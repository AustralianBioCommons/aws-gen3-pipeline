# Deployment Wrapper Guide

The recommended way to run this pipeline in production is from a small
**private deployment wrapper** repo — not from a fork or checkout of this one.
This guide covers creating a wrapper, operating it day to day, and upgrading
it. The quickstarts live in [QUICKSTART.md](QUICKSTART.md); this is the detail
behind them.

## What a deployment wrapper is, and why

A wrapper is a tiny private repo holding **only** what is specific to your
deployment:

| Path | Purpose |
|---|---|
| `config/<project>.<env>.json` | Real deployment inputs (accounts, ARNs, Gen3 facts, `customJobs`) — schema: [`../lib/config.ts`](../lib/config.ts) |
| `glue-scripts/*.py` | Your custom Glue job scripts, overlaid into upstream at deploy time |
| `cdk.context.json` | CDK's cached account lookups — commit it here (it is gitignored upstream) |
| `UPSTREAM_VERSION` | The upstream git tag every deploy uses |
| `deploy.sh` | Clone upstream @ pin → overlay → test → diff → deploy |
| `.checkout/` | Throwaway upstream clone (gitignored, recreated every run) |

That shape is the whole point: real IDs stay in a private repo, you own no
core code so you can never diverge, and upgrades are a one-line version bump
(rollback: revert the line — see [Upgrading](#upgrading)). The full reasoning:
[CONCEPTS.md section 3](CONCEPTS.md#3-the-deployment-wrapper--deploy-without-forking).

## Creating a wrapper

Scaffold it from any checkout of this repo:

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/<project>-pipeline-deploy --project <project> --envs test,prod
```

(The `/tmp/g3p` clone is a throwaway — it only supplies the script and the
template. If the script errors with `no upstream tag found`, the shallow
clone's branch tip isn't tagged; pass `--upstream-version vX.Y.Z` explicitly.)

`init-wrapper.sh` flags:

| Flag | Meaning |
|---|---|
| `<target-dir>` | Directory to create (must not already exist) |
| `--project <id>` | Your projectId (lower-case, e.g. `myproject`) |
| `--envs <e>[,<e>...]` | Environments to seed configs for (e.g. `test,prod`) |
| `--upstream-version vX.Y.Z` | Upstream tag to pin (default: the latest tag of the checkout you ran it from) |

What gets seeded:

- everything in [`../wrapper-template/`](../wrapper-template/) — `deploy.sh`,
  a README with the wrapper quickstarts, `.gitignore`, empty `config/` and
  `glue-scripts/` directories;
- `UPSTREAM_VERSION` containing the pinned tag;
- one `config/<project>.<env>.json` per `--envs` entry, copied from
  [`example-config.json`](example-config.json) with `projectId` and
  `environment` pre-set so the filename cross-check passes — every other field
  still needs real values ([CONFIG_GUIDE.md](CONFIG_GUIDE.md) is the
  field-by-field manual);
- an initial git commit on `main`.

Then fill in the configs and push — to a **private** repo:

```bash
cd ~/code/<project>-pipeline-deploy
$EDITOR config/<project>.<env>.json
gh repo create <org>/<project>-pipeline-deploy --private --source . --push
```

> **Never make the wrapper a fork of this repo.** GitHub forks of public
> repositories **cannot be made private** — a forked wrapper would publish
> your account IDs and ARNs to the world. Always create a fresh private repo
> and push the scaffolded directory to it (as above).

First deploy from the wrapper (details for bootstrap and the post-deploy
steps: [RUNBOOK.md](RUNBOOK.md)):

```bash
aws sso login --profile <your-profile>
npx cdk bootstrap aws://<account-id>/<region> --profile <your-profile>   # once per account+region
./deploy.sh --profile <your-profile> --env test --diff
./deploy.sh --profile <your-profile> --env test
```

## Day-2 operations

Every deploy is the same command. `deploy.sh` clones upstream at the pin into
`.checkout/`, removes any upstream demo configs, overlays your `config/*.json`,
`glue-scripts/*.py`, and `cdk.context.json`, then runs `npm ci`, `npm test`,
`cdk diff`, and (after a confirmation prompt) `cdk deploy "*"`. A failing
upstream test suite stops the deploy — that is deliberate.

```
./deploy.sh --profile <aws-profile> --env <env> [--project <id>] [--diff] [--yes]
```

| Flag | Meaning |
|---|---|
| `--profile` | AWS profile to deploy with (required) |
| `--env` | Environment matching `config/<project>.<env>.json` (required) |
| `--project` | Project id, only needed if `config/` holds several projects |
| `--diff` | Stop after `cdk diff` — nothing is deployed. Run this first, always |
| `--yes` | Skip the interactive confirmation before deploy (CI) |

Environment overrides, for testing wrapper changes against an unreleased or
local upstream:

| Variable | Meaning |
|---|---|
| `UPSTREAM_REPO` | Git URL **or local path** to clone instead of the public pipeline repo |
| `UPSTREAM_REF` | Git ref to clone instead of the contents of `UPSTREAM_VERSION` |

```bash
# e.g. diff your config against a local upstream branch before it is tagged:
UPSTREAM_REPO=~/code/aws-gen3-pipeline UPSTREAM_REF=my-branch \
  ./deploy.sh --profile <your-profile> --env test --diff
```

Real deploys should never need the overrides — if you find yourself deploying
from an untagged ref in anger, the change you need belongs upstream as a PR
and a release.

## Custom Glue scripts: the overlay

Custom jobs are declared in config (`customJobs` — schema and field reference:
[`../lib/config.ts`](../lib/config.ts) `CustomGlueJobConfig`,
[CONFIG_GUIDE.md](CONFIG_GUIDE.md#custom-glue-jobs)) and their scripts live in
the wrapper's `glue-scripts/`:

```bash
cp my_job.py glue-scripts/
$EDITOR config/<project>.<env>.json
#   "customJobs": [{ "key": "myJob", "scriptFile": "my_job.py" }]
./deploy.sh --profile <your-profile> --env <env> --diff
```

Overlay semantics, and the two guard rails around them:

- At deploy time your `glue-scripts/*.py` are **copied into** the upstream
  clone's `glue-scripts/` — added alongside the built-in scripts, never
  replacing the directory. (Matching a built-in filename overwrites that
  built-in script; don't, unless that is exactly what you mean.)
- The whole merged directory deploys to `s3://<metadata-bucket>/scripts/` on
  every deploy with **`prune: true`**: a script you delete or rename in the
  wrapper is **deleted from S3** on the next deploy. Nothing lingers — which
  also means an out-of-band script uploaded to that prefix by hand will be
  pruned. Everything under `scripts/` must come from a `glue-scripts/`
  directory.
- **Missing scripts fail at synth, not at runtime.** Every job in config —
  built-in or custom — must have its script present in the merged
  `glue-scripts/` or `cdk synth` throws
  (`Glue job "<key>" needs glue-scripts/<file>, which does not exist`). A
  typo'd `scriptFile` is caught before anything deploys.

One IAM note, by design: the Step Functions execution role is automatically
granted `glue:StartJobRun` (and job-run read/stop) on **every** job derived
from config — built-in and custom alike. Declaring a custom job is consenting
to the pipeline's state machines being able to run it; there is no extra IAM
step, and no way to opt a job out short of not declaring it.

## Upgrading

Environment by environment, lowest first:

```bash
# 1. Read the upstream release notes for the target tag — breaking changes
#    (naming, SSM tree, config schema) are called out there.
echo v1.1.0 > UPSTREAM_VERSION

# 2. Diff against the lowest environment; read the diff, really.
./deploy.sh --profile <your-profile> --env test --diff

# 3. Deploy it, verify, then repeat per environment.
./deploy.sh --profile <your-profile> --env test
.checkout/scripts/integration_test.sh --profile <your-profile> --env test
git add UPSTREAM_VERSION && git commit -m "chore: upgrade upstream to v1.1.0"

# Later, prod — same pin, same commands:
./deploy.sh --profile <your-prod-profile> --env prod --diff
./deploy.sh --profile <your-prod-profile> --env prod
```

**Rollback is reverting the pin:**

```bash
git revert <the-bump-commit>          # or: echo v1.0.0 > UPSTREAM_VERSION
./deploy.sh --profile <your-profile> --env <env> --diff
./deploy.sh --profile <your-profile> --env <env>
```

Because the wrapper holds no core code, that is the entire rollback — no
merge to unwind. (CloudFormation state moves backwards with the deploy;
stateful resources like bucket *contents* are untouched either way.)

## What belongs upstream vs in the wrapper

| Change | Where it goes |
|---|---|
| Account IDs, ARNs, AMIs, Gen3 facts, `customJobs` declarations | Wrapper `config/` |
| Deployment-specific Glue job scripts | Wrapper `glue-scripts/` |
| A new config field, stack change, or naming fix anyone could use | **Upstream, as a PR** to this repo |
| A fix to `deploy.sh` / the wrapper scaffold | **Upstream**, in [`../wrapper-template/`](../wrapper-template/) — every future wrapper gets it |

The dividing line: if a second adopter would want it, it is not
deployment-specific — send it upstream, get it released, and pick it up with
a version bump. The wrapper's `deploy.sh` is intentionally dumb for the same
reason: logic added there is versioned and tested for one deployment; logic
added upstream is versioned and tested for all of them.

## Related docs

| Doc | What it's for |
|---|---|
| [../README.md](../README.md) | What the pipeline is and the config model |
| [CONCEPTS.md](CONCEPTS.md) | Why the wrapper (and everything else) is shaped the way it is |
| [QUICKSTART.md](QUICKSTART.md) | The minimal end-to-end setup path |
| [RUNBOOK.md](RUNBOOK.md) | The full setup path: tools, AWS SSO, bootstrap, deploy, post-deploy steps, first release |
| [CONFIG_GUIDE.md](CONFIG_GUIDE.md) | Authoring the per-env config, field by field |
| [../wrapper-template/README.md](../wrapper-template/README.md) | The README every wrapper is born with (its quickstarts) |
