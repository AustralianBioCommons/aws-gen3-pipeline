#!/usr/bin/env bash
# scripts/discover_infra.sh — read-only inventory of a Gen3 DataOps pipeline.
#
# Produces the raw material needed to rebuild manually-created pipeline
# infrastructure as CDK: every project resource's live configuration, IAM
# policy documents, and the VPC/subnet/SG set derived from what is actually
# attached (EC2 ENI, CodeBuild vpcConfig, Glue connection, Lambda) — never
# from documentation.
#
# SAFETY: only list-/describe-/get-/batch-get- calls. No mutations. Never
# calls secretsmanager get-secret-value (names + metadata only). Re-runnable.
# Some get-bucket-* calls fail when a config is absent (no policy, no object
# lock, ...) — that is expected; the .err file is kept as the record.
#
# Usage:
#   ./scripts/discover_infra.sh --profile <your-profile> [--region ap-southeast-2]
#       [--project <id>] [--ec2-id <instance-id>] [--out docs/discovery/inventory]
set -uo pipefail

PROFILE=""
REGION="ap-southeast-2"
PROJECT=""
EC2_ID=""
OUTROOT="docs/discovery/inventory"

# Buckets that belong to the pipeline but do NOT carry the project prefix.
# Sourced from a scan of a legacy deployment. Extend as needed.
EXTRA_BUCKET_REGEX='athena-query-results|codepipeline|data-receive|data-cleaned|gen3schema|schema-commons|aws-glue|dataupload|synth'

usage() {
  cat >&2 <<EOF
Usage: $0 --profile <aws_profile> --project <id> [--region <r>] [--ec2-id <i-...>] [--out <dir>]
  --profile   REQUIRED. the AWS profile to inventory
  --project   REQUIRED. resource-name prefix to match (your projectId)
  --region    default: ${REGION}
  --ec2-id    known job-runner instance id (optional; skips the EC2 dump if omitted)
  --out       output root, default: ${OUTROOT}
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2;;
    --region)  REGION="$2";  shift 2;;
    --project) PROJECT="$2"; shift 2;;
    --ec2-id)  EC2_ID="$2";  shift 2;;
    --out)     OUTROOT="$2"; shift 2;;
    *) usage;;
  esac
done
[[ -n "$PROFILE" && -n "$PROJECT" ]] || usage

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }

AWS=(aws --profile "$PROFILE" --region "$REGION" --output json)
ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)" \
  || { echo "cannot authenticate profile ${PROFILE} — run: aws sso login --profile ${PROFILE}" >&2; exit 1; }
OUT="${OUTROOT}/${PROJECT}-${PROFILE}-${ACCOUNT}-$(date -u +%Y%m%d)"
mkdir -p "$OUT"

log()  { printf '[discover] %s\n' "$*" >&2; }
# File-name-safe slug for resources whose names contain spaces or slashes
# (Glue job "Silver Json Gen3_Validator", log group "/myproject/jobs", ...).
slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

# cap <name> <cmd...> : run a read-only command, save JSON, tolerate failure.
cap() {
  local name="$1"; shift
  log "$name"
  if "$@" >"$OUT/${name}.json" 2>"$OUT/${name}.err"; then
    rm -f "$OUT/${name}.err"
  else
    log "WARN: ${name} failed (kept ${name}.err)"
    echo '[]' >"$OUT/${name}.json"
  fi
}

log "account=$ACCOUNT region=$REGION project=$PROJECT ec2=$EC2_ID -> $OUT"
cap caller_identity "${AWS[@]}" sts get-caller-identity

# ---- 1. CloudFormation: what is ALREADY managed ----------------------------
cap cloudformation_stacks "${AWS[@]}" cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  UPDATE_ROLLBACK_COMPLETE IMPORT_COMPLETE
jq -r '.StackSummaries[]?.StackName' "$OUT/cloudformation_stacks.json" \
| while read -r s; do
    cap "cfn_resources_$(slug "$s")" "${AWS[@]}" cloudformation describe-stack-resources \
      --stack-name "$s"
  done

