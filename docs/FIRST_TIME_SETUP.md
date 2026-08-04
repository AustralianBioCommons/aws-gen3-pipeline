# First-Time Setup — from a fresh laptop to a running pipeline

This is the end-to-end on-ramp for someone who has **never touched this platform
before**. Follow it top to bottom: every step tells you exactly what to run and
how to check it worked. By the end you will have:

- all the tools installed and AWS access working;
- this repo cloned, building, and its test suite green;
- a pipeline environment deployed (or verified, if it already exists) — 12
  CloudFormation stacks whose resource names are published to SSM;
- the `g3dt` operator CLI installed and talking to that environment;
- your first **data release** cut with a single `git tag` push, and the
  release row confirmed in Athena.

It deliberately owns only the connective tissue. The deep detail lives in the
other guides and is linked at each step — read those links when the one-liner
here isn't enough. (Architecture and concepts: [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).
Config authoring: [CONFIG_GUIDE.md](CONFIG_GUIDE.md). Networking decisions:
[VPC_NETWORKING.md](VPC_NETWORKING.md). The deploy loop reference:
[../README.md](../README.md).)

> **Deploying via a wrapper instead?** Most adopters deploy from a private
> deployment wrapper (`./deploy.sh` — see [WRAPPER_GUIDE.md](WRAPPER_GUIDE.md))
> rather than a checkout of this repo. This guide still applies to you: steps
> 1–2 (tools, AWS access), 5 (bootstrap), and 7–11 (post-deploy steps, verify,
> CLI, first release) are identical; only steps 3–4 and 6 are replaced by the
> wrapper's `config/` files and `deploy.sh`.

> **The one mental model to hold** (from [../README.md](../README.md)): humans
> author **INPUTS** — one file per environment,
> `config/<projectId>.<env>.json`. `cdk deploy` derives every resource **name**
> from them and publishes the names to SSM Parameter Store under
> `/<project>/<env>/...`. Everything at runtime — the `g3dt` CLI, CodeBuild,
> the EC2 job box, Glue — reads those SSM parameters. Nothing else is
> configuration.

**Assumptions:** macOS or Linux; you have (or can request) AWS SSO access to
the target AWS account, and access to the GitHub org that will host your
project's dbt repo.

---

## 1. Install the tools

Each block installs one tool, then verifies it. Skip what you already have.

**Git**

```bash
git --version          # any recent version is fine
# macOS: xcode-select --install     Linux: sudo apt install git / sudo dnf install git
```

