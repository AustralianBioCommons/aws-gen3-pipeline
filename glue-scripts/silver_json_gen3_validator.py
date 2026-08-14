"""Glue job: validate the dumped silver JSONs against the Gen3 schema.

Ported from the legacy pipeline's "Silver Json Gen3_Validator" job and
reworked to the shape proven there on 2026-07-31 (requires toolkit >= 2.2.0):

* Loop-invariants are hoisted out of the per-study loop — one schema
  download + resolution and ONE listing of the validation prefix (which
  grows with run history) instead of one of each per study.
* The per-study Iceberg writes are batched into a single INSERT at the end.
* After the results land, a **validation gate** queries the latest
  validation_id for REAL failures (known-noise error patterns and synthetic
  studies excluded) and FAILS this job — and therefore the validation Step
  Function — when any remain. A green validation run means schema-clean
  data; the operator loop is: gate fails -> inspect the results table
  -> fix the source data -> re-run until green.

Configuration is name-free: every name resolves from the env's SSM tree
(--PROJECT_ID/--ENV/--REGION injected by the CDK) and queries run in the
env's Athena workgroup. The study list is derived from the silver DB's table
names (the same silver_<study>_* convention write_validation_jsons.py uses).

--DB_TARGET selects which warehouse to validate, and must match the value the
previous job ran with. `real` (the default) validates the real silver DB and
writes `full_validation_results` — runbook step 9, run on demand after a
release. `ci` validates the ci_-prefixed silver DB that the dbt `ci` target
builds and writes `ci_full_validation_results`, so the commit-triggered CI
pipeline grades exactly what it just built.

The two targets never share a results table. The gate selects the run with the
greatest validation_id, so a shared table would let a CI run silently grade a
release check (or the reverse) purely on which happened to run last.

Reads:  s3://<validation-bucket>/<prefix>/... (the JSONs the previous job
        wrote — `validation` for real, `ci_validation` for CI) and the Gen3
        schema at gen3.schemaS3Uri.
Writes: <results-table>.csv beside the JSONs, and the <results-table> Iceberg
        table in the env's validation Glue DB.
"""
import argparse
import logging
import sys

import pandas as pd

