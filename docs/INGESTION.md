# Ingesting metadata-template submissions — from workbook to bronze

The end-to-end task guide for the supported no-code ingestion path: a
researcher fills a [gen3-metadata-templates](https://github.com/AustralianBioCommons/gen3-metadata-templates)
Excel workbook, someone deposits it in S3, and the
`<project>-<env>-ingest-metadata-templates` Glue job turns it into
append-only bronze Iceberg tables. This doc is the *how*: a workable example
on the stock defaults, launching the job, and exactly how its parameters
decide what tables get created. The *what* — the layer contract, what bronze
rows contain, why bronze is append-only — lives in
[DATA_LAYERS.md](DATA_LAYERS.md).

Placeholders follow [RUNBOOK.md](RUNBOOK.md)'s conventions (`<project>` =
`myproject`, `<env>` = `test`, `<your-profile>` = `myproject_test`, study =
`synth1`).

The shape of the whole path:

```
g3mt generate <schema> <node> -o template.xlsx     a researcher gets a workbook
        ...fill it in Excel (dropdowns, guidance)...
g3mt validate template.xlsx -s <schema>            optional, catches errors early
aws s3 cp template.xlsx s3://<bronze-bucket>/submissions/<study_id>/
        │
        ▼  Glue job  <project>-<env>-ingest-metadata-templates
        │
<project>_<env>_bronze_db . bronze_<study_id>_<node>       one table per node sheet
```

---

## How the job finds workbooks

There is no registration step and no configured file list — everything is
resolved at run time, by convention. The job is handed only
`--PROJECT_ID/--ENV/--REGION` (baked in as CDK default arguments), and then:

1. **Bucket from SSM.** It resolves the env's parameter tree
   (`/{project}/{env}/*`) via the g3dt resolver and reads `buckets/bronze` —
   that is the bucket it scans.
2. **Prefix by convention.** It lists everything under
   `s3://<bronze-bucket>/submissions/` recursively (`submissions` is just the
   `--S3_PREFIX` default), keeping every `*.xlsx` and skipping Excel `~$`
   lockfiles.
3. **Study from the key.** The **first path segment** under the prefix is the
   study id — it names the bronze tables:

   ```
   s3://<project>-<env>-bronze-<account-id>-<region>/submissions/<study_id>/<anything>.xlsx
                                                         └ prefix ─┘ └ study ─┘
   ```

   A workbook dropped directly at the prefix root (no study folder) is not an
   error — it lands under a study literally called `unassigned`.
4. **Sheets from the workbook itself.** Inside each file, the hidden `_g3mt`
   sheet's node → sheet map says which sheets are data and which node each one
   becomes (`bronze_<study_id>_<node>`) — no node list lives in config.

So depositing is the whole handover: drop a `.xlsx` under
`submissions/<study_id>/`, then run the job.

---

## Worked example on the defaults

**What this achieves:** three real bronze tables (`bronze_synth1_subject`,
`bronze_synth1_site`, `bronze_synth1_sample`) from one workbook, using only
the names a stock deployment derives. Every command below was run for real
against the public omix3 dictionary.

**1. Install the template tool** (on your laptop, not the pipeline):

```bash
pipx install gen3-metadata-templates    # provides `g3mt`
```

**2. Generate a workbook from your deployed dictionary.** Use the same
dictionary your env is configured with — the config's `gen3.*` fields compose
its URL as
`<dictionaryBaseUrl>/<schemaRepo>/refs/tags/<dictionaryVersion>/<dictionaryPath>`.
This example uses a real public bundle (the omix3 v1.3.0 dictionary), target
node `sample`:

```bash
SCHEMA=https://raw.githubusercontent.com/GUARDIANS-infrastructure/omix3schemadev/refs/tags/v1.3.0/dictionary/prod_dict/omix3_schema.json

g3mt generate "$SCHEMA" sample --path sample=2 -o sample_submission.xlsx
# -> Wrote sample_submission.xlsx  (3 sheet(s): subject -> site -> sample)
```

`--path sample=2` picks the subject → site → sample route — when a node is
reachable more than one way, `g3mt` lists the numbered options and asks.
One sheet per node on the path, tab order = fill order, parent links and
controlled values as dropdowns.

> The **official public Gen3 dictionary**
> (`s3.amazonaws.com/dictionary-artifacts/datadictionary/develop/schema.json`,
> the one RUNBOOK step 6 stages for validation) currently does **not** load in
> `g3mt` — its `_terms.yaml` is missing refs the resolver needs (see
> Troubleshooting). Use your project's own dictionary bundle, as you would in
> production anyway.

