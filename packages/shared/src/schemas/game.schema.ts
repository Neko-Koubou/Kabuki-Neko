import { z } from "zod";
import {
  DISPLAY_MODES,
  GAME_TIMING,
  REVEAL_MODES,
  SCORING,
  type GamePhase,
} from "../constants/game";
import { QUIZ_LIMITS, ROOM_LIMITS, SETTINGS_LIMITS, TEXT_LIMITS } from "../constants/limits";
import { errorCodeSchema } from "../errors";
import { nicknameSchema, textSchema } from "../unicode";
import { bgmTrackSchema } from "./audio.schema";
import { accessibilitySchema, mediaSchema, youtubeUrlSchema } from "./media.schema";
import { answerSchema, questionFields } from "./question.schema";
import { quizTitleSchema } from "./quiz.schema";
import { avatarSchema, revisionSchema, timestampSchema, uuidSchema } from "./users.schema";

const count = z.number().int().nonnegative();
const rank = z.number().int().positive();
const questionIndex = z
  .number()
  .int()
  .min(0)
  .max(QUIZ_LIMITS.questions - 1);
export const pinCodeSchema = z.string().regex(/^[0-9]{6}$/u);
export const endReasonSchema = z.enum(["COMPLETED", "HOST_ENDED", "EXPIRED"]);
export const publicPlayerSchema = z.strictObject({
  id: uuidSchema,
  nickname: nicknameSchema,
  avatar: avatarSchema,
  connected: z.boolean(),
  joinOrder: count,
});
export const publicOptionSchema = z.strictObject({
  id: uuidSchema,
  index: z.number().int().min(0).max(3),
  colorIndex: z.number().int().min(0).max(3),
  text: textSchema({ min: 1, max: TEXT_LIMITS.option }),
});
export const mediaPayloadSchema = z
  .strictObject({
    kind: z.enum(["image", "audio", "video", "youtube"]),
    url: mediaSchema.shape.publicUrl,
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    startSec: z.number().int().min(0).max(QUIZ_LIMITS.videoSec),
    endSec: z.number().int().min(0).max(QUIZ_LIMITS.videoSec).nullable(),
    revealMode: z.enum(REVEAL_MODES),
    accessibility: accessibilitySchema,
  })
  .superRefine((media, ctx) => {
    if (media.endSec !== null && media.endSec <= media.startSec)
      ctx.addIssue({ code: "custom", message: "INVALID_VIDEO_RANGE" });
    if (
      !["video", "youtube"].includes(media.kind) &&
      (media.startSec !== 0 || media.endSec !== null)
    )
      ctx.addIssue({ code: "custom", message: "INVALID_VIDEO_RANGE" });
    if (media.kind !== "image" && media.revealMode !== "NONE")
      ctx.addIssue({ code: "custom", message: "INCOMPATIBLE_MEDIA_EFFECT" });
    if (media.kind === "youtube" && !youtubeUrlSchema.safeParse(media.url).success)
      ctx.addIssue({ code: "custom", message: "INVALID_FORMAT", path: ["url"] });
  });
