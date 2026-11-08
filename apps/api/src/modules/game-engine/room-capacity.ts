/**
 * Room capacity reservation (SA §10.3).
 *
 * Byte budgets are reserved when a room is created, so a valid game can never discover at
 * finalization that its report or role snapshot is too large:
 * - `baseBytes`: serialized FrozenReport skeleton with every private question snapshot counted
 *   twice (quiz + per-question history) and session fields at their widest values;
 * - `perPlayerBytes`: 2048 bytes for the player record plus, per question, 1024 bytes of answer
 *   metadata and the worst-case serialized answer (text 48002, multiple/puzzle 32, single 2);
 * - `maxPublicQuestionBytes`: largest public question projection (must be ≤ 512 KiB).
 * Effective maxPlayers = min(configured, 5000, ⌊(64 MiB − base) / perPlayer⌋,
 * ⌊(4 MiB − maxPublicQuestion) / 1024⌋). Creation fails with 422 PAYLOAD_TOO_LARGE or
 * CAPACITY_TOO_SMALL before the room becomes ACTIVE. Joins count retained kicked players too.
 */
import { ROOM_LIMITS, SETTINGS_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { ApiError } from "../../common/error.filter";
import type { ActiveRoomState, QuizSnapshot } from "../../providers/state/game-state.interface";

type PrivateQuestion = QuizSnapshot["questions"][number];
/** Widest possible epoch-millisecond timestamp used for worst-case serialization. */
const WIDEST_TIMESTAMP = 9_999_999_999_999;
/** A UUID-shaped placeholder of the real serialized width. */
const UUID_WIDTH = "00000000-0000-4000-8000-000000000000";

/** Persisted reservation, mirrored in `ActiveRoomState.reservations`. */
export interface CapacityReservation {
  baseBytes: number;
  perPlayerBytes: number;
  maxPublicQuestionBytes: number;
}
/** Result of capacity planning for a new room. */
export interface CapacityPlan {
  maxPlayers: number;
  reservations: CapacityReservation;
}

/** UTF-8 byte length of a value's JSON serialization. */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
/** Worst-case serialized answer payload for a question type. */
export function answerBound(type: PrivateQuestion["type"]): number {
  const bounds = ROOM_LIMITS.serializedAnswerBytes;
  if (type === "TYPE_ANSWER") return bounds.text;
  if (type === "MULTIPLE_SELECT") return bounds.multiple;
  if (type === "ORDER_PUZZLE") return bounds.puzzle;
  return bounds.single;
}
/** Public question projection at its largest (answering phase: options and media visible). */
export function publicQuestionBytes(
  question: PrivateQuestion,
  index: number,
  total: number,
): number {
  return serializedBytes({
    id: question.id,
    questionIndex: index,
    totalQuestions: total,
    type: question.type,
    promptText: question.promptText,
    pointsMultiplier: question.pointsMultiplier,
    timeLimitSec: question.timeLimitSec,
    media: question.mediaSnapshot,
    options:
      question.type === "TYPE_ANSWER"
        ? []
        : question.publicOptions.map((option) => ({
            id: option.id,
            index: option.index,
            colorIndex: option.colorIndex,
            text: option.text,
          })),
  });
}
/** FrozenReport skeleton without players/answers, at the widest session field values. */
export function baseReportBytes(quiz: QuizSnapshot): number {
  return serializedBytes({
    schemaVersion: 1,
    session: {
      id: UUID_WIDTH,
      quizId: UUID_WIDTH,
      quizTitleSnapshot: quiz.title,
      quizRevision: Number.MAX_SAFE_INTEGER,
      hostId: UUID_WIDTH,
      pinCode: "000000",
      displayMode: "PROJECTOR",
      endReason: "HOST_ENDED",
      totalPlayers: SETTINGS_LIMITS.maxPlayers,
      totalQuestions: quiz.questions.length,
      playedQuestions: quiz.questions.length,
      startedAt: WIDEST_TIMESTAMP,
      endedAt: WIDEST_TIMESTAMP,
    },
    quiz,
    players: [],
    questions: quiz.questions.map((snapshot, questionIndex) => ({
      questionIndex,
      sourceQuestionId: UUID_WIDTH,
      snapshot,
      status: "UNPLAYED",
      openedAt: WIDEST_TIMESTAMP,
      closedAt: WIDEST_TIMESTAMP,
      closeReason: "ALL_ANSWERED",
      eligiblePlayerIds: [],
    })),
    answers: [],
  });
}

/**
 * Computes the reservation and effective player limit for `quiz` under the configured setting.
 * Throws 422 PAYLOAD_TOO_LARGE / CAPACITY_TOO_SMALL so creation fails before ACTIVE.
 */
export function planCapacity(quiz: QuizSnapshot, configuredMaxPlayers: number): CapacityPlan {
  const total = quiz.questions.length;
  const maxPublicQuestionBytes = Math.max(
    0,
    ...quiz.questions.map((question, index) => publicQuestionBytes(question, index, total)),
  );
  if (maxPublicQuestionBytes > ROOM_LIMITS.publicQuestionBytes)
    throw new ApiError("PAYLOAD_TOO_LARGE", 422, { limit: ROOM_LIMITS.publicQuestionBytes });
  const baseBytes = baseReportBytes(quiz);
  const perPlayerBytes =
    ROOM_LIMITS.playerReservationBytes +
    quiz.questions.reduce(
      (sum, question) => sum + ROOM_LIMITS.questionReservationBytes + answerBound(question.type),
      0,
    );
  const byReport = Math.floor((ROOM_LIMITS.frozenReportBytes - baseBytes) / perPlayerBytes);
  const byRoster = Math.floor(
    (ROOM_LIMITS.roleSnapshotBytes - maxPublicQuestionBytes) / ROOM_LIMITS.rosterPlayerBytes,
  );
  const maxPlayers = Math.min(configuredMaxPlayers, SETTINGS_LIMITS.maxPlayers, byReport, byRoster);
  if (maxPlayers < 1) throw new ApiError("CAPACITY_TOO_SMALL", 422, { actual: maxPlayers });
  return { maxPlayers, reservations: { baseBytes, perPlayerBytes, maxPublicQuestionBytes } };
}

/** True while another player (counting retained kicked records) fits the reservation. */
export function hasSeat(state: Pick<ActiveRoomState, "players" | "maxPlayers">): boolean {
  return Object.keys(state.players).length < state.maxPlayers;
}