**Node.js (current LTS)** — via [nvm](https://github.com/nvm-sh/nvm) so you
can switch versions later:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart your shell, then:
nvm install --lts
node --version         # v22.x or newer LTS
```

> **Note:** you do **not** need `npm install -g aws-cdk`. This repo pins the
> CDK CLI as a dev-dependency (see [`../package.json`](../package.json)) and
> every command below uses `npx cdk ...`, which picks up the pinned version.

**AWS CLI v2**

```bash
# macOS:
brew install awscli
# Linux: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
aws --version          # aws-cli/2.x
```

**jq** (used by the integration test):

```bash
brew install jq        # or: sudo apt install jq / sudo dnf install jq
jq --version
```

**Python 3.11+ and pipx** (for the `g3dt` operator CLI in step 9):

```bash
python3 --version      # 3.11 or newer
brew install pipx && pipx ensurepath    # or: python3 -m pip install --user pipx
```

**GitHub CLI** (optional but handy for creating repos from the dbt template):

```bash
brew install gh && gh auth login
```

---

## 2. Get AWS access (SSO)

The platform uses AWS IAM Identity Center (SSO) named profiles — one profile
per environment, conventionally `<project>_<env>` (e.g. `myproject_test`). If
you don't have SSO access yet, request it from the AWS account admin before
continuing. The commands below write `<your-profile>` — substitute the profile
name you choose.

Configure a profile (interactive):

```bash
aws configure sso
# SSO session name:  <your-profile>
# SSO start URL:     (from your admin, e.g. https://<org>.awsapps.com/start)
# SSO region:        ap-southeast-2
# Account / role:    pick the pipeline account and your role
# Profile name:      <your-profile>
```

Your `~/.aws/config` should end up with a block like:

```ini
[profile <your-profile>]
sso_session    = <your-profile>
sso_account_id = <pipeline-account-id>
sso_role_name  = AWSAdministratorAccess
region         = ap-southeast-2

[sso-session <your-profile>]
sso_start_url  = https://<org>.awsapps.com/start
sso_region     = ap-southeast-2
```

Log in and **verify** — this is the check you'll repeat whenever a command
fails with an expired-token error:

```bash
aws sso login --profile <your-profile>
aws sts get-caller-identity --profile <your-profile>
# "Account" MUST be the pipeline account you expect (<pipeline-account-id>).
```

---

## 3. Clone, install, test

Create your own repository from the template first (GitHub → *Use this
template*) if you plan to keep changes, or clone this repo directly to
evaluate:

```bash
git clone https://github.com/AustralianBioCommons/aws-gen3-pipeline.git
cd aws-gen3-pipeline
npm ci
npm run build
npm test
```

**Check:** the suite is green — all tests pass. Those tests are load-bearing:
they pin the naming grammar ([`../test/names.test.ts`](../test/names.test.ts)),
drift-guard the SSM tree ([`../test/ssm-publishing.test.ts`](../test/ssm-publishing.test.ts)),
pin config loading ([`../test/load-config.test.ts`](../test/load-config.test.ts)),
and pin the release-trigger contract ([`../test/dbt-trigger.test.ts`](../test/dbt-trigger.test.ts)).
If they fail on a fresh clone, stop and fix your toolchain before touching AWS.

---

## 4. Point at an environment (or author a new one)

Ten minutes of reading first: the config model section of
[../README.md](../README.md) and sections 1–2 of [CONFIG_GUIDE.md](CONFIG_GUIDE.md).
Then take one of two paths:

### Path A — the environment already exists

Someone (you, a colleague, or a wrapper deploy) has already deployed the
project/env. Get its config file — from the private deployment wrapper repo,
or from whoever deployed it — into `config/<projectId>.<env>.json`
(`config/*.json` is gitignored here, so it stays local). It is INPUTS only,
and every field is explained in [CONFIG_GUIDE.md](CONFIG_GUIDE.md). Check the
environment is live:

```bash
aws ssm get-parameters-by-path --path /<project>/<env> --recursive \
  --profile <your-profile> | jq '.Parameters | length'
# 39 -> deployed and publishing. Skip to step 6 (or step 8 to just verify it).
# 0  -> the env is not deployed; continue as if Path B from step 5.
```

### Path B — stand up a new project/environment

Order matters:

1. **Create the project's dbt repo first** — from the
   [gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)
   (GitHub → *Use this template*, or `gh repo create <org>/<project>-dbt
   --template AustralianBioCommons/gen3-dbt-template --private`). The pipeline's
   CI/CD sources **that** repo, never this one.
2. **One-time per AWS account:** create the CodeConnections connection to the
   GitHub org and note its ARN — follow
   [CONFIG_GUIDE.md section 3.3, "Setting up the connection"](CONFIG_GUIDE.md#setting-up-the-connection-one-time-per-aws-account).
3. **Author the config**: `cp docs/example-config.json
   config/<projectId>.<env>.json`, then fill it in field-by-field with
   [CONFIG_GUIDE.md section 3](CONFIG_GUIDE.md#3-field-by-field-reference). For
   `network.*` (CIDR choice, `public` vs `peered` Gen3 access) read
   [VPC_NETWORKING.md section 5](VPC_NETWORKING.md#5-the-greenfield-network--built-by-the-cdk-libstacksnetwork-stackts)
   and [section 5a](VPC_NETWORKING.md#5a-reaching-the-gen3-rest-api--private-connectivity-is-required).
   (Wrapper users: author the same file in the wrapper's `config/` and commit
   it **there** — that private repo is exactly where real IDs belong.)
4. Validate before deploying:
   [CONFIG_GUIDE.md section 5](CONFIG_GUIDE.md#5-validate-before-you-deploy).

---

## 5. Bootstrap the account (first time per account + region only)

The CDK needs a one-time "bootstrap" stack in each account+region. Check
whether it's already there:

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --profile <your-profile> --query 'Stacks[0].StackStatus' --output text
# CREATE_COMPLETE / UPDATE_COMPLETE -> already bootstrapped, skip ahead.
# "Stack ... does not exist"        -> run the bootstrap below.
```

```bash
npx cdk bootstrap aws://<accountId>/ap-southeast-2 --profile <your-profile>
```

---

## 6. Deploy

(Wrapper users: `./deploy.sh --profile <your-profile> --env <env> --diff`,
then without `--diff` — it runs the same test/diff/deploy sequence below from
a clean upstream checkout. The deploy notes still apply.)

```bash
# See the 12 stacks the app defines for the env:
npx cdk list -c env=test
# <project>-test-network, -buckets, -artifact-bucket, -iam-roles,
# -glue-catalog, -glue-jobs, -athena, -stepfunctions, -codebuild,
# -codepipeline, -ec2-job-runner, -ssm-parameters

# Preview what would change (safe, read-only):
npx cdk diff --all -c env=test --profile <your-profile>

# Deploy everything (10-20 minutes on first run):
npx cdk deploy --all -c env=test --profile <your-profile>
```

> **Note:** if more than one project's config exists in `config/`, add
> `-c project=<projectId>` to every cdk command.

**Deploy notes — what actually happens, and what it costs:**

- The network stack creates a VPC, one NAT gateway (**~US$50/month while
  deployed**), an S3 gateway endpoint, and two zero-ingress security groups —
  the pipeline borrows nothing from other stacks in the account. See
  [VPC_NETWORKING.md section 5](VPC_NETWORKING.md#5-the-greenfield-network--built-by-the-cdk-libstacksnetwork-stackts).
- The SSM stack deploys **last** by design (it publishes names, including the
  EC2 instance id, only after every resource exists).
- Deploying the CodePipeline stack wires **live** pipelines to GitHub via
  CodeConnections — pushes to the configured branch will trigger builds from
  then on.
- The Glue job scripts ship from the repo's `glue-scripts/` directory and are
  deployed to `s3://<metadata-bucket>/scripts/` automatically on every
  `cdk deploy` (a BucketDeployment in the glue-jobs stack, with `prune: true`
  so removed scripts are also removed from S3) — no manual upload. Details:
  step 7b.
- The EC2 job box starts **running** (billed), but **auto-stops after ~24 h
  averaging under 1% CPU** (CloudWatch alarm). For immediate savings you can
  still stop it by hand:
  `aws ec2 stop-instances --instance-ids "$(aws ssm get-parameter --name /<project>/<env>/ec2/instanceId --query Parameter.Value --output text --profile <your-profile>)"`.

**Check:** every stack ends `✅`, and the SSM tree is complete:

```bash
aws ssm get-parameters-by-path --path /<project>/<env> --recursive \
  --profile <your-profile> | jq '.Parameters | length'
# -> 39   (38 from the ssm-parameters stack + ec2/instanceId from the EC2 stack)
```

---

## 7. The two manual post-deploy steps

The CDK cannot create these; the integration test (step 8) WARNs until they
are done.

### 7a. Create the Gen3 API-key secret

Jobs authenticate to the Gen3 commons with an API key stored in Secrets
Manager. The secret **name must exactly match** `gen3.awsSecretName` in your
config file (e.g. `myproject_api_key.json`).

1. In the Gen3 commons web portal: your profile → *Create API key* → download
   the `credentials.json` (it contains `api_key` and `key_id`).
2. Create the secret from it:

```bash
aws secretsmanager create-secret \
  --name "$(jq -r .gen3.awsSecretName config/<projectId>.<env>.json)" \
  --secret-string file://credentials.json \
  --profile <your-profile>
```

**Check:** `aws secretsmanager describe-secret --secret-id <name> --profile
<your-profile>` succeeds. (Only the EC2 job box's role can *read* it — it is
scoped to exactly this secret name.)

### 7b. Glue job scripts — automatic (nothing to do)

The built-in Glue job scripts live in the repo's
[`../glue-scripts/`](../glue-scripts/) directory and are deployed to
`s3://<metadata-bucket>/scripts/` **automatically on every `cdk deploy`** (a
BucketDeployment in the glue-jobs stack). They receive only
`--PROJECT_ID/--ENV/--REGION` from the CDK and resolve every name from the
env's SSM tree via the `g3dt` toolkit — the same wheel the EC2 box and
CodeBuild run. (Custom jobs declared via `customJobs` deploy the same way —
see [CONFIG_GUIDE.md](CONFIG_GUIDE.md#custom-glue-jobs) and
[WRAPPER_GUIDE.md](WRAPPER_GUIDE.md#custom-glue-scripts-the-overlay).)

**Check:**

```bash
aws s3 ls s3://$(aws ssm get-parameter --name /<project>/<env>/buckets/metadata \
    --profile <your-profile> --query Parameter.Value --output text)/scripts/ \
  --profile <your-profile>
# write_validation_jsons.py, silver_json_gen3_validator.py, write_data_release_to_json.py, ...
```

---

## 8. Verify the deployment

**Why this step exists:** a green `cdk deploy` only proves the resources were
*created* — it cannot see whether the EC2 box's user-data bootstrap succeeded,
whether it registered with SSM, whether Athena queries actually run, or
whether out-of-band dependencies (Glue job scripts in S3, the Gen3 secret,
GitHub App access) are in place. The integration test checks exactly those
runtime behaviours — never call an environment "up" until it passes.

```bash
./scripts/integration_test.sh --profile <your-profile> --env <env>
# --read-only skips the two active probes (an Athena SELECT 1 and an SSM
# Run Command on the job box); see the script header for all flags.
```

This probes the **live** environment: SSM tree truthfulness, the EC2 box
(running, private subnet, SSM-managed, `g3dt` installed, NAT egress), an
Athena `SELECT 1` in the workgroup, the auto-stop alarm, and the pipelines.

**How to read it:**

- **PASS** — expected on everything infrastructure-side. A healthy env shows
  `15 passed, 0 failed`.
- **WARN** — the Gen3 secret if you skipped step 7a. Acceptable; fix at your pace.
- **FAIL** — a real problem. Start with
  [DEVELOPER_GUIDE.md section 7, Troubleshooting](DEVELOPER_GUIDE.md#7-troubleshooting).

---

## 9. Set up the operator CLI (`g3dt`)

Day-to-day operations use
[gen3-dataops-toolkit](https://github.com/AustralianBioCommons/gen3-dataops-toolkit)
— the `g3dt` CLI. It carries **no configuration**: it resolves every resource
name live from the env's SSM tree. The only local file is a tiny bootstrap
marker.

```bash
pipx install gen3-dataops-toolkit
g3dt version        # e.g. 2.1.2
```

Create the marker at `~/.g3dt/g3dt.yaml`:

```yaml
# The only local config g3dt needs. Everything else resolves from SSM.
project: myproject          # your projectId
region: ap-southeast-2
default_env: test
profiles:                   # AWS named profile per env (omit on EC2/CI —
  test: <your-profile>      # ambient role credentials are used there)
```

(Search order is `./g3dt.yaml` → `~/.g3dt/g3dt.yaml` → `/etc/g3dt/g3dt.yaml`;
the last one is written onto the EC2 job box by CDK user-data, which is why
the box needs no setup.)

**Check — the golden safety habit.** Before *any* job, print the resolved
names and read them out loud; they must be the `<project>-<env>-*` set you
expect:

```bash
g3dt config show --env test
g3dt config envs            # environments with a deployed SSM tree
```

---

## 10. First operations

### 10a. The EC2 job box

```bash
g3dt ec2 status --env test        # e.g. "i-...: running (ssm online)"
g3dt ec2 up --env test            # starts it and waits for SSM registration
aws ssm start-session --target <instance-id> --profile <your-profile>   # shell on the box (no SSH)
g3dt ec2 down --env test          # or let the 24h-idle auto-stop alarm do it
```

Long data-plane jobs (e.g. `g3dt metadata upload ... --on ec2`) dispatch to
this box via SSM Run Command — disconnect-safe, watched with
`g3dt jobs list` / `g3dt jobs logs <run-id> --follow`.

### 10b. Run dbt locally against the env

From your project's dbt repo (created from the template in step 4B):

```bash
eval "$(g3dt config dbt-env --env test)"   # exports the env's names from SSM
export DBT_PROFILES_DIR=.
dbt deps && dbt build
```

### 10c. Cut your first data release

A data release is **one tag push** on the project's dbt repo — never a
console click:

```bash
cd <your-project>-dbt
# optional but good hygiene: bump vars.project_version in dbt_project.yml
git tag data-v0.1.0
git push origin data-v0.1.0
```

That fires the `<project>-<env>-dbt-write-release-info` pipeline (only
`data-v*` tags trigger it; branch pushes only run CI). Watch it:

```bash
g3dt pipeline status --env test                 # per-stage state
g3dt pipeline logs   --env test --follow        # live dbt + release-writer output
```

**Check:** the Build stage reaches `Succeeded`, and the release rows landed in
the Iceberg ledger (Athena, workgroup `<project>-<env>`):

```sql
SELECT release_tag, db_name, model_name, github_sha
FROM   "<project>_<env>_dataops_metadata_db"."releases"
WHERE  release_tag = '0.1.0';
```

Re-pushing the same release is safe — the writer is idempotent and logs
`[SKIP] Release row already exists`. (The pipeline's final
`write_release_jsons` stage exports gold-model JSONs; with a silver-only
dbt project it logs "no gold-model rows" and succeeds.)

---

## 11. When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `Token has expired and refresh failed` / `The SSO session has expired` | SSO login lapsed | `aws sso login --profile <p>` (step 2) |
| `No SSM parameters found under /<project>/<env>` from `g3dt` | env not deployed, or wrong `project:` in your marker | step 6; check `~/.g3dt/g3dt.yaml` |
| `cdk deploy` fails with "current credentials could not be used" / bootstrap errors | account+region not bootstrapped | step 5 |
| Pipelines exist but Source stage fails | CodeConnections connection still `PENDING` (needs one-time console handshake) | [CONFIG_GUIDE.md section 3.3](CONFIG_GUIDE.md#33-repo--the-dbt-repository-that-drives-cicd) and [DEVELOPER_GUIDE.md section 7](DEVELOPER_GUIDE.md#7-troubleshooting) |
| Wrong env's names printed by `g3dt config show` | wrong `--env`, or wrong `-c env=` at deploy time | re-check before running anything that writes |
| Step Function stages `validation` / `write_release_jsons` fail | check the Glue job run logs (`/aws-glue/python-jobs/output`); scripts deploy automatically (step 7b) | step 7b |

More: [DEVELOPER_GUIDE.md section 7, Troubleshooting](DEVELOPER_GUIDE.md#7-troubleshooting)
and the error table in [CONFIG_GUIDE.md section 5](CONFIG_GUIDE.md#5-validate-before-you-deploy).

---

## 12. Related docs

| Doc | What it's for |
|---|---|
| [../README.md](../README.md) | The config model + the quickstarts |
| [WRAPPER_GUIDE.md](WRAPPER_GUIDE.md) | Creating, operating, and upgrading a private deployment wrapper |
| [CONFIG_GUIDE.md](CONFIG_GUIDE.md) | Authoring `config/<projectId>.<env>.json`, field by field; CodeConnections setup |
| [VPC_NETWORKING.md](VPC_NETWORKING.md) | The pipeline's network, CIDR choice, `public` vs `peered` Gen3 access |
| [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) | Architecture, the 12 stacks, how-to recipes, troubleshooting |
| [gen3-dataops-toolkit](https://github.com/AustralianBioCommons/gen3-dataops-toolkit) | The `g3dt` CLI (operator tooling; PyPI package) |
| [gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template) | The dbt project template each project instantiates |