# ---- 2. S3 ------------------------------------------------------------------
cap s3_buckets "${AWS[@]}" s3api list-buckets
jq -r --arg p "$PROJECT" --arg x "$EXTRA_BUCKET_REGEX" \
  '.Buckets[].Name | select(test($p) or test($x))' "$OUT/s3_buckets.json" \
| sort -u | while read -r b; do
    sb="$(slug "$b")"
    cap "s3_location_${sb}"      "${AWS[@]}" s3api get-bucket-location                 --bucket "$b"
    cap "s3_versioning_${sb}"    "${AWS[@]}" s3api get-bucket-versioning               --bucket "$b"
    cap "s3_tagging_${sb}"       "${AWS[@]}" s3api get-bucket-tagging                  --bucket "$b"
    cap "s3_encryption_${sb}"    "${AWS[@]}" s3api get-bucket-encryption               --bucket "$b"
    cap "s3_objectlock_${sb}"    "${AWS[@]}" s3api get-object-lock-configuration       --bucket "$b"
    cap "s3_publicaccess_${sb}"  "${AWS[@]}" s3api get-public-access-block             --bucket "$b"
    cap "s3_policy_${sb}"        "${AWS[@]}" s3api get-bucket-policy                   --bucket "$b"
    cap "s3_lifecycle_${sb}"     "${AWS[@]}" s3api get-bucket-lifecycle-configuration  --bucket "$b"
    cap "s3_notification_${sb}"  "${AWS[@]}" s3api get-bucket-notification-configuration --bucket "$b"
    cap "s3_cors_${sb}"          "${AWS[@]}" s3api get-bucket-cors                     --bucket "$b"
  done

# Bucket size + object count from CloudWatch daily metrics (read-only, no
# LIST charges; values lag up to ~48h, which is fine for a volume signal).
cw_start() { date -u -v-3d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '3 days ago' +%Y-%m-%dT00:00:00Z; }
cw_end()   { date -u +%Y-%m-%dT00:00:00Z; }
jq -r --arg p "$PROJECT" --arg x "$EXTRA_BUCKET_REGEX" \
  '.Buckets[].Name | select(test($p) or test($x))' "$OUT/s3_buckets.json" \
| sort -u | while read -r b; do
    sb="$(slug "$b")"
    cap "s3_size_${sb}" "${AWS[@]}" cloudwatch get-metric-statistics \
      --namespace AWS/S3 --metric-name BucketSizeBytes \
      --dimensions Name=BucketName,Value="$b" Name=StorageType,Value=StandardStorage \
      --start-time "$(cw_start)" --end-time "$(cw_end)" \
      --period 86400 --statistics Average
    cap "s3_objects_${sb}" "${AWS[@]}" cloudwatch get-metric-statistics \
      --namespace AWS/S3 --metric-name NumberOfObjects \
      --dimensions Name=BucketName,Value="$b" Name=StorageType,Value=AllStorageTypes \
      --start-time "$(cw_start)" --end-time "$(cw_end)" \
      --period 86400 --statistics Average
  done

# ---- 3. Glue: databases, tables (Iceberg!), jobs, connections ---------------
cap glue_databases "${AWS[@]}" glue get-databases
jq -r '.DatabaseList[]?.Name' "$OUT/glue_databases.json" | while read -r db; do
  cap "glue_tables_$(slug "$db")" "${AWS[@]}" glue get-tables --database-name "$db"
done
cap glue_jobs                    "${AWS[@]}" glue get-jobs
cap glue_connections             "${AWS[@]}" glue get-connections
cap glue_crawlers                "${AWS[@]}" glue list-crawlers
cap glue_security_configurations "${AWS[@]}" glue get-security-configurations

