// test/ssm-publishing.test.ts
//
// The drift guard: synths the WHOLE app via buildApp() and asserts that every
// physical name the resource stacks create appears as the Value of some SSM
// parameter. Add a bucket / DB / role / project / pipeline / state machine
// without a matching entry in lib/ssm-keys.ts and this goes red. The
// key-parity test catches the reverse (a published name whose resource is gone).
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InputConfig } from '../lib/config';
import { buildApp } from '../lib/build-app';
import { ssmParameters } from '../lib/ssm-keys';

// Placeholder fixture, never config/*.json: wrapper checkouts overlay their
// own config/ and `npm test` must stay green inside them. The drift guard
// only needs the SHAPE of the names, not real deployment values.
const config: InputConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'pipeline-config.json'), 'utf-8'),
);

const app = new cdk.App();
const { names, stacks } = buildApp(app, config);
const ssmTemplate = Template.fromStack(stacks.ssm);
const base = `/${config.projectId}/${config.environment}`;

// The keys this config should publish, read from the same map the stack
// publishes from. Derived, never hardcoded: a fork that adds a parameter to
// lib/ssm-keys.ts stays green here without also editing a total by hand.
// ec2/instanceId is absent on purpose — the EC2 stack publishes it (runtime
// token of a replaceable instance; a cross-stack reference would block
// replacement), and the test below asserts exactly that split.
const EXPECTED_PARAM_NAMES = Object.keys(ssmParameters(config, names))
    .map((key) => `${base}/${key}`);

/** Every string Value published to SSM (the instanceId token is an object, skipped). */
const publishedValues = new Set<string>(
    Object.values(ssmTemplate.findResources('AWS::SSM::Parameter'))
        .map((r) => r.Properties?.Value)
        .filter((v): v is string => typeof v === 'string'),
);

/** Pull a (possibly nested, dot-path) physical-name property off every resource of a type. */
function namesOf(stack: cdk.Stack, type: string, propPath: string): string[] {
    const res = Template.fromStack(stack).findResources(type);
    return Object.values(res)
        .map((r) => propPath.split('.').reduce<any>((o, k) => o?.[k], r.Properties))
        .filter((v): v is string => typeof v === 'string');
}

