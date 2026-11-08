/**
 * Room allocation and create reconciliation (SA §6.2, `host:create_room`).
 *
 * Protocol for one create request (idempotent by the host's requestId):
 * 1. one SQL transaction authorizes the quiz (own or PUBLIC, exact revision), builds the private
 *    playable snapshot under the same locks, plans capacity, pins READY media, allocates a unique
 *    crypto-random PIN (≤ 32 attempts) under the active-room cap and records the `room.create`
 *    receipt — the allocation is CREATING and stores everything needed to rebuild the room;
 * 2. the state store creates the room if absent (same sessionId on every retry);
 * 3. SQL marks the allocation ACTIVE and completes the receipt; only then is the ACK returned.
 * A retry or a second instance handling the same request reaches the same allocation and room.
 * CREATING allocations older than 120 s are activated when their state exists, otherwise
 * compensated (released) so the PIN and media pins are freed. A creator that lost its allocation
 * removes the room it may have created and fails rather than acknowledging a dead room.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  QuizzesRepository,
  RuntimeRepository,
  SettingsRepository,
  canonicalRequestHash,
  type Allocation,
  type MediaRow,
} from "@kabuki-neko/database";
import { ROOM_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { mediaSchema } from "@kabuki-neko/shared/schemas/media.schema";
import type { QuizWrite } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import {
  GAME_STATE_STORE,
  type ActiveRoomState,
  type IGameStateStore,
  type QuizSnapshot,
} from "../../providers/state/game-state.interface";
import { createQuizSnapshot } from "../quizzes/quiz-snapshot";
import type { CurrentQuizMedia } from "../quizzes/quiz-validator";
import { planCapacity, type CapacityReservation } from "./room-capacity";

/** Validated `host:create_room` request fields (envelope already checked by the gateway). */
export interface CreateRoomRequest {
  requestId: string;
  quizId: string;
  quizRevision: number;
  displayMode: "PROJECTOR" | "STREAMER";
  friendlyNicknames: boolean;
}
/** `host:create_room` success ACK data. */
export interface CreateRoomAck {
  pinCode: string;
  sessionId: string;
  phaseVersion: 1;
}
/** Private material persisted in `room_allocations.creation_snapshot` to rebuild the room. */
interface CreationSnapshot {
  quiz: QuizSnapshot;
  displayMode: "PROJECTOR" | "STREAMER";
  friendlyNicknames: boolean;
  maxPlayers: number;
  reservations: CapacityReservation;
}
/** Outcome of one reconciliation scan, for metrics and tests. */
export interface ReconcileResult {
  activated: number;
  released: number;
}

/** Media references of a quiz write (cover + question media). */
function references(quiz: QuizWrite): string[] {
  return [quiz.coverMediaId, ...quiz.questions.map((question) => question.mediaId)].filter(
    (id): id is string => id !== null,
  );
}
/** Current media row → validator input. */
function currentMedia(row: MediaRow): CurrentQuizMedia {
  return {
    ...mediaSchema.parse({
      id: row.id,
      uploaderId: row.uploader_id,
      storageDriver: row.storage_driver,
      publicUrl: row.public_url,
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
      accessibility: row.accessibility,
      revision: row.revision,
      createdAt: row.created_at,
      inUse: true,
      canDelete: false,
    }),
    status: row.state,
  };
}
/** Maps repository failures to the socket error envelope codes from SA §5.2. */
function domainError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
  if (code === "REVISION_CONFLICT") throw new ApiError("REVISION_CONFLICT", 409);
  if (code === "IDEMPOTENCY_CONFLICT") throw new ApiError("IDEMPOTENCY_CONFLICT", 409);
  if (code === "PIN_EXHAUSTED") throw new ApiError("PIN_EXHAUSTED", 503);
  if (code === "CAPACITY_REACHED") throw new ApiError("CAPACITY_REACHED", 503);
  if (code === "ROOM_EXPIRED") throw new ApiError("ROOM_EXPIRED", 409);
  if (code === "INVALID_REFERENCE") throw new ApiError("QUIZ_NOT_PLAYABLE", 422);
  throw error;
}

