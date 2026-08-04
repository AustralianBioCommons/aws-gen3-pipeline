// test/dbt-trigger.test.ts
//
// Pins the release-decoupling contract on the two dbt pipelines
// (june_refactor_plan docs 06/08):
//   * write-release-info triggers ONLY on data-v* tag pushes — a software tag
//     or a plain branch merge must never mutate the releases ledger;
//   * dbt-test-and-run stays branch-push CI with no tag trigger;
//   * CodeBuild receives exactly PROJECT_ID + ENV — every other value resolves
//     from SSM at build time, and any extra injected variable is a name source
//     creeping back in.
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InputConfig } from '../lib/config';
import { buildApp } from '../lib/build-app';

// Placeholder fixture, never config/*.json: wrapper checkouts overlay their
// own config/ and `npm test` must stay green inside them.
const config: InputConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
);

const app = new cdk.App();
const { names, stacks } = buildApp(app, config);
const cpTemplate = Template.fromStack(stacks.codePipeline);
const cbTemplate = Template.fromStack(stacks.codeBuild);

describe('release decoupling — pipeline triggers', () => {
    it('write-release pipeline triggers ONLY on data-v* tags', () => {
        cpTemplate.hasResourceProperties('AWS::CodePipeline::Pipeline', {
            Name: names.codepipeline.writeReleaseInfo,
            Triggers: Match.arrayWith([
                Match.objectLike({
                    ProviderType: 'CodeStarSourceConnection',
                    GitConfiguration: Match.objectLike({
                        Push: Match.arrayWith([
                            Match.objectLike({ Tags: { Includes: ['data-v*'] } }),
                        ]),
                    }),
                }),
            ]),
        });
    });

    it('test-and-run pipeline has NO tag trigger (CI on branch push only)', () => {
        const pipelines = cpTemplate.findResources('AWS::CodePipeline::Pipeline');
        const testAndRun = Object.values(pipelines).find(
            (p) => p.Properties?.Name === names.codepipeline.dbtTestAndRun,
        );
        expect(testAndRun).toBeDefined();
        const triggers = testAndRun?.Properties?.Triggers ?? [];
        const tagTriggers = triggers.filter((tr: any) =>
            tr?.GitConfiguration?.Push?.some((p: any) => p?.Tags));
        expect(tagTriggers).toHaveLength(0);
    });
});

describe('name-free buildspecs — the CodeBuild env-var contract', () => {
    it('both projects receive exactly PROJECT_ID and ENV, with the config values', () => {
        const projects = Object.values(cbTemplate.findResources('AWS::CodeBuild::Project'));
        expect(projects).toHaveLength(2);
        for (const p of projects) {
            const vars = p.Properties?.Environment?.EnvironmentVariables ?? [];
            const byName = Object.fromEntries(vars.map((v: any) => [v.Name, v.Value]));
            expect(byName).toEqual({
                PROJECT_ID: config.projectId,
                ENV: config.environment,
            });
        }
    });

    it('the CodeBuild role can GetParametersByPath on the BARE tree path', () => {
        // Same runtime pitfall as the EC2 role: the bare path resource is
        // required for GetParametersByPath, the /* form only covers children.
        const statements = Object.values(cbTemplate.findResources('AWS::IAM::Policy'))
            .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);
        const ssmStmt = statements.find((s) =>
            JSON.stringify(s.Action ?? '').includes('ssm:GetParametersByPath'));
        expect(ssmStmt).toBeDefined();
        const resources = JSON.stringify(ssmStmt.Resource);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}"`);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}/*`);
    });

    it('no Secrets Manager grant remains on the CodeBuild role', () => {
        const statements = Object.values(cbTemplate.findResources('AWS::IAM::Policy'))
            .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);
        const secretStmts = statements.filter((s) =>
            JSON.stringify(s.Action ?? '').includes('secretsmanager:'));
        expect(secretStmts).toHaveLength(0);
    });
});
