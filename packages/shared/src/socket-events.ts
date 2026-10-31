import { z } from "zod";
import { DISPLAY_MODES, GAME_PHASES, GAME_TIMING, SCORING } from "./constants/game";
import { QUIZ_LIMITS, SETTINGS_LIMITS, SOCKET_LIMITS } from "./constants/limits";
import { errorEnvelopeSchema } from "./errors";
import { nicknameSchema } from "./unicode";
import { accessTokenSchema } from "./schemas/auth.schema";
import { answerSchema } from "./schemas/question.schema";
import {
  answeringQuestionSchema,
  endReasonSchema,
  finalizeStatusSchema,
  hostRoomSyncSchema,
  leaderboardEntrySchema,
  leaderboardSchema,
  personalResultSchema,
  pinCodeSchema,
  playerRoomSyncSchema,
  previewQuestionSchema,
  publicPlayerSchema,
  revealSchema,
  roomSyncSchema,
} from "./schemas/game.schema";
import { jsonByteLimitSchema, quizTitleSchema } from "./schemas/quiz.schema";
import { avatarSchema, revisionSchema, timestampSchema, uuidSchema } from "./schemas/users.schema";

export const GAME_NAMESPACE = "/game";
export const SOCKET_IO_PATH = "/socket.io";
export const PROTOCOL_VERSION = 1;
export const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const friendlyNameTicketSchema = sessionTokenSchema;
export const handshakeSchema = jsonByteLimitSchema(SOCKET_LIMITS.handshakeBytes).pipe(
  z.strictObject({ protocolVersion: z.literal(1), accessToken: accessTokenSchema.optional() }),
);
const requestFields = { requestId: uuidSchema };
const memberFields = { ...requestFields, sessionId: uuidSchema, pinCode: pinCodeSchema };
const phaseFields = { ...memberFields, expectedPhaseVersion: revisionSchema };
const count = z.number().int().nonnegative();
const questionIndex = z
  .number()
  .int()
  .min(0)
  .max(QUIZ_LIMITS.questions - 1);
function request<T extends z.ZodRawShape>(shape: T) {
  return jsonByteLimitSchema(SOCKET_LIMITS.eventBytes).pipe(z.strictObject(shape));
}
export function ackSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({
      ok: z.literal(true),
      requestId: uuidSchema,
      serverTime: timestampSchema,
      data,
    }),
    z.strictObject({
      ok: z.literal(false),
      requestId: uuidSchema,
      serverTime: timestampSchema,
      error: errorEnvelopeSchema,
    }),
  ]);
}
function contract<R extends z.ZodType, D extends z.ZodType>(request: R, data: D) {
  return { request, ack: ackSchema(data) };
}
const joinRequest = jsonByteLimitSchema(SOCKET_LIMITS.eventBytes).pipe(
  z.union([
    z.strictObject({
      ...requestFields,
      pinCode: pinCodeSchema,
      nickname: nicknameSchema,
      avatar: avatarSchema,
      friendlyNameTicket: friendlyNameTicketSchema.optional(),
    }),
    z.strictObject({
      ...memberFields,
      sessionToken: sessionTokenSchema,
      nickname: nicknameSchema.optional(),
      avatar: avatarSchema.optional(),
    }),
  ]),
);
const joinData = z
  .strictObject({
    playerId: uuidSchema,
    sessionId: uuidSchema,
    sessionToken: sessionTokenSchema,
    recovered: z.boolean(),
    snapshot: playerRoomSyncSchema,
  })
  .refine(
    (value) =>
      value.sessionId === value.snapshot.sessionId &&
      value.playerId === value.snapshot.self.playerId,
    { message: "INVALID_REFERENCE" },
  );
