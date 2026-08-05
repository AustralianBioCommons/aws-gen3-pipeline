"""Glue job: export the latest data release's gold tables to JSON in S3.

Ported from the legacy pipeline's "write_data_release_to_json" job and
reworked to the performance shape proven there on 2026-07-31: models export
concurrently with a bounded thread pool, each gold table is queried AT ITS
PINNED ICEBERG SNAPSHOT (the ledger's snapshot_id — requires toolkit >= 2.2.0,
whose construct_json honours a pre-set pin), the DataImportOrder is computed
once and written once per study prefix, and per-table failures are collected
so the job fails at the end naming every failed table.

Names resolve from the env's SSM tree (--PROJECT_ID/--ENV/--REGION injected
by the CDK) and queries run in the env's Athena workgroup.

One behavioural delta from the legacy script: when the latest release has no
gold-model rows (e.g. an environment whose dbt project defines only silver
models, like the un-forked template), the job logs a warning and exits
successfully instead of raising — a release without gold models is a valid
state, not a pipeline failure.

Reads:  the env's `releases` Iceberg ledger (written by `g3dt release write`).
Writes: s3://<gold-bucket>/release_jsons/v<tag>/<study>/<table>.json plus a
        DataImportOrder.txt per study (key layout fixed in
        g3dt.utils.athena_utils.write_release_jsons_to_s3).

Environment overrides (optional): RELEASE_EXPORT_MAX_WORKERS (default 8),
RELEASE_EXPORT_TAG (default: latest tag in the ledger).
"""
import argparse
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

