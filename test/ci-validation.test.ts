// test/ci-validation.test.ts
//
// Pins the rule that CI validates what CI built.
//
// The dbt template's CI buildspec exports G3DT_DBT_TARGET=ci, so the
// generate_schema_name macro lands every model in a ci_-prefixed Glue
// database. Before this contract existed, the CI pipeline's last stage
// invoked a validation state machine whose Glue jobs resolved
// `glue/db/silver` — the REAL silver DB, which CI deliberately never writes.
// On a fresh environment that produced a bare
// `TABLE_NOT_FOUND: ... full_validation_results does not exist` (seen live
// 2026-08-13/14, omix3 test), which reads like a broken deployment rather
// than an empty one; on a populated environment it would have quietly graded
// stale data that had nothing to do with the commit under test.
//
// Two state machines, differing only in the --DB_TARGET they pass to the same
// two Glue jobs, keep the two audiences honest: the CI pipeline drives the ci
// one, and runbook step 9 drives the real one on demand.
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
const sfnTemplate = Template.fromStack(stacks.stepFunctions);
const cpTemplate = Template.fromStack(stacks.codePipeline);

/** The parsed Step Functions definition for a state machine, by its deployed name. */
function definitionFor(stateMachineName: string): any {
    const match = Object.values(
        sfnTemplate.findResources('AWS::StepFunctions::StateMachine'),
    ).find((r: any) => r.Properties?.StateMachineName === stateMachineName);
    if (!match) {
        throw new Error(`No state machine named "${stateMachineName}" in the synthesised stack`);
    }
    return JSON.parse((match as any).Properties.DefinitionString);
}

describe('CI validation targets the ci_* databases, not the real warehouse', () => {
    it('derives a distinct name for the CI validation machine', () => {
        // Input:    the fixture config (projectId "demo", environment "test").
        // Expected: two separate names, the CI one suffixed -ci. They must not
        //           collide: both machines are deployed side by side.
        expect(names.stepFunctions.validation).toBe('demo-test-validation');
        expect(names.stepFunctions.validationCi).toBe('demo-test-validation-ci');
    });

    it('deploys both validation machines', () => {
        for (const name of [names.stepFunctions.validation, names.stepFunctions.validationCi]) {
            sfnTemplate.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineName: name,
            });
        }
    });

    it.each([
        ['real', () => names.stepFunctions.validation],
        ['ci', () => names.stepFunctions.validationCi],
    ])('the %s machine passes that target to BOTH Glue jobs', (target, nameOf) => {
        // Input:    each machine's synthesised definition.
        // Expected: every Task carries Arguments {'--DB_TARGET': <target>}.
        //
        // Both jobs, not just one: the validator reads the JSON files the
        // dump job wrote, under a prefix scoped by the same flag. If the two
        // ever disagree, the validator reads the other target's artifacts —
        // silent cross-contamination rather than an error.
        const definition = definitionFor(nameOf());
        const states = Object.values(definition.States) as any[];
        expect(states).toHaveLength(2);
        for (const state of states) {
            expect(state.Parameters.Arguments).toEqual({ '--DB_TARGET': target });
        }
    });

    it('both machines run the same two Glue jobs in the same order', () => {
        // The targets differ; the orchestration must not. A job added to one
        // machine and not the other is a drift bug that no other test sees.
        const shape = (name: string) => {
            const d = definitionFor(name);
            return {
                startAt: d.StartAt,
                jobs: Object.values(d.States).map((s: any) => s.Parameters.JobName),
            };
        };
        expect(shape(names.stepFunctions.validationCi))
            .toEqual(shape(names.stepFunctions.validation));
        expect(shape(names.stepFunctions.validation).jobs).toEqual([
            'demo-test-write-validation-jsons',
            'demo-test-silver-json-gen3-validator',
        ]);
    });

    it('the CI pipeline invokes the CI machine, never the real one', () => {
        // THE regression. A CI stage pointed at the real-warehouse machine is
        // exactly the bug this file exists for, and it is invisible at synth
        // time — the stack deploys fine and only fails at runtime, in a way
        // that looks like a data problem.
        cpTemplate.hasResourceProperties('AWS::CodePipeline::Pipeline', {
            Name: names.codepipeline.dbtTestAndRun,
            Stages: Match.arrayWith([
                Match.objectLike({
                    Name: 'InvokeValidationStepFunctions',
                    Actions: Match.arrayWith([
                        Match.objectLike({
                            Configuration: Match.objectLike({
                                StateMachineArn: Match.stringLikeRegexp(
                                    `stateMachine:${names.stepFunctions.validationCi}$`,
                                ),
                            }),
                        }),
                    ]),
                }),
            ]),
        });
    });

    it('the pipeline role can start the CI machine but not the real one', () => {
        // Least privilege, and a second line of defence: even if the stage were
        // repointed at the real machine, CodePipeline could not start it.
        const statements = Object.values(cpTemplate.findResources('AWS::IAM::Policy'))
            .flatMap((p: any) => p.Properties?.PolicyDocument?.Statement ?? [])
            .filter((s: any) => JSON.stringify(s.Action).includes('states:StartExecution'));
        expect(statements.length).toBeGreaterThan(0);

        const granted = JSON.stringify(statements.map((s: any) => s.Resource));
        expect(granted).toContain(`stateMachine:${names.stepFunctions.validationCi}`);
        // The real machine's ARN is a strict prefix of the CI one, so a bare
        // "does it appear" check would always pass — require a boundary.
        expect(granted).not.toMatch(
            new RegExp(`stateMachine:${names.stepFunctions.validation}(?!-ci)`),
        );
    });
});
