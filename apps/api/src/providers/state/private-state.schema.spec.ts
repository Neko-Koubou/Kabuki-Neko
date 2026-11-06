import { ROOM_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import {
  activeRoomStateSchema,
  frozenReportSchema,
  historyIdSchema,
  joinReceiptSchema,
  privateQuestionSnapshotSchema,
} from "./private-state.schema";

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
describe("private state serialization boundary", () => {
  it("round-trips reservations and all nullable initial room fields", () => {
    expect(activeRoomStateSchema.parse(JSON.parse(JSON.stringify(room())))).toEqual(room());
    const overCapacity = room();
    overCapacity.maxPlayers = 5000;
    expect(activeRoomStateSchema.safeParse(overCapacity).success).toBe(false);
  });
  it("keeps the frozen schema strict at every credential-bearing boundary", () => {
    expect(frozenReportSchema.safeParse(report()).success).toBe(true);
    for (const field of ["sessionToken", "tokenHash", "socketId", "connectionId"]) {
      const value = report();
      expect(frozenReportSchema.safeParse({ ...value, [field]: "secret" }).success).toBe(false);
      expect(
        frozenReportSchema.safeParse({
          ...value,
          players: value.players.map((p) => ({ ...p, [field]: "secret" })),
        }).success,
      ).toBe(false);
      expect(
        frozenReportSchema.safeParse({ ...value, session: { ...value.session, [field]: "secret" } })
          .success,
      ).toBe(false);
      expect(
        privateQuestionSnapshotSchema.safeParse({ ...question(), [field]: "secret" }).success,
      ).toBe(false);
    }
  });
  it("accepts generated UUIDv5 history IDs without relaxing v4 input IDs", () => {
    const id = "00000000-0000-5000-8000-000000000001";
    expect(historyIdSchema.safeParse(id).success).toBe(true);
    expect(uuidSchema.safeParse(id).success).toBe(false);
    expect(
      frozenReportSchema.safeParse({ ...report(), session: { ...report().session, id } }).success,
    ).toBe(false);
    expect(historyIdSchema.safeParse("00000000-0000-1000-8000-000000000001").success).toBe(false);
  });
  it("rejects dangling report references and duplicate answers", () => {
    const value = report();
    expect(
      frozenReportSchema.safeParse({ ...value, answers: [...value.answers, ...value.answers] })
        .success,
    ).toBe(false);
    expect(
      frozenReportSchema.safeParse({
        ...value,
        players: value.players.map((p) => ({ ...p, sessionId: uuid(9) })),
      }).success,
    ).toBe(false);
    expect(
      frozenReportSchema.safeParse({
        ...value,
        answers: value.answers.map((a) => ({ ...a, playerId: uuid(9) })),
      }).success,
    ).toBe(false);
  });
  it("keeps replay tokens in a restricted sidecar", () => {
    const receipt = {
      requestId: uuid(8),
      payloadHash: "a".repeat(64),
      playerId: uuid(6),
      sessionToken: "a".repeat(43),
      expiresAt: 120000,
    };
    expect(joinReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(activeRoomStateSchema.safeParse({ ...room(), joinReceipts: [receipt] }).success).toBe(
      false,
    );
  });
  it("bounds worst-case escaped text serialization by the per-player reservation", () => {
    const value = report();
    // 8,000 single-byte characters that each expand to six JSON bytes.
    const worstText = "\u0001".repeat(8000);
    expect(Buffer.byteLength(JSON.stringify(worstText))).toBe(
      ROOM_LIMITS.serializedAnswerBytes.text,
    );
    const base = Buffer.byteLength(JSON.stringify({ ...value, players: [], answers: [] }));
    const serialized = Buffer.byteLength(
      JSON.stringify({
        ...value,
        answers: value.answers.map((a) => ({ ...a, submittedPayload: worstText })),
      }),
    );
    const perPlayer =
      ROOM_LIMITS.playerReservationBytes +
      ROOM_LIMITS.questionReservationBytes +
      ROOM_LIMITS.serializedAnswerBytes.text;
    expect(serialized - base).toBeLessThanOrEqual(perPlayer);
  });
  it("rejects mismatched private option mapping", () => {
    const value = question();
    expect(
      privateQuestionSnapshotSchema.safeParse({ ...value, publicToPrivateOptionIds: [uuid(9)] })
        .success,
    ).toBe(false);
  });
});