# ---- 4. Athena --------------------------------------------------------------
cap athena_workgroups "${AWS[@]}" athena list-work-groups
jq -r '.WorkGroups[]?.Name' "$OUT/athena_workgroups.json" | while read -r wg; do
  cap "athena_wg_$(slug "$wg")" "${AWS[@]}" athena get-work-group --work-group "$wg"
done

# ---- 5. CodePipeline / CodeBuild / CodeConnections ---------------------------
cap codepipelines "${AWS[@]}" codepipeline list-pipelines
jq -r '.pipelines[]?.name' "$OUT/codepipelines.json" | while read -r p; do
  cap "codepipeline_$(slug "$p")" "${AWS[@]}" codepipeline get-pipeline --name "$p"
done
cap codebuild_projects "${AWS[@]}" codebuild list-projects
CB_NAMES="$(jq -r '.projects[]?' "$OUT/codebuild_projects.json" | tr '\n' ' ')"
if [[ -n "${CB_NAMES// /}" ]]; then
  # shellcheck disable=SC2086  # CodeBuild project names cannot contain spaces
  cap codebuild_detail "${AWS[@]}" codebuild batch-get-projects --names $CB_NAMES
fi
cap codeconnections "${AWS[@]}" codeconnections list-connections

# ---- 6. Step Functions -------------------------------------------------------
cap stepfunctions "${AWS[@]}" stepfunctions list-state-machines
jq -r '.stateMachines[]?.stateMachineArn' "$OUT/stepfunctions.json" | while read -r arn; do
  cap "sfn_$(slug "$(basename "$arn")")" "${AWS[@]}" stepfunctions describe-state-machine \
    --state-machine-arn "$arn"
done

# ---- 7. Lambda ----------------------------------------------------------------
cap lambda_functions "${AWS[@]}" lambda list-functions
jq -r '.Functions[]?.FunctionName' "$OUT/lambda_functions.json" | while read -r fn; do
  sf="$(slug "$fn")"
  cap "lambda_config_${sf}" "${AWS[@]}" lambda get-function-configuration --function-name "$fn"
  cap "lambda_policy_${sf}" "${AWS[@]}" lambda get-policy                 --function-name "$fn"
done

# ---- 8. EC2 job box (deep capture) + all instances ---------------------------
cap ec2_instances "${AWS[@]}" ec2 describe-instances
cap ec2_key_pairs "${AWS[@]}" ec2 describe-key-pairs
if [[ -n "$EC2_ID" ]]; then
  cap "ec2_instance_$(slug "$EC2_ID")" "${AWS[@]}" ec2 describe-instances --instance-ids "$EC2_ID"
  EC2_JSON="$OUT/ec2_instance_$(slug "$EC2_ID").json"
  AMI_ID="$(jq -r '.Reservations[]?.Instances[]?.ImageId // empty' "$EC2_JSON" | head -1)"
  [[ -n "$AMI_ID" ]] && cap "ec2_ami_$(slug "$AMI_ID")" "${AWS[@]}" ec2 describe-images --image-ids "$AMI_ID"
  cap "ec2_volumes_$(slug "$EC2_ID")" "${AWS[@]}" ec2 describe-volumes \
    --filters Name=attachment.instance-id,Values="$EC2_ID"
  IPROF_ARN="$(jq -r '.Reservations[]?.Instances[]?.IamInstanceProfile.Arn // empty' "$EC2_JSON" | head -1)"
  if [[ -n "$IPROF_ARN" ]]; then
    IPROF_NAME="${IPROF_ARN##*/}"
    cap "iam_instance_profile_$(slug "$IPROF_NAME")" "${AWS[@]}" iam get-instance-profile \
      --instance-profile-name "$IPROF_NAME"
  fi
fi

