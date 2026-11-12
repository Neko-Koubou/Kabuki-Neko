/**
 * Socket.io transport for the live game (SA §5.1–§5.4): namespace `/game`, path `/socket.io`.
 *
 * Connection: Origin allowlist and the ≤ 8 KiB `{protocolVersion:1, accessToken?}` handshake are
 * checked before accept; events above 16 KiB close the transport. A valid access token makes the
 * socket a host principal (renewable with `auth:update`); anonymous sockets that neither join nor
 * authenticate within 120 s are disconnected.
 *
 * Requests: every one of the 16 client events is validated with its shared contract, charged to
 * its rate tier (IP, user, player or socket), authorized from the server-side binding (never from
 * the pin alone) and answered with the success/error ACK envelope. Player bindings carry the
 * connection generation, so a replaced socket is rejected by the store even if its disconnect
 * notice is lost; replaced sockets are also told and disconnected.
 *
 * Pushes: after each mutation (and each scheduler tick, via the notifying game service) the room's
 * private state is diffed against the last published summary and only role-safe projections are
 * emitted — room-wide events to `host:` + `players:` rooms, personal results to `player:` rooms and
 * answer counts/finalization to the host room only. `room:version` is broadcast every 5 s so a
 * client that missed a packet re-syncs.
 */
