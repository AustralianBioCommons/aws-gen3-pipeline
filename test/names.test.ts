// test/names.test.ts
//
// Pins the naming convention itself. deriveNames() is the single source of
// truth for every OUTPUT name — the CLI, dbt, and later migration scripts all
// depend on these exact shapes, so a change here is a breaking change to
// every SSM consumer and must be deliberate.
import { deriveNames } from '../lib/names';
import { InputConfig } from '../lib/config';

const cfg: InputConfig = {
    projectId: 'myproject',
    environment: 'test',
    accountId: '123456789012',
    region: 'ap-southeast-2',
    network: { vpcCidr: '10.20.0.0/16' },
    repo: { fullName: 'org/repo', branch: 'main', codeStarConnectionArn: 'arn:aws:codeconnections:x' },
    ec2: { instanceType: 't3.micro', ami: 'ami-000' },
    toolkitVersion: '1.3.0',
    gen3: {
        dictionaryVersion: 'v1', awsSecretName: 's', schemaS3Uri: 'u', domain: 'd',
        appName: 'a', namespace: 'n', clusterName: 'c', schemaRepo: 'r',
    },
};

const names = deriveNames(cfg);

describe('deriveNames — the naming convention is pinned', () => {
    it('buckets follow <project>-<env>-<suffix>-<account>-<region>, lower-cased', () => {
        expect(names.buckets.metadata).toBe('myproject-test-metadata-123456789012-ap-southeast-2');
        expect(names.buckets.rawBronze).toBe('myproject-test-raw-bronze-123456789012-ap-southeast-2');
        expect(names.buckets.athenaResults).toBe('myproject-test-athena-results-123456789012-ap-southeast-2');
    });

    it('every bucket name fits the 63-char S3 limit for all real env names', () => {
        for (const environment of ['test', 'staging', 'prod']) {
            const n = deriveNames({ ...cfg, environment });
            for (const name of Object.values(n.buckets)) {
                expect(name.length).toBeLessThanOrEqual(63);
            }
        }
    });

    it('Glue databases use underscores and a _db suffix (no account/region)', () => {
        expect(names.glueDatabases.metadata).toBe('myproject_test_dataops_metadata_db');
        expect(names.glueDatabases.rawSilver).toBe('myproject_test_raw_silver_db');
    });

    it('CI databases are the real names with a leading ci_ prefix — real names never change', () => {
        expect(names.glueDatabases.ciRawSilver).toBe('ci_myproject_test_raw_silver_db');
        expect(names.glueDatabases.ciRawGold).toBe('ci_myproject_test_raw_gold_db');
        // the invariant: only the ci variants carry the prefix
        expect(names.glueDatabases.rawSilver.startsWith('ci_')).toBe(false);
        expect(names.glueDatabases.rawGold.startsWith('ci_')).toBe(false);
    });

    it('workgroup is the bare <project>-<env> prefix', () => {
        expect(names.athena.workgroup).toBe('myproject-test');
        expect(names.athena.outputLocation).toBe(`s3://${names.buckets.athenaResults}/`);
    });

    it('the release ledger lives in the metadata DB', () => {
        expect(names.release).toEqual({ db: 'myproject_test_dataops_metadata_db', table: 'releases' });
    });

    it('Glue jobs are env-prefixed with stable lookup keys', () => {
        const keys = names.glueJobs.map((j) => j.key);
        expect(keys).toEqual(['writeValidationJsons', 'silverJsonGen3Validator', 'writeDataReleaseToJson', 'ingestMetadataTemplates']);
        for (const j of names.glueJobs) {
            expect(j.name).toMatch(/^myproject-test-/);
            expect(j.scriptLocation).toMatch(new RegExp(`^s3://${names.buckets.metadata}/scripts/`));
        }
    });

    it('ec2 leaves match the dispatch contract (logGroup path, metadata logBucket)', () => {
        expect(names.ec2).toEqual({
            logGroup: '/myproject/test/ec2/jobs',
            logBucket: names.buckets.metadata,
            logPrefix: 'ec2-job-logs',
        });
    });

    it('glue jobs carry no VPC connection (Glue-managed networking is deliberate)', () => {
        expect('glueConnection' in names).toBe(false);
    });
});

describe('deriveNames — customJobs derivation (the wrapper contract)', () => {
    it('a custom job derives <project>-<env>-<kebab-key> and scripts/<scriptFile>', () => {
        // Input: key "myIngestJob", script "my_ingest.py". Expected: the job
        // name kebab-cases the key under the env prefix, and the script
        // location lands in the same scripts/ prefix as the built-ins — the
        // name and location are OUTPUTs, never authored in config.
        const n = deriveNames({
            ...cfg,
            customJobs: [{ key: 'myIngestJob', scriptFile: 'my_ingest.py' }],
        });
        const job = n.glueJobs.find((j) => j.key === 'myIngestJob');
        expect(job).toEqual({
            key: 'myIngestJob',
            name: 'myproject-test-my-ingest-job',
            scriptLocation: `s3://${n.buckets.metadata}/scripts/my_ingest.py`,
        });
    });

    it('nameSuffix overrides the kebab-cased key when a deployment needs a specific job name', () => {
        const n = deriveNames({
            ...cfg,
            customJobs: [{ key: 'myIngestJob', scriptFile: 'my_ingest.py', nameSuffix: 'legacy-ingest' }],
        });
        expect(n.glueJobs.find((j) => j.key === 'myIngestJob')?.name)
            .toBe('myproject-test-legacy-ingest');
    });

    it('custom jobs append after the built-ins — the built-in list never reorders', () => {
        // Step Functions and IAM grants key off the built-ins; a wrapper's
        // additions must be purely additive.
        const n = deriveNames({
            ...cfg,
            customJobs: [{ key: 'myIngestJob', scriptFile: 'my_ingest.py' }],
        });
        expect(n.glueJobs.map((j) => j.key)).toEqual([
            'writeValidationJsons', 'silverJsonGen3Validator',
            'writeDataReleaseToJson', 'ingestMetadataTemplates', 'myIngestJob',
        ]);
    });

    it('a custom key that shadows a built-in throws (it would replace a core job)', () => {
        expect(() => deriveNames({
            ...cfg,
            customJobs: [{ key: 'writeValidationJsons', scriptFile: 'evil.py' }],
        })).toThrow(/writeValidationJsons.*collides/);
    });

    it('duplicate custom keys throw', () => {
        expect(() => deriveNames({
            ...cfg,
            customJobs: [
                { key: 'myIngestJob', scriptFile: 'a.py' },
                { key: 'myIngestJob', scriptFile: 'b.py' },
            ],
        })).toThrow(/myIngestJob.*collides/);
    });
});
