# Deployment Config Guide

How to write `config/<project>.<env>.json` — the single file that drives a whole
pipeline deployment. This is a reference manual: work through Section 2's checklist top to
bottom, look each field up in Section 3 when you don't know a value, and validate with Section 5
before deploying. A sanitised template to copy is at [`example-config.json`](example-config.json)
and a worked walkthrough for a staging environment is in Section 4. Real, filled-in configs
live in your private deployment wrapper — `config/*.json` is deliberately gitignored in
this repo (see [`WRAPPER_GUIDE.md`](WRAPPER_GUIDE.md)).

---

## 1. What this file is (read this first)

The config holds **INPUTS only** — values a human must choose because the CDK cannot
derive them. Everything the CDK *creates* (bucket names, Glue databases, the Athena
workgroup, job names, …) is an **OUTPUT**: computed by `deriveNames()` in
[`../lib/names.ts`](../lib/names.ts) from four identity fields and published to SSM
Parameter Store on deploy.

> **The one rule:** if you are about to type a *resource name* into this file, stop —
> it belongs in `deriveNames()`. The schema ([`../lib/config.ts`](../lib/config.ts))
> makes this hard to get wrong: there are no name fields.

```
config/<project>.<env>.json ──► cdk deploy --all -c env=<env> ──► SSM /{project}/{env}/…
        (INPUTS)                 (creates resources +               (runtime source of truth
                                  publishes OUTPUT names)            for CLI / CodeBuild / EC2)
```

**How the file gets loaded** ([`../lib/load-config.ts`](../lib/load-config.ts)), in
precedence order:

| How | Command | When to use |
|---|---|---|
| By env name | `cdk deploy --all -c env=test` → reads `config/<projectId>.test.json` | Normal operator workflow (one project in `config/`) |
| By env + project | `cdk deploy --all -c env=test -c project=project1` | When `config/` holds **multiple projects** and the env suffix alone is ambiguous |
| Inline context | `cdk synth -c pipelineConfig="$(cat my.json)"` | Ad-hoc/testing |
| Environment variable | `PIPELINE_CONFIG_JSON="$(cat …)" cdk deploy --all` | CI, or when the config file lives in another repo |

The context flags behave identically for **every** CDK command — `list`, `synth`,
`diff`, `deploy`, `destroy` — because each one starts by running the app, which loads
the config the same way. (`diff`/`deploy` additionally need `--profile <env-profile>`
to talk to CloudFormation; `list`/`synth` are fully offline.)

> **Recommended: fork this repo per project.** Keep one project's config files per
> checkout — then every command is just `cdk <cmd> -c env=<env>` with no project flag,
> and the fork's history tracks that project's infrastructure decisions. Generic
> improvements flow back via PRs to the template repo.

Files are named `config/<projectId>.<env>.json`. The loader finds them by the
`.<env>.json` suffix (the project id is **not** hard-coded); if you do keep several
projects in one checkout, add `-c project=<projectId>` whenever they share an
environment. Either way the filename is checked against the `projectId` and
`environment` fields inside the file — a mismatch fails loudly rather than deploying
under unexpected names. Example multi-project dir:

```
config/
├── project1.test.json    cdk deploy --all -c env=test -c project=project1
├── project1.prod.json    cdk deploy --all -c env=prod             (unambiguous — no project flag needed)
└── project2.test.json    cdk diff -c env=test -c project=project2
```

---

## 2. The skeleton and checklist

Copy this, then fill every `<-` using Section 3:

