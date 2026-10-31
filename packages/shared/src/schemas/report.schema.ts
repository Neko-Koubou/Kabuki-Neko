import { z } from "zod";
import { DISPLAY_MODES } from "../constants/game";
import { PAGING, QUIZ_LIMITS } from "../constants/limits";
import { nicknameSchema } from "../unicode";
import { endReasonSchema, pinCodeSchema } from "./game.schema";
import { answerSchema, questionSchema } from "./question.schema";
import { quizTitleSchema } from "./quiz.schema";
import {
  avatarSchema,
  pageSchema,
  pagingQueryShape,
  searchSchema,
  timestampSchema,
  uuidSchema,
} from "./users.schema";
export { finalizeStatusSchema, type FinalizeStatus } from "./game.schema";

const count = z.number().int().nonnegative();
const questionIndex = z
  .number()
  .int()
  .min(0)
  .max(QUIZ_LIMITS.questions - 1);
export const metricSchema = z
  .strictObject({
    numerator: z.number().nonnegative(),
    denominator: count,
    value: z.number().min(0).max(1).nullable(),
  })
  .superRefine((metric, ctx) => {
    if (
      metric.numerator > metric.denominator ||
      (metric.denominator === 0
        ? metric.numerator !== 0 || metric.value !== null
        : metric.value === null ||
          Math.abs(metric.value - metric.numerator / metric.denominator) > Number.EPSILON * 16)
    )
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
  });
export const sessionSummarySchema = z
  .strictObject({
    id: uuidSchema,
    quizId: uuidSchema.nullable(),
    quizTitle: quizTitleSchema,
    hostId: uuidSchema,
    pinCode: pinCodeSchema,
    displayMode: z.enum(DISPLAY_MODES),
    endReason: endReasonSchema,
    totalPlayers: count,
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema,
    status: z.literal("ready"),
  })
  .refine((session) => session.startedAt === null || session.endedAt >= session.startedAt, {
    message: "OUT_OF_RANGE",
  });
export const playerReportSchema = z
  .strictObject({
    id: uuidSchema,
    nickname: nicknameSchema,
    avatar: avatarSchema,
    isKicked: z.boolean(),
    finalScore: count,
    finalRank: z.number().int().positive().nullable(),
    correctCount: count,
    unansweredCount: count,
    maxStreak: count,
    avgResponseTimeMs: z.number().nonnegative().nullable(),
    accuracy: metricSchema,
  })
  .refine((player) => !player.isKicked || player.finalRank === null, {
    message: "OUT_OF_RANGE",
    path: ["finalRank"],
  });
export const questionReportSchema = z
  .strictObject({
    questionIndex,
    question: questionSchema,
    status: z.enum(["UNPLAYED", "PLAYED"]),
    eligibleCount: count,
    acceptedCount: count,
    correctCount: count,
    partialCount: count,
    incorrectCount: count,
    unansweredCount: count,
    accuracy: metricSchema,
    optionCounts: z.array(z.strictObject({ optionId: uuidSchema, count })).max(4),
  })
  .superRefine((report, ctx) => {
    const invalid = () => ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (report.questionIndex !== report.question.orderIndex) invalid();
    if (report.acceptedCount + report.unansweredCount !== report.eligibleCount) invalid();
    if (
      report.status === "UNPLAYED" &&
      (report.eligibleCount !== 0 ||
        report.correctCount !== 0 ||
        report.partialCount !== 0 ||
        report.incorrectCount !== 0 ||
        report.accuracy.denominator !== 0 ||
        report.optionCounts.some((option) => option.count !== 0))
    )
      invalid();
    if (report.question.type === "POLL") {
      if (
        report.correctCount !== 0 ||
        report.partialCount !== 0 ||
        report.incorrectCount !== 0 ||
        report.accuracy.denominator !== 0
      )
        invalid();
    } else if (
      report.correctCount + report.partialCount + report.incorrectCount !==
      report.acceptedCount
    )
      invalid();
    if (report.question.pointsMultiplier === 0 && report.accuracy.denominator !== 0) invalid();
    if (
      report.status === "PLAYED" &&
      report.question.type !== "POLL" &&
      report.question.pointsMultiplier > 0 &&
      report.accuracy.denominator !== report.eligibleCount
    )
      invalid();
  });