const publicQuestionFields = {
  id: uuidSchema,
  questionIndex,
  totalQuestions: z.number().int().min(1).max(QUIZ_LIMITS.questions),
  type: z.enum([
    "SINGLE_CHOICE",
    "TRUE_FALSE",
    "MULTIPLE_SELECT",
    "TYPE_ANSWER",
    "ORDER_PUZZLE",
    "POLL",
  ]),
  promptText: textSchema({ min: 1, max: TEXT_LIMITS.prompt, multiline: true }),
  pointsMultiplier: questionFields.pointsMultiplier,
  timeLimitSec: questionFields.timeLimitSec,
  media: mediaPayloadSchema.nullable(),
  options: z.array(publicOptionSchema).max(QUIZ_LIMITS.options),
};
export const publicQuestionSchema = z
  .strictObject(publicQuestionFields)
  .superRefine((question, ctx) => {
    if (question.questionIndex >= question.totalQuestions)
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (question.type === "TYPE_ANSWER" && question.options.length !== 0)
      ctx.addIssue({ code: "custom", message: "INVALID_OPTION_COUNT" });
    if (question.type === "POLL" && question.pointsMultiplier !== 0)
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (new Set(question.options.map((option) => option.id)).size !== question.options.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_ID" });
    question.options.forEach((option, index) => {
      if (option.index !== index) ctx.addIssue({ code: "custom", message: "NONCONTIGUOUS_ORDER" });
    });
  });
export const previewQuestionSchema = publicQuestionSchema.refine(
  (question) => question.options.length === 0 && question.media === null,
  { message: "INVALID_PHASE" },
);
export const answeringQuestionSchema = publicQuestionSchema.refine(
  (question) => {
    if (question.type === "TYPE_ANSWER") return question.options.length === 0;
    if (question.type === "ORDER_PUZZLE") return question.options.length === 4;
    if (question.type === "TRUE_FALSE") return question.options.length === 2;
    return question.options.length >= 2;
  },
  { message: "INVALID_OPTION_COUNT" },
);
export const timingSchema = z
  .strictObject({
    phaseStartedAt: timestampSchema,
    phaseEndsAt: timestampSchema.nullable(),
    questionStartedAt: timestampSchema.nullable(),
    inputClosesAt: timestampSchema.nullable(),
    acceptanceClosesAt: timestampSchema.nullable(),
  })
  .superRefine((timing, ctx) => {
    if (timing.phaseEndsAt !== null && timing.phaseEndsAt < timing.phaseStartedAt)
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    const {
      questionStartedAt: start,
      inputClosesAt: input,
      acceptanceClosesAt: acceptance,
    } = timing;
    if (
      [start, input, acceptance].some((value) => value !== null) &&
      (start === null ||
        input === null ||
        acceptance === null ||
        input < start ||
        acceptance !== input + GAME_TIMING.graceMs)
    )
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
  });
export const acceptedAnswerSchema = z.strictObject({
  submissionId: uuidSchema,
  questionIndex,
  receivedAt: timestampSchema,
  answer: answerSchema,
});
export const leaderboardEntrySchema = z.strictObject({
  playerId: uuidSchema,
  nickname: nicknameSchema,
  avatar: avatarSchema,
  score: count,
  rank,
  rankChange: z.number().int(),
  correctCount: count,
});
export const leaderboardSchema = z.strictObject({
  topPlayers: z.array(leaderboardEntrySchema).max(SCORING.leaderboardSize),
  biggestClimber: z
    .strictObject({ playerId: uuidSchema, nickname: nicknameSchema, ranksGained: rank })
    .nullable(),
});
export const personalResultSchema = z
  .strictObject({
    result: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "UNANSWERED", "POLL", "NOT_ELIGIBLE"]),
    isCorrect: z.boolean().nullable(),
    accuracyNumerator: count,
    accuracyDenominator: count,
    basePoints: count,
    streakBonus: count.max(SCORING.maximumStreakBonus),
    pointsAwarded: count,
    currentStreak: count,
    totalScore: count,
    currentRank: rank.nullable(),
    rankBehindPlayerName: nicknameSchema.nullable(),
    isNoPoints: z.boolean(),
  })
  .superRefine((result, ctx) => {
    const invalid = () => ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
    if (
      result.pointsAwarded !== result.basePoints + result.streakBonus ||
      result.totalScore < result.pointsAwarded ||
      result.accuracyNumerator > result.accuracyDenominator
    )
      invalid();
    if (result.isNoPoints && (result.basePoints !== 0 || result.streakBonus !== 0)) invalid();
    if (
      result.result === "CORRECT" &&
      (result.isCorrect !== true ||
        result.accuracyDenominator === 0 ||
        result.accuracyNumerator !== result.accuracyDenominator)
    )
      invalid();
    if (
      result.result === "PARTIAL" &&
      (result.isCorrect !== true ||
        result.accuracyNumerator === 0 ||
        result.accuracyNumerator >= result.accuracyDenominator)
    )
      invalid();
    if (result.result === "INCORRECT" && result.isCorrect !== false) invalid();
    if (["UNANSWERED", "POLL", "NOT_ELIGIBLE"].includes(result.result) && result.isCorrect !== null)
      invalid();
    if (
      !["CORRECT", "PARTIAL"].includes(result.result) &&
      (result.accuracyNumerator !== 0 || result.pointsAwarded !== 0)
    )
      invalid();
  });
