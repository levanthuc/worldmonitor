#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy one isolated commodity WorldMonitor stack behind the shared Caddy
# gateway. It deliberately never runs `docker compose down -v`, never changes
# another project's route, and rolls the app image back if its health check
# fails before Caddy is reloaded.

PROJECT_DIR="${PROJECT_DIR:-/opt/worldmonitor}"
PROJECT_NAME="${PROJECT_NAME:-worldmonitor}"
DOMAIN="${DOMAIN:-thitruong.tongluc.com}"
GATEWAY_DIR="${GATEWAY_DIR:-/opt/gateway}"
GATEWAY_NETWORK="${GATEWAY_NETWORK:-gateway}"
APP_ALIAS="${APP_ALIAS:-worldmonitor-app}"
COMPOSE_FILE="$PROJECT_DIR/deploy/worldmonitor/compose.gateway.yaml"
ENV_FILE="$PROJECT_DIR/.env"
ROUTE_FILE="$GATEWAY_DIR/sites/worldmonitor.caddy"

log() { printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker compose "$@"
  else
    sudo docker compose "$@"
  fi
}

project_compose() {
  compose_cmd -p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

gateway_compose() {
  compose_cmd -f "$GATEWAY_DIR/compose.yaml" "$@"
}

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | sed 's/^[^=]*=//' || true
}

set_env_value() {
  local key="$1" value="$2" temp
  temp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  if [ -f "$ENV_FILE" ]; then grep -v -E "^${key}=" "$ENV_FILE" > "$temp" || true; fi
  printf '%s=%s\n' "$key" "$value" >> "$temp"
  chmod 600 "$temp"
  mv "$temp" "$ENV_FILE"
}

ensure_project() {
  [ -d "$PROJECT_DIR" ] || fail "Project directory not found: $PROJECT_DIR"
  [ -f "$PROJECT_DIR/Dockerfile" ] || fail "Missing $PROJECT_DIR/Dockerfile"
  [ -f "$COMPOSE_FILE" ] || fail "Missing $COMPOSE_FILE"
  [ -f "$GATEWAY_DIR/compose.yaml" ] || fail "Shared gateway not found: $GATEWAY_DIR"
  docker_cmd network inspect "$GATEWAY_NETWORK" >/dev/null 2>&1 \
    || fail "Docker network '$GATEWAY_NETWORK' is missing; do not create it blindly on a shared VPS."
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    umask 077
    : > "$ENV_FILE"
  fi
  [ -n "$(env_value REDIS_PASSWORD)" ] || set_env_value REDIS_PASSWORD "$(openssl rand -hex 32)"
  [ -n "$(env_value REDIS_TOKEN)" ] || set_env_value REDIS_TOKEN "$(openssl rand -hex 32)"
  [ -n "$(env_value WM_REDIS_REST_PORT)" ] || set_env_value WM_REDIS_REST_PORT 8079
  chmod 600 "$ENV_FILE"
}

build_images() {
  local revision app_image seed_image rest_image
  revision="$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD 2>/dev/null || date '+%Y%m%d%H%M%S')"
  rest_image="worldmonitor-redis-rest:local"

  if [ -n "${DEPLOY_IMAGE:-}" ]; then
    app_image="$DEPLOY_IMAGE"
    seed_image="${DEPLOY_SEED_IMAGE:-${DEPLOY_IMAGE}-seeder}"
    log "Pulling immutable application image $app_image"
    docker_cmd pull "$app_image"
    if [ -n "${DEPLOY_SEED_IMAGE:-}" ]; then docker_cmd pull "$seed_image"; fi
  else
    app_image="tongluc-worldmonitor:${revision}"
    seed_image="tongluc-worldmonitor-seeder:${revision}"
    log "Building focused seeder image $seed_image"
    docker_cmd build --target seeder -t "$seed_image" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR"
    log "Building commodity application image $app_image"
    docker_cmd build --build-arg VITE_VARIANT=commodity -t "$app_image" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR"
  fi

  log "Building Redis REST adapter $rest_image"
  docker_cmd build -t "$rest_image" -f "$PROJECT_DIR/docker/Dockerfile.redis-rest" "$PROJECT_DIR/docker"
  set_env_value WM_IMAGE "$app_image"
  set_env_value WM_SEED_IMAGE "$seed_image"
  set_env_value WM_REDIS_REST_IMAGE "$rest_image"
}

wait_for_health() {
  local container status attempt
  container="$(project_compose ps -q worldmonitor)"
  [ -n "$container" ] || return 1
  for attempt in $(seq 1 36); do
    status="$(docker_cmd inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [ "$status" = healthy ]; then return 0; fi
    if [ "$status" = unhealthy ] || [ "$status" = exited ] || [ "$status" = dead ]; then
      project_compose logs --tail=120 worldmonitor >&2 || true
      return 1
    fi
    sleep 5
  done
  project_compose logs --tail=120 worldmonitor >&2 || true
  return 1
}

write_and_reload_route() {
  local temp
  temp="$(mktemp "$GATEWAY_DIR/sites/.worldmonitor.caddy.XXXXXX")"
  cat > "$temp" <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy $APP_ALIAS:8080
}
CADDY
  mv "$temp" "$ROUTE_FILE"
  if ! gateway_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    rm -f "$ROUTE_FILE"
    gateway_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
    fail "Caddy rejected the new route; it has been removed and the prior config reloaded."
  fi
}

main() {
  local prior_image
  ensure_project
  ensure_env
  prior_image="$(env_value WM_IMAGE)"
  build_images
  project_compose config >/dev/null

  log "Starting private Redis services and WorldMonitor"
  project_compose up -d redis redis-rest worldmonitor
  if ! wait_for_health; then
    if [ -n "$prior_image" ] && [ "$prior_image" != "$(env_value WM_IMAGE)" ]; then
      log "New image failed health checks; reverting WorldMonitor to last configured image."
      set_env_value WM_IMAGE "$prior_image"
      project_compose up -d --no-deps worldmonitor || true
    fi
    fail "WorldMonitor did not become healthy; Caddy was not changed."
  fi

  log "Publishing isolated Caddy route for $DOMAIN"
  write_and_reload_route
  set_env_value WM_LAST_GOOD_IMAGE "$(env_value WM_IMAGE)"
  log "Deployment ready: https://$DOMAIN"
  project_compose ps
}

main "$@"
