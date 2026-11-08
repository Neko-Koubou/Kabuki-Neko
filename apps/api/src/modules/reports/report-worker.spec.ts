/**
 * TASK-084 coverage on SQLite with a real game played through the memory store: competing workers
 * claim a job exactly once, a crashed worker's lease expires and is taken over (its late write is
 * refused), leases are renewed while writing, durable jobs survive a process restart, five
 * automated backoffs (1/5/30/120/600 s) end in manual retry, the concurrency limit holds, and the
 * room state / host listener only see `ready` + reportId after the history transaction committed.
 * Scheduler recovery (`GameService.syncFinalization` → `ReportWorker.sync`) re-enqueues a report
 * whose enqueue failed during a database outage.
 */
import { randomUUID } from "node:crypto";
import {
  AuthRepository,
  JobsRepository,
  QuizzesRepository,
  ReportsRepository,
  RuntimeRepository,
  SettingsRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type FinalizationJob,
} from "@kabuki-neko/database";
import { FINALIZATION_LIMITS } from "@kabuki-neko/shared/constants/limits";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import type {
  FrozenReport,
  HostCommand,
  RoomIdentity,
} from "../../providers/state/game-state.interface";
import { MemoryStateStore } from "../../providers/state/memory-state.store";
import { RefreshService } from "../auth/refresh.service";
import { GameService } from "../game-engine/game.service";
import { RecoveryService } from "../game-engine/recovery.service";
import { projectRoom } from "../game-engine/room-projector";
import { RoomRegistryService } from "../game-engine/room-registry.service";
import { FINALIZATION_SYNC_MS, RoomScheduler } from "../game-engine/room-scheduler";
import { ReportFinalizer } from "./report-finalizer";
import { ReportWorker, jobIdentity, statusFromJob } from "./report-worker";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
const runtime = new RuntimeRepository(db);
const jobs = new JobsRepository(db);
const reports = new ReportsRepository(db);
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: "a".repeat(64),
  refreshSecret: "b".repeat(64),
});
let jwt: JwtGuard;
let refresh: RefreshService;
let host: VerifiedPrincipal;
let now = 0;
const clock = () => now;
let store: MemoryStateStore;
let finalizer: ReportFinalizer;
let game: GameService;
const workers: ReportWorker[] = [];

/** New worker sharing the database and the current state store (one per simulated process). */
function worker(stateStore: MemoryStateStore = store): ReportWorker {
  const created = new ReportWorker(
    jobs,
    new ReportFinalizer(jobs, reports, stateStore, clock),
    stateStore,
    config,
    clock,
  );
  workers.push(created);
  return created;
}
/** Persisted history sessions for a session ID. */
const sessions = (id: string) => db.manager.countBy("game_sessions", { id });
/** Current durable job row. */
const job = (id: string) =>
  db.manager.getRepository<FinalizationJob>("finalization_jobs").findOneByOrFail({
    session_id: id,
  });
/** Finalization status currently held in the room state. */
const roomStatus = async (identity: RoomIdentity) =>
  (await store.getPrivateSnapshot(identity))?.finalization ?? null;

/**
 * Plays a two-question game (one answered, then ended early) through the real engine. The report
 * hook is the finalizer's enqueue, exactly as the module wires it; returns the frozen report.
 */
