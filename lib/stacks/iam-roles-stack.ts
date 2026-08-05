// lib/stacks/iam-roles-stack.ts
// Shared roles: the Glue ETL role and the Step Functions execution role.
// (CodeBuild and CodePipeline create their own roles in their own stacks.)
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

export interface IamRolesStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class IamRolesStack extends cdk.Stack {
    public readonly glueJobRole: iam.Role;
    public readonly stepFunctionsRole: iam.Role;

    constructor(scope: Construct, id: string, props: IamRolesStackProps) {
        super(scope, id, props);

        const { config, names } = props;
        const { accountId, region } = config;
        const prefix = `${config.projectId}-${config.environment}`;

        // -------- Glue ETL role
        this.glueJobRole = new iam.Role(this, 'GlueEtlRole', {
            roleName: names.roles.glueEtl,
            assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
        });

        const dataBucketArns = [
            names.buckets.bronze,
            names.buckets.silver,
            names.buckets.gold,
            names.buckets.metadata,
            names.buckets.validation,
            names.buckets.athenaResults,
        ].map((b) => `arn:aws:s3:::${b}`);

        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            // GetBucketLocation + the multipart actions are required by Athena
            // to "verify/create" its query output location — without them
            // StartQueryExecution fails with InvalidRequestException (the gap
            // that kept the validation Glue jobs red until 2026-07-31).
            actions: [
                's3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject',
                's3:GetBucketLocation', 's3:AbortMultipartUpload',
                's3:ListBucketMultipartUploads', 's3:ListMultipartUploadParts',
            ],
            resources: [
                ...dataBucketArns,
                ...dataBucketArns.map((arn) => `${arn}/*`),
            ],
        }));

        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables',
                'glue:GetPartition', 'glue:GetPartitions',
                'glue:CreateTable', 'glue:UpdateTable',
                'glue:DeleteTable', 'glue:BatchDeleteTable',
                'glue:BatchCreatePartition', 'glue:BatchDeletePartition',
            ],
            resources: [
                `arn:aws:glue:${region}:${accountId}:catalog`,
                `arn:aws:glue:${region}:${accountId}:database/*`,
                `arn:aws:glue:${region}:${accountId}:table/*/*`,
            ],
        }));

        // The jobs run their queries through the env's Athena workgroup
        // (mirrors the CodeBuild role's staging-parity shape).
        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'athena:StartQueryExecution', 'athena:GetQueryExecution',
                'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup',
            ],
            resources: [`arn:aws:athena:${region}:${accountId}:workgroup/${names.athena.workgroup}`],
        }));
        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'athena:ListQueryExecutions', 'athena:ListWorkGroups',
                'athena:ListDatabases', 'athena:ListTableMetadata',
            ],
            resources: ['*'],
        }));

        // The scripts resolve every name from the env's SSM tree via g3dt.
        // BOTH resources are required: GetParametersByPath authorizes against
        // the bare path (no trailing /*), GetParameter against the children.
        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            resources: [
                `arn:aws:ssm:${region}:${accountId}:parameter/${config.projectId}/${config.environment}`,
                `arn:aws:ssm:${region}:${accountId}:parameter/${config.projectId}/${config.environment}/*`,
            ],
        }));

        this.glueJobRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams',
            ],
            resources: ['*'],
        }));

        // -------- Step Functions role
        this.stepFunctionsRole = new iam.Role(this, 'StepFunctionsExecRole', {
            roleName: `${prefix}-stepfunctions-role`,
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
        });

        const glueJobArns = names.glueJobs.map(
            (job) => `arn:aws:glue:${region}:${accountId}:job/${job.name}`,
        );

        this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'glue:StartJobRun', 'glue:GetJobRun', 'glue:GetJobRuns', 'glue:BatchStopJobRun',
            ],
            resources: glueJobArns,
        }));

        this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
                'logs:DeleteLogDelivery', 'logs:ListLogDeliveries',
                'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups',
            ],
            resources: ['*'],
        }));

        this.stepFunctionsRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
                'xray:GetSamplingRules', 'xray:GetSamplingTargets',
            ],
            resources: ['*'],
        }));
    }
}
