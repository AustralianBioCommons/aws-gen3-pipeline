// lib/stacks/codebuild-stack.ts
// The two dbt CodeBuild projects, run inside the pipeline VPC.
//
// Source model (mirrors the proven manual pipeline): the projects have a
// CODEPIPELINE source — they never authenticate to GitHub themselves and no
// PAT / imported source credentials are needed. The pipeline's Source stage
// checks the dbt repo out through the CodeConnections connection and hands
// CodeBuild a full-clone reference (CODEBUILD_CLONE_REF); CodeBuild performs
// the git clone using the connection, authorized by the UseConnection grant
// on its role below.
//
// Buildspec paths are facts about the dbt repo's layout (see
// gen3-dbt-template/.codepipeline/). The buildspecs are name-free: the CDK
// injects only PROJECT_ID + ENV, and everything else resolves from the env's
// SSM tree at build time (june_refactor_plan doc 06).
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

const DBT_TEST_AND_RUN_BUILDSPEC = '.codepipeline/dbt_test_and_run.yml';
const DBT_RELEASE_BUILDER_BUILDSPEC = '.codepipeline/write_release_info.yml';

export interface CodeBuildStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
    /** The pipeline-owned VPC and zero-ingress SG from NetworkStack. */
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
}

export class CodeBuildStack extends cdk.Stack {
    public readonly dbtTestAndRunProject: codebuild.IProject;
    public readonly dbtReleaseBuilderProject: codebuild.IProject;

    constructor(scope: Construct, id: string, props: CodeBuildStackProps) {
        super(scope, id, props);

        const { config, names, vpc, securityGroup } = props;
        const { accountId, region } = config;

        const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
            roleName: `${config.projectId}-${config.environment}-codebuild-role`,
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
        });

        // Data permissions modelled on the proven manual staging role
        // (dbt-test-and-run service-role policy in the legacy deployment), translated
        // to derived names: dbt reads bronze, writes silver/gold/metadata/
        // validation, and runs everything through the env's Athena workgroup.
        const rwBuckets = [
            names.buckets.rawSilver,
            names.buckets.rawGold,
            names.buckets.metadata,
            names.buckets.validation,
            names.buckets.athenaResults,
        ].map((b) => `arn:aws:s3:::${b}`);
        const bronzeBucket = `arn:aws:s3:::${names.buckets.rawBronze}`;

        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'BucketList',
            actions: ['s3:ListBucket', 's3:GetBucketLocation'],
            resources: [...rwBuckets, bronzeBucket],
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ReadWriteObjects',
            actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:PutObjectAcl'],
            resources: rwBuckets.map((arn) => `${arn}/*`),
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ReadOnlyBronzeObjects',
            actions: ['s3:GetObject'],
            resources: [`${bronzeBucket}/*`],
        }));

        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AthenaWorkgroupScoped',
            actions: [
                'athena:StartQueryExecution', 'athena:GetQueryExecution',
                'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup',
            ],
            resources: [`arn:aws:athena:${region}:${accountId}:workgroup/${names.athena.workgroup}`],
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AthenaList',
            actions: [
                'athena:ListQueryExecutions', 'athena:ListWorkGroups',
                'athena:ListDatabases', 'athena:ListTableMetadata',
            ],
            resources: ['*'],
        }));

        const glueDbArns = (dbs: string[]) => dbs.flatMap((db) => [
            `arn:aws:glue:${region}:${accountId}:database/${db}`,
            `arn:aws:glue:${region}:${accountId}:table/${db}/*`,
        ]);
        const catalogArn = `arn:aws:glue:${region}:${accountId}:catalog`;

        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'GlueReadWriteDbtDatabases',
            actions: [
                'glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables',
                'glue:GetPartition', 'glue:GetPartitions', 'glue:SearchTables',
                'glue:CreateTable', 'glue:UpdateTable', 'glue:DeleteTable', 'glue:BatchDeleteTable',
                'glue:CreatePartition', 'glue:UpdatePartition', 'glue:DeletePartition',
                'glue:BatchCreatePartition', 'glue:BatchDeletePartition',
                'glue:CreatePartitionIndex', 'glue:DeletePartitionIndex',
                'glue:GetTableVersion', 'glue:GetTableVersions',
                'glue:DeleteTableVersion', 'glue:BatchDeleteTableVersion',
                'glue:UpdateColumnStatisticsForTable', 'glue:UpdateColumnStatisticsForPartition',
                'glue:GetUserDefinedFunctions',
            ],
            resources: [
                catalogArn,
                ...glueDbArns([
                    names.glueDatabases.rawSilver,
                    names.glueDatabases.rawGold,
                    names.glueDatabases.metadata,
                    names.glueDatabases.validation,
                    // CI isolation: the ci dbt target writes these instead of
                    // the real silver/gold databases.
                    names.glueDatabases.ciRawSilver,
                    names.glueDatabases.ciRawGold,
                ]),
            ],
        }));
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'GlueReadOnlyBronze',
            actions: [
                'glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables',
                'glue:GetPartition', 'glue:GetPartitions',
                'glue:GetTableVersion', 'glue:GetTableVersions', 'glue:SearchTables',
            ],
            resources: [
                ...glueDbArns([names.glueDatabases.rawBronze]),
                `arn:aws:glue:${region}:${accountId}:database/default`,
            ],
        }));

        // Resolve names from SSM at build time: the buildspecs read the
        // toolkit pin (meta/toolkitVersion) and the dbt settings via
        // `g3dt config dbt-env`, and `g3dt release write` reads release/*.
        // BOTH resources are required: GetParametersByPath authorizes against
        // the bare path (no trailing /*), GetParameter against the children.
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ReadOwnSsmTree',
            actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            resources: [
                `arn:aws:ssm:${region}:${accountId}:parameter/${config.projectId}/${config.environment}`,
                `arn:aws:ssm:${region}:${accountId}:parameter/${config.projectId}/${config.environment}/*`,
            ],
        }));

        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup', 'logs:CreateLogStream',
                'logs:PutLogEvents', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams',
            ],
            resources: ['*'],
        }));

        // Lets CodeBuild git-clone the private dbt repo through the pipeline's
        // CodeConnections connection (CODEBUILD_CLONE_REF source artifacts).
        codeBuildRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'codestar-connections:UseConnection',
                'codeconnections:UseConnection',
            ],
            resources: [config.repo.codeStarConnectionArn],
        }));

        const mkProject = (logicalId: string, projectName: string, buildspec: string) =>
            new codebuild.PipelineProject(this, logicalId, {
                projectName,
                environment: {
                    buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
                    computeType: codebuild.ComputeType.SMALL,
                    privileged: false,
                },
                // PROJECT_ID + ENV are the ONLY injected variables — the
                // buildspecs resolve everything else from SSM. Every extra
                // injected name would be a name source creeping back in.
                environmentVariables: {
                    PROJECT_ID: { value: config.projectId },
                    ENV: { value: config.environment },
                },
                vpc,
                securityGroups: [securityGroup],
                subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                buildSpec: codebuild.BuildSpec.fromSourceFilename(buildspec),
                role: codeBuildRole,
            });

        this.dbtTestAndRunProject = mkProject(
            'DbtTestAndRunProject',
            names.codebuild.dbtTestAndRun,
            DBT_TEST_AND_RUN_BUILDSPEC,
        );

        this.dbtReleaseBuilderProject = mkProject(
            'DbtReleaseBuilderProject',
            names.codebuild.dbtReleaseBuilder,
            DBT_RELEASE_BUILDER_BUILDSPEC,
        );
    }
}
