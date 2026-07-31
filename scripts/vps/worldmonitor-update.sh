#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy a tested commit from the user's fork. Upstream merges happen on the
# tongluc-production branch before this script is used; the VPS only consumes
# the resulting immutable fork commit and never merges upstream on its own.
PROJECT_DIR="${PROJECT_DIR:-/opt/worldmonitor}"
REF="${1:-origin/tongluc-production}"

cd "$PROJECT_DIR"
git diff --quiet && git diff --cached --quiet || {
  echo 'Refusing update: the VPS source worktree is dirty.' >&2
  exit 1
}
git fetch origin --tags
git switch --detach "$REF"
bash scripts/vps/worldmonitor-deploy.sh
