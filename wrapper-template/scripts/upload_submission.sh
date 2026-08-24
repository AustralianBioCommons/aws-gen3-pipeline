#!/usr/bin/env bash
# Upload a filled g3mt workbook to where the ingest Glue job scans for it,
# and print the exact job-run commands for what you chose.
#
# How the job finds files, launches, and what parameters create what tables:
# upstream docs/INGESTION.md
# (https://github.com/AustralianBioCommons/aws-gen3-pipeline/blob/main/docs/INGESTION.md).
# In short: bucket from SSM buckets/bronze, prefix `submissions/` by
# convention, study id = first folder under the prefix, sheets from the
# workbook's own `_g3mt` map. This script mirrors those defaults and derives
# every name from your config/<project>.<env>.json.
#
# Usage:
#   ./scripts/upload_submission.sh <workbook.xlsx> <study-id> \
#       [--env <env>] [--profile <aws-profile>] \
#       [--bucket <bucket-name>] [--prefix <prefix>]
#
# --env:    which config/*.<env>.json to derive names from. Optional when the
#           wrapper has exactly one config.
# --profile: AWS profile for the upload (default: <projectId>_<env>).
# --prefix: any prefix in the bronze bucket works with no permission change
#           (the Glue ETL role's grant is bucket-wide); the job just needs the
#           matching --S3_PREFIX, which this script prints for you.
# --bucket: a NON-DEFAULT bucket needs infrastructure work first — the Glue
#           ETL role is only granted the pipeline's own buckets, so the job's
#           scan will fail with AccessDenied until a read grant for your
#           bucket is added in upstream lib/stacks/iam-roles-stack.ts and
#           deployed. See upstream docs/INGESTION.md, "Pointing ingestion at
#           a different bucket or prefix".
set -euo pipefail

# Print only the header comment block (stop at the first non-comment line).
usage() { awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 1; }

WORKBOOK="${1:-}"; STUDY="${2:-}"
[ -n "$WORKBOOK" ] && [ -n "$STUDY" ] || usage
shift 2

PROFILE=""
ENV=""
BUCKET=""
PREFIX="submissions"
while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE="$2"; shift 2 ;;
        --env) ENV="$2"; shift 2 ;;
        --bucket) BUCKET="$2"; shift 2 ;;
        --prefix) PREFIX="${2%/}"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; usage ;;
    esac
done

[ -f "$WORKBOOK" ] || { echo "No such file: $WORKBOOK" >&2; exit 1; }
case "$WORKBOOK" in
    *.xlsx) ;;
    *) echo "The ingest job only picks up .xlsx files: $WORKBOOK" >&2; exit 1 ;;
esac

# Bucket names are derived, never authored (upstream lib/names.ts):
# <projectId>-<environment>-bronze-<accountId>-<region>, all from the config.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "$ENV" ]; then
    CONFIG="$(ls "$ROOT"/config/*."$ENV".json 2>/dev/null | head -1)"
    [ -n "$CONFIG" ] || { echo "No config/*.$ENV.json found" >&2; exit 1; }
else
    set -- "$ROOT"/config/*.json
    [ -e "$1" ] || { echo "No config/*.json found" >&2; exit 1; }
    [ $# -eq 1 ] || { echo "Multiple configs found — pass --env" >&2; exit 1; }
    CONFIG="$1"
fi

field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['$1'])" "$CONFIG"; }
PROJECT_ID="$(field projectId)"
ENV="$(field environment)"
ACCOUNT_ID="$(field accountId)"
REGION="$(field region)"
PROFILE="${PROFILE:-${PROJECT_ID}_${ENV}}"

BRONZE_BUCKET="${PROJECT_ID}-${ENV}-bronze-${ACCOUNT_ID}-${REGION}"
BUCKET="${BUCKET:-$BRONZE_BUCKET}"
DEST="s3://${BUCKET}/${PREFIX}/${STUDY}/$(basename "$WORKBOOK")"
JOB="${PROJECT_ID}-${ENV}-ingest-metadata-templates"

# The job needs matching overrides for anything non-default.
JOB_ARGS="\"--STUDY\":\"$STUDY\""
[ "$PREFIX" != "submissions" ] && JOB_ARGS="$JOB_ARGS,\"--S3_PREFIX\":\"$PREFIX\""
if [ "$BUCKET" != "$BRONZE_BUCKET" ]; then
    JOB_ARGS="$JOB_ARGS,\"--S3_BUCKET\":\"$BUCKET\""
    cat >&2 <<EOF
WARNING: '$BUCKET' is not this env's bronze bucket ($BRONZE_BUCKET).
The Glue ETL role is only granted the pipeline's own buckets, so the ingest
job will fail with AccessDenied unless a read grant for this bucket has been
added in upstream lib/stacks/iam-roles-stack.ts and deployed. See upstream
docs/INGESTION.md, "Pointing ingestion at a different bucket or prefix".

EOF
fi

echo "==> Uploading $(basename "$WORKBOOK") for study '$STUDY'"
aws s3 cp "$WORKBOOK" "$DEST" --profile "$PROFILE"

cat <<EOF

Deposited: $DEST

To ingest it, run the Glue job (dry run first to check parsing):

  aws glue start-job-run --job-name $JOB --profile $PROFILE \\
    --arguments '{$JOB_ARGS,"--DRY_RUN":"true"}'

  aws glue start-job-run --job-name $JOB --profile $PROFILE \\
    --arguments '{$JOB_ARGS}'

Then check the tables:

  SELECT count(*) FROM ${PROJECT_ID}_${ENV}_bronze_db.bronze_${STUDY}_<node>;
EOF
