/**
 * TASK-080 coverage for the game state machine on SQLite + memory store with one fake clock:
 * full timed flow, double next, skip racing a submit, kicking the last required player, partial
 * MULTIPLE_SELECT success, no vacuous reveal, early end closing only the current question, ending
 * an empty lobby, and recovery after a crash during result commit or report freeze.
 */
import { randomUUID } from "node:crypto";
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
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
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
import { GameService, type PlayerBinding } from "./game.service";
import { RecoveryService } from "./recovery.service";
import { projectRoom } from "./room-projector";
import { RoomRegistryService } from "./room-registry.service";

type Kind = "SINGLE_CHOICE" | "MULTIPLE_SELECT";
const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
const runtime = new RuntimeRepository(db);
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
let game: GameService;
let recovery: RecoveryService;
let rooms: RoomRegistryService;
let frozen: FrozenReport[];

/** Playable quiz: SINGLE_CHOICE (key = option 0) or MULTIPLE_SELECT (keys = options 0 and 1). */
async function quiz(kinds: Kind[]) {
  const id = await quizzes.create(host.user.id, { title: "Engine" }, 1);
  const write = quizWriteSchema.parse({
    title: "Engine",
    description: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    coverMediaId: null,
    questions: kinds.map((type, orderIndex) => ({
      id: randomUUID(),
      orderIndex,
      type,
      promptText: `Q${orderIndex}`,
      mediaId: null,
      externalVideoUrl: null,
      videoStartSec: 0,
      videoEndSec: null,
      mediaRevealMode: "NONE",
      timeLimitSec: 20,
      pointsMultiplier: 1,
      explanationText: null,
      accessibility: emptyAccessibility(),
      options: [0, 1, 2].map((optionIndex) => ({
        id: randomUUID(),
        optionIndex,
        colorIndex: optionIndex,
        optionText: `O${optionIndex}`,
        isCorrect: type === "SINGLE_CHOICE" ? optionIndex === 0 : optionIndex < 2,
        sortOrder: 0,
      })),
    })),
  });
  return { id, revision: await quizzes.save(host.user.id, id, 1, write, 2) };
}
/** Creates a room for a quiz of `kinds` and joins `players` players. */
async function room(kinds: Kind[], players = 2) {
  const { id, revision } = await quiz(kinds);
  const ack = await rooms.createRoom(host, {
    requestId: randomUUID(),
    quizId: id,
    quizRevision: revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  const identity: RoomIdentity = { pin: ack.pinCode, sessionId: ack.sessionId };
  const bindings: PlayerBinding[] = [];
  for (let i = 0; i < players; i++) {
    const joined = await recovery.join(
      {
        requestId: randomUUID(),
        pinCode: ack.pinCode,
        nickname: `P${i}`,
        avatar: { style: "bottts", seed: `s${i}` },
      },
      { connectionId: randomUUID(), ip: "192.0.2.1" },
    );
    bindings.push(joined.binding);
  }
  return { identity, bindings };
}
/** Current private state. */
async function state(identity: RoomIdentity) {
  const value = await store.getPrivateSnapshot(identity);
  if (!value) throw new Error("room missing");
  return value;
}
/** Host command helper; `expected` defaults to the current phaseVersion. */
async function command(
  identity: RoomIdentity,
  event: HostCommand["event"],
  fields: Record<string, unknown> = {},
  requestId = randomUUID(),
) {
  const expected = (await state(identity)).phaseVersion;
  const request = {
    requestId,
    sessionId: identity.sessionId,
    pinCode: identity.pin,
    ...(["host:lock_room", "host:kick_player"].includes(event)
      ? {}
      : { expectedPhaseVersion: expected }),
    ...fields,
  };
  return game.hostCommand(host, { event, request } as HostCommand);
}
/** Advances the shared clock and runs one scheduler tick. */
async function advance(identity: RoomIdentity, ms: number) {
  now += ms;
  await game.tick(identity, now);
}
/** Starts the game and advances to QUESTION_ANSWERING of question 0. */
async function toAnswering(identity: RoomIdentity) {
  await command(identity, "host:start_game");
  await advance(identity, 3_000);
  await advance(identity, 4_000);
  expect((await state(identity)).phase).toBe("QUESTION_ANSWERING");
}
/** Submits public option indices for the current question. */
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
/** Public option index whose private option has the given private index. */
async function publicIndex(identity: RoomIdentity, privateIndex: number) {
  const s = await state(identity);
  const question = s.quiz.questions[s.questionIndex ?? 0];
  return question?.publicToPrivateOptionIds.indexOf(question.options[privateIndex]?.id ?? "") ?? -1;
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
    email: "host@example.org",
    password_hash: "fixture",
    created_at: 1,
    updated_at: 1,
  });
  host = await jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  now = Date.now();
  store = new MemoryStateStore(projectRoom, clock);
  game = new GameService(store, jwt, clock);
  frozen = [];
  game.setReportHook(async (_identity, report) => {
    frozen.push(report);
  });
  recovery = new RecoveryService(runtime, settings, store);
  rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
});

