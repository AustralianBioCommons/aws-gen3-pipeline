// test/integration-script.test.ts
//
// Guards scripts/integration_test.sh — the post-deploy suite operators run to
// decide whether an environment is actually up. It is shell, so nothing else
// in this repo type-checks it, and it is invoked two different ways:
//
//   from a checkout of this repo:  ./scripts/integration_test.sh ...
//   from a private wrapper:        ./.checkout/scripts/integration_test.sh ...
//
// The second form is the one docs/RUNBOOK.md, docs/QUICKSTART.md and
// docs/WRAPPER_GUIDE.md tell operators to use, and it is the one that broke:
// every path in the script was resolved against the caller's CWD, so from a
// wrapper root (which has config/ but no package.json and no compiled lib/)
// the setup step and the deriveNames() require() both failed. $EXPECT came
// back empty and the suite reported six confident, entirely bogus FAILs
// against a healthy environment — the worst possible failure mode for a
// script whose whole job is telling you the truth about a deployment.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'integration_test.sh');
const source = fs.readFileSync(script, 'utf-8');

/**
 * The script with whole-line comments removed. Ordering assertions run against
 * this, not the raw file: the script explains itself heavily, and prose that
 * quotes a path (`lib/names.js`, `npm run build`) would otherwise match as if
 * it were code and make the position checks meaningless.
 */
const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('scripts/integration_test.sh — the post-deploy suite operators trust', () => {
    it('is executable and parses as valid bash', () => {
        // Input:    the shipped script.
        // Expected: +x set, and `bash -n` (parse-only, offline) exits 0.
        // A lost mode bit or a quoting slip here surfaces as "permission
        // denied" / a syntax error at the end of someone's first deploy.
        expect(fs.statSync(script).mode & 0o100).toBeTruthy();
        expect(spawnSync('bash', ['-n', script], { encoding: 'utf-8' }).status).toBe(0);
    });

    it('resolves its own repo root before using any relative path', () => {
        // Input:    the shipped script.
        // Expected: a `cd` off ${BASH_SOURCE[0]} appears before the first
        //           relative-path use (package.json / lib/ / config/).
        //
        // Asserted on the source rather than by running the script, because a
        // real run needs AWS credentials and a deployed environment. That
        // makes this a narrow check — it pins the fix, not the whole
        // behaviour — but the bug it guards against is a one-line deletion
        // away and silently inverts every result the script prints.
        const cdIndex = code.indexOf('cd "$(dirname "${BASH_SOURCE[0]}")/.."');
        expect(cdIndex).toBeGreaterThan(-1);

        for (const relativeUse of ['lib/names.js', 'npm run build', 'config/*.']) {
            const useIndex = code.indexOf(relativeUse);
            expect(useIndex).toBeGreaterThan(-1);
            expect(useIndex).toBeGreaterThan(cdIndex);
        }
    });

    it('checks the SSM tree by key, not by hardcoded count', () => {
        // Input:    the shipped script.
        // Expected: it reads the expected keys from lib/ssm-keys.ts and never
        //           compares the tree size to a literal total.
        //
        // Why it matters: anyone who forks this pipeline and adds a parameter
        // shifts the total. A count assertion would fail their healthy
        // deployment and tell them nothing about which key was involved; a
        // per-key probe adapts to their map and names what is missing.
        expect(source).toContain("require('./lib/ssm-keys.js')");
        expect(source).toContain('.ssmKeys[]');
        expect(source).not.toMatch(/expected 4[01] parameters/);
    });
});
