/**
 * API startup gate (docker/startup-gate.cjs; code review MJ-17, MN-36), run as the image runs it
 * but against the locally compiled schema (`pnpm --filter @kabuki-neko/api build` first).
 *
 * - With only DEPLOYMENT_PROFILE=scale (no DB_DRIVER/STATE_DRIVER, as Compose sets it) the gate
 *   waits for PostgreSQL and Redis and fails after KN_STARTUP_WAIT_SEC when they are down.
 * - It passes as soon as both accept TCP connections.
 * - The default profile (SQLite, memory state) needs no wait.
 * - An invalid KN_STARTUP_WAIT_SEC or configuration fails fast, naming fields only.
 */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const ROOT = path.resolve(__dirname, "../..");
const GATE = path.join(ROOT, "docker/startup-gate.cjs");
const SCHEMA = path.join(ROOT, "apps/api/dist/config/env.schema.js");
const run = promisify(execFile);

/** Runs the gate with `env` on top of a minimal test environment. */
async function gate(env: Record<string, string>) {
  try {
    await run(process.execPath, [GATE], {
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        KN_ENV_SCHEMA_MODULE: SCHEMA,
        STORAGE_DRIVER: "local",
        ...env,
      },
      timeout: 20_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, stderr: failure.stderr };
  }
}

/** A TCP listener on a free local port. */
async function listener(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const { server, port } = await listener();
  server.close();
  await once(server, "close");
  return port;
}

jest.setTimeout(60_000);

it("gates the scale profile's PostgreSQL even without DB_DRIVER and times out", async () => {
  const port = await closedPort();
  const started = Date.now();
  const outcome = await gate({
    DEPLOYMENT_PROFILE: "scale",
    DATABASE_URL: `postgres://kabuki:secret-password@127.0.0.1:${port}/kabuki`,
    REDIS_URL: `redis://127.0.0.1:${port}`,
    KN_STARTUP_WAIT_SEC: "1",
  });
  expect(outcome.code).toBe(1);
  expect(outcome.stderr).toBe("kabuki-entrypoint: database not reachable within 1 s\n");
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(outcome.stderr).not.toContain("secret-password");
});

it("passes once the scale profile's database and Redis accept connections", async () => {
  const database = await listener();
  const redis = await listener();
  try {
    const outcome = await gate({
      DEPLOYMENT_PROFILE: "scale",
      DATABASE_URL: `postgres://kabuki:secret@127.0.0.1:${database.port}/kabuki`,
      REDIS_URL: `redis://127.0.0.1:${redis.port}`,
      KN_STARTUP_WAIT_SEC: "5",
    });
    expect(outcome).toEqual({ code: 0, stderr: "" });
  } finally {
    database.server.close();
    redis.server.close();
  }
  // Redis down while the database is up: the scale profile's state store is gated too.
  const up = await listener();
  try {
    const outcome = await gate({
      DEPLOYMENT_PROFILE: "scale",
      DATABASE_URL: `postgres://kabuki:secret@127.0.0.1:${up.port}/kabuki`,
      REDIS_URL: `redis://127.0.0.1:${await closedPort()}`,
      KN_STARTUP_WAIT_SEC: "1",
    });
    expect(outcome.stderr).toBe("kabuki-entrypoint: redis not reachable within 1 s\n");
  } finally {
    up.server.close();
  }
});

it("needs no wait for the default profile", async () => {
  expect(await gate({ KN_STARTUP_WAIT_SEC: "1" })).toEqual({ code: 0, stderr: "" });
  // An empty value (unset Compose interpolation) means the default.
  expect(await gate({ KN_STARTUP_WAIT_SEC: "" })).toEqual({ code: 0, stderr: "" });
});

it("rejects an invalid wait or configuration without printing values", async () => {
  for (const wait of ["abc", "0", "3601", "1.5", "-5"])
    expect(await gate({ KN_STARTUP_WAIT_SEC: wait })).toEqual({
      code: 1,
      stderr: "kabuki-entrypoint: KN_STARTUP_WAIT_SEC must be an integer from 1 to 3600\n",
    });
  const outcome = await gate({ DB_DRIVER: "postgres", DATABASE_URL: "not a url secret-value" });
  expect(outcome.code).toBe(1);
  expect(outcome.stderr).toBe("kabuki-entrypoint: invalid configuration: DATABASE_URL\n");
});