```jsonc
{
  "projectId": "myproject",           // <- Section 3.1 short lowercase project slug
  "environment": "staging",           // <- Section 3.1 test | staging | prod (keep short!)
  "accountId": "123456789012",        // <- Section 3.1 the target AWS account
  "region": "ap-southeast-2",         // <- Section 3.1

  "network": {                        //  Section 3.2 (whole block optional)
    "vpcCidr": "10.20.0.0/16",        // <- must not overlap other VPCs
    "gen3ApiAccess": {                // <- how this env reaches the Gen3 commons API
      "mode": "public"                //   "public" (test/prod) or "peered" (VPN-secured staging)
    }
  },

  "repo": {                           //  Section 3.3
    "fullName": "AustralianBioCommons/gen3-dbt-template",  // <- the project's DBT repo (from the template)
    "branch": "main",
    "codeStarConnectionArn": "arn:aws:codeconnections:..."     // <- must be AVAILABLE
  },

  "ec2": {                            //  Section 3.4 the job-runner box
    "instanceType": "t3.micro",       // <- size for your metadata jobs
    "ami": "ami-..."                  // <- current Amazon Linux 2023 id
    // "keyName": "..."               // <- OMIT unless you need break-glass SSH
  },

  "toolkitVersion": "2.1.2",          // <- Section 3.5 PyPI pin for the g3dt toolkit

  "gen3": {                           //  Section 3.6 facts about this env's Gen3 commons
    "dictionaryVersion": "v1.0.0",
    "awsSecretName": "myproject_staging_gen3_api_key.json",  // <- convention: <project>_<env>_gen3_api_key.json
    "schemaS3Uri": "my-schema-bucket/schema.json",
    "domain": "commons.example.org",
    "appName": "staginggen3",
    "namespace": "myproject",
    "clusterName": "Gen3-Eks-pipeline-staging",
    "schemaRepo": "my-org/my-schema-repo"
  }
}
```

Checklist (details for every row in Section 3):

| # | Field | Required | Type | One-line purpose |
|---|---|---|---|---|
| 1 | `projectId` | ✅ | string | First segment of every resource name |
| 2 | `environment` | ✅ | string | Second segment; isolates envs from each other |
| 3 | `accountId` | ✅ | string | AWS account the stacks deploy into |
| 4 | `region` | ✅ | string | AWS region (this pipeline: `ap-southeast-2`) |
| 5 | `network.vpcCidr` | optional | CIDR | Address space of the pipeline's own VPC (default `10.20.0.0/16`) |
| 6 | `network.gen3ApiAccess` | optional | object | `public` (default) or `peered` route to the Gen3 API |
| 7 | `repo.fullName` | ✅ | `org/repo` | GitHub repo CodePipeline/CodeBuild check out |
| 8 | `repo.branch` | ✅ | string | Branch that triggers the CI pipeline |
| 9 | `repo.codeStarConnectionArn` | ✅ | ARN | AWS↔GitHub OAuth link used by the Source stage |
| 10 | `ec2.instanceType` | ✅ | string | Job-runner box size |
| 11 | `ec2.ami` | ✅ | AMI id | Job-runner OS image (Amazon Linux 2023) |
| 12 | `ec2.keyName` | optional | string | Break-glass SSH key pair — omit by default |
| 13 | `ec2.alertEmail` | optional | email | Notify this address when the idle box auto-stops |
| 14 | `toolkitVersion` | ✅ | semver | Pinned toolkit version for EC2 + Glue jobs |
| 15–22 | `gen3.*` (8 fields) | ✅ | strings | Facts about this env's Gen3 commons (see Section 3.6) |
| 23 | `customJobs` | optional | array | Deployment-specific Glue jobs — see [Custom Glue jobs](#custom-glue-jobs) |

---

## 3. Field-by-field reference

All lookup commands are **read-only** and assume `--profile <your-profile>`
(one AWS CLI profile per environment/account) and `--region ap-southeast-2`.

### 3.1 Identity — `projectId`, `environment`, `accountId`, `region`

These four drive every derived name: buckets are
`<projectId>-<environment>-<suffix>-<accountId>-<region>`, Glue databases are
`<projectId>_<environment>_<suffix>_db`, everything else is
`<projectId>-<environment>-<suffix>` (pinned by `test/names.test.ts`).

| Field | What it does | How to find it | Gotchas |
|---|---|---|---|
| `projectId` | Names every resource and the SSM tree root `/{projectId}/{env}/…` | You choose it once per project (`myproject`) | Lowercase letters/digits/dashes only (it lands in bucket names). Changing it later = a brand-new pipeline |
| `environment` | Isolates envs — nothing collides across `test`/`staging`/`prod` | You choose it; stick to `test`, `staging`, `prod` | **Keep it short.** S3 caps bucket names at 63 chars; the names test enforces this for the three standard env names |
| `accountId` | Pins stacks to one account; part of bucket names | `aws sts get-caller-identity --profile <p> --query Account --output text` | Verify it matches the env you *think* the profile points at — profile↔account mapping has been wrong before |
| `region` | Region for every resource | Fixed for this project: `ap-southeast-2` | AMI ids and connection ARNs are region-scoped — they must match |

### 3.2 `network` — the pipeline's own VPC

The pipeline **creates its own VPC** (public+private subnets across 2 AZs, one NAT
gateway ≈ US$50/month, S3 gateway endpoint, two zero-ingress security groups). You
never supply VPC/subnet/SG ids. Full design: [VPC_NETWORKING.md Section 5](VPC_NETWORKING.md).

| Field | What it does | How to find it | Gotchas |
|---|---|---|---|
| `vpcCidr` | Address space of the created VPC | Pick any private range not used by other VPCs in the account: `aws ec2 describe-vpcs --profile <p> --query 'Vpcs[].[VpcId,CidrBlock,Tags[?Key==`Name`]\|[0].Value]' --output table` | Overlap only matters if you peer — but peered Gen3 access **requires** non-overlap, so avoid it always (the lookup command shows what is already taken in the account) |
| `gen3ApiAccess.mode` | How the EC2 job box reaches the Gen3 commons REST API | Decision table below | Defaults to `public`. Getting this wrong = `metadata upload` times out (box deploys fine, uploads fail) |
| `gen3ApiAccess.peerVpcId` | Gen3 VPC to peer with (peered mode only) | `aws ec2 describe-vpcs --profile <p> --filters Name=tag:Name,Values=<gen3-vpc-name> --query 'Vpcs[].[VpcId,CidrBlock]'` — ask the commons' devops engineer for the VPC name | Same account + region only (the CDK auto-accepts the peering) |
| `gen3ApiAccess.peerVpcCidr` | Destination for the peering route | Same command as above (second column) | — |

**Choosing the mode** — "is the Gen3 commons API public in this environment?"

| Signal | Conclusion |
|---|---|
| The devops engineer says you need the **VPN** to hit the API from a laptop | `peered` (typical for **staging**) |
| `dig +short <commons-api-hostname>` returns **private IPs (10.x)** | `peered` |
| The hostname resolves to public IPs and `curl https://<host>/_status` works without VPN | `public` (typical for **test** and **prod**) |

⚠ In **peered** mode, two steps live on the **Gen3 side** and belong to the devops
engineer who manages the VPN: a return route (`<vpcCidr> → pcx-…`) in the Gen3 VPC's
route tables, and a 443-allow from `<vpcCidr>` on the internal ALB's security group.
Details + post-deploy connectivity check: [VPC_NETWORKING.md Section 5a](VPC_NETWORKING.md).

### 3.3 `repo` — the dbt repository that drives CI/CD

**The source repo is always a dbt repo**, created from
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template).
Transformation commits trigger the `dbt-test-and-run` pipeline; tag pushes trigger the
`write-release-info` pipeline. CodeBuild reads its buildspecs
(`.codepipeline/dbt_test_and_run.yml`, `.codepipeline/write_release_info.yml`) from
that repo's checkout, so they must exist there (the template includes them).

