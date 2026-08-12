# Quickstart

The minimum working path from nothing to a **validated synthetic data
release**, via a private deployment wrapper. One sentence per step; every
step is explained in full in [RUNBOOK.md](RUNBOOK.md), and the ideas behind
it in [CONCEPTS.md](CONCEPTS.md).

Fill in the placeholders with your values: `<project>` (e.g. `myproject`),
`<env>` (e.g. `test`), `<account-id>`, `<region>`, `<your-profile>` (an AWS
SSO profile), `<org>` (your GitHub org).

**Prerequisites** (installs and SSO setup: [RUNBOOK step 0](RUNBOOK.md#0-prerequisites)):
Node.js LTS, AWS CLI v2 with an SSO profile logged in (`aws sso login
--profile <your-profile>`), Python 3.11+ with pipx, jq, and a GitHub org for
two private repos.

**1. Create your deployment wrapper** — a fresh private repo holding only
your config, pinned to an upstream release
([RUNBOOK step 1a](RUNBOOK.md#1a-the-deployment-wrapper-holds-your-real-config--keep-it-private)):

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/<project>-pipeline-deploy \
  --project <project> --envs <env> --upstream-version v2.2.0   # use the latest release tag
cd ~/code/<project>-pipeline-deploy
gh repo create <org>/<project>-pipeline-deploy --private --source . --push
```

**2. Create your dbt repo** from the template — its built-in models generate
synthetic data, so the pipeline works before any real data exists
([RUNBOOK step 1b](RUNBOOK.md#1b-the-dbt-repo-drives-silver-and-gold)):

```bash
gh repo create <org>/<project>-dbt \
  --template AustralianBioCommons/gen3-dbt-template --private
```

**3. Create the AWS-side prerequisites** — a CodeConnections connection to
your GitHub org (console: Developer Tools → Connections → Create → GitHub;
note the ARN) and, when you have a Gen3 API key, the secret
`<project>_<env>_gen3_api_key.json` (deferrable — one WARN in step 7 until it
exists) ([RUNBOOK step 2](RUNBOOK.md#2-aws-prerequisites-the-config-will-reference)).

**4. Fill in the config** `config/<project>.<env>.json` — the fields that
matter: `accountId`, `region`, `repo.fullName` (your dbt repo) +
`repo.codeStarConnectionArn`, `ec2.ami`, `toolkitVersion` (`3.2.0`), and the
`gen3.*` facts ([RUNBOOK step 3](RUNBOOK.md#3-fill-in-the-config), field
reference [CONFIG_GUIDE.md](CONFIG_GUIDE.md)). Commit and push.

**5. Bootstrap (once per account+region) and deploy**
([RUNBOOK step 4](RUNBOOK.md#4-first-deploy)):

```bash
npx cdk bootstrap aws://<account-id>/<region> --profile <your-profile>
./deploy.sh --profile <your-profile> --env <env> --diff    # review first
./deploy.sh --profile <your-profile> --env <env>           # ~10-20 min
```

**6. Install and point the operator CLI**
([RUNBOOK step 5](RUNBOOK.md#5-configure-the-cli-toolkit)):

```bash
pipx install gen3-dataops-toolkit
mkdir -p ~/.g3dt && cat > ~/.g3dt/g3dt.yaml <<EOF
project: <project>
region: <region>
default_env: <env>
profiles:
  <env>: <your-profile>
EOF
g3dt config show --env <env>       # every resolved name — read them aloud
```

**7. Verify the deployment** — expect all PASS, plus exactly one WARN if you
deferred the Gen3 secret ([RUNBOOK step 4](RUNBOOK.md#4-first-deploy)):

```bash
./.checkout/scripts/integration_test.sh --profile <your-profile> --env <env>
```

**8. Stage the test data dictionary** into the metadata bucket and point
`gen3.schemaS3Uri` at it, then redeploy — the exact commands are in
[RUNBOOK step 6](RUNBOOK.md#6-stage-the-default-test-dictionary).

**9. Trigger the first CI build** — push anything to the dbt repo's main
branch, then watch it land in the isolated `ci_*` databases
([RUNBOOK step 7](RUNBOOK.md#7-first-dbt-build-ci)):

```bash
g3dt pipeline logs --env <env> --which dbtTestAndRun --follow
```

**10. Cut a data release** ([RUNBOOK step 8](RUNBOOK.md#8-cut-a-data-release)):

```bash
cd <your-dbt-repo>
git tag data-v0.1.0 && git push origin data-v0.1.0
g3dt pipeline status --env <env> --which writeReleaseInfo
```

**11. Validate it** — green means every record is schema-clean
([RUNBOOK step 9](RUNBOOK.md#9-validate)):

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:<region>:<account-id>:stateMachine:<project>-<env>-validation \
  --profile <your-profile>
```

Done: the gold bucket now holds a versioned `release_jsons/v0.1.0/` folder —
the artifact a Gen3 deployment consumes
([RUNBOOK step 10](RUNBOOK.md#10-the-end-state--a-versioned-release-folder)).

---

- Every step explained, with checks and troubleshooting: **[RUNBOOK.md](RUNBOOK.md)**
- Why it works this way: **[CONCEPTS.md](CONCEPTS.md)**
- Day-to-day operation: **[OPERATIONS.md](OPERATIONS.md)**
- Contributors deploying from a checkout of this repo:
  **[DEVELOPER_GUIDE.md section 6](DEVELOPER_GUIDE.md#6-deployment)**
