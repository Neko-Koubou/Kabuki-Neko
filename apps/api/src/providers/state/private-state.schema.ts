import { z } from "zod";
import { DISPLAY_MODES, GAME_PHASES } from "@kabuki-neko/shared/constants/game";
import { QUIZ_LIMITS, ROOM_LIMITS, SETTINGS_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { bgmTrackSchema } from "@kabuki-neko/shared/schemas/audio.schema";
import {
  endReasonSchema,
  finalizeStatusSchema,
  leaderboardSchema,
  mediaPayloadSchema,
  personalResultSchema,
  pinCodeSchema,
  publicOptionSchema,
  revealSchema,
  timingSchema,
} from "@kabuki-neko/shared/schemas/game.schema";
import {
  answerSchema,
  questionFields,
  optionSchema,
  questionSchema,
} from "@kabuki-neko/shared/schemas/question.schema";
import {
  avatarSchema,
  revisionSchema,
  timestampSchema,
  uuidSchema,
} from "@kabuki-neko/shared/schemas/users.schema";
import { clientContracts } from "@kabuki-neko/shared/socket-events";
import { nicknameSchema } from "@kabuki-neko/shared/unicode";

const count = z.number().int().nonnegative().safe();
const rank = count.positive().nullable();
const index = count.max(QUIZ_LIMITS.questions - 1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const ids = z
  .array(uuidSchema)
  .max(SETTINGS_LIMITS.maxPlayers)
  .refine((v) => new Set(v).size === v.length, "DUPLICATE_ID");
const byId = <T extends z.ZodType>(schema: T) => z.record(uuidSchema, schema);
const byQuestion = <T extends z.ZodType>(schema: T) =>
  z.record(
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/u)
      .refine((v) => Number(v) < QUIZ_LIMITS.questions),
    schema,
  );
export const closeReasonSchema = z.enum([
  "TIMER",
  "ALL_ANSWERED",
  "HOST_SKIP",
  "HOST_END",
  "EXPIRED",
]);
/** Only generated history row IDs permit UUIDv5; all external/source IDs stay v4. */
export const historyIdSchema = z.union([
  uuidSchema,
  z.uuid({ version: "v5" }).regex(/^[0-9a-f-]+$/u),
]);

const snapshotFields = {
  publicOptions: z.array(publicOptionSchema).max(QUIZ_LIMITS.options),
  publicToPrivateOptionIds: z.array(uuidSchema).max(QUIZ_LIMITS.options),
  mediaSnapshot: mediaPayloadSchema.nullable(),
};
// Intersecting strict objects would reject the other object's keys. Validate the
// question separately, then restore the strictly validated private extension.
export const privateQuestionSnapshotSchema = z
  .strictObject({
    ...questionFields,
    type: z.enum([
      "SINGLE_CHOICE",
      "TRUE_FALSE",
      "MULTIPLE_SELECT",
      "TYPE_ANSWER",
      "ORDER_PUZZLE",
      "POLL",
    ]),
    options: z.array(optionSchema),
    ...snapshotFields,
  })
  .transform((value, ctx) => {
    const { publicOptions, publicToPrivateOptionIds, mediaSnapshot, ...question } = value;
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      return z.NEVER;
    }
    if (
      publicOptions.length !== publicToPrivateOptionIds.length ||
      new Set(publicOptions.map((o) => o.id)).size !== publicOptions.length ||
      new Set(publicToPrivateOptionIds).size !== publicToPrivateOptionIds.length ||
      publicOptions.some((o, i) => o.index !== i) ||
      publicToPrivateOptionIds.some((id) => !parsed.data.options.some((o) => o.id === id)) ||
      (parsed.data.type === "TYPE_ANSWER" && publicOptions.length !== 0)
    ) {
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE" });
      return z.NEVER;
    }
    return { ...parsed.data, publicOptions, publicToPrivateOptionIds, mediaSnapshot };
  });
