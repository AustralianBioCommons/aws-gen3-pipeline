#!/usr/bin/env bash
# scripts/integration_test.sh - slim runtime integration tests for a DEPLOYED env.
#
# CloudFormation already guarantees every resource exists; these checks cover
# what a green `cdk deploy` CANNOT verify:
#   - the live SSM tree is complete and its values are truthful
#   - the EC2 job box finished its user-data bootstrap and registered with SSM
#     (proving instance profile + private-subnet NAT egress end-to-end)
#   - an Athena query actually completes through the new workgroup
#   - the auto-stop alarm is live with the intended shape
#   - known CFN blind spots: Glue job scripts in S3, the Gen3 secret, and the
#     pipelines' first execution status (informational)
#
# ACTIVE probes (skipped with --read-only): one `SELECT 1` Athena query (writes
# a small result object to the athena-results bucket) and one SSM Run Command
# on the job box (`g3dt version`, marker file, outbound HTTPS check).
#
# Usage (from a checkout of this repo, or from a wrapper via its .checkout/):
#   ./scripts/integration_test.sh --profile <your-profile> [--env test] [--project <id>] [--read-only]
#   ./.checkout/scripts/integration_test.sh --profile <your-profile> [--env test] ...
set -uo pipefail

# Anchor to this repo's root so every relative path below (package.json, lib/,
# config/) resolves here and not in the caller's CWD. The documented wrapper
# invocation runs this from the wrapper root, which has a config/ of its own
# but no package.json and no compiled lib/ — without this cd, `npm run build`
# and the deriveNames() require() both fail, $EXPECT comes back empty, and
# every check that dereferences it reports a bogus FAIL. deploy.sh overlays the
# wrapper's config into .checkout/config/, so the config read here is the same
# one the CDK deployed with either way.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "cannot locate repo root" >&2; exit 1; }

PROFILE=""; ENV_NAME="test"; PROJECT=""; READ_ONLY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="$2"; shift 2;;
    --env)       ENV_NAME="$2"; shift 2;;
    --project)   PROJECT="$2"; shift 2;;
    --read-only) READ_ONLY="true"; shift;;
    *) echo "Usage: $0 --profile <p> [--env <e>] [--project <id>] [--read-only]" >&2; exit 2;;
  esac
done
[[ -n "$PROFILE" ]] || { echo "--profile is required" >&2; exit 2; }

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[[ -f lib/names.js ]] || { echo "[setup] compiling (lib/names.js missing)"; npm run build >/dev/null; }

