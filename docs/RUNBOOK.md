# End-to-end setup runbook

Stand up a complete Gen3 data pipeline from nothing: this repo (the CDK
infrastructure), your dbt repo (from
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)),
and the [`gen3-dataops-toolkit`](https://pypi.org/project/gen3-dataops-toolkit/)
CLI — ending with a running warehouse, a validated synthetic dataset, and a
versioned data-release folder in the gold bucket.

This is the full detailed guide: every step of the journey, with what each
step achieves and how to check it worked. For the same journey with minimal
ceremony, use [QUICKSTART.md](QUICKSTART.md); for the ideas behind each
mechanism, read [CONCEPTS.md](CONCEPTS.md) first. This runbook was written by
walking the whole process on a live test environment, so the troubleshooting
section at the end is real, not speculative.

**Version pairing** (the three components move together — see each repo's
release notes):

| Component | This runbook assumes |
|---|---|
| aws-gen3-pipeline | ≥ v2.2.0 |
| gen3-dataops-toolkit | ≥ 3.2.0 |
| gen3-validator | ≥ 2.2.0 (resolved automatically as a toolkit dependency) |
| gen3-dbt-template | silver-generators revision or later |

**Placeholders.** Angle-bracketed values are yours to fill in; everything else
is copy-pasteable as written:

| Placeholder | Meaning | Example |
|---|---|---|
| `<project>` | Your project id (lower-case) | `myproject` |
| `<env>` | Environment name | `test` |
| `<account-id>` | The target AWS account | `123456789012` |
| `<region>` | The target AWS region | `ap-southeast-2` |
| `<your-profile>` | Your AWS SSO CLI profile | `myproject_test` |
| `<study>` | The study segment in dbt model names | `synth1` |

Every derived resource name follows the conventions in
[CONCEPTS.md, "The naming scheme and the SSM tree"](CONCEPTS.md#the-naming-scheme-and-the-ssm-tree).

---

## 0. Prerequisites

**What this achieves:** a laptop with the right tools and working AWS access.
Each block installs one thing, then verifies it — skip what you already have.

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
> CDK CLI as a dev-dependency and every command below uses `npx cdk ...`,
> which picks up the pinned version.

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

**Python 3.11+ and pipx** (for the `g3dt` operator CLI in step 5):

```bash
python3 --version      # 3.11 or newer
brew install pipx && pipx ensurepath    # or: python3 -m pip install --user pipx
```

**GitHub CLI** (optional but handy for creating repos from templates):

```bash
brew install gh && gh auth login
```

You will also need **a GitHub org or account** to hold two private repos (your
deployment wrapper and your dbt repo), and **AWS SSO access** to the target
account with rights to deploy (admin-ish). If you don't have SSO access yet,
request it from the AWS account admin before continuing.

### Set up AWS access (SSO)

The platform uses AWS IAM Identity Center (SSO) named profiles — one profile
per environment, conventionally `<project>_<env>`. Configure one
interactively:

```bash
aws configure sso
# SSO session name:  <your-profile>
# SSO start URL:     (from your admin, e.g. https://<org>.awsapps.com/start)
# SSO region:        <region>
# Account / role:    pick the pipeline account and your role
# Profile name:      <your-profile>
```

Your `~/.aws/config` should end up with a block like:

```ini
[profile <your-profile>]
sso_session    = <your-profile>
sso_account_id = <account-id>
sso_role_name  = AWSAdministratorAccess
region         = <region>

[sso-session <your-profile>]
sso_start_url  = https://<org>.awsapps.com/start
sso_region     = <region>
```

Log in and **verify** — this is the check you'll repeat whenever any AWS
command fails with an expired-token error (expect to re-login daily):

```bash
aws sso login --profile <your-profile>
aws sts get-caller-identity --profile <your-profile>
# "Account" MUST be <account-id>, the pipeline account you expect.
```

## 1. Create your two repos

**What this achieves:** the two repositories you own — a private wrapper that
deploys the infrastructure, and a dbt repo that defines the warehouse.

> **Joining an environment that already exists?** Someone has already done
> this setup — you don't repeat it. Get access to the existing wrapper and
> dbt repos instead of creating new ones, then check the environment is live:
>
> ```bash
> aws ssm get-parameters-by-path --path /<project>/<env> --recursive \
>   --profile <your-profile> | jq '.Parameters | length'
> # 39 -> deployed and publishing. Skip to step 5 (configure the CLI).
> # 0  -> not deployed; continue below.
> ```

### 1a. The deployment wrapper (holds your real config — keep it PRIVATE)

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/<project>-pipeline-deploy --project <project> --envs <env>
cd ~/code/<project>-pipeline-deploy
# create a PRIVATE GitHub repo and push this directory to it
```

The `/tmp/g3p` clone is a **throwaway** — it exists only so you can run
`init-wrapper.sh`, which scaffolds a fresh, standalone repo at the target
path. The wrapper is never a fork or clone of this repo (forks of public
repos cannot be made private, which would publish your account IDs), and it
never holds pipeline code: its `deploy.sh` clones this repo at the tag pinned
in `UPSTREAM_VERSION`, overlays your config, and deploys. Full concept:
[CONCEPTS.md section 3](CONCEPTS.md#3-the-deployment-wrapper--deploy-without-forking);
mechanics: [WRAPPER_GUIDE.md](WRAPPER_GUIDE.md).

> If the script errors with `no upstream tag found`, the shallow clone's
> branch tip isn't tagged — pass the latest release explicitly:
> `--upstream-version vX.Y.Z`.

### 1b. The dbt repo (drives silver and gold)

Create your repo from the
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)
(GitHub → *Use this template*, or
`gh repo create <org>/<project>-dbt --template AustralianBioCommons/gen3-dbt-template --private`).
Out of the box its `silver_synth1_*` models **generate deterministic
synthetic data in SQL** — `dbt build` alone produces a whole warehouse, so
you can prove the pipeline end-to-end before any real data exists. Bronze is
never written by dbt; it is the landing zone for your real ingestion later
([DATA_LAYERS.md](DATA_LAYERS.md)).

## 2. AWS prerequisites the config will reference

**What this achieves:** the three account-level facts your config file needs
before it can be filled in.

1. **CodeConnections (GitHub) connection** — lets CodePipeline watch your dbt
   repo without a stored token. Console → Developer Tools → Connections →
   Create connection → GitHub → authorise → note the ARN. Grant the GitHub
   App access to your dbt repo specifically. (One-time per AWS account;
   detailed walkthrough:
   [CONFIG_GUIDE.md section 3.3](CONFIG_GUIDE.md#33-repo--the-dbt-repository-that-drives-cicd).)

2. **Gen3 API-key secret** *(deferrable)* — jobs authenticate to the Gen3
   commons with an API key stored in AWS Secrets Manager, named
   `<project>_<env>_gen3_api_key.json` by convention. The pipeline deploys
   fine without it; the integration test will WARN until it exists, and
   metadata upload / indexd registration need it before any real push
   (step 11). To create it when ready:

   1. In the Gen3 commons web portal: your profile → *Create API key* →
      download the `credentials.json` (it contains `api_key` and `key_id`).
   2. Create the secret from it:

   ```bash
   aws secretsmanager create-secret \
     --name <project>_<env>_gen3_api_key.json \
     --secret-string file://credentials.json \
     --profile <your-profile>
   ```

   Only the job box's role can read it — the grant is scoped to exactly this
   secret name, which must match `gen3.awsSecretName` in your config.

3. **An AMI id** for the EC2 job box — the suggested value is the current
   Amazon Linux 2023 image in your region, which AWS publishes as a public
   SSM parameter:

   ```bash
   aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
     --query Parameter.Value --output text --profile <your-profile>
   ```

## 3. Fill in the config

**What this achieves:** the single INPUTS file the whole environment is
derived from (why it works this way:
[CONCEPTS.md section 4](CONCEPTS.md#4-configuration-inputs-outputs-and-what-ssm-achieves)).

Edit `config/<project>.<env>.json` in the wrapper (seeded from
`docs/example-config.json`). Field-by-field reference:
[CONFIG_GUIDE.md](CONFIG_GUIDE.md). The fields people get wrong:

- `repo.fullName` / `branch` — **your dbt repo**, not the template.
- `repo.codeStarConnectionArn` — from step 2.1.
- `toolkitVersion` — the `gen3-dataops-toolkit` PyPI pin (currently `3.2.0`).
  This single value pins the toolkit for the Glue jobs, the EC2 box, and the
  CodeBuild builds.
- `gen3.schemaS3Uri` — `bucket/key` form, **no `s3://`**. For a first
  environment with no commons of your own, use the default test dictionary
  (step 6).
- `gen3.awsSecretName` — the secret *name* from step 2.2 (never a value).

Commit and push the wrapper.

## 4. First deploy

**What this achieves:** the twelve CloudFormation stacks — network, buckets,
databases, build pipelines, validation state machine, job box — created in
your account, and proof that they actually work.

First, a one-time step per account+region: the CDK needs a "bootstrap" stack
(a small S3 bucket and roles it stages deployments through). Check whether
it's already there, and create it if not:

```bash
cd ~/code/<project>-pipeline-deploy
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --profile <your-profile> --query 'Stacks[0].StackStatus' --output text
# CREATE_COMPLETE / UPDATE_COMPLETE -> already bootstrapped, skip the next command.
# "Stack ... does not exist"        -> bootstrap:
npx cdk bootstrap aws://<account-id>/<region> --profile <your-profile>
```

Then review and deploy (first deploy takes ~10-20 minutes):

```bash
./deploy.sh --profile <your-profile> --env <env> --diff    # review all 12 stacks; deploys nothing
./deploy.sh --profile <your-profile> --env <env>
```

`deploy.sh` clones the pinned upstream into `.checkout/`, overlays your
config, runs the upstream test suite, diffs, and deploys — a failing test
suite stops the deploy, deliberately.

**Deploy notes — what actually happens, and what it costs:**

- The network stack creates a VPC, one NAT gateway (**~US$50/month while
  deployed**), an S3 gateway endpoint, and two zero-ingress security groups.
- The SSM stack deploys **last** by design — it publishes names only after
  every resource exists.
- Deploying the CodePipeline stack wires **live** pipelines to GitHub —
  pushes to the configured branch will trigger builds from then on.
- Glue job scripts deploy to `s3://<metadata-bucket>/scripts/` automatically
  on every deploy (with `prune: true`, so removed scripts are removed from
  S3) — no manual upload, ever.
- The EC2 job box starts **running** (billed), but auto-stops after ~24 h of
  idling (CloudWatch alarm). To stop it immediately: `g3dt ec2 down` (after
  step 5).

**Check** the SSM tree is complete:

```bash
aws ssm get-parameters-by-path --path /<project>/<env> --recursive \
  --profile <your-profile> | jq '.Parameters | length'
# -> 39
```

Then prove the environment *works*, not just that it was created — a green
deploy cannot see whether the job box bootstrapped, Athena queries run, or
the out-of-band pieces (Glue scripts in S3, the Gen3 secret, GitHub App
access) are in place. The integration suite probes exactly those runtime
behaviours; never call an environment "up" until it passes:

```bash
# from the wrapper (the checkout deploy.sh created):
./.checkout/scripts/integration_test.sh --profile <your-profile> --env <env>
# from a checkout of this repo instead: ./scripts/integration_test.sh ...
```

**How to read it:**

- **PASS** — expected on everything infrastructure-side.
- **WARN** — expect exactly one, for the Gen3 secret, if you deferred
  step 2.2. Acceptable; fix at your pace.
- **FAIL** — a real problem. Start with the troubleshooting table below, then
  [DEVELOPER_GUIDE.md section 7](DEVELOPER_GUIDE.md#7-troubleshooting).

## 5. Configure the CLI toolkit

**What this achieves:** the `g3dt` operator CLI on your laptop, resolving
every resource name live from the SSM tree the deploy just published — the
toolkit needs AWS credentials and this one small marker file, nothing else.

```bash
pipx install gen3-dataops-toolkit
g3dt version                       # >= 3.2.0 (see the pairing table above)

mkdir -p ~/.g3dt && cat > ~/.g3dt/g3dt.yaml <<EOF
project: <project>
region: <region>
default_env: <env>
profiles:                # AWS named profile per env (omit on EC2/CI —
  <env>: <your-profile>  # ambient role credentials are used there)
EOF
```

(Config search order is `./g3dt.yaml` → `~/.g3dt/g3dt.yaml` →
`/etc/g3dt/g3dt.yaml`; the last one is written onto the EC2 job box by CDK
user-data, which is why the box needs no setup.)

**Check — the golden safety habit.** Before *any* job, print the resolved
names and read them out loud; they must be the `<project>-<env>-*` set you
expect:

```bash
g3dt config show --env <env>       # every derived name, resolved live from SSM
g3dt config envs                   # environments with a deployed SSM tree
g3dt config diff --env <env> --file ~/code/<project>-pipeline-deploy/config/<project>.<env>.json
                                   # exits 1 on drift — usable as a CI gate
```

If `config show` errors about missing app facts, the deploy has not run (or
ran an older pipeline version than the toolkit expects — check the version
pairing table above).

## 6. Stage the default test dictionary

**What this achieves:** a data dictionary the validation job can read. The
validation Glue job downloads its Gen3 schema from `gen3.schemaS3Uri`
(config → SSM `app/schema_s3_uri` → S3). With no commons of your own, use
the official public Gen3 dictionary, copied into the pipeline's own metadata
bucket so the Glue role can read it:

```bash
curl -s https://s3.amazonaws.com/dictionary-artifacts/datadictionary/develop/schema.json \
  -o /tmp/schema.json

aws s3 cp /tmp/schema.json \
  s3://<project>-<env>-metadata-<account-id>-<region>/schema/gen3_datadictionary_develop.json \
  --profile <your-profile>
```

Set `gen3.schemaS3Uri` to
`<project>-<env>-metadata-<account-id>-<region>/schema/gen3_datadictionary_develop.json`
and `gen3.dictionaryVersion` to `develop` in the wrapper config, then
redeploy (`./deploy.sh … --diff` → deploy) so SSM mirrors the new values.

The template's synthetic chain (`project → experiment → case → demographic`)
validates green against this dictionary.

## 7. First dbt build (CI)

**What this achieves:** proof the commit-triggered pipeline works, with all
output isolated from the real warehouse
([CONCEPTS.md section 6](CONCEPTS.md#6-ci-builds-vs-release-builds--why-they-never-touch)).

Push anything to your dbt repo's main branch. The commit triggers the
`<project>-<env>-dbt-test-and-run` CodePipeline, which runs `dbt build` with
the `ci` target — everything lands in the isolated `ci_*` databases, never
the real warehouse:

```bash
g3dt pipeline status --env <env> --which dbtTestAndRun
g3dt pipeline logs   --env <env> --which dbtTestAndRun --follow
```

Green means: synthetic silver + gold built in `ci_<project>_<env>_silver_db`
/ `ci_<project>_<env>_gold_db` and all schema tests passed.

Two other ways to run things, for later:

- **Run dbt locally against the env** (from your dbt repo):

  ```bash
  eval "$(g3dt config dbt-env --env <env>)"   # exports the env's names from SSM
  export DBT_PROFILES_DIR=.
  dbt deps && dbt build
  ```

  Never skip the `eval` line — without it, the profile's `env_var()` defaults
  point at another environment's names.

- **The EC2 job box**, for long jobs that shouldn't depend on your laptop:

  ```bash
  g3dt ec2 status --env <env>       # e.g. "i-...: running (ssm online)"
  g3dt ec2 up --env <env> --wait    # starts it and waits for SSM registration
  g3dt ec2 down --env <env>         # or let the 24h-idle auto-stop do it
  ```

## 8. Cut a data release

**What this achieves:** a versioned, reproducible snapshot of the warehouse,
recorded in the release ledger
([CONCEPTS.md section 8](CONCEPTS.md#8-releases-tags-and-reproducibility)).

Releases are tags, never branches or console clicks:

```bash
cd <your-dbt-repo>
# optional but good hygiene: bump vars.project_version in dbt_project.yml first
git tag data-v0.1.0 && git push origin data-v0.1.0
```

This triggers the `<project>-<env>-dbt-write-release-info` pipeline (only
`data-v*` tags trigger it; branch pushes only run CI), which:

1. **Waits for any in-progress CI build** (the wait-gate — you'll see
   "Checking for in-progress … builds" in its log; a WARNING about IAM there
   means the pipeline deploy is incomplete).
2. Runs `dbt build` with the default target → the **real**
   `<project>_<env>_silver_db` / `_gold_db`.
3. Writes one row per model to the `releases` ledger
   (`<project>_<env>_dataops_metadata_db.releases`), pinning each model's
   Iceberg snapshot to the tag.

When the release pipeline completes, the **write-release-jsons Step Function
runs automatically** — do not start it by hand right after a release (the
Glue job allows one concurrent run; a manual start just fails with
`ConcurrentRunsExceededException` while the automatic one succeeds).

**Check** the Build stage reaches `Succeeded`, then confirm the ledger rows
(Athena, workgroup `<project>-<env>`):

```sql
SELECT release_tag, db_name, model_name, github_sha
FROM   "<project>_<env>_dataops_metadata_db"."releases"
WHERE  release_tag = '0.1.0';
```

Re-pushing the same tag is safe — the writer is idempotent and logs
`[SKIP] Release row already exists`.

## 9. Validate

**What this achieves:** the answer to "would Gen3 accept this data?" — the
gate that separates built from releasable
([CONCEPTS.md section 7](CONCEPTS.md#7-the-validation-gate--what-green-means)).

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:<region>:<account-id>:stateMachine:<project>-<env>-validation \
  --profile <your-profile>
```

The validation state machine dumps every silver table to JSON, validates each
record against the dictionary from step 6, writes results to
`<project>_<env>_validation_db.full_validation_results`, and **fails the
execution if real errors remain** — a green run *means* schema-clean data,
not just that the machinery ran. On a red run:

```sql
SELECT node, validation_error, count(*) FROM <project>_<env>_validation_db.full_validation_results
WHERE validation_id = (SELECT max(validation_id) FROM <project>_<env>_validation_db.full_validation_results)
  AND validation_error IS NOT NULL
GROUP BY 1, 2 ORDER BY 3 DESC
```

Fix the data (or models), re-release, re-run. Operator loop detail:
[OPERATIONS.md](OPERATIONS.md).

## 10. The end state — a versioned release folder

After steps 8–9 the gold bucket holds the deployable artifact:

```
s3://<project>-<env>-gold-<account-id>-<region>/release_jsons/v0.1.0/synth1/
├── project.json          one file per Gen3 node, submission-shaped
├── experiment.json
├── case.json
├── demographic.json
└── DataImportOrder.txt   topological submission order, derived from the schema
```

The `synth1` folder name comes from the **model-name convention**
`<layer>_<study>_<node>` (e.g. `silver_synth1_case`) — the release exporter
and the metadata-upload layout both parse it, so keep the study segment when
you add models. Query anything at any layer meanwhile:

```bash
# via Athena, workgroup <project>-<env>
SELECT count(*) FROM <project>_<env>_silver_db.silver_synth1_case;
```

## 11. When real data arrives

1. Ingest into bronze — any way you like; the supported no-code path is
   [gen3-metadata-templates](https://github.com/AustralianBioCommons/gen3-metadata-templates)
   workbooks + the `<project>-<env>-ingest-metadata-templates` Glue job
   ([DATA_LAYERS.md](DATA_LAYERS.md)). CodeBuild/dbt cannot write bronze —
   that boundary is enforced by IAM, not convention.
2. In the dbt repo: add a `models/sources.yml` over your bronze tables
   (schema from `G3DT_DB_BRONZE`) and replace the synthetic generator models
   with silver models reading `{{ source(...) }}` — same output shape
   (cleaned columns + Gen3 link JSON + FK helper). Gold and tests keep their
   shape.
3. Create the API-key secret (step 2.2) and verify uploads will actually
   work before a production push:

   ```bash
   g3dt metadata upload --study <study> --env <env>
   g3dt indexd register --s3-paths s3://<bucket>/<study>/ --study <study> --env <env>
   g3dt indexd check-download --env <env>       # Indexd → DRS → signed URL, exits non-zero on failure
   ```

## 12. Day-2 operations

- **Upgrades**: bump `UPSTREAM_VERSION` and/or `toolkitVersion` in the
  wrapper → `./deploy.sh … --diff` → deploy. Rollback = revert the pin.
  Toolkit bumps re-roll the Glue jobs and replace the EC2 box (expected).
  The integration suite's toolkit-pin drift check catches a missed leg.
- Daily ops, delete/reupload flows, EC2 job box: [OPERATIONS.md](OPERATIONS.md).
- Anything surprising: [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md).

---

## Troubleshooting (all hit for real while writing this)

| Symptom | Cause / fix |
|---|---|
| Any AWS call: `Token has expired and refresh failed` | SSO session expired — `aws sso login --profile <your-profile>` (step 0) |
| `cdk deploy` fails with "current credentials could not be used" / bootstrap errors | Account+region not bootstrapped — step 4 |
| `g3dt`: `No SSM parameters found under /<project>/<env>` | Env not deployed, or wrong `project:` in `~/.g3dt/g3dt.yaml` |
| Pipelines exist but the Source stage fails | CodeConnections connection still `PENDING` — it needs the one-time console handshake ([CONFIG_GUIDE.md section 3.3](CONFIG_GUIDE.md#33-repo--the-dbt-repository-that-drives-cicd)) |
| Wrong env's names printed by `g3dt config show` | Wrong `--env`, or wrong `-c env=` at deploy time — re-check before running anything that writes |
| Validation job: `SchemaResolutionError` (or, pre-2.2.0, `KeyError` in `gen3_validator.resolve_schema`) | A structural `$ref` in the dictionary is genuinely broken — the message names the ref and file. (Older gen3-validator < 2.2.0 also crashed on the official dictionary's `term` refs; ensure the pairing table's versions) |
| Validation fails listing a "study" per node with empty JSON filenames later | Model names missing the study segment — use `<layer>_<study>_<node>` |
| Validation / write-release-jsons Step Function stage fails | Check the Glue job run logs (`/aws-glue/python-jobs/output`); scripts deploy automatically on every deploy (step 4) |
| `write-release-jsons` fails with `ConcurrentRunsExceededException` right after a release | It auto-runs post-release; your manual start collided with it. Check the newest execution — the automatic one likely SUCCEEDED |
| dbt test errors `ICEBERG_MISSING_METADATA` after changing a model's materialization | Switching an existing Iceberg relation (e.g. incremental → table) can strand its metadata pointer — drop the old Glue table(s) and rebuild |
| Release build log: `WARNING: cannot query … builds (missing IAM permission?)` | The CI wait-gate is degrading to a no-op — the pipeline deploy providing `WaitOnCiBuilds` hasn't landed; redeploy |
| CI green but a laptop `dbt build` targets weird names | You skipped `eval "$(g3dt config dbt-env --env <env>)"` — the `env_var()` defaults only fit the reference environment |
| `g3dt` errors: missing app fact(s) / missing medallion SSM key | Pipeline not deployed, or toolkit major ahead of the pipeline version — see the pairing table at the top |
| Integration suite: parameter-count mismatch | Wrapper `UPSTREAM_VERSION` and the deployed stack disagree — diff + deploy, then rerun |
