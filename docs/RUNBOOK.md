# End-to-end setup runbook

Stand up a complete Gen3 data pipeline from nothing: this repo (the CDK
infrastructure), your dbt repo (from
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)),
and the [`gen3-dataops-toolkit`](https://pypi.org/project/gen3-dataops-toolkit/)
CLI — ending with a running warehouse, a validated synthetic dataset, and a
versioned data-release folder in the gold bucket.

This runbook is the *ordered path*; each step links to the reference doc that
owns the detail. It was written by walking the whole process on a live test
environment, so the troubleshooting section at the end is real, not
speculative.

**Version pairing** (the three components move together — see each repo's
release notes):

| Component | This runbook assumes |
|---|---|
| aws-gen3-pipeline | ≥ v2.2.0 |
| gen3-dataops-toolkit | ≥ 3.2.0 |
| gen3-dbt-template | silver-generators revision or later |

Throughout, replace `myproject` / `test` / `<account-id>` / `<your-profile>`
with your values. Every derived name follows the conventions in
[QUICKSTART.md](QUICKSTART.md#reference-naming-conventions-and-the-ssm-tree).

---

## 0. Prerequisites

- An AWS account for the environment, with admin-ish deploy rights via an
  **SSO profile** (`aws configure sso`; the walkthrough in
  [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) covers this). Log in before any
  AWS step and expect to re-login daily:

  ```bash
  aws sso login --profile <your-profile>
  ```

- [Node.js](https://nodejs.org/) (current LTS) and the
  [AWS CLI](https://aws.amazon.com/cli/) v2. The CDK CLI is a pinned
  dev-dependency of this repo — always `npx cdk`, never a global install.
- Python 3.11+ with `pipx` (for the CLI toolkit).
- A GitHub org/account to hold two private repos: your **deployment wrapper**
  and your **dbt repo**.

## 1. Create your two repos

### 1a. The deployment wrapper (holds your real config — keep it PRIVATE)

```bash
git clone --depth 1 https://github.com/AustralianBioCommons/aws-gen3-pipeline.git /tmp/g3p
/tmp/g3p/scripts/init-wrapper.sh ~/code/myproject-pipeline-deploy --project myproject --envs test
cd ~/code/myproject-pipeline-deploy
# create a PRIVATE GitHub repo and push this directory to it
```

The wrapper never holds pipeline code: `deploy.sh` clones this repo at the tag
pinned in `UPSTREAM_VERSION`, overlays your config, and deploys. Full concept:
[WRAPPER_GUIDE.md](WRAPPER_GUIDE.md).

### 1b. The dbt repo (drives silver and gold)

Create your repo from the
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template)
(GitHub → *Use this template*, or clone + push). Out of the box its
`silver_synth1_*` models **generate deterministic synthetic data in SQL** —
`dbt build` alone produces a whole warehouse, so you can prove the pipeline
end-to-end before any real data exists. Bronze is never written by dbt; it is
the landing zone for your real ingestion later
([DATA_LAYERS.md](DATA_LAYERS.md)).

## 2. AWS prerequisites the config will reference

1. **CodeConnections (GitHub) connection** — lets CodePipeline watch your dbt
   repo. Console → Developer Tools → Connections → Create connection → GitHub
   → authorise → note the ARN. Grant the GitHub App access to your dbt repo
   specifically.
2. **Gen3 API-key secret** *(deferrable)* — metadata upload/indexd/
   check-download need a Secrets Manager secret holding a Gen3 API key JSON,
   named `<project>_<env>_gen3_api_key.json` by convention. The pipeline
   deploys fine without it; the integration test will WARN until it exists.
3. **An AMI id** for the EC2 job box (current Amazon Linux 2023 in your
   region):

   ```bash
   aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
     --query Parameter.Value --output text --profile <your-profile>
   ```

## 3. Fill in the config

Edit `config/myproject.test.json` in the wrapper (seeded from
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

```bash
cd ~/code/myproject-pipeline-deploy
npx cdk bootstrap aws://<account-id>/<region> --profile <your-profile>   # once per account+region
./deploy.sh --profile <your-profile> --env test --diff                   # review all 12 stacks
./deploy.sh --profile <your-profile> --env test                          # ~10-15 min first time
```

Then prove it with the integration suite (from the wrapper's `.checkout/`):

```bash
./.checkout/scripts/integration_test.sh --profile <your-profile> --env test
```

Expect all PASS with one WARN (the API-key secret, if deferred). A green
`cdk deploy` only proves resources were *created*; the integration suite
proves they *work* ([FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) explains each
check).

## 5. Configure the CLI toolkit

```bash
pipx install gen3-dataops-toolkit
mkdir -p ~/.g3dt && cat > ~/.g3dt/g3dt.yaml <<EOF
project: myproject
region: <region>
default_env: test
profiles:
  test: <your-profile>
EOF

g3dt config show --env test        # every derived name, resolved live from SSM
g3dt config diff --env test --file ~/code/myproject-pipeline-deploy/config/myproject.test.json
                                   # exits 1 on drift — usable as a CI gate
```

The toolkit needs AWS credentials and nothing else: every name comes from the
SSM tree the deploy published. If `config show` errors about missing app
facts, the deploy has not run (or ran an older pipeline version than the
toolkit expects — check the version pairing table above).

## 6. Stage the default test dictionary

The validation Glue job downloads its Gen3 schema from `gen3.schemaS3Uri`
(config → SSM `app/schema_s3_uri` → S3). With no commons of your own, use the
official public Gen3 dictionary, copied into the pipeline's own metadata
bucket so the Glue role can read it:

```bash
curl -s https://s3.amazonaws.com/dictionary-artifacts/datadictionary/develop/schema.json \
  -o /tmp/schema.json

# WORKAROUND (until gen3_validator resolves $refs file-aware): strip the
# documentation-only `term`/`terms` reference blocks — validation semantics
# are unchanged, but the resolver otherwise crashes on refs into _terms.yaml.
python3 - <<'EOF'
import json
s = json.load(open("/tmp/schema.json"))
def strip(n):
    if isinstance(n, dict):
        for k in ("term", "terms"):
            if k in n and isinstance(n[k], (dict, list)):
                del n[k]
        for v in n.values(): strip(v)
    elif isinstance(n, list):
        for v in n: strip(v)
strip(s)
json.dump(s, open("/tmp/schema.json", "w"))
EOF

aws s3 cp /tmp/schema.json \
  s3://myproject-test-metadata-<account-id>-<region>/schema/gen3_datadictionary_develop.json \
  --profile <your-profile>
```

Set `gen3.schemaS3Uri` to
`myproject-test-metadata-<account-id>-<region>/schema/gen3_datadictionary_develop.json`
and `gen3.dictionaryVersion` to `develop` in the wrapper config, then
redeploy (`./deploy.sh … --diff` → deploy) so SSM mirrors the new values.

The template's synthetic chain (`project → experiment → case → demographic`)
validates green against this dictionary.

## 7. First dbt build (CI)

Push anything to your dbt repo's main branch. The commit triggers the
`<project>-<env>-dbt-test-and-run` CodePipeline, which runs `dbt build` with
the `ci` target — everything lands in the isolated `ci_*` databases, never
the real warehouse:

```bash
g3dt pipeline status --env test --which dbtTestAndRun
g3dt pipeline logs   --env test --which dbtTestAndRun --follow
```

Green means: synthetic silver + gold built in `ci_myproject_test_silver_db` /
`ci_..._gold_db` and all schema tests passed.

## 8. Cut a data release

Releases are tags, never branches:

```bash
cd <your-dbt-repo>
git tag data-v0.1.0 && git push origin data-v0.1.0
```

This triggers the `<project>-<env>-dbt-write-release-info` pipeline, which:
1. **Waits for any in-progress CI build** (the wait-gate — you'll see
   "Checking for in-progress … builds" in its log; a WARNING about IAM there
   means the pipeline deploy is incomplete).
2. Runs `dbt build` with the default target → the **real**
   `myproject_test_silver_db` / `_gold_db`.
3. Writes one row per model to the `releases` ledger
   (`myproject_test_dataops_metadata_db.releases`), pinning each model's
   Iceberg snapshot to the tag.

When the release pipeline completes, the **write-release-jsons Step Function
runs automatically** — do not start it by hand right after a release (the
Glue job allows one concurrent run; a manual start just fails with
`ConcurrentRunsExceededException` while the automatic one succeeds).

## 9. Validate

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:<region>:<account-id>:stateMachine:myproject-test-validation \
  --profile <your-profile>
```

The validation state machine dumps every silver table to JSON, validates each
record against the dictionary from step 6, writes results to
`myproject_test_validation_db.full_validation_results`, and **fails the
execution if real errors remain** — a green run *means* schema-clean data,
not just that the machinery ran. On a red run:

```sql
SELECT node, validation_error, count(*) FROM myproject_test_validation_db.full_validation_results
WHERE validation_id = (SELECT max(validation_id) FROM myproject_test_validation_db.full_validation_results)
  AND validation_error IS NOT NULL
GROUP BY 1, 2 ORDER BY 3 DESC
```

Fix the data (or models), re-release, re-run. Operator loop detail:
[OPERATIONS.md](OPERATIONS.md).

## 10. The end state — a versioned release folder

After steps 8–9 the gold bucket holds the deployable artifact:

```
s3://myproject-test-gold-<account-id>-<region>/release_jsons/v0.1.0/synth1/
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
# via Athena, workgroup myproject-test
SELECT count(*) FROM myproject_test_silver_db.silver_synth1_case;
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
   g3dt metadata upload --study mystudy --env test
   g3dt indexd register --s3-paths s3://<bucket>/<study>/ --study mystudy --env test
   g3dt indexd check-download --env test        # Indexd → DRS → signed URL, exits non-zero on failure
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
| Any AWS call: `Token has expired and refresh failed` | SSO session expired — `aws sso login --profile <p>` |
| Validation job: `KeyError` inside `gen3_validator.resolve_schema` | Dictionary has `term`/`terms` refs into `_terms.yaml` (the official one does) — apply the strip in step 6 |
| Validation fails listing a "study" per node with empty JSON filenames later | Model names missing the study segment — use `<layer>_<study>_<node>` |
| `write-release-jsons` fails with `ConcurrentRunsExceededException` right after a release | It auto-runs post-release; your manual start collided with it. Check the newest execution — the automatic one likely SUCCEEDED |
| dbt test errors `ICEBERG_MISSING_METADATA` after changing a model's materialization | Switching an existing Iceberg relation (e.g. incremental → table) can strand its metadata pointer — drop the old Glue table(s) and rebuild |
| Release build log: `WARNING: cannot query … builds (missing IAM permission?)` | The CI wait-gate is degrading to a no-op — the pipeline deploy providing `WaitOnCiBuilds` hasn't landed; redeploy |
| CI green but a laptop `dbt build` targets weird names | You skipped `eval "$(g3dt config dbt-env --env <env>)"` — the `env_var()` defaults only fit the reference environment |
| `g3dt` errors: missing app fact(s) / missing medallion SSM key | Pipeline not deployed, or toolkit major ahead of the pipeline version — see the pairing table at the top |
| Integration suite: parameter-count mismatch | Wrapper `UPSTREAM_VERSION` and the deployed stack disagree — diff + deploy, then rerun |
