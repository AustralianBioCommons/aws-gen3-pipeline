# Gen3 data pipeline — deployment wrapper

Private deployment wrapper for the
[aws-gen3-pipeline](https://github.com/AustralianBioCommons/aws-gen3-pipeline)
template. This repo holds everything specific to **your** deployment — config
with real account IDs, custom Glue job scripts, the pinned upstream version —
and nothing else. Core pipeline code is never committed here: `deploy.sh`
clones the upstream repo at the pinned tag into `.checkout/` (gitignored),
overlays this repo's files, and deploys from there. Because you own no copy of
the core code, your deployment can never diverge from upstream — upgrades are
a version bump, not a merge.

Keep this repo **private**: the files here are exactly the ones that must not
be public.

## Quickstart: first deploy

```bash
# 1. Fill in your environment config (schema: upstream lib/config.ts)
$EDITOR config/<project>.<env>.json

# 2. Log in and bootstrap the CDK (first time per account only)
aws sso login --profile <your-profile>
npx cdk bootstrap aws://<account-id>/<region> --profile <your-profile>

# 3. Review, then deploy
./deploy.sh --profile <your-profile> --env <env> --diff   # review the changes
./deploy.sh --profile <your-profile> --env <env>          # deploy for real
```

Full guide → upstream [`docs/RUNBOOK.md`](https://github.com/AustralianBioCommons/aws-gen3-pipeline/blob/main/docs/RUNBOOK.md)
and [`docs/CONFIG_GUIDE.md`](https://github.com/AustralianBioCommons/aws-gen3-pipeline/blob/main/docs/CONFIG_GUIDE.md).

## Quickstart: add a custom Glue job

```bash
# 1. Drop your python-shell script here
cp my_job.py glue-scripts/

# 2. Declare it in config (name + script location are derived for you)
#    "customJobs": [{ "key": "myJob", "scriptFile": "my_job.py" }]
$EDITOR config/<project>.<env>.json

# 3. Diff, then deploy
./deploy.sh --profile <your-profile> --env <env> --diff
./deploy.sh --profile <your-profile> --env <env>
```

Full guide → upstream [`docs/CONFIG_GUIDE.md`](https://github.com/AustralianBioCommons/aws-gen3-pipeline/blob/main/docs/CONFIG_GUIDE.md#custom-glue-jobs).

## Quickstart: upgrade the pipeline

```bash
# 1. Read the upstream CHANGELOG/release notes for breaking changes, then bump the pin
echo v1.1.0 > UPSTREAM_VERSION

# 2. Review what the new version changes, then deploy
./deploy.sh --profile <your-profile> --env <env> --diff
./deploy.sh --profile <your-profile> --env <env>
```

Roll back by reverting `UPSTREAM_VERSION` and deploying again. Upgrade lower
environments first.

Full guide → upstream [`docs/WRAPPER_GUIDE.md`](https://github.com/AustralianBioCommons/aws-gen3-pipeline/blob/main/docs/WRAPPER_GUIDE.md).

## What lives where

| Path | Purpose |
|---|---|
| `config/<project>.<env>.json` | Real deployment inputs (accounts, ARNs, Gen3 facts, `customJobs`) |
| `glue-scripts/*.py` | Your custom Glue job scripts, overlaid into upstream at deploy time |
| `cdk.context.json` | CDK's cached account lookups — commit it here (it is gitignored upstream) |
| `UPSTREAM_VERSION` | The upstream git tag every deploy uses |
| `deploy.sh` | Clone upstream @ pin → overlay → test → diff → deploy |
| `.checkout/` | Throwaway upstream clone (gitignored, recreated every run) |

Generic improvements belong upstream as pull requests; only
deployment-specific things belong here.