describe('SSM publishing — every named resource is exported (drift guard)', () => {
    it('exports every S3 bucket name', () => {
        const created = [
            ...namesOf(stacks.buckets, 'AWS::S3::Bucket', 'BucketName'),
            ...namesOf(stacks.artifactBucket, 'AWS::S3::Bucket', 'BucketName'),
        ];
        expect(created.length).toBeGreaterThan(0);
        for (const n of created) expect(publishedValues).toContain(n);
    });

    it('exports every Glue database name', () => {
        const created = namesOf(stacks.glueCatalog, 'AWS::Glue::Database', 'DatabaseInput.Name');
        expect(created.length).toBe(7);
        for (const n of created) expect(publishedValues).toContain(n);
    });

    it('exports the Glue ETL role name', () => {
        const created = namesOf(stacks.iamRoles, 'AWS::IAM::Role', 'RoleName');
        expect(created).toContain(names.roles.glueEtl);
        expect(publishedValues).toContain(names.roles.glueEtl);
    });

    it('exports every CodeBuild project, pipeline, and state machine name', () => {
        for (const n of namesOf(stacks.codeBuild, 'AWS::CodeBuild::Project', 'Name'))
            expect(publishedValues).toContain(n);
        for (const n of namesOf(stacks.codePipeline, 'AWS::CodePipeline::Pipeline', 'Name'))
            expect(publishedValues).toContain(n);
        for (const n of namesOf(stacks.stepFunctions, 'AWS::StepFunctions::StateMachine', 'StateMachineName'))
            expect(publishedValues).toContain(n);
    });

    it('the EC2 stack publishes its own instanceId param (no cross-stack export)', () => {
        Template.fromStack(stacks.ec2).hasResourceProperties('AWS::SSM::Parameter', {
            Name: `${base}/ec2/instanceId`,
        });
        // and the SSM stack must NOT publish it — that reintroduces the export
        expect(Object.values(ssmTemplate.findResources('AWS::SSM::Parameter'))
            .filter((p) => p.Properties?.Name === `${base}/ec2/instanceId`)).toHaveLength(0);
    });

    it('exports the app/* facts the CLI resolves at runtime', () => {
        for (const leaf of [
            'app/dictionary_version', 'app/aws_secret_name', 'app/schema_s3_uri',
            'app/domain', 'app/app_name', 'app/namespace', 'app/cluster_name', 'app/schema_repo',
        ]) {
            ssmTemplate.hasResourceProperties('AWS::SSM::Parameter', { Name: `${base}/${leaf}` });
        }
    });

    it('publishes exactly the keys in the shared map — none missing, none stray', () => {
        // Input:    the fixture config synthed through buildApp().
        // Expected: the set of parameter Names in the SSM stack is exactly the
        //           set of keys in lib/ssm-keys.ts, prefixed with /project/env.
        //
        // This is the parity check that makes the map trustworthy as a
        // contract. A key added to the map but never published (or a put()
        // reintroduced outside the map) fails here, which matters because
        // scripts/integration_test.sh probes a LIVE tree against this same map
        // — a map that lies would turn every deployment red for no reason.
        const published = Object.values(ssmTemplate.findResources('AWS::SSM::Parameter'))
            .map((r) => r.Properties?.Name as string);
        expect([...published].sort()).toEqual([...EXPECTED_PARAM_NAMES].sort());

        // Set equality above would hide a duplicate Name published under two
        // logical IDs; the raw resource count would not.
        ssmTemplate.resourceCountIs('AWS::SSM::Parameter', EXPECTED_PARAM_NAMES.length);
    });

    it('pins the medallion SSM key paths — the cross-repo contract', () => {
        // These exact key strings are read by the toolkit (dbt-env, release
        // search) and this repo's own glue-scripts via rc.get(). Nothing else
        // in the suite asserts the key PATHS, so before this test a key
        // rename kept everything green here while silently breaking every
        // consumer (rc.get returns None — no error, wrong warehouse). If this
        // test breaks, you are changing a published contract: coordinate a
        // toolkit release and a major version bump.
        for (const key of [
            'buckets/bronze', 'buckets/silver', 'buckets/gold',
            'glue/db/bronze', 'glue/db/silver', 'glue/db/gold',
            'glue/db/ciSilver', 'glue/db/ciGold',
        ]) {
            ssmTemplate.hasResourceProperties('AWS::SSM::Parameter', {
                Name: `${base}/${key}`,
            });
        }
    });
});

describe('NetworkStack — the pipeline owns its network, zero ingress', () => {
    const netTemplate = Template.fromStack(stacks.network);

    it('creates one VPC, one NAT gateway, and an S3 gateway endpoint', () => {
        netTemplate.resourceCountIs('AWS::EC2::VPC', 1);
        netTemplate.resourceCountIs('AWS::EC2::NatGateway', 1);
        netTemplate.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    });

    it('pipeline security groups have no ingress and HTTPS-only egress', () => {
        const sgs = Object.values(netTemplate.findResources('AWS::EC2::SecurityGroup'));
        expect(sgs.length).toBe(2);
        for (const sg of sgs) {
            expect(sg.Properties?.SecurityGroupIngress).toBeUndefined();
            const egress = sg.Properties?.SecurityGroupEgress ?? [];
            expect(egress).toHaveLength(1);
            expect(egress[0].FromPort).toBe(443);
            expect(egress[0].ToPort).toBe(443);
        }
    });

    it('public Gen3 API access (the default) creates no peering', () => {
        netTemplate.resourceCountIs('AWS::EC2::VPCPeeringConnection', 0);
    });

    it('AWS-bound description strings are printable ASCII (EC2 rejects anything else)', () => {
        const ascii = /^[\x20-\x7E]*$/;
        for (const sg of Object.values(netTemplate.findResources('AWS::EC2::SecurityGroup'))) {
            expect(sg.Properties?.GroupDescription).toMatch(ascii);
        }
        const ec2T = Template.fromStack(stacks.ec2);
        for (const alarm of Object.values(ec2T.findResources('AWS::CloudWatch::Alarm'))) {
            expect(alarm.Properties?.AlarmDescription ?? '').toMatch(ascii);
        }
    });
});

