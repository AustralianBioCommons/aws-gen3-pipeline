#!/usr/bin/env bash
# deploy.sh — deploy this wrapper's config against the pinned upstream pipeline.
#
# The wrapper never holds pipeline code: every run starts from a clean clone of
# the upstream repo at the ref in UPSTREAM_VERSION, overlays this repo's config
# and glue scripts, then tests/diffs/deploys from inside the clone (.checkout/).
# Keep this script dumb — anything smarter belongs upstream, where it is
# versioned and tested for every wrapper at once.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./deploy.sh --profile <aws-profile> --env <env> [--project <id>] [--diff] [--yes]

  --profile   AWS profile to deploy with (required)
  --env       Environment matching config/<project>.<env>.json (required)
  --project   Project id, only needed if config/ holds several projects
  --diff      Stop after `cdk diff` (nothing is deployed)
  --yes       Skip the interactive confirmation before deploy

Environment overrides (for developing against a local upstream checkout):
  UPSTREAM_REPO  Git URL or local path (default: the public pipeline repo)
  UPSTREAM_REF   Git ref to clone (default: the contents of UPSTREAM_VERSION)
EOF
    exit 1
}

PROFILE="" ENV_NAME="" PROJECT="" DIFF_ONLY=0 ASSUME_YES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE="$2"; shift 2 ;;
        --env)     ENV_NAME="$2"; shift 2 ;;
        --project) PROJECT="$2"; shift 2 ;;
        --diff)    DIFF_ONLY=1; shift ;;
        --yes)     ASSUME_YES=1; shift ;;
        *) usage ;;
    esac
done
[ -n "$PROFILE" ] && [ -n "$ENV_NAME" ] || usage

cd "$(dirname "$0")"
TAG="$(tr -d '[:space:]' < UPSTREAM_VERSION)"
REPO="${UPSTREAM_REPO:-https://github.com/AustralianBioCommons/aws-gen3-pipeline.git}"
REF="${UPSTREAM_REF:-$TAG}"

echo "==> Cloning upstream ${REPO} @ ${REF}"
rm -rf .checkout
git clone --quiet --depth 1 --branch "$REF" "$REPO" .checkout

echo "==> Overlaying config and glue scripts"
# Clear any upstream demo configs first so config discovery cannot go ambiguous.
rm -f .checkout/config/*.json
cp config/*.json .checkout/config/
if compgen -G "glue-scripts/*.py" > /dev/null; then
    cp glue-scripts/*.py .checkout/glue-scripts/
fi
[ -f cdk.context.json ] && cp cdk.context.json .checkout/

cd .checkout
echo "==> Installing dependencies and running the upstream test suite"
npm ci --silent
npm test

CTX=(-c "env=${ENV_NAME}")
[ -n "$PROJECT" ] && CTX+=(-c "project=${PROJECT}")

echo "==> cdk diff"
npx cdk diff "*" "${CTX[@]}" --profile "$PROFILE"

if [ "$DIFF_ONLY" -eq 1 ]; then
    echo "==> --diff given: stopping before deploy"
    exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Deploy the above with profile '${PROFILE}'? [y/N] " answer
    case "$answer" in
        y|Y|yes|YES) ;;
        *) echo "Aborted — nothing deployed."; exit 1 ;;
    esac
fi

echo "==> cdk deploy"
npx cdk deploy "*" --require-approval never "${CTX[@]}" --profile "$PROFILE"
