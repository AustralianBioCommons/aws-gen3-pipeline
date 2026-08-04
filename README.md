# Gen3 AWS Data Pipeline

CDK TypeScript project for deploying the Gen3 data pipeline infrastructure on AWS.

This is a **GitHub template repository** (use the *Use this template* button, or —
recommended — generate a private deployment wrapper with the quickstart below),
licensed **Apache-2.0**.

## How configuration works (read this first)

There are exactly two kinds of values:

- **INPUTS** — things a human chooses: account, region, an optional VPC CIDR, the
  GitHub connection, EC2 instance type/AMI, the toolkit version pin, the Gen3
  facts, and any custom Glue jobs. They live in **one file per environment**:
  `config/<projectId>.<env>.json` (schema: `lib/config.ts`). `config/*.json` is
  gitignored in this public repo — real configs are committed in your private
  deployment wrapper (see [docs/WRAPPER_GUIDE.md](docs/WRAPPER_GUIDE.md));
  `docs/example-config.json` is the template to copy.
- **OUTPUTS** — names the CDK *creates* (buckets, Glue DBs, workgroup, jobs, pipelines,
  state machines, the EC2 job box). Nobody authors these. They are derived in one pure
  function — `deriveNames()` in `lib/names.ts` — and **published to SSM Parameter Store**
  on deploy under `/<project>/<env>/…`, where every runtime consumer (the CLI, CodeBuild,
  the EC2 box, Glue) reads them.

```
config/<projectId>.<env>.json  ──►  cdk deploy --all -c env=<env>  ──►  SSM /<project>/<env>/…  ──►  CLI / CodeBuild / EC2 / Glue
     (INPUTS only)            (creates resources +                 (runtime source of truth)
                               publishes OUTPUT names)
```

Naming conventions (pinned by `test/names.test.ts` — changing them is a breaking change
for every SSM consumer):

| Resource class | Pattern | Example |
|---|---|---|
| S3 buckets | `<project>-<env>-<suffix>-<account>-<region>` | `etl-test-metadata-123456789012-ap-southeast-2` |
| Glue databases | `<project>_<env>_<suffix>_db` | `etl_test_raw_silver_db` |
| Everything else | `<project>-<env>-<suffix>` | `etl-test-dbt-test-and-run` |

The SSM tree per env (39 parameters): `meta/*`, `buckets/*`, `glue/db/*`, `athena/*`,
`release/*`, `roles/*`, `codebuild/*`, `codepipeline/*`, `stepfunctions/*`, `ec2/*`,
plus the `app/*` Gen3 facts mirrored for the CLI. `test/ssm-publishing.test.ts` is the
drift guard: every named resource must have a matching SSM parameter or the suite fails.

## Prerequisites

