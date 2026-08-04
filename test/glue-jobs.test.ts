// test/glue-jobs.test.ts
//
// Pins the Glue jobs' configuration contract: the scripts receive exactly
// PROJECT_ID/ENV/REGION and resolve everything else from SSM via the g3dt
// toolkit, the scripts themselves ship from this repo's glue-scripts/ via a
// BucketDeployment (no manual upload step), and the Glue role carries the
// Athena + SSM grants the scripts need at runtime.
//
// Also pins the customJobs mechanism: a deployment declares a job in config
// (key + script file + optional overrides) and gets a CfnJob without touching
// any stack code. That contract is what deployment wrappers build on, so it
// is asserted here rather than left to convention.
//
// Tests deliberately use test/fixtures/pipeline-config.json (placeholder
// values), never config/*.json: wrapper checkouts overlay their own config/
// and `npm test` must stay green inside them.
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InputConfig } from '../lib/config';
import { buildApp } from '../lib/build-app';

const config: InputConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
);

// The exact pin string the stack passes to every job. Duplicated here on
// purpose: the ~20-minute pip-backtracking incident this pin prevents means
// any change to it must be a visible, deliberate test edit.
const TOOLKIT_PIN =
    `gen3-dataops-toolkit==${config.toolkitVersion},` +
    'awswrangler==3.14.0,boto3==1.41.5,pandas==2.3.3,' +
    'numpy==1.26.4,pyarrow==18.1.0,openpyxl==3.1.5';

const app = new cdk.App();
const { names, stacks } = buildApp(app, config);
const glueTemplate = Template.fromStack(stacks.glueJobs);
const iamTemplate = Template.fromStack(stacks.iamRoles);

describe('Glue jobs — the SSM-resolution contract', () => {
    it('every job passes PROJECT_ID, ENV and REGION (and the toolkit pin)', () => {
        const jobs = Object.values(glueTemplate.findResources('AWS::Glue::Job'));
        expect(jobs).toHaveLength(names.glueJobs.length);
        for (const job of jobs) {
            const args = job.Properties?.DefaultArguments ?? {};
            expect(args['--PROJECT_ID']).toBe(config.projectId);
            expect(args['--ENV']).toBe(config.environment);
            expect(args['--REGION']).toBe(config.region);
            // Toolkit pin plus pinned transitive deps: a bare package pin
            // sends Glue python-shell's pip into ~20 min of resolver
            // backtracking before the job's own code starts.
            expect(args['--additional-python-modules']).toBe(TOOLKIT_PIN);
        }
    });

    it('the scripts deploy from glue-scripts/ to the metadata bucket', () => {
        // A BucketDeployment synthesises a custom resource targeting scripts/.
        const deployments = glueTemplate.findResources('Custom::CDKBucketDeployment');
        const props = Object.values(deployments)[0]?.Properties;
        expect(props).toBeDefined();
        expect(props.DestinationBucketName).toBe(names.buckets.metadata);
        expect(props.DestinationBucketKeyPrefix).toBe('scripts/');
    });

    it('a source file exists for every scriptLocation the jobs reference', () => {
        // The names derive scripts/<file>.py; the repo must actually ship them.
        for (const jobDef of names.glueJobs) {
            const file = jobDef.scriptLocation.split('/').pop() as string;
            const local = path.join(process.cwd(), 'glue-scripts', file);
            expect(fs.existsSync(local)).toBe(true);
        }
    });
});

describe('Custom jobs from config — the deployment-wrapper contract', () => {
    // Input: one customJobs entry exercising every optional field. The script
    // file reuses an existing built-in script so the synth-time existence
    // check passes without adding a fixture .py to glue-scripts/.
    const customConfig: InputConfig = {
        ...config,
        customJobs: [{
            key: 'helloWorld',
            scriptFile: 'write_validation_jsons.py',
            extraPythonModules: ['tabulate==0.9.0'],
            extraArgs: { '--MY_FLAG': 'x' },
            timeoutMinutes: 60,
        }],
    };
    const customApp = new cdk.App();
    const custom = buildApp(customApp, customConfig);
    const template = Template.fromStack(custom.stacks.glueJobs);

    it('declaring a job in config yields a CfnJob named <project>-<env>-<kebab-key>', () => {
        // Expected: key "helloWorld" derives job name "demo-test-hello-world"
        // — no TypeScript edits involved. This is the whole point of the
        // mechanism, so the derived name is pinned exactly.
        template.hasResourceProperties('AWS::Glue::Job', {
            Name: 'demo-test-hello-world',
            Timeout: 60,
        });
    });

    it('extra python modules append after the shared toolkit pin; extra args merge over the standard set', () => {
        const jobs = Object.values(template.findResources('AWS::Glue::Job'));
        const hello = jobs.find((j) => j.Properties?.Name === 'demo-test-hello-world');
        expect(hello).toBeDefined();
        const args = hello!.Properties.DefaultArguments;
        // The shared pin set stays first (fast pip resolution for every job);
        // the job's own pins follow it.
        expect(args['--additional-python-modules']).toBe(`${TOOLKIT_PIN},tabulate==0.9.0`);
        // Custom args add to — never replace — the SSM-resolution trio.
        expect(args['--MY_FLAG']).toBe('x');
        expect(args['--PROJECT_ID']).toBe(config.projectId);
    });

    it('built-in jobs are unchanged by the presence of custom jobs', () => {
        // A wrapper adding its own job must not perturb the core pipeline:
        // the built-ins keep the verbatim pin string and default timeout.
        const jobs = Object.values(template.findResources('AWS::Glue::Job'));
        const builtIn = jobs.find((j) => j.Properties?.Name === 'demo-test-write-validation-jsons');
        expect(builtIn).toBeDefined();
        expect(builtIn!.Properties.DefaultArguments['--additional-python-modules']).toBe(TOOLKIT_PIN);
        expect(builtIn!.Properties.Timeout).toBe(2880);
    });

    it('a configured job whose script file is missing fails at synth, naming the file', () => {
        // glue-scripts/ deploys with prune:true, so a missing script must
        // never reach deploy time — the stack throws while synthesising.
        const badConfig: InputConfig = {
            ...config,
            customJobs: [{ key: 'ghostJob', scriptFile: 'does_not_exist.py' }],
        };
        expect(() => buildApp(new cdk.App(), badConfig))
            .toThrow(/ghostJob.*does_not_exist\.py/s);
    });
});

describe('Glue ETL role — runtime grants the scripts need', () => {
    const statements = Object.values(iamTemplate.findResources('AWS::IAM::Policy'))
        .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);

    it('runs Athena in the env workgroup only', () => {
        const flat = JSON.stringify(statements);
        expect(flat).toContain(`:workgroup/${names.athena.workgroup}`);
        expect(flat).toContain('athena:StartQueryExecution');
    });

    it('reads the env SSM tree — bare path AND children', () => {
        const ssmStmt = statements.find((s) =>
            JSON.stringify(s.Action ?? '').includes('ssm:GetParametersByPath'));
        expect(ssmStmt).toBeDefined();
        const resources = JSON.stringify(ssmStmt.Resource);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}"`);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}/*`);
    });
});
