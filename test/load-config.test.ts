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
