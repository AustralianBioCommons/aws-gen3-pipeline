# VPC & Networking for the Gen3 Data Pipeline

How the pipeline uses networks: which components attach to a VPC and why, the network
the CDK builds for each environment, how that network reaches the Gen3 commons API, and
the security posture that falls out of the design.

---

## 1. The pipeline's networking consumers

Only **two** components of this pipeline attach to a VPC. Everything else is
serverless and uses AWS-managed networking.

| # | Consumer | Why it needs a network | Direction |
|---|----------|------------------------|-----------|
| 1 | **EC2 job box** | Long data-plane jobs (metadata upload, indexd register): AWS APIs (SSM, S3, Athena, Glue, Secrets Manager, CloudWatch Logs, STS), HTTPS to the Gen3 commons API (which may be internal — see section 3), PyPI during bootstrap | **Outbound only** — SSM Run Command/Session Manager works by the agent polling out; nothing needs to connect in |
| 2 | **CodeBuild projects** (`<project>-<env>-dbt-test-and-run`, `<project>-<env>-dbt-release-builder`) | dbt against Athena/Glue/S3, pip + dbt package downloads, GitHub checkout | Outbound only |

**Glue jobs deliberately use no VPC.** A python-shell job **without** a connection runs
in Glue's own service network **with internet access** — `--additional-python-modules`
(pip) and calls to public endpoints work fine, so the CDK attaches no connection to any
job. A NETWORK connection would only be reintroduced if a job someday must reach
**private-IP resources inside a VPC** or must egress from a **stable, allowlistable
IP**; note that attaching one *removes* Glue-managed internet and makes the job depend
on a private subnet + NAT route.

Explicitly **not** VPC-attached:

- **Athena, Glue Data Catalog, Glue jobs, Step Functions, CodePipeline, Secrets Manager, SSM** — serverless/managed.
- **The `g3dt` CLI / dbt on a laptop** — the operator's machine, public AWS APIs via SSO.
- The Gen3 deployment's own VPC and EKS cluster belong to the Gen3 platform, not this pipeline.

### 1a. The CLI dispatch path, end to end

`g3dt … --on ec2` and `g3dt jobs` create these network flows:

| Flow | From → To | Network path |
|---|---|---|
| `ssm:SendCommand` / `GetCommandInvocation` / `CancelCommand` (dispatch, `jobs status/stop`) | laptop → AWS API | public AWS endpoints, SSO creds — VPC not involved |
| `ec2:Start/Stop/DescribeInstances` (`ec2 up/down/status`) | laptop → AWS API | public AWS endpoints |
| `logs:FilterLogEvents` (`jobs logs --follow`) | laptop → AWS API | public AWS endpoints |
| `s3:ListObjectsV2/GetObject` on the run-log prefix (older run logs) | laptop → AWS API | public AWS endpoints |
| SSM agent command channel | **box → ssm/ssmmessages/ec2messages** | box egress (NAT, or interface endpoints) |
| Command output upload (`OutputS3BucketName` → `<logPrefix>/<run_id>`) | **box (SSM agent) → S3** | box egress — S3 gateway endpoint or NAT |
| Command output streaming (`CloudWatchOutputConfig` → the job log group) | **box (SSM agent) → CloudWatch Logs** | box egress — NAT or `logs` endpoint |
| The job itself: AWS APIs + PyPI | **box → AWS APIs + internet** | box egress — NAT (+ S3 gateway endpoint) |
| The job itself: Gen3 commons REST API | **box → commons API** | NAT if the API is internet-facing; **VPC peering into the Gen3 VPC** if it is internal (section 3) |
| ArgoCD / Gen3 dictionary ops (`g3dt k8s`, `g3dt dict`) | laptop → Gen3 endpoints | public HTTPS, interactive SSO — VPC not involved |

Everything the CLI's status/log tooling needs is either a **laptop-side public AWS API
call** or **outbound traffic from the box** — the network in section 2 covers all of it
with a private subnet + NAT + S3 gateway endpoint, and needs **zero inbound rules**.

SSH-based dispatch (anything that needs port 22 inbound) is *intentionally* unsupported
by the zero-ingress design. SSM dispatch and the user-data bootstrap replace it; do not
open port 22 to accommodate an SSH workflow.

---

## 2. The pipeline VPC — built by the CDK (`lib/stacks/network-stack.ts`)

`NetworkStack` gives each environment one small, pipeline-owned VPC, deployed first, so
the pipeline is fully standalone from whatever else lives in the account. The only input
is the CIDR (`network.vpcCidr`, default `10.20.0.0/16`) — pick one that does not overlap
neighbouring VPCs (section 6 has the lookup command).

```
VPC <network.vpcCidr>  (2 AZs)
│
├── public subnets  (…/24 per AZ)  route: 0.0.0.0/0 → IGW    hosts: the NAT gateway only
├── private subnets (…/24 per AZ)  route: 0.0.0.0/0 → NAT    hosts: EC2 job box, CodeBuild
│
├── S3 gateway endpoint (free — attached to the private route tables)
└── (optional, add later) interface endpoints: ssm, ssmmessages, ec2messages, logs
```

