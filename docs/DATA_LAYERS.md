# Data layers — the contract, and a recommended way to meet it

This platform is deliberately **unopinionated about ingestion** and
**opinionated about what comes out of it**. How raw data reaches the pipeline is
your choice: every project's sources are different, and forcing one ingestion
tool on all of them would be the fastest way to make the platform useless for
the next project.

What the platform does require is a small contract about **where data lands**
and **what shape it is in by the time validation runs**. Everything below the
"Contract" heading is a recommendation you can ignore; the contract itself is
what the deployed infrastructure and the Glue jobs actually depend on.

---

## The three layers

The CDK creates a bucket *and* a Glue database per layer, per environment
(`lib/names.ts`):

| Layer | Bucket | Glue database | Built by | Rebuilt by CI? |
|---|---|---|---|---|
| **Bronze** | `<project>-<env>-bronze-<account>-<region>` | `<project>_<env>_bronze_db` | **you** — any ingestion you like, or dbt-generated (the template's synthetic default) | Only when dbt-managed → `ci_<project>_<env>_bronze_db` |
| **Silver** | `<project>-<env>-silver-<account>-<region>` | `<project>_<env>_silver_db` | dbt | Yes → `ci_<project>_<env>_silver_db` |
| **Gold** | `<project>-<env>-gold-<account>-<region>` | `<project>_<env>_gold_db` | dbt | Yes → `ci_<project>_<env>_gold_db` |

Every layer has a `ci_` twin so commit-triggered CI never writes the release
warehouse (see [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 3 and the
`ci` dbt target). Bronze's twin only sees writes when bronze itself is
dbt-managed — the dbt template's synthetic-data revision generates
deterministic bronze in SQL, which is the recommended starting point for a new
environment. Deployments with real ingestion (Glue jobs, external tools)
simply leave `ci_..._bronze_db` empty, and the boundary still holds:
**externally-ingested bronze is an input to the platform, not a product of it.**

---

## The contract

Three requirements. Everything else is up to you.

### 1. Raw data lands in bronze

Whatever ingestion you use — a Glue job, a Lambda, a manual upload, an external
tool, a `COPY` from another warehouse — the output must end up as tables in the
env's **bronze Glue database**, backed by the bronze bucket.

The platform does not care how they got there, what file format you used on the
way, or whether the process was scheduled or hand-run. It cares that dbt can
`source()` them.

### 2. Silver is built by dbt and is Gen3-shaped

Silver models are where raw source structure becomes **the structure Gen3
expects** — one model per Gen3 node, with the node's properties as columns and
the submitter-id relationships wired up. This is the layer where "our data" turns
into "a Gen3 submission".

Getting this right is what makes the rest of the pipeline work. Validation,
metadata upload, and indexd association all assume silver already looks like
Gen3; none of them will reshape it for you.

### 3. Validation runs off silver

`silver_json_gen3_validator.py` derives its work directly from the silver
database:

```python
silver_db = rc.get("glue/db/silver")
study_id_list = derive_study_ids(AthenaQuery(config), silver_db)
```

It discovers studies from table names matching `silver_<study>_*`, dumps each to
JSON, and validates those JSONs against the Gen3 schema. A green run means
**schema-clean data** — the gate fails the job, and the Step Function, when any
real failures remain.

Two consequences worth stating plainly:

- **Naming is load-bearing.** Tables must be `silver_<study>_<node>` or study
  discovery silently misses them — no error, just a study that never gets
  validated.
- **Validation is not a linter over your source data.** It answers one question:
  *would Gen3 accept this?* If silver is not yet Gen3-shaped, validation failures
  will describe schema violations rather than the modelling problem that caused
  them.

---

## Recommended: how to meet the contract

None of this is enforced. It is the shape that worked, offered so you do not
have to rediscover it.

### Bronze — keep it dumb

Land data **as close to source as practical** and do the thinking in silver.
Bronze tables that already embed business logic are the ones nobody can re-derive
when the source changes.

- One bronze table per source file or feed, named for the source, not the target.
- Prefer Iceberg or Parquet over CSV so schema and types survive.
- Re-ingest should be idempotent: re-running the same input should not double the
  rows. (This is the same class of bug as the indexd duplicate-registration issue
  in [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) section 8 — additive-by-default
  pipelines quietly double their corpus on a re-run.)
- Keep the raw file in the bronze **bucket** even when the table is what you
  query. It is the only artifact that can settle an argument about what arrived.

### Silver — one model per Gen3 node

- Name models `silver_<study>_<node>` — study discovery depends on it.
- One model per Gen3 node type, columns named exactly as the dictionary's
  properties.
- Populate `submitter_id` and the parent-node references; these are what Gen3
  uses to link records, and what the import order in `DataImportOrder.txt`
  traverses.
- Do the joins, renames, unit conversions and vocabulary mapping here. If a
  transformation needs explaining, it belongs in silver with a comment, not
  hidden in bronze.
- Run validation locally against a branch build before tagging a release — CI
  builds silver into the `ci_` database, so you can validate without touching
  the warehouse.

### Gold — release and export shape

Gold is what gets exported to release JSONs and uploaded to Gen3. In practice it
is silver plus the things only known at release time: the `object_id` from the
indexd registry joined onto file nodes, and any per-release trimming.

Keep the indexd join here rather than in silver, so a re-registration does not
force a silver rebuild.

---

## The supported ingestion path: gen3-metadata-templates

If you have no ingestion pipeline of your own — the common case for a new
project — this is the path to use. It needs no data engineering at all.

```
g3mt generate <schema> <node> -o template.xlsx     a researcher gets a workbook
        ...fill it in Excel (dropdowns, guidance)...
g3mt validate template.xlsx --schema <schema>      optional, catches errors early
aws s3 cp template.xlsx s3://<bronze-bucket>/submissions/<study_id>/
        │
        ▼  Glue job  <project>-<env>-ingest-metadata-templates
        │
<project>_<env>_bronze_db . bronze_<study_id>_<node>       one table per node sheet
```

[`gen3-metadata-templates`](https://github.com/AustralianBioCommons/gen3-metadata-templates)
(`pipx install gen3-metadata-templates`) turns a Gen3 schema into an Excel
workbook with **one sheet per node on the path to your target**, in fill order,
with parent links and controlled values as **dropdowns** — so most submission
errors cannot be made in the first place.

### Depositing

The study id is the **first path segment** under the scanned prefix:

```
s3://<project>-<env>-bronze-<account>-<region>/submissions/<study_id>/<anything>.xlsx
                                                   └ prefix ─┘ └ study ─┘
```

Then run the job (from the console, a schedule, or an S3 event — the CDK
creates it; wiring a trigger is your choice):

| Argument | Default | Purpose |
|---|---|---|
| `--S3_PREFIX` | `submissions` | Prefix under the bronze bucket to scan |
| `--STUDY` | all | Ingest only one study id |
| `--DRY_RUN` | `false` | Parse and report without writing |

### What the job relies on

The workbook layout is fixed by `g3mt`, so nothing is guessed:

- The **`_g3mt` sheet** carries provenance (`g3mt_version`, `schema_file`,
  `target_node`, `path`) and an explicit **node → sheet map**. That map is the
  authoritative list of data sheets, so `Instructions`, `Dictionary` and
  `_lists` are never ingested and no exclusion list can drift.
- **Row 1 is headers, row 2 is the type/required hint row, data starts at row
  3.** Row 2 is dropped — otherwise every table gains a junk record reading
  `string — required`.
- `g3mt generate` provisions blank rows (5000 by default); empty rows are
  discarded.
- A workbook with no `_g3mt` sheet is **rejected**, not guessed at.

### What lands in bronze

One Iceberg table per node sheet, `bronze_<study_id>_<node>`, with values
exactly as typed — multi-value cells are not split, enums are not checked, links
are not resolved. That is silver's job (see the contract above). Each row also
carries provenance so it can be traced to its origin:

| Column | Meaning |
|---|---|
| `_src_file` | the S3 URI of the workbook |
| `_src_sheet` / `_src_row` | the sheet and **spreadsheet row number** it came from |
| `_src_study_id` | study id from the S3 path |
| `_src_g3mt_version` / `_src_schema_file` / `_src_target_node` | what generated the workbook |
| `_src_ingested_at` | UTC ingest timestamp |
| `row_hash` | stable row identity — see below |

The `_src` prefix cannot collide with a Gen3 property, since no Gen3 property
starts with an underscore.

### Re-depositing is a no-op

`row_hash` covers the cell values **plus** the source file, sheet and row, and
the write is a MERGE on that hash. Re-uploading an unchanged workbook rewrites
the same rows rather than appending a second copy; editing a cell produces a new
hash, so corrections land as new rows and the original stays traceable.

Including the coordinates in the hash is deliberate: two genuinely different
rows carrying identical values (a repeated measurement) stay distinct. Making
the ingest idempotent from the start is a direct lesson from the legacy
pipeline, where an additive-by-default registration silently doubled its corpus
the first time it was re-run.

---

## Ingestion tools — provided, but optional

The platform ships ingestion helpers so you do not have to start from nothing.
They live in the toolkit as **`g3dt.ingest`** and are importable from any Glue
job, EC2 job, or local script:

```python
from g3dt.ingest.ingest import (
    get_ingest_true_files,      # list objects under a prefix, honouring an S3 tag filter
    read_csv_robust,            # encoding/delimiter sniffing, ragged-row tolerant
    read_json_robust,
    read_xlsx_robust,           # multi-sheet -> dict of frames (needs openpyxl)
    flatten_xlsx_dict,          # ... then one frame, sheet name preserved as a column
    align_and_combine_frames,   # union frames with differing columns
    prepare_ingest_metadata,    # provenance columns: source uri, tags, row hash, ingest time
    compute_row_hash,           # stable row identity, for idempotent re-ingest
    normalise,                  # column names -> snake_case, Athena-safe
)
```

**Using them is entirely optional.** They exist because most projects hit the
same handful of problems — inconsistent encodings, Excel workbooks with one
sheet per table, files that must be filtered by S3 tag, needing to know which
source file a row came from. If your sources do not have those problems, ignore
the module and write your own job. The contract above is what matters; how you
satisfy it is not inspected. The S3 `ingest=true` tag contract these helpers
honour is documented in the toolkit's `docs/INGEST.md`.

The template's `scripts/seed_bronze.py` is a working end-to-end example: it
creates synthetic bronze tables that the shipped silver models build on, so a
freshly deployed environment has something to run before any real data arrives.

### The toolkit's copy is behind the monolith

`g3dt/ingest/ingest.py` was split from the legacy monolith on 2026-07-15 and has
not tracked the fixes made since. Missing, in rough order of value:

| Gap | What it does | Legacy commit |
|---|---|---|
| `ingest_table_to_dataset` / `ingest_files_to_dataset` | The two top-level entry points. g3dt only has the older `*_to_parquet_dataset` forms, so **writing bronze as Iceberg is not reachable from the toolkit at all** | `cc64b47` |
| `table_format` flag | Selects Parquet or Iceberg per call (17 references in the monolith, 0 in g3dt) | `cc64b47` |
| Parallel S3 tag scan | `get_ingest_true_files(..., max_workers=32)` — the tag lookup is per-object and serial in g3dt | `21fdbee` |
| `openpyxl>=3.1.0` runtime pin | xlsx reading exists in g3dt but the dependency is undeclared, so it fails at runtime rather than at install | `2d0b4ce` |

(The commit hashes refer to the legacy private repo the toolkit was split from.)
Porting these is mechanical — the module is otherwise near-identical — and it
is the difference between "bronze can be Iceberg" and "bronze is Parquet only".

### One practice worth carrying across

The legacy pipeline's ingest once had a **missing comma in a Python exclude list**, which
silently un-excluded two tables, and the deployed Glue script had been edited in
the console away from the repo — so the deployed behaviour and the reviewed
behaviour had quietly diverged. Whatever ingestion you build, **keep the
deployed artifact generated from the repo** (as `glue-scripts/` is here), so a
console edit cannot become the real behaviour.

## See also

- [OPERATIONS_DETAIL.md](OPERATIONS_DETAIL.md) — CI/release isolation, the
  validation gate, and known gaps
- [CONFIG_GUIDE.md](CONFIG_GUIDE.md) — every INPUT field, including the Gen3 facts
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — deploy workflow and stack map