export const quizSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  quizId: uuidSchema,
  revision: revisionSchema,
  title: z.string(),
  description: z.string().nullable(),
  bgmTrack: bgmTrackSchema,
  coverMedia: mediaPayloadSchema.nullable(),
  questions: z.array(privateQuestionSnapshotSchema).min(1).max(QUIZ_LIMITS.questions),
});
export const playerTotalsSchema = z.strictObject({
  score: count,
  streak: count,
  maxStreak: count,
  correctCount: count,
  responseSumMs: count,
  responseCount: count,
  rank,
  previousRank: rank,
});
export const activePlayerSchema = playerTotalsSchema.extend({
  id: uuidSchema,
  nickname: nicknameSchema,
  nicknameKey: z.string().min(1),
  avatar: avatarSchema,
  joinOrder: count,
  joinedAt: timestampSchema,
  kickedAt: timestampSchema.nullable(),
  tokenHash: hash,
  connectionGeneration: revisionSchema,
  connected: z.boolean(),
  connectionId: z.string().min(1).nullable(),
  lastSeenAt: timestampSchema,
});
export const storedAnswerSchema = z.strictObject({
  playerId: uuidSchema,
  submissionId: uuidSchema,
  questionIndex: index,
  questionId: uuidSchema,
  answer: answerSchema,
  payloadHash: hash,
  receivedAt: timestampSchema,
  responseTimeMs: count,
});
export const closedQuestionSchema = z.strictObject({
  questionIndex: index,
  phaseVersion: revisionSchema,
  closedAt: timestampSchema,
  reason: closeReasonSchema,
  hash,
  requiredPlayerIds: ids,
  eligiblePlayerIds: ids,
  answers: z.array(storedAnswerSchema).max(SETTINGS_LIMITS.maxPlayers),
});
export const questionResultSchema = z.strictObject({
  questionIndex: index,
  reveal: revealSchema,
  personal: byId(personalResultSchema),
  leaderboard: leaderboardSchema,
  playerTotals: byId(playerTotalsSchema),
});
export const commandAckSchema = z.union([
  clientContracts["host:lock_room"].ack,
  clientContracts["host:kick_player"].ack,
  clientContracts["host:start_game"].ack,
  clientContracts["host:skip_timer"].ack,
  clientContracts["host:next_step"].ack,
  clientContracts["host:end_game"].ack,
]);
export const commandReceiptSchema = z.strictObject({
  actorId: uuidSchema,
  payloadHash: hash,
  ack: commandAckSchema,
  createdAt: timestampSchema,
});
export const friendlyTicketSchema = z.strictObject({
  nickname: nicknameSchema,
  tokenHash: hash,
  socketId: z.string().min(1),
  expiresAt: timestampSchema,
  consumed: z.boolean(),
});
export const leaseSchema = z.strictObject({
  ownerId: uuidSchema,
  epoch: revisionSchema,
  expiresAt: timestampSchema,
});
/** Restricted sidecar, never nested in an ActiveRoomState or a report. */
export const joinReceiptSchema = z.strictObject({
  requestId: uuidSchema,
  payloadHash: hash,
  playerId: uuidSchema,
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  expiresAt: timestampSchema,
});
export const frozenSessionSchema = z.strictObject({
  id: uuidSchema,
  quizId: uuidSchema.nullable(),
  quizTitleSnapshot: z.string(),
  quizRevision: revisionSchema,
  hostId: uuidSchema,
  pinCode: pinCodeSchema,
  displayMode: z.enum(DISPLAY_MODES),
  endReason: endReasonSchema,
  totalPlayers: count.max(SETTINGS_LIMITS.maxPlayers),
  totalQuestions: count.max(QUIZ_LIMITS.questions),
  playedQuestions: count.max(QUIZ_LIMITS.questions),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema,
});
export const frozenPlayerSchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  nickname: nicknameSchema,
  avatarStyle: avatarSchema.shape.style,
  avatarSeed: avatarSchema.shape.seed,
  joinOrder: count,
  isKicked: z.boolean(),
  finalScore: count,
  finalRank: rank,
  correctCount: count,
  unansweredCount: count,
  maxStreak: count,
  avgResponseTimeMs: count.nullable(),
  joinedAt: timestampSchema,
  kickedAt: timestampSchema.nullable(),
});
export const frozenQuestionResultSchema = z.strictObject({
  questionIndex: index,
  sourceQuestionId: uuidSchema.nullable(),
  snapshot: privateQuestionSnapshotSchema,
  status: z.enum(["UNPLAYED", "PLAYED"]),
  openedAt: timestampSchema.nullable(),
  closedAt: timestampSchema.nullable(),
  closeReason: closeReasonSchema.nullable(),
  eligiblePlayerIds: ids,
});
export const frozenAnswerSchema = z.strictObject({
  playerId: uuidSchema,
  questionIndex: index,
  questionId: uuidSchema.nullable(),
  submissionId: uuidSchema.nullable(),
  submittedPayload: answerSchema.nullable(),
  result: z.enum(["CORRECT", "PARTIAL", "INCORRECT", "UNANSWERED", "POLL"]),
  isCorrect: z.boolean().nullable(),
  accuracyNumerator: count,
  accuracyDenominator: count,
  responseTimeMs: count.nullable(),
  receivedAt: timestampSchema.nullable(),
  pointsAwarded: count,
  streakBonusAwarded: count,
  currentStreak: count,
});
export const frozenReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    session: frozenSessionSchema,
    quiz: quizSnapshotSchema,
    players: z.array(frozenPlayerSchema).max(SETTINGS_LIMITS.maxPlayers),
    questions: z.array(frozenQuestionResultSchema).max(QUIZ_LIMITS.questions),
    answers: z.array(frozenAnswerSchema).max(SETTINGS_LIMITS.maxPlayers * QUIZ_LIMITS.questions),
  })
  .superRefine((report, ctx) => {
    const players = new Set(report.players.map((p) => p.id));
    const answers = new Set(report.answers.map((a) => `${a.questionIndex}:${a.playerId}`));
    if (
      players.size !== report.players.length ||
      answers.size !== report.answers.length ||
      report.session.totalPlayers !== report.players.length ||
      report.session.totalQuestions !== report.questions.length ||
      report.questions.length !== report.quiz.questions.length ||
      report.session.playedQuestions !==
        report.questions.filter((q) => q.status === "PLAYED").length ||
      report.players.some((p) => p.sessionId !== report.session.id) ||
      report.questions.some(
        (q, i) =>
          q.questionIndex !== i ||
          q.snapshot.id !== report.quiz.questions[i]?.id ||
          q.eligiblePlayerIds.some((id) => !players.has(id)),
      ) ||
      report.answers.some(
        (a) =>
          !players.has(a.playerId) ||
          !report.questions[a.questionIndex]?.eligiblePlayerIds.includes(a.playerId),
      )
    )
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE" });
    if (Buffer.byteLength(JSON.stringify(report)) > ROOM_LIMITS.frozenReportBytes)
      ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
  });