Security groups (created by `NetworkStack`):

| SG | Ingress | Egress | Attached to |
|---|---|---|---|
| `<project>-<env>-job-runner-sg` | **none** | 443/tcp → 0.0.0.0/0 | EC2 box |
| `<project>-<env>-codebuild-sg` | **none** | 443/tcp → 0.0.0.0/0 | CodeBuild projects |

HTTPS-only egress is safe because DNS and time-sync use link-local AWS services that
security groups do not evaluate, and AL2023 package repos, pip, GitHub, AWS APIs and
Gen3 endpoints are all on 443. `test/ssm-publishing.test.ts` pins the zero-ingress +
443-only shape.

Glue jobs use no SG at all — they run connection-less on Glue-managed networking. If a
NETWORK connection is ever reintroduced, it needs its own SG with the Glue-required
self-referencing all-TCP ingress rule, in a private subnet with a NAT route.

Design decisions and why:

- **One NAT gateway, not two.** Roughly US$50/month each. The pipeline is batch tooling,
  not a serving path — an AZ outage pausing jobs is acceptable. Add a second NAT per AZ
  only if that changes.
- **Interface endpoints are optional.** With a NAT, everything works without them. Add
  `ssm`/`ssmmessages`/`ec2messages` if you want the job box to survive without any
  internet route, or `logs`/`athena`/`glue` to cut NAT data charges. The S3 *gateway*
  endpoint is free — always present (Athena results, dbt data, job logs are all S3).
- **Nothing is borrowed.** Earlier revisions imported VPC/subnet/SG ids from other stacks
  in the account. That made the pipeline depend on networks it did not own, with
  whatever routing and ingress rules those networks happened to have, and anyone
  cleaning up a neighbouring stack could silently break it. Creating a standalone VPC per
  environment removes that class of failure — which is why the config has no VPC ids.
- **The laptop/box split is unaffected**: the operator's laptop talks to public AWS
  APIs; only the two consumers in section 1 ride the VPC.

---

## 3. Reaching the Gen3 REST API — `network.gen3ApiAccess`

Whether the NAT path can reach the commons API depends entirely on how the Gen3
deployment exposes it. Some commons sit behind an **internet-facing** load balancer;
others are **internal** (VPN-secured) — the hostname still resolves publicly, but to
private IPs inside the Gen3 VPC, so a laptop needs the VPN and the job box needs a
private route. Check before writing the config:

```bash
dig +short <commons-api-hostname>   # private (10.x / 172.16.x / 192.168.x) answers => internal
curl -s -o /dev/null -w '%{http_code}\n' https://<commons-api-hostname>/_status   # off-VPN
```

`network.gen3ApiAccess` (see `lib/config.ts`) expresses the result:

| Mode | When | What the CDK does |
|---|---|---|
| `{ "mode": "public" }` (default) | The commons API is internet-facing | Nothing extra; the NAT path covers it |
| `{ "mode": "peered", "peerVpcId": "vpc-…", "peerVpcCidr": "<gen3-vpc-cidr>" }` | The commons API is internal / VPN-secured | Creates a same-account **VPC peering** into the Gen3 VPC (auto-accepted) and routes `peerVpcCidr → pcx` from every private subnet — the pipeline-side half of what the VPN does for a laptop |

DNS needs nothing (the hostname resolves publicly), and the 443-egress security group
already permits traffic to peered CIDRs. Only **routing** is missing, and peered mode
adds it.

**Peered mode needs two Gen3-side steps** (they live in Gen3-owned infrastructure —
coordinate with whoever operates the commons):

1. A **return route** `<pipeline-cidr> → pcx-…` in the Gen3 VPC's route tables.
2. The internal ALB's security group must **allow 443 from the pipeline CIDR**.

Constraints:

- Peering is same-account, same-region only (CloudFormation auto-accepts it). A Transit
  Gateway attachment is the scalable alternative if your organisation standardises on
  TGW; the CDK does not create one.
- The pipeline CIDR (`network.vpcCidr`) **must not overlap** the Gen3 VPC's CIDR — a hard
  prerequisite for peering. Confirm the Gen3 CIDR per environment when authoring its
  config.
- Gen3-facing work belongs on the EC2 box. Glue jobs run on Glue-managed networking with
  no route into any VPC, so they can never reach an internal commons.

---

## 4. What this networking enables, and what it blocks