async function play(): Promise<{ identity: RoomIdentity; report: FrozenReport }> {
  let frozen: FrozenReport | null = null;
  game.setReportHook(async (identity, report) => {
    frozen = report;
    await finalizer.enqueue(identity, report);
  });
  const rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  const recovery = new RecoveryService(runtime, settings, store);
  const quizId = await quizzes.create(host.user.id, { title: "Worker quiz" }, 1);
  const source = await quizzes.read(host.user.id, quizId);
  const base = source.content.questions[0];
  if (!base) throw new Error("draft missing");
  const write = quizWriteSchema.parse({
    ...source.content,
    questions: [0, 1].map((orderIndex) => ({
      ...base,
      id: orderIndex === 0 ? base.id : randomUUID(),
      orderIndex,
      promptText: `Q${orderIndex}`,
      options: base.options.map((o, i) => ({
        ...o,
        id: orderIndex === 0 ? o.id : randomUUID(),
        optionText: `O${i}`,
      })),
    })),
  });
  const revision = await quizzes.save(host.user.id, quizId, 1, write, 2);
  const ack = await rooms.createRoom(host, {
    requestId: randomUUID(),
    quizId,
    quizRevision: revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  const identity = { pin: ack.pinCode, sessionId: ack.sessionId };
  const { binding } = await recovery.join(
    {
      requestId: randomUUID(),
      pinCode: ack.pinCode,
      nickname: "Ann",
      avatar: { style: "bottts", seed: "Ann" },
    },
    { connectionId: randomUUID(), ip: "192.0.2.4" },
  );
  const command = async (event: HostCommand["event"]) => {
    const s = await store.getPrivateSnapshot(identity);
    return game.hostCommand(host, {
      event,
      request: {
        requestId: randomUUID(),
        sessionId: identity.sessionId,
        pinCode: identity.pin,
        expectedPhaseVersion: s?.phaseVersion ?? 1,
      },
    } as HostCommand);
  };
  await command("host:start_game");
  now += 3_000;
  await game.tick(identity, now);
  now += 4_000;
  await game.tick(identity, now);
  const question = (await store.getPrivateSnapshot(identity))?.quiz.questions[0];
  await game.submitAnswer(binding, {
    questionIndex: 0,
    questionId: question?.id ?? "",
    submissionId: randomUUID(),
    answer: question?.publicToPrivateOptionIds.indexOf(question.options[0]?.id ?? "") ?? 0,
  });
  await command("host:end_game");
  if (!frozen) throw new Error("report not frozen");
  return { identity, report: frozen };
}

beforeAll(async () => {
  refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
  jwt = new JwtGuard(refresh);
  await db.initialize();
  await migrateDatabase(db, true);
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "Host",
    email: "worker@example.org",
    password_hash: "fixture",
    created_at: 1,
    updated_at: 1,
  });
  host = await jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of [
    "player_answers",
    "game_players",
    "session_questions",
    "game_sessions",
    "finalization_jobs",
    "request_dedup",
    "room_media",
    "room_allocations",
  ])
    await db.manager.clear(table);
  now = Date.now();
  store = new MemoryStateStore(projectRoom, clock);
  finalizer = new ReportFinalizer(jobs, reports, store, clock);
  game = new GameService(store, jwt, clock);
});
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("lets exactly one of two competing workers write the report, publishing only after commit", async () => {
  const { identity } = await play();
  expect(await roomStatus(identity)).toMatchObject({ status: "pending", reportId: null });
  const seen: Array<{ status: FinalizeStatus; persisted: number }> = [];
  const [a, b] = [worker(), worker()];
  for (const w of [a, b])
    w.setStatusListener(async (_identity, status) => {
      seen.push({ status, persisted: await sessions(status.sessionId) });
    });
  const outcomes = await Promise.all([a.runOnce(), b.runOnce()]);
  expect(outcomes.filter((o) => o === "READY")).toHaveLength(1);
  expect(outcomes.filter((o) => o === null)).toHaveLength(1);
  expect(await sessions(identity.sessionId)).toBe(1);
  expect((await job(identity.sessionId)).state).toBe("READY");
  // The single ready notification carries the stable reportId and arrives after the commit.
  expect(seen).toEqual([
    {
      status: expect.objectContaining({ status: "ready", reportId: identity.sessionId }),
      persisted: 1,
    },
  ]);
  expect(await roomStatus(identity)).toMatchObject({
    status: "ready",
    reportId: identity.sessionId,
    retryable: false,
  });
  // A READY job is never claimed again, and the durable room can now be released.
  expect(await a.runOnce()).toBeNull();
  expect(await store.releaseRoom(identity)).toBe(true);
});

