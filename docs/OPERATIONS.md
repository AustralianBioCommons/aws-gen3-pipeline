# Operating the pipeline — the quick guide

Everything you do week to week, in the order you will need it. Each section is
the short version; when you need to know *why* something behaves the way it
does, or what to do when it breaks, follow the link into
[OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md).

**Setting up for the first time?** Do [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md)
first — this guide assumes an environment already exists.

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
and vice versa. See [DATA_LAYERS.md](DATA_LAYERS.md) for the layer contract.

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
Gen3 schema. Run the validation Step Function, then:

- **Green** = schema-clean data, safe to release.
- **Red** = the gate found real failures. Query `full_validation_results` for
  the latest `validation_id`, fix the source data, re-run until green.

The gate deliberately fails the job rather than warning, so a green run means
something. Known-noise patterns and synthetic studies are excluded.

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
| Validation fails and you cannot tell why | `full_validation_results`, latest `validation_id` |
| A release exported stale data | [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 5 |
| A Glue job runs old code after a fix | The toolkit-pin coupling — [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 5 |
| `502` on `/wts/external_oidc/` | Credential/commons mismatch, not a broken link — [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 2 |
| Downloads `401` although records exist | Authz gap: the key's user lacks `read-storage` |

---

## See also

- [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) — mechanisms, failure modes, and why
- [DATA_LAYERS.md](DATA_LAYERS.md) — the bronze/silver/gold contract
- [CONFIG_GUIDE.md](CONFIG_GUIDE.md) / [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)
