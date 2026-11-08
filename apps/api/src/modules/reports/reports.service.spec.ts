/**
 * TASK-085 coverage on SQLite with a real five-question game (SINGLE_CHOICE, partial
 * MULTIPLE_SELECT, POLL, a zero-multiplier question and one UNPLAYED question) and a player kicked
 * after the first question: weighted accuracy over scored opportunities only (denominator 0 →
 * null), question counts for every type, kicked players counted only before the kick, hardest
 * question ordering and ties, answer rows per status, the 18-column CSV with formula/control
 * injection guards, status/retry from history, durable job, frozen room or lost room, and 404/409/503
 * gates for inaccessible, pending and failed reports.
 */
import { randomUUID } from "node:crypto";
import {
  AuditRepository,
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
} from "@kabuki-neko/database";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import type { QuestionReport } from "@kabuki-neko/shared/schemas/report.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import type { HostCommand, RoomIdentity } from "../../providers/state/game-state.interface";
import { MemoryStateStore } from "../../providers/state/memory-state.store";
import { RefreshService } from "../auth/refresh.service";
import { GameService, type PlayerBinding } from "../game-engine/game.service";
import { RecoveryService } from "../game-engine/recovery.service";
import { projectRoom } from "../game-engine/room-projector";
import { RoomRegistryService } from "../game-engine/room-registry.service";
import {
  CSV_BOM,
  REPORT_CSV_COLUMNS,
  csvDecimal,
  csvRecord,
  csvText,
  reportCsvFilename,
} from "./report-csv";
import { ReportFinalizer } from "./report-finalizer";
import { ReportWorker } from "./report-worker";
import { ReportsService, hardestQuestions, metric } from "./reports.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
const runtime = new RuntimeRepository(db);
const jobs = new JobsRepository(db);
const reports = new ReportsRepository(db);
const users = new UsersRepository(db);
const audit = new AuditRepository(db);
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: "a".repeat(64),
  refreshSecret: "b".repeat(64),
});
let jwt: JwtGuard;
let refresh: RefreshService;
let host: VerifiedPrincipal;
let other: VerifiedPrincipal;
let now = 0;
const clock = () => now;
let store: MemoryStateStore;
let game: GameService;
let finalizer: ReportFinalizer;
let worker: ReportWorker;
let service: ReportsService;

type Kind = { type: "SINGLE_CHOICE" | "MULTIPLE_SELECT" | "POLL"; multiplier: 0 | 1 };
/** The game used by most tests: Q0 single, Q1 multiple, Q2 poll, Q3 single ×0, Q4 unplayed. */
const KINDS: Kind[] = [
  { type: "SINGLE_CHOICE", multiplier: 1 },
  { type: "MULTIPLE_SELECT", multiplier: 1 },
  { type: "POLL", multiplier: 0 },
  { type: "SINGLE_CHOICE", multiplier: 0 },
  { type: "SINGLE_CHOICE", multiplier: 1 },
];

