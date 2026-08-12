# AWS Gen3 Pipeline

[![CI](https://github.com/AustralianBioCommons/aws-gen3-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/AustralianBioCommons/aws-gen3-pipeline/actions/workflows/ci.yml)

**A production data pipeline for [Gen3](https://gen3.org/) data commons, deployed to
your AWS account with one command.** It takes research metadata from "a spreadsheet a
researcher filled in" to "validated, versioned, queryable data the commons can serve" —
with every step automated, auditable, and reproducible.

Deploy it by generating a small private **deployment wrapper** (your config, nothing
else) and running `./deploy.sh` — see the **[Quickstart](docs/QUICKSTART.md)**.

## The problem this solves

A Gen3 data commons is only as useful as the metadata behind it, and getting that
metadata in is genuinely hard:

- Researchers submit study metadata as spreadsheets, which must be checked against the
  commons' **data dictionary** (the schema defining what a valid subject, sample, or
  file record looks like) before anything can be published.
- Raw submissions need cleaning and reshaping — while keeping the original, the
  cleaned version, and the published version separate and traceable.
- The portal must never see half-finished data: releases have to be **versioned,
  validated snapshots**, not whatever the tables happened to contain that day.
- Doing all this with ad-hoc scripts and manual uploads works exactly until the first
  mistake, and leaves no audit trail.

This repo deploys the automated alternative: a **bronze → silver → gold lakehouse**
with a hard validation gate and a tagged-release workflow, so publishing data to a
commons becomes a reviewed, repeatable engineering process.

## What it deploys

Twelve CDK stacks (TypeScript), which together provide:

| Capability | AWS services |
|---|---|
| **Lakehouse storage** — bronze (raw, as-submitted), silver (cleaned), gold (publishable) as Iceberg tables | S3, Glue Data Catalog |
| **Ingestion** — metadata-template workbooks deposited to S3 become bronze tables with row-level provenance; re-uploads are no-ops | Glue python-shell jobs |
| **Transformation CI/CD** — your dbt repo drives silver/gold; commits build into isolated `ci_` databases, never the real warehouse | CodePipeline, CodeBuild |
| **Validation gate** — records are rendered to Gen3-shaped JSON and checked against the dictionary; the run **fails** if real errors remain, so green = schema-clean | Step Functions, Glue |
| **Data releases** — pushing a `data-v*` tag writes a versioned entry to a release ledger and emits structured release JSONs for the Gen3 deployment | CodePipeline, Step Functions |
| **Interactive SQL** — every layer queryable in its own workgroup | Athena |
| **Job box** — an auto-stopping EC2 instance for long-running CLI dispatch | EC2, SSM |
| **Zero name drift** — every created resource name is published to Parameter Store; runtime tooling reads names from there, never from checked-out code | SSM Parameter Store |
| **Networking** — its own VPC; reaches internet-facing commons out of the box, or peers into a VPN-secured Gen3 VPC | VPC, peering |

(Architecture diagram and the ideas behind each piece:
[docs/CONCEPTS.md](docs/CONCEPTS.md).)

Configuration follows one rule: humans author **inputs** in a single JSON file per
environment; every resource **name** is an **output**, derived and published to SSM —
nobody ever types a bucket name twice. The why:
[docs/CONCEPTS.md](docs/CONCEPTS.md#4-configuration-inputs-outputs-and-what-ssm-achieves);
the fields: [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md).

## What using it looks like

Once deployed, a normal week on the pipeline:

1. **A study team submits metadata.** They fill in a
   [gen3-metadata-templates](https://github.com/AustralianBioCommons/gen3-metadata-templates)
   workbook and drop it in the bronze bucket. The ingest Glue job turns each sheet
   into a bronze table — original values untouched, provenance on every row.
2. **An engineer evolves the models.** They push to the project's dbt repo (created
   from [gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template));
   CI builds and tests the models in isolated `ci_` databases; merging builds the real
   silver and gold tables.
3. **Validation gates the release.** The validation state machine checks every
   generated record against the data dictionary and fails loudly on real errors — a
   green run *means* the data is schema-clean, not just that the machinery ran.
4. **A release is cut.** Tagging the dbt repo `data-v1.2.0` writes a versioned
   snapshot to the release ledger and produces the structured release JSONs the Gen3
   deployment consumes. Rolling back is pointing at the previous version.
5. **Anyone with access explores in Athena** — at every layer, the whole time:
   `SELECT * FROM myproject_test_gold_db.subject`.

## The CLI toolkit

The pipeline is operated with **`gen3-dataops-toolkit`** (`g3dt`, on PyPI). It reads
everything it needs from the SSM parameters the pipeline publishes, so it requires AWS
credentials and nothing else — no repo checkout, no config files. A taste:

```bash
pipx install gen3-dataops-toolkit

g3dt config show --env test                     # what names am I actually pointed at?
g3dt dict pull && g3dt dict upload --env test   # deploy a data-dictionary version

g3mt generate <schema> sample -o template.xlsx  # sample metadata workbook (g3mt:
                                                #   pipx install gen3-metadata-templates)
aws s3 cp template.xlsx s3://<bronze-bucket>/submissions/<study_id>/
                                                # ...then run the ingest Glue job

g3dt metadata upload --study mystudy --env test # upload study metadata to the commons
g3dt indexd register --s3-paths s3://bucket/study/ --study mystudy --env test

g3dt jobs list                                  # what's running right now?
g3dt pipeline status --env test --which dbtTestAndRun
g3dt ec2 up --env test --wait                   # start the job box
```

For a brand-new environment with no real data yet, the dbt template's silver
models generate deterministic synthetic data in SQL — a plain `dbt build`
produces the whole warehouse (bronze stays empty; it is the ingest target),
so you can exercise the pipeline end-to-end on day one. Day-to-day operations
live in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Deploying it

This is a **GitHub template repository**, licensed **Apache-2.0**. The recommended
path is a private deployment wrapper — a tiny repo holding only your config and custom
Glue jobs, pinned to a released version of this code — so upgrading is a version bump
and your account IDs never touch a public repo.

The documentation is three tiers deep — understand it, deploy it fast, or follow
every step — backed by reference guides:

| Doc | Read it when |
|---|---|
| [docs/CONCEPTS.md](docs/CONCEPTS.md) | **Understand it** — what each piece is for, what problems the design solves, glossary |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | **The fastest working deploy** — nothing to a validated release, minimal ceremony |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | **Every step, explained** — the same journey in full detail, with checks and troubleshooting |
| [docs/WRAPPER_GUIDE.md](docs/WRAPPER_GUIDE.md) | Creating, operating, or upgrading a deployment wrapper |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | **Day-to-day: what to run** — the quick guide |
| [docs/OPERATIONS_DETAIL.md](docs/OPERATIONS_DETAIL.md) | Something behaved unexpectedly, or you are changing something structural |
| [docs/DATA_LAYERS.md](docs/DATA_LAYERS.md) | Designing ingestion, or wondering what bronze/silver/gold must contain |
| [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md) | Writing or reviewing a per-env config |
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | Contributing, or navigating the stack map |
| [docs/VPC_NETWORKING.md](docs/VPC_NETWORKING.md) | Networking and Gen3 access modes |

The transformation side lives in its own template —
[gen3-dbt-template](https://github.com/AustralianBioCommons/gen3-dbt-template):
create your project's dbt repo from it and point `repo.fullName` in your env config at
that repo (wiring: [docs/CONFIG_GUIDE.md](docs/CONFIG_GUIDE.md), Section 3.3).

Generic improvements are welcome upstream — see [CONTRIBUTING.md](CONTRIBUTING.md).
Deployment-specific things belong in your wrapper.
