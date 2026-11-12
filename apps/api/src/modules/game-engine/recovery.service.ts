/**
 * Player PIN check, friendly names, joining and session recovery (SA §5.2).
 *
 * - The live PIN is resolved through SQL (unique PIN) and the room state is read by sessionId, so
 *   a reused PIN can never be confused with an older room.
 * - New joins are LOBBY-only and unlocked, with a normalized unique nickname, the current
 *   profanity list and one of the six avatar styles. In friendly mode the nickname must come from
 *   a single-use, socket-bound server ticket (120 s); typed nicknames cannot bypass it.
 * - Each join issues a 32-byte session token; only its SHA-256 is stored. A lost ACK retried with
 *   the same requestId within 120 s receives the same slot and token (state-store join receipt).
 * - Recovery requires sessionId + token, binds a new connection generation (older sockets become
 *   SESSION_REPLACED) and rejects changed nickname/avatar. Kicked players and cross-room tokens
 *   are refused.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { RuntimeRepository, SettingsRepository, canonicalRequestHash } from "@kabuki-neko/database";
import { avatarSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { nicknameKey, nicknameSchema } from "@kabuki-neko/shared/unicode";
import { ApiError } from "../../common/error.filter";
import {
  GAME_STATE_STORE,
  StateDomainError,
  type ActiveRoomState,
  type IGameStateStore,
} from "../../providers/state/game-state.interface";
import type { PlayerRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { friendlyName } from "./friendly-names";

/** HTTP-style status for each domain error the state store may raise. */
const STATUS: Readonly<Record<string, number>> = {
  ROOM_NOT_FOUND: 404,
  NOT_FOUND: 404,
  GAME_IN_PROGRESS: 409,
  ROOM_LOCKED: 409,
  ROOM_FULL: 409,
  ROOM_EXPIRED: 409,
  ROOM_LOST: 409,
  NICKNAME_TAKEN: 409,
  NICKNAME_INVALID: 422,
  NICKNAME_FORBIDDEN: 422,
  INVALID_SESSION_TOKEN: 401,
  PLAYER_KICKED: 403,
  FORBIDDEN: 403,
  SESSION_REPLACED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_PHASE: 409,
  STALE_PHASE: 409,
  NO_PLAYERS: 409,
  ALREADY_ANSWERED: 409,
  QUESTION_MISMATCH: 409,
  TIME_EXPIRED: 409,
  INVALID_ANSWER: 422,
  CAPACITY_REACHED: 503,
  STATE_UNAVAILABLE: 503,
};
/** Converts state-store domain failures into the socket error envelope; rethrows others. */
export function stateError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof StateDomainError) throw new ApiError(error.code, STATUS[error.code] ?? 409);
  throw error;
}
/** SHA-256 hex of a secret token (only the hash is ever stored). */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
/** 32 random bytes as base64url (43 characters). */
function secret(): string {
  return randomBytes(32).toString("base64url");
}

/** Socket context the gateway passes for anonymous/player calls. */
export interface PlayerContext {
  connectionId: string;
  ip: string;
}
/** Successful join: ACK data plus the binding the gateway attaches to the socket. */
export interface JoinOutcome {
  ack: {
    playerId: string;
    sessionId: string;
    sessionToken: string;
    recovered: boolean;
    snapshot: PlayerRoomSync;
  };
  binding: { pin: string; sessionId: string; playerId: string; generation: number };
}
/** Validated `player:join_room` request (one of the two join shapes). */
export type JoinRequest =
  | {
      requestId: string;
      pinCode: string;
      nickname: string;
      avatar: { style: string; seed: string };
      friendlyNameTicket?: string | undefined;
    }
  | {
      requestId: string;
      pinCode: string;
      sessionId: string;
      sessionToken: string;
      nickname?: string | undefined;
      avatar?: { style: string; seed: string } | undefined;
    };

