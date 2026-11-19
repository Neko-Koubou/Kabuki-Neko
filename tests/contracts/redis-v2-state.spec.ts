/**
 * TASK-185M contract: the Redis v2 room layout (ADR-13, SA §6.1.1) against a real Redis.
 * Covers what TASK-185M ports: room creation (CREATED/EXISTS), the full and window reads (equal to
 * the seeded state, window limited to the current and latest scored question), the release that
 * deletes every room key by name, scheduler leases, the frozen report, durability and the
 * finalization status. TASK-185N adds players (joins, recovery, presence, avatars, tickets) and
 * TASK-185O answer admission, the question freeze and the flat per-answer cost, TASK-185P result
 * commits, host commands (lock, kick, start, next, skip, end) and scheduled phase transitions.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Redis from "ioredis";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { playerRoomSyncSchema } from "@kabuki-neko/shared/schemas/game.schema";
import {
  activePlayerSchema,
  activeRoomStateSchema,
  frozenReportSchema,
  questionResultSchema,
  windowRoomState,
} from "../../apps/api/src/providers/state/private-state.schema";
import type {
  ActiveRoomState,
  ApplyCommandInput,
  RoomProjector,
} from "../../apps/api/src/providers/state/game-state.interface";
import { RedisV2StateStore } from "../../apps/api/src/providers/state/redis-v2-state.store";
import { createTestRuntime } from "../helpers/runtime";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { pin: "000123", sessionId: uuid(1) };
const PREFIX = `kabukineko:v2contract:v2:room:{${identity.pin}}`;

function question() {
  return {
    id: uuid(2),
    orderIndex: 0,
    type: "TYPE_ANSWER",
    promptText: "Name a cat",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier: 1,
    explanationText: null,
    accessibility: emptyAccessibility(),
    options: [
      {
        id: uuid(3),
        optionIndex: 0,
        colorIndex: 0,
        optionText: "Neko",
        isCorrect: true,
        sortOrder: 0,
      },
    ],
    publicOptions: [],
    publicToPrivateOptionIds: [],
    mediaSnapshot: null,
  };
}

function quiz() {
  return {
    schemaVersion: 1,
    quizId: uuid(4),
    revision: 1,
    title: "Cats",
    description: null,
    bgmTrack: "random",
    coverMedia: null,
    questions: [question()],
  };
}

function report_() {
  return {
    schemaVersion: 1,
    session: {
      id: uuid(1),
      quizId: uuid(4),
      quizTitleSnapshot: "Cats",
      quizRevision: 1,
      hostId: uuid(5),
      pinCode: "000123",
      displayMode: "PROJECTOR",
      endReason: "COMPLETED",
      totalPlayers: 1,
      totalQuestions: 1,
      playedQuestions: 1,
      startedAt: 1000,
      endedAt: 22000,
    },
    quiz: quiz(),
    players: [
      {
        id: uuid(6),
        sessionId: uuid(1),
        nickname: "Neko",
        avatarStyle: "bottts",
        avatarSeed: "cat",
        joinOrder: 0,
        isKicked: false,
        finalScore: 0,
        finalRank: 1,
        correctCount: 0,
        unansweredCount: 0,
        maxStreak: 0,
        avgResponseTimeMs: 1000,
        joinedAt: 0,
        kickedAt: null,
      },
    ],
    questions: [
      {
        questionIndex: 0,
        sourceQuestionId: uuid(2),
        snapshot: question(),
        status: "PLAYED",
        openedAt: 1000,
        closedAt: 22000,
        closeReason: "TIMER",
        eligiblePlayerIds: [uuid(6)],
      },
    ],
    answers: [
      {
        playerId: uuid(6),
        questionIndex: 0,
        questionId: uuid(2),
        submissionId: uuid(7),
        submittedPayload: "Cat",
        result: "INCORRECT",
        isCorrect: false,
        accuracyNumerator: 0,
        accuracyDenominator: 1,
        responseTimeMs: 1000,
        receivedAt: 2000,
        pointsAwarded: 0,
        streakBonusAwarded: 0,
        currentStreak: 0,
      },
    ],
  };
}

function room() {
  return {
    schemaVersion: 1,
    sessionId: uuid(1),
    pinCode: "000123",
    hostId: uuid(5),
    quiz: quiz(),
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
    isLocked: false,
    maxPlayers: 200,
    phase: "LOBBY",
    phaseVersion: 1,
    revision: 1,
    publicRevision: 1,
    questionIndex: null,
    timing: {
      phaseStartedAt: 0,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    createdAt: 0,
    hardExpiresAt: 28800000,
    lobbyActiveAt: 0,
    accepting: false,
    requiredPlayerIds: [],
    eligiblePlayerIds: [],
    players: {},
    answers: {},
    closedQuestions: {},
    results: {},
    commands: {},
    tickets: {},
    frozenReport: null,
    finalization: null,
    endReason: null,
    reservations: { baseBytes: 4096, perPlayerBytes: 51074, maxPublicQuestionBytes: 1024 },
  };
}

function player(n = 6) {
  return activePlayerSchema.parse({
    id: uuid(n),
    nickname: `Cat${n}`,
    nicknameKey: `cat${n}`,
    avatar: { style: "bottts", seed: "cat" },
    joinOrder: n - 6,
    joinedAt: 0,
    kickedAt: null,
    tokenHash: createHash("sha256").update("a".repeat(43)).digest("hex"),
    connectionGeneration: 1,
    connected: true,
    connectionId: `socket${n}`,
    lastSeenAt: 0,
    score: 0,
    streak: 0,
    maxStreak: 0,
    correctCount: 0,
    responseSumMs: 0,
    responseCount: 0,
    rank: null,
    previousRank: null,
  });
}

function answering(required = [uuid(6)]) {
  const s = activeRoomStateSchema.parse(room());
  s.players = { [uuid(6)]: player(), [uuid(7)]: player(7) };
  s.phase = "QUESTION_ANSWERING";
  s.questionIndex = 0;
  s.accepting = true;
  s.requiredPlayerIds = required;
  s.eligiblePlayerIds = [...required];
  s.timing = {
    phaseStartedAt: 1000,
    phaseEndsAt: 21000,
    questionStartedAt: 1000,
    inputClosesAt: 21000,
    acceptanceClosesAt: 22500,
  };
  return s;
}

const project: RoomProjector = (s, principal, now) => {
  if (principal.role !== "player") throw new Error("player fixture only");
  return playerRoomSyncSchema.parse({
    role: "player",
    sessionId: s.sessionId,
    pinCode: s.pinCode,
    phase: s.phase,
    revision: s.revision,
    publicRevision: s.publicRevision,
    phaseVersion: s.phaseVersion,
    serverTime: now,
    quizTitle: s.quiz.title,
    totalQuestions: s.quiz.questions.length,
    displayMode: s.displayMode,
    friendlyNicknames: s.friendlyNicknames,
    isLocked: s.isLocked,
    maxPlayers: s.maxPlayers,
    players: Object.values(s.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      connected: p.connected,
      joinOrder: p.joinOrder,
    })),
    timing: s.timing,
    question: null,
    reveal: null,
    leaderboard: null,
    podium: [],
    endReason: null,
    self: {
      playerId: principal.playerId,
      score: 0,
      streak: 0,
      rank: null,
      acceptedAnswer: null,
      result: null,
    },
  });
};

function result(s: ActiveRoomState) {
  return questionResultSchema.parse({
    questionIndex: 0,
    reveal: {
      type: "TYPE_ANSWER",
      questionIndex: 0,
      correctOptionIds: [],
      acceptedTexts: ["Neko"],
      correctOrderIds: [],
      optionCounts: [],
      correctCount: 1,
      partialCount: 0,
      incorrectCount: 0,
      unansweredCount: 0,
      explanationText: null,
    },
    personal: {},
    leaderboard: { topPlayers: [], biggestClimber: null },
    playerTotals: Object.fromEntries(
      Object.keys(s.players).map((id) => [
        id,
        {
          score: 1000,
          streak: 1,
          maxStreak: 1,
          correctCount: 1,
          responseSumMs: 100,
          responseCount: 1,
          rank: id === uuid(6) ? 1 : 2,
          previousRank: null,
        },
      ]),
    ),
  });
}

/** Throws when a value is missing (typed narrowing for assertions). */
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing value");
  return value;
}
/** A finished-question state: question 0 scored, question 1 answering, both answered by player 6. */
function twoQuestions(): ActiveRoomState {
  const s = answering([uuid(6)]);
  const second = { ...question(), id: uuid(9), orderIndex: 1 };
  s.quiz.questions = [question(), second] as never;
  s.questionIndex = 1;
  const stored = (q: number) => ({
    playerId: uuid(6),
    submissionId: uuid(30 + q),
    questionIndex: q,
    questionId: q === 0 ? uuid(2) : uuid(9),
    answer: "Neko",
    payloadHash: "c".repeat(64),
    receivedAt: 2000 + q,
    responseTimeMs: 1000,
  });
  s.answers = { [`0:${uuid(6)}`]: stored(0), [`1:${uuid(6)}`]: stored(1) };
  s.closedQuestions = {
    "0": {
      questionIndex: 0,
      phaseVersion: 3,
      closedAt: 22000,
      reason: "TIMER",
      hash: "d".repeat(64),
      requiredPlayerIds: [uuid(6)],
      eligiblePlayerIds: [uuid(6)],
      answers: [stored(0)],
    },
  };
  s.results = { "0": result(s) };
  return activeRoomStateSchema.parse(s);
}

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let redis: Redis;
let store: RedisV2StateStore;
/** Creates the room from `state` with timestamps around the Redis clock's present. */
async function seed(state: ActiveRoomState = activeRoomStateSchema.parse(room())) {
  const now = Date.now();
  state.createdAt = now;
  state.lobbyActiveAt = now;
  state.hardExpiresAt = now + 28_800_000;
  return store.createRoom(identity.pin, state, 28_800_000);
}
beforeAll(async () => {
  runtime = await createTestRuntime();
  redis = new Redis((await runtime.redis()).getConnectionUrl(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
  });
  redis.on("error", () => undefined);
  await redis.connect();
});
afterAll(async () => {
  redis?.disconnect();
  await runtime?.cleanup();
});
beforeEach(async () => {
  await redis.flushdb();
  store = new RedisV2StateStore(redis, project, "v2contract");
});
afterEach(() => store.onModuleDestroy());

