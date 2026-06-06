#!/usr/bin/env bash
# DropIn production deploy — runs ON the VPS.
#
# The deploy SSH key in authorized_keys pins:
#   command="/bin/bash /opt/dropin/scripts/deploy.sh"
# so the CI runner can ONLY ever invoke this script — no shell, no other commands.
# The target commit arrives via $SSH_ORIGINAL_COMMAND (the arg the runner "asked" to run).
set -euo pipefail

REPO_DIR="/opt/dropin"
SERVICE="dropin"
HEALTH_URL="http://127.0.0.1:8787/"

cd "$REPO_DIR"

# Resolve target commit: prefer the SHA passed over SSH, else origin/main HEAD.
REQUESTED="${SSH_ORIGINAL_COMMAND:-}"
git fetch --quiet origin main
if [[ "$REQUESTED" =~ ^[0-9a-f]{40}$ ]]; then
  TARGET="$REQUESTED"
else
  TARGET="$(git rev-parse origin/main)"
fi

echo "Deploying $TARGET"
git reset --hard "$TARGET"          # .env is gitignored / untracked -> preserved

npm ci --omit=dev --no-audit --no-fund

sudo /usr/bin/systemctl restart "$SERVICE"

# Health gate — fail the deploy (and the CI job) if the app isn't serving.
for i in $(seq 1 10); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then
    echo "Healthy after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "Health check FAILED — app not responding on $HEALTH_URL" >&2
exit 1
