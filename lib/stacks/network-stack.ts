// lib/stacks/network-stack.ts
//
// The pipeline's own network — nothing is borrowed from other stacks in the
// account (see docs/VPC_NETWORKING.md for why that matters). Layout:
//
//   VPC <cidr> (default 10.20.0.0/16 — must not overlap neighbouring VPCs)
//   ├── public subnets  (2 AZs)  route → IGW    hosts the NAT gateway only
//   ├── private subnets (2 AZs)  route → NAT    hosts EC2 job box + CodeBuild
//   └── S3 gateway endpoint (free; keeps S3 traffic off the NAT)
//
// Security posture: both pipeline SGs have ZERO ingress (SSM dispatch is
// outbound-only) and egress restricted to HTTPS. DNS and time-sync use
// link-local AWS services that security groups do not evaluate.
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { InputConfig } from '../config';
import { DerivedNames } from '../names';

const DEFAULT_VPC_CIDR = '10.20.0.0/16';

export interface NetworkStackProps extends cdk.StackProps {
    config: InputConfig;
    names: DerivedNames;
}

export class NetworkStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly jobRunnerSg: ec2.SecurityGroup;
    public readonly codeBuildSg: ec2.SecurityGroup;
    /** Set when gen3ApiAccess.mode = "peered". */
    public readonly gen3Peering?: ec2.CfnVPCPeeringConnection;

    constructor(scope: Construct, id: string, props: NetworkStackProps) {
        super(scope, id, props);

        const { config } = props;
        const prefix = `${config.projectId}-${config.environment}`;
        const cidr = config.network?.vpcCidr ?? DEFAULT_VPC_CIDR;
        const gen3Access = config.network?.gen3ApiAccess ?? { mode: 'public' as const };

        this.vpc = new ec2.Vpc(this, 'PipelineVpc', {
            vpcName: `${prefix}-vpc`,
            ipAddresses: ec2.IpAddresses.cidr(cidr),
            maxAzs: 2,
            // One NAT is deliberate: batch tooling tolerates an AZ outage, and
            // each NAT gateway costs ~US$50/month. Raise if that changes.
            natGateways: 1,
            subnetConfiguration: [
                { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
            ],
        });

        this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
        });

        const zeroIngressSg = (logicalId: string, name: string, description: string) => {
            const sg = new ec2.SecurityGroup(this, logicalId, {
                vpc: this.vpc,
                securityGroupName: name,
                description,
                allowAllOutbound: false,
            });
            sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443),
                'HTTPS out: AWS APIs, PyPI, GitHub, Gen3 endpoints');
            return sg;
        };

        // NOTE: EC2 GroupDescription only accepts ASCII characters.
        this.jobRunnerSg = zeroIngressSg(
            'JobRunnerSg',
            `${prefix}-job-runner-sg`,
            'EC2 job box - no ingress; SSM dispatch is outbound-only',
        );
        this.codeBuildSg = zeroIngressSg(
            'CodeBuildSg',
            `${prefix}-codebuild-sg`,
            'CodeBuild dbt projects - no ingress',
        );

        // Gen3 API access. "public" (test/prod commons): the NAT path covers
        // it, nothing to build. "peered" (VPN-secured staging commons): peer
        // into the Gen3 VPC and route to it from our private subnets — the
        // pipeline-side half of what the VPN does for a laptop. The Gen3-side
        // half (return route + ALB SG allow) is a devops step; see
        // docs/VPC_NETWORKING.md section 5a.
        if (gen3Access.mode === 'peered') {
            if (!gen3Access.peerVpcId || !gen3Access.peerVpcCidr) {
                throw new Error(
                    'network.gen3ApiAccess.mode "peered" requires peerVpcId and peerVpcCidr.',
                );
            }
            // Same-account, same-region peering is auto-accepted by CloudFormation.
            this.gen3Peering = new ec2.CfnVPCPeeringConnection(this, 'Gen3Peering', {
                vpcId: this.vpc.vpcId,
                peerVpcId: gen3Access.peerVpcId,
                tags: [{ key: 'Name', value: `${prefix}-gen3-peering` }],
            });
            this.vpc.privateSubnets.forEach((subnet, i) => {
                new ec2.CfnRoute(this, `Gen3PeerRoute${i}`, {
                    routeTableId: subnet.routeTable.routeTableId,
                    destinationCidrBlock: gen3Access.peerVpcCidr,
                    vpcPeeringConnectionId: this.gen3Peering!.ref,
                });
            });
        }
    }
}
