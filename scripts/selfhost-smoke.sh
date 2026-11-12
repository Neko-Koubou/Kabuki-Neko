#!/usr/bin/env bash
# Self-host smoke test (TASK-182; docs/self-hosting.md).
#
# Starts the Docker Compose package from this checkout under its own isolated project name,
# waits for the healthchecks, and checks what an operator would check by hand:
#   1. GET /                          -> 200 (web)
#   2. GET /api/v1/auth/setup-status  -> 200, not yet initialized
#   3. GET /join                      -> 200 (player entry)
#   4. first-run setup through the API, then a restart of every container;
#   5. after the restart the instance is still initialized and the administrator can sign in,
#      i.e. the data volume persisted.
# It never touches the operator's own `kabuki-neko` project: the project name is unique per run
# (or KN_SMOKE_PROJECT) and must start with `kn-smoke-`. Teardown runs `down` and keeps that
# project's volumes, unless --purge is given, which deletes only this smoke project's volumes.
#
# Usage: bash scripts/selfhost-smoke.sh [--profile default|scale] [--tls] [--no-build] [--purge]
#   --profile scale  PostgreSQL + Redis + MinIO profile (DEPLOYMENT_PROFILE=scale)
#   --tls            add docker/docker-compose.tls.yml with KN_DOMAIN=localhost (Caddy's local
#                    CA; checks go through the proxy on a free HTTPS port)
#   --no-build       use already built images (kabuki-neko-{api,web}:${KN_IMAGE_TAG:-local})
#   --purge          remove this smoke project's volumes on teardown
# Needs: docker with Compose v2, curl. No sudo. Exit code 0 only when every check passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=default
TLS=0
BUILD=1
PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --tls) TLS=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$PROFILE" == default || "$PROFILE" == scale ]] || { echo "--profile must be default or scale" >&2; exit 2; }

PROJECT="${KN_SMOKE_PROJECT:-kn-smoke-$(date +%s)-$$}"
if [[ "$PROJECT" != kn-smoke-* ]]; then
  echo "refusing project name '$PROJECT': smoke projects must start with kn-smoke-" >&2
  exit 2
fi

