# VPC & Networking for the Gen3 Data Pipeline

How the pipeline uses networks: what each component needs, what the manually-built
staging environment actually does today (observed from the live AWS APIs, not docs),
what to build for a greenfield environment, and the security posture that falls out.

> Evidence: every "observed" claim below is backed by raw discovery captures taken from
> a live deployment (`vpc_*.json`, `codebuild_detail.json`, `ec2_instance_*.json`,
> `glue_connections.json`) — [`scripts/discover_infra.sh`](../scripts/discover_infra.sh)
> regenerates such an inventory against any account. Resource ids in the worked examples
> below are placeholders; the topology, routes and rules are as observed.

---

## 1. The pipeline's networking consumers

Only **two** components of this pipeline attach to a VPC. Everything else is
serverless and uses AWS-managed networking.

| # | Consumer | Why it needs a network | Direction |
|---|----------|------------------------|-----------|
| 1 | **EC2 job-runner box** | Long data-plane jobs (metadata upload, indexd register): AWS APIs (SSM, S3, Athena, Glue, Secrets Manager, CloudWatch Logs, STS), HTTPS to the Gen3 commons API (**internal ALB — needs private routing, see section 5a**), PyPI during bootstrap | **Outbound only** — SSM Run Command/Session Manager works by the agent polling out; nothing needs to connect in |
| 2 | **CodeBuild projects** (`dbt-test-and-run`, `dbt-release-builder`) | dbt against Athena/Glue/S3, pip + dbt package downloads, GitHub checkout | Outbound only |

**Glue jobs deliberately use no VPC.** A python-shell job **without** a connection runs
in Glue's own service network **with internet access** — `--additional-python-modules`
(pip) and calls to public Gen3 endpoints work fine. Staging proves it: 8 of 9 live jobs
run connection-less (the 9th references a connection that was deleted). The CDK
therefore attaches no connection to any job. A NETWORK connection would only be
reintroduced if a job someday must reach **private-IP resources inside a VPC** or must
egress from a **stable, allowlistable IP**; note that attaching one *removes*
Glue-managed internet and makes the job depend on a private subnet + NAT route.

Explicitly **not** VPC-attached (verified in staging):

- **`add_studyID_tags` Lambda** — no VPC config; it only handles S3 events and S3 API calls.
- **Athena, Glue Data Catalog, Glue jobs, Step Functions, CodePipeline, Secrets Manager, SSM** — serverless/managed.
- **The `g3dt` CLI / dbt on a laptop** — operator's machine, public AWS APIs via SSO.
- (The Gen3/EKS staging VPC and its Lambdas belong to the Gen3 platform, not this pipeline.)

### 1a. The CLI dispatch path, end to end (from the g3dt CLI source)

`g3dt … --on ec2` and `g3dt jobs` create these network flows
(`cli/_internal/dispatch.py`, `cli/ec2_cmds.py`):

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
| The job itself: Gen3 commons REST API (`Gen3Submission`) | **box → internal Gen3 ALB (private IPs)** | **VPC peering/TGW route into the Gen3 VPC — NOT the NAT** (section 5a) |
| ArgoCD / Gen3 dictionary ops (`g3dt k8s`, `g3dt dict`) | laptop → Gen3 endpoints | public HTTPS, interactive SSO — VPC not involved |

Everything the CLI's status/log tooling needs is either a **laptop-side public AWS API
call** or **outbound traffic from the box** — the greenfield design in section 5 covers all of
it with a private subnet + NAT + S3 gateway endpoint, and needs **zero inbound rules**.

Two legacy CLI paths are *intentionally* broken by the zero-ingress design:
`--dispatch ssh` (port 22 inbound) and the old `spin_up_ec2.sh` SSH/SCP bootstrap.
Both are superseded by SSM dispatch and user-data bootstrap; do not open port 22 to
accommodate them.

---

## 2. What staging actually does today (observed 2026-07-06)

Staging owns **no network**. It borrows three VPCs from neighbouring projects:

### 2a. EC2 job box — `studiovpc-vpc` (`vpc-0123456789abcdef0`, 10.33.0.0/16)

| Item | Observed value |
|---|---|
| Instance | `i-0123456789abcdef0` (`myproject-upload-ec2`, t3.micro) |
| Subnet | `subnet-0123456789abcdef0` (10.33.5.0/24, ap-southeast-2a) — **PUBLIC**: default route → IGW `igw-0123456789abcdef0`, `MapPublicIpOnLaunch: true` |
| SG | `SG-Worker-SSH` (`sg-0123456789abcdef0`): ingress **TCP 22 from 203.0.113.10/32** (a single operator IP); egress all |
| Extras in this VPC | Private subnet `subnet-0123456789abcdef1` (routes via NAT `nat-0123456789abcdef0`), S3 gateway endpoint, interface endpoints for ssm/sts/logs/monitoring/ecr/sagemaker |

