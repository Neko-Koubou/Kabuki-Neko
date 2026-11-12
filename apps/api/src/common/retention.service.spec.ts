/**
 * RetentionService (code review MJ-01): batched purge of audit events, expired idempotency
 * receipts and expired refresh tokens on a real migrated SQLite database, plus the scheduler
 * lifecycle and failure isolation.
 */
import { randomUUID } from "node:crypto";
import {
  AuditRepository,
  AuthRepository,
  OperationsRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { AuditService } from "./audit.service";
import { MetricsService } from "./metrics.service";
import { RETENTION_INTERVAL_MS, RetentionService } from "./retention.service";

const DAY = 86_400_000;
const NOW = 400 * DAY;
const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const audits = new AuditRepository(db);
const operations = new OperationsRepository(db);
const accounts = new AuthRepository(db);
/** Builds the service under test on a fixed clock with captured stderr lines. */
function service(lines: string[] = [], clock = () => NOW) {
  const audit = new AuditService(audits, new MetricsService(), 30, () => undefined, clock);
  return new RetentionService(audit, operations, accounts, clock, (line) => lines.push(line));
}
/** Inserts `count` rows into `table` built by `row(i)`, in chunks SQLite accepts. */
async function seed(table: string, count: number, row: (i: number) => Record<string, unknown>) {
  const rows = Array.from({ length: count }, (_, i) => row(i));
  for (let i = 0; i < rows.length; i += 200) await db.manager.insert(table, rows.slice(i, i + 200));
}
let userId = "";
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
  userId = randomUUID();
  await db.manager.insert("users", {
    id: userId,
    email: "retention@example.org",
    name: "Retention",
    password_hash: "x".repeat(97),
    role: "CREATOR",
    is_active: true,
    auth_version: 1,
    revision: 1,
    created_at: 0,
    updated_at: 0,
  });
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of ["audit_events", "request_dedup", "refresh_tokens"])
    await db.manager.clear(table);
});

it("drains every table in batches of 1000 and keeps live rows", async () => {
  await seed("audit_events", 2500, (i) => ({
    id: randomUUID(),
    settings_id: "global",
    occurred_at: i,
    actor_type: "ANONYMOUS",
    action: "auth.login.failure",
    outcome: "FAILURE",
    correlation_id: randomUUID(),
  }));
  await seed("audit_events", 3, () => ({
    id: randomUUID(),
    settings_id: "global",
    occurred_at: NOW,
    actor_type: "ANONYMOUS",
    action: "auth.login.failure",
    outcome: "FAILURE",
    correlation_id: randomUUID(),
  }));
  const receipt = (state: string, expires: number) => ({
    id: randomUUID(),
    actor_scope: "setup",
    operation: "auth.setup",
    key: randomUUID(),
    request_hash: "0".repeat(64),
    state,
    expires_at: expires,
    created_at: 0,
  });
  await seed("request_dedup", 1200, () => receipt("DONE", NOW - 1));
  await seed("request_dedup", 2, () => receipt("PENDING", NOW - 1));
  await seed("request_dedup", 2, () => receipt("DONE", NOW + DAY));
  const token = (expires: number) => ({
    id: randomUUID(),
    user_id: userId,
    family_id: randomUUID(),
    token_hash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    issued_at: 0,
    expires_at: expires,
  });
  await seed("refresh_tokens", 1500, () => token(NOW - 2 * DAY));
  await seed("refresh_tokens", 2, () => token(NOW - DAY / 2));

  const result = await service().runOnce();
  expect(result).toEqual({ audit_events: 2500, request_dedup: 1200, refresh_tokens: 1500 });
  expect(await db.manager.count("audit_events")).toBe(3);
  expect(await db.manager.count("request_dedup")).toBe(4);
  expect(await db.manager.count("refresh_tokens")).toBe(2);
  expect((await service().runOnce()).audit_events).toBe(0);
});

it("stops at the time budget and leaves the rest for the next run", async () => {
  await seed("audit_events", 2100, (i) => ({
    id: randomUUID(),
    settings_id: "global",
    occurred_at: i,
    actor_type: "ANONYMOUS",
    action: "auth.login.failure",
    outcome: "FAILURE",
    correlation_id: randomUUID(),
  }));
  let tick = NOW;
  const clock = () => (tick += 20_000);
  expect((await service([], clock).runOnce(30_000)).audit_events).toBe(1000);
  expect(await db.manager.count("audit_events")).toBe(1100);
});

it("logs a failing purge without internals and still runs the others", async () => {
  const lines: string[] = [];
  const failing = jest
    .spyOn(operations, "purge")
    .mockRejectedValue(new Error("SQLITE secret path"));
  try {
    const result = await service(lines).runOnce();
    expect(result.request_dedup).toBe(0);
    expect(lines).toEqual([
      JSON.stringify({ level: "error", event: "retention_purge_failed", table: "request_dedup" }),
    ]);
  } finally {
    failing.mockRestore();
  }
});

it("runs at boot and hourly, one run at a time, and stops on shutdown", async () => {
  jest.useFakeTimers();
  const retention = service();
  const run = jest.spyOn(retention, "runOnce");
  try {
    retention.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await retention.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    await retention.onModuleDestroy();
    jest.useRealTimers();
    run.mockRestore();
  }
});