/** Max outstanding friendly-name tickets per client IP and room. */
export const FRIENDLY_TICKETS_PER_IP = 10;
const TICKET_TTL_MS = 120_000;

@Injectable()
export class RecoveryService {
  /** `${sessionId}|${ip}` → ticket expiry times (process-local reservation bound). */
  private readonly outstanding = new Map<string, number[]>();

  constructor(
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
  ) {}

  /**
   * Resolves a live PIN to its room identity and private state, or 404. New joins, PIN checks
   * and friendly names need an ACTIVE allocation; token recovery also accepts FINALIZING, which
   * the scheduler sets as soon as the report is frozen (PODIUM/FINISHED), so a player who
   * refreshes on the podium still gets the results during the 1 h retention (SA §6.2(4), BR-12;
   * code review MJ-04).
   */
  private async room(
    pin: string,
    statuses: readonly string[] = ["ACTIVE"],
  ): Promise<{ identity: { pin: string; sessionId: string }; state: ActiveRoomState }> {
    const allocation = await this.runtime.findByPin(pin);
    if (!allocation || !statuses.includes(allocation.status))
      throw new ApiError("ROOM_NOT_FOUND", 404);
    const identity = { pin: allocation.pin_code, sessionId: allocation.id };
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state) throw new ApiError("ROOM_NOT_FOUND", 404);
    return { identity, state };
  }
  /** Rejects joins outside an open, unlocked lobby with free seats. */
  private static assertJoinable(state: ActiveRoomState) {
    if (state.phase !== "LOBBY") throw new ApiError("GAME_IN_PROGRESS", 409);
    if (state.isLocked) throw new ApiError("ROOM_LOCKED", 409);
    if (Object.keys(state.players).length >= state.maxPlayers) throw new ApiError("ROOM_FULL", 409);
  }

  /** `player:check_pin` — availability for a new join. */
  async checkPin(pin: string) {
    const { state } = await this.room(pin);
    RecoveryService.assertJoinable(state);
    return {
      friendlyNicknames: state.friendlyNicknames,
      displayMode: state.displayMode,
      maxPlayers: state.maxPlayers,
      availability: "OPEN" as const,
    };
  }

  /**
   * `player:request_friendly_name` — reserves a unique server nickname for this socket. A re-roll
   * replaces the socket's previous ticket; at most 10 outstanding tickets per IP and room.
   */
  async requestFriendlyName(pin: string, context: PlayerContext) {
    const { identity, state } = await this.room(pin);
    RecoveryService.assertJoinable(state);
    if (!state.friendlyNicknames) throw new ApiError("INVALID_PHASE", 409);
    const now = Date.now();
    const key = `${identity.sessionId}|${context.ip}`;
    const live = (this.outstanding.get(key) ?? []).filter((expiry) => expiry > now);
    if (live.length >= FRIENDLY_TICKETS_PER_IP)
      throw new ApiError("RATE_LIMITED", 429, {
        retryAfterMs: Math.max(0, (live[0] ?? now) - now),
      });
    const taken = new Set(Object.values(state.players).map((player) => player.nicknameKey));
    for (let attempt = 0; attempt < 20; attempt++) {
      const nickname = friendlyName();
      if (taken.has(nicknameKey(nickname))) continue;
      const ticket = secret();
      const expiresAt = now + TICKET_TTL_MS;
      try {
        await this.store.reserveFriendlyTicket(identity, {
          nickname,
          tokenHash: tokenHash(ticket),
          socketId: context.connectionId,
          expiresAt,
          consumed: false,
        });
      } catch (error) {
        if (error instanceof StateDomainError && error.code === "NICKNAME_TAKEN") continue;
        stateError(error);
      }
      live.push(expiresAt);
      this.outstanding.set(key, live);
      return { nickname, friendlyNameTicket: ticket, expiresAt };
    }
    throw new ApiError("NICKNAME_TAKEN", 409);
  }

  /** Validates a typed nickname: schema, then the current profanity list (normalized). */
  private async checkedNickname(raw: string): Promise<{ nickname: string; key: string }> {
    const parsed = nicknameSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError("NICKNAME_INVALID", 422);
    const key = nicknameKey(parsed.data);
    const words = (await this.settings.current()).profanity_words.map(nicknameKey);
    if (words.some((word) => word.length > 0 && key.includes(word)))
      throw new ApiError("NICKNAME_FORBIDDEN", 422);
    return { nickname: parsed.data, key };
  }

  /** `player:join_room` — new join or token recovery; see the module comment. */
  async join(request: JoinRequest, context: PlayerContext): Promise<JoinOutcome> {
    const { identity, state } = await this.room(
      request.pinCode,
      "sessionToken" in request ? ["ACTIVE", "FINALIZING"] : ["ACTIVE"],
    );
    const { requestId: _requestId, ...payload } = request;
    const payloadHash = canonicalRequestHash(JSON.parse(JSON.stringify(payload)));
    if ("sessionToken" in request) {
      if (request.sessionId !== identity.sessionId)
        throw new ApiError("INVALID_SESSION_TOKEN", 401);
      const hash = tokenHash(request.sessionToken);
      const player = Object.values(state.players).find((candidate) => candidate.tokenHash === hash);
      if (!player) throw new ApiError("INVALID_SESSION_TOKEN", 401);
      if (player.kickedAt !== null) throw new ApiError("PLAYER_KICKED", 403);
      if (
        (request.nickname !== undefined && request.nickname !== player.nickname) ||
        (request.avatar !== undefined &&
          (request.avatar.style !== player.avatar.style ||
            request.avatar.seed !== player.avatar.seed))
      )
        throw new ApiError("VALIDATION_FAILED", 422);
      try {
        const bound = await this.store.bindPlayer({
          ...identity,
          requestId: request.requestId,
          payloadHash,
          connectionId: context.connectionId,
          binding: { kind: "recover", playerId: player.id, tokenHash: hash },
        });
        return {
          ack: {
            playerId: bound.player.id,
            sessionId: identity.sessionId,
            sessionToken: request.sessionToken,
            recovered: true,
            snapshot: bound.snapshot,
          },
          binding: { ...identity, playerId: bound.player.id, generation: bound.generation },
        };
      } catch (error) {
        stateError(error);
      }
    }
    const avatar = avatarSchema.safeParse(request.avatar);
    if (!avatar.success) throw new ApiError("VALIDATION_FAILED", 422);
    const { nickname, key } = await this.checkedNickname(request.nickname);
    const sessionToken = secret();
    const now = Date.now();
    try {
      const bound = await this.store.bindPlayer({
        ...identity,
        requestId: request.requestId,
        payloadHash,
        connectionId: context.connectionId,
        binding: {
          kind: "join",
          sessionToken,
          friendlyTicketHash: request.friendlyNameTicket
            ? tokenHash(request.friendlyNameTicket)
            : null,
          player: {
            id: randomUUID(),
            nickname,
            nicknameKey: key,
            avatar: avatar.data,
            joinOrder: 0,
            joinedAt: now,
            kickedAt: null,
            tokenHash: tokenHash(sessionToken),
            connectionGeneration: 1,
            connected: true,
            connectionId: context.connectionId,
            lastSeenAt: now,
            score: 0,
            streak: 0,
            maxStreak: 0,
            correctCount: 0,
            responseSumMs: 0,
            responseCount: 0,
            rank: null,
            previousRank: null,
          },
        },
      });
      return {
        ack: {
          playerId: bound.player.id,
          sessionId: identity.sessionId,
          sessionToken: bound.token ?? sessionToken,
          recovered: false,
          snapshot: bound.snapshot,
        },
        binding: { ...identity, playerId: bound.player.id, generation: bound.generation },
      };
    } catch (error) {
      stateError(error);
    }
  }
}
