/**
 * TASK-081 coverage with a fake clock shared by the memory store, game service and schedulers:
 * exact countdown/preview/grace/podium boundaries driven only by scans (no host action → no
 * pause), lease ownership between two instances with takeover after expiry, missing state → LOST
 * and later release, lobby idle and hard expiry, retention of a non-durable frozen report, and the
 * single 24 h pending-finalization alarm.
 */
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  AuthRepository,
  QuizzesRepository,
  RuntimeRepository,
  SettingsRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { ROOM_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { MetricsService } from "../../common/metrics.service";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import type { HostCommand, RoomIdentity } from "../../providers/state/game-state.interface";
import { MemoryStateStore } from "../../providers/state/memory-state.store";
import { RefreshService } from "../auth/refresh.service";
import { GameService } from "./game.service";
import { RecoveryService } from "./recovery.service";
import { projectRoom } from "./room-projector";
import { RoomRegistryService } from "./room-registry.service";
import { RoomScheduler, nextDeadline } from "./room-scheduler";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
const runtime = new RuntimeRepository(db);
/** Config for one simulated instance. */
const configFor = (instance: string) =>
  new ConfigService(parseEnvironment({ NODE_ENV: "test", DEPLOYMENT_INSTANCE_ID: instance }), {
    accessSecret: "a".repeat(64),
    refreshSecret: "b".repeat(64),
  });
const config = configFor(randomUUID());
let jwt: JwtGuard;
let refresh: RefreshService;
let host: VerifiedPrincipal;
let now = 0;
const clock = () => now;
let store: MemoryStateStore;
let game: GameService;
let rooms: RoomRegistryService;
let recovery: RecoveryService;

/** A scheduler instance with its own owner ID (and optionally its own game service). */
function scheduler(service = game, instance = randomUUID()) {
  return new RoomScheduler(runtime, rooms, store, service, configFor(instance), clock);
}
/** Room with one playable 20 s question and `players` joined players. */
async function room(players = 1) {
  const id = await quizzes.create(host.user.id, { title: "Timers" }, 1);
  const source = await quizzes.read(host.user.id, id);
  const write = quizWriteSchema.parse({
    ...source.content,
    questions: source.content.questions.map((q) => ({
      ...q,
      promptText: "Q",
      options: q.options.map((o, i) => ({ ...o, optionText: `O${i}` })),
    })),
  });
  const revision = await quizzes.save(host.user.id, id, 1, write, 2);
  const ack = await rooms.createRoom(host, {
    requestId: randomUUID(),
    quizId: id,
    quizRevision: revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  for (let i = 0; i < players; i++)
    await recovery.join(
      {
        requestId: randomUUID(),
        pinCode: ack.pinCode,
        nickname: `P${i}`,
        avatar: { style: "bottts", seed: `s${i}` },
      },
      { connectionId: randomUUID(), ip: "192.0.2.2" },
    );
  return { pin: ack.pinCode, sessionId: ack.sessionId };
}
/** Current phase of a room (or null when the state is gone). */
async function phase(identity: RoomIdentity) {
  return (await store.getPrivateSnapshot(identity))?.phase ?? null;
}
/** Allocation status by session ID. */
async function status(identity: RoomIdentity) {
  return (await runtime.find(identity.sessionId))?.status ?? null;
}
/** Host command with the current phase version. */
async function command(identity: RoomIdentity, event: HostCommand["event"]) {
  const s = await store.getPrivateSnapshot(identity);
  const requestId = randomUUID();
  return game.hostCommand(host, {
    event,
    request: {
      requestId,
      sessionId: identity.sessionId,
      pinCode: identity.pin,
      expectedPhaseVersion: s?.phaseVersion ?? 1,
    },
  } as HostCommand);
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
    email: "timers@example.org",
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
  await db.manager.clear("request_dedup");
  await db.manager.clear("room_media");
  await db.manager.clear("room_allocations");
  now = Date.now();
  store = new MemoryStateStore(projectRoom, clock);
  game = new GameService(store, jwt, clock);
  rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  recovery = new RecoveryService(runtime, settings, store);
});

it("advances timed phases at exact boundaries from scans alone", async () => {
  const identity = await room();
  const worker = scheduler();
  await command(identity, "host:start_game");
  const started = now;
  now = started + 2_999;
  await worker.scan(now);
  expect(await phase(identity)).toBe("GAME_START_COUNTDOWN");
  now = started + 3_000;
  await worker.scan(now);
  expect(await phase(identity)).toBe("QUESTION_PREVIEW");
  const preview = now;
  now = preview + 4_000;
  await worker.scan(now);
  const answering = await store.getPrivateSnapshot(identity);
  expect(answering?.phase).toBe("QUESTION_ANSWERING");
  expect(answering && nextDeadline(answering)).toBe(now + 20_000 + 1_500 + 1);
  now += 21_500;
  await worker.scan(now);
  expect(await phase(identity)).toBe("QUESTION_ANSWERING");
  now += 1;
  await worker.scan(now);
  expect(await phase(identity)).toBe("ANSWER_REVEAL");
  now += 3_600_000;
  await worker.scan(now);
  expect(await phase(identity)).toBe("ANSWER_REVEAL");
  await command(identity, "host:next_step");
  const podium = now;
  expect(await status(identity)).toBe("ACTIVE");
  await worker.scan(now);
  expect(await status(identity)).toBe("FINALIZING");
  now = podium + 7_999;
  await worker.scan(now);
  expect(await phase(identity)).toBe("PODIUM");
  now = podium + 8_000;
  await worker.scan(now);
  expect(await phase(identity)).toBe("FINISHED");
});

it("lets exactly one instance lead a room and hands over after the lease expires", async () => {
  const identity = await room();
  const gameA = new GameService(store, jwt, clock),
    gameB = new GameService(store, jwt, clock);
  const tickA = jest.spyOn(gameA, "tick"),
    tickB = jest.spyOn(gameB, "tick");
  const a = scheduler(gameA),
    b = scheduler(gameB);
  await a.scan(now);
  await b.scan(now);
  expect(tickA).toHaveBeenCalledTimes(1);
  expect(tickB).not.toHaveBeenCalled();
  now += 1_000;
  await a.scan(now);
  await b.scan(now);
  expect(tickA).toHaveBeenCalledTimes(2);
  expect(tickB).not.toHaveBeenCalled();
  now += 3_001;
  await b.scan(now);
  expect(tickB).toHaveBeenCalledTimes(1);
  await a.scan(now);
  expect(tickA).toHaveBeenCalledTimes(2);
  expect(await phase(identity)).toBe("LOBBY");
});

it("marks rooms LOST on missing state, idle lobbies and non-answering hard expiry, then releases them", async () => {
  const worker = scheduler();
  // Connected clients learn why their room ended (code review MJ-05).
  const ended = jest.spyOn(game, "roomEnded");
  const missing = await room(0);
  await store.releaseRoom(missing);
  await worker.scan(now);
  expect(await status(missing)).toBe("LOST");
  expect(ended).toHaveBeenCalledWith(missing, "ROOM_LOST");
  const idle = await room(0);
  // Allocations are stamped with the real clock, slightly after the fake clock's start.
  now += 2 * 3_600_000 + 1_000;
  await worker.scan(now);
  expect(await status(idle)).toBe("LOST");
  expect(ended).toHaveBeenCalledWith(idle, "ROOM_EXPIRED");
  expect(await phase(idle)).toBeNull();
  now += 3_600_001;
  await worker.scan(now);
  expect(await runtime.find(missing.sessionId)).toBeNull();
  expect(await runtime.find(idle.sessionId)).toBeNull();
});

it("expires an answering question as EXPIRED at the hard lifetime and keeps a pending report", async () => {
  const identity = await room();
  const worker = scheduler();
  await command(identity, "host:start_game");
  now += 3_000;
  await worker.scan(now);
  now += 4_000;
  await worker.scan(now);
  const state = await store.getPrivateSnapshot(identity);
  now = (state?.hardExpiresAt ?? now) + 1;
  await worker.scan(now);
  const ended = await store.getPrivateSnapshot(identity);
  expect(ended).toMatchObject({ phase: "PODIUM", endReason: "EXPIRED" });
  expect(ended?.closedQuestions["0"]?.reason).toBe("EXPIRED");
  expect(ended?.frozenReport?.session.endReason).toBe("EXPIRED");
  // Past the hard lifetime the store refuses further transitions; the pending report is retained.
  now += 8_000;
  await worker.scan(now);
  expect(await phase(identity)).toBe("PODIUM");
  now += 3_600_001;
  await worker.scan(now);
  expect(await phase(identity)).toBe("PODIUM");
  expect(await status(identity)).toBe("FINALIZING");
  await store.acknowledgeDurableReport(identity);
  await store.markFinalization(identity, {
    sessionId: identity.sessionId,
    status: "ready",
    reportId: identity.sessionId,
    retryable: false,
    errorCode: null,
    updatedAt: now,
  });
  await worker.scan(now);
  expect(await phase(identity)).toBeNull();
  expect(await status(identity)).toBe("CLOSED");
});

it("ends a hard-expired game outside ANSWERING at PODIUM with a report instead of LOST", async () => {
  // Code review MJ-06: question 0 was played; the room expires while its answer is revealed.
  const identity = await room();
  const worker = scheduler();
  const ended = jest.spyOn(game, "roomEnded");
  await command(identity, "host:start_game");
  now += 3_000;
  await worker.scan(now);
  now += 4_000;
  await worker.scan(now);
  now += 21_501;
  await worker.scan(now);
  expect(await phase(identity)).toBe("ANSWER_REVEAL");
  const state = await store.getPrivateSnapshot(identity);
  now = (state?.hardExpiresAt ?? now) + 1;
  await worker.scan(now);
  const podium = await store.getPrivateSnapshot(identity);
  expect(podium).toMatchObject({ phase: "PODIUM", endReason: "EXPIRED" });
  expect(podium?.finalization?.status).toBe("pending");
  expect(podium?.frozenReport?.session.endReason).toBe("EXPIRED");
  expect(podium?.frozenReport?.questions[0]?.status).toBe("PLAYED");
  expect(ended).not.toHaveBeenCalled();
  await worker.scan(now);
  expect(await status(identity)).toBe("FINALIZING");
});

it("still marks a hard-expired LOBBY as LOST: nothing was played", async () => {
  const identity = await room();
  const worker = scheduler();
  const state = await store.getPrivateSnapshot(identity);
  now = (state?.hardExpiresAt ?? now) + 1;
  await worker.scan(now);
  expect(await status(identity)).toBe("LOST");
  expect(await phase(identity)).toBeNull();
});

it("raises one alarm when a frozen report is still not durable 24 h after the game, never evicting it", async () => {
  const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  try {
    const identity = await room();
    const lines: string[] = [];
    const metrics = new MetricsService((line) => lines.push(line), clock);
    const worker = new RoomScheduler(
      runtime,
      rooms,
      store,
      game,
      configFor(randomUUID()),
      clock,
      metrics,
    );
    await command(identity, "host:start_game");
    now += 3_000;
    await worker.scan(now);
    now += 4_000;
    await worker.scan(now);
    const state = await store.getPrivateSnapshot(identity);
    now = (state?.hardExpiresAt ?? now) + 1;
    await worker.scan(now);
    const ended = await store.getPrivateSnapshot(identity);
    const endedAt = ended?.frozenReport?.session.endedAt ?? now;
    now = endedAt + ROOM_LIMITS.pendingAlarmMs - 1;
    await worker.scan(now);
    expect(errors).not.toHaveBeenCalled();
    now = endedAt + ROOM_LIMITS.pendingAlarmMs;
    await worker.scan(now);
    now += 60_000;
    await worker.scan(now);
    expect(errors).toHaveBeenCalledTimes(1);
    // MJ-16: also one counted, structured alarm event (no IDs in the metric dimension).
    expect(metrics.snapshot().counters["finalization_pending_alarms"]).toBe(1);
    expect(lines.map((line) => JSON.parse(line) as { event: string })).toEqual([
      expect.objectContaining({
        event: "finalization_pending_alarm",
        errorCode: "FINALIZATION_PENDING",
      }),
    ]);
    expect(String(errors.mock.calls[0]?.[0])).toBe(
      `finalization pending for more than 24 h for session ${identity.sessionId}`,
    );
    // Still retained: no eviction of a non-durable report.
    expect(await phase(identity)).toBe("PODIUM");
    expect(await status(identity)).toBe("FINALIZING");
  } finally {
    errors.mockRestore();
  }
});