/** Creates a quiz (single key = option 0, multiple keys = options 0 and 1) and an open room. */
async function room(nicknames: string[], title = '=HYPERLINK("evil")') {
  const quizId = await quizzes.create(host.user.id, { title: "Draft" }, 1);
  const accessibility = (await quizzes.read(host.user.id, quizId)).content.questions[0]
    ?.accessibility;
  const write = quizWriteSchema.parse({
    title,
    description: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    coverMediaId: null,
    questions: KINDS.map((kind, orderIndex) => ({
      id: randomUUID(),
      orderIndex,
      type: kind.type,
      promptText: `Q${orderIndex}`,
      mediaId: null,
      externalVideoUrl: null,
      videoStartSec: 0,
      videoEndSec: null,
      mediaRevealMode: "NONE",
      timeLimitSec: 20,
      pointsMultiplier: kind.multiplier,
      explanationText: null,
      accessibility,
      options: [0, 1, 2].map((optionIndex) => ({
        id: randomUUID(),
        optionIndex,
        colorIndex: optionIndex,
        optionText: `O${optionIndex}`,
        isCorrect:
          kind.type === "SINGLE_CHOICE"
            ? optionIndex === 0
            : kind.type === "MULTIPLE_SELECT"
              ? optionIndex < 2
              : false,
        sortOrder: 0,
      })),
    })),
  });
  const revision = await quizzes.save(host.user.id, quizId, 1, write, 2);
  const rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  const recovery = new RecoveryService(runtime, settings, store);
  const ack = await rooms.createRoom(host, {
    requestId: randomUUID(),
    quizId,
    quizRevision: revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  const identity: RoomIdentity = { pin: ack.pinCode, sessionId: ack.sessionId };
  const bindings: PlayerBinding[] = [];
  for (const [index, nickname] of nicknames.entries())
    bindings.push(
      (
        await recovery.join(
          {
            requestId: randomUUID(),
            pinCode: ack.pinCode,
            nickname,
            avatar: { style: "bottts", seed: `seed${index}` },
          },
          { connectionId: randomUUID(), ip: "192.0.2.5" },
        )
      ).binding,
    );
  return { identity, bindings, quizId };
}
/** Current private state of a room. */
async function state(identity: RoomIdentity) {
  const s = await store.getPrivateSnapshot(identity);
  if (!s) throw new Error("room missing");
  return s;
}
/** Host command with the current phase version where required. */
async function command(
  identity: RoomIdentity,
  event: HostCommand["event"],
  fields: Record<string, unknown> = {},
) {
  const s = await state(identity);
  return game.hostCommand(host, {
    event,
    request: {
      requestId: randomUUID(),
      sessionId: identity.sessionId,
      pinCode: identity.pin,
      ...(event === "host:kick_player" ? {} : { expectedPhaseVersion: s.phaseVersion }),
      ...fields,
    },
  } as HostCommand);
}
/** Advances the clock and ticks the room. */
async function advance(identity: RoomIdentity, ms: number) {
  now += ms;
  await game.tick(identity, now);
}
/** Public option index of private option `optionIndex` of the current question. */
async function pub(identity: RoomIdentity, optionIndex: number) {
  const s = await state(identity);
  const question = s.quiz.questions[s.questionIndex ?? 0];
  return question?.publicToPrivateOptionIds.indexOf(question.options[optionIndex]?.id ?? "") ?? -1;
}
/** Submits an answer (public indices) for the current question 1 s into answering. */
async function submit(identity: RoomIdentity, binding: PlayerBinding, answer: number | number[]) {
  const s = await state(identity);
  const index = s.questionIndex ?? 0;
  return game.submitAnswer(binding, {
    questionIndex: index,
    questionId: s.quiz.questions[index]?.id ?? "",
    submissionId: randomUUID(),
    answer,
  });
}
/** Closes the current question by its timer if it is still answering. */
async function closeByTimer(identity: RoomIdentity) {
  const s = await state(identity);
  if (s.phase === "QUESTION_ANSWERING")
    await advance(identity, (s.timing.acceptanceClosesAt ?? now) + 1 - now);
  expect((await state(identity)).phase).toBe("ANSWER_REVEAL");
}
/** From reveal: leaderboard, then (optionally) on to the next question's answering phase. */
async function nextQuestion(identity: RoomIdentity, kick?: string) {
  await command(identity, "host:next_step");
  if (kick) await command(identity, "host:kick_player", { playerId: kick });
  await command(identity, "host:next_step");
  await advance(identity, 4_000);
  expect((await state(identity)).phase).toBe("QUESTION_ANSWERING");
}

/**
 * Plays the KINDS game with Ann, Ben and Cat: Q0 Ann correct / Ben wrong / Cat silent, Cat kicked,
 * Q1 Ann partial / Ben correct, Q2 poll Ann only, Q3 (×0) Ann correct / Ben wrong, then end.
 * The report is queued; `persist` decides whether the worker writes it.
 */
async function play(persist = true) {
  const { identity, bindings, quizId } = await room(["@Ann", "-Ben", "Cat"]);
  const [ann, ben, cat] = bindings as [PlayerBinding, PlayerBinding, PlayerBinding];
  await command(identity, "host:start_game");
  await advance(identity, 3_000);
  await advance(identity, 4_000);
  now += 1_000;
  await submit(identity, ann, await pub(identity, 0));
  await submit(identity, ben, await pub(identity, 1));
  await closeByTimer(identity);
  await nextQuestion(identity, cat.playerId);
  now += 2_000;
  await submit(identity, ann, [await pub(identity, 0)]);
  await submit(identity, ben, [await pub(identity, 0), await pub(identity, 1)]);
  await closeByTimer(identity);
  await nextQuestion(identity);
  now += 500;
  await submit(identity, ann, await pub(identity, 2));
  await closeByTimer(identity);
  await nextQuestion(identity);
  now += 1_500;
  await submit(identity, ann, await pub(identity, 0));
  await submit(identity, ben, await pub(identity, 2));
  await closeByTimer(identity);
  await command(identity, "host:next_step");
  await command(identity, "host:end_game");
  expect((await state(identity)).phase).toBe("PODIUM");
  if (persist) expect(await worker.runOnce()).toBe("READY");
  return { identity, ann, ben, cat, quizId };
}

beforeAll(async () => {
  refresh = new RefreshService(config, new AuthRepository(db), users);
  jwt = new JwtGuard(refresh);
  await db.initialize();
  await migrateDatabase(db, true);
  const principal = async (email: string) => {
    const id = randomUUID();
    await db.manager.insert("users", {
      id,
      name: email,
      email,
      password_hash: "fixture",
      created_at: 1,
      updated_at: 1,
    });
    return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
  };
  host = await principal("analytics@example.org");
  other = await principal("other-analytics@example.org");
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
    "audit_events",
  ])
    await db.manager.clear(table);
  await db.manager.update("users", host.user.id, { is_active: true });
  now = Date.now();
  store = new MemoryStateStore(projectRoom, clock);
  game = new GameService(store, jwt, clock);
  finalizer = new ReportFinalizer(jobs, reports, store, clock);
  worker = new ReportWorker(jobs, finalizer, store, config, clock);
  game.setReportHook(async (identity, report) => {
    await finalizer.enqueue(identity, report);
  });
  service = new ReportsService(reports, runtime, users, audit, store, worker, clock);
});
afterEach(async () => {
  await worker.stop();
  jest.restoreAllMocks();
});

