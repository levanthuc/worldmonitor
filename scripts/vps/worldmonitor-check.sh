#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only operational check for the isolated WorldMonitor deployment.
PROJECT_DIR="${PROJECT_DIR:-/opt/worldmonitor}"
PROJECT_NAME="${PROJECT_NAME:-worldmonitor}"
DOMAIN="${DOMAIN:-thitruong.tongluc.com}"
GATEWAY_DIR="${GATEWAY_DIR:-/opt/gateway}"
COMPOSE_FILE="$PROJECT_DIR/deploy/worldmonitor/compose.gateway.yaml"
ENV_FILE="$PROJECT_DIR/.env"

compose_cmd() {
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then docker compose "$@"; else sudo docker compose "$@"; fi
}

project_compose() { compose_cmd -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

[ -f "$COMPOSE_FILE" ] || { echo "[FAIL] Missing compose: $COMPOSE_FILE"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "[FAIL] Missing env: $ENV_FILE"; exit 1; }

project_compose ps
docker network inspect gateway >/dev/null && echo '[OK] gateway network available'
grep -q "^$DOMAIN {" "$GATEWAY_DIR/sites/worldmonitor.caddy" && echo '[OK] Caddy route present'
curl -fsS --max-time 15 "https://$DOMAIN/api/sidecar-health" >/dev/null && echo '[OK] public sidecar health'
curl -fsS --max-time 30 "https://$DOMAIN/api/gold-analyst?mode=export" \
  | grep -q 'worldmonitor-gold-silver-evidence-v1' && echo '[OK] data export works without AI key'