it("runs the timed flow, rejects a double next and lets skip race a submit consistently", async () => {
  const { identity, bindings } = await room(["SINGLE_CHOICE", "SINGLE_CHOICE"]);
  const [a, b] = bindings as [PlayerBinding, PlayerBinding];
  await command(identity, "host:start_game");
  await advance(identity, 2_999);
  expect((await state(identity)).phase).toBe("GAME_START_COUNTDOWN");
  await advance(identity, 1);
  expect((await state(identity)).phase).toBe("QUESTION_PREVIEW");
  await advance(identity, 4_000);
  expect((await state(identity)).requiredPlayerIds.sort()).toEqual([a.playerId, b.playerId].sort());
  expect(await submit(identity, a, await publicIndex(identity, 0))).toMatchObject({
    accepted: true,
  });
  const [skip, late] = await Promise.allSettled([
    command(identity, "host:skip_timer"),
    submit(identity, b, await publicIndex(identity, 1)),
  ]);
  // Either skip froze first (HOST_SKIP) or B's answer completed the required set (ALL_ANSWERED)
  // and the skip then observed the committed reveal as a stale phase.
  if (skip.status === "fulfilled")
    expect(skip.value).toMatchObject({ ok: true, data: { phase: "ANSWER_REVEAL" } });
  else expect(skip.reason).toMatchObject({ errorCode: "STALE_PHASE" });
  const revealed = await state(identity);
  const reveal = revealed.results["0"]?.reveal;
  expect(
    (reveal?.correctCount ?? 0) + (reveal?.incorrectCount ?? 0) + (reveal?.unansweredCount ?? 0),
  ).toBe(2);
  expect(reveal?.incorrectCount).toBe(late.status === "fulfilled" ? 1 : 0);
  expect(revealed.phase).toBe("ANSWER_REVEAL");
  expect(revealed.closedQuestions["0"]?.reason).toBe(
    skip.status === "fulfilled" ? "HOST_SKIP" : "ALL_ANSWERED",
  );

  const version = revealed.phaseVersion;
  const next = (requestId: string) =>
    game.hostCommand(host, {
      event: "host:next_step",
      request: {
        requestId,
        sessionId: identity.sessionId,
        pinCode: identity.pin,
        expectedPhaseVersion: version,
      },
    } as HostCommand);
  const first = randomUUID();
  const results = await Promise.allSettled([next(first), next(randomUUID())]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { errorCode: "STALE_PHASE" },
  });
  expect((await state(identity)).phase).toBe("LEADERBOARD");
  const replay = await next(first);
  expect(replay).toMatchObject({ ok: true, data: { phase: "LEADERBOARD" } });
});

it("closes on kicking the last required player and scores partial multiple-select", async () => {
  const { identity, bindings } = await room(["MULTIPLE_SELECT"]);
  const [a, b] = bindings as [PlayerBinding, PlayerBinding];
  await toAnswering(identity);
  now += 10_000;
  await submit(identity, a, [await publicIndex(identity, 0)]);
  expect((await state(identity)).phase).toBe("QUESTION_ANSWERING");
  await command(identity, "host:kick_player", { playerId: b.playerId });
  const s = await state(identity);
  expect(s.phase).toBe("ANSWER_REVEAL");
  expect(s.closedQuestions["0"]?.reason).toBe("ALL_ANSWERED");
  expect(s.results["0"]?.personal[a.playerId]).toMatchObject({
    result: "PARTIAL",
    accuracyNumerator: 1,
    accuracyDenominator: 2,
    basePoints: 375,
    pointsAwarded: 375,
  });
  expect(s.results["0"]?.personal[b.playerId]).toBeUndefined();
  expect(s.results["0"]?.reveal).toMatchObject({ partialCount: 1 });
});

