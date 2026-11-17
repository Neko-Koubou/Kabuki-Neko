/**
 * API startup gate (docker/entrypoint.sh; code review MJ-17, MN-36).
 *
 * 1. Validates the environment with the API's compiled schema. Only the invalid field names are
 *    printed, never values.
 * 2. Waits until the external database and Redis selected by the *effective* configuration accept
 *    TCP connections. The drivers come from the parsed schema, so `DEPLOYMENT_PROFILE=scale`
 *    (PostgreSQL + Redis by default) is gated even when DB_DRIVER/STATE_DRIVER are not set, which
 *    is how the Compose scale profile runs. SQLite and the memory state store need no wait.
 * 3. The wait is bounded by KN_STARTUP_WAIT_SEC (integer 1–3600, default 60); a timeout or an
 *    invalid value exits 1 so the orchestrator restarts the container instead of hanging.
 *
 * Exit codes: 0 ready, 1 invalid configuration or unreachable dependency.
 * KN_ENV_SCHEMA_MODULE overrides the compiled schema path (tests); the image uses the default.
 */
"use strict";
const net = require("node:net");
const { setTimeout } = require("node:timers");
const { URL } = require("node:url");

/** Writes one prefixed line to stderr and exits 1. */
function fail(message) {
  process.stderr.write(`kabuki-entrypoint: ${message}\n`);
  process.exit(1);
}

/** Default ports of the URL schemes the API supports for its database and Redis. */
const DEFAULT_PORTS = {
  "postgres:": 5432,
  "postgresql:": 5432,
  "mysql:": 3306,
  "redis:": 6379,
  "rediss:": 6379,
};

/** Resolves once `url` accepts a TCP connection; rejects after `deadline` (epoch ms). */
function reachable(url, deadline) {
  const parsed = new URL(url);
  const port = Number(parsed.port || DEFAULT_PORTS[parsed.protocol] || 0);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(2000);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("timeout"));
        else setTimeout(attempt, Math.max(0, Math.min(1000, deadline - Date.now())));
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function main() {
  // Unset or empty (e.g. an empty Compose interpolation) means the default.
  const rawWait = process.env.KN_STARTUP_WAIT_SEC || "60";
  if (!/^[0-9]{1,4}$/.test(rawWait) || Number(rawWait) < 1 || Number(rawWait) > 3600)
    fail("KN_STARTUP_WAIT_SEC must be an integer from 1 to 3600");
  const seconds = Number(rawWait);

  const { parseEnvironment, ConfigurationError } = require(
    process.env.KN_ENV_SCHEMA_MODULE || "/app/dist/config/env.schema.js",
  );
  let config;
  try {
    config = parseEnvironment(process.env);
  } catch (error) {
    const fields = error instanceof ConfigurationError ? error.fields.join(", ") : "unknown";
    fail(`invalid configuration: ${fields}`);
  }

  const targets = [];
  if (config.DB_DRIVER === "postgres" || config.DB_DRIVER === "mysql")
    targets.push(["database", config.DATABASE_URL]);
  if (config.STATE_DRIVER === "redis") {
    if (config.REDIS_URL) targets.push(["redis", config.REDIS_URL]);
    for (const node of config.REDIS_CLUSTER_NODES) targets.push(["redis cluster node", node]);
  }
  const deadline = Date.now() + seconds * 1000;
  for (const [label, url] of targets) {
    try {
      await reachable(url, deadline);
    } catch {
      fail(`${label} not reachable within ${seconds} s`);
    }
  }
}

main().catch(() => fail("startup gate failed"));