it("creates a room once into separate keys and reads it back equal (full and window)", async () => {
  const state = twoQuestions();
  expect(await seed(state)).toBe("CREATED");
  expect(await seed(twoQuestions())).toBe("EXISTS");
  // One JSON blob no more: the pieces live under their own keys.
  expect(await redis.hexists(`${PREFIX}:meta`, "state")).toBe(0);
  expect(await redis.hlen(`${PREFIX}:players`)).toBe(2);
  expect(await redis.hlen(`${PREFIX}:answers:1`)).toBe(1);
  expect(await redis.exists(`${PREFIX}:closed:0`, `${PREFIX}:result:0`)).toBe(2);
  const full = required(await store.getPrivateSnapshot(identity));
  expect(full).toEqual(state);
  const window = required(await store.readPrivateSnapshot(identity));
  expect(window).toEqual(windowRoomState(state));
  // Unchanged pieces return the same window object; another session or PIN reads nothing.
  expect(await store.readPrivateSnapshot(identity)).toBe(window);
  expect(await store.getPrivateSnapshot({ ...identity, sessionId: uuid(90) })).toBeNull();
  expect(await store.readPrivateSnapshot({ ...identity, pin: "999999" })).toBeNull();
  // Empty collections survive the cjson round trip as the schema's arrays and records.
  expect(await seed(activeRoomStateSchema.parse(room()))).toBe("EXISTS");
  await redis.flushdb();
  await seed();
  const lobby = required(await store.getPrivateSnapshot(identity));
  expect(lobby.requiredPlayerIds).toEqual([]);
  expect(lobby.players).toEqual({});
  expect(lobby.quiz.questions[0]?.accessibility.captions).toEqual([]);
});