describe('NetworkStack — peered Gen3 API access (VPN-secured environments)', () => {
    const peeredConfig: InputConfig = {
        ...config,
        environment: 'peertest',
        network: {
            vpcCidr: '10.20.0.0/16',
            gen3ApiAccess: {
                mode: 'peered',
                peerVpcId: 'vpc-0gen3staging000000',
                peerVpcCidr: '10.17.0.0/16',
            },
        },
    };
    const peeredApp = new cdk.App();
    const peered = buildApp(peeredApp, peeredConfig);
    const netTemplate = Template.fromStack(peered.stacks.network);

    it('creates the peering and a route from every private subnet', () => {
        netTemplate.resourceCountIs('AWS::EC2::VPCPeeringConnection', 1);
        netTemplate.hasResourceProperties('AWS::EC2::VPCPeeringConnection', {
            PeerVpcId: 'vpc-0gen3staging000000',
        });
        const routes = Object.values(netTemplate.findResources('AWS::EC2::Route'))
            .filter((r) => r.Properties?.DestinationCidrBlock === '10.17.0.0/16');
        expect(routes).toHaveLength(2); // one per private subnet (2 AZs)
        for (const r of routes) expect(r.Properties?.VpcPeeringConnectionId).toBeDefined();
    });

    it('rejects peered mode without the peer VPC details', () => {
        const badApp = new cdk.App();
        expect(() => buildApp(badApp, {
            ...peeredConfig,
            environment: 'peerbad',
            network: { gen3ApiAccess: { mode: 'peered' } },
        })).toThrow(/peerVpcId and peerVpcCidr/);
    });
});

describe('CodeBuild sources from the pipeline connection (no PAT needed)', () => {
    it('projects have a CODEPIPELINE source, never a GitHub one', () => {
        const cbTemplate = Template.fromStack(stacks.codeBuild);
        const projects = Object.values(cbTemplate.findResources('AWS::CodeBuild::Project'));
        expect(projects).toHaveLength(2);
        for (const p of projects) {
            expect(p.Properties?.Source?.Type).toBe('CODEPIPELINE');
        }
    });

    it('the CodeBuild role can run dbt: workgroup-scoped Athena + read-only bronze', () => {
        const cbTemplate = Template.fromStack(stacks.codeBuild);
        const statements = Object.values(cbTemplate.findResources('AWS::IAM::Policy'))
            .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);
        const flat = JSON.stringify(statements);

        // Athena is scoped to the env's workgroup, not '*' (staging pattern)
        expect(flat).toContain(`:workgroup/${names.athena.workgroup}`);
        expect(flat).toContain('athena:StartQueryExecution');
        // Glue write actions exist for the dbt-managed DBs
        expect(flat).toContain('glue:DeleteTable');
        // bronze objects are read-only: no statement grants PutObject on the bronze bucket
        const bronzeWrites = statements.filter((s) =>
            JSON.stringify(s.Action).includes('s3:PutObject') &&
            JSON.stringify(s.Resource).includes(names.buckets.bronze));
        expect(bronzeWrites).toHaveLength(0);
        // and no ci bronze database exists to grant Glue writes on
        expect(flat).not.toContain(`database/ci_${names.glueDatabases.bronze}`);
    });

    it('pipeline source actions hand over a full-clone reference', () => {
        const cpTemplate = Template.fromStack(stacks.codePipeline);
        const pipelines = Object.values(cpTemplate.findResources('AWS::CodePipeline::Pipeline'));
        expect(pipelines).toHaveLength(2);
        for (const p of pipelines) {
            const sourceAction = p.Properties?.Stages?.[0]?.Actions?.[0];
            expect(sourceAction?.Configuration?.OutputArtifactFormat).toBe('CODEBUILD_CLONE_REF');
        }
    });
});