/** Initial LOBBY state rebuilt deterministically from an allocation. */
export function initialRoomState(row: Allocation): ActiveRoomState {
  const creation = row.creation_snapshot as CreationSnapshot;
  return {
    schemaVersion: 1,
    sessionId: row.id,
    pinCode: row.pin_code,
    hostId: row.host_id,
    quiz: creation.quiz,
    displayMode: creation.displayMode,
    friendlyNicknames: creation.friendlyNicknames,
    isLocked: false,
    maxPlayers: creation.maxPlayers,
    phase: "LOBBY",
    phaseVersion: 1,
    revision: 1,
    publicRevision: 1,
    questionIndex: null,
    timing: {
      phaseStartedAt: row.created_at,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    createdAt: row.created_at,
    hardExpiresAt: row.expires_at,
    lobbyActiveAt: row.created_at,
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
    reservations: creation.reservations,
  };
}

@Injectable()
export class RoomRegistryService {
  constructor(
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
    @Inject(QuizzesRepository) private readonly quizzes: QuizzesRepository,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
  ) {}

  /** Creates the state for a CREATING allocation (if absent), then activates it in SQL. */
  private async materialize(row: Allocation, now: number): Promise<CreateRoomAck> {
    const identity = { pin: row.pin_code, sessionId: row.id };
    if (row.status === "CREATING") {
      const ttl = Math.max(1, row.expires_at - now) + ROOM_LIMITS.redisSafetyHorizonMs;
      const created = await this.store.createRoom(row.pin_code, initialRoomState(row), ttl);
      if (created === "EXISTS" && !(await this.store.getPrivateSnapshot(identity)))
        throw new ApiError("ROOM_LOST", 409);
      try {
        await this.runtime.activate(row.id, Date.now());
      } catch {
        // The allocation was released or changed meanwhile: never ACK a room without SQL backing.
        await this.store.releaseRoom(identity);
        throw new ApiError("ROOM_LOST", 409);
      }
    } else if (row.status !== "ACTIVE") throw new ApiError("ROOM_EXPIRED", 409);
    return { pinCode: row.pin_code, sessionId: row.id, phaseVersion: 1 };
  }

  /** `host:create_room` — current host, playable authorized quiz, one room per requestId. */
  async createRoom(
    principal: VerifiedPrincipal,
    request: CreateRoomRequest,
  ): Promise<CreateRoomAck> {
    const host = await this.jwt.current(principal);
    const env = this.config.values;
    const now = Date.now();
    const configuredMax = (await this.settings.current()).max_players_per_room;
    let row: Allocation;
    try {
      row = await this.runtime.reserve(
        {
          hostId: host.id,
          quizId: request.quizId,
          quizRevision: request.quizRevision,
          requestId: request.requestId,
          requestHash: canonicalRequestHash({
            quizId: request.quizId,
            quizRevision: request.quizRevision,
            displayMode: request.displayMode,
            friendlyNicknames: request.friendlyNicknames,
          }),
          driver: env.STATE_DRIVER,
          namespace: env.STATE_NAMESPACE,
          capacity: env.MAX_ACTIVE_ROOMS,
          now,
          expiresAt: now + env.ROOM_MAX_AGE_SEC * 1000,
        },
        async (manager) => {
          const source = await this.quizzes.read(host.id, request.quizId, manager);
          const refs = references(source.content);
          const media = new Map(source.media.map((asset) => [asset.id, currentMedia(asset)]));
          const quiz = createQuizSnapshot(
            request.quizId,
            source.row.revision,
            source.content,
            media,
            {
              actorId: host.id,
              retainedMediaIds: new Set(refs),
            },
          );
          const plan = planCapacity(quiz, configuredMax);
          const creation: CreationSnapshot = {
            quiz,
            displayMode: request.displayMode,
            friendlyNicknames: request.friendlyNicknames,
            maxPlayers: plan.maxPlayers,
            reservations: plan.reservations,
          };
          return { snapshot: creation, mediaIds: refs };
        },
      );
    } catch (error) {
      domainError(error);
    }
    return this.materialize(row, now);
  }

  /**
   * Scan for CREATING allocations older than 120 s: activate those whose state exists (the crash
   * happened after state creation) and release the rest so PIN/media pins are not leaked.
   */
  async reconcileCreating(now: number = Date.now()): Promise<ReconcileResult> {
    const stale = await this.runtime.staleCreating(now - ROOM_LIMITS.creatingTimeoutMs);
    const result: ReconcileResult = { activated: 0, released: 0 };
    for (const row of stale) {
      const state = await this.store.getPrivateSnapshot({ pin: row.pin_code, sessionId: row.id });
      if (state) {
        try {
          await this.runtime.activate(row.id, now);
          result.activated++;
        } catch {
          /* Released concurrently; the next scan observes the final status. */
        }
      } else if (await this.runtime.release(row.id, row.pin_code, now)) result.released++;
    }
    return result;
  }
}
