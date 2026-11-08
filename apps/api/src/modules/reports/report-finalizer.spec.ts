/**
 * TASK-083 coverage on SQLite with a real game played through the memory store: freeze-to-queue
 * (durable job before durable state), DB outage then recovery, stable UUIDv5 history IDs and
 * idempotent READY, rollback at every insert boundary, deleted source quiz/questions becoming NULL
 * while snapshots stay intact, and hash mismatches that never overwrite history.
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
  reportRowId,
} from "@kabuki-neko/database";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { EntityManager } from "typeorm";
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
import { ReportFinalizer } from "./report-finalizer";

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
const HISTORY = ["player_answers", "game_players", "session_questions", "game_sessions"] as const;

/** Plays a two-question game (one answered, then ended early) and returns the frozen report. */
async function play(): Promise<{ identity: RoomIdentity; report: FrozenReport; quizId: string }> {
  const game = new GameService(store, jwt, clock);
  let frozen: FrozenReport | null = null;
  game.setReportHook(async (_identity, report) => {
    frozen = report;
  });
  const rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  const recovery = new RecoveryService(runtime, settings, store);
  const quizId = await quizzes.create(host.user.id, { title: "Report quiz" }, 1);
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
  const players = [];
  for (const nickname of ["Ann", "Ben"])
    players.push(
      (
        await recovery.join(
          {
            requestId: randomUUID(),
            pinCode: ack.pinCode,
            nickname,
            avatar: { style: "bottts", seed: nickname },
          },
          { connectionId: randomUUID(), ip: "192.0.2.3" },
        )
      ).binding,
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
  const s = await store.getPrivateSnapshot(identity);
  const question = s?.quiz.questions[0];
  const correct = question?.publicToPrivateOptionIds.indexOf(question.options[0]?.id ?? "") ?? 0;
  const answering = players[0];
  if (!answering) throw new Error("player missing");
  await game.submitAnswer(answering, {
    questionIndex: 0,
    questionId: question?.id ?? "",
    submissionId: randomUUID(),
    answer: correct,
  });
  await command("host:end_game");
  if (!frozen) throw new Error("report not frozen");
  return { identity, report: frozen, quizId };
}
/** Row counts of every history table. */
async function counts() {
  const result: Record<string, number> = {};
  for (const table of HISTORY) result[table] = await db.manager.count(table);
  return result;
}
/** Claims the job for `sessionId` (one job per test). */
async function claim(sessionId: string) {
  const job = await jobs.claim(now);
  if (!job || job.session_id !== sessionId) throw new Error("job not claimable");
  return job;
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
    email: "reports@example.org",
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
    ...HISTORY,
    "finalization_jobs",
    "request_dedup",
    "room_media",
    "room_allocations",
  ])
    await db.manager.clear(table);
  now = Date.now();
  store = new MemoryStateStore(projectRoom, clock);
  finalizer = new ReportFinalizer(jobs, reports, store, clock);
});
afterEach(() => {
  jest.restoreAllMocks();
});

