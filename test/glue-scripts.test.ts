// test/glue-scripts.test.ts
//
// Guards the Python that CDK uploads to S3 and Glue then runs.
//
// This repo has no Python test infrastructure — no pytest, no conftest, no
// pyproject — and these scripts import g3dt, awswrangler and pandas, so real
// unit tests would mean standing up a Python toolchain and mocking heavy
// dependencies. Until that is worth doing, these four scripts ship completely
// unexercised: the first thing that runs them is a live Glue job, minutes into
// someone's deploy, and a syntax error costs a full pipeline run to discover.
//
// So this suite is deliberately shallow. It compiles every script and pins the
// two contracts that live in the Python but are enforced from CDK, where
// nothing else can see them. It does NOT test validation behaviour — that is
// verified live, the same convention test/wrapper-template.test.ts follows for
// deploy behaviour.
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.join(__dirname, '..');
const glueScripts = path.join(root, 'glue-scripts');
const scripts = fs.readdirSync(glueScripts).filter((f) => f.endsWith('.py'));
const read = (f: string) => fs.readFileSync(path.join(glueScripts, f), 'utf-8');

/** python3 is present on ubuntu-latest and every dev Mac, but do not hard-fail if not. */
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;

describe('glue-scripts — the Python CDK ships to S3', () => {
    it('finds the scripts CDK expects to upload', () => {
        // A rename here silently breaks lib/names.ts's scriptLocation, which
        // resolves file names this test would otherwise never see.
        expect(scripts.sort()).toEqual([
            'ingest_metadata_templates.py',
            'silver_json_gen3_validator.py',
            'write_data_release_to_json.py',
            'write_validation_jsons.py',
        ]);
    });

    (python ? it : it.skip)('every script compiles', () => {
        // Input:    each shipped .py file.
        // Expected: `python3 -m py_compile` exits 0.
        // Parse-only, offline, and fast — the Python equivalent of the
        // `bash -n` check in test/wrapper-template.test.ts.
        for (const script of scripts) {
            const result = spawnSync(
                python as string,
                ['-m', 'py_compile', path.join(glueScripts, script)],
                { encoding: 'utf-8' },
            );
            expect({ script, status: result.status, stderr: result.stderr })
                .toEqual({ script, status: 0, stderr: '' });
        }
    });

    it('both validation jobs accept --DB_TARGET with the same options', () => {
        // The Step Functions definitions pass this flag (see
        // test/ci-validation.test.ts). A flag renamed or dropped on the Python
        // side would not fail any CDK test — argparse would reject the run at
        // execution time, inside Glue, long after deploy reported success.
        for (const script of ['write_validation_jsons.py', 'silver_json_gen3_validator.py']) {
            const source = read(script);
            expect(source).toContain('"--DB_TARGET"');
            // Both scripts must agree on the target names and on what each
            // target resolves to — they are two halves of one Step Function
            // and the second reads what the first wrote.
            for (const token of [
                '"real"', '"ci"',
                'glue/db/silver', 'glue/db/ciSilver',
                '"validation"', '"ci_validation"',
                '"full_validation_results"', '"ci_full_validation_results"',
            ]) {
                expect(source).toContain(token);
            }
        }
    });

    it('the validator skips the gate when there is nothing to validate', () => {
        // The gate queries the results table, which is created by the first
        // Iceberg write and never by CDK (a CFN Glue table makes Athena's
        // Iceberg engine reject it — see lib/stacks/glue-catalog-stack.ts).
        // With no studies, nothing is written, so an unguarded gate reports
        // TABLE_NOT_FOUND against a perfectly healthy empty environment.
        // Asserted on source order because running the script needs AWS
        // credentials and a deployed environment; narrow, but it pins a guard
        // that is one deletion away from returning.
        const source = read('silver_json_gen3_validator.py');
        const code = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');

        const guard = code.indexOf('if not study_id_list:');
        const gate = code.indexOf('run_validation_gate(');
        expect(guard).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(gate);
    });
});
