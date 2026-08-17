# Operating the pipeline — the quick guide

Everything you do week to week, in the order you will need it. Each section is
the short version; when you need to know *why* something behaves the way it
does, or what to do when it breaks, follow the link into
[OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md).

**Setting up for the first time?** Do [QUICKSTART.md](QUICKSTART.md) (or the
fully-explained [RUNBOOK.md](RUNBOOK.md)) first — this guide assumes an
environment already exists.

> Everywhere below, substitute your project and environment for `myproject` / `test`.
> Every command is `g3dt`, the toolkit CLI, installed from PyPI and pinned per
> environment by `toolkitVersion` in the CDK config.

---

## 0. The one-minute mental model

```
   your ingestion  ─►  BRONZE  ─►  dbt  ─►  SILVER  ─►  dbt  ─►  GOLD  ─►  release JSONs  ─►  Gen3
   (yours to choose)              (CI + release)      (Gen3-shaped)                (versioned)
                                        │
                                        └─►  validation Step Function (must be green)
```

Two independent lifecycles run over that:

- **Software releases** (`v*` tags) ship the toolkit and the CDK.
- **Data releases** (`data-v*` tags) ship a versioned snapshot of the warehouse.

They are deliberately decoupled — a data release does not require a code change,
and vice versa. See [DATA_LAYERS.md](DATA_LAYERS.md) for the layer contract and
[CONCEPTS.md](CONCEPTS.md) for the fuller version of this mental model.

---

## 1. Before you touch anything

```bash
g3dt config show --env test          # what names am I actually pointed at?
g3dt config diff --env test          # does SSM match the committed config?
g3dt jobs list                       # is anything already running?
```

`config diff` **exits 1 on drift**, so it is safe to put in CI. Get into the
habit of running the first two before any upload, delete, or release — reading
the resolved names aloud has caught more mistakes than any guard.

---

## 2. Load data into bronze