it("queues durably, survives a database outage and writes stable idempotent history", async () => {
  const { identity, report } = await play();
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  expect(await finalizer.enqueue(identity, report)).toMatchObject({
    status: "failed",
    retryable: true,
    reportId: null,
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(await store.releaseRoom(identity)).toBe(false);
  expect((await store.getPrivateSnapshot(identity))?.finalization).toMatchObject({
    status: "failed",
  });
  expect(await db.manager.count("finalization_jobs")).toBe(0);
  expect(await finalizer.enqueue(identity, report)).toMatchObject({
    status: "pending",
    reportId: null,
  });
  expect(await finalizer.enqueue(identity, report)).toMatchObject({ status: "pending" });
  expect(await db.manager.count("finalization_jobs")).toBe(1);
  const job = await claim(identity.sessionId);
  expect(await finalizer.persist(job)).toBe(identity.sessionId);
  expect(await counts()).toEqual({
    player_answers: 2,
    game_players: 2,
    session_questions: 2,
    game_sessions: 1,
  });
  const question = await db.manager.findOneByOrFail<{ id: string; question_index: number }>(
    "session_questions",
    {
      question_index: 0,
    },
  );
  expect(question.id).toBe(reportRowId(identity.sessionId, "session_questions/0"));
  const answerIds = (await db.manager.find<{ id: string }>("player_answers"))
    .map((row) => row.id)
    .sort();
  expect(answerIds).toEqual(
    report.answers
      .map((a) =>
        reportRowId(identity.sessionId, `player_answers/${a.questionIndex}/${a.playerId}`),
      )
      .sort(),
  );
  expect(await finalizer.persist(job)).toBe(identity.sessionId);
  expect(await counts()).toEqual({
    player_answers: 2,
    game_players: 2,
    session_questions: 2,
    game_sessions: 1,
  });
  expect(
    (
      await db.manager.findOneByOrFail<{ state: string; session_id: string }>("finalization_jobs", {
        session_id: identity.sessionId,
      })
    ).state,
  ).toBe("READY");
});

it.each(["game_sessions", "session_questions", "game_players", "player_answers"])(
  "rolls back everything when inserting %s fails",
  async (table) => {
    const { identity, report } = await play();
    await finalizer.enqueue(identity, report);
    const job = await claim(identity.sessionId);
    const insert = EntityManager.prototype.insert;
    jest.spyOn(EntityManager.prototype, "insert").mockImplementation(function (
      this: EntityManager,
      target: unknown,
      entity: unknown,
    ) {
      if (target === table) return Promise.reject(new Error(`boom ${table}`));
      return insert.call(this, target as never, entity as never);
    });
    await expect(finalizer.persist(job)).rejects.toThrow(`boom ${table}`);
    jest.restoreAllMocks();
    expect(await counts()).toEqual({
      player_answers: 0,
      game_players: 0,
      session_questions: 0,
      game_sessions: 0,
    });
    expect(
      (
        await db.manager.findOneByOrFail<{ state: string; session_id: string }>(
          "finalization_jobs",
          {
            session_id: identity.sessionId,
          },
        )
      ).state,
    ).toBe("RUNNING");
    expect(await finalizer.persist(job)).toBe(identity.sessionId);
    expect((await counts()).game_sessions).toBe(1);
  },
);

it("rolls back when the job cannot be marked READY", async () => {
  const { identity, report } = await play();
  await finalizer.enqueue(identity, report);
  const job = await claim(identity.sessionId);
  const update = EntityManager.prototype.update;
  jest.spyOn(EntityManager.prototype, "update").mockImplementation(function (
    this: EntityManager,
    target: unknown,
    criteria: unknown,
    partial: unknown,
  ) {
    if (target === "finalization_jobs") return Promise.reject(new Error("boom job"));
    return update.call(this, target as never, criteria as never, partial as never);
  });
  await expect(finalizer.persist(job)).rejects.toThrow("boom job");
  jest.restoreAllMocks();
  expect(await counts()).toEqual({
    player_answers: 0,
    game_players: 0,
    session_questions: 0,
    game_sessions: 0,
  });
});

it("nulls deleted source references while keeping immutable snapshots", async () => {
  const { identity, report, quizId } = await play();
  await finalizer.enqueue(identity, report);
  const quiz = await quizzes.read(host.user.id, quizId);
  await quizzes.delete(host.user.id, quizId, quiz.row.revision);
  const job = await claim(identity.sessionId);
  await finalizer.persist(job);
  const session = await db.manager.findOneByOrFail<{
    id: string;
    quiz_id: string | null;
    quiz_title_snapshot: string;
  }>("game_sessions", { id: identity.sessionId });
  expect(session).toMatchObject({ quiz_id: null, quiz_title_snapshot: "Report quiz" });
  const questions = await db.manager.find<{
    question_index: number;
    source_question_id: string | null;
    snapshot: { promptText: string };
  }>("session_questions", { order: { question_index: "ASC" } });
  expect(questions.map((q) => q.source_question_id)).toEqual([null, null]);
  expect(questions.map((q) => q.snapshot.promptText)).toEqual(["Q0", "Q1"]);
  expect(
    (await db.manager.find<{ question_id: string | null }>("player_answers")).every(
      (a) => a.question_id === null,
    ),
  ).toBe(true);
});

it("refuses a different payload for the same session and never overwrites history", async () => {
  const { identity, report } = await play();
  await finalizer.enqueue(identity, report);
  const tampered: FrozenReport = {
    ...report,
    session: { ...report.session, quizTitleSnapshot: "Tampered" },
  };
  await expect(finalizer.enqueue(identity, tampered)).rejects.toThrow("hash mismatch");
  const job = await claim(identity.sessionId);
  await expect(finalizer.persist({ ...job, payload_hash: "0".repeat(64) })).rejects.toThrow(
    "hash mismatch",
  );
  expect(await counts()).toEqual({
    player_answers: 0,
    game_players: 0,
    session_questions: 0,
    game_sessions: 0,
  });
  await finalizer.persist(job);
  expect(
    (
      await db.manager.findOneByOrFail<{ id: string; quiz_title_snapshot: string }>(
        "game_sessions",
        {
          id: identity.sessionId,
        },
      )
    ).quiz_title_snapshot,
  ).toBe("Report quiz");
  await expect(
    finalizer.enqueue({ ...identity, sessionId: randomUUID() }, report),
  ).rejects.toMatchObject({ errorCode: "INVALID_REFERENCE" });
});
