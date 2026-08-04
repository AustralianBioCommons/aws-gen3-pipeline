// lib/stacks/ec2-job-runner-stack.ts
//
// The long-job box the CLI dispatches data-plane work to (metadata upload,
// indexd register) via SSM Run Command. One instance per environment — the
// old manual pipeline shared a single box across test/staging/prod, which is
// the data-safety bug this stack exists to fix.
//
// Operational model: no SSH, no git credentials. The box is SSM-managed
// (AmazonSSMManagedInstanceCore), the toolkit arrives via pip in user-data,
// and the CLI on the box resolves all names from this env's SSM tree using
// the instance profile. `keyName` is an optional break-glass extra.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

// Auto-stop thresholds — fixed, mirroring the proven manual staging alarm
// (the legacy upload-box auto-stop alarm): stop the box after 24 consecutive 1-hour
// periods averaging under 1% CPU.
const AUTO_STOP_IDLE_HOURS = 24;
const AUTO_STOP_CPU_THRESHOLD_PCT = 1;

export interface Ec2JobRunnerStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
    /** The pipeline-owned VPC and zero-ingress SG from NetworkStack. */
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
}

export class Ec2JobRunnerStack extends cdk.Stack {
    /** Runtime token — resolved by CloudFormation at deploy, published to SSM. */
    public readonly instanceId: string;
    public readonly logGroupName: string;

    constructor(scope: Construct, id: string, props: Ec2JobRunnerStackProps) {
        super(scope, id, props);

        const { config, names, vpc, securityGroup } = props;
        const { projectId, environment, accountId, region, ec2: ec2Cfg } = config;
        const prefix = `${projectId}-${environment}`;

        // Log group dispatched-job stdout/stderr streams to (`g3dt jobs logs --follow`)
        const logGroup = new logs.LogGroup(this, 'JobLogs', {
            logGroupName: names.ec2.logGroup,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const role = new iam.Role(this, 'JobRunnerRole', {
            roleName: `${prefix}-ec2-job-runner-role`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                // SSM Run Command / Session Manager instead of SSH
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        const bucketArns = Object.values(names.buckets).map((b) => `arn:aws:s3:::${b}`);
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
            resources: [...bucketArns, ...bucketArns.map((a) => `${a}/*`)],
        }));
        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                'athena:StartQueryExecution', 'athena:GetQueryExecution',
                'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup',
            ],
            resources: ['*'],
        }));
        role.addToPolicy(new iam.PolicyStatement({
            actions: [
                'glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartitions',
                'glue:CreateTable', 'glue:UpdateTable', 'glue:BatchCreatePartition',
            ],
            resources: ['*'],
        }));
        // Secrets access is config-driven: the box can read exactly the Gen3
        // API-key secret named in gen3.awsSecretName, nothing else. The
        // trailing * covers the random suffix Secrets Manager appends to ARNs.
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                `arn:aws:secretsmanager:${region}:${accountId}:secret:${config.gen3.awsSecretName}*`,
            ],
        }));
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
            resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
        }));
        // The CLI on the box resolves names from its own env's SSM tree.
        // BOTH resources are required: GetParametersByPath authorizes against
        // the bare path (no trailing /*), GetParameter against the children.
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            resources: [
                `arn:aws:ssm:${region}:${accountId}:parameter/${projectId}/${environment}`,
                `arn:aws:ssm:${region}:${accountId}:parameter/${projectId}/${environment}/*`,
            ],
        }));

        // Bootstrap: python + the toolkit, plus the g3dt marker.
        // The marker is written BOTH as a file and as env vars because the
        // toolkit's load_marker() reads repo_root()/g3dt.yaml or env vars —
        // and a pip-only box has no repo root.
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
            'set -euxo pipefail',
            'dnf install -y python3.11 python3.11-pip',
            'python3.11 -m pip install --upgrade pip',
            `python3.11 -m pip install "gen3-dataops-toolkit==${config.toolkitVersion}"`,
            'mkdir -p /etc/g3dt',
            `printf 'project: %s\\nregion: %s\\ndefault_env: %s\\n' '${projectId}' '${region}' '${environment}' > /etc/g3dt/g3dt.yaml`,
            // AWS_DEFAULT_REGION too: botocore honours it but NOT plain AWS_REGION
            `printf 'export G3DT_PROJECT=%s\\nexport AWS_REGION=%s\\nexport AWS_DEFAULT_REGION=%s\\nexport G3DT_DEFAULT_ENV=%s\\n' '${projectId}' '${region}' '${region}' '${environment}' > /etc/profile.d/g3dt.sh`,
        );

        const instance = new ec2.Instance(this, 'JobRunner', {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroup,
            instanceType: new ec2.InstanceType(ec2Cfg.instanceType),
            machineImage: ec2.MachineImage.genericLinux({ [region]: ec2Cfg.ami }),
            keyPair: ec2Cfg.keyName
                ? ec2.KeyPair.fromKeyPairName(this, 'JobBoxKey', ec2Cfg.keyName)
                : undefined,
            role,
            userData,
            // User-data only runs on an instance's FIRST boot; without this,
            // a bootstrap change (e.g. a toolkitVersion bump) is silently
            // applied-but-never-executed. This replaces the instance instead,
            // and the new instanceId flows to SSM automatically.
            userDataCausesReplacement: true,
        });
        cdk.Tags.of(instance).add('Name', `${prefix}-job-runner`);

        // The instanceId parameter lives HERE, not in the SSM stack: its value
        // is a runtime token of a replaceable resource, and referencing it
        // cross-stack creates an export that blocks instance replacement
        // ("Cannot delete export ... in use by ...-ssm-parameters").
        new ssm.StringParameter(this, 'InstanceIdParam', {
            parameterName: `/${projectId}/${environment}/ec2/instanceId`,
            stringValue: instance.instanceId,
        });

        // Auto-stop the box when idle so it doesn't bill forever. Missing data
        // is ignored: a stopped instance emits no metrics, so the alarm holds
        // its state instead of flapping/re-firing. Restart with
        // `aws ec2 start-instances` (or the CLI's ec2 up).
        const autoStopAlarm = new cloudwatch.Alarm(this, 'AutoStopAlarm', {
            alarmName: `${prefix}-ec2-auto-stop`,
            alarmDescription:
                `Stops the ${prefix} job box after ${AUTO_STOP_IDLE_HOURS}h averaging ` +
                `under ${AUTO_STOP_CPU_THRESHOLD_PCT}% CPU`,
            metric: new cloudwatch.Metric({
                namespace: 'AWS/EC2',
                metricName: 'CPUUtilization',
                dimensionsMap: { InstanceId: instance.instanceId },
                statistic: 'Average',
                period: cdk.Duration.hours(1),
            }),
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            threshold: AUTO_STOP_CPU_THRESHOLD_PCT,
            evaluationPeriods: AUTO_STOP_IDLE_HOURS,
            datapointsToAlarm: AUTO_STOP_IDLE_HOURS,
            treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        });
        autoStopAlarm.addAlarmAction(
            new cloudwatchActions.Ec2Action(cloudwatchActions.Ec2InstanceAction.STOP),
        );

        if (ec2Cfg.alertEmail) {
            const alertTopic = new sns.Topic(this, 'Ec2AlertsTopic', {
                topicName: `${prefix}-ec2-alerts`,
            });
            alertTopic.addSubscription(
                new snsSubscriptions.EmailSubscription(ec2Cfg.alertEmail),
            );
            autoStopAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
        }

        this.instanceId = instance.instanceId;
        this.logGroupName = logGroup.logGroupName;
    }
}