it("releases every room key by name and refuses a release before the report is durable", async () => {
  await seed(twoQuestions());
  // A room without a frozen report is released at once, every key included.
  expect(await store.releaseRoom({ ...identity, sessionId: uuid(90) })).toBe(false);
  expect(await store.releaseRoom(identity)).toBe(true);
  expect(await redis.keys(`${PREFIX}*`)).toEqual([]);
  expect(await store.getPrivateSnapshot(identity)).toBeNull();
  expect(await store.readPrivateSnapshot(identity)).toBeNull();
});

it("runs scheduler leases with epochs and fails them for a missing room", async () => {
  await seed();
  const lease = required(await store.acquireLease(identity, uuid(60), 3000));
  expect(lease).toMatchObject({ ownerId: uuid(60), epoch: 1 });
  expect(await store.acquireLease(identity, uuid(61), 3000)).toBeNull();
  expect(await store.renewLease(identity, lease, 3000)).toBe(true);
  expect(await store.renewLease(identity, { ...lease, epoch: 9 }, 3000)).toBe(false);
  expect(await store.releaseLease(identity, lease)).toBe(true);
  expect(required(await store.acquireLease(identity, uuid(61), 3000)).epoch).toBe(2);
  await expect(
    store.acquireLease({ ...identity, sessionId: uuid(90) }, uuid(61), 3000),
  ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
});

it("freezes the report once, persists the room, gates ready on durability and then releases", async () => {
  const state = twoQuestions();
  state.phase = "PODIUM";
  await seed(state);
  const before = required(await store.getPrivateSnapshot(identity));
  const report = frozenReportSchema.parse(report_());
  expect(await store.freezeReport(identity, before.revision + 1, report)).toBe("RETRY");
  expect(await store.freezeReport(identity, before.revision, report)).toBe("COMMITTED");
  expect(await store.freezeReport(identity, before.revision + 1, report)).toBe("RETRY");
  // The room now outlives its safety TTL until released.
  expect(await redis.pttl(`${PREFIX}:meta`)).toBe(-1);
  expect(await redis.pttl(`${PREFIX}:players`)).toBe(-1);
  const frozen = required(await store.getPrivateSnapshot(identity));
  expect(frozen.frozenReport).toEqual(report);
  expect(frozen.revision).toBe(before.revision + 1);
  const status = {
    sessionId: identity.sessionId,
    status: "ready" as const,
    reportId: identity.sessionId,
    retryable: false,
    errorCode: null,
    updatedAt: 1,
  };
  await expect(store.markFinalization(identity, status)).rejects.toMatchObject({
    code: "FINALIZATION_PENDING",
  });
  expect(await store.releaseRoom(identity)).toBe(false);
  await store.acknowledgeDurableReport(identity);
  expect(await store.markFinalization(identity, status)).toBe(frozen.revision + 1);
  expect(required(await store.getPrivateSnapshot(identity)).finalization).toEqual(status);
  expect(await store.releaseRoom(identity)).toBe(true);
  expect(await redis.keys(`${PREFIX}*`)).toEqual([]);
});

/** Joins player 6 (or `n`) with a fixed request id, as a retried join would. */
function join(n = 6, friendlyTicketHash: string | null = null) {
  return store.bindPlayer({
    ...identity,
    requestId: uuid(30 + n),
    payloadHash: "a".repeat(64),
    connectionId: "join",
    binding: { kind: "join", player: player(n), sessionToken: "a".repeat(43), friendlyTicketHash },
  });
}

it("retries joins without a second slot, recovers and rejects old generations (TASK-185N)", async () => {
  await seed();
  const first = await join();
  expect(first.generation).toBe(1);
  const second = await join();
  expect(second.generation).toBe(2);
  expect(second.token).toBe(first.token);
  expect(await redis.hlen(`${PREFIX}:players`)).toBe(1);
  expect(await store.setPresence(identity, uuid(6), 1, false)).toBe(false);
  await expect(
    store.getRoleSnapshot(identity, { role: "player", playerId: uuid(6), generation: 1 }),
  ).rejects.toMatchObject({ code: "SESSION_REPLACED" });
  const recovered = await store.bindPlayer({
    ...identity,
    requestId: uuid(41),
    payloadHash: "b".repeat(64),
    connectionId: "recover",
    binding: { kind: "recover", playerId: uuid(6), tokenHash: player().tokenHash },
  });
  expect(recovered.generation).toBe(3);
  expect(recovered.token).toBeNull();
  expect(JSON.stringify(recovered.snapshot)).not.toContain("tokenHash");
  await expect(
    store.bindPlayer({
      ...identity,
      requestId: uuid(42),
      payloadHash: "b".repeat(64),
      connectionId: "recover",
      binding: { kind: "recover", playerId: uuid(6), tokenHash: "f".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "INVALID_SESSION_TOKEN" });
  await expect(
    store.getRoleSnapshot(identity, { role: "host", hostId: uuid(90) }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  // A different payload under the same join request id is a conflict.
  await expect(
    store.bindPlayer({
      ...identity,
      requestId: uuid(36),
      payloadHash: "e".repeat(64),
      connectionId: "join",
      binding: {
        kind: "join",
        player: player(),
        sessionToken: "a".repeat(43),
        friendlyTicketHash: null,
      },
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("tracks presence and lobby avatars per player field only (TASK-185N)", async () => {
  await seed();
  const joined = await join();
  await join(7);
  const before = required(await store.getPrivateSnapshot(identity)).revision;
  expect(await store.setPresence(identity, uuid(6), joined.generation, false)).toBe(true);
  const offline = required(await store.getPrivateSnapshot(identity));
  expect(offline.players[uuid(6)]).toMatchObject({ connected: false, connectionId: null });
  expect(offline.players[uuid(7)]?.connected).toBe(true);
  expect(offline.revision).toBe(before + 1);
  expect(offline.publicRevision).toBe(offline.revision);
  const revision = await store.updateAvatar(identity, uuid(6), joined.generation, {
    style: "bottts",
    seed: "new",
  });
  expect(revision).toBe(offline.revision + 1);
  expect(required(await store.getPrivateSnapshot(identity)).players[uuid(6)]?.avatar.seed).toBe(
    "new",
  );
  await expect(
    store.updateAvatar(identity, uuid(6), joined.generation + 5, { style: "bottts", seed: "x" }),
  ).rejects.toMatchObject({ code: "SESSION_REPLACED" });
  await expect(
    store.updateAvatar(identity, uuid(99), 1, { style: "bottts", seed: "x" }),
  ).rejects.toMatchObject({ code: "INVALID_SESSION_TOKEN" });
  await expect(
    store.updateAvatar(identity, uuid(6), joined.generation, { style: "nope", seed: "x" }),
  ).rejects.toMatchObject({ code: "INVALID_FORMAT" });
});

it("refuses duplicate nicknames and joins friendly rooms only through the socket's ticket (TASK-185N)", async () => {
  await seed();
  await join();
  await expect(
    store.bindPlayer({
      ...identity,
      requestId: uuid(50),
      payloadHash: "a".repeat(64),
      connectionId: "other",
      binding: {
        kind: "join",
        player: { ...player(8), nicknameKey: player().nicknameKey },
        sessionToken: "a".repeat(43),
        friendlyTicketHash: null,
      },
    }),
  ).rejects.toMatchObject({ code: "NICKNAME_TAKEN" });
  await store.releaseRoom(identity);
  await seed(activeRoomStateSchema.parse({ ...room(), friendlyNicknames: true }));
  const now = Date.now();
  await store.reserveFriendlyTicket(identity, {
    nickname: player().nickname,
    tokenHash: "b".repeat(64),
    socketId: "join",
    expiresAt: now + 119000,
    consumed: false,
  });
  await expect(join()).rejects.toMatchObject({ code: "NICKNAME_INVALID" });
  const joined = await join(6, "b".repeat(64));
  expect(joined.generation).toBe(1);
  // The ticket is consumed once.
  expect(JSON.parse(required(await redis.hget(`${PREFIX}:tickets`, "b".repeat(64)))).consumed).toBe(
    true,
  );
  await expect(
    store.reserveFriendlyTicket(identity, {
      nickname: player().nickname,
      tokenHash: "c".repeat(64),
      socketId: "late",
      expiresAt: now + 119000,
      consumed: false,
    }),
  ).rejects.toMatchObject({ code: "NICKNAME_TAKEN" });
});

/** An answer submission of player `n` for question `q` (fixture question ids: q0 = uuid(2)). */
function answer(n = 6, q = 0, questionId = uuid(2)) {
  return {
    ...identity,
    playerId: uuid(n),
    generation: 1,
    submissionId: uuid(n + 1000 + q * 100),
    questionId,
    questionIndex: q,
    answer: "Neko",
  };
}
/** Seeds an answering room whose acceptance window sits around the Redis clock's present. */
async function seedAnswering(state: ActiveRoomState, closesInMs = 21_400) {
  const now = Date.now();
  const startedAt = now + closesInMs - 21_500;
  state.timing = {
    phaseStartedAt: startedAt,
    phaseEndsAt: now + closesInMs - 1500,
    questionStartedAt: startedAt,
    inputClosesAt: now + closesInMs - 1500,
    acceptanceClosesAt: now + closesInMs,
  };
  return seed(state);
}
/** The stored room core (raw `:meta` field), for counters the assembled state does not expose. */
async function storedCore(): Promise<{ answeredRequired: number; revision: number }> {
  return JSON.parse(required(await redis.hget(`${PREFIX}:meta`, "core"))) as {
    answeredRequired: number;
    revision: number;
  };
}

it("admits one answer, freezes once on the last required answer and replays (TASK-185O)", async () => {
  await seedAnswering(answering());
  const before = required(await store.getPrivateSnapshot(identity)).revision;
  const answers = await Promise.all([store.admitAnswer(answer()), store.admitAnswer(answer())]);
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0]).toMatchObject({ playerId: uuid(6), questionIndex: 0, answer: "Neko" });
  expect(answers[0].payloadHash).toMatch(/^[0-9a-f]{64}$/u);
  const frozen = required(await store.getPrivateSnapshot(identity));
  expect(frozen.accepting).toBe(false);
  expect(frozen.phase).toBe("QUESTION_ANSWERING");
  expect(frozen.revision).toBe(before + 1);
  expect(frozen.publicRevision).toBe(frozen.revision);
  const closed = required(frozen.closedQuestions[0]);
  expect(closed).toMatchObject({ reason: "ALL_ANSWERED", questionIndex: 0, phaseVersion: 1 });
  expect(closed.answers).toEqual([answers[0]]);
  expect(closed.hash).toMatch(/^[0-9a-f]{64}$/u);
  expect((await storedCore()).answeredRequired).toBe(1);
  // Freeze-once: a later close is ALREADY_CLOSED and leaves the record untouched.
  expect(
    await store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
  ).toBe("ALREADY_CLOSED");
  expect(required(await store.getPrivateSnapshot(identity)).closedQuestions[0]).toEqual(closed);
  // Replay of the same submission still returns the stored answer after the freeze.
  expect(await store.admitAnswer(answer())).toEqual(answers[0]);
  await expect(store.admitAnswer({ ...answer(), answer: "Other" })).rejects.toMatchObject({
    code: "ALREADY_ANSWERED",
  });
  // A non-required player cannot answer a frozen question.
  await expect(store.admitAnswer(answer(7))).rejects.toMatchObject({ code: "INVALID_PHASE" });
});

it("counts required answers, adds eligible players and refuses invalid submissions (TASK-185O)", async () => {
  await seedAnswering(answering([uuid(6), uuid(7)]));
  await store.admitAnswer(answer(6));
  let state = required(await store.getPrivateSnapshot(identity));
  expect(state.accepting).toBe(true);
  expect(state.closedQuestions).toEqual({});
  expect((await storedCore()).answeredRequired).toBe(1);
  // ALL_ANSWERED is checked against the stored answers.
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
  ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  await expect(store.admitAnswer({ ...answer(7), questionId: uuid(99) })).rejects.toMatchObject({
    code: "QUESTION_MISMATCH",
  });
  await expect(store.admitAnswer({ ...answer(7), answer: "" })).rejects.toMatchObject({
    code: "INVALID_ANSWER",
  });
  await expect(store.admitAnswer({ ...answer(7), generation: 2 })).rejects.toMatchObject({
    code: "SESSION_REPLACED",
  });
  await expect(store.admitAnswer(answer(8))).rejects.toMatchObject({
    code: "INVALID_SESSION_TOKEN",
  });
  await expect(store.admitAnswer({ ...answer(7), sessionId: uuid(77) })).rejects.toMatchObject({
    code: "ROOM_NOT_FOUND",
  });
  await store.admitAnswer(answer(7));
  state = required(await store.getPrivateSnapshot(identity));
  expect(state.accepting).toBe(false);
  expect(state.closedQuestions[0]?.answers.map((a) => a.playerId)).toEqual([uuid(6), uuid(7)]);
  expect((await storedCore()).answeredRequired).toBe(2);
});

it("adds a non-required answer to the eligible set without freezing (TASK-185O)", async () => {
  await seedAnswering(answering([uuid(6)]));
  await store.admitAnswer(answer(7));
  const state = required(await store.getPrivateSnapshot(identity));
  expect(state.eligiblePlayerIds).toEqual([uuid(6), uuid(7)]);
  expect(state.accepting).toBe(true);
  expect((await storedCore()).answeredRequired).toBe(0);
});

it("closes on the timer only after the inclusive deadline, and for host skips (TASK-185O)", async () => {
  // Deadline still open: TIMER is early, admission is allowed.
  await seedAnswering(answering([uuid(6), uuid(7)]));
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "TIMER" }),
  ).rejects.toMatchObject({ code: "TIME_EXPIRED" });
  await store.admitAnswer(answer(6));
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 2, reason: "TIMER" }),
  ).rejects.toMatchObject({ code: "STALE_PHASE" });
  const skipped = await store.closeQuestion({
    ...identity,
    expectedPhaseVersion: 1,
    reason: "HOST_SKIP",
  });
  expect(skipped).toMatchObject({ reason: "HOST_SKIP", questionIndex: 0 });
  expect(skipped !== "ALREADY_CLOSED" && skipped.answers.map((a) => a.playerId)).toEqual([uuid(6)]);

  // Deadline passed: admission is TIME_EXPIRED and the natural close freezes once.
  await redis.flushdb();
  await seedAnswering(answering([uuid(6), uuid(7)]), -1);
  await expect(store.admitAnswer(answer(6))).rejects.toMatchObject({ code: "TIME_EXPIRED" });
  const natural = await store.closeQuestion({
    ...identity,
    expectedPhaseVersion: 1,
    reason: "TIMER",
  });
  expect(natural).toMatchObject({ reason: "TIMER", answers: [] });
  const state = required(await store.getPrivateSnapshot(identity));
  expect(state.accepting).toBe(false);
  expect(state.closedQuestions[0]).toEqual(natural);
  expect(await store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "TIMER" })).toBe(
    "ALREADY_CLOSED",
  );
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "EXPIRED" }),
  ).resolves.toBe("ALREADY_CLOSED");
});