# log: timestamped progress line.
log() { printf '[selfhost-smoke %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
# fail: prints the reason, the containers' recent logs, and exits non-zero (teardown still runs).
fail() {
  log "FAIL: $*"
  compose ps -a || true
  compose logs --tail 40 || true
  exit 1
}

# free_port: a TCP port nothing listens on locally (bash /dev/tcp probe; no extra tools).
free_port() {
  local port
  for _ in $(seq 1 50); do
    port=$((20000 + RANDOM % 20000))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return
    fi
  done
  echo "no free port found" >&2
  exit 1
}

export KN_BIND_ADDRESS=127.0.0.1
export KN_WEB_PORT KN_API_PORT KN_MEDIA_PORT
KN_WEB_PORT="$(free_port)"
KN_API_PORT="$(free_port)"
KN_MEDIA_PORT="$(free_port)"
export KN_PUBLIC_URL="http://localhost:${KN_WEB_PORT}"
export KN_API_PUBLIC_URL="http://localhost:${KN_API_PORT}"
export KN_MEDIA_PUBLIC_URL="http://localhost:${KN_MEDIA_PORT}/kabuki-neko-media"
# Local evaluation over plain HTTP (and the bundled MinIO over HTTP in the scale profile).
export ALLOW_INSECURE_LOCAL_HTTP=true
export DEPLOYMENT_PROFILE="$PROFILE"

FILES=(-f "$ROOT/docker/docker-compose.yml")
if [[ "$TLS" == 1 ]]; then
  FILES+=(-f "$ROOT/docker/docker-compose.tls.yml")
  export KN_DOMAIN=localhost KN_TLS_BIND_ADDRESS=127.0.0.1
  export KN_HTTP_PORT KN_HTTPS_PORT
  KN_HTTP_PORT="$(free_port)"
  KN_HTTPS_PORT="$(free_port)"
  # A private /24 per run so parallel smoke projects never share the proxy address.
  octet=$((RANDOM % 200 + 20))
  export KN_PROXY_SUBNET="172.31.${octet}.0/24" KN_PROXY_ADDRESS="172.31.${octet}.10"
fi
PROFILE_ARGS=()
[[ "$PROFILE" == scale ]] && PROFILE_ARGS=(--profile scale)

# compose: docker compose for this smoke project only.
compose() { docker compose --progress quiet -p "$PROJECT" "${FILES[@]}" "${PROFILE_ARGS[@]}" "$@"; }

# teardown: stops this smoke project; deletes its volumes only with --purge.
teardown() {
  local status=$?
  if [[ "$PURGE" == 1 ]]; then
    log "teardown: down --volumes (smoke project $PROJECT only)"
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  else
    log "teardown: down (volumes of $PROJECT kept; rerun with --purge to delete them)"
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap teardown EXIT

if [[ "$TLS" == 1 ]]; then
  BASE="https://localhost:${KN_HTTPS_PORT}"
  API="$BASE/api/v1"
  ORIGIN="https://localhost"
  # Caddy's local CA for KN_DOMAIN=localhost is not in the host trust store.
  CURL=(curl -sS --insecure --max-time 20)
else
  BASE="http://127.0.0.1:${KN_WEB_PORT}"
  API="http://127.0.0.1:${KN_API_PORT}/api/v1"
  ORIGIN="$KN_PUBLIC_URL"
  CURL=(curl -sS --max-time 20)
fi

# http_status: prints the HTTP status of a GET.
http_status() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1" || echo 000; }

# wait_healthy: waits until a service's container reports healthy (or fails after 300 s).
wait_healthy() {
  local service="$1" id state
  for _ in $(seq 1 150); do
    id="$(compose ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [[ "$state" == healthy ]] && return 0
      [[ "$state" == exited || "$state" == dead ]] && fail "$service container $state"
    fi
    sleep 2
  done
  fail "$service did not become healthy within 300 s"
}

# wait_status: waits until a URL answers the expected status (proxy start-up, certificates).
wait_status() {
  local url="$1" expected="$2" got=000
  for _ in $(seq 1 60); do
    got="$(http_status "$url")"
    [[ "$got" == "$expected" ]] && return 0
    sleep 2
  done
  fail "GET $url answered $got, expected $expected"
}

# json_field: extracts a top-level JSON field with node from the API image (no jq needed).
json_field() {
  docker run --rm -i --entrypoint node "kabuki-neko-api:${KN_IMAGE_TAG:-local}" -e '
    let input = ""; process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => { const v = JSON.parse(input)[process.argv[1]]; process.stdout.write(String(v)); });
  ' "$1"
}

# all_healthy: waits for every long-running service of the profile.
all_healthy() {
  wait_healthy api
  wait_healthy web
  if [[ "$TLS" == 1 ]]; then wait_status "$BASE/" 200; fi
}

log "project $PROJECT, profile $PROFILE, tls=$TLS, build=$BUILD"
UP_ARGS=(up -d)
[[ "$BUILD" == 1 ]] && UP_ARGS+=(--build) || UP_ARGS+=(--no-build)
compose "${UP_ARGS[@]}" >/dev/null || fail "compose up failed"
all_healthy

log "check 1: GET / is 200"
[[ "$(http_status "$BASE/")" == 200 ]] || fail "GET / did not answer 200"

log "check 2: GET /api/v1/auth/setup-status is 200 and not initialized"
status_body="$("${CURL[@]}" -f "$API/auth/setup-status")" || fail "setup-status did not answer 200"
[[ "$(json_field isInitialized <<<"$status_body")" == false ]] || fail "fresh instance is already initialized"

log "check 3: GET /join is 200"
[[ "$(http_status "$BASE/join")" == 200 ]] || fail "GET /join did not answer 200"

log "check 4: first-run setup, then restart"
# Throwaway password for the isolated smoke instance; sent on stdin, never on the command line.
PASSWORD="Smoke-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
EMAIL="admin@smoke.invalid"
setup_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$API/auth/setup" \
  -H "Origin: $ORIGIN" -H "X-Kabuki-Client: web-v1" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
  --data @- <<<"{\"instanceName\":\"Smoke\",\"name\":\"Admin\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
[[ "$setup_code" == 201 ]] || fail "setup answered $setup_code, expected 201"
compose restart >/dev/null || fail "restart failed"
all_healthy

log "check 5: data persisted across the restart"
status_body="$("${CURL[@]}" -f "$API/auth/setup-status")" || fail "setup-status after restart did not answer 200"
[[ "$(json_field isInitialized <<<"$status_body")" == true ]] || fail "setup was lost after the restart"
login_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" \
  -H "Origin: $ORIGIN" -H "X-Kabuki-Client: web-v1" -H "Content-Type: application/json" \
  --data @- <<<"{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
[[ "$login_code" == 200 || "$login_code" == 201 ]] || fail "administrator sign-in after restart answered $login_code"
[[ "$(http_status "$BASE/join")" == 200 ]] || fail "GET /join after restart did not answer 200"

log "PASS: all checks passed for profile $PROFILE (tls=$TLS)"