describe('EC2 job-runner stack synthesises the dispatch preconditions', () => {
    const ec2Template = Template.fromStack(stacks.ec2);

    it('creates the instance, its role, and the job log group', () => {
        ec2Template.resourceCountIs('AWS::EC2::Instance', 1);
        ec2Template.hasResourceProperties('AWS::IAM::Role', {
            RoleName: `${config.projectId}-${config.environment}-ec2-job-runner-role`,
        });
        ec2Template.hasResourceProperties('AWS::Logs::LogGroup', {
            LogGroupName: names.ec2.logGroup,
        });
    });

    it('the instance role is SSM-managed (Run Command / Session Manager, no SSH)', () => {
        const roles = ec2Template.findResources('AWS::IAM::Role');
        const managed = JSON.stringify(Object.values(roles).map((r) => r.Properties?.ManagedPolicyArns));
        expect(managed).toContain('AmazonSSMManagedInstanceCore');
    });

    it('the role can GetParametersByPath on the BARE tree path (not just children)', () => {
        // GetParametersByPath authorizes against parameter/<project>/<env>
        // itself; a /*-only grant fails at runtime (found live on 2026-07-15).
        const statements = Object.values(ec2Template.findResources('AWS::IAM::Policy'))
            .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);
        const ssmStmt = statements.find((s) =>
            JSON.stringify(s.Action).includes('ssm:GetParametersByPath'));
        expect(ssmStmt).toBeDefined();
        const resources = JSON.stringify(ssmStmt.Resource);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}"`);
        expect(resources).toContain(`parameter/${config.projectId}/${config.environment}/*`);
    });

    it('secrets access is scoped to exactly the secret named in the config', () => {
        const policies = Object.values(ec2Template.findResources('AWS::IAM::Policy'));
        const statements = policies.flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []);
        const secretStmts = statements.filter((s) =>
            JSON.stringify(s.Action).includes('secretsmanager:GetSecretValue'));
        expect(secretStmts).toHaveLength(1);
        const resources = JSON.stringify(secretStmts[0].Resource);
        expect(resources).toContain(`secret:${config.gen3.awsSecretName}*`);
        expect(resources).not.toContain('secret:*"');
    });

    it('an idle box auto-stops: 24x 1h periods under 1% CPU (staging alarm parity)', () => {
        ec2Template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            MetricName: 'CPUUtilization',
            Statistic: 'Average',
            Period: 3600,
            EvaluationPeriods: 24,
            DatapointsToAlarm: 24,
            Threshold: 1,
            ComparisonOperator: 'LessThanThreshold',
            TreatMissingData: 'ignore',
        });
        const alarms = Object.values(ec2Template.findResources('AWS::CloudWatch::Alarm'));
        expect(JSON.stringify(alarms[0].Properties?.AlarmActions)).toContain(':ec2:stop');
    });

    it('no SNS resources unless alertEmail is configured', () => {
        ec2Template.resourceCountIs('AWS::SNS::Topic', 0);

        const alertApp = new cdk.App();
        const alertConfig: InputConfig = {
            ...config,
            environment: 'alerts',
            ec2: { ...config.ec2, alertEmail: 'data-team@example.org' },
        };
        const withAlerts = Template.fromStack(buildApp(alertApp, alertConfig).stacks.ec2);
        withAlerts.resourceCountIs('AWS::SNS::Topic', 1);
        withAlerts.hasResourceProperties('AWS::SNS::Subscription', {
            Protocol: 'email',
            Endpoint: 'data-team@example.org',
        });
        const alarms = Object.values(withAlerts.findResources('AWS::CloudWatch::Alarm'));
        expect(alarms[0].Properties?.AlarmActions).toHaveLength(2);
    });
});
