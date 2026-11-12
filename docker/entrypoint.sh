#!/bin/sh
# Kabuki Neko container entrypoint for the API and web images (TASK-175; SA §10.2).
#
# Usage (set by the images): kabuki-entrypoint api|web [extra node arguments]
#
# Runs under tini (PID 1), which forwards SIGTERM/SIGINT. The script `exec`s node, so node is the
# process that receives the signal: the API drains through its Nest shutdown hooks, and the web
# server stops accepting connections.
#
# API:
# 1. Secrets from files. For each of JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, DATABASE_URL,
#    REDIS_URL, S3_ACCESS_KEY and S3_SECRET_KEY, a `<NAME>_FILE` path (Docker/Compose secrets) is
#    read into the variable. Setting both forms is an error. Without either, a file named after
#    the lower-case variable in KN_SECRETS_DIR (the Compose scale profile's generated secrets
#    volume, e.g. `jwt_access_secret`) is used when present. Nothing is ever printed.
# 2. Shared secrets: with DEPLOYMENT_TOPOLOGY=multi, every node must sign and verify the same
#    tokens, so JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (or their _FILE forms) are required.
#    A per-node generated secret file would silently split the sessions.
# 3. Startup gate (docker/startup-gate.cjs): the compiled environment schema validates the
#    environment (only invalid field names are reported); then the external database and Redis
#    that the *effective* configuration selects (including the DEPLOYMENT_PROFILE=scale defaults)
#    must accept TCP connections within KN_STARTUP_WAIT_SEC seconds (integer 1–3600, default 60).
#    Only then does the API start and apply migrations under its migration lock
#    (DB_AUTO_MIGRATE). A timeout or invalid setting exits non-zero so the orchestrator restarts
#    the container instead of hanging.
# Web: starts the Next.js standalone server.
set -eu

role="${1:-}"
[ "$#" -gt 0 ] && shift

# Prints a message to stderr and exits 1.
fail() {
  echo "kabuki-entrypoint: $*" >&2
  exit 1
}

# Loads `<NAME>_FILE` into `<NAME>` for the fixed list of secret names (names are not user input).
load_secret_files() {
  for name in JWT_ACCESS_SECRET JWT_REFRESH_SECRET DATABASE_URL REDIS_URL S3_ACCESS_KEY S3_SECRET_KEY; do
    eval "file=\${${name}_FILE:-}"
    eval "current=\${${name}:-}"
    if [ -z "$file" ] && [ -z "$current" ] && [ -n "${KN_SECRETS_DIR:-}" ]; then
      candidate="${KN_SECRETS_DIR}/$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
      if [ -f "$candidate" ]; then file="$candidate"; fi
    fi
    [ -n "$file" ] || continue
    [ -z "$current" ] || fail "$name and ${name}_FILE are both set; use one"
    [ -r "$file" ] || fail "${name}_FILE is not a readable file"
    value=$(cat "$file")
    [ -n "$value" ] || fail "${name}_FILE is empty"
    export "$name=$value"
    unset "${name}_FILE"
  done
}

# Validates the configuration and waits for the effective database/Redis (see the header, step 3).
startup_gate() {
  node "${KN_STARTUP_GATE:-/usr/local/lib/kabuki-startup-gate.cjs}"
}

case "$role" in
  api)
    load_secret_files
    if [ "${DEPLOYMENT_TOPOLOGY:-single}" = "multi" ]; then
      [ -n "${JWT_ACCESS_SECRET:-}" ] && [ -n "${JWT_REFRESH_SECRET:-}" ] ||
        fail "DEPLOYMENT_TOPOLOGY=multi needs the same JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (or *_FILE) on every API node"
    fi
    startup_gate
    cd /app
    exec node dist/main.js "$@"
    ;;
  web)
    cd /app/apps/web
    exec node server.js "$@"
    ;;
  *)
    fail "usage: kabuki-entrypoint api|web"
    ;;
esac