from g3dt import resolver
from g3dt.utils.athena_utils import (
    AthenaConfig,
    AthenaGoldWriter,
    AthenaValidationWriter,
    construct_data_import_order,
    write_release_jsons_to_s3,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEFAULT_MAX_WORKERS = 8


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--PROJECT_ID", required=True)
    parser.add_argument("--ENV", required=True)
    parser.add_argument("--REGION", required=True)
    args, _unknown = parser.parse_known_args()
    return args


def get_latest_release_tag(df, tag_col="release_tag"):
    """
    Given a DataFrame and a version-tag column, return the latest version tag.
    Handles tags like '1.2.3' and ignores non-numeric suffixes (e.g., 'rc').
    """
    def version_tuple(tag):
        parts = tag.strip().split(".")
        nums = []
        for part in parts:
            num = ""
            for ch in part:
                if ch.isdigit():
                    num += ch
                else:
                    break
            nums.append(int(num) if num else 0)
        return tuple(nums)

    if tag_col not in df.columns or df.empty:
        raise ValueError(f"Column '{tag_col}' missing or DataFrame is empty.")
    idx = df[tag_col].apply(version_tuple).idxmax()
    latest = df.loc[idx, tag_col]
    logger.info(f"Latest release_tag is: {latest}")
    return latest


def parse_model_row(row):
    """Extract the export parameters for one releases-ledger row.

    Model names encode study and (optionally) environment:
    ``gold_staging_edcad_subject`` -> study_id "staging/edcad", table "subject";
    ``gold_ausdiab_medical_history`` -> study_id "ausdiab", table
    "medical_history".
    """
    table_name = row["model_name"]
    parts = table_name.split("_")
    if parts[1] in ("staging", "prod"):
        study_id = f"{parts[1]}/{parts[2]}"
        write_table_name = "_".join(parts[3:])
    else:
        study_id = parts[1]
        write_table_name = "_".join(parts[2:])
    return {
        "snapshot_id": row["snapshot_id"],
        "db_name": row["db_name"],
        "table_name": table_name,
        "write_table_name": write_table_name,
        "study_id": study_id,
        "release_tag": f"v{row['release_tag']}",
    }


def process_model(config, s3_bucket, model):
    """Export one gold model at its pinned snapshot. Thread-safe unit of work.

    Creates its own boto3 session/client and AthenaGoldWriter, runs exactly
    one Athena query (the pinned-snapshot SELECT — construct_json honours the
    pin), and writes the JSON to S3. Returns the study output directory.
    """
    logger.info(
        f"Processing: study_id={model['study_id']}, table_name={model['table_name']}, "
        f"db_name={model['db_name']}, snapshot_id={model['snapshot_id']}, "
        f"release_tag={model['release_tag']}"
    )
    session = boto3.Session(region_name=config.aws_region)
    s3_client = session.client("s3")

    writer = AthenaGoldWriter(config, model["db_name"], model["table_name"])
    writer.snapshot_id = model["snapshot_id"]
    data_json = writer.construct_json()

    output_dir = write_release_jsons_to_s3(
        s3_bucket=s3_bucket,
        release_id=model["release_tag"],
        study_id=model["study_id"],
        table_name=model["write_table_name"],
        json_data=data_json,
        s3_client=s3_client,
    )
    logger.info(
        f"Successfully wrote JSON for table '{model['table_name']}' "
        f"(study_id={model['study_id']}, release_tag={model['release_tag']}) to S3."
    )
    return output_dir


def main() -> None:
    args = parse_args()
    rc = resolver.resolve(args.PROJECT_ID, args.ENV, region=args.REGION)

    release_db = rc.release_db
    release_table = rc.release_table
    gold_bucket = rc.get("buckets/gold")
    schema_s3_uri = f"s3://{rc.app('schema_s3_uri')}"
    max_workers = int(os.environ.get("RELEASE_EXPORT_MAX_WORKERS", str(DEFAULT_MAX_WORKERS)))

    logger.info(
        "Resolved from SSM /%s/%s: ledger=%s.%s, gold bucket=%s, workgroup=%s",
        args.PROJECT_ID, args.ENV, release_db, release_table, gold_bucket,
        rc.athena_workgroup,
    )

    config = AthenaConfig(
        aws_region=rc.region,
        aws_profile=None,
        athena_s3_output=rc.athena_output_location,
        workgroup=rc.athena_workgroup,
    )

    logger.info(f"Loading releases ledger {release_db}.{release_table}...")
    athena_writer = AthenaValidationWriter(config, release_db, release_table)
    athena_writer._get_latest_snapshot_id()
    release_table_pd = athena_writer._get_full_table()
    logger.info(f"Loaded {len(release_table_pd)} rows from metadata table.")

    release_tag = os.environ.get("RELEASE_EXPORT_TAG") or get_latest_release_tag(release_table_pd)

    logger.info(
        f"Filtering DataFrame to release_tag '{release_tag}' rows containing 'gold' in db_name..."
    )
    filtered = release_table_pd[
        (release_table_pd["release_tag"] == release_tag)
        & (release_table_pd["db_name"].str.contains("gold"))
    ]

    if len(filtered) == 0:
        # Legacy raised here; on the platform a silver-only release is valid.
        logger.warning(
            f"No gold-model rows for release_tag '{release_tag}' — "
            f"nothing to export. (Add gold models to the dbt project to "
            f"produce release JSONs.)"
        )
        return

    logger.info(f"Found {len(filtered)} tables to process for release_tag '{release_tag}'.")

    # The import order depends only on the schema — compute it once.
    import_order_text = "\n".join(construct_data_import_order(schema_s3_uri))

    models = [parse_model_row(row) for _, row in filtered.iterrows()]

    output_dirs = set()
    failures = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_model = {
            pool.submit(process_model, config, gold_bucket, m): m for m in models
        }
        for future in as_completed(future_to_model):
            model = future_to_model[future]
            try:
                output_dirs.add(future.result())
            except Exception as e:
                logger.error(f"FAILED: {model['db_name']}.{model['table_name']} "
                             f"(snapshot_id={model['snapshot_id']}): {e}")
                failures[model["table_name"]] = e

    s3 = boto3.client("s3", region_name=rc.region)
    for output_dir in sorted(output_dirs):
        key = f"{output_dir}/DataImportOrder.txt"
        s3.put_object(Body=import_order_text, Bucket=gold_bucket, Key=key)
        logger.info(f"Wrote data import order to s3://{gold_bucket}/{key}")

    logger.info(f"Exported {len(models) - len(failures)}/{len(models)} tables "
                f"across {len(output_dirs)} study prefixes.")
    if failures:
        raise RuntimeError(
            f"{len(failures)} table(s) failed to export: {sorted(failures)}. "
            "If a pinned snapshot has expired (Iceberg retention), the release "
            "can no longer be reproduced — investigate before re-running."
        )


if __name__ == "__main__":
    main()