it("computes weighted accuracy, per-type counts, kicked opportunities and hardest questions", async () => {
  const { identity, ann, ben, cat } = await play();
  const report = await service.detail(host.user.id, identity.sessionId);
  expect(report).toMatchObject({
    totalQuestions: 5,
    playedQuestions: 4,
    accuracyDefinition: "weighted-success-scored-opportunities-v1",
    displayTimezone: "UTC",
    snapshotVersion: 1,
    // Q0 (1 of 3) + Q1 (0.5 + 1 of 2); POLL, ×0 and UNPLAYED are not opportunities.
    accuracy: { numerator: 2.5, denominator: 5, value: 0.5 },
    hardestQuestionIndexes: [0, 1],
  });
  expect(report.session).toMatchObject({
    id: identity.sessionId,
    quizTitle: '=HYPERLINK("evil")',
    status: "ready",
    endReason: "HOST_ENDED",
    totalPlayers: 3,
  });
  const q = report.questions;
  const optionCounts = (index: number) => q[index]?.optionCounts.map((o) => o.count);
  expect(q[0]).toMatchObject({
    status: "PLAYED",
    eligibleCount: 3,
    acceptedCount: 2,
    correctCount: 1,
    partialCount: 0,
    incorrectCount: 1,
    unansweredCount: 1,
    accuracy: { numerator: 1, denominator: 3 },
  });
  expect(q[0]?.accuracy.value).toBeCloseTo(1 / 3, 12);
  expect(optionCounts(0)).toEqual([1, 1, 0]);
  expect(q[1]).toMatchObject({
    eligibleCount: 2,
    acceptedCount: 2,
    correctCount: 1,
    partialCount: 1,
    incorrectCount: 0,
    unansweredCount: 0,
    accuracy: { numerator: 1.5, denominator: 2, value: 0.75 },
  });
  expect(optionCounts(1)).toEqual([2, 1, 0]);
  expect(q[2]).toMatchObject({
    eligibleCount: 2,
    acceptedCount: 1,
    correctCount: 0,
    partialCount: 0,
    incorrectCount: 0,
    unansweredCount: 1,
    accuracy: { numerator: 0, denominator: 0, value: null },
  });
  expect(optionCounts(2)).toEqual([0, 0, 1]);
  expect(q[3]).toMatchObject({
    acceptedCount: 2,
    correctCount: 1,
    incorrectCount: 1,
    accuracy: { denominator: 0, value: null },
  });
  expect(q[4]).toMatchObject({
    status: "UNPLAYED",
    eligibleCount: 0,
    acceptedCount: 0,
    unansweredCount: 0,
    accuracy: { denominator: 0, value: null },
  });
  expect(optionCounts(4)).toEqual([0, 0, 0]);
  // The report question is the authoring question (no public mapping leaks into it).
  expect(q[0]?.question).not.toHaveProperty("publicToPrivateOptionIds");
  const players = report.players.items;
  expect(players.map((p) => p.id)).toEqual([ann.playerId, ben.playerId, cat.playerId]);
  expect(report.players.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  expect(players[0]).toMatchObject({
    nickname: "@Ann",
    finalRank: 1,
    accuracy: { numerator: 1.5, denominator: 2, value: 0.75 },
  });
  expect(players[1]).toMatchObject({ accuracy: { numerator: 1, denominator: 2, value: 0.5 } });
  // Cat only had the opportunity before the kick.
  expect(players[2]).toMatchObject({
    isKicked: true,
    finalRank: null,
    unansweredCount: 1,
    avgResponseTimeMs: null,
    accuracy: { numerator: 0, denominator: 1, value: 0 },
  });
  const page = await service.players(host.user.id, identity.sessionId, {
    search: "ben",
    limit: "5",
  });
  expect(page.items.map((p) => p.id)).toEqual([ben.playerId]);
  expect(page.items[0]?.accuracy.value).toBe(0.5);
});

it("returns one answer row per question with NOT_PLAYED / NOT_ELIGIBLE / ANSWERED / UNANSWERED", async () => {
  const { identity, ann, ben, cat } = await play();
  const rows = async (playerId: string) =>
    (await service.answers(host.user.id, identity.sessionId, playerId, {})).items;
  const annRows = await rows(ann.playerId);
  expect(annRows.map((r) => [r.status, r.result])).toEqual([
    ["ANSWERED", "CORRECT"],
    ["ANSWERED", "PARTIAL"],
    ["ANSWERED", "POLL"],
    ["ANSWERED", "CORRECT"],
    ["NOT_PLAYED", null],
  ]);
  expect(annRows[0]).toMatchObject({ responseTimeMs: 1_000, isCorrect: true });
  expect(annRows[1]).toMatchObject({ accuracyNumerator: 1, accuracyDenominator: 2 });
  expect((annRows[1]?.basePoints ?? 0) + (annRows[1]?.streakBonus ?? 0)).toBe(
    annRows[1]?.pointsAwarded,
  );
  expect(annRows[2]).toMatchObject({ isCorrect: null, accuracyDenominator: 0, pointsAwarded: 0 });
  expect(annRows[3]).toMatchObject({ pointsAwarded: 0, basePoints: 0 });
  expect((await rows(ben.playerId))[2]).toMatchObject({
    status: "UNANSWERED",
    submittedPayload: null,
    responseTimeMs: null,
  });
  expect((await rows(cat.playerId)).map((r) => r.status)).toEqual([
    "UNANSWERED",
    "NOT_ELIGIBLE",
    "NOT_ELIGIBLE",
    "NOT_ELIGIBLE",
    "NOT_PLAYED",
  ]);
  const second = await service.answers(host.user.id, identity.sessionId, ann.playerId, {
    page: "2",
    limit: "2",
  });
  expect(second.items.map((r) => r.questionIndex)).toEqual([2, 3]);
  expect(second.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  await expect(
    service.answers(host.user.id, identity.sessionId, randomUUID(), {}),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
});

it("orders hardest questions by accuracy, then larger denominator, then index, at most five", () => {
  const q = (questionIndex: number, numerator: number, denominator: number, played = true) =>
    ({
      questionIndex,
      status: played ? "PLAYED" : "UNPLAYED",
      accuracy: metric({ numerator, denominator }),
    }) as QuestionReport;
  expect(
    hardestQuestions([
      q(0, 1, 2),
      q(1, 2, 4),
      q(2, 0, 0),
      q(3, 1, 3),
      q(4, 0, 0, false),
      q(5, 2, 4),
      q(6, 9, 10),
      q(7, 0, 1),
      q(8, 3, 6),
    ]),
  ).toEqual([7, 3, 8, 1, 5]);
  expect(metric({ numerator: 0, denominator: 0 })).toEqual({
    numerator: 0,
    denominator: 0,
    value: null,
  });
  expect(hardestQuestions([q(0, 0, 0), q(1, 0, 0, false)])).toEqual([]);
});

it("exports the stable 18-column CSV with formula and control injection guards", async () => {
  const { identity, ann, ben, cat } = await play();
  const csv = await service.exportCsv(host.user.id, identity.sessionId);
  expect(csv.filename).toBe(`kabuki-neko-report-${identity.sessionId}.csv`);
  const text = [...csv.chunks].join("");
  expect(text.startsWith(CSV_BOM)).toBe(true);
  const lines = text.slice(1).split("\r\n");
  expect(lines[0]).toBe(REPORT_CSV_COLUMNS.join(","));
  expect(REPORT_CSV_COLUMNS).toHaveLength(18);
  expect(lines).toHaveLength(5);
  expect(lines[4]).toBe("");
  const session = await reports.session(host.user.id, identity.sessionId);
  const annScore = (await reports.allPlayers(host.user.id, identity.sessionId))[0]?.final_score;
  const prefix = [
    `"${identity.sessionId}"`,
    `"'=HYPERLINK(""evil"")"`,
    `"${identity.pin}"`,
    `"HOST_ENDED"`,
    `"${new Date(session.started_at ?? 0).toISOString()}"`,
    `"${new Date(session.ended_at).toISOString()}"`,
  ].join(",");
  // correct_count mirrors the stored engine total (it currently also counts the ×0 question) and
  // the average covers every accepted answer including the poll: (1000+2000+500+1500)/4.
  const annCorrect = (await reports.allPlayers(host.user.id, identity.sessionId))[0]?.correct_count;
  expect(lines[1]).toBe(
    `${prefix},"${ann.playerId}","'@Ann",false,1,${annScore},${annCorrect},0,2,1250.000,1.500000,2,0.750000`,
  );
  expect(lines[2]?.startsWith(`${prefix},"${ben.playerId}","'-Ben",false,2,`)).toBe(true);
  expect(lines[2]?.endsWith(",1,2,0.500000")).toBe(true);
  expect(lines[3]).toBe(`${prefix},"${cat.playerId}","Cat",true,,0,0,1,0,,0,1,0.000000`);
  // Unit-level guards: every formula trigger, leading whitespace, TAB/CR/LF and other controls.
  for (const value of ["=1+1", "+1", "-1", "@SUM(A1)", "  =cmd", "\t1", "\r1", "\n1"])
    expect(csvText(value).startsWith(`"'`)).toBe(true);
  expect(csvText('say "hi"')).toBe('"say ""hi"""');
  expect(csvText("a\u0000b\u001bc\u007f")).toBe('"a�b�c�"');
  expect(csvText("plain, text")).toBe('"plain, text"');
  expect(csvDecimal(null, 3)).toBe("");
  expect(csvDecimal(1 / 3, 6)).toBe("0.333333");
  expect(() => csvDecimal(Number.NaN, 3)).toThrow("INVALID_FORMAT");
  expect(() => reportCsvFilename("../../etc/passwd")).toThrow("INVALID_FORMAT");
  const record = csvRecord(
    {
      id: identity.sessionId,
      quizTitle: "Quiz",
      pinCode: "000001",
      endReason: "COMPLETED",
      startedAt: null,
      endedAt: 0,
    },
    {
      id: ann.playerId,
      nickname: "x",
      isKicked: false,
      finalRank: null,
      finalScore: 0,
      correctCount: 0,
      unansweredCount: 0,
      maxStreak: 0,
      avgResponseTimeMs: null,
      accuracy: metric({ numerator: 0, denominator: 0 }),
    },
  );
  expect(record).toBe(
    `"${identity.sessionId}","Quiz","000001","COMPLETED",,"1970-01-01T00:00:00.000Z","${ann.playerId}","x",false,,0,0,0,0,,0,0,\r\n`,
  );
});

it("hides inaccessible reports and gates pending and failed ones", async () => {
  const { identity, ann } = await play(false);
  const id = identity.sessionId;
  // Pending: queued but not written.
  await expect(service.detail(host.user.id, id)).rejects.toMatchObject({
    errorCode: "FINALIZATION_PENDING",
  });
  await expect(service.exportCsv(host.user.id, id)).rejects.toMatchObject({
    errorCode: "FINALIZATION_PENDING",
  });
  expect(await service.status(host.user.id, id)).toMatchObject({ status: "pending" });
  await expect(service.retry(host.user.id, id)).rejects.toMatchObject({
    errorCode: "FINALIZATION_PENDING",
  });
  expect((await service.list(host.user.id, {})).items).toEqual([]);
  // Failed: the write fails, reads answer 503 and the manual retry re-queues it.
  jest.spyOn(reports, "persist").mockRejectedValueOnce(new Error("disk full"));
  expect(await worker.runOnce()).toBe("FAILED");
  await expect(service.players(host.user.id, id, {})).rejects.toMatchObject({
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(await service.status(host.user.id, id)).toMatchObject({
    status: "failed",
    retryable: true,
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(await service.retry(host.user.id, id)).toMatchObject({ status: "pending" });
  expect(await worker.runOnce()).toBe("READY");
  expect(await service.status(host.user.id, id)).toMatchObject({ status: "ready", reportId: id });
  expect(await service.retry(host.user.id, id)).toMatchObject({ status: "ready", reportId: id });
  expect((await service.list(host.user.id, {})).items.map((s) => s.id)).toEqual([id]);
  // Another host — even one who could see the source quiz — never sees it.
  for (const call of [
    () => service.detail(other.user.id, id),
    () => service.players(other.user.id, id, {}),
    () => service.answers(other.user.id, id, ann.playerId, {}),
    () => service.exportCsv(other.user.id, id),
    () => service.status(other.user.id, id),
    () => service.retry(other.user.id, id),
  ])
    await expect(call()).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  expect((await service.list(other.user.id, {})).items).toEqual([]);
  // A deactivated host loses access to their own reports.
  await db.manager.update("users", host.user.id, { is_active: false });
  await expect(service.detail(host.user.id, id)).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  await expect(service.status(host.user.id, id)).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  expect((await service.list(host.user.id, {})).items).toEqual([]);
  await expect(service.detail(host.user.id, randomUUID())).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
});

it("answers status and retry from the frozen room or a lost room when no job exists", async () => {
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  const { identity } = await play(false);
  const id = identity.sessionId;
  expect(await db.manager.count("finalization_jobs")).toBe(0);
  expect(await service.status(host.user.id, id)).toMatchObject({
    status: "failed",
    errorCode: "REPORT_SAVE_FAILED",
    retryable: true,
  });
  // Storage still down: 503, nothing lost.
  jest.spyOn(jobs, "enqueue").mockRejectedValueOnce(new Error("database unavailable"));
  await expect(service.retry(host.user.id, id)).rejects.toMatchObject({
    errorCode: "REPORT_SAVE_FAILED",
  });
  expect(await service.retry(host.user.id, id)).toMatchObject({ status: "pending" });
  expect(await db.manager.count("finalization_jobs")).toBe(1);
  expect(await worker.runOnce()).toBe("READY");
  // A room still in its lobby has no report yet; a lost room is reported as lost, not retryable.
  const lobby = (await room(["Dee"], "Lobby")).identity;
  await expect(service.status(host.user.id, lobby.sessionId)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
  await expect(service.retry(host.user.id, lobby.sessionId)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
  await runtime.transition(lobby.sessionId, "ACTIVE", "LOST", now);
  for (const result of [
    await service.status(host.user.id, lobby.sessionId),
    await service.retry(host.user.id, lobby.sessionId),
  ])
    expect(result).toMatchObject({ status: "lost", retryable: false, reportId: null });
  // After release only the audited loss remains.
  await audit.append(
    {
      actorType: "SYSTEM",
      actorId: host.user.id,
      action: "room.release.lost",
      resourceId: lobby.sessionId,
      outcome: "SUCCESS",
      correlationId: randomUUID(),
    },
    now,
  );
  await db.manager.delete("room_allocations", { id: lobby.sessionId });
  expect(await service.status(host.user.id, lobby.sessionId)).toMatchObject({ status: "lost" });
  await expect(service.status(other.user.id, lobby.sessionId)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
});
