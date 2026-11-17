import { randomInt } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { once } from "node:events";
import { Server } from "../../apps/api/node_modules/socket.io";
import { createHash } from "node:crypto";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { playerRoomSyncSchema } from "@kabuki-neko/shared/schemas/game.schema";
import {
  activeRoomStateSchema,
  activePlayerSchema,
  questionResultSchema,
  frozenReportSchema,
} from "../../apps/api/src/providers/state/private-state.schema";
import type {
  ActiveRoomState,
  RoomProjector,
  ApplyCommandInput,
  HostCommand,
} from "../../apps/api/src/providers/state/game-state.interface";
import Redis from "ioredis";
import { setTimeout as delay } from "node:timers/promises";
import {
  RedisStateStore,
  restoreArrays,
} from "../../apps/api/src/providers/state/redis-state.store";
import { StateConnections, StateProjection } from "../../apps/api/src/providers/state/state.module";
import { ConfigService } from "../../apps/api/src/config/config.service";
import { createTestRuntime } from "../helpers/runtime";
import type { IGameStateStore } from "../../apps/api/src/providers/state/game-state.interface";
import { MemoryStateStore } from "../../apps/api/src/providers/state/memory-state.store";
import { GameService } from "../../apps/api/src/modules/game-engine/game.service";
import type { JwtGuard, VerifiedPrincipal } from "../../apps/api/src/common/guards/jwt.guard";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
function report() {
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

const identity = { pin: "000123", sessionId: uuid(1) };
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
function answer(n = 6) {
  return {
    ...identity,
    playerId: uuid(n),
    generation: 1,
    submissionId: uuid(n + 10),
    questionId: uuid(2),
    questionIndex: 0,
    answer: "Neko",
  };
}
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
function command(
  event: "host:skip_timer" | "host:end_game" = "host:skip_timer",
): ApplyCommandInput {
  return {
    ...identity,
    hostId: uuid(5),
    requestId: uuid(20),
    payloadHash: "a".repeat(64),
    expectedPhaseVersion: 1,
    command: {
      event,
      request: {
        sessionId: uuid(1),
        pinCode: "000123",
        requestId: uuid(20),
        expectedPhaseVersion: 1,
      },
    },
  };
}
jest.setTimeout(30000);

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let redis: Redis;
let redisUrl: string;
beforeAll(async () => {
  runtime = await createTestRuntime();
  redisUrl = (await runtime.redis()).getConnectionUrl();
  redis = new Redis(redisUrl, {
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

for (const driver of ["memory", "redis"] as const)
  describe(`${driver} state contract`, () => {
    let store: IGameStateStore;
    let cleanup: () => void;
    let now: number;
    beforeEach(async () => {
      now = Date.now();
      if (driver === "redis") {
        const adapter = new RedisStateStore(redis, project, "parity");
        store = adapter;
        cleanup = () => adapter.onModuleDestroy();
        await redis.flushdb();
      } else {
        const adapter = new MemoryStateStore(project, () => now);
        store = adapter;
        cleanup = () => adapter.onModuleDestroy();
      }
    });
    afterEach(() => cleanup());
    const seed = async (state = activeRoomStateSchema.parse(room()), ttl = 28_800_000) => {
      state.createdAt = now;
      state.lobbyActiveAt = now;
      state.hardExpiresAt = now + 28_800_000;
      if (state.phase === "QUESTION_ANSWERING")
        state.timing = {
          phaseStartedAt: now - 100,
          phaseEndsAt: now + 19900,
          questionStartedAt: now - 100,
          inputClosesAt: now + 19900,
          acceptanceClosesAt: now + 21400,
        };
      return store.createRoom(identity.pin, state, ttl);
    };
    const join = () =>
      store.bindPlayer({
        ...identity,
        requestId: uuid(30),
        payloadHash: "a".repeat(64),
        connectionId: "join",
        binding: {
          kind: "join",
          player: player(),
          sessionToken: "a".repeat(43),
          friendlyTicketHash: null,
        },
      });
    it("creates once, preserves empty arrays and returns detached private state", async () => {
      expect(await seed()).toBe("CREATED");
      expect(await seed()).toBe("EXISTS");
      const s = required(await store.getPrivateSnapshot(identity));
      expect(s.requiredPlayerIds).toEqual([]);
      expect(s.quiz.questions[0]?.publicOptions).toEqual([]);
      s.quiz.title = "Changed locally";
      expect((await store.getPrivateSnapshot(identity))?.quiz.title).toBe("Cats");
      expect(await store.getPrivateSnapshot({ ...identity, sessionId: uuid(90) })).toBeNull();
      expect(await store.releaseRoom({ ...identity, sessionId: uuid(90) })).toBe(false);
    });
    it("serves the read-only state equal to the validated read through a scored question (TASK-185F)", async () => {
      const same = async () => {
        const light = await store.readPrivateSnapshot(identity);
        expect(light).toEqual(await store.getPrivateSnapshot(identity));
        return light;
      };
      // Lobby: empty arrays (cjson stores them as {}) and empty records stay distinct.
      await seed();
      const lobby = required(await same());
      expect(lobby.requiredPlayerIds).toEqual([]);
      expect(lobby.players).toEqual({});
      expect(lobby.quiz.questions[0]?.publicOptions).toEqual([]);
      // An unchanged state is served without parsing it again.
      expect(await store.readPrivateSnapshot(identity)).toBe(lobby);
      await store.releaseRoom(identity);
      expect(await store.readPrivateSnapshot(identity)).toBeNull();
      // Answering, frozen and scored.
      await seed(answering());
      await same();
      await store.admitAnswer(answer());
      const frozen = required(await same());
      expect(frozen.closedQuestions[0]?.answers).toHaveLength(1);
      await store.commitQuestionResult({
        ...identity,
        expectedRevision: frozen.revision,
        closedQuestionHash: required(frozen.closedQuestions[0]).hash,
        result: result(frozen),
      });
      const scored = required(await same());
      expect(scored.players[uuid(6)]?.score).toBe(1000);
      expect(await store.readPrivateSnapshot({ ...identity, sessionId: uuid(90) })).toBeNull();
      if (driver === "redis") {
        // A state the schema rejects is still refused by the validated read.
        const [meta] = ["meta"].map(
          (suffix) => `kabukineko:parity:room:{${identity.pin}}:${suffix}`,
        );
        const stored = JSON.parse(required(await redis.hget(required(meta), "state"))) as {
          players: Record<string, { nickname: string }>;
        };
        required(stored.players[uuid(6)]).nickname = "x".repeat(500);
        await redis.hset(required(meta), "state", JSON.stringify(stored));
        await expect(store.getPrivateSnapshot(identity)).rejects.toMatchObject({
          code: "STATE_UNAVAILABLE",
        });
      }
    });
    it("runs scheduler lease operations without decoding the room state (TASK-185H)", async () => {
      if (driver !== "redis") return;
      await seed();
      // A state Redis cannot decode: only the release, which needs it, may read it.
      const meta = `kabukineko:parity:room:{${identity.pin}}:meta`;
      await redis.hset(meta, "state", "{not json");
      const lease = required(await store.acquireLease(identity, uuid(60), 3000));
      expect(lease).toMatchObject({ ownerId: uuid(60), epoch: 1 });
      expect(await store.renewLease(identity, lease, 3000)).toBe(true);
      expect(await store.releaseLease(identity, lease)).toBe(true);
      await expect(
        store.acquireLease({ ...identity, sessionId: uuid(90) }, uuid(61), 3000),
      ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
      await expect(store.releaseRoom(identity)).rejects.toMatchObject({
        code: "STATE_UNAVAILABLE",
      });
    });
    it("reads room state with HMGET, never through a Lua script (TASK-185J)", async () => {
      if (driver !== "redis") return;
      await seed(answering());
      /** Calls of each command so far (`INFO commandstats`). */
      const calls = async () => {
        const info = await redis.info("commandstats");
        const count = (name: string) =>
          Number(new RegExp(`cmdstat_${name}:calls=(\\d+)`, "u").exec(info)?.[1] ?? "0");
        return { scripts: count("evalsha") + count("eval"), hmget: count("hmget") };
      };
      const before = await calls();
      expect(await store.readPrivateSnapshot(identity)).not.toBeNull();
      expect(await store.getPrivateSnapshot(identity)).not.toBeNull();
      expect(await store.readPrivateSnapshot({ ...identity, sessionId: uuid(90) })).toBeNull();
      const after = await calls();
      expect(after.scripts).toBe(before.scripts);
      expect(after.hmget - before.hmget).toBe(3);
    });
    it("retries joins without a second slot, recovers and rejects old generations", async () => {
      await seed();
      const first = await join();
      expect(first.generation).toBe(1);
      const second = await join();
      expect(second.generation).toBe(2);
      expect(second.token).toBe(first.token);
      expect(Object.keys(required(await store.getPrivateSnapshot(identity)).players)).toHaveLength(
        1,
      );
      expect(await store.setPresence(identity, uuid(6), 1, false)).toBe(false);
      await expect(
        store.getRoleSnapshot(identity, { role: "player", playerId: uuid(6), generation: 1 }),
      ).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      const recovered = await store.bindPlayer({
        ...identity,
        requestId: uuid(31),
        payloadHash: "b".repeat(64),
        connectionId: "recover",
        binding: { kind: "recover", playerId: uuid(6), tokenHash: player().tokenHash },
      });
      expect(recovered.generation).toBe(3);
      expect(recovered.token).toBeNull();
      expect(JSON.stringify(recovered.snapshot)).not.toContain("tokenHash");
      await expect(
        store.getRoleSnapshot(identity, { role: "host", hostId: uuid(90) }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    it("deduplicates commands and rejects mismatched identities", async () => {
      await seed();
      const lock: ApplyCommandInput = {
        ...command(),
        command: {
          event: "host:lock_room",
          request: {
            pinCode: identity.pin,
            sessionId: identity.sessionId,
            requestId: uuid(20),
            isLocked: true,
          },
        },
      };
      const first = await store.applyCommand(lock);
      const second = await store.applyCommand(lock);
      expect(first.committed).toBe(true);
      expect(second.committed).toBe(false);
      expect(first.ack).toEqual(second.ack);
      await expect(
        store.applyCommand({ ...lock, payloadHash: "b".repeat(64) }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(store.applyCommand({ ...lock, requestId: uuid(90) })).rejects.toMatchObject({
        code: "INVALID_REFERENCE",
      });
      await expect(join()).rejects.toMatchObject({ code: "ROOM_LOCKED" });
    });
    it("admits one answer, freezes once and CAS commits complete totals", async () => {
      await seed(answering());
      const answers = await Promise.all([store.admitAnswer(answer()), store.admitAnswer(answer())]);
      expect(answers[0]).toEqual(answers[1]);
      const frozen = required(await store.getPrivateSnapshot(identity));
      expect(frozen.accepting).toBe(false);
      expect(frozen.phase).toBe("QUESTION_ANSWERING");
      expect(frozen.closedQuestions[0]?.answers).toHaveLength(1);
      expect(
        await store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
      ).toBe("ALREADY_CLOSED");
      const commit = {
        ...identity,
        expectedRevision: frozen.revision,
        closedQuestionHash: required(frozen.closedQuestions[0]).hash,
        result: result(frozen),
      };
      const outcomes = await Promise.all([
        store.commitQuestionResult(commit),
        store.commitQuestionResult(commit),
      ]);
      expect(outcomes.sort()).toEqual(["COMMITTED", "RETRY"]);
      expect((await store.getPrivateSnapshot(identity))?.players[uuid(6)]?.score).toBe(1000);
      expect(await store.admitAnswer(answer())).toEqual(answers[0]);
      await expect(store.admitAnswer({ ...answer(), answer: "Other" })).rejects.toMatchObject({
        code: "ALREADY_ANSWERED",
      });
    });
    it("closes ALL_ANSWERED and scores when the last unanswered required player is kicked", async () => {
      // MJ-03: the Redis kick script does not freeze; GameService drives the close for both stores.
      await seed(answering([uuid(6), uuid(7)]));
      await store.admitAnswer(answer(6));
      const jwt = { current: async () => ({ id: uuid(5) }) } as unknown as JwtGuard;
      const game = new GameService(store, jwt, () => Date.now());
      const ack = await game.hostCommand(
        { user: { id: uuid(5) } } as VerifiedPrincipal,
        {
          event: "host:kick_player",
          request: {
            pinCode: identity.pin,
            sessionId: identity.sessionId,
            requestId: uuid(21),
            playerId: uuid(7),
          },
        } as HostCommand,
      );
      expect(ack).toMatchObject({ ok: true, data: { kicked: true, playerId: uuid(7) } });
      const s = required(await store.getPrivateSnapshot(identity));
      expect(s.closedQuestions[0]?.reason).toBe("ALL_ANSWERED");
      expect(s.phase).toBe("ANSWER_REVEAL");
      expect(s.results[0]).toBeDefined();
    });
    it("expires a started game outside ANSWERING to PODIUM only after the hard lifetime", async () => {
      // Code review MJ-06: the same atomic step on both stores.
      const state = activeRoomStateSchema.parse(room());
      state.players = { [uuid(6)]: player() };
      state.phase = "LEADERBOARD";
      state.questionIndex = 0;
      state.createdAt = now;
      state.lobbyActiveAt = now;
      state.hardExpiresAt = Date.now() + 300;
      expect(await store.createRoom(identity.pin, state, 28_800_000)).toBe("CREATED");
      await expect(store.expireToPodium(identity, 1)).rejects.toMatchObject({
        code: "INVALID_PHASE",
      });
      await delay(400);
      now = Date.now();
      expect(await store.expireToPodium(identity, 7)).toBe(false);
      expect(await store.expireToPodium(identity, 1)).toBe(true);
      const ended = required(await store.getPrivateSnapshot(identity));
      expect(ended).toMatchObject({ phase: "PODIUM", phaseVersion: 2, endReason: "EXPIRED" });
      expect(ended.finalization).toMatchObject({ status: "pending", retryable: true });
      expect(ended.timing.phaseEndsAt).toBe(required(ended.timing.phaseStartedAt) + 8_000);
      await expect(store.expireToPodium(identity, 2)).rejects.toMatchObject({
        code: "INVALID_PHASE",
      });
    });
    it("holds host ACK until result commit and preserves the command receipt", async () => {
      await seed(answering());
      let settled = false;
      const pending = store.applyCommand(command()).then((ack) => {
        settled = true;
        return ack;
      });
      let frozen: ActiveRoomState | null = null;
      for (let i = 0; i < 100; i++) {
        frozen = await store.getPrivateSnapshot(identity);
        if (frozen?.closedQuestions[0]) break;
        await delay(5);
      }
      expect(settled).toBe(false);
      const state = required(frozen);
      await store.commitQuestionResult({
        ...identity,
        expectedRevision: state.revision,
        closedQuestionHash: required(state.closedQuestions[0]).hash,
        result: result(state),
      });
      const ack = await pending;
      expect(ack.ack.ok).toBe(true);
      expect((await store.applyCommand(command())).ack).toEqual(ack.ack);
    });
    it("fences lease epochs and PIN reuse", async () => {
      await seed();
      const leases = await Promise.all([
        store.acquireLease(identity, uuid(60), 3000),
        store.acquireLease(identity, uuid(61), 3000),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(1);
      const lease = required(leases.find((l) => l !== null));
      expect(await store.renewLease(identity, { ...lease, epoch: lease.epoch + 1 }, 3000)).toBe(
        false,
      );
      expect(await store.renewLease(identity, lease, 3000)).toBe(true);
      expect(await store.releaseLease(identity, lease)).toBe(true);
      const replacement = required(await store.acquireLease(identity, uuid(62), 3000));
      expect(replacement.epoch).toBe(lease.epoch + 1);
      expect(await store.releaseLease(identity, lease)).toBe(false);
      expect(await store.releaseRoom(identity)).toBe(true);
      await seed(activeRoomStateSchema.parse({ ...room(), sessionId: uuid(90) }));
      expect(await store.releaseRoom(identity)).toBe(false);
    });
    it("enforces logical TTL while retaining private state for maintenance", async () => {
      await seed(undefined, 30);
      await delay(50);
      now += 50;
      expect(await store.getRoleSnapshot(identity, { role: "host", hostId: uuid(5) })).toBeNull();
      await expect(join()).rejects.toMatchObject({ code: "ROOM_EXPIRED" });
      expect(await store.getPrivateSnapshot(identity)).not.toBeNull();
    });
    it("preserves frozen reports until durable READY and rejects stale finalization", async () => {
      await seed(activeRoomStateSchema.parse({ ...room(), phase: "PODIUM" }));
      expect(await store.freezeReport(identity, 1, frozenReportSchema.parse(report()))).toBe(
        "COMMITTED",
      );
      expect(await store.freezeReport(identity, 1, frozenReportSchema.parse(report()))).toBe(
        "RETRY",
      );
      expect(await store.releaseRoom(identity)).toBe(false);
      const ready = {
        sessionId: identity.sessionId,
        status: "ready" as const,
        reportId: identity.sessionId,
        retryable: false,
        errorCode: null,
        updatedAt: now,
      };
      await expect(store.markFinalization(identity, ready)).rejects.toMatchObject({
        code: "FINALIZATION_PENDING",
      });
      await store.acknowledgeDurableReport(identity);
      await store.markFinalization(identity, ready);
      expect(
        (await store.getPrivateSnapshot(identity))?.frozenReport?.quiz.questions[0]?.publicOptions,
      ).toEqual([]);
      expect(await store.releaseRoom(identity)).toBe(true);
    });
    it("reserves socket-bound nicknames and advances timed phases with CAS", async () => {
      const state = activeRoomStateSchema.parse({
        ...room(),
        phase: "GAME_START_COUNTDOWN",
        players: { [uuid(6)]: player() },
        timing: { ...room().timing, phaseStartedAt: now - 4000, phaseEndsAt: now - 1000 },
      });
      await seed(state);
      const timing = { ...state.timing, phaseStartedAt: now, phaseEndsAt: now + 4000 };
      expect(await store.transitionPhase(identity, 1, "QUESTION_PREVIEW", timing, 0)).toBe(true);
      expect(await store.transitionPhase(identity, 1, "QUESTION_PREVIEW", timing, 0)).toBe(false);
      expect((await store.getPrivateSnapshot(identity))?.phaseVersion).toBe(2);
      await store.releaseRoom(identity);
      await seed(activeRoomStateSchema.parse({ ...room(), friendlyNicknames: true }));
      await store.reserveFriendlyTicket(identity, {
        nickname: player().nickname,
        tokenHash: "b".repeat(64),
        socketId: "join",
        expiresAt: now + 119000,
        consumed: false,
      });
      await expect(join()).rejects.toMatchObject({ code: "NICKNAME_INVALID" });
      const joined = await store.bindPlayer({
        ...identity,
        requestId: uuid(30),
        payloadHash: "a".repeat(64),
        connectionId: "join",
        binding: {
          kind: "join",
          player: player(),
          sessionToken: "a".repeat(43),
          friendlyTicketHash: "b".repeat(64),
        },
      });
      expect(joined.generation).toBe(1);
    });
  });

describe("read-only Redis state decoding (TASK-185F)", () => {
  /** What Redis cjson does to a stored state: every empty array becomes `{}`. */
  function cjsonEncoded(value: unknown): unknown {
    if (Array.isArray(value)) return value.length === 0 ? {} : value.map(cjsonEncoded);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cjsonEncoded(v)]));
    return value;
  }
  /** States that together hold every kind of empty array: lobby, answering, scored, frozen. */
  function fixtures(): ActiveRoomState[] {
    const lobby = activeRoomStateSchema.parse(room());
    const scored = answering([]);
    scored.results = { "0": result(scored) };
    scored.phase = "LEADERBOARD";
    scored.accepting = false;
    const frozen = activeRoomStateSchema.parse({
      ...scored,
      phase: "PODIUM",
      frozenReport: frozenReportSchema.parse(report()),
      finalization: {
        sessionId: uuid(1),
        status: "pending",
        reportId: null,
        retryable: true,
        errorCode: null,
        updatedAt: 1,
      },
    });
    return [lobby, answering(), scored, frozen];
  }

  it.each([0, 1, 2, 3])("restores every cjson-encoded empty array of fixture %i", (n) => {
    const state = required(fixtures()[n]);
    const encoded = cjsonEncoded(JSON.parse(JSON.stringify(state)));
    expect(restoreArrays(activeRoomStateSchema, encoded)).toEqual(state);
  });
});

describe("Redis lifecycle", () => {
  it("reloads scripts after SCRIPT FLUSH, reconnects and never falls back on outages", async () => {
    const store = new RedisStateStore(redis, project, "lifecycle");
    const state = activeRoomStateSchema.parse({
      ...room(),
      createdAt: Date.now(),
      lobbyActiveAt: Date.now(),
      hardExpiresAt: Date.now() + 28800000,
    });
    await store.createRoom(identity.pin, state, 28800000);
    await redis.script("FLUSH");
    expect((await store.getPrivateSnapshot(identity))?.sessionId).toBe(identity.sessionId);
    const ended = once(redis, "end");
    redis.disconnect();
    await ended;
    await expect(store.getPrivateSnapshot(identity)).rejects.toMatchObject({
      code: "STATE_UNAVAILABLE",
    });
    await redis.connect();
    expect((await store.getPrivateSnapshot(identity))?.sessionId).toBe(identity.sessionId);
    const isolated = new RedisStateStore(redis, project, "other");
    expect(await isolated.getPrivateSnapshot(identity)).toBeNull();
    store.onModuleDestroy();
    isolated.onModuleDestroy();
  });
  it("fails closed before projection registration and closes all Redis connections", async () => {
    const projection = new StateProjection();
    expect(() =>
      projection.project(
        activeRoomStateSchema.parse(room()),
        { role: "host", hostId: uuid(5) },
        Date.now(),
      ),
    ).toThrow("STATE_UNAVAILABLE");
    projection.register(project);
    const config = await ConfigService.load({
      ...runtime.env,
      STATE_DRIVER: "redis",
      REDIS_URL: redisUrl,
    });
    const connections = await StateConnections.open(config);
    const client = connections.command;
    expect(await client?.ping()).toBe("PONG");
    const ended = once(required(client), "end");
    connections.onModuleDestroy();
    await ended;
    expect(client?.status).not.toBe("ready");
    expect(connections.command).toBeNull();
    const unavailable = await ConfigService.load({
      ...runtime.env,
      STATE_DRIVER: "redis",
      REDIS_URL: "redis://127.0.0.1:1",
    });
    await expect(StateConnections.open(unavailable)).rejects.toMatchObject({
      code: "STATE_UNAVAILABLE",
    });
  });
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture value");
  return value;
}

describe("Socket.io event distribution", () => {
  it("delivers server events across two API adapters in the same namespace", async () => {
    const config = await ConfigService.load({
      ...runtime.env,
      STATE_DRIVER: "redis",
      REDIS_URL: redisUrl,
    });
    const first = await StateConnections.open(config);
    const second = await StateConnections.open(config);
    const a = new Server(),
      b = new Server();
    try {
      first.install(a);
      second.install(b);
      const received = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Event delivery timed out")), 3000);
        b.on("state-contract", (payload: unknown) => {
          clearTimeout(timeout);
          resolve(payload);
        });
      });
      // Wait for the adapter subscription to be visible before publishing.
      for (let i = 0; i < 100; i++) {
        const counts = await redis.pubsub("NUMSUB", "kabukineko:default:socket.io-request#/#");
        if (Array.isArray(counts) && counts[1] === 2) break;
        await delay(10);
      }
      a.serverSideEmit("state-contract", { sessionId: identity.sessionId, revision: 2 });
      expect(await received).toEqual({ sessionId: identity.sessionId, revision: 2 });
    } finally {
      await Promise.all([a.of("/").adapter.close(), b.of("/").adapter.close()]);
      await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    }
  });
});

describe("Redis Cluster", () => {
  it("routes same-slot operations on three masters and reloads each node's scripts", async () => {
    const base = randomInt(20000, 29000);
    const ports = [base, base + 1, base + 2];
    const start = ports
      .map(
        (port) =>
          `redis-server --port ${port} --bind 0.0.0.0 --protected-mode no --cluster-enabled yes --cluster-config-file /tmp/nodes-${port}.conf --cluster-node-timeout 2000 --cluster-announce-ip 127.0.0.1 --appendonly no --save '' &`,
      )
      .join("\n");
    const container = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(...ports.map((port) => ({ container: port, host: port })))
      .withCommand(["sh", "-c", `${start}\nwait`])
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections", 3))
      .start();
    let connections: StateConnections | undefined;
    try {
      const created = await container.exec([
        "redis-cli",
        "--cluster",
        "create",
        ...ports.map((p) => `127.0.0.1:${p}`),
        "--cluster-replicas",
        "0",
        "--cluster-yes",
      ]);
      expect(created.exitCode).toBe(0);
      const config = await ConfigService.load({
        ...runtime.env,
        STATE_DRIVER: "redis",
        REDIS_CLUSTER_NODES: JSON.stringify(ports.map((p) => `redis://127.0.0.1:${p}`)),
      });
      connections = await StateConnections.open(config);
      const client = required(connections.command);
      const store = new RedisStateStore(client, project, "cluster");
      for (const pin of ["000123", "123456", "999999"]) {
        const state = activeRoomStateSchema.parse({
          ...room(),
          pinCode: pin,
          createdAt: Date.now(),
          lobbyActiveAt: Date.now(),
          hardExpiresAt: Date.now() + 28800000,
        });
        expect(await store.createRoom(pin, state, 28800000)).toBe("CREATED");
        expect(
          (await store.getPrivateSnapshot({ pin, sessionId: identity.sessionId }))?.pinCode,
        ).toBe(pin);
      }
      for (const port of ports)
        expect(
          (await container.exec(["redis-cli", "-p", String(port), "SCRIPT", "FLUSH"])).exitCode,
        ).toBe(0);
      expect((await store.getPrivateSnapshot(identity))?.sessionId).toBe(identity.sessionId);
      expect(await store.releaseRoom(identity)).toBe(true);
      store.onModuleDestroy();
    } finally {
      await connections?.onModuleDestroy();
      await container.stop();
    }
  });
});
