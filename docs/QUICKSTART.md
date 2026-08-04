# Quickstart

Short, copy-pasteable paths for the four common tasks. Each links to the full
guide for detail. New to the project? Read the [README](../README.md) first for
what the pipeline is and how configuration works.

## Prerequisites

- [Node.js](https://nodejs.org/) (current LTS)
- [AWS CLI](https://aws.amazon.com/cli/) v2, configured with an SSO profile for the target account
- The CDK CLI is a pinned dev-dependency — use `npx cdk ...`; no global install needed

## Create your deployment wrapper (recommended)

Adopters deploy from a small **private** wrapper repo that holds only real
config, custom Glue scripts, and a pinned upstream version — never a copy of
this code, so upgrades are a version bump, not a merge.

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/my-gen3-deploy --project myproject --envs test
cd ~/code/my-gen3-deploy
$EDITOR config/myproject.test.json      # fill in real values — field-by-field: CONFIG_GUIDE.md
./deploy.sh --profile <your-profile> --env test --diff   # review; drop --diff to deploy
```

Full guide → [WRAPPER_GUIDE.md](WRAPPER_GUIDE.md)

## Deploy from a checkout (contributors/evaluation)

```bash
git clone https://github.com/AustralianBioCommons/aws-gen3-pipeline.git && cd aws-gen3-pipeline
cp docs/example-config.json config/myproject.test.json   # config/*.json is gitignored here
$EDITOR config/myproject.test.json      # field-by-field: CONFIG_GUIDE.md
npm ci && npm test
npx cdk bootstrap --profile <your-profile>               # first time per account+region only
npx cdk diff "*" -c env=test --profile <your-profile>
npx cdk deploy "*" -c env=test --profile <your-profile>
./scripts/integration_test.sh --profile <your-profile> --env test
```

Full guide → [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md)

## Add a custom Glue job

Deployment-specific python-shell jobs are declared in config — no stack code to edit.

```bash
cp my_job.py glue-scripts/              # in a wrapper: its own glue-scripts/ (overlaid at deploy time)
$EDITOR config/myproject.test.json
#   "customJobs": [{ "key": "myJob", "scriptFile": "my_job.py" }]
npx cdk diff "*" -c env=test --profile <your-profile>    # wrapper: ./deploy.sh ... --diff
npx cdk deploy "*" -c env=test --profile <your-profile>  # wrapper: ./deploy.sh ...
```

Full guide → [CONFIG_GUIDE.md#custom-glue-jobs](CONFIG_GUIDE.md#custom-glue-jobs)

## Upgrade a wrapper deployment

```bash
cd ~/code/my-gen3-deploy
echo v1.1.0 > UPSTREAM_VERSION          # read the upstream release notes first
./deploy.sh --profile <your-profile> --env test --diff
./deploy.sh --profile <your-profile> --env test
# rollback = revert the UPSTREAM_VERSION change and deploy again
```

Full guide → [WRAPPER_GUIDE.md#upgrading](WRAPPER_GUIDE.md#upgrading)

## Reference: naming conventions and the SSM tree

Naming conventions (pinned by `test/names.test.ts` — changing them is a breaking change
for every SSM consumer):

| Resource class | Pattern | Example |
|---|---|---|
| S3 buckets | `<project>-<env>-<suffix>-<account>-<region>` | `etl-test-metadata-123456789012-ap-southeast-2` |
| Glue databases | `<project>_<env>_<suffix>_db` | `etl_test_raw_silver_db` |
| Everything else | `<project>-<env>-<suffix>` | `etl-test-dbt-test-and-run` |

The SSM tree per env: `meta/*`, `buckets/*`, `glue/db/*`, `athena/*`, `release/*`,
`roles/*`, `codebuild/*`, `codepipeline/*`, `stepfunctions/*`, `ec2/*`, plus the
`app/*` Gen3 facts mirrored for the CLI. `test/ssm-publishing.test.ts` is the drift
guard: every named resource must have a matching SSM parameter or the suite fails.

## Useful commands

- `npm run build` — compile TypeScript to JS
- `npm run test` — run the jest unit tests (naming convention + SSM drift guard)
- `npx cdk list -c env=test` — list the stacks for an environment
- `npx cdk synth -c env=test` — emit the synthesized CloudFormation template
- `npx cdk diff -c env=test --profile <p>` — compare deployed stacks with current state
- `npx cdk deploy --all -c env=test --profile <p>` — deploy the whole pipeline for an environment

All of these accept `-c project=<projectId>` too (only needed when `config/` holds
several projects for the same env — unnecessary in a wrapper, which holds one
project's configs).