| Path | Enables | Blocks / does not allow |
|---|---|---|
| Private subnet + NAT (EC2 box, CodeBuild) | All outbound: AWS APIs, PyPI, GitHub, internet-facing Gen3 APIs. Stable egress IP (the NAT EIP) usable for allowlisting | **All unsolicited inbound** — nothing on the internet can reach these ENIs at all |
| VPC peering into the Gen3 VPC (peered mode) | The EC2 box reaches an internal commons API over private routing | Nothing else: the route covers only `peerVpcCidr`, and Glue jobs are not on the VPC |
| Glue-managed networking (all Glue jobs — no connection) | Outbound internet (pip, public endpoints) + AWS APIs, zero setup | No access to private-IP resources in any VPC; egress IP is Glue's, not yours |
| S3 gateway endpoint | S3 traffic bypasses the NAT — free, faster, keeps data off the public path | — |
| Interface endpoints (optional: ssm/logs/athena/glue/…) | AWS API calls resolve to private IPs inside the VPC; work even with no NAT; reduce NAT data charges | Each endpoint costs roughly US$10/month plus data; only worth it for chatty services |
| Zero-ingress security groups | Everything the pipeline does (SSM dispatch included) | SSH — by design; use SSM Session Manager instead |

In plain terms:

- No component can be connected to from the internet — there is no inbound path.
- SSH to the job box is impossible (no key required either); shell access is via
  `aws ssm start-session`, which is IAM-authenticated and CloudTrail-audited.
- Data-plane traffic to S3 never leaves AWS's network (gateway endpoint).
- Compromise or cleanup of a neighbouring stack cannot remove the pipeline's network.

---

## 5. Security posture

What the design guarantees, and where each guarantee is enforced:

1. **Zero ingress, everywhere.** Neither pipeline SG has an inbound rule; nothing the
   pipeline does needs one (`NetworkStack`, pinned by `test/ssm-publishing.test.ts`).
2. **No public IPs on pipeline compute.** The EC2 box and CodeBuild live in private
   subnets; only the NAT gateway sits in a public subnet.
3. **HTTPS-only egress.** Every SG allows 443/tcp out and nothing else.
4. **No SSH.** Shell access is `aws ssm start-session` — IAM-authenticated,
   CloudTrail-audited, no key to leak.
5. **A network the pipeline owns.** One VPC per environment, created by the CDK; no
   borrowed subnets, routes, or security groups.
6. **Least-privilege secret access.** The job-runner role can read exactly the Secrets
   Manager secret named in `gen3.awsSecretName` (recommended name:
   `<project>_<env>_gen3_api_key.json`) and nothing else — the IAM grant is generated
   from the config.
7. **Glue stays off the VPC.** With no connection attached, Glue jobs have no route into
   any private network, including the Gen3 VPC.

---

## 6. Config inputs and deploy checks

`config/<project>.<env>.json` INPUTS (see `lib/config.ts`):

| Input | What to put there |
|---|---|
| `network.vpcCidr` (optional) | CIDR for the pipeline's own VPC (default `10.20.0.0/16`). Must not overlap other VPCs in the account (a hard requirement for peered mode). Everything else — subnets, routes, NAT, endpoints, SGs — is created by `NetworkStack`. |
| `network.gen3ApiAccess` (optional) | How this env reaches the Gen3 commons API: `{ "mode": "public" }` (default; internet-facing commons) or `{ "mode": "peered", "peerVpcId": …, "peerVpcCidr": … }` for VPN-secured commons — see section 3. |

Pre-deploy: check CIDR overlap (read-only):

```bash
aws ec2 describe-vpcs --profile <env-profile> --region <region> \
  --query 'Vpcs[].[VpcId,CidrBlock,Tags[?Key==`Name`]|[0].Value]' --output table
```

(To capture a fuller read-only inventory of an existing account — VPCs, routes,
endpoints, security groups and what is attached to them —
[`scripts/discover_infra.sh`](../scripts/discover_infra.sh) `--profile <p> --project <id>`
writes one to `docs/discovery/inventory/`.)

Post-deploy verification — `./scripts/integration_test.sh --profile <env-profile>
--env <env>` covers all of the below (plus bootstrap/Athena/alarm checks); manual
equivalents:

```bash
P="--profile <env-profile> --region <region>"
# 1. The pipeline VPC exists with its NAT available
aws ec2 describe-vpcs $P --filters Name=tag:Name,Values=<project>-<env>-vpc \
  --query 'Vpcs[].[VpcId,CidrBlock]'
aws ec2 describe-nat-gateways $P --filter Name=vpc-id,Values=<vpc> \
  --query 'NatGateways[].[NatGatewayId,State]'
# 2. Pipeline SGs have zero ingress
aws ec2 describe-security-groups $P \
  --filters Name=group-name,Values='<project>-<env>-*-sg' \
  --query 'SecurityGroups[].[GroupName,length(IpPermissions)]'
# 3. The job box registered with SSM (proves the whole egress path works)
aws ssm describe-instance-information $P \
  --query 'InstanceInformationList[?InstanceId==`<id>`].PingStatus'
# 4. The box can reach the Gen3 API (proves the section-3 NAT or peering route works) —
#    run on the box via SSM; expect an HTTP status, not a timeout
aws ssm send-command $P --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["curl -s -o /dev/null -w %{http_code} https://<gen3-domain>/_status"]'
```