export const clientContracts = {
  "auth:update": contract(
    request({ ...requestFields, accessToken: accessTokenSchema }),
    z.strictObject({ authenticated: z.literal(true) }),
  ),
  "host:create_room": contract(
    request({
      ...requestFields,
      quizId: uuidSchema,
      quizRevision: revisionSchema,
      displayMode: z.enum(DISPLAY_MODES),
      friendlyNicknames: z.boolean(),
    }),
    z.strictObject({ pinCode: pinCodeSchema, sessionId: uuidSchema, phaseVersion: z.literal(1) }),
  ),
  "host:recover_room": contract(
    request({ ...requestFields, sessionId: uuidSchema }),
    z.strictObject({ snapshot: hostRoomSyncSchema }),
  ),
  "host:lock_room": contract(
    request({ ...memberFields, isLocked: z.boolean() }),
    z.strictObject({ isLocked: z.boolean() }),
  ),
  "host:kick_player": contract(
    request({ ...memberFields, playerId: uuidSchema }),
    z.strictObject({ kicked: z.literal(true), playerId: uuidSchema }),
  ),
  "host:start_game": contract(
    request(phaseFields),
    z.strictObject({ phase: z.literal("GAME_START_COUNTDOWN"), phaseVersion: revisionSchema }),
  ),
  "host:skip_timer": contract(
    request(phaseFields),
    z.strictObject({ phase: z.literal("ANSWER_REVEAL"), phaseVersion: revisionSchema }),
  ),
  "host:next_step": contract(
    request(phaseFields),
    z.strictObject({ phase: z.enum(GAME_PHASES), phaseVersion: revisionSchema }),
  ),
  "host:end_game": contract(
    request(phaseFields),
    z.strictObject({
      phase: z.literal("PODIUM"),
      phaseVersion: revisionSchema,
      finalization: finalizeStatusSchema,
    }),
  ),
  "player:check_pin": contract(
    request({ ...requestFields, pinCode: pinCodeSchema }),
    z.strictObject({
      friendlyNicknames: z.boolean(),
      displayMode: z.enum(DISPLAY_MODES),
      maxPlayers: z.number().int().min(1).max(SETTINGS_LIMITS.maxPlayers),
      availability: z.literal("OPEN"),
    }),
  ),
  "player:request_friendly_name": contract(
    request({ ...requestFields, pinCode: pinCodeSchema }),
    z.strictObject({
      nickname: nicknameSchema,
      friendlyNameTicket: friendlyNameTicketSchema,
      expiresAt: timestampSchema,
    }),
  ),
  "player:join_room": contract(joinRequest, joinData),
  "player:update_avatar": contract(
    request({ ...memberFields, avatar: avatarSchema }),
    z.strictObject({ avatar: avatarSchema }),
  ),
  "player:submit_answer": contract(
    request({
      ...memberFields,
      questionIndex,
      questionId: uuidSchema,
      submissionId: uuidSchema,
      answer: answerSchema,
    }),
    z.strictObject({
      accepted: z.literal(true),
      submissionId: uuidSchema,
      questionIndex,
      receivedAt: timestampSchema,
    }),
  ),
  "room:sync": contract(request(memberFields), z.strictObject({ snapshot: roomSyncSchema })),
  "room:time": contract(
    request({ ...memberFields, clientSentAt: timestampSchema }),
    z
      .strictObject({
        clientSentAt: timestampSchema,
        serverReceivedAt: timestampSchema,
        serverSentAt: timestampSchema,
      })
      .refine((value) => value.serverSentAt >= value.serverReceivedAt, { message: "OUT_OF_RANGE" }),
  ),
} as const;
export type ClientEventName = keyof typeof clientContracts;
export type ClientRequest<E extends ClientEventName> = z.output<
  (typeof clientContracts)[E]["request"]
>;
export type ClientAck<E extends ClientEventName> = z.output<(typeof clientContracts)[E]["ack"]>;
export type ClientToServerEvents = {
  [E in ClientEventName]: (
    request: ClientRequest<E>,
    acknowledge: (response: ClientAck<E>) => void,
  ) => void;
};

export const hostRevealDataSchema = z.strictObject({ reveal: revealSchema });
export const playerRevealDataSchema = z.strictObject({
  reveal: revealSchema,
  result: personalResultSchema,
});
export const hostLeaderboardDataSchema = leaderboardSchema;
export const playerLeaderboardDataSchema = leaderboardSchema.extend({
  selfRank: z.number().int().positive().nullable(),
});
export const hostPodiumDataSchema = z
  .strictObject({
    podium: z.array(leaderboardEntrySchema).max(SCORING.podiumSize),
    finalization: finalizeStatusSchema,
    reportId: uuidSchema.nullable(),
  })
  .refine((value) => value.reportId === value.finalization.reportId, {
    message: "INVALID_REFERENCE",
  });