Ingestion is yours to design; the platform only requires the result lands in the
env's bronze database. The toolkit ships optional helpers
(`g3dt.ingest`) if you want them — see
[DATA_LAYERS.md](DATA_LAYERS.md#ingestion-tools--provided-but-optional).

**The supported no-code path** — for projects without their own pipeline:
generate an Excel template with `g3mt`, have a researcher fill it in, drop it in
S3, and run the ingest job:

```bash
g3mt generate <schema> sample -o sample_template.xlsx    # ...fill it in...
aws s3 cp sample_template.xlsx s3://<bronze-bucket>/submissions/<study_id>/
# then run the <project>-<env>-ingest-metadata-templates Glue job
```

One bronze table per node sheet, and re-depositing the same workbook is a no-op.
Full detail in [DATA_LAYERS.md](DATA_LAYERS.md#the-supported-ingestion-path-gen3-metadata-templates).

For a brand-new environment with no real data yet, the dbt template's silver
models generate deterministic synthetic data (`dbt build` alone — bronze stays
empty), so you can exercise the whole pipeline immediately.

> **The synth models target the stock Gen3 dictionary.** They emit nodes named
> `case` and `experiment`. If your dictionary renames or omits those — omix3,
> for instance, uses `subject` and has no `experiment` — validation will report
> `node '<name>' not found in resolved schema` until you rename the models to
> match. That is a real finding, not a broken environment: it is the same check
> that protects your production data.

---

## 3. Build silver and gold

Push to your dbt repo. The commit-triggered pipeline runs `dbt build` into the
**`ci_` databases**, never the real warehouse:

```bash
g3dt pipeline status --env test --which dbtTestAndRun
g3dt pipeline logs   --env test --which dbtTestAndRun --follow
```

To build locally against the real databases:

```bash
eval "$(g3dt config dbt-env --env test)"    # exports G3DT_* for profiles.yml
dbt build
```

---

## 4. Validate

Validation reads **silver**, dumps each study to JSON, and checks it against the
Gen3 schema. It runs against one of two warehouses, and there is a separate
Step Function for each:

| Machine | Reads | Writes | Driven by |
|---|---|---|---|
| `<project>-<env>-validation-ci` | `ci_<…>_silver_db` | `ci_full_validation_results` | the CI pipeline, on every push |
| `<project>-<env>-validation` | `<…>_silver_db` | `full_validation_results` | you, on demand after a release |

CI validates what CI built. The dbt `ci` target writes only `ci_*` databases, so
the commit-triggered machine grades that build; the real machine grades the
warehouse a release promoted. The two never share a results table — the gate
picks the greatest `validation_id`, so a shared table would let a CI run
silently grade a release check.

Either way:

- **Green** = schema-clean data, safe to release.
- **Red** = the gate found real failures. Query the run's results table for the
  latest `validation_id`, fix the source data, re-run until green.

Every run writes at least one row, and the write happens **before** the job
fails — so the results table, not the Glue log, is where you look first. Rows
come in three kinds:

| `validation_result` | Meaning | Gated? |
|---|---|---|
| `FAIL` | A value violated the node's schema — a bad enum, a missing required field | Yes |
| `ERROR` | The record could not be checked at all. Usually its `type` names a node your dictionary does not define | Yes — nothing was verified, which is worse than a known violation |
| `PASS` | Marker written when a study is clean. One row per study, no findings attached | No |

The PASS marker is load-bearing, not cosmetic. The gate grades the greatest
`validation_id`, so a clean run that wrote nothing would leave the previous
*failing* run as the latest and the gate could never go green however many
times you fixed the data.

The gate deliberately fails the job rather than warning, so a green run means
something. Known-noise patterns and studies matching `%synthetic%` are excluded
— note that a study named `synth1` does **not** match, and is gated normally.

Which findings block a release is a project decision, and the gate's defaults
will not suit everyone. To change them, overlay your own
`silver_json_gen3_validator.py` — see
[WRAPPER_GUIDE.md](WRAPPER_GUIDE.md#replacing-a-built-in-script), which covers
the three invariants a replacement gate query must preserve.

The usual loop is: push → CI validates `ci_*` → read `ci_full_validation_results`
→ fix the models → push again. Cut the release once that is green.

---

## 5. Cut a data release

```bash
# 1. Make sure CI is green and finished first — see the caveat in section 5 of
#    OPERATIONS_DETAIL.md about the release build racing CI.
# 2. Bump the DATA version, commit, then tag:
git tag data-v1.5.4 && git push origin data-v1.5.4
```

The release pipeline builds dbt against the **real** warehouse, writes the
release manifest (pinning each model's Iceberg snapshot), then exports the
release JSONs.

```bash
g3dt pipeline status --env test --which writeReleaseInfo
```

---

## 6. Register files with indexd

```bash
g3dt indexd register --s3-paths s3://bucket/study/ --study mystudy --env test
```

Then **prove the files actually download** before shipping links to anyone.
Registration succeeding does not mean a user can fetch the file — that needs
`read-storage` on the record's authz resource, a separate grant. Verify with
`g3dt indexd check-download` (toolkit >= 2.3.0; the interpretation table for
its results is in the toolkit README). Background in
[OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 8.

---

## 7. Upload metadata to Gen3

```bash
g3dt metadata upload      --study mystudy --env test           # one study
g3dt metadata upload-all  --studies "a,b,c" --env test         # sequential, one job
```

Long jobs belong on the EC2 box — add `--on ec2`, then watch:

```bash
g3dt jobs list
g3dt jobs logs <run-id> --follow
```

Confirmation prompts always happen **locally, before dispatch** — SSM has no
TTY, so a remote prompt would hang forever.

---

## 8. Delete metadata (destructive)

```bash
g3dt delete metadata --studies mystudy --env test --version 0.9.8
g3dt delete metadata --studies mystudy --env test --version all   # always prompts
```

Every delete confirms. Production requires typing the target exactly, even with
`--yes`, and `all` always prompts regardless.

> **Two traps that look like success.** A version that matches nothing is
> reported as *skipped*, not as an error — so a mistyped version reads as a
> clean run. And `g3dt` does not yet strip a leading `v`, so `v1.5.4` matches
> zero rows every time. Pass `1.5.4`. Both are covered in
> [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 7.

---

## 9. The EC2 job box

```bash
g3dt ec2 up --env test --wait      # waits for SSM to come online
g3dt ec2 status --env test
g3dt ec2 down --env test
```

One box serves the environment. Check `g3dt jobs list` before dispatching —
nothing else should be in progress.

---

## 10. When something breaks

| Symptom | Start here |
|---|---|
| Names look wrong / commands hit the wrong resource | `g3dt config show`, then `g3dt config diff` |
| A dbt build wrote to the wrong database | [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 3 |
| Validation fails and you cannot tell why | the run's results table (`ci_full_validation_results` from CI, `full_validation_results` from step 9), latest `validation_id` |
| `TABLE_NOT_FOUND: ... full_validation_results does not exist` | Nothing has been validated into that table yet — it is created by the first Iceberg write, never by CDK. Check the previous Glue job's log for `NOTHING TO VALIDATE`, and confirm the silver DB for that target actually has tables |
| `node '<name>' not found in resolved schema` (an `ERROR` row) | Your models emit a node your dictionary does not define. Rename the model, or add the node to the dictionary. Common straight after scaffolding from the dbt template — see the caveat in section 2 |
| A release exported stale data | [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 5 |
| A Glue job runs old code after a fix | The toolkit-pin coupling — [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 5 |
| `502` on `/wts/external_oidc/` | Credential/commons mismatch, not a broken link — [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 2 |
| Downloads `401` although records exist | Authz gap: the key's user lacks `read-storage` |

---

## See also

- [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) — mechanisms, failure modes, and why
- [DATA_LAYERS.md](DATA_LAYERS.md) — the bronze/silver/gold contract
- [CONFIG_GUIDE.md](CONFIG_GUIDE.md) / [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)