export const capacityReservationSchema = z.strictObject({
  baseBytes: count.max(ROOM_LIMITS.frozenReportBytes),
  perPlayerBytes: count.positive(),
  maxPublicQuestionBytes: count.max(ROOM_LIMITS.publicQuestionBytes),
});
export const activeRoomStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sessionId: uuidSchema,
    pinCode: pinCodeSchema,
    hostId: uuidSchema,
    quiz: quizSnapshotSchema,
    displayMode: z.enum(DISPLAY_MODES),
    friendlyNicknames: z.boolean(),
    isLocked: z.boolean(),
    maxPlayers: count.positive().max(SETTINGS_LIMITS.maxPlayers),
    phase: z.enum(GAME_PHASES),
    phaseVersion: revisionSchema,
    revision: revisionSchema,
    publicRevision: revisionSchema,
    questionIndex: index.nullable(),
    timing: timingSchema,
    createdAt: timestampSchema,
    hardExpiresAt: timestampSchema,
    lobbyActiveAt: timestampSchema,
    accepting: z.boolean(),
    requiredPlayerIds: ids,
    eligiblePlayerIds: ids,
    players: byId(activePlayerSchema),
    answers: z.record(z.string().regex(/^(0|[1-9][0-9]*):[0-9a-f-]{36}$/u), storedAnswerSchema),
    closedQuestions: byQuestion(closedQuestionSchema),
    results: byQuestion(questionResultSchema),
    commands: byId(commandReceiptSchema),
    tickets: z.record(hash, friendlyTicketSchema),
    frozenReport: frozenReportSchema.nullable(),
    finalization: finalizeStatusSchema.nullable(),
    endReason: endReasonSchema.nullable(),
    reservations: capacityReservationSchema,
  })
  .superRefine((room, ctx) => {
    const { baseBytes, perPlayerBytes, maxPublicQuestionBytes } = room.reservations;
    if (
      Object.keys(room.players).length > room.maxPlayers ||
      room.publicRevision > room.revision ||
      baseBytes + room.maxPlayers * perPlayerBytes > ROOM_LIMITS.frozenReportBytes ||
      maxPublicQuestionBytes + room.maxPlayers * 1024 > ROOM_LIMITS.roleSnapshotBytes
    )
      ctx.addIssue({ code: "custom", message: "CAPACITY_REACHED" });
    if (
      Object.entries(room.players).some(([key, p]) => key !== p.id) ||
      Object.entries(room.answers).some(
        ([key, a]) => key !== `${a.questionIndex}:${a.playerId}` || !room.players[a.playerId],
      ) ||
      Object.entries(room.closedQuestions).some(([key, q]) => key !== String(q.questionIndex)) ||
      Object.entries(room.results).some(([key, q]) => key !== String(q.questionIndex)) ||
      room.requiredPlayerIds.some((id) => !room.eligiblePlayerIds.includes(id)) ||
      room.eligiblePlayerIds.some((id) => !room.players[id]) ||
      (room.frozenReport && room.frozenReport.session.id !== room.sessionId) ||
      (room.finalization && room.finalization.sessionId !== room.sessionId)
    )
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE" });
  });
