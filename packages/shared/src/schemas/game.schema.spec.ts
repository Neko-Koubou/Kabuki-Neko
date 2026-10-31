import { describe, expect, it } from "vitest";
import {
  finalizeStatusSchema,
  hostRoomSyncSchema,
  personalResultSchema,
  playerRoomSyncSchema,
  publicQuestionSchema,
  revealSchema,
} from "./game.schema";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const avatar = { style: "bottts", seed: "neko" };
const player = { id: uuid(2), nickname: "Neko", avatar, connected: true, joinOrder: 0 };
const capabilities = {
  canStart: true,
  canLock: true,
  canKick: true,
  canSkip: false,
  canNext: false,
  canEnd: true,
};
function base() {
  return {
    sessionId: uuid(1),
    pinCode: "012345",
    revision: 1,
    publicRevision: 1,
    phaseVersion: 1,
    serverTime: 1000,
    phase: "LOBBY",
    quizTitle: "Quiz",
    totalQuestions: 1,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
    isLocked: false,
    maxPlayers: 200,
    players: [player],
    question: null,
    timing: {
      phaseStartedAt: 0,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    reveal: null,
    leaderboard: null,
    podium: [],
    endReason: null,
  };
}
function host() {
  return {
    ...base(),
    role: "host",
    bgmTrack: "random",
    answeredCount: 0,
    eligibleCount: 0,
    finalization: null,
    capabilities,
  };
}
function participant() {
  return {
    ...base(),
    role: "player",
    self: {
      playerId: player.id,
      score: 0,
      streak: 0,
      rank: null,
      acceptedAnswer: null,
      result: null,
    },
  };
}
function question() {
  return {
    id: uuid(3),
    questionIndex: 0,
    totalQuestions: 1,
    type: "SINGLE_CHOICE",
    promptText: "Choose one",
    pointsMultiplier: 1,
    timeLimitSec: 20,
    media: null,
    options: [0, 1].map((index) => ({
      id: uuid(index + 4),
      index,
      colorIndex: index,
      text: `Option${index}`,
    })),
  };
}
const reveal = {
  questionIndex: 0,
  type: "SINGLE_CHOICE",
  correctOptionIds: [uuid(4)],
  acceptedTexts: [],
  correctOrderIds: [],
  optionCounts: [{ optionId: uuid(4), count: 1 }],
  correctCount: 1,
  partialCount: 0,
  incorrectCount: 0,
  unansweredCount: 0,
  explanationText: null,
};
const timing = {
  phaseStartedAt: 1000,
  phaseEndsAt: 22500,
  questionStartedAt: 1000,
  inputClosesAt: 21000,
  acceptanceClosesAt: 22500,
};
const result = {
  result: "PARTIAL",
  isCorrect: true,
  accuracyNumerator: 1,
  accuracyDenominator: 2,
  basePoints: 375,
  streakBonus: 100,
  pointsAwarded: 475,
  currentStreak: 2,
  totalScore: 1000,
  currentRank: 1,
  rankBehindPlayerName: null,
  isNoPoints: false,
};

describe("role and phase projections", () => {
  it("accepts host/player lobbies while rejecting private credentials and host-only fields", () => {
    expect(hostRoomSyncSchema.parse(host()).bgmTrack).toBe("random");
    expect(playerRoomSyncSchema.parse(participant()).role).toBe("player");
    for (const patch of [
      { sessionToken: "secret" },
      { tokenHash: "secret" },
      { finalization: null },
      { reportId: uuid(1) },
      { bgmTrack: "random" },
      { capabilities },
    ])
      expect(playerRoomSyncSchema.safeParse({ ...participant(), ...patch }).success).toBe(false);
    expect(hostRoomSyncSchema.safeParse({ ...host(), privateQuiz: {} }).success).toBe(false);
    expect(playerRoomSyncSchema.safeParse({ ...participant(), phase: "GRACE" }).success).toBe(
      false,
    );
  });
  it("never accepts option keys, sort order, accepted texts or explanation in public questions", () => {
    const q = question();
    for (const patch of [
      { acceptedTexts: ["secret"] },
      { explanationText: "secret" },
      { options: q.options.map((option) => ({ ...option, isCorrect: true })) },
      { options: q.options.map((option) => ({ ...option, sortOrder: 1 })) },
    ])
      expect(publicQuestionSchema.safeParse({ ...q, ...patch }).success).toBe(false);
    expect(publicQuestionSchema.safeParse({ ...q, type: "TYPE_ANSWER" }).success).toBe(false);
    expect(publicQuestionSchema.parse({ ...q, type: "TYPE_ANSWER", options: [] }).options).toEqual(
      [],
    );
  });
  it("distinguishes preview/answering/reveal visibility and authoritative timing", () => {
    const preview = {
      ...participant(),
      phase: "QUESTION_PREVIEW",
      question: { ...question(), options: [] },
      timing: { ...base().timing, phaseEndsAt: 4000 },
    };
    expect(playerRoomSyncSchema.safeParse(preview).success).toBe(true);
    expect(playerRoomSyncSchema.safeParse({ ...preview, question: question() }).success).toBe(
      false,
    );
    const answering = {
      ...participant(),
      phase: "QUESTION_ANSWERING",
      question: question(),
      timing,
    };
    expect(playerRoomSyncSchema.safeParse(answering).success).toBe(true);
    expect(playerRoomSyncSchema.safeParse({ ...answering, reveal }).success).toBe(false);
    expect(
      playerRoomSyncSchema.safeParse({
        ...answering,
        timing: { ...timing, acceptanceClosesAt: 23000 },
      }).success,
    ).toBe(false);
    expect(
      playerRoomSyncSchema.safeParse({ ...answering, phase: "ANSWER_REVEAL", reveal }).success,
    ).toBe(true);
    expect(
      playerRoomSyncSchema.safeParse({
        ...answering,
        phase: "ANSWER_REVEAL",
        reveal: { ...reveal, questionIndex: 1 },
      }).success,
    ).toBe(false);
  });
  it("supports all eight phases including8s podium and forbids cross-session finalization", () => {
    const stages = [
      host(),
      { ...host(), phase: "GAME_START_COUNTDOWN", timing: { ...base().timing, phaseEndsAt: 3000 } },
      {
        ...host(),
        phase: "QUESTION_PREVIEW",
        question: { ...question(), options: [] },
        timing: { ...base().timing, phaseEndsAt: 4000 },
      },
      { ...host(), phase: "QUESTION_ANSWERING", question: question(), timing },
      { ...host(), phase: "ANSWER_REVEAL", question: question(), reveal },
      {
        ...host(),
        phase: "LEADERBOARD",
        question: question(),
        leaderboard: { topPlayers: [], biggestClimber: null },
      },
      {
        ...host(),
        phase: "PODIUM",
        endReason: "HOST_ENDED",
        timing: { ...base().timing, phaseEndsAt: 8000 },
      },
      { ...host(), phase: "FINISHED", endReason: "HOST_ENDED" },
    ];
    for (const stage of stages)
      expect(hostRoomSyncSchema.safeParse(stage).success, stage.phase).toBe(true);
    expect(
      hostRoomSyncSchema.safeParse({
        ...host(),
        phase: "PODIUM",
        endReason: "HOST_ENDED",
        timing: { ...base().timing, phaseEndsAt: 3000 },
      }).success,
    ).toBe(false);
    expect(
      hostRoomSyncSchema.safeParse({
        ...host(),
        finalization: {
          sessionId: uuid(99),
          status: "pending",
          reportId: null,
          retryable: false,
          errorCode: null,
          updatedAt: 0,
        },
      }).success,
    ).toBe(false);
  });
});
describe("individual scoring and reveal contracts", () => {
  it("preserves total points exactly once and nullable correctness by result", () => {
    expect(personalResultSchema.parse(result).pointsAwarded).toBe(475);
    expect(personalResultSchema.safeParse({ ...result, pointsAwarded: 575 }).success).toBe(false);
    expect(personalResultSchema.safeParse({ ...result, result: "POLL" }).success).toBe(false);
    expect(personalResultSchema.safeParse({ ...result, result: "CORRECT" }).success).toBe(false);
    expect(
      personalResultSchema.parse({
        ...result,
        result: "NOT_ELIGIBLE",
        isCorrect: null,
        accuracyNumerator: 0,
        accuracyDenominator: 0,
        basePoints: 0,
        streakBonus: 0,
        pointsAwarded: 0,
      }).isCorrect,
    ).toBeNull();
    expect(personalResultSchema.safeParse({ ...result, isNoPoints: true }).success).toBe(false);
  });
  it("only permits keys matching the revealed question type", () => {
    expect(revealSchema.safeParse({ ...reveal, type: "POLL" }).success).toBe(false);
    expect(
      revealSchema.parse({ ...reveal, type: "POLL", correctOptionIds: [], correctCount: 0 }).type,
    ).toBe("POLL");
    expect(revealSchema.safeParse({ ...reveal, acceptedTexts: ["secret"] }).success).toBe(false);
  });
  it("exposes a report UUID only for a ready finalization of that session", () => {
    const status = {
      sessionId: uuid(1),
      status: "pending",
      reportId: null,
      retryable: false,
      errorCode: null,
      updatedAt: 0,
    };
    expect(finalizeStatusSchema.parse(status).reportId).toBeNull();
    expect(finalizeStatusSchema.safeParse({ ...status, reportId: uuid(1) }).success).toBe(false);
    expect(
      finalizeStatusSchema.parse({ ...status, status: "ready", reportId: uuid(1) }).reportId,
    ).toBe(uuid(1));
    expect(finalizeStatusSchema.safeParse({ ...status, status: "ready" }).success).toBe(false);
    expect(
      finalizeStatusSchema.safeParse({ ...status, status: "lost", retryable: true }).success,
    ).toBe(false);
  });
});