const answerReportFields = {
  questionIndex,
  submittedPayload: answerSchema.nullable(),
  result: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "UNANSWERED", "POLL"]).nullable(),
  isCorrect: z.boolean().nullable(),
  accuracyNumerator: count,
  accuracyDenominator: count,
  responseTimeMs: count.nullable(),
  pointsAwarded: count,
  streakBonus: count.max(500),
  basePoints: count,
};
const noOpportunity = {
  ...answerReportFields,
  submittedPayload: z.null(),
  result: z.null(),
  isCorrect: z.null(),
  accuracyNumerator: z.literal(0),
  accuracyDenominator: z.literal(0),
  responseTimeMs: z.null(),
  pointsAwarded: z.literal(0),
  streakBonus: z.literal(0),
  basePoints: z.literal(0),
};
export const answerReportSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ ...noOpportunity, status: z.literal("NOT_PLAYED") }),
    z.strictObject({ ...noOpportunity, status: z.literal("NOT_ELIGIBLE") }),
    z.strictObject({
      ...answerReportFields,
      status: z.literal("ANSWERED"),
      submittedPayload: answerSchema,
      result: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "POLL"]),
      responseTimeMs: count,
    }),
    z.strictObject({
      ...answerReportFields,
      status: z.literal("UNANSWERED"),
      submittedPayload: z.null(),
      result: z.enum(["UNANSWERED", "POLL"]),
      isCorrect: z.null(),
      accuracyNumerator: z.literal(0),
      responseTimeMs: z.null(),
      pointsAwarded: z.literal(0),
      streakBonus: z.literal(0),
      basePoints: z.literal(0),
    }),
  ])
  .superRefine((report, ctx) => {
    const invalid = () => ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (
      report.pointsAwarded !== report.basePoints + report.streakBonus ||
      report.accuracyNumerator > report.accuracyDenominator
    )
      invalid();
    if (
      report.result === "CORRECT" &&
      (report.isCorrect !== true ||
        report.accuracyDenominator === 0 ||
        report.accuracyNumerator !== report.accuracyDenominator)
    )
      invalid();
    if (
      report.result === "PARTIAL" &&
      (report.isCorrect !== true ||
        report.accuracyNumerator === 0 ||
        report.accuracyNumerator >= report.accuracyDenominator)
    )
      invalid();
    if (
      report.result === "INCORRECT" &&
      (report.isCorrect !== false || report.accuracyNumerator !== 0 || report.pointsAwarded !== 0)
    )
      invalid();
    if (
      report.result === "POLL" &&
      (report.isCorrect !== null ||
        report.accuracyNumerator !== 0 ||
        report.accuracyDenominator !== 0 ||
        report.pointsAwarded !== 0)
    )
      invalid();
  });
export const fullReportSchema = z
  .strictObject({
    session: sessionSummarySchema,
    totalQuestions: count.max(QUIZ_LIMITS.questions),
    playedQuestions: count.max(QUIZ_LIMITS.questions),
    accuracy: metricSchema,
    accuracyDefinition: z.literal("weighted-success-scored-opportunities-v1"),
    questions: z.array(questionReportSchema).max(QUIZ_LIMITS.questions),
    hardestQuestionIndexes: z.array(questionIndex).max(5),
    players: pageSchema(playerReportSchema),
    displayTimezone: z.literal("UTC"),
    snapshotVersion: z.literal(1),
  })
  .superRefine((report, ctx) => {
    const invalid = () => ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (
      report.questions.length !== report.totalQuestions ||
      report.questions.filter((question) => question.status === "PLAYED").length !==
        report.playedQuestions ||
      report.questions.some((question, index) => question.questionIndex !== index)
    )
      invalid();
    if (
      new Set(report.hardestQuestionIndexes).size !== report.hardestQuestionIndexes.length ||
      report.hardestQuestionIndexes.some(
        (index) =>
          report.questions[index]?.status !== "PLAYED" ||
          (report.questions[index]?.accuracy.denominator ?? 0) === 0,
      )
    )
      invalid();
    if (report.players.meta.total !== report.session.totalPlayers) invalid();
  });
export const sessionsPageSchema = pageSchema(sessionSummarySchema);
export const playerReportsPageSchema = pageSchema(playerReportSchema);
export const answerReportsPageSchema = pageSchema(answerReportSchema);
export const reportsQuerySchema = z.strictObject({
  ...pagingQueryShape(PAGING.defaults.reports),
  quizId: uuidSchema.optional(),
  search: searchSchema.default(""),
  sort: z.literal("ended_desc").default("ended_desc"),
});
export const reportPlayersQuerySchema = z.strictObject({
  ...pagingQueryShape(20),
  search: searchSchema.default(""),
  sort: z.literal("rank_asc").default("rank_asc"),
});
export const reportAnswersQuerySchema = z.strictObject({
  ...pagingQueryShape(20),
  sort: z.literal("question_asc").default("question_asc"),
});
export type Metric = z.infer<typeof metricSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type PlayerReport = z.infer<typeof playerReportSchema>;
export type QuestionReport = z.infer<typeof questionReportSchema>;
export type AnswerReport = z.infer<typeof answerReportSchema>;
export type SessionFullReport = z.infer<typeof fullReportSchema>;