| Field | What it does | How to find it | Gotchas |
|---|---|---|---|
| `fullName` | `org/repo` of the project's **dbt repo** — the pipelines check it out and build it | Create it from the template, then use its GitHub path | Must contain the dbt project at the repo root plus `.codepipeline/` buildspecs |
| `branch` | Branch whose pushes trigger the CI pipeline | Team convention (`main`) | — |
| `codeStarConnectionArn` | The AWS↔GitHub link the Source stage uses | `aws codeconnections list-connections --profile <p> --query 'Connections[].[ConnectionName,ConnectionStatus,ConnectionArn]' --output table` | Status must be **AVAILABLE**. If PENDING: AWS Console → Developer Tools → Settings → Connections → complete the GitHub handshake ([troubleshooting](DEVELOPER_GUIDE.md#7-troubleshooting)). Connections are per-account — don't copy an ARN across envs |

**How triggering works (there are no classic webhooks to set up):** the pipelines are
CodePipeline **V2**, connected to GitHub through the CodeConnections connection — a
GitHub App installed on the org. Push events flow through the connection:

1. Push to `repo.branch` → `<project>-<env>-dbt-test-and-run` runs (dbt build →
   validation Step Function).
2. Tag push → `<project>-<env>-dbt-write-release-info` runs (dbt build → release
   ledger → release Step Function). The trigger is scoped to `data-v*` tags —
   a plain branch push or a software tag never starts a release (pinned by
   `test/dbt-trigger.test.ts`).

**How the private repo is pulled — one mechanism, no PAT.** The connection covers the
whole path (this mirrors the proven manual staging pipeline exactly):

1. A push/tag event reaches the pipeline through the connection (GitHub App).
2. The Source stage checks the repo out via the connection and hands CodeBuild a
   **full-clone reference** (`OutputArtifactFormat: CODEBUILD_CLONE_REF`), not a zip.
3. CodeBuild git-clones the private repo **through the connection**, authorized by the
   `codestar-connections:UseConnection` grant the CDK puts on its role
   (`codebuild-stack.ts`). The projects themselves have a `CODEPIPELINE` source and
   never hold GitHub credentials — **no PAT / `import-source-credentials` is needed.**

#### Setting up the connection (one-time per AWS account)

A single connection serves every pipeline in the account. Connections are
account- and region-scoped — create one per account, in `ap-southeast-2`.

| Step | How |
|---|---|
| 1. Create the connection | `aws codeconnections create-connection --provider-type GitHub --connection-name <org>-github --profile <p>` (or Console → Developer Tools → Settings → Connections → *Create connection*). It starts in **PENDING** |
| 2. Complete the GitHub handshake | Console → Developer Tools → Settings → Connections → select it → **Update pending connection** → authorize → **Install a new app** → pick the GitHub org → this installs the **"AWS Connector for GitHub"** App |
| 3. Scope repository access | During install (or later: GitHub org → **Settings → GitHub Apps → AWS Connector for GitHub → Repository access**) grant either *All repositories* or *Only select repositories* **including the dbt repo**. A repo the App can't see fails the Source stage even with an AVAILABLE connection |
| 4. Verify | `aws codeconnections list-connections --profile <p> --query 'Connections[].[ConnectionName,ConnectionStatus,ConnectionArn]'` → status **AVAILABLE** |
| 5. Configure | Paste the ARN into `repo.codeStarConnectionArn` |

The handshake (step 2) is the only part that cannot be done from the CLI — it requires
a browser session with rights on both the AWS account and the GitHub org.

### 3.4 `ec2` — the job-runner box

One SSM-managed instance per env; the `g3dt` CLI dispatches long metadata jobs
to it. No SSH, no git credentials — bootstrap is pip via user-data.

**The box auto-stops when idle**: a CloudWatch alarm (`<project>-<env>-ec2-auto-stop`)
stops it after **24 consecutive hours averaging under 1% CPU** — fixed constants
mirroring the proven manually-built pipeline's alarm. A stopped box
holds no alarm state (missing data is ignored) and restarts with
`aws ec2 start-instances` or the CLI's `ec2 up`.

| Field | What it does | How to find it | Gotchas |
|---|---|---|---|
| `instanceType` | Box size | `t3.micro` matches the old manual box and is fine for metadata/indexd jobs; bump to `t3.medium`+ if jobs need more memory | Billed while running (~US$10/mo for t3.micro). Stop when idle: `aws ec2 stop-instances --instance-ids "$(aws ssm get-parameter --name /<project>/<env>/ec2/instanceId --query Parameter.Value --output text)"` |
| `ami` | OS image — Amazon Linux 2023 | `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 --profile <p> --query Parameter.Value --output text` | Public AMI ids are region-scoped (same id for every account in ap-southeast-2). Pinned deliberately — re-run the command and update when you *choose* to take a new image |
| `keyName` | Optional break-glass SSH key pair | `aws ec2 describe-key-pairs --profile <p> --query 'KeyPairs[].KeyName'` — the pair must already exist | **Omit it.** Shell access is `aws ssm start-session` (IAM-authenticated, audited). The zero-ingress SG blocks port 22 anyway, so a key only matters if you also change the SG |
| `alertEmail` | Optional: notify this address when the auto-stop alarm fires (creates an SNS topic `<project>-<env>-ec2-alerts` + email subscription) | Team distribution list or operator email | The address receives a one-time SNS confirmation email that must be clicked. Omit for stop-only behaviour with no SNS resources |

### 3.5 `toolkitVersion`

Pins the `gen3-dataops-toolkit` PyPI package (the `g3dt` CLI) in **three** places:
the EC2 box's user-data (`pip install gen3-dataops-toolkit==<version>`), every Glue job's
`--additional-python-modules`.

| How to find it | Gotchas |
|---|---|
| **The latest version actually published on PyPI**: `curl -s https://pypi.org/pypi/gen3-dataops-toolkit/json \| jq -r .info.version` | ⚠ **Pin only published versions** — an unpublished pin makes the EC2 user-data `pip install` fail silently (green deploy, unbootstrapped box — the integration tests catch it). **Bumping the pin replaces the EC2 job box** (by design — user-data only runs on first boot), so don't bump mid-job. The CodeBuild buildspecs read the pin from SSM `meta/toolkitVersion` at build time, so this one field keeps the whole env on one toolkit version |

### 3.6 `gen3` — facts about this environment's Gen3 commons

These describe the Gen3 deployment the pipeline serves. They are mirrored to SSM as
`/{project}/{env}/app/*` (snake_case) so the CLI can resolve them from anywhere. The
values are owned by the Gen3/devops side — when in doubt, ask the devops engineer who
runs the commons. Today's authoritative source per env:
a live sibling environment: run `g3dt config show --env <env>` (the values are mirrored to SSM `app/*`), or ask the commons' devops engineer for a new deployment.

| Field | Consumed by | How to find it | Gotchas |
|---|---|---|---|
| `dictionaryVersion` | `g3dt dict` ops — version of the data dictionary | `g3dt config show --env <env>` on a sibling env | — |
| `awsSecretName` | `metadata upload` / `indexd register` auth — the Secrets Manager secret holding the Gen3 API key. **This value also generates IAM**: the job box's role is granted `GetSecretValue` on exactly this secret and nothing else | Recommended name: `<project>_<env>_gen3_api_key.json` (e.g. `myproject_test_gen3_api_key.json`). Check what exists: `aws secretsmanager list-secrets --profile <p> --query 'SecretList[].Name'` | This is the secret **name**, never its value. The secret must exist in the same account with the value entered manually. Renaming the secret means updating this field **and redeploying** (the IAM grant follows the config) |
| `schemaS3Uri` | `g3dt dict upload` — where the schema JSON lands | sibling env / devops (e.g. `my-schema-bucket/schema.json`) | `bucket/key` form, no `s3://` prefix. The bucket belongs to the Gen3 deployment, not this pipeline |
| `domain` | `g3dt k8s` / `dict deploy` — the **ArgoCD/CD endpoint** for the commons | sibling env / devops | ⚠ Despite the name, this is *not* the commons REST API — the API URL comes from the API-key JWT. `cd.*` hostnames are typically internal (VPN) |
| `appName` | k8s restart ops — the Gen3 app/helm identifier | sibling env / devops (e.g. `staginggen3`) | — |
| `namespace` | k8s restart ops — the commons' k8s namespace | sibling env / devops (e.g. `myproject`) | — |
| `clusterName` | k8s ops — the EKS cluster running the commons | `aws eks list-clusters --profile <p>` | The cluster is Gen3 infrastructure — the pipeline never manages it |
| `schemaRepo` | `g3dt dict pull` — GitHub repo of the schema JSON | team convention (e.g. `my-org/my-schema-repo`) | — |

---

## 4. Worked example — writing `config/myproject.staging.json`

Every value below is found with the Section 3 commands against the target account
(placeholder `123456789012`, profile `<your-profile>`). The **commands are real** —
run them against your own account; the **outputs shown are placeholders** standing in
for whatever your account returns.

| Step | Command / source | Result (placeholder) |
|---|---|---|
| Account | `aws sts get-caller-identity --profile <your-profile> --query Account --output text` | `123456789012` |
| CIDR check | `aws ec2 describe-vpcs …` → list the CIDRs already in use | `10.20.0.0/16` is free ✓ |
| Gen3 API mode | Laptop needs the VPN in staging; `dig` on the commons host returns private 10.x IPs | `peered` |
| Peer VPC | `aws ec2 describe-vpcs --filters Name=tag:Name,Values=<gen3-vpc-name> …` | `vpc-0123456789abcdef0`, `10.17.0.0/16` |
| Connection | `aws codeconnections list-connections …` | `<org>-github`, AVAILABLE, `…connection/00000000-0000-0000-0000-000000000000` |
| AMI | `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 …` | `ami-00000000000000000` (yours is the real current id) |
| Key pair | skip — SSM-only access | (omitted) |
| Toolkit | latest **published** toolkit release on PyPI (Section 3.5) | `1.3.0` |
| Gen3 facts | `g3dt config show --env <env>` on a sibling env, or the commons' devops engineer | see below |

```json
{
  "projectId": "myproject",
  "environment": "staging",
  "accountId": "123456789012",
  "region": "ap-southeast-2",

  "network": {
    "vpcCidr": "10.20.0.0/16",
    "gen3ApiAccess": {
      "mode": "peered",
      "peerVpcId": "vpc-0123456789abcdef0",
      "peerVpcCidr": "10.17.0.0/16"
    }
  },

  "repo": {
    "fullName": "my-org/my-dbt-repo",
    "branch": "main",
    "codeStarConnectionArn": "arn:aws:codeconnections:ap-southeast-2:123456789012:connection/00000000-0000-0000-0000-000000000000"
  },

  "ec2": {
    "instanceType": "t3.micro",
    "ami": "ami-00000000000000000"
  },

  "toolkitVersion": "1.3.0",

  "gen3": {
    "dictionaryVersion": "v1.0.0",
    "awsSecretName": "myproject_staging_gen3_api_key.json",
    "schemaS3Uri": "my-schema-bucket/schema.json",
    "domain": "commons.example.org",
    "appName": "staginggen3",
    "namespace": "myproject",
    "clusterName": "Gen3-Eks-pipeline-staging",
    "schemaRepo": "my-org/my-schema-repo"
  }
}
```

Then hand the devops engineer the two Gen3-side peering steps from
[VPC_NETWORKING.md Section 5a](VPC_NETWORKING.md) (return route + ALB SG allow for
`10.20.0.0/16`).

---

## Custom Glue jobs

The optional `customJobs` array declares deployment-specific Glue **python-shell**
jobs alongside the four built-in ones — no stack code edits. It is the one config
block normally authored by a **private deployment wrapper** rather than this repo:
the wrapper keeps the script and the config entry together, overlays its scripts
into `glue-scripts/` before synthesizing, and deploys. Full workflow:
[`WRAPPER_GUIDE.md`](WRAPPER_GUIDE.md).

```json
{
  "customJobs": [
    { "key": "myIngestJob", "scriptFile": "my_ingest.py", "timeoutMinutes": 60 }
  ]
}
```

### Fields (schema: `CustomGlueJobConfig` in [`../lib/config.ts`](../lib/config.ts))

| Field | Required | What it is | Default |
|---|---|---|---|
| `key` | ✅ | Stable **camelCase** slug, unique across built-in *and* custom jobs. It is the CloudFormation logical id and the lookup key other stacks use — renaming it replaces the deployed job | — |
| `scriptFile` | ✅ | **Bare** `.py` filename in `glue-scripts/` (no path separators) | — |
| `nameSuffix` | optional | Kebab-case job-name suffix | kebab-cased `key` |
| `extraPythonModules` | optional | Extra pip pins, appended **after** the shared toolkit pin | — |
| `extraArgs` | optional | Extra `--KEY` default arguments, merged **over** the standard `--PROJECT_ID`/`--ENV`/`--REGION` set (last-wins, so a wrapper can deliberately override the standard args too) | — |
| `maxCapacity` | optional | DPU capacity | `1` |
| `timeoutMinutes` | optional | Job timeout | `2880` (48 h) |

### Derived OUTPUTs

As with everything else, the deployed names are computed by `deriveNames()` — never
authored in config. For the example above (project `myproject`, env `test`):

| OUTPUT | Value |
|---|---|
| Glue job name | `myproject-test-my-ingest-job` (`<project>-<env>-` + kebab-cased `key`, unless `nameSuffix` overrides) |
| Script location | `s3://<metadata-bucket>/scripts/my_ingest.py` (synced from `glue-scripts/` on every deploy) |

### Validation — fail early, twice

- **Load-time** ([`../lib/load-config.ts`](../lib/load-config.ts)): rejects a `key`
  that is not a camelCase slug, a `scriptFile` that is not a bare `.py` filename
  (path separators would escape the `scripts/` S3 prefix), duplicate keys, and keys
  that collide with built-in jobs — each with the offending entry named.
- **Synth-time** (`glue-jobs-stack.ts`): if `glue-scripts/<scriptFile>` does not
  exist on disk, `cdk synth` throws. This matters because the `scripts/` S3 prefix
  is synced with `prune: true` — a job configured without its script would otherwise
  deploy green while pointing at an S3 key the sync just deleted. Wrappers must
  overlay their scripts into `glue-scripts/` **before** synthesizing.

### What custom jobs get automatically

- **IAM**: the Step Functions execution role gains `glue:StartJobRun` (and
  `GetJobRun`/`GetJobRuns`/`BatchStopJobRun`) on every custom job, exactly like the
  built-ins. This is by design: the wrapper author owns both the config and the
  scripts, so declaring a job in `customJobs` is the trust boundary.
- **Runtime environment**: Glue python-shell with the `analytics` library set
  (pandas, awswrangler) preinstalled, plus the pinned `g3dt` toolkit
  (`toolkitVersion`) and any `extraPythonModules` pip-installed at job start.
- **Arguments**: scripts receive **only** `--PROJECT_ID`, `--ENV`, `--REGION`
  (plus your `extraArgs`). That is the whole config contract — resolve every other
  name (buckets, Glue databases, workgroup, secrets…) from SSM
  `/<project>/<env>/…` via the `g3dt` toolkit. Never hard-code resource names in a
  script.

---

## 5. Validate before you deploy

```bash
npm run build && npm test          # naming pins + SSM drift guard (uses test/fixtures/pipeline-config.json)
npx cdk list  -c env=staging       # expect 12 myproject-staging-* stacks
npx cdk synth -c env=staging > /dev/null
npx cdk diff -c env=staging --profile <your-profile>   # read-only preview
```

Common errors:

| Symptom | Cause | Fix |
|---|---|---|
| `No config file for env "x" — expected config/<projectId>.x.json` | No file ends in `.x.json` | Name the file `<projectId>.<env>.json`, or fix the `-c env=` value |
| `Multiple config files for env "x" (…) — disambiguate with -c project=<projectId>` | Several projects share that env | Add `-c project=<projectId>` to the command |
| `No config file for project "p" env "x" — expected config/p.x.json` | `-c project=` names a project with no file for that env | Fix the project id or create the file |
| `Config file … does not match its contents … rename it to <projectId>.<env>.json` | Filename disagrees with the `projectId`/`environment` fields inside the file | Rename the file or fix the fields — they must agree |
| `Config is missing required INPUT field(s): …` | A required top-level block is absent | Add it (Section 2 checklist) |
| `network.gen3ApiAccess.mode "peered" requires peerVpcId and peerVpcCidr.` | Peered mode without peer details | Add both (Section 3.2) |
| `Invalid S3 bucket name … no more than 63 characters` at synth | `environment` (or `projectId`) too long | Shorten it — the convention is length-budgeted for `test`/`staging`/`prod` |
| Pipeline Source stage fails after deploy | Connection is PENDING, or ARN from another account | Section 3.3 — complete the console handshake |
| EC2 instance fails to launch | AMI id stale/deregistered or wrong region | Re-run the AMI lookup (Section 3.4) |
| Box deploys but `metadata upload` times out | Wrong `gen3ApiAccess` mode, or Gen3-side peering steps not done | Section 3.2 decision table; [VPC_NETWORKING.md Section 5a](VPC_NETWORKING.md) check #4 |
| Box never shows `Online` in `aws ssm describe-instance-information` | Egress broken (NAT missing/misconfigured — shouldn't happen with the created VPC) | [VPC_NETWORKING.md Section 6](VPC_NETWORKING.md) post-deploy checks |

---

## 6. Related docs

| Doc | What's in it |
|---|---|
| [`FIRST_TIME_SETUP.md`](FIRST_TIME_SETUP.md) | End-to-end first-time on-ramp: tools, SSO, deploy, post-deploy steps, `g3dt`, first release |
| [`../README.md`](../README.md) | What the pipeline is and the INPUT/OUTPUT model |
| [`QUICKSTART.md`](QUICKSTART.md) | Deploy workflow, naming conventions, SSM tree |
| [`VPC_NETWORKING.md`](VPC_NETWORKING.md) | The created network's full design, Gen3 API access modes, security posture, deploy checks |
| [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) | Stack-by-stack architecture, common tasks, troubleshooting |
| [`example-config.json`](example-config.json) | Sanitised template for a brand-new project |
| [`../lib/config.ts`](../lib/config.ts) | The schema itself (`InputConfig`) — authoritative |
| [`../lib/names.ts`](../lib/names.ts) | `deriveNames()` — every OUTPUT name, and the conventions |
| [`WRAPPER_GUIDE.md`](WRAPPER_GUIDE.md) | The private deployment-wrapper workflow — where real configs and custom scripts live |