const revealFields = {
  questionIndex,
  correctOptionIds: z.array(uuidSchema).max(4),
  acceptedTexts: z.array(textSchema({ min: 1, max: TEXT_LIMITS.option })).max(QUIZ_LIMITS.textKeys),
  correctOrderIds: z.array(uuidSchema).max(4),
  optionCounts: z.array(z.strictObject({ optionId: uuidSchema, count })).max(4),
  correctCount: count,
  partialCount: count,
  incorrectCount: count,
  unansweredCount: count,
  explanationText: questionFields.explanationText,
};
export const revealSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...revealFields,
    type: z.literal("SINGLE_CHOICE"),
    correctOptionIds: z.array(uuidSchema).length(1),
    acceptedTexts: z.array(z.never()).length(0),
    correctOrderIds: z.array(z.never()).length(0),
  }),
  z.strictObject({
    ...revealFields,
    type: z.literal("TRUE_FALSE"),
    correctOptionIds: z.array(uuidSchema).length(1),
    acceptedTexts: z.array(z.never()).length(0),
    correctOrderIds: z.array(z.never()).length(0),
  }),
  z.strictObject({
    ...revealFields,
    type: z.literal("MULTIPLE_SELECT"),
    correctOptionIds: z.array(uuidSchema).min(1).max(4),
    acceptedTexts: z.array(z.never()).length(0),
    correctOrderIds: z.array(z.never()).length(0),
  }),
  z.strictObject({
    ...revealFields,
    type: z.literal("TYPE_ANSWER"),
    correctOptionIds: z.array(z.never()).length(0),
    acceptedTexts: revealFields.acceptedTexts.min(1),
    correctOrderIds: z.array(z.never()).length(0),
    optionCounts: z.array(z.never()).length(0),
  }),
  z.strictObject({
    ...revealFields,
    type: z.literal("ORDER_PUZZLE"),
    correctOptionIds: z.array(z.never()).length(0),
    acceptedTexts: z.array(z.never()).length(0),
    correctOrderIds: z.array(uuidSchema).length(4),
  }),
  z.strictObject({
    ...revealFields,
    type: z.literal("POLL"),
    correctOptionIds: z.array(z.never()).length(0),
    acceptedTexts: z.array(z.never()).length(0),
    correctOrderIds: z.array(z.never()).length(0),
    correctCount: z.literal(0),
    partialCount: z.literal(0),
    incorrectCount: z.literal(0),
  }),
]);
/** Defined here for host projection; reports re-export the same status contract. */
export const finalizeStatusSchema = z
  .strictObject({
    sessionId: uuidSchema,
    status: z.enum(["pending", "ready", "failed", "lost"]),
    reportId: uuidSchema.nullable(),
    retryable: z.boolean(),
    errorCode: errorCodeSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .superRefine((status, ctx) => {
    if (
      status.status === "ready"
        ? status.reportId !== status.sessionId || status.retryable || status.errorCode !== null
        : status.reportId !== null
    )
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE" });
    if (status.status === "lost" && status.retryable)
      ctx.addIssue({ code: "custom", message: "INVALID_PHASE" });
  });
export type FinalizeStatus = z.infer<typeof finalizeStatusSchema>;
const roomFields = {
  sessionId: uuidSchema,
  pinCode: pinCodeSchema,
  revision: revisionSchema,
  publicRevision: revisionSchema,
  phaseVersion: revisionSchema,
  serverTime: timestampSchema,
  quizTitle: quizTitleSchema,
  totalQuestions: z.number().int().min(0).max(QUIZ_LIMITS.questions),
  displayMode: z.enum(DISPLAY_MODES),
  friendlyNicknames: z.boolean(),
  isLocked: z.boolean(),
  maxPlayers: z.number().int().min(1).max(SETTINGS_LIMITS.maxPlayers),
  players: z.array(publicPlayerSchema).max(SETTINGS_LIMITS.maxPlayers),
  question: publicQuestionSchema.nullable(),
  timing: timingSchema,
  reveal: revealSchema.nullable(),
  leaderboard: leaderboardSchema.nullable(),
  podium: z.array(leaderboardEntrySchema).max(SCORING.podiumSize),
  endReason: endReasonSchema.nullable(),
};
function phaseSnapshots<T extends z.ZodRawShape>(roleFields: T) {
  const {
    question: _question,
    reveal: _reveal,
    leaderboard: _leaderboard,
    podium: _podium,
    endReason: _endReason,
    ...common
  } = roomFields;
  const base = { ...common, ...roleFields };
  const active = { ...base, endReason: z.null(), podium: z.array(z.never()).length(0) };
  const final = {
    ...base,
    question: roomFields.question,
    reveal: roomFields.reveal,
    leaderboard: roomFields.leaderboard,
    podium: roomFields.podium,
    endReason: endReasonSchema,
  };
  return z.discriminatedUnion("phase", [
    z.strictObject({
      ...active,
      phase: z.literal("LOBBY"),
      question: z.null(),
      reveal: z.null(),
      leaderboard: z.null(),
    }),
    z.strictObject({
      ...active,
      phase: z.literal("GAME_START_COUNTDOWN"),
      question: z.null(),
      reveal: z.null(),
      leaderboard: z.null(),
    }),
    z.strictObject({
      ...active,
      phase: z.literal("QUESTION_PREVIEW"),
      question: previewQuestionSchema,
      reveal: z.null(),
      leaderboard: roomFields.leaderboard,
    }),
    z.strictObject({
      ...active,
      phase: z.literal("QUESTION_ANSWERING"),
      question: answeringQuestionSchema,
      reveal: z.null(),
      leaderboard: roomFields.leaderboard,
    }),
    z.strictObject({
      ...active,
      phase: z.literal("ANSWER_REVEAL"),
      question: publicQuestionSchema,
      reveal: revealSchema,
      leaderboard: roomFields.leaderboard,
    }),
    z.strictObject({
      ...active,
      phase: z.literal("LEADERBOARD"),
      question: publicQuestionSchema,
      reveal: roomFields.reveal,
      leaderboard: leaderboardSchema,
    }),
    z.strictObject({ ...final, phase: z.literal("PODIUM") }),
    z.strictObject({ ...final, phase: z.literal("FINISHED") }),
  ]);
}
type RoomBase = { [K in keyof typeof roomFields]: z.output<(typeof roomFields)[K]> } & {
  phase: GamePhase;
};
function validateRoom(room: RoomBase, ctx: z.RefinementCtx) {
  if (
    new Set(room.players.map((player) => player.id)).size !== room.players.length ||
    room.players.length > room.maxPlayers
  )
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE", path: ["players"] });
  const expectedPhaseMs =
    room.phase === "GAME_START_COUNTDOWN"
      ? GAME_TIMING.countdownMs
      : room.phase === "QUESTION_PREVIEW"
        ? GAME_TIMING.previewMs
        : room.phase === "PODIUM"
          ? GAME_TIMING.podiumMs
          : null;
  if (
    expectedPhaseMs !== null &&
    room.timing.phaseEndsAt !== room.timing.phaseStartedAt + expectedPhaseMs
  )
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE", path: ["timing", "phaseEndsAt"] });
  if (
    room.phase === "QUESTION_ANSWERING" &&
    (room.question === null ||
      room.timing.questionStartedAt === null ||
      room.timing.inputClosesAt !==
        room.timing.questionStartedAt + room.question.timeLimitSec * 1_000)
  )
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE", path: ["timing"] });
  if (room.publicRevision > room.revision)
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
  if (room.question && room.question.totalQuestions !== room.totalQuestions)
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE", path: ["totalQuestions"] });
  if (
    room.reveal &&
    room.question &&
    (room.reveal.questionIndex !== room.question.questionIndex ||
      room.reveal.type !== room.question.type)
  )
    ctx.addIssue({ code: "custom", message: "QUESTION_MISMATCH" });
  if (new TextEncoder().encode(JSON.stringify(room)).byteLength > ROOM_LIMITS.roleSnapshotBytes)
    ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
}

export const hostRoomSyncSchema = phaseSnapshots({
  role: z.literal("host"),
  bgmTrack: bgmTrackSchema,
  answeredCount: count,
  eligibleCount: count,
  finalization: finalizeStatusSchema.nullable(),
  capabilities: z.strictObject({
    canStart: z.boolean(),
    canLock: z.boolean(),
    canKick: z.boolean(),
    canSkip: z.boolean(),
    canNext: z.boolean(),
    canEnd: z.boolean(),
  }),
})
  .superRefine(validateRoom)
  .superRefine((room, ctx) => {
    if (room.finalization && room.finalization.sessionId !== room.sessionId)
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE", path: ["finalization"] });
  });
export const playerRoomSyncSchema = phaseSnapshots({
  role: z.literal("player"),
  self: z.strictObject({
    playerId: uuidSchema,
    score: count,
    streak: count,
    rank: rank.nullable(),
    acceptedAnswer: acceptedAnswerSchema.nullable(),
    result: personalResultSchema.nullable(),
  }),
})
  .superRefine(validateRoom)
  .superRefine((room, ctx) => {
    if (!room.players.some((player) => player.id === room.self.playerId))
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE", path: ["self", "playerId"] });
    if (
      room.self.acceptedAnswer &&
      (!room.question ||
        room.phase === "QUESTION_PREVIEW" ||
        room.self.acceptedAnswer.questionIndex !== room.question.questionIndex)
    )
      ctx.addIssue({
        code: "custom",
        message: "QUESTION_MISMATCH",
        path: ["self", "acceptedAnswer"],
      });
  });
export const roomSyncSchema = z.union([hostRoomSyncSchema, playerRoomSyncSchema]);
export type HostRoomSync = z.infer<typeof hostRoomSyncSchema>;
export type PlayerRoomSync = z.infer<typeof playerRoomSyncSchema>;
export type PublicQuestion = z.infer<typeof publicQuestionSchema>;
export type PersonalResult = z.infer<typeof personalResultSchema>;
export type Reveal = z.infer<typeof revealSchema>;
