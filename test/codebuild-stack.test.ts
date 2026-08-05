// test/codebuild-stack.test.ts
//
// Pins the CodeBuild role's CI wait-gate grant. The release buildspec
// (gen3-dbt-template .codepipeline/write_release_info.yml) polls the CI
// project — ListBuildsForProject + BatchGetBuilds — before it runs dbt build.
// The acdc lesson: without this grant the buildspec's gate degrades to a
// warning and warn-skips, so releases silently stop waiting on CI. The grant
// is load-bearing and is therefore pinned by test, not left to convention.
//
// Tests deliberately use test/fixtures/pipeline-config.json (placeholder
// values), never config/*.json: wrapper checkouts overlay their own config/
// and `npm test` must stay green inside them.
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InputConfig } from '../lib/config';
import { buildApp } from '../lib/build-app';

const config: InputConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
);

const app = new cdk.App();
const { names, stacks } = buildApp(app, config);
const template = Template.fromStack(stacks.codeBuild);

describe('CodeBuild role — the CI wait-gate grant', () => {
    it('may poll the CI project (ListBuildsForProject + BatchGetBuilds), scoped to that one project', () => {
        // Expected: a statement carrying BOTH codebuild polling actions whose
        // resource is the derived dbt-test-and-run project ARN. The role is
        // shared with the CI project itself, so the grant must stay scoped to
        // this single project — never a wildcard.
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: Match.arrayWith([
                            'codebuild:ListBuildsForProject',
                            'codebuild:BatchGetBuilds',
                        ]),
                        Resource: Match.stringLikeRegexp(
                            `:project/${names.codebuild.dbtTestAndRun}$`,
                        ),
                    }),
                ]),
            },
        });
    });
});