# ---- 9. VPC — derived from live attachments only ------------------------------
# The authoritative VPC/subnet/SG set is what is ATTACHED to the job box,
# the CodeBuild projects, the Glue connections, and any VPC-configured
# Lambda — documented IDs are not trusted.
{
  jq -r '.Reservations[]?.Instances[]? | .SubnetId // empty'                 "$EC2_JSON"
  jq -r '.projects[]?.vpcConfig.subnets[]? // empty'                         "$OUT/codebuild_detail.json" 2>/dev/null
  jq -r '.ConnectionList[]?.PhysicalConnectionRequirements.SubnetId // empty' "$OUT/glue_connections.json"
  for f in "$OUT"/lambda_config_*.json; do
    [[ -e "$f" ]] && jq -r '.VpcConfig.SubnetIds[]? // empty' "$f"
  done
} | sort -u | grep -v '^$' > "$OUT/attached_subnet_ids.txt" || true
{
  jq -r '.Reservations[]?.Instances[]?.SecurityGroups[]?.GroupId // empty'    "$EC2_JSON"
  jq -r '.projects[]?.vpcConfig.securityGroupIds[]? // empty'                 "$OUT/codebuild_detail.json" 2>/dev/null
  jq -r '.ConnectionList[]?.PhysicalConnectionRequirements.SecurityGroupIdList[]? // empty' "$OUT/glue_connections.json"
  for f in "$OUT"/lambda_config_*.json; do
    [[ -e "$f" ]] && jq -r '.VpcConfig.SecurityGroupIds[]? // empty' "$f"
  done
} | sort -u | grep -v '^$' > "$OUT/attached_sg_ids.txt" || true

SUBNET_IDS="$(tr '\n' ' ' < "$OUT/attached_subnet_ids.txt")"
SG_IDS="$(tr '\n' ' ' < "$OUT/attached_sg_ids.txt")"
if [[ -n "${SUBNET_IDS// /}" ]]; then
  # shellcheck disable=SC2086
  cap vpc_subnets "${AWS[@]}" ec2 describe-subnets --subnet-ids $SUBNET_IDS
else
  log "WARN: no attached subnets found"; echo '[]' > "$OUT/vpc_subnets.json"
fi
if [[ -n "${SG_IDS// /}" ]]; then
  # shellcheck disable=SC2086
  cap vpc_security_groups "${AWS[@]}" ec2 describe-security-groups --group-ids $SG_IDS
else
  log "WARN: no attached security groups found"; echo '[]' > "$OUT/vpc_security_groups.json"
fi
{
  jq -r '.Reservations[]?.Instances[]?.VpcId // empty' "$EC2_JSON"
  jq -r '.projects[]?.vpcConfig.vpcId // empty' "$OUT/codebuild_detail.json" 2>/dev/null
  jq -r '.Subnets[]?.VpcId // empty' "$OUT/vpc_subnets.json"
  jq -r '.SecurityGroups[]?.VpcId // empty' "$OUT/vpc_security_groups.json"
} | sort -u | grep -v '^$' > "$OUT/attached_vpc_ids.txt" || true
VPC_IDS="$(tr '\n' ' ' < "$OUT/attached_vpc_ids.txt")"
VPC_FILTER="$(tr '\n' ',' < "$OUT/attached_vpc_ids.txt" | sed 's/,$//')"
if [[ -n "${VPC_IDS// /}" ]]; then
  # shellcheck disable=SC2086
  cap vpc_vpcs "${AWS[@]}" ec2 describe-vpcs --vpc-ids $VPC_IDS
  cap vpc_route_tables      "${AWS[@]}" ec2 describe-route-tables      --filters Name=vpc-id,Values="$VPC_FILTER"
  cap vpc_nat_gateways      "${AWS[@]}" ec2 describe-nat-gateways      --filter  Name=vpc-id,Values="$VPC_FILTER"
  cap vpc_internet_gateways "${AWS[@]}" ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values="$VPC_FILTER"
  cap vpc_endpoints         "${AWS[@]}" ec2 describe-vpc-endpoints     --filters Name=vpc-id,Values="$VPC_FILTER"
else
  log "WARN: no attached VPCs found"
fi