import { randomUUID } from "node:crypto";
import { Inject, type OnModuleDestroy } from "@nestjs/common";
import { RuntimeRepository } from "@kabuki-neko/database";
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from "@nestjs/websockets";
import type { Namespace, Socket } from "socket.io";
import { ZodError } from "zod";
import { GAME_TIMING } from "@kabuki-neko/shared/constants/game";
import { SOCKET_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { errorEnvelopeSchema, type ErrorEnvelope } from "@kabuki-neko/shared/errors";
import {
  GAME_NAMESPACE,
  SOCKET_IO_PATH,
  clientContracts,
  handshakeSchema,
  type ClientEventName,
} from "@kabuki-neko/shared/socket-events";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { clientIp, trustedProxies } from "../../common/guards/origin.guard";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import {
  GAME_STATE_STORE,
  StateDomainError,
  type ActiveRoomState,
  type HostCommand,
  type IGameStateStore,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { StateConnections } from "../../providers/state/state.module";
import { GameService, type PlayerBinding, type RoomEndReason } from "./game.service";
import { RecoveryService, stateError } from "./recovery.service";
import { projectHost, projectPlayer } from "./room-projector";
import { RoomRegistryService } from "./room-registry.service";

/** Per-socket server-side binding (never trusted from client payloads). */
interface SocketData {
  ip: string;
  host: VerifiedPrincipal | null;
  player: PlayerBinding | null;
  expiry: ReturnType<typeof setTimeout> | null;
}
/** What was last published for a room, used to derive push events. */
interface Summary {
  pin: string;
  revision: number;
  publicRevision: number;
  phaseVersion: number;
  isLocked: boolean;
  answered: number;
  finalization: string | null;
  players: Map<string, { avatar: string; connected: boolean; kicked: boolean }>;
}
type GameSocket = Socket & { data: SocketData };
const HOST_EVENTS = new Set<ClientEventName>([
  "host:lock_room",
  "host:kick_player",
  "host:start_game",
  "host:skip_timer",
  "host:next_step",
  "host:end_game",
]);
/** Rate tier per client event (SA §5.1). */
const TIERS: Readonly<Record<ClientEventName, RateTier>> = {
  "auth:update": "AUTH",
  "host:create_room": "HOST",
  "host:recover_room": "SYNC",
  "host:lock_room": "HOST",
  "host:kick_player": "HOST",
  "host:start_game": "HOST",
  "host:skip_timer": "HOST",
  "host:next_step": "HOST",
  "host:end_game": "HOST",
  "player:check_pin": "CHECK_JOIN",
  "player:request_friendly_name": "FRIENDLY",
  "player:join_room": "CHECK_JOIN",
  "player:update_avatar": "AVATAR",
  "player:submit_answer": "ANSWER",
  "room:sync": "SYNC",
  "room:time": "TIME",
};
/** Safe client-facing messages; anything else uses a generic sentence. */
const MESSAGES: Partial<Record<string, string>> = {
  AUTH_REQUIRED: "Authentication required",
  FORBIDDEN: "Access denied",
  VALIDATION_FAILED: "Request validation failed",
  RATE_LIMITED: "Too many requests",
  ROOM_NOT_FOUND: "Room not found",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Error envelope for any thrown value; unknown errors never leak details. */
function envelope(error: unknown): ErrorEnvelope {
  const correlationId = randomUUID();
  if (error instanceof ZodError)
    return errorEnvelopeSchema.parse({
      statusCode: 422,
      errorCode: "VALIDATION_FAILED",
      message: "Request validation failed",
      params: {},
      details: [],
      correlationId,
    });
  if (error instanceof StateDomainError) {
    try {
      stateError(error);
    } catch (mapped) {
      return envelope(mapped);
    }
  }
  if (error instanceof ApiError)
    return errorEnvelopeSchema.parse({
      statusCode: error.getStatus(),
      errorCode: error.errorCode,
      message: MESSAGES[error.errorCode] ?? "The request could not be completed",
      params: error.params,
      details: error.details,
      correlationId,
    });
  return errorEnvelopeSchema.parse({
    statusCode: 500,
    errorCode: "INTERNAL_ERROR",
    message: "An internal error occurred",
    params: {},
    details: [],
    correlationId,
  });
}

@WebSocketGateway({
  namespace: GAME_NAMESPACE,
  path: SOCKET_IO_PATH,
  maxHttpBufferSize: SOCKET_LIMITS.eventBytes,
  pingInterval: SOCKET_LIMITS.pingIntervalMs,
  pingTimeout: SOCKET_LIMITS.pingTimeoutMs,
  cors: { origin: true, credentials: true },
})
export class GameGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() private server!: Namespace;
  private readonly summaries = new Map<string, Summary>();
  private readonly queues = new Map<string, Promise<void>>();
  /** Publish per room queued but not started yet; later calls share it (see `publish`). */
  private readonly pendingPublishes = new Map<string, Promise<void>>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly trusted: (address: string) => boolean;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(StateConnections) private readonly connections: StateConnections,
    @Inject(GameService) private readonly game: GameService,
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
    @Inject(RoomRegistryService) private readonly rooms: RoomRegistryService,
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
  ) {
    this.trusted = trustedProxies(config.get("TRUST_PROXY_CIDRS"));
  }

  /** Installs the Redis adapter (scale profile), connection middleware and the 5 s heartbeat. */
  afterInit(namespace: Namespace): void {
    this.connections.install(namespace.server);
    namespace.use((socket, next) => {
      void this.admit(socket as GameSocket).then(
        () => next(),
        (error: unknown) => {
          const failure = Object.assign(new Error(envelope(error).errorCode), {
            data: envelope(error),
          });
          next(failure);
        },
      );
    });
    const notify = (
      this.game as GameService & { setNotifier?: (fn: (id: RoomIdentity) => Promise<void>) => void }
    ).setNotifier;
    notify?.call(this.game, (identity) => this.publish(identity));
    const ended = (
      this.game as GameService & {
        setEndNotifier?: (
          fn: (id: RoomIdentity, reason: RoomEndReason | null) => Promise<void>,
        ) => void;
      }
    ).setEndNotifier;
    ended?.call(this.game, (identity, reason) => this.forget(identity, reason));
    this.heartbeat = setInterval(() => this.beat(), SOCKET_LIMITS.heartbeatMs);
    this.heartbeat.unref();
  }
  /** Stops the heartbeat. */
  onModuleDestroy(): void {
    clearInterval(this.heartbeat);
  }

  /** Origin + handshake validation and optional host authentication before the socket connects. */
  private async admit(socket: GameSocket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    if (!origin || !this.config.get("CORS_ORIGIN").includes(origin))
      throw new ApiError("ORIGIN_DENIED", 403);
    const parsed = handshakeSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 422);
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    socket.data = {
      ip: clientIp(
        socket.handshake.address || "127.0.0.1",
        typeof forwarded === "string" ? forwarded : undefined,
        this.trusted,
      ),
      host: null,
      player: null,
      expiry: null,
    };
    if (parsed.data.accessToken) {
      try {
        socket.data.host = await this.jwt.authenticate(parsed.data.accessToken);
      } catch {
        throw new ApiError("AUTH_REQUIRED", 401);
      }
    }
  }

  /** Registers the 16 request handlers; anonymous sockets get a 120 s join deadline. */
  handleConnection(socket: GameSocket): void {
    if (!socket.data.host)
      socket.data.expiry = setTimeout(() => {
        if (!socket.data.host && !socket.data.player) socket.disconnect(true);
      }, SOCKET_LIMITS.anonymousLifetimeMs);
    for (const event of Object.keys(clientContracts) as ClientEventName[])
      socket.on(event, (payload: unknown, ack: unknown) => {
        void this.dispatch(event, socket, payload).then((response) => {
          if (typeof ack === "function") (ack as (value: unknown) => void)(response);
        });
      });
  }
  /** Marks the bound player disconnected (generation-checked) and publishes presence. */
  async handleDisconnect(socket: GameSocket): Promise<void> {
    if (socket.data.expiry) clearTimeout(socket.data.expiry);
    const binding = socket.data.player;
    if (!binding) return;
    await this.store
      .setPresence(binding, binding.playerId, binding.generation, false)
      .catch(() => false);
    await this.publish(binding).catch(() => undefined);
  }

  /**
   * Rejects, before any limiter key is created, a request whose tier needs a binding the socket
   * does not have (code review MJ-15). These requests would fail in `execute` anyway (answers and
   * avatars need a bound player; sync and time need a bound player or an authenticated host), so
   * the client sees the same error, but an anonymous socket can no longer mint a limiter key per
   * connection and fill the in-memory limiter.
   */
  private requireBinding(event: ClientEventName, socket: GameSocket): void {
    const tier = TIERS[event];
    if ((tier === "ANSWER" || tier === "AVATAR") && !socket.data.player)
      throw new ApiError("INVALID_SESSION_TOKEN", 401);
    if ((tier === "SYNC" || tier === "TIME") && !socket.data.player && !socket.data.host)
      throw new ApiError("AUTH_REQUIRED", 401);
  }
  /**
   * Rate key for an event (code review MJ-15). Keys never depend on the socket id, so the number of
   * limiter keys grows with authenticated hosts, joined players and client IPs, not connections:
   * - HOST: the host user, or the client IP when unauthenticated;
   * - ANSWER/AVATAR: the bound player;
   * - SYNC/TIME: the bound player, else the host user (unbound sockets are rejected earlier);
   * - everything else (auth, PIN check, join, friendly name): the client IP.
   */
  private rateKey(event: ClientEventName, socket: GameSocket): string {
    const tier = TIERS[event];
    const { host, player, ip } = socket.data;
    if (tier === "HOST") return host ? `user:${host.user.id}` : `ip:${ip}`;
    if (tier === "ANSWER" || tier === "AVATAR" || tier === "SYNC" || tier === "TIME") {
      if (player) return `player:${player.playerId}`;
      if (host) return `user:${host.user.id}`;
    }
    return `ip:${ip}`;
  }
  /** Validates, rate-limits, executes and wraps one client request into its ACK envelope. */
  private async dispatch(event: ClientEventName, socket: GameSocket, payload: unknown) {
    const raw =
      typeof payload === "object" && payload !== null
        ? (payload as { requestId?: unknown }).requestId
        : undefined;
    const requestId = typeof raw === "string" && UUID.test(raw) ? raw : randomUUID();
    try {
      this.requireBinding(event, socket);
      await this.limiter.consume(TIERS[event], this.rateKey(event, socket));
      if (event === "host:create_room")
        await this.limiter.consume("CREATE", this.rateKey(event, socket));
      const request = clientContracts[event].request.parse(payload) as Record<string, unknown> & {
        requestId: string;
      };
      const data = await this.execute(event, socket, request);
      return clientContracts[event].ack.parse({
        ok: true,
        requestId,
        serverTime: Date.now(),
        data,
      });
    } catch (error) {
      return { ok: false, requestId, serverTime: Date.now(), error: envelope(error) };
    }
  }
  /** Host principal of the socket or 401. */
  private host(socket: GameSocket): VerifiedPrincipal {
    if (!socket.data.host) throw new ApiError("AUTH_REQUIRED", 401);
    return socket.data.host;
  }
  /** Player binding for the addressed room or 401. */
  private player(socket: GameSocket, request: Record<string, unknown>): PlayerBinding {
    const binding = socket.data.player;
    if (!binding || binding.sessionId !== request.sessionId || binding.pin !== request.pinCode)
      throw new ApiError("INVALID_SESSION_TOKEN", 401);
    return binding;
  }
  /** Joins the host socket to its room channel after verifying ownership via projection. */
  private async attachHost(socket: GameSocket, identity: RoomIdentity) {
    const principal = this.host(socket);
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state) throw new ApiError("ROOM_NOT_FOUND", 404);
    const snapshot = projectHost(state, principal.user.id, Date.now());
    await socket.join(`host:${identity.sessionId}`);
    return snapshot;
  }

  /** Executes one validated request and returns its ACK data. */
  private async execute(
    event: ClientEventName,
    socket: GameSocket,
    request: Record<string, unknown> & { requestId: string },
  ): Promise<unknown> {
    if (HOST_EVENTS.has(event)) {
      const principal = this.host(socket);
      const identity = { pin: String(request.pinCode), sessionId: String(request.sessionId) };
      const ack = await this.game.hostCommand(principal, { event, request } as HostCommand);
      await this.publish(identity);
      if (!ack.ok)
        throw new ApiError(
          ack.error.errorCode,
          ack.error.statusCode,
          ack.error.params,
          ack.error.details,
        );
      return ack.data;
    }
    switch (event) {
      case "auth:update": {
        socket.data.host = await this.jwt.authenticate(String(request.accessToken)).catch(() => {
          throw new ApiError("AUTH_REQUIRED", 401);
        });
        return { authenticated: true };
      }
      case "host:create_room": {
        const ack = await this.rooms.createRoom(this.host(socket), request as never);
        await this.attachHost(socket, { pin: ack.pinCode, sessionId: ack.sessionId });
        await this.publish({ pin: ack.pinCode, sessionId: ack.sessionId });
        return ack;
      }
      case "host:recover_room": {
        const allocation = await this.findSession(String(request.sessionId));
        return { snapshot: await this.attachHost(socket, allocation) };
      }
      case "player:check_pin":
        return this.recovery.checkPin(String(request.pinCode));
      case "player:request_friendly_name":
        return this.recovery.requestFriendlyName(String(request.pinCode), {
          connectionId: socket.id,
          ip: socket.data.ip,
        });
      case "player:join_room": {
        const outcome = await this.recovery.join(request as never, {
          connectionId: socket.id,
          ip: socket.data.ip,
        });
        const binding = outcome.binding;
        this.server
          .to(`player:${binding.playerId}`)
          .except(socket.id)
          .emit(
            "player:session_replaced",
            this.push(binding, await this.store.getPrivateSnapshot(binding), {
              reason: "SESSION_REPLACED",
            }),
          );
        this.server.in(`player:${binding.playerId}`).except(socket.id).disconnectSockets(true);
        socket.data.player = binding;
        if (socket.data.expiry) clearTimeout(socket.data.expiry);
        await socket.join([`players:${binding.sessionId}`, `player:${binding.playerId}`]);
        await this.publish(binding);
        return outcome.ack;
      }
      case "player:update_avatar": {
        const binding = this.player(socket, request);
        try {
          await this.store.updateAvatar(
            binding,
            binding.playerId,
            binding.generation,
            request.avatar as { style: string; seed: string },
          );
        } catch (error) {
          stateError(error);
        }
        await this.publish(binding);
        return { avatar: request.avatar };
      }
      case "player:submit_answer": {
        const binding = this.player(socket, request);
        const ack = await this.game.submitAnswer(binding, request as never);
        // The ACK reports the admission; the room changes reach clients as pushes. Waiting for the
        // room's publish queue here made the N-th answer of a burst wait for N diffs (TASK-183A).
        // A missed publish is caught by the room:version heartbeat.
        void this.publish(binding);
        return ack;
      }
      case "room:sync": {
        const identity = { pin: String(request.pinCode), sessionId: String(request.sessionId) };
        if (socket.data.player?.sessionId === identity.sessionId) {
          const binding = this.player(socket, request);
          const snapshot = await this.store
            .getRoleSnapshot(identity, {
              role: "player",
              playerId: binding.playerId,
              generation: binding.generation,
            })
            .catch(stateError);
          if (!snapshot) throw new ApiError("ROOM_NOT_FOUND", 404);
          return { snapshot };
        }
        return { snapshot: await this.attachHost(socket, identity) };
      }
      case "room:time": {
        const received = Date.now();
        if (!socket.data.player && !socket.data.host) throw new ApiError("AUTH_REQUIRED", 401);
        return {
          clientSentAt: request.clientSentAt,
          serverReceivedAt: received,
          serverSentAt: Math.max(received, Date.now()),
        };
      }
      default:
        throw new ApiError("VALIDATION_FAILED", 422);
    }
  }
  /** Room identity for a session the caller hosts (allocation lookup by session ID). */
  private async findSession(sessionId: string): Promise<RoomIdentity> {
    for (const summary of this.summaries.entries())
      if (summary[0] === sessionId) return { pin: summary[1].pin, sessionId };
    const allocation = await this.runtime.find(sessionId);
    if (!allocation || !["ACTIVE", "FINALIZING"].includes(allocation.status))
      throw new ApiError("ROOM_NOT_FOUND", 404);
    return { pin: allocation.pin_code, sessionId };
  }

  /** Push envelope for a room event. */
  private push(identity: RoomIdentity, state: Readonly<ActiveRoomState> | null, data: unknown) {
    return {
      protocolVersion: 1 as const,
      sessionId: identity.sessionId,
      pinCode: identity.pin,
      phaseVersion: state?.phaseVersion ?? 1,
      revision: state?.revision ?? 1,
      serverTime: Date.now(),
      eventId: randomUUID(),
      data,
    };
  }
  /**
   * Runs `step` after the room's queued publishes. The queue entry is removed once the last queued
   * step settles, so the map holds only rooms with work in flight (code review MJ-05).
   */
  private enqueue(sessionId: string, step: () => Promise<void> | void): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(step)
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
      });
    this.queues.set(sessionId, next);
    return next;
  }
  /**
   * Serializes publishes per room so diffs are computed against a consistent summary, and
   * coalesces them: a call made while a publish of the room is queued but not started shares it.
   * A diff reads the state when it starts and compares it with the last published summary, so the
   * shared diff covers every change made before it. A burst of answers therefore runs at most one
   * diff in flight plus one queued, instead of one full diff per answer (QA follow-up TASK-183A).
   */
  publish(identity: RoomIdentity): Promise<void> {
    const key = identity.sessionId;
    const pending = this.pendingPublishes.get(key);
    if (pending) return pending;
    const queued = this.enqueue(key, () => {
      this.pendingPublishes.delete(key);
      return this.diff(identity);
    });
    this.pendingPublishes.set(key, queued);
    return queued;
  }
  /**
   * Forgets a room the scheduler dropped (code review MJ-05): after the queued publishes, sends
   * `room:expired` with `reason` to its host and players (null: released quietly after retention)
   * and removes its summary, which also stops its heartbeat. With the Redis adapter the push
   * reaches clients connected to every instance.
   */
  forget(identity: RoomIdentity, reason: RoomEndReason | null): Promise<void> {
    return this.enqueue(identity.sessionId, () => {
      if (reason)
        this.server
          .to([`host:${identity.sessionId}`, `players:${identity.sessionId}`])
          .emit("room:expired", this.push(identity, null, { reason }));
      this.summaries.delete(identity.sessionId);
    });
  }
  /** Emits the role-safe events implied by the change since the last published summary. */
  private async diff(identity: RoomIdentity): Promise<void> {
    const before = this.summaries.get(identity.sessionId);
    const state = await this.store.getPrivateSnapshot(identity);
    const all = [`host:${identity.sessionId}`, `players:${identity.sessionId}`];
    if (!state) {
      if (before)
        this.server
          .to(all)
          .emit("room:expired", this.push(identity, null, { reason: "ROOM_LOST" }));
      this.summaries.delete(identity.sessionId);
      return;
    }
    if (before && before.revision === state.revision) return;
    const now = Date.now();
    const hostView = projectHost(state, state.hostId, now);
    const index = state.questionIndex;
    const answered =
      index === null
        ? 0
        : state.requiredPlayerIds.filter(
            (id) => state.answers[`${index}:${id}`] && state.players[id]?.kickedAt === null,
          ).length;
    const summary: Summary = {
      pin: identity.pin,
      revision: state.revision,
      publicRevision: state.publicRevision,
      phaseVersion: state.phaseVersion,
      isLocked: state.isLocked,
      answered,
      finalization: state.finalization
        ? `${state.finalization.status}:${state.finalization.updatedAt}`
        : null,
      players: new Map(
        Object.values(state.players).map((p) => [
          p.id,
          { avatar: JSON.stringify(p.avatar), connected: p.connected, kicked: p.kickedAt !== null },
        ]),
      ),
    };
    this.summaries.set(identity.sessionId, summary);
    const emit = (rooms: string | string[], name: string, data: unknown) =>
      this.server.to(rooms).emit(name, this.push(identity, state, data));
    const active = Object.values(state.players).filter((p) => p.kickedAt === null);
    for (const player of Object.values(state.players)) {
      const old = before?.players.get(player.id);
      const kicked = player.kickedAt !== null;
      if (!old && !kicked)
        emit(all, "room:player_joined", {
          player: {
            id: player.id,
            nickname: player.nickname,
            avatar: player.avatar,
            connected: player.connected,
            joinOrder: player.joinOrder,
          },
          totalPlayers: active.length,
        });
      if (old && !old.kicked && kicked) {
        emit(all, "room:player_left", {
          playerId: player.id,
          totalPlayers: active.length,
          reason: "KICKED",
        });
        emit(`player:${player.id}`, "player:kicked", { reason: "HOST_REMOVED" });
        this.server.in(`player:${player.id}`).disconnectSockets(true);
      }
      if (old && !kicked && old.avatar !== JSON.stringify(player.avatar))
        emit(all, "room:player_updated", { playerId: player.id, avatar: player.avatar });
      if (old && !kicked && old.connected !== player.connected)
        emit(all, "room:presence_changed", { playerId: player.id, connected: player.connected });
    }
    if (before && before.isLocked !== state.isLocked)
      emit(all, "room:lock_changed", { isLocked: state.isLocked });
    if (
      state.phase === "QUESTION_ANSWERING" &&
      (!before || before.answered !== answered || before.phaseVersion !== state.phaseVersion)
    )
      emit(`host:${identity.sessionId}`, "game:answer_count_updated", {
        answeredCount: answered,
        totalPlayers: state.requiredPlayerIds.filter((id) => state.players[id]?.kickedAt === null)
          .length,
        optionalAnswerCount:
          index === null
            ? 0
            : state.eligiblePlayerIds.filter(
                (id) => !state.requiredPlayerIds.includes(id) && state.answers[`${index}:${id}`],
              ).length,
      });
    if (hostView.finalization && before?.finalization !== summary.finalization)
      emit(`host:${identity.sessionId}`, "report:status_changed", hostView.finalization);
    if (before && before.phaseVersion === state.phaseVersion) return;
    const t = state.timing;
    switch (state.phase) {
      case "GAME_START_COUNTDOWN":
        emit(all, "game:countdown", {
          durationSec: 3,
          quizTitle: state.quiz.title,
          totalQuestions: state.quiz.questions.length,
          phaseStartedAt: t.phaseStartedAt,
          phaseEndsAt: t.phaseEndsAt ?? t.phaseStartedAt + GAME_TIMING.countdownMs,
        });
        break;
      case "QUESTION_PREVIEW":
        emit(all, "game:question_preview", {
          question: hostView.question,
          previewDurationMs: GAME_TIMING.previewMs,
          phaseStartedAt: t.phaseStartedAt,
          phaseEndsAt: t.phaseEndsAt,
        });
        break;
      case "QUESTION_ANSWERING":
        emit(all, "game:question_answering", {
          question: hostView.question,
          serverStartTime: t.questionStartedAt,
          inputClosesAt: t.inputClosesAt,
          acceptanceClosesAt: t.acceptanceClosesAt,
        });
        break;
      case "ANSWER_REVEAL":
        emit(`host:${identity.sessionId}`, "game:answer_reveal", { reveal: hostView.reveal });
        for (const player of active) {
          const view = projectPlayer(state, player.id, player.connectionGeneration, now);
          if (view.reveal && view.self.result)
            emit(`player:${player.id}`, "game:answer_reveal", {
              reveal: view.reveal,
              result: view.self.result,
            });
        }
        break;
      case "LEADERBOARD":
        if (hostView.leaderboard) {
          emit(`host:${identity.sessionId}`, "game:leaderboard", hostView.leaderboard);
          for (const player of active)
            emit(`player:${player.id}`, "game:leaderboard", {
              ...hostView.leaderboard,
              selfRank: player.rank,
            });
        }
        break;
      case "PODIUM":
        if (hostView.finalization)
          emit(`host:${identity.sessionId}`, "game:podium", {
            podium: hostView.podium,
            finalization: hostView.finalization,
            reportId: hostView.finalization.reportId,
          });
        for (const player of active) {
          const view = projectPlayer(state, player.id, player.connectionGeneration, now);
          emit(`player:${player.id}`, "game:podium", {
            podium: view.podium,
            result: view.self.result,
          });
        }
        break;
      case "FINISHED":
        emit(all, "game:finished", { endReason: state.endReason ?? "COMPLETED" });
        break;
      default:
        break;
    }
  }
  /** 5 s heartbeat of the public revision for every room this instance has published. */
  private beat(): void {
    for (const [sessionId, summary] of this.summaries)
      this.server.to([`host:${sessionId}`, `players:${sessionId}`]).emit("room:version", {
        protocolVersion: 1,
        sessionId,
        pinCode: summary.pin,
        phaseVersion: summary.phaseVersion,
        revision: summary.revision,
        serverTime: Date.now(),
        eventId: randomUUID(),
        data: { publicRevision: summary.publicRevision },
      });
  }
}
