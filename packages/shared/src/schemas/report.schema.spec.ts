import { describe, expect, it } from "vitest";
import {
  answerReportSchema,
  finalizeStatusSchema,
  fullReportSchema,
  metricSchema,
  questionReportSchema,
} from "./report.schema";
import { emptyAccessibility } from "./media.schema";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const emptyMetric = { numerator: 0, denominator: 0, value: null };
const emptyAnswer = {
  questionIndex: 0,
  status: "NOT_PLAYED",
  submittedPayload: null,
  result: null,
  isCorrect: null,
  accuracyNumerator: 0,
  accuracyDenominator: 0,
  responseTimeMs: null,
  pointsAwarded: 0,
  streakBonus: 0,
  basePoints: 0,
};
function questionReport() {
  return {
    questionIndex: 0,
    question: {
      id: uuid(2),
      orderIndex: 0,
      type: "SINGLE_CHOICE",
      promptText: "Which?",
      mediaId: null,
      externalVideoUrl: null,
      videoStartSec: 0,
      videoEndSec: null,
      mediaRevealMode: "NONE",
      timeLimitSec: 20,
      pointsMultiplier: 1,
      explanationText: null,
      accessibility: emptyAccessibility(),
      options: [],
    },
    status: "UNPLAYED",
    eligibleCount: 0,
    acceptedCount: 0,
    correctCount: 0,
    partialCount: 0,
    incorrectCount: 0,
    unansweredCount: 0,
    accuracy: emptyMetric,
    optionCounts: [],
  };
}
describe("report accuracy and opportunity semantics", () => {
  it("represents no opportunities as null and preserves fractional partial credit", () => {
    expect(metricSchema.parse(emptyMetric).value).toBeNull();
    expect(metricSchema.parse({ numerator: 1.5, denominator: 3, value: 0.5 }).value).toBe(0.5);
    for (const metric of [
      { numerator: 0, denominator: 0, value: 0 },
      { numerator: 1, denominator: 0, value: null },
      { numerator: 1.5, denominator: 3, value: 1 },
      { numerator: Infinity, denominator: 1, value: 1 },
    ])
      expect(metricSchema.safeParse(metric).success).toBe(false);
  });
  it("distinguishes not-played, not-eligible and unanswered without invented payloads", () => {
    expect(answerReportSchema.parse(emptyAnswer).status).toBe("NOT_PLAYED");
    expect(answerReportSchema.parse({ ...emptyAnswer, status: "NOT_ELIGIBLE" }).status).toBe(
      "NOT_ELIGIBLE",
    );
    expect(
      answerReportSchema.parse({
        ...emptyAnswer,
        status: "UNANSWERED",
        result: "UNANSWERED",
        accuracyDenominator: 1,
      }).result,
    ).toBe("UNANSWERED");
    expect(answerReportSchema.safeParse({ ...emptyAnswer, submittedPayload: 0 }).success).toBe(
      false,
    );
    expect(answerReportSchema.safeParse({ ...emptyAnswer, status: "UNANSWERED" }).success).toBe(
      false,
    );
    expect(
      answerReportSchema.safeParse({ ...emptyAnswer, status: "ANSWERED", result: "CORRECT" })
        .success,
    ).toBe(false);
  });
  it("keeps partial points475=375+100 and rejects wrong bonus arithmetic", () => {
    const answer = {
      ...emptyAnswer,
      status: "ANSWERED",
      submittedPayload: [1],
      result: "PARTIAL",
      isCorrect: true,
      accuracyNumerator: 1,
      accuracyDenominator: 2,
      responseTimeMs: 10_000,
      pointsAwarded: 475,
      basePoints: 375,
      streakBonus: 100,
    };
    expect(answerReportSchema.parse(answer).pointsAwarded).toBe(475);
    expect(answerReportSchema.safeParse({ ...answer, pointsAwarded: 575 }).success).toBe(false);
    expect(answerReportSchema.safeParse({ ...answer, result: "POLL" }).success).toBe(false);
    expect(
      answerReportSchema.parse({
        ...emptyAnswer,
        status: "ANSWERED",
        result: "POLL",
        submittedPayload: 1,
        responseTimeMs: 1000,
      }).result,
    ).toBe("POLL");
  });
  it("accepts early end with unplayed snapshots and stable locale-neutral metadata", () => {
    const report = {
      session: {
        id: uuid(1),
        quizId: null,
        quizTitle: "Quiz",
        hostId: uuid(3),
        pinCode: "001234",
        displayMode: "PROJECTOR",
        endReason: "HOST_ENDED",
        totalPlayers: 0,
        startedAt: null,
        endedAt: 1000,
        status: "ready",
      },
      totalQuestions: 1,
      playedQuestions: 0,
      accuracy: emptyMetric,
      accuracyDefinition: "weighted-success-scored-opportunities-v1",
      questions: [questionReport()],
      hardestQuestionIndexes: [],
      players: { items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } },
      displayTimezone: "UTC",
      snapshotVersion: 1,
    };
    expect(fullReportSchema.parse(report).playedQuestions).toBe(0);
    expect(fullReportSchema.safeParse({ ...report, hardestQuestionIndexes: [0] }).success).toBe(
      false,
    );
    expect(fullReportSchema.safeParse({ ...report, playedQuestions: 1 }).success).toBe(false);
    expect(fullReportSchema.safeParse({ ...report, displayTimezone: "Asia/Jakarta" }).success).toBe(
      false,
    );
    expect(fullReportSchema.safeParse({ ...report, snapshotVersion: 2 }).success).toBe(false);
  });
  it("never counts poll/no-points opportunities in weighted accuracy", () => {
    const poll = {
      ...questionReport(),
      question: { ...questionReport().question, type: "POLL", pointsMultiplier: 0 },
      status: "PLAYED",
      eligibleCount: 2,
      acceptedCount: 1,
      unansweredCount: 1,
    };
    expect(questionReportSchema.parse(poll).accuracy.value).toBeNull();
    expect(
      questionReportSchema.safeParse({
        ...poll,
        accuracy: { numerator: 1, denominator: 2, value: 0.5 },
      }).success,
    ).toBe(false);
    expect(questionReportSchema.safeParse({ ...questionReport(), acceptedCount: 1 }).success).toBe(
      false,
    );
  });
  it("shares the host ready gate and rejects prematurely exposed report IDs", () => {
    const status = {
      sessionId: uuid(1),
      status: "failed",
      reportId: null,
      retryable: true,
      errorCode: "REPORT_SAVE_FAILED",
      updatedAt: 0,
    };
    expect(finalizeStatusSchema.parse(status).retryable).toBe(true);
    expect(finalizeStatusSchema.safeParse({ ...status, reportId: uuid(1) }).success).toBe(false);
    expect(finalizeStatusSchema.safeParse({ ...status, status: "ready" }).success).toBe(false);
  });
});
