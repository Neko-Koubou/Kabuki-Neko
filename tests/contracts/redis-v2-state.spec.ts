/**
 * TASK-185M contract: the Redis v2 room layout (ADR-13, SA §6.1.1) against a real Redis.
 * Covers what TASK-185M ports: room creation (CREATED/EXISTS), the full and window reads (equal to
 * the seeded state, window limited to the current and latest scored question), the release that
 * deletes every room key by name, scheduler leases, the frozen report, durability and the
 * finalization status. Gameplay operations join this contract in TASK-185N/O/P.
 */
import { createHash } from "node:crypto";
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

it("fails the gameplay operations that later tasks port closed, never on another layout", async () => {
  await seed();
  await expect(
    store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "TIMER" }),
  ).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
  // v1 keys are never read by v2 (ADR-13 migration by draining).
  await redis.hset(`kabukineko:v2contract:room:{${identity.pin}}:meta`, "state", "{}");
  expect(await store.getPrivateSnapshot({ ...identity, pin: "000124" })).toBeNull();
});