/**
 * A room on its last of `questions` questions with `players` players: every earlier question is
 * answered by everyone, frozen and scored; the current one is answering with everyone required.
 */
function playedRoom(questions: number, players: number): ActiveRoomState {
  const s = activeRoomStateSchema.parse(room());
  s.maxPlayers = 200;
  s.quiz.questions = Array.from({ length: questions }, (_, q) => ({
    ...question(),
    id: uuid(100_000 + q),
    orderIndex: q,
  })) as never;
  const ids = Array.from({ length: players }, (_, i) => uuid(1000 + i));
  s.players = Object.fromEntries(
    ids.map((id, i) => [id, { ...player(1000 + i), nickname: `Cat${i}`, nicknameKey: `cat${i}` }]),
  );
  const current = questions - 1;
  for (let q = 0; q < current; q += 1) {
    const stored = ids.map((id) => ({
      playerId: id,
      submissionId: uuid(200_000 + q * 1000 + ids.indexOf(id)),
      questionIndex: q,
      questionId: uuid(100_000 + q),
      answer: "Neko",
      payloadHash: "c".repeat(64),
      receivedAt: 2000,
      responseTimeMs: 1000,
    }));
    for (const a of stored) s.answers[`${q}:${a.playerId}`] = a;
    s.closedQuestions[String(q)] = {
      questionIndex: q,
      phaseVersion: q + 1,
      closedAt: 3000,
      reason: "ALL_ANSWERED",
      hash: "d".repeat(64),
      requiredPlayerIds: ids,
      eligiblePlayerIds: ids,
      answers: stored,
    };
    const scored = result(s);
    scored.questionIndex = q;
    scored.reveal.questionIndex = q;
    s.results[String(q)] = scored;
  }
  s.phase = "QUESTION_ANSWERING";
  s.questionIndex = current;
  s.phaseVersion = questions;
  s.accepting = true;
  s.requiredPlayerIds = ids;
  s.eligiblePlayerIds = [...ids];
  return activeRoomStateSchema.parse(s);
}
/** Median server-side duration (µs, SLOWLOG) of `admitAnswer` for every player but the last. */
async function admissionMicros(questions: number, players: number): Promise<number> {
  await redis.flushdb();
  // A fresh adapter: a session's quiz is cached, and this helper reseeds the same session id.
  store.onModuleDestroy();
  store = new RedisV2StateStore(redis, project, "v2contract");
  await seedAnswering(playedRoom(questions, players));
  const q = questions - 1;
  // Warm the script cache (a NOSCRIPT miss would log one extra EVALSHA) with a refused close.
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 0, reason: "TIMER" }),
  ).rejects.toMatchObject({ code: "STALE_PHASE" });
  await redis.slowlog("RESET");
  for (let i = 0; i < players - 1; i += 1)
    await store.admitAnswer({ ...answer(1000 + i, q, uuid(100_000 + q)) });
  const entries = (await redis.slowlog("GET", 10_000)) as [number, number, number, string[]][];
  const durations = entries
    .filter(([, , , command]) => /^(evalsha|eval)$/iu.test(command[0] ?? ""))
    .map(([, , micros]) => micros)
    .sort((a, b) => a - b);
  expect(durations).toHaveLength(players - 1);
  return durations[Math.floor(durations.length / 2)] ?? 0;
}