it("never reveals vacuously and closes on the timer strictly after the grace period", async () => {
  const { identity, bindings } = await room(["SINGLE_CHOICE"], 1);
  const [a] = bindings as [PlayerBinding];
  await command(identity, "host:start_game");
  await advance(identity, 3_000);
  await store.setPresence(identity, a.playerId, a.generation, false);
  await advance(identity, 4_000);
  const s = await state(identity);
  expect(s.requiredPlayerIds).toEqual([]);
  await advance(identity, 20_000 + 1_500);
  expect((await state(identity)).phase).toBe("QUESTION_ANSWERING");
  await advance(identity, 1);
  const closed = await state(identity);
  expect(closed.phase).toBe("ANSWER_REVEAL");
  expect(closed.closedQuestions["0"]?.reason).toBe("TIMER");
});

it("ends an empty lobby and an active question with immutable reports", async () => {
  const empty = await room(["SINGLE_CHOICE"], 0);
  const ended = await command(empty.identity, "host:end_game");
  expect(ended).toMatchObject({
    ok: true,
    data: { phase: "PODIUM", finalization: { status: "pending" } },
  });
  expect(frozen).toHaveLength(1);
  expect(frozen[0]?.session).toMatchObject({
    totalPlayers: 0,
    playedQuestions: 0,
    endReason: "HOST_ENDED",
  });

  const { identity, bindings } = await room(["SINGLE_CHOICE", "SINGLE_CHOICE", "SINGLE_CHOICE"]);
  const [a] = bindings as [PlayerBinding];
  await toAnswering(identity);
  await submit(identity, a, await publicIndex(identity, 0));
  const result = await command(identity, "host:end_game");
  expect(result).toMatchObject({ data: { phase: "PODIUM" } });
  const report = frozen[1];
  expect(report?.questions.map((q) => [q.status, q.closeReason])).toEqual([
    ["PLAYED", "HOST_END"],
    ["UNPLAYED", null],
    ["UNPLAYED", null],
  ]);
  expect(report?.answers.map((x) => x.result).sort()).toEqual(["CORRECT", "UNANSWERED"]);
  expect(report?.players.find((p) => p.id === a.playerId)).toMatchObject({
    finalScore: 1000,
    finalRank: 1,
    correctCount: 1,
  });
  expect(await command(identity, "host:end_game")).toMatchObject({ data: { phase: "PODIUM" } });
  expect(frozen).toHaveLength(2);
  await advance(identity, 7_999);
  expect((await state(identity)).phase).toBe("PODIUM");
  await advance(identity, 1);
  expect((await state(identity)).phase).toBe("FINISHED");
});

it("recovers after a crash during result commit and during report freeze", async () => {
  const { identity, bindings } = await room(["SINGLE_CHOICE"]);
  const [a] = bindings as [PlayerBinding];
  await toAnswering(identity);
  await submit(identity, a, await publicIndex(identity, 0));
  jest.spyOn(store, "commitQuestionResult").mockRejectedValueOnce(new Error("crash"));
  await advance(identity, 21_501).catch(() => undefined);
  const frozenOnly = await state(identity);
  expect(frozenOnly).toMatchObject({ phase: "QUESTION_ANSWERING", accepting: false });
  expect(frozenOnly.results["0"]).toBeUndefined();
  await advance(identity, 1);
  const revealed = await state(identity);
  expect(revealed.phase).toBe("ANSWER_REVEAL");
  expect(revealed.players[a.playerId]).toMatchObject({ score: 1000, streak: 1 });

  jest.spyOn(store, "freezeReport").mockRejectedValueOnce(new Error("crash"));
  expect(await command(identity, "host:next_step")).toMatchObject({ data: { phase: "PODIUM" } });
  expect((await state(identity)).frozenReport).toBeNull();
  expect(frozen).toHaveLength(0);
  await advance(identity, 10);
  expect((await state(identity)).frozenReport).not.toBeNull();
  expect(frozen).toHaveLength(1);
  await advance(identity, 10);
  expect(frozen).toHaveLength(1);
  expect(revealed.players[a.playerId]?.streak).toBe(1);
});
