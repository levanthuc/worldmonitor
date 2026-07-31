#!/usr/bin/env bash
set -Eeuo pipefail

# Seed only the data used by the gold/silver copy bundle.  The jobs are split
# by freshness so a slow or credential-gated upstream cannot stop the live
# market snapshot from refreshing.  Each execution is intentionally isolated
# in the existing WorldMonitor seeder image; it never restarts the app.

PROJECT_DIR="${PROJECT_DIR:-/opt/worldmonitor}"
COMPOSE_FILE="$PROJECT_DIR/deploy/worldmonitor/compose.gateway.yaml"
ENV_FILE="$PROJECT_DIR/.env"
MODE="${1:-fast}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

[ -f "$COMPOSE_FILE" ] || { warn "Missing compose file: $COMPOSE_FILE"; exit 1; }
[ -f "$ENV_FILE" ] || { warn "Missing private environment file: $ENV_FILE"; exit 1; }

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

run_seed() {
  local script="$1"
  shift
  log "Seeding $script"
  if ! "${compose[@]}" run --rm --no-deps worldmonitor-seeder "$script" "$@"; then
    # Preserve the last good cache and continue with the independent sources.
    # The copy bundle will expose the resulting gap rather than invent data.
    warn "$script failed; the next scheduled run will retry."
  fi
}

seed_fast() {
  run_seed scripts/seed-commodity-quotes.mjs
  run_seed scripts/seed-hyperliquid-flow.mjs
}

seed_hourly() {
  seed_fast
  run_seed scripts/seed-fear-greed.mjs
  run_seed scripts/seed-prediction-markets.mjs
}

seed_daily() {
  seed_hourly
  run_seed scripts/seed-cot.mjs
  run_seed scripts/seed-gold-etf-flows.mjs
  run_seed scripts/seed-economic-calendar.mjs
  run_seed scripts/seed-economy.mjs
  run_seed scripts/seed-sanctions-pressure.mjs
  run_seed scripts/seed-ucdp-events.mjs
  run_seed scripts/seed-conflict-intel.mjs
  run_seed scripts/seed-consumer-prices.mjs --force
}

case "$MODE" in
  fast) seed_fast ;;
  hourly) seed_hourly ;;
  daily) seed_daily ;;
  *)
    printf 'Usage: %s {fast|hourly|daily}\n' "$0" >&2
    exit 64
    ;;
esac

log "WorldMonitor $MODE seed completed."
