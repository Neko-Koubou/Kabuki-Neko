import type { z } from "zod";
import type { GamePhase } from "@kabuki-neko/shared/constants/game";
import type { ErrorCode } from "@kabuki-neko/shared/errors";
import type {
  FinalizeStatus,
  HostRoomSync,
  PlayerRoomSync,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { Answer } from "@kabuki-neko/shared/schemas/question.schema";
import type { ClientRequest } from "@kabuki-neko/shared/socket-events";
import type * as schema from "./private-state.schema";

export type ActiveRoomState = z.output<typeof schema.activeRoomStateSchema>;
export type ActivePlayer = z.output<typeof schema.activePlayerSchema>;
export type StoredAnswer = z.output<typeof schema.storedAnswerSchema>;
export type ClosedQuestion = z.output<typeof schema.closedQuestionSchema>;
export type QuestionResult = z.output<typeof schema.questionResultSchema>;
export type QuizSnapshot = z.output<typeof schema.quizSnapshotSchema>;
export type FrozenReport = z.output<typeof schema.frozenReportSchema>;
export type FriendlyTicket = z.output<typeof schema.friendlyTicketSchema>;
export type JoinReceipt = z.output<typeof schema.joinReceiptSchema>;
export type Lease = z.output<typeof schema.leaseSchema>;
export type CommandAck = z.output<typeof schema.commandAckSchema>;
export type CloseReason = z.output<typeof schema.closeReasonSchema>;
export type RoomIdentity = { pin: string; sessionId: string };
export type Principal =
  { role: "host"; hostId: string } | { role: "player"; playerId: string; generation: number };
export type RoomProjector = (
  state: Readonly<ActiveRoomState>,
  principal: Principal,
  now: number,
) => HostRoomSync | PlayerRoomSync;
export class StateDomainError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "StateDomainError";
  }
}
export type HostCommandEvent =
  | "host:lock_room"
  | "host:kick_player"
  | "host:start_game"
  | "host:skip_timer"
  | "host:next_step"
  | "host:end_game";
export type HostCommand = {
  [E in HostCommandEvent]: { event: E; request: ClientRequest<E> };
}[HostCommandEvent];
export type ApplyCommandInput = RoomIdentity & {
  hostId: string;
  requestId: string;
  payloadHash: string;
  expectedPhaseVersion: number;
  command: HostCommand;
};
export type CommandResult = {
  committed: boolean;
  revision: number;
  phaseVersion: number;
  ack: CommandAck;
};
export type BindPlayerInput = RoomIdentity & {
  requestId: string;
  payloadHash: string;
  connectionId: string;
  binding:
    | {
        kind: "join";
        player: ActivePlayer;
        sessionToken: string;
        friendlyTicketHash: string | null;
      }
    | { kind: "recover"; playerId: string; tokenHash: string };
};
export type BindPlayerResult = {
  player: ActivePlayer;
  token: string | null;
  generation: number;
  snapshot: PlayerRoomSync;
};
export type AdmitAnswerInput = RoomIdentity & {
  playerId: string;
  generation: number;
  submissionId: string;
  questionId: string;
  questionIndex: number;
  answer: Answer;
};
export type CloseQuestionInput = RoomIdentity & {
  expectedPhaseVersion: number;
  reason: CloseReason;
};
export type CommitQuestionInput = RoomIdentity & {
  expectedRevision: number;
  closedQuestionHash: string;
  result: QuestionResult;
};

/** All gameplay changes use guarded atomic operations, never a get/update pair.
 * Implementations return detached copies and reject stale session/generation IDs.
 * Domain failures throw StateDomainError; infrastructure failures never fallback.
 */
export interface IGameStateStore {
  createRoom(pin: string, state: ActiveRoomState, ttlMs: number): Promise<"CREATED" | "EXISTS">;
  applyCommand(input: ApplyCommandInput): Promise<CommandResult>;
  bindPlayer(input: BindPlayerInput): Promise<BindPlayerResult>;
  admitAnswer(input: AdmitAnswerInput): Promise<StoredAnswer>;
  closeQuestion(input: CloseQuestionInput): Promise<ClosedQuestion | "ALREADY_CLOSED">;
  commitQuestionResult(input: CommitQuestionInput): Promise<"COMMITTED" | "RETRY">;
  getRoleSnapshot(
    identity: RoomIdentity,
    principal: Principal,
  ): Promise<HostRoomSync | PlayerRoomSync | null>;
  markFinalization(identity: RoomIdentity, status: FinalizeStatus): Promise<number>;
  /** Detached private read is restricted to scheduler, scoring and finalization. */
  getPrivateSnapshot(identity: RoomIdentity): Promise<ActiveRoomState | null>;
  reserveFriendlyTicket(identity: RoomIdentity, ticket: FriendlyTicket): Promise<void>;
  setPresence(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    connected: boolean,
  ): Promise<boolean>;
  /**
   * LOBBY-only avatar change for the bound player connection (`player:update_avatar`). Unknown
   * player → INVALID_SESSION_TOKEN, kicked → PLAYER_KICKED, stale generation → SESSION_REPLACED,
   * other phases → INVALID_PHASE. Returns the new room revision.
   */
  updateAvatar(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    avatar: { style: string; seed: string },
  ): Promise<number>;
  acquireLease(identity: RoomIdentity, ownerId: string, ttlMs: number): Promise<Lease | null>;
  renewLease(identity: RoomIdentity, lease: Lease, ttlMs: number): Promise<boolean>;
  releaseLease(identity: RoomIdentity, lease: Lease): Promise<boolean>;
  releaseRoom(identity: RoomIdentity): Promise<boolean>;
  freezeReport(
    identity: RoomIdentity,
    expectedRevision: number,
    report: FrozenReport,
  ): Promise<"COMMITTED" | "RETRY">;
  acknowledgeDurableReport(identity: RoomIdentity): Promise<void>;
  /** Scheduler transition is a phase CAS, including the complete timing update. */
  transitionPhase(
    identity: RoomIdentity,
    expectedPhaseVersion: number,
    phase: GamePhase,
    timing: ActiveRoomState["timing"],
    questionIndex: number | null,
  ): Promise<boolean>;
}
export const GAME_STATE_STORE = Symbol("GAME_STATE_STORE");