it("takes over a crashed worker's job only after its 30 s lease and refuses the stale write", async () => {
  const { identity } = await play();
  const crashed = await jobs.claim(now);
  if (!crashed) throw new Error("job not claimable");
  const survivor = worker();
  now += FINALIZATION_LIMITS.leaseMs - 1;
  expect(await survivor.runOnce()).toBeNull();
  expect(await sessions(identity.sessionId)).toBe(0);
  now += 2;
  const takenOver = await jobs.claim(now);
  if (!takenOver) throw new Error("expired lease not re-claimable");
  expect(takenOver.lease_owner).not.toBe(crashed.lease_owner);
  // The crashed process comes back while the job belongs to someone else: refused, nothing written.
  expect(await worker().process(crashed)).toBe("LEASE_LOST");
  expect(await sessions(identity.sessionId)).toBe(0);
  expect(await survivor.process(takenOver)).toBe("READY");
  // Once READY, a late write with the same payload is idempotent and never duplicates history.
  expect(await worker().process(crashed)).toBe("READY");
  expect(await sessions(identity.sessionId)).toBe(1);
  expect(await db.manager.countBy("game_players", { session_id: identity.sessionId })).toBe(1);
  expect(await roomStatus(identity)).toMatchObject({ status: "ready" });
});

it("renews the lease every 10 s while a slow write runs", async () => {
  const { identity } = await play();
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
  const w = worker();
  const claimed = await jobs.claim(now);
  if (!claimed) throw new Error("job not claimable");
  const leaseUntil = claimed.lease_until ?? 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const persist = jest
    .spyOn(ReportFinalizer.prototype, "persist")
    .mockImplementationOnce(async function (this: ReportFinalizer, j) {
      await gate;
      return ReportFinalizer.prototype.persist.call(this, j);
    });
  const running = w.process(claimed);
  now += FINALIZATION_LIMITS.renewalMs;
  await jest.advanceTimersByTimeAsync(FINALIZATION_LIMITS.renewalMs);
  await new Promise((resolve) => setImmediate(resolve));
  expect((await job(identity.sessionId)).lease_until).toBe(now + FINALIZATION_LIMITS.leaseMs);
  expect((await job(identity.sessionId)).lease_until).toBeGreaterThan(leaseUntil);
  // Past the original lease, but the renewed one is still valid, so the write succeeds.
  now += FINALIZATION_LIMITS.leaseMs - FINALIZATION_LIMITS.renewalMs + 1;
  await jest.advanceTimersByTimeAsync(FINALIZATION_LIMITS.renewalMs);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  expect(await running).toBe("READY");
  expect(persist).toHaveBeenCalledTimes(2);
});

it("finishes durable jobs after a process restart even though the memory state is gone", async () => {
  const { identity, report } = await play();
  // Restart: a fresh process has an empty memory store and a new worker.
  const restarted = worker(new MemoryStateStore(projectRoom, clock));
  const statuses: Array<[RoomIdentity | null, FinalizeStatus]> = [];
  restarted.setStatusListener(async (id, status) => {
    statuses.push([id, status]);
  });
  expect(await restarted.runOnce()).toBe("READY");
  expect(await sessions(identity.sessionId)).toBe(1);
  expect(statuses).toEqual([
    [identity, expect.objectContaining({ status: "ready", reportId: identity.sessionId })],
  ]);
  expect(jobIdentity({ payload: report as unknown as Record<string, unknown> })).toEqual(identity);
  expect(jobIdentity({ payload: { invalid: true } })).toBeNull();
});