export const playerPodiumDataSchema = z.strictObject({
  podium: z.array(leaderboardEntrySchema).max(SCORING.podiumSize),
  result: personalResultSchema.nullable(),
});
const phaseTimeFields = { phaseStartedAt: timestampSchema, phaseEndsAt: timestampSchema };
export const serverEventDataSchemas = {
  "room:state_sync": roomSyncSchema,
  "room:version": z.strictObject({ publicRevision: revisionSchema }),
  "room:player_joined": z.strictObject({ player: publicPlayerSchema, totalPlayers: count }),
  "room:player_updated": z.strictObject({ playerId: uuidSchema, avatar: avatarSchema }),
  "room:player_left": z.strictObject({
    playerId: uuidSchema,
    totalPlayers: count,
    reason: z.literal("KICKED"),
  }),
  "room:presence_changed": z.strictObject({ playerId: uuidSchema, connected: z.boolean() }),
  "room:lock_changed": z.strictObject({ isLocked: z.boolean() }),
  "player:kicked": z.strictObject({ reason: z.literal("HOST_REMOVED") }),
  "player:session_replaced": z.strictObject({ reason: z.literal("SESSION_REPLACED") }),
  "game:countdown": z
    .strictObject({
      durationSec: z.literal(3),
      quizTitle: quizTitleSchema,
      totalQuestions: z.number().int().min(1).max(QUIZ_LIMITS.questions),
      ...phaseTimeFields,
    })
    .refine((value) => value.phaseEndsAt === value.phaseStartedAt + GAME_TIMING.countdownMs, {
      message: "OUT_OF_RANGE",
    }),
  "game:question_preview": z
    .strictObject({
      question: previewQuestionSchema,
      previewDurationMs: z.literal(4_000),
      ...phaseTimeFields,
    })
    .refine((value) => value.phaseEndsAt === value.phaseStartedAt + GAME_TIMING.previewMs, {
      message: "OUT_OF_RANGE",
    }),
  "game:question_answering": z
    .strictObject({
      question: answeringQuestionSchema,
      serverStartTime: timestampSchema,
      inputClosesAt: timestampSchema,
      acceptanceClosesAt: timestampSchema,
    })
    .refine(
      (value) =>
        value.inputClosesAt === value.serverStartTime + value.question.timeLimitSec * 1_000 &&
        value.acceptanceClosesAt === value.inputClosesAt + GAME_TIMING.graceMs,
      { message: "OUT_OF_RANGE" },
    ),
  "game:answer_count_updated": z
    .strictObject({ answeredCount: count, totalPlayers: count, optionalAnswerCount: count })
    .refine((value) => value.answeredCount <= value.totalPlayers, { message: "OUT_OF_RANGE" }),
  "game:answer_reveal": z.union([hostRevealDataSchema, playerRevealDataSchema]),
  "game:leaderboard": z.union([hostLeaderboardDataSchema, playerLeaderboardDataSchema]),
  "game:podium": z.union([hostPodiumDataSchema, playerPodiumDataSchema]),
  "game:finished": z.strictObject({ endReason: endReasonSchema }),
  "report:status_changed": finalizeStatusSchema,
  "room:expired": z.strictObject({ reason: z.enum(["ROOM_EXPIRED", "ROOM_LOST"]) }),
  "room:error": errorEnvelopeSchema,
} as const;
export function pushEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    protocolVersion: z.literal(1),
    sessionId: uuidSchema,
    pinCode: pinCodeSchema,
    phaseVersion: revisionSchema,
    revision: revisionSchema,
    serverTime: timestampSchema,
    eventId: uuidSchema,
    data,
  });
}
export type ServerEventName = keyof typeof serverEventDataSchemas;
export type PushEnvelope<T> = {
  protocolVersion: 1;
  sessionId: string;
  pinCode: string;
  phaseVersion: number;
  revision: number;
  serverTime: number;
  eventId: string;
  data: T;
};
export type ServerToClientEvents = {
  [E in ServerEventName]: (
    event: PushEnvelope<z.output<(typeof serverEventDataSchemas)[E]>>,
  ) => void;
};
/** Role-specific payload maps prevent selecting a host-only schema for player broadcasts. */
const {
  "game:answer_count_updated": _answerCount,
  "report:status_changed": _reportStatus,
  ...playerEvents
} = serverEventDataSchemas;
export const playerEventDataSchemas = {
  ...playerEvents,
  "room:state_sync": playerRoomSyncSchema,
  "game:answer_reveal": playerRevealDataSchema,
  "game:leaderboard": playerLeaderboardDataSchema,
  "game:podium": playerPodiumDataSchema,
} as const;
export const hostEventDataSchemas = {
  ...serverEventDataSchemas,
  "room:state_sync": hostRoomSyncSchema,
  "game:answer_reveal": hostRevealDataSchema,
  "game:leaderboard": hostLeaderboardDataSchema,
  "game:podium": hostPodiumDataSchema,
} as const;