it("keeps admitAnswer's Redis cost flat after 20 questions x 50 players (TASK-185O)", async () => {
  // Tolerance (recorded in the implementation log): the median after 19 played questions stays
  // within 2x + 100 µs of the median on the first question. v1 decoded every played question.
  await redis.config("SET", "slowlog-log-slower-than", "0");
  await redis.config("SET", "slowlog-max-len", "10000");
  try {
    const first = await admissionMicros(1, 50);
    const late = await admissionMicros(20, 50);
    expect(late).toBeLessThanOrEqual(first * 2 + 100);
  } finally {
    await redis.config("SET", "slowlog-log-slower-than", "10000");
    await redis.config("SET", "slowlog-max-len", "128");
  }
});

/** A host command input for this room (TASK-185P). */
function host(
  event: "host:start_game" | "host:next_step" | "host:end_game" | "host:skip_timer",
  phaseVersion: number,
  requestId: string,
) {
  const request = {
    sessionId: identity.sessionId,
    pinCode: identity.pin,
    requestId,
    expectedPhaseVersion: phaseVersion,
  };
  return {
    ...identity,
    hostId: uuid(5),
    requestId,
    payloadHash: "a".repeat(64),
    expectedPhaseVersion: phaseVersion,
    command: { event, request },
  } as ApplyCommandInput;
}
/** Ends the current phase now by moving its stored deadline to its start (scheduler shortcut). */
async function endPhaseNow(): Promise<void> {
  const core = JSON.parse(required(await redis.hget(`${PREFIX}:meta`, "core"))) as {
    timing: { phaseStartedAt: number; phaseEndsAt: number | null };
  };
  core.timing.phaseEndsAt = core.timing.phaseStartedAt;
  await redis.hset(`${PREFIX}:meta`, "core", JSON.stringify(core));
}

