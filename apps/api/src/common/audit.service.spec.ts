import { randomUUID } from "node:crypto";
import {
  AuditRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { AuditService } from "./audit.service";
import { MetricsService } from "./metrics.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.manager.clear("audit_events");
});
const event = () => ({
  actorType: "USER",
  actorId: randomUUID(),
  action: "quiz.import",
  resourceId: randomUUID(),
  outcome: "SUCCESS",
  correlationId: randomUUID(),
});
it("projects allowlisted fields to SQL and UTC stdout without credential or content canaries", async () => {
  const output: string[] = [],
    repository = new AuditRepository(db);
  const service = new AuditService(
    repository,
    new MetricsService(),
    30,
    (line) => {
      output.push(line);
    },
    () => 1700000000000,
  );
  const canary = "TOP-SECRET-CANARY";
  await service.record({
    ...event(),
    password: canary,
    email: `${canary}@test.example`,
    nickname: canary,
    answer: canary,
    headers: { authorization: canary },
    accessToken: canary,
    refreshToken: canary,
    url: `https://example.test/file?signature=${canary}`,
    error: new Error(canary),
  });
  const sql = await db.manager.find("audit_events");
  expect(sql).toHaveLength(1);
  expect(JSON.stringify({ output, sql })).not.toContain(canary);
  expect(output[0]).toContain('"occurredAt":"2023-11-14T22:13:20.000Z"');
  await expect(service.record({ ...event(), action: canary })).rejects.toMatchObject({
    errorCode: "VALIDATION_FAILED",
  });
  await expect(
    service.record({ ...event(), resourceId: `https://example.test/?secret=${canary}` }),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  expect(output).toHaveLength(1);
});
it.each([7, 365])("purges at %i days in batches of at most 1000", async (days) => {
  const now = (days + 2) * 86400000,
    repository = new AuditRepository(db);
  const audit = new AuditService(
    repository,
    new MetricsService(),
    days,
    () => undefined,
    () => now,
  );
  const sample = event();
  for (let i = 0; i < 1001; i++)
    await repository.append({ ...sample, actorType: "USER", outcome: "SUCCESS" }, 1);
  await repository.append({ ...sample, actorType: "USER", outcome: "SUCCESS" }, now);
  expect(await audit.purge()).toBe(1000);
  expect(await audit.purge()).toBe(1);
  expect(await audit.purge()).toBe(0);
  expect(await db.manager.count("audit_events")).toBe(1);
});
it("fails safely on SQL failure and rejects out-of-range retention", async () => {
  const repository = new AuditRepository(db),
    metrics = new MetricsService();
  const service = new AuditService(repository, metrics, 30, () => undefined);
  const append = jest
    .spyOn(repository, "append")
    .mockRejectedValue(new Error("SELECT PASSWORD_SECRET"));
  await expect(service.record(event())).rejects.toMatchObject({
    errorCode: "DEPENDENCY_UNAVAILABLE",
    message: "DEPENDENCY_UNAVAILABLE",
  });
  expect(metrics.snapshot().counters.audit_failures).toBeUndefined();
  expect(metrics.snapshot().counters["audit_failures:DEPENDENCY_UNAVAILABLE"]).toBe(1);
  for (const value of [6, 366, 7.5])
    expect(() => new AuditService(repository, metrics, value)).toThrow("Invalid audit retention");
  append.mockRestore();
});
it("keeps bounded metrics and emits a throttled failed-job alarm without job payloads", () => {
  let now = 1700000000000;
  const lines: string[] = [];
  const metrics = new MetricsService(
    (line) => {
      lines.push(line);
    },
    () => now,
  );
  metrics.increment("answers_rejected", "TIME_EXPIRED");
  metrics.observe("broadcast_latency_ms", 25);
  metrics.reportJobFailed("REPORT_SAVE_FAILED");
  metrics.reportJobFailed("REPORT_SAVE_FAILED");
  expect(lines).toHaveLength(1);
  now += 60000;
  metrics.reportJobFailed("REPORT_SAVE_FAILED");
  expect(lines).toHaveLength(2);
  expect(metrics.snapshot().counters["report_queue_failures:REPORT_SAVE_FAILED"]).toBe(3);
  expect(() => metrics.observe("broadcast_latency_ms", NaN)).toThrow();
  const snapshot = metrics.snapshot();
  snapshot.counters["answers_rejected:TIME_EXPIRED"] = 99;
  expect(metrics.snapshot().counters["answers_rejected:TIME_EXPIRED"]).toBe(1);
});
it("runs daily retention and cancels its scheduler on shutdown", async () => {
  jest.useFakeTimers();
  const repository = new AuditRepository(db);
  const purge = jest.spyOn(repository, "purge").mockResolvedValue(0);
  const service = new AuditService(repository, new MetricsService(), 7, () => undefined);
  try {
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(purge).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(86400000);
    expect(purge).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(86400000);
    expect(purge).toHaveBeenCalledTimes(2);
  } finally {
    await service.onModuleDestroy();
    jest.useRealTimers();
    purge.mockRestore();
  }
});
