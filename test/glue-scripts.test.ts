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

    it('the ingest job resolves its names under the keys SSM actually publishes', () => {
        // The job reads four names from the /{project}/{env} SSM tree. The
        // published key is athena/outputLocation (lib/ssm-keys.ts), and the
        // resolver's entry point is resolver.resolve() — constructing
        // ResolvedConfig directly passes the region string where the params
        // mapping belongs. Both mistakes shipped once and only surface minutes
        // into a live Glue run, so pin them here.
        const source = read('ingest_metadata_templates.py');
        const code = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');

        expect(code).toContain('resolver.resolve(');
        expect(code).not.toContain('resolver.ResolvedConfig(');
        expect(code).toContain('"athena/outputLocation"');
        expect(code).not.toContain('"athena/output"');

        // Discovery can be re-pointed per run (--S3_BUCKET falls back to the
        // SSM bronze bucket) — the override is documented in DATA_LAYERS.md
        // with its IAM implications, so it must not silently disappear.
        expect(code).toContain('"--S3_BUCKET"');
    });

    it('the ingest job appends to bronze and stamps batch provenance', () => {
        // Bronze is append-only: every run lands as a new batch and dedup on
        // row_hash happens at bronze->silver promotion (the dbt template's
        // dedupe_bronze macro). A merge_cols= reappearing here would silently
        // restore the old MERGE — overwriting _src_ingested_at in place and
        // destroying the record of earlier batches — while every CDK test
        // stayed green. The batch stamp contract: --JOB_RUN_ID is accepted
        // (Glue supplies it) and _src_batch_id lands on every row.
        const source = read('ingest_metadata_templates.py');
        const code = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');

        expect(code).not.toContain('merge_cols=');
        expect(code).toContain('"--JOB_RUN_ID"');
        expect(code).toContain('"_src_batch_id"');

        // Athena/Iceberg cannot have dots in column names: without the
        // sanitizing rename, `subject.submitter_id` collapses into a second
        // `submitter_id` and every table with a link column fails to create
        // ("Duplicate column name" — first observed live on omix3-test).
        expect(code).toContain('def athena_safe_frame(');
        expect(code).toContain('athena_safe_frame(df)');

        // The to_iceberg temp_path must be unique per run and cleaned up:
        // wrangler INSERTs via a temp table over the whole prefix and leaves
        // the staged parquet behind, so a reused static prefix re-ingests
        // every earlier run's staging as ghost rows (observed live:
        // 3 runs -> 3x/2x/1x copies per batch on omix3-test).
        expect(code).toContain('tmp_{table}_{batch_id}');
        expect(code).toContain('wr.s3.delete_objects(temp_path');
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

    it('the validator writes results before it raises on a failed study', () => {
        // The operator loop is "read the results table, fix, push again", so a
        // study that blows up must still leave a row behind. It previously did
        // not: the Iceberg write was guarded by `if results_frames:`, and a
        // study that raised appended nothing, so a run where every study failed
        // wrote no table at all and the operator got a Glue log to read instead.
        //
        // Two things are pinned. The except branch records an error_frame, and
        // the write precedes the raise — swapping those would restore the old
        // behaviour while still passing an "is error_frame called" check.
        const source = read('silver_json_gen3_validator.py');
        const code = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');

        expect(code).toContain('results_frames.append(\n                error_frame(');

        const write = code.indexOf('write_iceberg_to_db(');
        const raise = code.indexOf('raise RuntimeError(');
        expect(write).toBeGreaterThan(-1);
        expect(raise).toBeGreaterThan(-1);
        expect(write).toBeLessThan(raise);
    });
});
