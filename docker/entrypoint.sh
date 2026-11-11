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
#    read into the variable. Setting both forms is an error. Nothing is ever printed.
# 2. Shared secrets: with DEPLOYMENT_TOPOLOGY=multi, every node must sign and verify the same
#    tokens, so JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (or their _FILE forms) are required.
#    A per-node generated secret file would silently split the sessions.
# 3. Configuration check: the compiled environment schema validates the environment. On failure
#    only the invalid field names are reported.
# 4. Bounded migration gate: an external database (and Redis) must accept TCP connections within
#    KN_STARTUP_WAIT_SEC seconds (default 60). Only then does the API start, and it applies
#    migrations under its migration lock (DB_AUTO_MIGRATE). A timeout exits non-zero so the
#    orchestrator restarts the container instead of hanging.
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
    [ -n "$file" ] || continue
    eval "current=\${${name}:-}"
    [ -z "$current" ] || fail "$name and ${name}_FILE are both set; use one"
    [ -r "$file" ] || fail "${name}_FILE is not a readable file"
    value=$(cat "$file")
    [ -n "$value" ] || fail "${name}_FILE is empty"
    export "$name=$value"
    unset "${name}_FILE"
  done
}

# Validates the environment with the API's compiled schema; prints only invalid field names.
check_api_config() {
  node -e '
    const { parseEnvironment, ConfigurationError } = require("/app/dist/config/env.schema.js");
    try {
      parseEnvironment(process.env);
    } catch (error) {
      const fields = error instanceof ConfigurationError ? error.fields.join(", ") : "unknown";
      process.stderr.write(`kabuki-entrypoint: invalid configuration: ${fields}\n`);
      process.exit(1);
    }
  '
}

# Waits until host:port of `url` accepts TCP connections, at most KN_STARTUP_WAIT_SEC seconds.
wait_for() {
  label="$1"
  url="$2"
  KN_WAIT_URL="$url" KN_WAIT_LABEL="$label" node -e '
    const net = require("node:net");
    const limit = Number(process.env.KN_STARTUP_WAIT_SEC || "60") * 1000;
    const url = new URL(process.env.KN_WAIT_URL);
    const defaults = { "postgres:": 5432, "postgresql:": 5432, "mysql:": 3306, "redis:": 6379, "rediss:": 6379 };
    const port = Number(url.port || defaults[url.protocol] || 0);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const deadline = Date.now() + limit;
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(2000);
      socket.once("connect", () => { socket.destroy(); process.exit(0); });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) {
          process.stderr.write(`kabuki-entrypoint: ${process.env.KN_WAIT_LABEL} not reachable within ${limit / 1000} s\n`);
          process.exit(1);
        }
        setTimeout(attempt, 1000);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  '
}

case "$role" in
  api)
    load_secret_files
    if [ "${DEPLOYMENT_TOPOLOGY:-single}" = "multi" ]; then
      [ -n "${JWT_ACCESS_SECRET:-}" ] && [ -n "${JWT_REFRESH_SECRET:-}" ] ||
        fail "DEPLOYMENT_TOPOLOGY=multi needs the same JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (or *_FILE) on every API node"
    fi
    check_api_config
    case "${DB_DRIVER:-sqlite}" in
      postgres | mysql) wait_for "database" "${DATABASE_URL:?DATABASE_URL is required for ${DB_DRIVER}}" ;;
    esac
    if [ "${STATE_DRIVER:-memory}" = "redis" ] && [ -n "${REDIS_URL:-}" ]; then
      wait_for "redis" "$REDIS_URL"
    fi
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
