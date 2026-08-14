// lib/stacks/stepfunctions-stack.ts
// Two state machines orchestrating the Glue jobs. Jobs are looked up by their
// stable `key` (not display name) because deployed job names are env-prefixed.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface StepFunctionsStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
    stepFunctionsRole: iam.IRole;
}

export class StepFunctionsStack extends cdk.Stack {
    public readonly validationStateMachineName: string;
    public readonly validationCiStateMachineName: string;
    public readonly writeReleaseJsonsStateMachineName: string;

    constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
        super(scope, id, props);

        const { config, names } = props;
        const { projectId, environment } = config;
        const role = props.stepFunctionsRole;

        const glueJob = (key: string): string => {
            const job = names.glueJobs.find((j) => j.key === key);
            if (!job) {
                throw new Error(`No Glue job with key "${key}" in deriveNames()`);
            }
            return job.name;
        };

        const validationLogGroup = new logs.LogGroup(this, 'ValidationLogs', {
            logGroupName: `/aws/vendedlogs/states/${projectId}-${environment}-validation`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const validationCiLogGroup = new logs.LogGroup(this, 'ValidationCiLogs', {
            logGroupName: `/aws/vendedlogs/states/${projectId}-${environment}-validation-ci`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const writeReleaseLogGroup = new logs.LogGroup(this, 'WriteReleaseLogs', {
            logGroupName: `/aws/vendedlogs/states/${projectId}-${environment}-write-release-jsons`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // Both validation machines run the SAME two Glue jobs; only --DB_TARGET
        // differs. 'ci' points them at the ci_* databases the dbt `ci` target
        // builds (so the commit-triggered pipeline grades what it just built);
        // 'real' points them at the real warehouse for runbook step 9. The two
        // targets write different results tables — see the DB_TARGETS block in
        // glue-scripts/silver_json_gen3_validator.py.
        //
        // Passing it as a job Argument rather than as Step Functions input
        // keeps each machine unambiguous: a hand-started execution with no
        // input still validates the target its name says it does.
        const validationDefinition = (dbTarget: 'real' | 'ci') => ({
            Comment: `Orchestrate validation Glue jobs sequentially (${dbTarget} databases)`,
            StartAt: 'DumpAthenaToJson',
            States: {
                DumpAthenaToJson: {
                    Type: 'Task',
                    Resource: 'arn:aws:states:::glue:startJobRun.sync',
                    Parameters: {
                        JobName: glueJob('writeValidationJsons'),
                        Arguments: { '--DB_TARGET': dbTarget },
                    },
                    Next: 'ValidateJson',
                },
                ValidateJson: {
                    Type: 'Task',
                    Resource: 'arn:aws:states:::glue:startJobRun.sync',
                    Parameters: {
                        JobName: glueJob('silverJsonGen3Validator'),
                        // Must match DumpAthenaToJson: the validator reads the
                        // JSONs that job wrote, under a target-scoped prefix.
                        Arguments: { '--DB_TARGET': dbTarget },
                    },
                    End: true,
                },
            },
        });

        const writeReleaseDefinition = {
            Comment: 'Trigger Glue job to write release JSONs',
            StartAt: 'StartGlueJob',
            States: {
                StartGlueJob: {
                    Type: 'Task',
                    Resource: 'arn:aws:states:::glue:startJobRun.sync',
                    Parameters: {
                        JobName: glueJob('writeDataReleaseToJson'),
                    },
                    End: true,
                },
            },
        };

        const validationSm = new sfn.CfnStateMachine(this, 'ValidationStateMachine', {
            stateMachineName: names.stepFunctions.validation,
            roleArn: role.roleArn,
            stateMachineType: 'STANDARD',
            definitionString: JSON.stringify(validationDefinition('real')),
            loggingConfiguration: {
                level: 'ERROR',
                includeExecutionData: true,
                destinations: [
                    {
                        cloudWatchLogsLogGroup: { logGroupArn: validationLogGroup.logGroupArn },
                    },
                ],
            },
            tracingConfiguration: {
                enabled: true,
            },
        });

        const validationCiSm = new sfn.CfnStateMachine(this, 'ValidationCiStateMachine', {
            stateMachineName: names.stepFunctions.validationCi,
            roleArn: role.roleArn,
            stateMachineType: 'STANDARD',
            definitionString: JSON.stringify(validationDefinition('ci')),
            loggingConfiguration: {
                level: 'ERROR',
                includeExecutionData: true,
                destinations: [
                    {
                        cloudWatchLogsLogGroup: { logGroupArn: validationCiLogGroup.logGroupArn },
                    },
                ],
            },
            tracingConfiguration: {
                enabled: true,
            },
        });

        const writeReleaseSm = new sfn.CfnStateMachine(
            this,
            'WriteReleaseJsonsStateMachine',
            {
                stateMachineName: names.stepFunctions.writeReleaseJsons,
                roleArn: role.roleArn,
                stateMachineType: 'STANDARD',
                definitionString: JSON.stringify(writeReleaseDefinition),
                loggingConfiguration: {
                    level: 'OFF',
                    includeExecutionData: false,
                    destinations: [
                        {
                            cloudWatchLogsLogGroup: {
                                logGroupArn: writeReleaseLogGroup.logGroupArn,
                            },
                        },
                    ],
                },
                tracingConfiguration: {
                    enabled: true,
                },
            },
        );

        this.validationStateMachineName =
            validationSm.stateMachineName ?? names.stepFunctions.validation;
        this.validationCiStateMachineName =
            validationCiSm.stateMachineName ?? names.stepFunctions.validationCi;
        this.writeReleaseJsonsStateMachineName =
            writeReleaseSm.stateMachineName ?? names.stepFunctions.writeReleaseJsons;
    }
}
