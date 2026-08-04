"""Glue job: dump every silver table to a validation JSON in S3.

Ported from the legacy pipeline's "Write Validation JSONs" job and reworked
to the performance shape proven there on 2026-07-31: tables export
concurrently with a bounded thread pool, each worker owning its boto3
session/client and Athena writer, and exactly two Athena queries run per
table (the $snapshots lookup and the snapshot-pinned SELECT — the snapshot id
is reused from the writer for the S3 key, never re-queried). Per-table
failures are collected so the job fails at the end naming every failed table.

The legacy script hard-coded every name — here the job receives
--PROJECT_ID/--ENV/--REGION from the CDK (lib/stacks/glue-jobs-stack.ts) and
resolves everything else from the env's SSM tree via the g3dt resolver (the
toolkit is installed by --additional-python-modules).

Reads:  every silver* table in the env's silver Glue DB (dbt temp/lookup
        tables filtered out; study_id derived from the table name).
Writes: s3://<validation-bucket>/validation/study_id=.../validation_id=...
        /table_name=.../snapshot_id=.../<table>.json
        (key layout fixed in g3dt.utils.athena_utils.write_validation_json_to_s3;
        the legacy pipeline wrote to the silver bucket — the greenfield uses
        the dedicated validation bucket).

Environment overrides (optional): VALIDATION_EXPORT_MAX_WORKERS (default 8).
"""
import argparse
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

from g3dt import resolver
from g3dt.utils.athena_utils import (
    AthenaConfig,
    AthenaQuery,
    AthenaValidationWriter,
    generate_validation_id,
    write_validation_json_to_s3,
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

DEFAULT_MAX_WORKERS = 8


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--PROJECT_ID", required=True)
    parser.add_argument("--ENV", required=True)
    parser.add_argument("--REGION", required=True)
    parser.add_argument(
        "--EXCLUDE_TABLES",
        default="",
        help="Comma-separated silver table names to skip (optional).",
    )
    # Glue passes its own --flags (e.g. --job-language); ignore them.
    args, _unknown = parser.parse_known_args()
    return args


def should_export_table(table_name, exclude_tables=()):
    """Return True if a silver table is a validation-export candidate."""
    if not table_name.startswith("silver"):
        return False
    if table_name.endswith("_dbt_tmp"):
        return False
    if "lookup" in table_name:
        return False
    if "_rm_null" in table_name:
        return False
    if "latest_ingest" in table_name:
        return False
    if table_name in exclude_tables:
        return False
    return True


def process_table(config, validation_bucket, validation_id, silver_db, table):
    """Export one silver table's latest snapshot. Thread-safe unit of work.

    Creates its own boto3 session/client and AthenaValidationWriter, runs two
    Athena queries ($snapshots + the pinned SELECT), and writes the JSON to
    S3 reusing the writer's snapshot_id for the key.
    """
    table_name = table["table_name"]
    study_id = table["study_id"]
    logger.info("Processing table '%s' for study '%s'...", table_name, study_id)

    session = boto3.Session(region_name=config.aws_region)
    s3_client = session.client("s3")

    writer = AthenaValidationWriter(config, silver_db, table_name)
    validation_json = writer.construct_json()

    write_validation_json_to_s3(
        s3_bucket=validation_bucket,
        study_id=study_id,
        validation_id=validation_id,
        table_name=table_name,
        snapshot_id=writer.snapshot_id,
        json_data=validation_json,
        s3_client=s3_client,
    )
    logger.info("Wrote validation JSON for table '%s' (study '%s').", table_name, study_id)
    return table_name


def main() -> None:
    args = parse_args()
    rc = resolver.resolve(args.PROJECT_ID, args.ENV, region=args.REGION)
    silver_db = rc.get("glue/db/rawSilver")
    validation_bucket = rc.get("buckets/validation")
    max_workers = int(os.environ.get("VALIDATION_EXPORT_MAX_WORKERS", str(DEFAULT_MAX_WORKERS)))
    logger.info(
        "Resolved from SSM /%s/%s: silver db=%s, validation bucket=%s, workgroup=%s",
        args.PROJECT_ID, args.ENV, silver_db, validation_bucket, rc.athena_workgroup,
    )

    config = AthenaConfig(
        aws_region=rc.region,
        aws_profile=None,
        athena_s3_output=rc.athena_output_location,
        workgroup=rc.athena_workgroup,
    )

    athena_query = AthenaQuery(config)
    validation_id = generate_validation_id()
    table_list = athena_query.list_tables(silver_db)

    exclude_tables = frozenset(
        t.strip() for t in args.EXCLUDE_TABLES.split(",") if t.strip()
    )

    logger.info("Filtering tables in database '%s' for validation candidates...", silver_db)
    tables = [
        {"table_name": t, "study_id": t.split("_")[1]}
        for t in table_list
        if should_export_table(t, exclude_tables)
    ]
    logger.info("Found %d valid table(s) to process.", len(tables))

    failures = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_table = {
            pool.submit(process_table, config, validation_bucket,
                        validation_id, silver_db, t): t
            for t in tables
        }
        for future in as_completed(future_to_table):
            table = future_to_table[future]
            try:
                future.result()
            except Exception as e:
                logger.error("FAILED: %s: %s", table["table_name"], e)
                failures[table["table_name"]] = e

    logger.info("Exported %d/%d tables (validation_id=%s).",
                len(tables) - len(failures), len(tables), validation_id)
    if failures:
        raise RuntimeError(
            f"{len(failures)} table(s) failed validation export: {sorted(failures)}."
        )
    logger.info("All table validations have been written to S3.")


if __name__ == "__main__":
    main()