it("plays two questions to PODIUM with commands, CAS transitions and result commits (TASK-185P)", async () => {
  const state = activeRoomStateSchema.parse(room());
  state.quiz.questions = [question(), { ...question(), id: uuid(9), orderIndex: 1 }] as never;
  state.players = { [uuid(6)]: player(), [uuid(7)]: { ...player(7), connected: false } };
  await seed(state);
  const start = await store.applyCommand(host("host:start_game", 1, uuid(40)));
  expect(start).toMatchObject({ committed: true, phaseVersion: 2 });
  expect(start.ack).toMatchObject({
    ok: true,
    data: { phase: "GAME_START_COUNTDOWN", phaseVersion: 2 },
  });
  // Replays return the stored ACK; another payload conflicts.
  expect((await store.applyCommand(host("host:start_game", 1, uuid(40)))).ack).toEqual(start.ack);
  await expect(
    store.applyCommand({ ...host("host:start_game", 1, uuid(40)), payloadHash: "b".repeat(64) }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const timing = required(await store.getPrivateSnapshot(identity)).timing;
  // Not due yet, then due: the CAS lets exactly one transition through.
  expect(await store.transitionPhase(identity, 2, "QUESTION_PREVIEW", timing, 0)).toBe(false);
  await endPhaseNow();
  const moved = await Promise.all([
    store.transitionPhase(identity, 2, "QUESTION_PREVIEW", timing, 0),
    store.transitionPhase(identity, 2, "QUESTION_PREVIEW", timing, 0),
  ]);
  expect(moved.sort()).toEqual([false, true]);
  await endPhaseNow();
  expect(await store.transitionPhase(identity, 3, "QUESTION_ANSWERING", timing, 0)).toBe(true);
  let s = required(await store.getPrivateSnapshot(identity));
  expect(s).toMatchObject({ phase: "QUESTION_ANSWERING", accepting: true, questionIndex: 0 });
  // Only connected players are required; the time limit comes from the quiz (20 s + 1.5 s grace).
  expect(s.requiredPlayerIds).toEqual([uuid(6)]);
  expect(required(s.timing.acceptanceClosesAt) - required(s.timing.questionStartedAt)).toBe(21_500);
  expect((await storedCore()).answeredRequired).toBe(0);
  await store.admitAnswer(answer());
  s = required(await store.getPrivateSnapshot(identity));
  const commit = {
    ...identity,
    expectedRevision: s.revision,
    closedQuestionHash: required(s.closedQuestions[0]).hash,
    result: result(s),
  };
  expect(await store.commitQuestionResult({ ...commit, closedQuestionHash: "e".repeat(64) })).toBe(
    "RETRY",
  );
  const outcomes = await Promise.all([
    store.commitQuestionResult(commit),
    store.commitQuestionResult(commit),
  ]);
  expect(outcomes.sort()).toEqual(["COMMITTED", "RETRY"]);
  s = required(await store.getPrivateSnapshot(identity));
  expect(s).toMatchObject({ phase: "ANSWER_REVEAL", phaseVersion: 5 });
  expect(s.players[uuid(6)]?.score).toBe(1000);
  expect(s.players[uuid(7)]?.rank).toBe(2);
  expect(s.results[0]).toEqual(result(s));
  expect(JSON.parse(required(await redis.hget(`${PREFIX}:meta`, "core"))).scoredQuestions).toEqual([
    0,
  ]);
  // Reveal -> leaderboard -> preview of question 1.
  await store.applyCommand(host("host:next_step", 5, uuid(41)));
  const preview = await store.applyCommand(host("host:next_step", 6, uuid(42)));
  expect(preview.ack).toMatchObject({
    ok: true,
    data: { phase: "QUESTION_PREVIEW", phaseVersion: 7 },
  });
  await expect(store.applyCommand(host("host:next_step", 6, uuid(43)))).rejects.toMatchObject({
    code: "STALE_PHASE",
  });
  await endPhaseNow();
  expect(await store.transitionPhase(identity, 7, "QUESTION_ANSWERING", timing, 1)).toBe(true);
  expect((await storedCore()).answeredRequired).toBe(0);
  // A host skip freezes question 1 and its ACK waits for the result commit.
  const skip = store.applyCommand(host("host:skip_timer", 8, uuid(44)));
  let frozen: ActiveRoomState | null = null;
  for (let i = 0; i < 100 && !frozen?.closedQuestions[1]; i += 1)
    frozen = await store.getPrivateSnapshot(identity);
  const closed = required(required(frozen).closedQuestions[1]);
  expect(closed).toMatchObject({ reason: "HOST_SKIP", answers: [] });
  const second = result(required(frozen));
  second.questionIndex = 1;
  second.reveal.questionIndex = 1;
  expect(
    await store.commitQuestionResult({
      ...identity,
      expectedRevision: required(frozen).revision,
      closedQuestionHash: closed.hash,
      result: second,
    }),
  ).toBe("COMMITTED");
  expect((await skip).ack).toMatchObject({
    ok: true,
    data: { phase: "ANSWER_REVEAL", phaseVersion: 9 },
  });
  // The last reveal ends the game: PODIUM, COMPLETED, pending finalization.
  await store.applyCommand(host("host:next_step", 9, uuid(45)));
  s = required(await store.getPrivateSnapshot(identity));
  expect(s).toMatchObject({ phase: "PODIUM", endReason: "COMPLETED", phaseVersion: 10 });
  expect(s.finalization).toMatchObject({ status: "pending", retryable: true });
  expect(Object.keys(s.results)).toEqual(["0", "1"]);
  await endPhaseNow();
  expect(await store.transitionPhase(identity, 10, "FINISHED", timing, 1)).toBe(true);
  expect(required(await store.getPrivateSnapshot(identity)).phase).toBe("FINISHED");
});

it("locks the lobby, kicks players and ends a game outside ANSWERING (TASK-185P)", async () => {
  await seed();
  const lock: ApplyCommandInput = {
    ...identity,
    hostId: uuid(5),
    requestId: uuid(50),
    payloadHash: "a".repeat(64),
    expectedPhaseVersion: 1,
    command: {
      event: "host:lock_room",
      request: { sessionId: uuid(1), pinCode: "000123", requestId: uuid(50), isLocked: true },
    },
  } as ApplyCommandInput;
  await expect(store.applyCommand({ ...lock, hostId: uuid(99) })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect((await store.applyCommand(lock)).ack).toMatchObject({
    ok: true,
    data: { isLocked: true },
  });
  await expect(join()).rejects.toMatchObject({ code: "ROOM_LOCKED" });
  await expect(store.applyCommand(host("host:start_game", 1, uuid(51)))).rejects.toMatchObject({
    code: "NO_PLAYERS",
  });

  // Kicking an unanswered required player during ANSWERING removes it from the open question.
  await redis.flushdb();
  await seedAnswering(answering([uuid(6), uuid(7)]));
  await store.admitAnswer(answer(6));
  const kick = (playerId: string, requestId: string) =>
    store.applyCommand({
      ...identity,
      hostId: uuid(5),
      requestId,
      payloadHash: "a".repeat(64),
      expectedPhaseVersion: 1,
      command: {
        event: "host:kick_player",
        request: { sessionId: uuid(1), pinCode: "000123", requestId, playerId },
      },
    } as ApplyCommandInput);
  expect((await kick(uuid(7), uuid(52))).ack).toMatchObject({
    ok: true,
    data: { kicked: true, playerId: uuid(7) },
  });
  let s = required(await store.getPrivateSnapshot(identity));
  expect(s.requiredPlayerIds).toEqual([uuid(6)]);
  expect(s.players[uuid(7)]).toMatchObject({ connected: false, connectionGeneration: 2 });
  expect(s.players[uuid(7)]?.kickedAt).not.toBeNull();
  await expect(kick(uuid(7), uuid(53))).rejects.toMatchObject({ code: "PLAYER_KICKED" });
  await expect(kick(uuid(8), uuid(54))).rejects.toMatchObject({ code: "NOT_FOUND" });
  // The remaining required answers are in: ALL_ANSWERED now closes the question.
  expect(
    await store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
  ).toMatchObject({ reason: "ALL_ANSWERED", requiredPlayerIds: [uuid(6)] });

  // end_game outside ANSWERING commits PODIUM at once.
  await redis.flushdb();
  const reveal = answering();
  reveal.phase = "LEADERBOARD";
  reveal.accepting = false;
  await seed(reveal);
  const ended = await store.applyCommand(host("host:end_game", 1, uuid(55)));
  expect(ended).toMatchObject({ committed: true, phaseVersion: 2 });
  expect(ended.ack).toMatchObject({
    ok: true,
    data: { phase: "PODIUM", finalization: { status: "pending" } },
  });
  s = required(await store.getPrivateSnapshot(identity));
  expect(s).toMatchObject({ phase: "PODIUM", endReason: "HOST_ENDED" });
  await expect(store.applyCommand(host("host:skip_timer", 2, uuid(56)))).rejects.toMatchObject({
    code: "INVALID_PHASE",
  });
});

// Cases kept from the layout-v1 script contracts removed in TASK-185R.
it("matches SHA-256 test vectors in the freeze script (TASK-185R)", async () => {
  const script = await readFile(
    path.join(__dirname, "../../apps/api/src/providers/state/lua/v2-answer.lua"),
    "utf8",
  );
  const fn = script.slice(
    script.indexOf("local function sha256"),
    script.indexOf("local function freeze"),
  );
  for (const value of ["", "abc", "a".repeat(1000), "猫/🐱"])
    expect(await redis.eval(`${fn}return sha256(ARGV[1])`, 0, value)).toBe(
      createHash("sha256").update(value).digest("hex"),
    );
});

it("never vacuously closes an empty required set (TASK-185R)", async () => {
  await seedAnswering(answering([]));
  await store.admitAnswer(answer());
  expect(required(await store.getPrivateSnapshot(identity)).accepting).toBe(true);
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
  ).rejects.toMatchObject({ code: "INVALID_PHASE" });
});

it("reserves capacity under concurrent joins (TASK-185R)", async () => {
  await seed(activeRoomStateSchema.parse({ ...room(), maxPlayers: 1 }));
  const results = await Promise.allSettled([join(6), join(7)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results.filter((r) => r.status === "rejected" && r.reason.code === "ROOM_FULL"),
  ).toHaveLength(1);
});

it("never reads another layout's keys (ADR-13 migration by draining)", async () => {
  await seed();
  await redis.hset(`kabukineko:v2contract:room:{000124}:meta`, "sessionId", identity.sessionId);
  await redis.hset(`kabukineko:v2contract:room:{000124}:meta`, "state", "{}");
  expect(await store.getPrivateSnapshot({ ...identity, pin: "000124" })).toBeNull();
});