So the box sits on the public internet with a public IP, protected only by the SG.
It works, but nothing about the pipeline requires it: SSM dispatch is outbound-only.

### 2b. Glue connection — deleted in staging; not recreated in the greenfield

The `glue-internet-access` NETWORK connection **no longer exists**
(`glue_connections.json` is empty) even though the `upload_ausdiab_metadata` job still
references it — a dangling reference that will fail that job at start. The other 8 jobs
run connection-less on Glue-managed networking, which is the pattern the greenfield CDK
standardises on (no connection at all — see section 1).

For the record, the deleted connection's documented config decodes as: subnet
`subnet-0123456789abcdef1` = the studiovpc **private** subnet with a NAT route (the
correct shape — Glue ENIs never get public IPs), with SG `sg-0123456789abcdef1`
(self-referencing all-traffic ingress, the classic Glue-connection SG) — plus,
incorrectly, `sg-0123456789abcdef2` from a *different VPC*, which could never have been
valid. If a connection is ever reintroduced, copy that private-subnet + self-referencing-SG
shape inside the pipeline's own VPC.

### 2c. CodeBuild — SageMaker VPC (`vpc-0123456789abcdef1`, 10.11.15.0/24)

| Item | Observed value |
|---|---|
| Subnets | `subnet-0123456789abcdef2` (2a), `subnet-0123456789abcdef3` (2b) — **private**, default route → NAT `nat-0123456789abcdef1` (NAT lives in the VPC's public subnets) |
| SG | `sg-0123456789abcdef2` — the **SageMaker stack's VPC-endpoint SG** (ingress 443 from 10.11.15.0/24; egress all), borrowed |
| Endpoints in this VPC | S3 gateway + interface endpoints for **athena, glue, logs, s3, ecr** (and SageMaker) — so dbt's AWS API calls stay on private AWS networking; only PyPI/GitHub traffic uses the NAT |

This is actually a sound private-egress pattern — it just lives in, and depends on,
another project's stack.

---

## 3. What this networking enables, and what it blocks

| Path | Enables | Blocks / does not allow |
|---|---|---|
| Private subnet + NAT (CodeBuild, greenfield EC2) | All outbound: AWS APIs, PyPI, GitHub, Gen3 HTTPS. Stable egress IP (the NAT EIP) usable for allowlisting | **All unsolicited inbound** — nothing on the internet can reach these ENIs at all |
| Glue-managed networking (all Glue jobs — no connection) | Outbound internet (pip, public Gen3 endpoints) + AWS APIs, zero setup | No access to private-IP resources in any VPC; egress IP is Glue's, not yours |
| Public subnet + IGW (staging EC2 box today) | Same outbound, plus direct inbound to any port the SG opens | Inbound limited only by the SG (today: SSH from one IP) — this is the weakest link |
| S3 gateway endpoint (all three VPCs) | S3 traffic bypasses the NAT — free, faster, keeps data off the public path | — |
| Interface endpoints (athena/glue/logs/ssm/…) | AWS API calls resolve to private IPs inside the VPC; work even with no NAT; reduce NAT data charges | Each endpoint costs ~US$0.013/hr (~$10/mo) + data; only worth it for chatty services |
| Zero-ingress security groups | Everything the pipeline does (SSM dispatch included) | SSH — by design; use SSM Session Manager instead |

---

## 4. Security concerns (current state → what to change)

1. **EC2 box is on the public internet.** Public subnet, public IP, SSH open to one
   home/office IP. If that IP changes hands or the key leaks, the box (which holds
   Gen3 API-key access via its instance profile) is reachable. → **Resolved in the
   greenfield**: `NetworkStack` puts the box in a private subnet, no public IP,
   **zero ingress**; access via SSM Session Manager.
2. **Borrowed networks and SGs.** CodeBuild depends on the SageMaker stack's VPC and
   endpoint SG; the old Glue connection mixed SGs across VPCs; the test account's
   candidate subnets route through a Gen3 Squid proxy (section 6 history note). Anyone
   cleaning up those stacks silently breaks the pipeline. → **Resolved in the
   greenfield**: the pipeline creates its own VPC per environment.
3. **Egress-all everywhere.** Every SG allows all outbound. Adequate, but the pipeline
   only ever needs 443 (HTTPS) out — tightening egress to `443/tcp` is a cheap win
   (note: Glue's self-referencing rule and pip over 443 still work).
4. **Dangling reference:** `upload_ausdiab_metadata` still points at the deleted Glue
   connection — it will fail to start until the connection is recreated or removed
   from the job.
5. **Instance-profile blast radius** is a networking-adjacent concern: the old box's
   role could read all secrets in the account (`secretsmanager:GetSecretValue` on
   `secret:*`). → **Resolved in the greenfield**: the IAM grant is generated from the
   config — the job-runner role can read exactly the secret named in
   `gen3.awsSecretName` (recommended name: `<project>_<env>_gen3_api_key.json`) and
   nothing else.
6. **No inbound = smallest attack surface.** Nothing in this pipeline requires a
   single inbound rule. The greenfield target is: every SG has **zero ingress**
   (except the Glue connection SG's required self-reference).

---

## 5. The greenfield network — built by the CDK (`lib/stacks/network-stack.ts`)

**This is no longer just a reference design: `NetworkStack` creates it.** Each
environment gets one small, pipeline-owned VPC, deployed first, so the pipeline is
fully standalone from whatever else lives in the account. The only input is the CIDR
(`network.vpcCidr`, default `10.20.0.0/16` — pick one that doesn't overlap
neighbouring VPCs; in these accounts Gen3/SageMaker use 10.11.x, 10.13.x, 10.17.x,
10.33.x, 10.73.x).

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

(HTTPS-only egress is safe because DNS and time-sync use link-local AWS services that
security groups don't evaluate, and AL2023 package repos, pip, GitHub, AWS APIs and
Gen3 endpoints are all on 443. `test/ssm-publishing.test.ts` pins the zero-ingress +
443-only shape.)

(Glue jobs use no SG at all — they run connection-less on Glue-managed networking. If a
NETWORK connection is ever reintroduced, it needs its own SG with the Glue-required
self-referencing all-TCP ingress rule.)

Design decisions and why:

- **One NAT gateway, not two.** ~US$50/mo each in ap-southeast-2. The pipeline is
  batch tooling, not a serving path — an AZ outage pausing jobs is acceptable. Add a
  second NAT per AZ only if that changes.
- **Interface endpoints are optional.** With a NAT, everything works without them.
  Add `ssm`/`ssmmessages`/`ec2messages` if you want the job box to survive without any
  internet route, or `logs`/`athena`/`glue` to cut NAT data charges. The S3 *gateway*
  endpoint is free — always add it (Athena results, dbt data, job logs are all S3).
- **Gen3 endpoints are NOT public** — they are internal ALBs; the NAT path cannot
  reach them. Private connectivity into the Gen3 VPC is required — see section 5a.
- **The `_ec2`/laptop split is unaffected**: the operator's laptop talks to public AWS
  APIs; only the two consumers above ride the VPC.

### 5a. Reaching the Gen3 REST API — private connectivity is REQUIRED

**Finding (verified 2026-07-07):** the Gen3 commons endpoints are **internal ALBs**,
not public services:

- `staging.commons.example.org` → `internal-k8s-…elb.amazonaws.com` →
  **10.17.5.160 / 10.17.4.200 / 10.17.3.61** (private IPs in the Gen3 staging VPC).
- `test.commons.example.org` → **10.13.x** (private IPs in the Gen3 test VPC).
- `aws elbv2 describe-load-balancers` in staging: every Gen3 ALB has `Scheme: internal`.

This is why a laptop needs the **VPN** to reach the API. The staging EC2 box has its
own equivalent: its subnet carries a route **`10.17.0.0/16 → pcx-0123456789abcdef0`**
(VPC peering `studiovpc` ↔ the Gen3 staging VPC). `g3dt metadata upload --on ec2` works
*because of that peering*, not because the endpoint is public. (Notably, the old
Glue-connection subnet had **no** peering route — Glue jobs could never reach Gen3
from any of their networking modes, which confirms Gen3-facing work belongs on the
EC2 box.)

DNS is not a problem (the hostnames resolve publicly, just to private IPs), and the
443-egress SG already permits traffic to peered CIDRs. Only **routing** is missing.

**Gen3 API exposure varies per environment** — and the config expresses it via
`network.gen3ApiAccess` (see `lib/config.ts`):

| Mode | When | What the CDK does |
|---|---|---|
| `{ "mode": "public" }` (default) | The commons API is internet-facing — typical for **test** and **prod** environments | Nothing extra; the NAT path covers it |
| `{ "mode": "peered", "peerVpcId": "vpc-…", "peerVpcCidr": "10.17.0.0/16" }` | The commons API is VPN-secured / internal — typical for **staging**, where a devops engineer normally sets up the VPN | Creates a same-account **VPC peering** into the Gen3 VPC (auto-accepted) and routes `peerVpcCidr → pcx` from every private subnet — the pipeline-side half of what the VPN does for a laptop |

**Peered mode needs two Gen3-side steps** (they live in Gen3-owned infrastructure —
coordinate with the devops engineer who manages the VPN/commons):

1. A **return route** `<pipeline-cidr> → pcx-…` in the Gen3 VPC's route tables.
2. The internal ALB's security group must **allow 443 from the pipeline CIDR**.

(A Transit Gateway attachment — e.g. `tgw-0123456789abcdef0` observed in test — is the
scalable alternative if the org standardises on TGW; same coordination class.)

The pipeline CIDR (`network.vpcCidr`, default 10.20.0.0/16) was chosen not to overlap
any Gen3 VPC — a hard prerequisite for peering, so no re-addressing is needed.
Observed Gen3 VPC CIDRs: staging `10.17.0.0/16`, test `10.13.0.0/16`; confirm per
environment when authoring its config.

### What this design blocks, in plain terms

- No component can be connected to from the internet — there is no inbound path.
- SSH to the job box is impossible (no key required either); shell access is via
  `aws ssm start-session`, which is IAM-authenticated and CloudTrail-audited.
- Data-plane traffic to S3 never leaves AWS's network (gateway endpoint).
- Compromise of a neighbouring project's stack can't remove the pipeline's network.

---

## 6. Mapping to the CDK and deploy checks

`config/<project>.<env>.json` INPUTS (see `lib/config.ts`):

| Input | What to put there |
|---|---|
| `network.vpcCidr` (optional) | CIDR for the pipeline's own VPC (default `10.20.0.0/16`). Must not overlap other VPCs in the account (a hard requirement for peered mode). Everything else — subnets, routes, NAT, endpoints, SGs — is created by `NetworkStack`. |
| `network.gen3ApiAccess` (optional) | How this env reaches the Gen3 commons API: `{ "mode": "public" }` (default; internet-facing commons) or `{ "mode": "peered", "peerVpcId": …, "peerVpcCidr": … }` for VPN-secured environments — see section 5a. |

Pre-deploy: check CIDR overlap (read-only):

```bash
aws ec2 describe-vpcs --profile <env-profile> --region ap-southeast-2 \
  --query 'Vpcs[].[VpcId,CidrBlock,Tags[?Key==`Name`]|[0].Value]' --output table
```

Post-deploy verification — `./scripts/integration_test.sh --profile <env-profile>
--env <env>` covers all of the below (plus bootstrap/Athena/alarm checks); manual
equivalents:

```bash
P="--profile <env-profile> --region ap-southeast-2"
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
# 4. The box can reach the Gen3 API (proves the section-5a peering/TGW route works) —
#    run on the box via SSM; expect an HTTP status, not a timeout
aws ssm send-command $P --instance-ids <id> --document-name AWS-RunShellScript \
  --parameters 'commands=["curl -s -o /dev/null -w %{http_code} https://<gen3-domain>/_status"]'
```

> **History note (why the config has no VPC IDs):** earlier revisions imported
> VPC/subnet/SG IDs as inputs. Live verification showed every candidate network was
> borrowed and irregular — staging's box sat in a *public* `studiovpc` subnet, its
> CodeBuild ran in a SageMaker stack's VPC, and the test account's Gen3-owned private
> subnets default-route through a Gen3 **Squid filtering proxy instance**
> (subject to a domain allowlist and owned by an
> ASG the pipeline doesn't control). Rather than inherit those dependencies,
> `NetworkStack` now creates a standalone VPC per environment.

---

## 7. Where each fact came from

Each inventory file below is part of the discovery capture that
[`scripts/discover_infra.sh`](../scripts/discover_infra.sh) regenerates against a live
account.

| Claim | Inventory file |
|---|---|
| EC2 box subnet/SG/public IP | `ec2_instance_<instance-id>.json` |
| Subnet routes (IGW vs NAT) | `vpc_route_tables.json`, `vpc_nat_gateways.json`, `vpc_internet_gateways.json` |
| VPC endpoints per VPC | `vpc_endpoints.json` |
| SG rules | `vpc_security_groups.json` (+ live query for the two detached Glue SGs, 2026-07-07) |
| CodeBuild VPC config | `codebuild_detail.json` |
| Glue connection deleted | `glue_connections.json` (empty `ConnectionList`) vs `glue_jobs.json` (job still references it) |