from g3dt import resolver
from g3dt.utils.athena_utils import AthenaConfig, AthenaQuery, write_iceberg_to_db
from g3dt.validate.validate import (
    create_metadata_table,
    load_and_resolve_schema,
    run_validation_gate,
    validate_pipeline,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(
    logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
)
if logger.hasHandlers():
    logger.handlers.clear()
logger.addHandler(handler)


# CI isolation. The dbt `ci` target prefixes every database with ci_
# (gen3-dbt-template macros/generate_schema_name.sql), so a CI validation run
# has to read those databases and keep its artifacts away from the real
# warehouse's. Keep this table byte-for-byte in step with the same block in
# write_validation_jsons.py: Glue python-shell jobs each get exactly one file,
# so there is nowhere shared to put it.
DB_TARGETS = {
    "real": {
        "silver_key": "glue/db/silver",
        "key_prefix": "validation",
        "results_table": "full_validation_results",
    },
    "ci": {
        "silver_key": "glue/db/ciSilver",
        "key_prefix": "ci_validation",
        "results_table": "ci_full_validation_results",
    },
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--PROJECT_ID", required=True)
    parser.add_argument("--ENV", required=True)
    parser.add_argument("--REGION", required=True)
    parser.add_argument(
        "--DB_TARGET",
        default="real",
        choices=sorted(DB_TARGETS),
        help="Which warehouse to validate: 'real' (default) or 'ci'. Must "
             "match what write_validation_jsons.py ran with.",
    )
    args, _unknown = parser.parse_known_args()
    return args


def derive_study_ids(athena_query: AthenaQuery, silver_db: str) -> list:
    """Unique study ids from silver_<study>_* table names (same filters as
    write_validation_jsons.py, so the two jobs always agree on the studies)."""
    studies = []
    for table_name in athena_query.list_tables(silver_db):
        if not table_name.startswith("silver"):
            continue
        if table_name.endswith("_dbt_tmp"):
            continue
        if "lookup" in table_name or "_rm_null" in table_name or "latest_ingest" in table_name:
            continue
        study = table_name.split("_")[1]
        if study and study not in studies:
            studies.append(study)
    return studies


def main() -> None:
    args = parse_args()
    rc = resolver.resolve(args.PROJECT_ID, args.ENV, region=args.REGION)

    target = DB_TARGETS[args.DB_TARGET]
    silver_db = rc.get(target["silver_key"])
    results_table = target["results_table"]
    validation_bucket = rc.get("buckets/validation")
    validation_db = rc.get("glue/db/validation")
    # SSM stores schemaS3Uri in bucket/key form (no scheme) — see CONFIG_GUIDE.
    schema_s3_uri = f"s3://{rc.app('schema_s3_uri')}"
    validation_root = f"s3://{validation_bucket}/{target['key_prefix']}/"

    logger.info(
        "Resolved from SSM /%s/%s (DB_TARGET=%s): silver db=%s, validation "
        "root=%s, validation db=%s, results table=%s, schema=%s",
        args.PROJECT_ID, args.ENV, args.DB_TARGET, silver_db, validation_root,
        validation_db, results_table, schema_s3_uri,
    )

    config = AthenaConfig(
        aws_region=rc.region,
        aws_profile=None,
        athena_s3_output=rc.athena_output_location,
        workgroup=rc.athena_workgroup,
    )
    study_id_list = derive_study_ids(AthenaQuery(config), silver_db)
    logger.info("Derived %d study id(s) from %s: %s", len(study_id_list), silver_db, study_id_list)

    if not study_id_list:
        # Nothing to validate, so nothing gets written — and the gate below
        # would then query a table that does not exist yet (it is created by
        # the first Iceberg write, never by CDK: a CFN Glue table makes
        # Athena's Iceberg engine reject it, see glue-catalog-stack.ts).
        # Returning here keeps that from surfacing as a bare TABLE_NOT_FOUND,
        # which reads like a broken deployment rather than an empty one.
        logger.warning(
            "NOTHING TO VALIDATE: no studies derived from %s, so nothing was "
            "written and the gate is skipped (%s.%s is created by the first "
            "write, not by CDK, so it may not exist yet). This run proves the "
            "machinery works, NOT that any data is schema-clean. Build the "
            "dbt project, then re-run this Step Function for a real result.",
            silver_db, validation_db, results_table,
        )
        return

    # Hoisted loop-invariants: one schema download + resolution, one full
    # listing of the validation prefix — previously repeated per study.
    schema, schema_resolver = load_and_resolve_schema(schema_s3_uri)
    metadata_table = pd.DataFrame(create_metadata_table(validation_root))
    logger.info("Metadata table created from S3 (%s rows).", len(metadata_table))

    results_frames = []
    failures = {}
    for study_id in study_id_list:
        logger.info("Processing study_id: %s", study_id)
        try:
            df = validate_pipeline(
                study_id=study_id,
                schema_s3_uri=schema_s3_uri,
                validation_s3_uri=validation_root,
                write_back_root=validation_root,
                glue_database=validation_db,
                athena_s3_output=rc.athena_output_location,
                workgroup=rc.athena_workgroup,
                root_node="subject",
                schema=schema,
                resolver=schema_resolver,
                metadata_table=metadata_table,
                write_iceberg=False,   # batched into one INSERT below
            )
            results_frames.append(df)
        except Exception as e:
            logger.error("Validation FAILED for study '%s': %s", study_id, e)
            failures[study_id] = e

    if results_frames:
        combined = pd.concat(results_frames, ignore_index=True)
        logger.info(
            "Writing combined validation results (%s rows, %s studies) to Iceberg.",
            len(combined), len(results_frames),
        )
        write_iceberg_to_db(
            df=combined,
            database=validation_db,
            table=results_table,
            athena_s3_output=rc.athena_output_location,
            workgroup=rc.athena_workgroup,
            # Required on first creation of the Iceberg table (a fresh env's
            # validation DB starts empty); ignored once the table exists.
            # Scoped by table name so the real and CI tables never share a
            # data location.
            table_location=f"s3://{validation_bucket}/iceberg/{results_table}/",
        )

    if failures:
        raise RuntimeError(
            f"Validation failed for {len(failures)} study(ies): {sorted(failures)}."
        )

    # Quality gate: any REAL failures in the run just written fail this job —
    # and the validation Step Function — until the data is fixed.
    gate_df = run_validation_gate(
        validation_db, rc.athena_output_location,
        aws_region=rc.region, workgroup=rc.athena_workgroup,
        results_table=results_table,
    )
    if len(gate_df) > 0:
        logger.error(
            "VALIDATION GATE FAILED — %s distinct failure signature(s) in the "
            "latest validation run:\n%s",
            len(gate_df), gate_df.to_string(index=False),
        )
        raise RuntimeError(
            f"Validation gate failed: {len(gate_df)} distinct failure signature(s) "
            f"across studies {sorted(gate_df['study_id'].unique())}. "
            f"Query {validation_db}.{results_table} for the latest "
            "validation_id, fix the offending data, and re-run the validation "
            "Step Function until this gate passes."
        )
    logger.info("Validation gate PASSED — no real failures in the latest run.")
    logger.info("Validation complete for all studies.")


if __name__ == "__main__":
    main()