it("retries after 1/5/30/120/600 s, then waits for a manual retry that resets the attempts", async () => {
  const { identity } = await play();
  const w = worker();
  const statuses: FinalizeStatus[] = [];
  w.setStatusListener(async (_identity, status) => {
    statuses.push(status);
  });
  const insert = jest.spyOn(reports, "persist").mockRejectedValue(new Error("disk full"));
  expect(await w.runOnce()).toBe("FAILED");
  for (const delay of FINALIZATION_LIMITS.retryDelaysMs) {
    now += delay - 1;
    expect(await w.runOnce()).toBeNull();
    now += 1;
    expect(await w.runOnce()).toBe("FAILED");
  }
  expect(await job(identity.sessionId)).toMatchObject({
    state: "FAILED",
    attempts: FINALIZATION_LIMITS.automatedAttempts + 1,
    last_error_code: "REPORT_SAVE_FAILED",
  });
  // Exhausted: nothing more happens automatically, however long we wait.
  now += 24 * 3_600_000;
  expect(await w.runOnce()).toBeNull();
  expect(insert).toHaveBeenCalledTimes(FINALIZATION_LIMITS.automatedAttempts + 1);
  expect(await roomStatus(identity)).toMatchObject({
    status: "failed",
    retryable: true,
    reportId: null,
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(statuses.every((s) => s.status === "failed" && s.reportId === null)).toBe(true);
  expect(await sessions(identity.sessionId)).toBe(0);
  expect(await store.releaseRoom(identity)).toBe(false);
  // Only the owning host can reset it.
  expect(await w.manualRetry(identity.sessionId, randomUUID(), identity)).toBeNull();
  insert.mockRestore();
  expect(await w.manualRetry(identity.sessionId, host.user.id, identity)).toMatchObject({
    status: "pending",
    retryable: true,
  });
  expect(await job(identity.sessionId)).toMatchObject({ state: "PENDING", attempts: 0 });
  expect(await w.runOnce()).toBe("READY");
  expect(await roomStatus(identity)).toMatchObject({ status: "ready" });
  expect(await w.manualRetry(identity.sessionId, host.user.id, identity)).toBeNull();
});

it("never runs more jobs than FINALIZE_CONCURRENCY and drains a backlog when started", async () => {
  const identities = [];
  for (let i = 0; i < 3; i++) identities.push((await play()).identity);
  let running = 0;
  let peak = 0;
  const original = ReportFinalizer.prototype.persist;
  jest.spyOn(ReportFinalizer.prototype, "persist").mockImplementation(async function (
    this: ReportFinalizer,
    j,
  ) {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await original.call(this, j);
    } finally {
      running--;
    }
  });
  const w = worker();
  w.start();
  expect(w.active).toBeLessThanOrEqual(config.values.FINALIZE_CONCURRENCY);
  for (let i = 0; i < 100; i++) {
    const done = await db.manager.countBy("finalization_jobs", { state: "READY" });
    if (done === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await w.stop();
  expect(peak).toBe(config.values.FINALIZE_CONCURRENCY);
  for (const identity of identities) expect(await sessions(identity.sessionId)).toBe(1);
});

it("re-enqueues a report whose enqueue failed through scheduler recovery sync", async () => {
  const w = worker();
  game.setFinalizationSync((identity, report, current) =>
    w.sync(identity, report, current).then(() => undefined),
  );
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  const { identity, report } = await play();
  expect(await roomStatus(identity)).toMatchObject({
    status: "failed",
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(await db.manager.count("finalization_jobs")).toBe(0);
  // Still down at the first scheduler sync: stays failed/retryable, frozen report kept.
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  expect(await game.syncFinalization(identity)).toBe(true);
  expect(await store.releaseRoom(identity)).toBe(false);
  // Database back: the job is created, the state becomes durable and pending.
  expect(await game.syncFinalization(identity)).toBe(true);
  expect(await roomStatus(identity)).toMatchObject({ status: "pending", errorCode: null });
  expect(await w.runOnce()).toBe("READY");
  expect(await game.syncFinalization(identity)).toBe(false);
  // A READY job whose state update was lost is mirrored on the next sync.
  expect(await w.sync(identity, report, null)).toMatchObject({
    status: "ready",
    reportId: identity.sessionId,
  });
  expect(
    statusFromJob({ session_id: identity.sessionId, state: "RUNNING", last_error_code: null }, now),
  ).toMatchObject({ status: "pending", reportId: null });
});

it("lets the room scheduler re-drive finalization at most every 5 s until the room is released", async () => {
  const w = worker();
  game.setFinalizationSync((identity, report, current) =>
    w.sync(identity, report, current).then(() => undefined),
  );
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  const { identity } = await play();
  const rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  const scheduler = new RoomScheduler(runtime, rooms, store, game, config, clock);
  const sync = jest.spyOn(game, "syncFinalization");
  const row = async () => {
    const found = (await runtime.active(null)).find((r) => r.id === identity.sessionId);
    if (!found) throw new Error("allocation missing");
    return found;
  };
  await scheduler.visit(await row(), now);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await roomStatus(identity)).toMatchObject({ status: "pending" });
  await scheduler.visit(await row(), now + FINALIZATION_SYNC_MS - 1);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await w.runOnce()).toBe("READY");
  // Ready rooms are not synced again; after the 1 h FINISHED retention the room is released.
  now += 8_000;
  await scheduler.visit(await row(), now);
  expect(sync).toHaveBeenCalledTimes(1);
  now += 3_600_000;
  await scheduler.visit(await row(), now);
  expect(await store.getPrivateSnapshot(identity)).toBeNull();
  await scheduler.onModuleDestroy();
});