# ---- derive expected values from the SAME source of truth the CDK used ------
CONFIG_FILE=""
for f in config/*."${ENV_NAME}".json; do
  [[ -e "$f" ]] || continue
  if [[ -n "$PROJECT" ]]; then
    [[ "$f" == "config/${PROJECT}.${ENV_NAME}.json" ]] && CONFIG_FILE="$f"
  else
    [[ -n "$CONFIG_FILE" ]] && { echo "Multiple configs for env ${ENV_NAME}; pass --project" >&2; exit 2; }
    CONFIG_FILE="$f"
  fi
done
[[ -n "$CONFIG_FILE" ]] || { echo "No config/<project>.${ENV_NAME}.json found" >&2; exit 2; }

EXPECT="$(node -e "
const fs = require('fs');
const { deriveNames } = require('./lib/names.js');
const { expectedTreeKeys } = require('./lib/ssm-keys.js');
const cfg = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf-8'));
const n = deriveNames(cfg);
console.log(JSON.stringify({
  ssmKeys: expectedTreeKeys(cfg, n),
  prefix: cfg.projectId + '-' + cfg.environment,
  base: '/' + cfg.projectId + '/' + cfg.environment,
  region: cfg.region,
  toolkitVersion: cfg.toolkitVersion,
  secretName: cfg.gen3.awsSecretName,
  metadataBucket: n.buckets.metadata,
  workgroup: n.athena.workgroup,
  scriptLocations: n.glueJobs.map(j => j.scriptLocation),
  jobNames: n.glueJobs.map(j => j.name),
  pipelines: [n.codepipeline.dbtTestAndRun, n.codepipeline.writeReleaseInfo],
}));
")"
val() { echo "$EXPECT" | jq -r "$1"; }
PREFIX="$(val .prefix)"; BASE="$(val .base)"; REGION="$(val .region)"

AWS=(aws --profile "$PROFILE" --region "$REGION" --output json)

PASS=0; FAIL=0; WARN=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf '  \033[33mWARN\033[0m %s\n' "$1"; }
info() { printf '  \033[36mINFO\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

echo "Integration tests for ${PREFIX} (config: ${CONFIG_FILE}, profile: ${PROFILE})"
[[ "$READ_ONLY" == "true" ]] && echo "(read-only mode: active probes skipped)"

# ---- 1. Live SSM tree -------------------------------------------------------
hdr "SSM tree ${BASE}"
PARAMS="$("${AWS[@]}" ssm get-parameters-by-path --path "$BASE" --recursive 2>/dev/null)"
COUNT="$(echo "$PARAMS" | jq '.Parameters | length')"
# Presence, not an exact total: the expected keys come from lib/ssm-keys.ts —
# the same map the SSM stack publishes from — so a fork that adds a parameter
# is checked for it rather than failed by it. Naming the missing keys also
# beats "expected 41, found 40" when something really is absent. Extra keys
# beyond the map are fine here; test/ssm-publishing.test.ts is what forbids
# strays in this repo's own stacks.
MISSING=()
HAVE="$(echo "$PARAMS" | jq -r '.Parameters[].Name')"
while read -r rel; do
  [[ -n "$rel" ]] || continue
  grep -qxF "$BASE/$rel" <<<"$HAVE" || MISSING+=("$rel")
done < <(echo "$EXPECT" | jq -r '.ssmKeys[]')
EXPECTED_N="$(echo "$EXPECT" | jq '.ssmKeys | length')"
if (( ${#MISSING[@]} == 0 )); then
  ok "all ${EXPECTED_N} expected parameters present (${COUNT} in the tree)"
else
  bad "${#MISSING[@]} of ${EXPECTED_N} expected parameters missing: ${MISSING[*]}"
fi

pval() { echo "$PARAMS" | jq -r --arg n "$BASE/$1" '.Parameters[] | select(.Name==$n) | .Value'; }
[[ "$(pval buckets/metadata)" == "$(val .metadataBucket)" ]] \
  && ok "buckets/metadata matches deriveNames()" || bad "buckets/metadata value drifted"
[[ "$(pval athena/workgroup)" == "$(val .workgroup)" ]] \
  && ok "athena/workgroup matches deriveNames()" || bad "athena/workgroup value drifted"
[[ "$(pval meta/toolkitVersion)" == "$(val .toolkitVersion)" ]] \
  && ok "meta/toolkitVersion matches config" || bad "meta/toolkitVersion drifted"
# Toolkit releases are a three-way coupling: the PyPI release, the config's
# toolkitVersion pin, and the glue-scripts S3 copy must all move together.
# This check catches a missed leg: deployed Glue jobs still pinning an old
# toolkit after the config bumped. Custom jobs may legitimately override
# --additional-python-modules (lib/stacks/glue-jobs-stack.ts) - hence warn,
# not bad, when no pin is found at all.
PIN="gen3-dataops-toolkit==$(val .toolkitVersion)"
for job in $(echo "$EXPECT" | jq -r '.jobNames[]'); do
  MODS=$("${AWS[@]}" glue get-job --job-name "$job" --query 'Job.DefaultArguments."--additional-python-modules"' --output text 2>/dev/null)
  if [[ "$MODS" == *"$PIN"* ]]; then ok "glue job ${job} pins ${PIN}"
  elif [[ "$MODS" == *"gen3-dataops-toolkit=="* ]]; then bad "glue job ${job} pins a DIFFERENT toolkit version (${MODS})"
  else warn "glue job ${job}: no toolkit pin found (custom override or job missing)"; fi
done
INSTANCE_ID="$(pval ec2/instanceId)"
if [[ "$INSTANCE_ID" =~ ^i-[0-9a-f]+$ ]]; then ok "ec2/instanceId is a real id (${INSTANCE_ID})"; else bad "ec2/instanceId invalid: '${INSTANCE_ID}'"; fi
APP_COUNT="$(echo "$PARAMS" | jq --arg p "$BASE/app/" '[.Parameters[] | select(.Name | startswith($p))] | length')"
[[ "$APP_COUNT" == "8" ]] && ok "all 8 app/* facts published" || bad "expected 8 app/* params, found ${APP_COUNT}"

# ---- 2. EC2 job box ---------------------------------------------------------
hdr "EC2 job box ${INSTANCE_ID}"
BOX="$("${AWS[@]}" ec2 describe-instances --instance-ids "$INSTANCE_ID" 2>/dev/null | jq '.Reservations[0].Instances[0]')"
STATE="$(echo "$BOX" | jq -r '.State.Name')"
PUB_IP="$(echo "$BOX" | jq -r '.PublicIpAddress // empty')"
case "$STATE" in
  running) ok "instance running";;
  stopped) ok "instance stopped (auto-stop is expected behaviour)";;
  *)       bad "instance state: ${STATE}";;
esac
[[ -z "$PUB_IP" ]] && ok "no public IP (private subnet)" || bad "instance has a public IP (${PUB_IP})"

if [[ "$STATE" == "running" ]]; then
  PING="$("${AWS[@]}" ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)"
  [[ "$PING" == "Online" ]] \
    && ok "SSM-managed and Online (bootstrap egress + instance profile work)" \
    || bad "not Online in SSM (PingStatus: ${PING}) - check user-data/egress"
else
  info "box stopped - skipping SSM Online + on-box probe (start it to test dispatch)"
fi

if [[ "$READ_ONLY" != "true" && "$STATE" == "running" ]]; then
  CMD_ID="$("${AWS[@]}" ssm send-command --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "integration_test.sh probe" \
    --parameters 'commands=["runuser -l ec2-user -c \"g3dt version\"","cat /etc/g3dt/g3dt.yaml","curl -sI -m 10 https://pypi.org | head -1"]' \
    --query Command.CommandId --output text 2>/dev/null)"
  if [[ -z "$CMD_ID" ]]; then
    bad "could not send SSM command to the box"
  else
    STATUS="Pending"; TRIES=0
    while [[ "$STATUS" == "Pending" || "$STATUS" == "InProgress" ]] && (( TRIES < 20 )); do
      sleep 3; TRIES=$((TRIES+1))
      STATUS="$("${AWS[@]}" ssm get-command-invocation --command-id "$CMD_ID" \
        --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null)"
    done
    OUTPUT="$("${AWS[@]}" ssm get-command-invocation --command-id "$CMD_ID" \
      --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text 2>/dev/null)"
    if [[ "$STATUS" == "Success" ]]; then
      echo "$OUTPUT" | grep -qE "^[0-9]+\." && ok "g3dt CLI runs on the box (user-data pip succeeded)" \
                                          || bad "g3dt CLI not found on the box"
      echo "$OUTPUT" | grep -q "project:" && ok "/etc/g3dt/g3dt.yaml marker present" \
                                          || bad "g3dt.yaml marker missing"
      echo "$OUTPUT" | grep -q "HTTP"     && ok "outbound HTTPS works from the private subnet (NAT egress)" \
                                          || bad "outbound HTTPS failed from the box"
    else
      bad "on-box probe did not succeed (status: ${STATUS})"
    fi
  fi
fi

# ---- 3. Athena round-trip ---------------------------------------------------
hdr "Athena workgroup $(val .workgroup)"
if [[ "$READ_ONLY" == "true" ]]; then
  info "read-only: skipping SELECT 1 query"
else
  QID="$("${AWS[@]}" athena start-query-execution --work-group "$(val .workgroup)" \
    --query-string 'SELECT 1' --query QueryExecutionId --output text 2>/dev/null)"
  if [[ -z "$QID" ]]; then
    bad "could not start a query in the workgroup"
  else
    QSTATE="QUEUED"; TRIES=0
    while [[ "$QSTATE" == "QUEUED" || "$QSTATE" == "RUNNING" ]] && (( TRIES < 20 )); do
      sleep 2; TRIES=$((TRIES+1))
      QSTATE="$("${AWS[@]}" athena get-query-execution --query-execution-id "$QID" \
        --query 'QueryExecution.Status.State' --output text 2>/dev/null)"
    done
    [[ "$QSTATE" == "SUCCEEDED" ]] \
      && ok "SELECT 1 succeeded (engine + output location + permissions)" \
      || bad "query ended in ${QSTATE}"
  fi
fi

# ---- 4. Auto-stop alarm -----------------------------------------------------
hdr "Auto-stop alarm ${PREFIX}-ec2-auto-stop"
ALARM="$("${AWS[@]}" cloudwatch describe-alarms --alarm-names "${PREFIX}-ec2-auto-stop" 2>/dev/null | jq '.MetricAlarms[0]')"
if [[ "$ALARM" == "null" || -z "$ALARM" ]]; then
  bad "alarm not found"
else
  if echo "$ALARM" | jq -e '.Threshold == 1 and .EvaluationPeriods == 24 and .Period == 3600 and .TreatMissingData == "ignore"' >/dev/null; then
    ok "alarm shape matches staging parity (1% / 24x1h / ignore)"
  else
    bad "alarm shape drifted: $(echo "$ALARM" | jq -c '{Threshold,EvaluationPeriods,Period,TreatMissingData}')"
  fi
  echo "$ALARM" | jq -r '.AlarmActions[]' | grep -q ":ec2:stop" \
    && ok "stop action attached" || bad "no ec2:stop action on the alarm"
fi

# ---- 5. Known CloudFormation blind spots ------------------------------------
hdr "CFN blind spots"
while read -r loc; do
  b="${loc#s3://}"; key="${b#*/}"; b="${b%%/*}"
  if ! "${AWS[@]}" s3api head-object --bucket "$b" --key "$key" >/dev/null 2>&1; then
    warn "Glue job script missing: ${loc} (jobs cannot run until uploaded)"
  fi
done < <(echo "$EXPECT" | jq -r '.scriptLocations[]')
SECRET="$(val .secretName)"
"${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1 \
  && ok "secret '${SECRET}' exists" \
  || warn "secret '${SECRET}' missing - create it before metadata uploads"
for p in $(echo "$EXPECT" | jq -r '.pipelines[]'); do
  LATEST="$("${AWS[@]}" codepipeline list-pipeline-executions --pipeline-name "$p" \
    --max-items 1 --query 'pipelineExecutionSummaries[0].status' --output text 2>/dev/null | head -1)"
  info "pipeline ${p}: latest execution status = ${LATEST:-none} (informational)"
done

# ---- summary ----------------------------------------------------------------
printf '\n\033[1mSummary:\033[0m %d passed, %d failed, %d warnings\n' "$PASS" "$FAIL" "$WARN"
(( FAIL == 0 )) || exit 1
