// test/wrapper-template.test.ts
//
// Guards the shipped wrapper skeleton (wrapper-template/ + init-wrapper.sh):
// these files are copied verbatim into every adopter's private deployment
// repo, so a missing file, lost executable bit, or bash syntax error ships a
// broken scaffold that no upstream test would otherwise notice. Deploy
// BEHAVIOUR is validated live (clone → overlay → diff must reproduce a
// deployment exactly); this suite only pins the skeleton's integrity.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.join(__dirname, '..');
const template = path.join(root, 'wrapper-template');

describe('wrapper-template — the scaffold every wrapper starts from', () => {
    it('ships the complete skeleton', () => {
        for (const f of [
            'README.md', '.gitignore', 'UPSTREAM_VERSION', 'deploy.sh',
            'config/README.md', 'glue-scripts/README.md',
        ]) {
            expect(fs.existsSync(path.join(template, f))).toBe(true);
        }
    });

    it('deploy.sh and init-wrapper.sh are executable', () => {
        // cp -R preserves mode bits, so a lost +x here means every generated
        // wrapper's first `./deploy.sh` fails with "permission denied".
        for (const f of [
            path.join(template, 'deploy.sh'),
            path.join(root, 'scripts', 'init-wrapper.sh'),
        ]) {
            expect(fs.statSync(f).mode & 0o100).toBeTruthy();
        }
    });

    it('both scripts parse as valid bash', () => {
        // `bash -n` is a parse-only check: cheap, offline, and catches the
        // quoting/heredoc mistakes shell scripts are prone to.
        for (const f of [
            path.join(template, 'deploy.sh'),
            path.join(root, 'scripts', 'init-wrapper.sh'),
        ]) {
            const result = spawnSync('bash', ['-n', f], { encoding: 'utf-8' });
            expect(result.status).toBe(0);
        }
    });

    it('UPSTREAM_VERSION holds the placeholder init-wrapper.sh overwrites', () => {
        // Input: the shipped template file. Expected: the vX.Y.Z placeholder —
        // a real tag here would mean a wrapper generated without the init
        // script silently pins to whatever version last touched the template.
        expect(fs.readFileSync(path.join(template, 'UPSTREAM_VERSION'), 'utf-8').trim())
            .toBe('vX.Y.Z');
    });

    it('the wrapper gitignores its upstream checkout', () => {
        // .checkout/ is a full clone of this repo; committing it would defeat
        // the whole no-code-in-the-wrapper design.
        const ignore = fs.readFileSync(path.join(template, '.gitignore'), 'utf-8');
        expect(ignore).toContain('.checkout/');
    });
});
