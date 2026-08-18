// test/load-config.test.ts
//
// Pins the config-file discovery rules: the project id is never hard-coded —
// files are found by their .<env>.json suffix, and a config/ directory holding
// several projects needs -c project=<id> to disambiguate. These rules are what
// let one CDK checkout serve multiple projects and environments.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { findConfigFile, loadConfig } from '../lib/load-config';

describe('findConfigFile — multi-project config discovery', () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
        for (const f of ['project1.test.json', 'project1.prod.json', 'project2.test.json']) {
            fs.writeFileSync(path.join(dir, f), '{}');
        }
    });

    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('a unique env suffix resolves without naming the project', () => {
        expect(findConfigFile('prod', undefined, dir)).toBe(path.join(dir, 'project1.prod.json'));
    });

    it('an ambiguous env suffix demands -c project=<id>', () => {
        expect(() => findConfigFile('test', undefined, dir)).toThrow(/-c project=/);
    });

    it('project + env selects the exact file', () => {
        expect(findConfigFile('test', 'project2', dir)).toBe(path.join(dir, 'project2.test.json'));
    });

    it('an unknown project fails with the expected filename', () => {
        expect(() => findConfigFile('test', 'nope', dir)).toThrow(/config\/nope\.test\.json/);
    });

    it('an unknown env fails with the naming convention', () => {
        expect(() => findConfigFile('staging', undefined, dir)).toThrow(/<projectId>\.staging\.json/);
    });
});

describe('loadConfig — customJobs validation', () => {
    // customJobs is the one config block written by deployment wrappers, not
    // this repo, so malformed values arrive from outside. These cases pin
    // that they are rejected at load time with the offending key named —
    // long before any stack synthesises.
    const base = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
    );

    const load = (customJobs: unknown) =>
        loadConfig(new cdk.App({ context: { pipelineConfig: { ...base, customJobs } } }));

    it('a well-formed entry loads', () => {
        const cfg = load([{ key: 'myJob', scriptFile: 'my_job.py' }]);
        expect(cfg.customJobs).toHaveLength(1);
    });

    it('a non-camelCase key is rejected (it becomes a CFN logical id and lookup key)', () => {
        expect(() => load([{ key: 'My-Job', scriptFile: 'my_job.py' }]))
            .toThrow(/invalid key "My-Job"/);
    });

    it('a scriptFile with path separators is rejected (it would escape the scripts/ S3 prefix)', () => {
        expect(() => load([{ key: 'myJob', scriptFile: '../../etc/passwd.py' }]))
            .toThrow(/invalid scriptFile/);
        expect(() => load([{ key: 'myJob', scriptFile: 'sub/dir.py' }]))
            .toThrow(/invalid scriptFile/);
    });

    it('duplicate keys are rejected', () => {
        expect(() => load([
            { key: 'myJob', scriptFile: 'a.py' },
            { key: 'myJob', scriptFile: 'b.py' },
        ])).toThrow(/duplicate key "myJob"/);
    });
});

describe('loadConfig — required gen3.* fields', () => {
    // Every gen3.* fact is mirrored to SSM and read by the toolkit at
    // runtime; dictionaryBaseUrl + dictionaryPath in particular pin where
    // the data model is downloaded from, which underpins every toolkit data
    // operation. A missing field must fail at config load with the field
    // named — not publish "undefined" to SSM and surface mid-job.
    const base = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
    );

    const loadWithoutGen3Key = (key: string) => {
        const gen3 = { ...base.gen3 };
        delete gen3[key];
        return loadConfig(new cdk.App({ context: { pipelineConfig: { ...base, gen3 } } }));
    };

    it('the complete fixture loads', () => {
        expect(loadConfig(new cdk.App({ context: { pipelineConfig: base } })).gen3.dictionaryPath)
            .toBe('dictionary/prod_dict/demo_schema.json');
    });

    it.each(['dictionaryPath', 'dictionaryBaseUrl', 'schemaS3Uri'])(
        'a config missing gen3.%s is rejected with the field named',
        (key) => {
            expect(() => loadWithoutGen3Key(key))
                .toThrow(new RegExp(`gen3.* field\\(s\\): ${key}`));
        },
    );
});

describe('loadConfig — optional llm block validation', () => {
    // The llm block configures synthetic-data generation via
    // gen3-metadata-simulator and is mirrored to SSM as app/llm_provider +
    // app/llm_model. It is optional (the keyless "random" provider needs no
    // config), but when present a half-specified or misspelled block would
    // publish a broken fact set — these cases pin that it is rejected at load
    // time with the offending field named.
    const base = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
    );

    const loadWithLlm = (llm: unknown) =>
        loadConfig(new cdk.App({ context: { pipelineConfig: { ...base, llm } } }));

    it('a config without an llm block loads (the block is optional)', () => {
        const cfg = loadConfig(new cdk.App({ context: { pipelineConfig: base } }));
        expect(cfg.llm).toBeUndefined();
    });

    it('a well-formed llm block loads', () => {
        const cfg = loadWithLlm({ provider: 'anthropic', model: 'claude-opus-5' });
        expect(cfg.llm).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    });

    it('an unknown provider is rejected with the valid options named', () => {
        expect(() => loadWithLlm({ provider: 'gemini', model: 'some-model' }))
            .toThrow(/llm\.provider must be one of anthropic \| openai/);
    });

    it('a block without a model is rejected', () => {
        expect(() => loadWithLlm({ provider: 'anthropic' }))
            .toThrow(/llm\.model is required/);
    });
});
