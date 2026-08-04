// lib/stacks/codepipeline-stack.ts
// Two pipelines with decoupled lifecycles (june_refactor_plan docs 06/08):
// dbt-test-and-run is CI — it runs on every push to the configured branch and
// never writes a release; write-release-info runs ONLY on a data-v* tag push
// (a V2 git-tag trigger), so a software release or a plain merge can never
// mutate the releases ledger.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface CodePipelineStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
    codeBuildProjects: {
        dbtTestAndRun: codebuild.IProject;
        dbtReleaseBuilder: codebuild.IProject;
    };
    stepFunctionNames: {
        validation: string;
        writeReleaseJsons: string;
    };
}

export class CodePipelineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: CodePipelineStackProps) {
        super(scope, id, props);

        const { config, names, codeBuildProjects, stepFunctionNames } = props;
        const { repo } = config;

        const [owner, repoName] = repo.fullName.split('/');

        const pipelineRole = new iam.Role(this, 'CodePipelineRole', {
            roleName: `${config.projectId}-${config.environment}-codepipeline-role`,
            assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
        });

        pipelineRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'codebuild:BatchGetBuilds',
                'codebuild:StartBuild',
            ],
            resources: [
                codeBuildProjects.dbtTestAndRun.projectArn,
                codeBuildProjects.dbtReleaseBuilder.projectArn,
            ],
        }));

        pipelineRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'states:StartExecution',
                'states:DescribeStateMachine',
            ],
            resources: [
                `arn:aws:states:${this.region}:${this.account}:stateMachine:${stepFunctionNames.validation}`,
                `arn:aws:states:${this.region}:${this.account}:stateMachine:${stepFunctionNames.writeReleaseJsons}`,
            ],
        }));

        // Created by ArtifactBucketStack; imported by name here.
        const artifactBucket = s3.Bucket.fromBucketName(
            this,
            'ArtifactBucket',
            names.buckets.artifact,
        );

        const sourceOutput = new codepipeline.Artifact('SourceArtifact');
        const buildOutput = new codepipeline.Artifact('BuildArtifact');

        const validationStateMachine = stepfunctions.StateMachine.fromStateMachineArn(
            this,
            'ValidationStateMachine',
            `arn:aws:states:${this.region}:${this.account}:stateMachine:${stepFunctionNames.validation}`,
        );

        const writeReleaseStateMachine = stepfunctions.StateMachine.fromStateMachineArn(
            this,
            'WriteReleaseStateMachine',
            `arn:aws:states:${this.region}:${this.account}:stateMachine:${stepFunctionNames.writeReleaseJsons}`,
        );

        // 1) dbt-test-and-run pipeline (CI on branch push)
        const dbtPipeline = new codepipeline.Pipeline(
            this,
            'DbtTestAndRunPipeline',
            {
                pipelineName: names.codepipeline.dbtTestAndRun,
                pipelineType: codepipeline.PipelineType.V2,
                role: pipelineRole,
                artifactBucket,
            },
        );

        dbtPipeline.addStage({
            stageName: 'Source',
            actions: [
                new codepipelineActions.CodeStarConnectionsSourceAction({
                    actionName: 'Source',
                    owner,
                    repo: repoName,
                    branch: repo.branch,
                    connectionArn: repo.codeStarConnectionArn,
                    output: sourceOutput,
                    // Hand CodeBuild a full-clone reference; it clones via the
                    // connection (UseConnection is granted in codebuild-stack).
                    codeBuildCloneOutput: true,
                }),
            ],
        });

        dbtPipeline.addStage({
            stageName: 'Build',
            actions: [
                new codepipelineActions.CodeBuildAction({
                    actionName: 'Build',
                    project: codeBuildProjects.dbtTestAndRun,
                    input: sourceOutput,
                    outputs: [buildOutput],
                }),
            ],
        });

        dbtPipeline.addStage({
            stageName: 'InvokeValidationStepFunctions',
            actions: [
                new codepipelineActions.StepFunctionInvokeAction({
                    actionName: 'invoke-glue-validation-jobs',
                    stateMachine: validationStateMachine,
                    stateMachineInput: codepipelineActions.StateMachineInput.literal({}),
                    runOrder: 1,
                }),
            ],
        });

        // 2) write-release-info pipeline (data releases — data-v* tags only)
        const relSourceOutput = new codepipeline.Artifact('RelSourceArtifact');
        const relBuildOutput = new codepipeline.Artifact('RelBuildArtifact');

        // Hoisted so the V2 git-tag trigger below can reference it.
        const relSourceAction = new codepipelineActions.CodeStarConnectionsSourceAction({
            actionName: 'Source',
            owner,
            repo: repoName,
            branch: repo.branch,
            connectionArn: repo.codeStarConnectionArn,
            output: relSourceOutput,
            // Full clone: CodeBuild needs the tags to derive RELEASE_TAG
            // (git tag --points-at HEAD in write_release_info.yml).
            codeBuildCloneOutput: true,
        });

        const relPipeline = new codepipeline.Pipeline(
            this,
            'WriteReleaseInfoPipeline',
            {
                pipelineName: names.codepipeline.writeReleaseInfo,
                // Explicit V2: git-tag triggers require it, and the explicit
                // prop holds even without the cdk.json feature-flag context.
                pipelineType: codepipeline.PipelineType.V2,
                role: pipelineRole,
                artifactBucket,
                // DATA tags only — a software tag (v*) or a branch push must
                // never cut a data release (doc 08's decoupling invariant).
                triggers: [{
                    providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
                    gitConfiguration: {
                        sourceAction: relSourceAction,
                        pushFilter: [{ tagsIncludes: ['data-v*'] }],
                    },
                }],
            },
        );

        relPipeline.addStage({
            stageName: 'Source',
            actions: [relSourceAction],
        });

        relPipeline.addStage({
            stageName: 'Build',
            actions: [
                new codepipelineActions.CodeBuildAction({
                    actionName: 'Build',
                    project: codeBuildProjects.dbtReleaseBuilder,
                    input: relSourceOutput,
                    outputs: [relBuildOutput],
                }),
            ],
        });

        relPipeline.addStage({
            stageName: 'write_release_jsons',
            actions: [
                new codepipelineActions.StepFunctionInvokeAction({
                    actionName: 'write_release_jsons',
                    stateMachine: writeReleaseStateMachine,
                    stateMachineInput: codepipelineActions.StateMachineInput.literal({}),
                }),
            ],
        });
    }
}
