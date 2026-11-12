import { createHash } from "node:crypto";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { playerRoomSyncSchema } from "@kabuki-neko/shared/schemas/game.schema";
import {
  activeRoomStateSchema,
  activePlayerSchema,
  questionResultSchema,
  frozenReportSchema,
} from "./private-state.schema";
import type { ActiveRoomState, RoomProjector, ApplyCommandInput } from "./game-state.interface";
import { MemoryStateStore } from "./memory-state.store";
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
describe("memory atomic state", () => {
  let now: number;
  let store: MemoryStateStore;
  beforeEach(() => {
    now = 2000;
    store = new MemoryStateStore(project, () => now);
  });
  afterEach(() => store.onModuleDestroy());
  const seed = async (s = answering()) => {
    await store.createRoom(identity.pin, s, 28_800_000);
  };
  async function commit() {
    const s = required(await store.getPrivateSnapshot(identity));
    return store.commitQuestionResult({
      ...identity,
      expectedRevision: s.revision,
      closedQuestionHash: required(s.closedQuestions[0]).hash,
      result: result(s),
    });
  }
  it.each([21000, 22500])(
    "accepts inclusive intake at %i and rejects natural close at the boundary",
    async (t) => {
      await seed();
      now = t;
      await expect(
        store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "TIMER" }),
      ).rejects.toMatchObject({ code: "TIME_EXPIRED" });
      expect((await store.admitAnswer(answer())).receivedAt).toBe(t);
    },
  );
  it("rejects deadline +1501 without recording an answer", async () => {
    await seed();
    now = 22501;
    await expect(store.admitAnswer(answer())).rejects.toMatchObject({ code: "TIME_EXPIRED" });
    expect(required(await store.getPrivateSnapshot(identity)).answers).toEqual({});
  });
  it("freezes the last required answer atomically and replays the original after reveal", async () => {
    await seed();
    const accepted = await store.admitAnswer(answer());
    const frozen = required(await store.getPrivateSnapshot(identity));
    expect(frozen.accepting).toBe(false);
    expect(frozen.phase).toBe("QUESTION_ANSWERING");
    expect(required(frozen.closedQuestions[0]).answers).toEqual([accepted]);
    await expect(store.admitAnswer(answer(7))).rejects.toMatchObject({ code: "INVALID_PHASE" });
    const input = {
      ...identity,
      expectedRevision: frozen.revision,
      closedQuestionHash: required(frozen.closedQuestions[0]).hash,
      result: result(frozen),
    };
    expect(
      await Promise.all([store.commitQuestionResult(input), store.commitQuestionResult(input)]),
    ).toEqual(["COMMITTED", "RETRY"]);
    expect(await store.admitAnswer(answer())).toEqual(accepted);
    await expect(store.admitAnswer({ ...answer(), answer: "Dog" })).rejects.toMatchObject({
      code: "ALREADY_ANSWERED",
    });
    await expect(store.admitAnswer({ ...answer(), submissionId: uuid(90) })).rejects.toMatchObject({
      code: "ALREADY_ANSWERED",
    });
    expect(
      required(required(await store.getPrivateSnapshot(identity)).players[uuid(6)]).streak,
    ).toBe(1);
  });
  it("orders admission versus close without dropping accepted answers", async () => {
    await seed(answering([uuid(6), uuid(7)]));
    await Promise.all([
      store.admitAnswer(answer()),
      store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "HOST_SKIP" }),
    ]);
    expect(
      required(required(await store.getPrivateSnapshot(identity)).closedQuestions[0]).answers,
    ).toHaveLength(1);
    await expect(store.admitAnswer(answer(7))).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });
  it("does not reveal an empty required set, including extra recovered submissions", async () => {
    await seed(answering([]));
    await store.admitAnswer(answer());
    expect(required(await store.getPrivateSnapshot(identity)).accepting).toBe(true);
    await expect(
      store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "ALL_ANSWERED" }),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
    now = 22501;
    await store.closeQuestion({ ...identity, expectedPhaseVersion: 1, reason: "TIMER" });
    expect(await commit()).toBe("COMMITTED");
  });
  it.each(["host:skip_timer", "host:end_game"] as const)(
    "%s freezes immediately and ACKs only after scoring commit",
    async (event) => {
      await seed();
      const c = command(event);
      let done = false;
      const pending = store.applyCommand(c).then((r) => {
        done = true;
        return r;
      });
      const replay = store.applyCommand(c);
      await Promise.resolve();
      expect(done).toBe(false);
      expect(required(await store.getPrivateSnapshot(identity)).accepting).toBe(false);
      await expect(store.admitAnswer(answer())).rejects.toMatchObject({ code: "INVALID_PHASE" });
      await commit();
      const response = await pending;
      expect(response.ack.ok).toBe(true);
      expect((await replay).ack).toEqual(response.ack);
      expect((await store.applyCommand(c)).committed).toBe(false);
      await expect(store.applyCommand({ ...c, payloadHash: "b".repeat(64) })).rejects.toMatchObject(
        { code: "IDEMPOTENCY_CONFLICT" },
      );
      expect(required(await store.getPrivateSnapshot(identity)).phase).toBe(
        event === "host:end_game" ? "PODIUM" : "ANSWER_REVEAL",
      );
    },
  );
  it("rejects stale generation and does not remove disconnected required players", async () => {
    await seed();
    expect(await store.setPresence(identity, uuid(6), 0, false)).toBe(false);
    await store.setPresence(identity, uuid(6), 1, false);
    expect(required(await store.getPrivateSnapshot(identity)).requiredPlayerIds).toEqual([uuid(6)]);
    await expect(store.admitAnswer({ ...answer(), generation: 0 })).rejects.toMatchObject({
      code: "SESSION_REPLACED",
    });
  });
  it("enforces logical expiry immediately and session-safe release on PIN reuse", async () => {
    await seed();
    now = 28_800_001;
    await expect(store.admitAnswer(answer())).rejects.toMatchObject({ code: "ROOM_EXPIRED" });
    store.sweep();
    expect(await store.getPrivateSnapshot(identity)).toBeNull();
    const next = answering();
    next.sessionId = uuid(80);
    next.hardExpiresAt = now + 10000;
    await seed(next);
    expect(await store.releaseRoom(identity)).toBe(false);
    await expect(store.admitAnswer(answer())).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });
  it("uses lease epochs to fence previous owners", async () => {
    await seed();
    const first = required(await store.acquireLease(identity, uuid(70), 100));
    expect(await store.acquireLease(identity, uuid(71), 100)).toBeNull();
    now += 101;
    const second = required(await store.acquireLease(identity, uuid(71), 100));
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(await store.renewLease(identity, first, 100)).toBe(false);
    expect(await store.releaseLease(identity, first)).toBe(false);
    expect(await store.releaseLease(identity, second)).toBe(true);
  });
  it("reads private state without a copy that follows later store changes (TASK-185B)", async () => {
    await seed();
    expect(await store.readPrivateSnapshot({ ...identity, pin: "999999" })).toBeNull();
    const first = required(await store.readPrivateSnapshot(identity));
    // No copy: the same live object until the store replaces it.
    expect(await store.readPrivateSnapshot(identity)).toBe(first);
    const revision = first.revision;
    await store.admitAnswer(answer());
    const after = required(await store.readPrivateSnapshot(identity));
    expect(after.revision).toBeGreaterThan(revision);
    expect(Object.keys(after.answers)).toHaveLength(1);
    // The copying read stays independent of the store.
    const detached = required(await store.getPrivateSnapshot(identity));
    expect(detached).not.toBe(after);
    expect(detached).toEqual(after);
  });
  it("returns detached state and freezes immutable result payloads", async () => {
    const s = answering();
    await seed(s);
    required(s.players[uuid(6)]).score = 999;
    const detached = required(await store.getPrivateSnapshot(identity));
    required(detached.players[uuid(6)]).score = 777;
    expect(
      required(required(await store.getPrivateSnapshot(identity)).players[uuid(6)]).score,
    ).toBe(0);
  });
  it("pins pending/failed frozen reports past expiry until durable and ready", async () => {
    const s = activeRoomStateSchema.parse(room());
    s.phase = "PODIUM";
    s.endReason = "COMPLETED";
    await seed(s);
    await store.freezeReport(identity, 1, frozenReportSchema.parse(report()));
    now = 100_000_000;
    store.sweep();
    expect(await store.releaseRoom(identity)).toBe(false);
    expect(required(await store.getPrivateSnapshot(identity)).frozenReport).not.toBeNull();
    const ready = {
      sessionId: uuid(1),
      status: "ready" as const,
      reportId: uuid(1),
      retryable: false,
      errorCode: null,
      updatedAt: now,
    };
    await expect(store.markFinalization(identity, ready)).rejects.toMatchObject({
      code: "FINALIZATION_PENDING",
    });
    await store.acknowledgeDurableReport(identity);
    expect(await store.releaseRoom(identity)).toBe(false);
    await store.markFinalization(identity, ready);
    store.sweep();
    expect(await store.getPrivateSnapshot(identity)).toBeNull();
  });
  it("replays join token for 120 seconds, fences old connections and rejects altered retries", async () => {
    await seed(activeRoomStateSchema.parse(room()));
    const input = {
      ...identity,
      requestId: uuid(40),
      payloadHash: "a".repeat(64),
      connectionId: "socket",
      binding: {
        kind: "join" as const,
        player: player(),
        sessionToken: "a".repeat(43),
        friendlyTicketHash: null,
      },
    };
    const first = await store.bindPlayer(input);
    const retry = await store.bindPlayer(input);
    expect(retry.token).toBe(first.token);
    expect(retry.generation).toBe(first.generation + 1);
    expect(Object.keys(required(await store.getPrivateSnapshot(identity)).players)).toHaveLength(1);
    await expect(
      store.getRoleSnapshot(identity, {
        role: "player",
        playerId: uuid(6),
        generation: first.generation,
      }),
    ).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    await expect(store.bindPlayer({ ...input, payloadHash: "b".repeat(64) })).rejects.toMatchObject(
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    now += 120001;
    await expect(store.bindPlayer(input)).rejects.toMatchObject({ code: "NICKNAME_TAKEN" });
    const recovered = await store.bindPlayer({
      ...input,
      binding: { kind: "recover", playerId: uuid(6), tokenHash: player().tokenHash },
    });
    expect(recovered.token).toBeNull();
    expect(recovered.generation).toBe(retry.generation + 1);
  });
  it("checks scheduler deadlines and phase CAS while freezing connected membership", async () => {
    const s = activeRoomStateSchema.parse(room());
    s.players[uuid(6)] = player();
    await seed(s);
    const start: ApplyCommandInput = {
      ...command(),
      command: {
        event: "host:start_game",
        request: {
          sessionId: uuid(1),
          pinCode: "000123",
          requestId: uuid(20),
          expectedPhaseVersion: 1,
        },
      },
    };
    await store.applyCommand(start);
    const preview = {
      phaseStartedAt: 5000,
      phaseEndsAt: 9000,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    };
    expect(await store.transitionPhase(identity, 2, "QUESTION_PREVIEW", preview, 0)).toBe(false);
    now = 5000;
    expect(await store.transitionPhase(identity, 1, "QUESTION_PREVIEW", preview, 0)).toBe(false);
    expect(await store.transitionPhase(identity, 2, "QUESTION_PREVIEW", preview, 0)).toBe(true);
    now = 9000;
    const timing = {
      phaseStartedAt: now,
      phaseEndsAt: 29000,
      questionStartedAt: now,
      inputClosesAt: 29000,
      acceptanceClosesAt: 30500,
    };
    await expect(
      store.transitionPhase(
        identity,
        3,
        "QUESTION_ANSWERING",
        { ...timing, acceptanceClosesAt: 99999 },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FORMAT" });
    expect(await store.transitionPhase(identity, 3, "QUESTION_ANSWERING", timing, 0)).toBe(true);
    expect(required(await store.getPrivateSnapshot(identity)).requiredPlayerIds).toEqual([uuid(6)]);
    await expect(
      store.applyCommand({
        ...start,
        requestId: uuid(99),
        command: {
          event: "host:start_game",
          request: {
            sessionId: uuid(1),
            pinCode: "000123",
            requestId: uuid(99),
            expectedPhaseVersion: 1,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "STALE_PHASE" });
  });
  it("binds a friendly ticket only to its socket and consumes it once", async () => {
    const s = activeRoomStateSchema.parse(room());
    s.friendlyNicknames = true;
    await seed(s);
    const ticket = {
      nickname: "Cat6",
      tokenHash: "b".repeat(64),
      socketId: "socket",
      expiresAt: now + 120000,
      consumed: false,
    };
    await store.reserveFriendlyTicket(identity, ticket);
    const input = {
      ...identity,
      requestId: uuid(40),
      payloadHash: "a".repeat(64),
      connectionId: "wrong",
      binding: {
        kind: "join" as const,
        player: player(),
        sessionToken: "a".repeat(43),
        friendlyTicketHash: ticket.tokenHash,
      },
    };
    await expect(store.bindPlayer(input)).rejects.toMatchObject({ code: "NICKNAME_INVALID" });
    expect(Object.keys(required(await store.getPrivateSnapshot(identity)).players)).toHaveLength(0);
    await store.bindPlayer({ ...input, connectionId: "socket" });
    expect(
      required(required(await store.getPrivateSnapshot(identity)).tickets[ticket.tokenHash])
        .consumed,
    ).toBe(true);
    await expect(
      store.reserveFriendlyTicket(identity, { ...ticket, socketId: "other" }),
    ).rejects.toMatchObject({ code: "NICKNAME_TAKEN" });
  });
  it("rolls back joins when projection fails", async () => {
    store.onModuleDestroy();
    store = new MemoryStateStore(
      () => {
        throw new Error("projection failure");
      },
      () => now,
    );
    await seed(activeRoomStateSchema.parse(room()));
    await expect(
      store.bindPlayer({
        ...identity,
        requestId: uuid(40),
        payloadHash: "a".repeat(64),
        connectionId: "socket",
        binding: {
          kind: "join",
          player: player(),
          sessionToken: "a".repeat(43),
          friendlyTicketHash: null,
        },
      }),
    ).rejects.toThrow("projection failure");
    expect(required(await store.getPrivateSnapshot(identity)).players).toEqual({});
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture state");
  return value;
}
