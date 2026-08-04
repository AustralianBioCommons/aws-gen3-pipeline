#!/usr/bin/env bash
# scripts/init-wrapper.sh — scaffold a private deployment-wrapper repo from
# wrapper-template/. The wrapper holds your real config, custom glue scripts
# and the pinned upstream version; see wrapper-template/README.md for the
# day-2 workflow it sets up.
#
#   ./scripts/init-wrapper.sh <target-dir> --project <id> --envs <env>[,<env>...]
#                             [--upstream-version vX.Y.Z]
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ./scripts/init-wrapper.sh <target-dir> --project <id> --envs <env>[,<env>...]
                                 [--upstream-version vX.Y.Z]

  <target-dir>        Directory to create the wrapper in (must not already exist)
  --project           Your projectId (lower-case, e.g. "myproject")
  --envs              Comma-separated environments to seed configs for (e.g. "test,prod")
  --upstream-version  Upstream tag to pin (default: latest tag of this checkout)
EOF
    exit 1
}

TARGET="" PROJECT="" ENVS="" VERSION=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project)          PROJECT="$2"; shift 2 ;;
        --envs|--env)       ENVS="$2"; shift 2 ;;
        --upstream-version) VERSION="$2"; shift 2 ;;
        -*) usage ;;
        *)  [ -z "$TARGET" ] && TARGET="$1" || usage; shift ;;
    esac
done
[ -n "$TARGET" ] && [ -n "$PROJECT" ] && [ -n "$ENVS" ] || usage

UPSTREAM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$UPSTREAM_DIR/wrapper-template" ] || {
    echo "error: $UPSTREAM_DIR/wrapper-template not found — run from a pipeline checkout" >&2
    exit 1
}
[ -e "$TARGET" ] && { echo "error: $TARGET already exists — refusing to overwrite" >&2; exit 1; }

if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$UPSTREAM_DIR" describe --tags --abbrev=0 2>/dev/null || true)"
fi
[ -n "$VERSION" ] || {
    echo "error: no upstream tag found — pass --upstream-version vX.Y.Z" >&2
    exit 1
}

echo "==> Creating wrapper at $TARGET (upstream pin: $VERSION)"
mkdir -p "$TARGET"
cp -R "$UPSTREAM_DIR/wrapper-template/." "$TARGET/"
printf '%s\n' "$VERSION" > "$TARGET/UPSTREAM_VERSION"

# Seed one config per environment from the upstream example, with the
# project/environment fields set so the filename cross-check passes.
for envName in ${ENVS//,/ }; do
    node -e '
        const fs = require("fs");
        const [example, project, envName, out] = process.argv.slice(1);
        const cfg = JSON.parse(fs.readFileSync(example, "utf-8"));
        cfg.projectId = project;
        cfg.environment = envName;
        fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
    ' "$UPSTREAM_DIR/docs/example-config.json" "$PROJECT" "$envName" \
      "$TARGET/config/$PROJECT.$envName.json"
    echo "    seeded config/$PROJECT.$envName.json"
done

cd "$TARGET"
git init -q -b main
git add -A
git commit -q -m "chore: scaffold deployment wrapper (upstream $VERSION)"

cat <<EOF

Wrapper created. Next steps:
  1. cd $TARGET
  2. Fill in real values in config/$PROJECT.<env>.json
     (field reference: upstream docs/CONFIG_GUIDE.md — accountId, region,
      CodeStar connection ARN, AMI, Gen3 facts)
  3. Create a PRIVATE GitHub repo and push this directory to it
  4. aws sso login --profile <your-profile>
  5. ./deploy.sh --profile <your-profile> --env <env> --diff
EOF