- [Node.js](https://nodejs.org/) (current LTS)
- [AWS CLI](https://aws.amazon.com/cli/) v2, configured with an SSO profile for the target account
- The CDK CLI is a pinned dev-dependency — use `npx cdk ...`; no global install needed

## Quickstart: create your deployment wrapper (recommended)

Adopters deploy from a small **private** wrapper repo that holds only real
config, custom Glue scripts, and a pinned upstream version — never a copy of
this code, so upgrades are a version bump, not a merge.

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/my-gen3-deploy --project myproject --envs test
cd ~/code/my-gen3-deploy
$EDITOR config/myproject.test.json      # fill in real values — field-by-field: docs/CONFIG_GUIDE.md
./deploy.sh --profile <your-profile> --env test --diff   # review; drop --diff to deploy
```

Full guide → [docs/WRAPPER_GUIDE.md](docs/WRAPPER_GUIDE.md)

## Quickstart: deploy from a checkout (contributors/evaluation)

```bash
git clone https://github.com/AustralianBioCommons/aws-gen3-pipeline.git && cd aws-gen3-pipeline
cp docs/example-config.json config/myproject.test.json   # config/*.json is gitignored here
$EDITOR config/myproject.test.json      # field-by-field: docs/CONFIG_GUIDE.md
npm ci && npm test
npx cdk bootstrap --profile <your-profile>               # first time per account+region only
npx cdk diff "*" -c env=test --profile <your-profile>
npx cdk deploy "*" -c env=test --profile <your-profile>
./scripts/integration_test.sh --profile <your-profile> --env test
```

Full guide → [docs/FIRST_TIME_SETUP.md](docs/FIRST_TIME_SETUP.md)

## Quickstart: add a custom Glue job

Deployment-specific python-shell jobs are declared in config — no stack code to edit.

```bash
cp my_job.py glue-scripts/              # in a wrapper: its own glue-scripts/ (overlaid at deploy time)
$EDITOR config/myproject.test.json
#   "customJobs": [{ "key": "myJob", "scriptFile": "my_job.py" }]
npx cdk diff "*" -c env=test --profile <your-profile>    # wrapper: ./deploy.sh ... --diff
npx cdk deploy "*" -c env=test --profile <your-profile>  # wrapper: ./deploy.sh ...
```

Full guide → [docs/CONFIG_GUIDE.md#custom-glue-jobs](docs/CONFIG_GUIDE.md#custom-glue-jobs)

## Quickstart: upgrade a wrapper deployment

```bash
cd ~/code/my-gen3-deploy
echo v1.1.0 > UPSTREAM_VERSION          # read the upstream release notes first
./deploy.sh --profile <your-profile> --env test --diff
./deploy.sh --profile <your-profile> --env test
# rollback = revert the UPSTREAM_VERSION change and deploy again
```

Full guide → [docs/WRAPPER_GUIDE.md#upgrading](docs/WRAPPER_GUIDE.md#upgrading)

## Documentation map

| Doc | Read it when |
|---|---|
| [docs/FIRST_TIME_SETUP.md](docs/FIRST_TIME_SETUP.md) | Standing up a brand-new environment |
| [docs/WRAPPER_GUIDE.md](docs/WRAPPER_GUIDE.md) | Creating, operating, or upgrading a deployment wrapper |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | **Day-to-day: what to run** — the quick guide |
| [docs/OPERATIONS_DETAIL.md](docs/OPERATIONS_DETAIL.md) | Something behaved unexpectedly, or you are changing something structural |
| [docs/DATA_LAYERS.md](docs/DATA_LAYERS.md) | Designing ingestion, or wondering what bronze/silver/gold must contain |
| [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md) | Writing or reviewing a per-env config |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | Deploying, or navigating the stack map |
| [docs/VPC_NETWORKING.md](docs/VPC_NETWORKING.md) | Networking and Gen3 access modes |

## The dbt repo (the CI/CD source)

The pipelines' source repo is always a **dbt repo** — transformation commits trigger
the dbt-test-and-run pipeline and data-release tags trigger the write-release
pipeline. The dbt project lives in its own template repository:
**[AustralianBioCommons/gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)** —
create your project's dbt repo from it, point `repo.fullName` in the env config at
that repo, and grant the CodeConnections GitHub App access to it. Full wiring steps:
the template's README and [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md) (Section 3.3).
The dbt development workflow (seeding bronze, running models, integration
verification) is documented in the template's README.

---

## Useful commands

- `npm run build` — compile TypeScript to JS
- `npm run watch` — watch for changes and compile
- `npm run test` — run the jest unit tests (naming convention + SSM drift guard)
- `npx cdk list -c env=test` — list the stacks for an environment
- `npx cdk synth -c env=test` — emit the synthesized CloudFormation template
- `npx cdk diff -c env=test --profile <p>` — compare deployed stacks with current state
- `npx cdk deploy --all -c env=test --profile <p>` — deploy the whole pipeline for an environment

All of these accept `-c project=<projectId>` too (only needed when `config/` holds
several projects for the same env — unnecessary in a wrapper, which holds one
project's configs).