# ---- 10. IAM: roles + FULL policy documents -----------------------------------
IAM_ROLE_REGEX="${PROJECT}|dbt|codebuild|codepipeline|stepfunctions|glue|etl"
cap iam_roles "${AWS[@]}" iam list-roles
cap iam_instance_profiles "${AWS[@]}" iam list-instance-profiles
jq -r --arg p "$IAM_ROLE_REGEX" '.Roles[].RoleName | select(test($p; "i"))' \
  "$OUT/iam_roles.json" | sort -u | while read -r r; do
    sr="$(slug "$r")"
    cap "iam_role_${sr}"     "${AWS[@]}" iam get-role                    --role-name "$r"
    cap "iam_attached_${sr}" "${AWS[@]}" iam list-attached-role-policies --role-name "$r"
    cap "iam_inline_${sr}"   "${AWS[@]}" iam list-role-policies          --role-name "$r"
    # Inline policy documents
    jq -r '.PolicyNames[]?' "$OUT/iam_inline_${sr}.json" | while read -r pn; do
      cap "iam_inline_doc_${sr}__$(slug "$pn")" "${AWS[@]}" iam get-role-policy \
        --role-name "$r" --policy-name "$pn"
    done
    # Customer-managed attached policy documents (AWS-managed ones are
    # standard — the name in iam_attached_* is enough for CDK).
    jq -r '.AttachedPolicies[]?.PolicyArn' "$OUT/iam_attached_${sr}.json" \
    | grep -v ':aws:policy/' | while read -r pa; do
        pslug="$(slug "${pa##*/}")"
        if [[ ! -f "$OUT/iam_policy_${pslug}.json" ]]; then
          cap "iam_policy_${pslug}" "${AWS[@]}" iam get-policy --policy-arn "$pa"
          pv="$(jq -r '.Policy.DefaultVersionId // empty' "$OUT/iam_policy_${pslug}.json")"
          [[ -n "$pv" ]] && cap "iam_policy_doc_${pslug}" "${AWS[@]}" iam get-policy-version \
            --policy-arn "$pa" --version-id "$pv"
        fi
      done
  done

# ---- 11. Lake Formation (dbt/Athena IAM grants LF actions) --------------------
cap lakeformation_settings    "${AWS[@]}" lakeformation get-data-lake-settings
cap lakeformation_resources   "${AWS[@]}" lakeformation list-resources
cap lakeformation_permissions "${AWS[@]}" lakeformation list-permissions

# ---- 12. Secrets Manager (names + metadata ONLY — never values) --------------
cap secrets "${AWS[@]}" secretsmanager list-secrets

# ---- 13. SSM ------------------------------------------------------------------
cap ssm_instance_information "${AWS[@]}" ssm describe-instance-information
cap ssm_parameters           "${AWS[@]}" ssm describe-parameters

# ---- 14. CloudWatch Logs -------------------------------------------------------
for prefix in "/${PROJECT}" /aws/codebuild /aws-glue /aws/vendedlogs /aws/lambda; do
  cap "logs_$(slug "$prefix")" "${AWS[@]}" logs describe-log-groups \
    --log-group-name-prefix "$prefix"
done

# ---- 15. Straggler sweep (expected empty; captured to prove it) ----------------
cap events_rules        "${AWS[@]}" events list-rules
cap scheduler_schedules "${AWS[@]}" scheduler list-schedules
cap sns_topics          "${AWS[@]}" sns list-topics
cap sqs_queues          "${AWS[@]}" sqs list-queues
cap dynamodb_tables     "${AWS[@]}" dynamodb list-tables
cap rds_instances       "${AWS[@]}" rds describe-db-instances

log "done -> $OUT"
log "attached subnets: $(tr '\n' ' ' < "$OUT/attached_subnet_ids.txt")"
log "attached SGs:     $(tr '\n' ' ' < "$OUT/attached_sg_ids.txt")"
log "attached VPCs:    $(tr '\n' ' ' < "$OUT/attached_vpc_ids.txt")"