**3. Fill it in Excel.** Row 1 is headers, row 2 is the type/required hints,
data starts at row 3. Parent links are `<node>.submitter_id` columns fed by
dropdowns from the parent sheet, so fill parents first — e.g. two subjects,
one site, three samples pointing at them. Full filling guidance lives in
[g3mt's own docs](https://github.com/AustralianBioCommons/gen3-metadata-templates/blob/main/docs/filling-templates.md).

**4. Validate before depositing** (optional but cheap — catches type, enum
and broken-link errors on your laptop instead of in a Glue log):

```bash
g3mt validate sample_submission.xlsx -s "$SCHEMA"
# -> All good — validated 6 record(s), no problems found.
```

**5. Deposit under a study folder:**

```bash
aws s3 cp sample_submission.xlsx \
  s3://<project>-<env>-bronze-<account-id>-<region>/submissions/synth1/ \
  --profile <your-profile>
```

**Check:** `aws s3 ls s3://<project>-<env>-bronze-<account-id>-<region>/submissions/synth1/`
lists the workbook. The study folder name — `synth1` — is now part of every
table name this workbook will create.

---

## Launching the job

The job is created by the CDK but never triggered automatically — no
schedule, no S3 event (wiring one is your choice). Start it from the CLI:

```bash
# Rehearsal: parse everything, report what WOULD land, write nothing
aws glue start-job-run \
  --job-name <project>-<env>-ingest-metadata-templates \
  --arguments '{"--STUDY":"synth1","--DRY_RUN":"true"}' \
  --profile <your-profile>

# The real run
aws glue start-job-run \
  --job-name <project>-<env>-ingest-metadata-templates \
  --arguments '{"--STUDY":"synth1"}' \
  --profile <your-profile>
```

Or from the console: **AWS Glue → ETL jobs →
`<project>-<env>-ingest-metadata-templates` → Run** (set the same arguments
under *Job parameters* — keys include the `--`).

Watch a run (`start-job-run` returns the `JobRunId`):

```bash
aws glue get-job-run \
  --job-name <project>-<env>-ingest-metadata-templates \
  --run-id <jr_...> --profile <your-profile> \
  --query 'JobRun.{State:JobRunState,Error:ErrorMessage}'
```

Logs land in CloudWatch under `/aws-glue/python-jobs/output` (progress: one
`Writing N row(s) to <db>.<table>` line per table, then
`Ingest complete: N bronze table(s) written.`) and
`/aws-glue/python-jobs/error` (tracebacks), stream named by the run id.
Expect roughly a minute of dependency install before the first log line, then
a few seconds per table.

---

## What parameters create what tables

Every bronze table is named `bronze_<study_id>_<node>` inside
`<project>_<env>_bronze_db`. The **node** part comes from the workbook's
`_g3mt` sheet map (sheets with no filled rows are skipped); the **study**
part comes from the S3 folder. The arguments only change *which workbooks are
scanned* — never the naming formula:

| Argument | Default | Effect on what gets created |
|---|---|---|
| `--STUDY` | all | Only workbooks under `submissions/<study>/` are ingested — only `bronze_<study>_*` tables are touched |
| `--S3_PREFIX` | `submissions` | Scan a different prefix; study is still the first folder under it |
| `--S3_BUCKET` | the env's bronze bucket (SSM) | Scan a different bucket (needs an IAM grant — next section). Writes still land in the bronze bucket |
| `--DRY_RUN` | `false` | `true` parses and logs what *would* land; **zero tables created or written** |
| `--JOB_RUN_ID` | generated | Only sets the `_src_batch_id` stamp on rows; never affects table names |

Worked scenarios, assuming workbooks under `submissions/synth1/` and
`submissions/pilot2/`:

- **No arguments** — both studies ingest: `bronze_synth1_*` and
  `bronze_pilot2_*` tables are created/appended in one run.
- **`--STUDY synth1`** — only `bronze_synth1_*`; `pilot2` files are listed
  but skipped.
- **A workbook at `submissions/` root** (no study folder) — it ingests under
  the literal study `unassigned`: tables named `bronze_unassigned_<node>`.
  Almost always a mis-deposit; move the file into a study folder and re-run.
- **The example workbook above** — three tables, because its `_g3mt` map has
  three node sheets: `bronze_synth1_subject`, `bronze_synth1_site`,
  `bronze_synth1_sample`.

Re-running the same job on the same files **appends a second batch** of
identical rows (new `_src_batch_id`, same `row_hash`) — bronze is append-only
by design, and deduplication belongs to bronze→silver promotion. The contract
and rationale: [DATA_LAYERS.md](DATA_LAYERS.md#bronze-is-append-only-silver-dedups-on-row_hash).

---

## Verify in Athena

Workgroup `<project>-<env>`:

```sql
SELECT count(*) FROM <project>_<env>_bronze_db.bronze_synth1_sample;
-- -> the number of filled rows on the sample sheet

SELECT DISTINCT _src_batch_id, _src_ingested_at
FROM <project>_<env>_bronze_db.bronze_synth1_sample;
-- -> one batch per job run that saw this workbook
```

Column names are the workbook headers, Athena-sanitized: link columns land as
`subject_submitter_id`, not `subject.submitter_id` (dots are illegal in
Athena). Every row also carries `_src_file`/`_src_sheet`/`_src_row` and the
rest of the provenance set — the full column reference is in
[DATA_LAYERS.md](DATA_LAYERS.md#what-lands-in-bronze).

From here the data enters the normal flow: point your dbt sources at the
bronze tables ([RUNBOOK.md section 11](RUNBOOK.md#11-when-real-data-arrives)),
dedup with the dbt template's `dedupe_bronze` macro, and build silver.

---

## Pointing ingestion at a different bucket or prefix

Both the deposit location and the scan are adjustable per run, but they differ
in what else has to change:

- **A different prefix** (same bronze bucket) needs nothing beyond passing the
  matching `--S3_PREFIX` at run time. The Glue ETL role's grant covers the
  whole bronze bucket, so any prefix inside it is already readable.
- **A different bucket** (`--S3_BUCKET`) is a config change: the Glue ETL
  role is granted S3 access **only** to the six buckets the pipeline owns
  (bronze/silver/gold/metadata/validation/athena-results), so a scan of any
  other bucket fails with `AccessDenied`. Declare the external bucket in the
  env config's **`dataReceiveBuckets`** list and redeploy:

  ```jsonc
  "dataReceiveBuckets": [
      "myproject-data-receive-bucket"
  ]
  ```

  Each listed bucket is granted **read-only** to the Glue ETL role —
  `s3:ListBucket`, `s3:GetBucketLocation`, `s3:GetObject`, and
  `s3:GetObjectTagging` (tag-driven ingest discovery reads object tags).
  The pipeline never writes to or deletes from a receive bucket; a test pins
  the grant to read-only actions. See
  [CONFIG_GUIDE.md section 3.9](CONFIG_GUIDE.md#39-datareceivebuckets--data-receive-buckets-optional).
  A bucket in **another account** additionally needs its own bucket policy to
  allow this role (deterministic name: `<project>-<env>-glue-etl-role`) — the
  config grant is only the identity-policy half.

  Note the write side never moves: bronze tables always land in the env's
  bronze bucket and `<project>_<env>_bronze_db`, whatever was scanned.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no '_g3mt' sheet — this workbook was not generated by g3mt` | Hand-built or stripped workbook; the job refuses to guess layouts. Regenerate with `g3mt generate` and paste the data in |
| `No .xlsx workbooks found. Nothing to do.` | Wrong prefix or bucket for this run, or the file lacks an `.xlsx` extension — check `--S3_PREFIX`/`--S3_BUCKET` against where you deposited |
| Tables appear under `bronze_unassigned_*` | Workbook deposited at the prefix root instead of `submissions/<study>/` — move it and re-run |
| `AccessDenied` listing or reading with `--S3_BUCKET` | The Glue ETL role has no grant for that bucket — add it to `dataReceiveBuckets` and redeploy (previous section); a cross-account bucket also needs its own bucket policy |
| `g3mt` cannot load the official public Gen3 dictionary (`Missing key 'file_format' … _terms.yaml`) | Known gap: that bundle's `_terms.yaml` lacks refs the resolver needs. Generate from your project's own dictionary bundle instead |
| `QueryFailed: Duplicate column name: submitter_id` | Ingest script older than v3.4.1 (dotted link headers) — bump the wrapper's `UPSTREAM_VERSION` and redeploy |
| Row counts multiply per batch after re-runs (2×/3× copies of old batches) | Ingest script older than v3.4.2 (staging-path reuse) — bump and redeploy, then `DELETE` the duplicate batches |
| Job stuck ~1 min with no output | Normal: python-shell installs its dependency set before the script starts |

---

## See also

- [DATA_LAYERS.md](DATA_LAYERS.md) — the layer contract: what bronze rows
  contain, provenance columns, append-only semantics
- [OPERATIONS.md section 2](OPERATIONS.md#2-load-data-into-bronze) — the
  day-to-day short version
- [RUNBOOK.md section 11](RUNBOOK.md#11-when-real-data-arrives) — wiring dbt
  sources over the new bronze tables
- [gen3-metadata-templates docs](https://github.com/AustralianBioCommons/gen3-metadata-templates/tree/main/docs)
  — generating, filling and validating workbooks in depth
- [WRAPPER_GUIDE.md](WRAPPER_GUIDE.md) — wrappers ship
  `scripts/upload_submission.sh`, which uploads and prints these launch
  commands with your env's real names filled in
