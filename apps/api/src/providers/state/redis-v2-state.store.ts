/**
 * Redis game-state store, layout v2 (ADR-13, SA §6.1.1; TASK-185M onward).
 *
 * The v1 store (`redis-state.store.ts`) kept each room as one JSON string that every script decoded
 * and re-encoded, so per-answer Redis work grew with every played question. v2 keeps the room in
 * separate keys of one hash slot `{pin}`: `core` and `quiz` in `:meta`, `:players`,
 * `:answers:<q>`, `:closed:<q>`, `:result:<q>`, `:commands`, `:tickets` and `:report`. Scripts
 * touch only the pieces an operation changes.
 *
 * Reads go through the `read` operation of `lua/v2-room.lua`, which returns the raw pieces of a
 * consistent snapshot (one atomic script, which also follows Cluster redirections as one command):
 * - `getPrivateSnapshot`: every question, assembled and fully validated (finalization, recovery);
 * - `readPrivateSnapshot`: the read-only window (current + latest scored question), only
 *   structurally restored, cached while its raw pieces are unchanged (hot paths).
 *
 * Built next to v1 and not yet installed in `StateModule`. Ported so far: room lifecycle, reads,
 * leases and the report (TASK-185M); players: join, recover, presence, avatar, friendly tickets
 * (TASK-185N, `lua/v2-player.lua`); answer admission and question freeze (TASK-185O,
 * `lua/v2-answer.lua`); result commits, host commands and scheduled phases (TASK-185P,
 * `lua/v2-question.lua`, with host skip/end in `lua/v2-answer.lua` next to the freeze).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Redis, Cluster } from "ioredis";
import { z } from "zod";
import { ERROR_CODES } from "@kabuki-neko/shared/errors";
import { clientContracts } from "@kabuki-neko/shared/socket-events";
import {
  finalizeStatusSchema,
  playerRoomSyncSchema,
} from "@kabuki-neko/shared/schemas/game.schema";
import { answerSchemaForQuestion } from "@kabuki-neko/shared/schemas/question.schema";
import { avatarSchema } from "@kabuki-neko/shared/schemas/users.schema";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { StateDomainError } from "./game-state.interface";
import type {
  ActiveRoomState,
  AdmitAnswerInput,
  ApplyCommandInput,
  BindPlayerInput,
  BindPlayerResult,
  ClosedQuestion,
  CloseQuestionInput,
  CommandResult,
  CommitQuestionInput,
  FriendlyTicket,
  FrozenReport,
  IGameStateStore,
  Lease,
  Principal,
  QuizSnapshot,
  RoomIdentity,
  RoomProjector,
  StoredAnswer,
} from "./game-state.interface";
import {
  activePlayerSchema,
  activeRoomStateSchema,
  assembleRoomState,
  closedQuestionSchema,
  commandAckSchema,
  commandReceiptSchema,
  friendlyTicketSchema,
  frozenReportSchema,
  joinReceiptSchema,
  leaseSchema,
  questionResultSchema,
  quizSnapshotSchema,
  roomCoreSchema,
  splitRoomState,
  storedAnswerSchema,
  type RoomParts,
} from "./private-state.schema";
import { restoreArrays } from "./redis-state.store";

/** Throws the domain error `code`. */
const fail = (code: ConstructorParameters<typeof StateDomainError>[0]): never => {
  throw new StateDomainError(code);
};
/** Script JSON replies are objects; the operation decides which fields matter. */
const objectSchema = z.record(z.string(), z.unknown());
/** Reply of a host command: committed or replayed, with the room's versions and the ACK. */
const commandResultSchema = z.object({
  committed: z.boolean(),
  revision: z.number().int(),
  phaseVersion: z.number().int(),
  ack: commandAckSchema,
});
/** Rooms whose last read window is cached, at most (oldest dropped first). */
const WINDOW_CACHE_ROOMS = 256;
/** Sessions whose immutable quiz snapshot is cached for answer validation, at most. */
const QUIZ_CACHE_SESSIONS = 256;
/** Scripts of the v2 layout, loaded from `lua/<name>.lua`. */
const SCRIPTS = ["v2-room", "v2-player", "v2-answer", "v2-question"] as const;
type ScriptName = (typeof SCRIPTS)[number];

/** A flat `HGETALL` reply `[field, value, …]` as a record of raw JSON strings. */
function pairs(flat: unknown): Record<string, string> {
  if (!Array.isArray(flat) || flat.length % 2 !== 0) return fail("STATE_UNAVAILABLE");
  const record: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) {
    const [field, value] = [flat[i], flat[i + 1]];
    if (typeof field !== "string" || typeof value !== "string") return fail("STATE_UNAVAILABLE");
    record[field] = value;
  }
  return record;
}
/** One stored JSON piece, parsed and with its cjson-encoded empty arrays restored (no validation). */
function piece<T>(schema: z.ZodType<T>, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("STATE_UNAVAILABLE");
  }
  return restoreArrays(schema, parsed) as T;
}
/** Every value of a stored hash, parsed as `schema` pieces, keyed like the hash. */
function pieces<T>(schema: z.ZodType<T>, raw: Record<string, string>): Record<string, T> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, piece(schema, value)]));
}

/** The raw pieces of one `read` reply plus the Redis clock and expiry fields. */
interface RawRead {
  parts: RoomParts;
  expiresAt: number;
  now: number;
  /** Joined raw strings: equal raw text means an unchanged window (cache key). */
  fingerprint: string;
}

/** Redis store with the v2 room layout (see the file comment). */
export class RedisV2StateStore implements IGameStateStore {
  private readonly scripts = new Map<ScriptName, { source: string; sha: string }>();
  private destroyed = false;
  /** Last read window per room, keyed by its raw pieces (see `readPrivateSnapshot`). */
  private readonly windowCache = new Map<string, { fingerprint: string; state: ActiveRoomState }>();
  /** Immutable quiz snapshot per room session (see `sessionQuiz`). */
  private readonly quizCache = new Map<string, QuizSnapshot>();
  /**
   * @param redis command connection (standalone or Cluster)
   * @param project allowlist role projector (TASK-076) used by `getRoleSnapshot`
   * @param namespace deployment state namespace (`STATE_NAMESPACE`)
   */
  constructor(
    private readonly redis: Redis | Cluster,
    private readonly project: RoomProjector,
    private readonly namespace = "default",
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(namespace)) fail("INVALID_FORMAT");
    for (const name of SCRIPTS) {
      const source = readFileSync(path.join(__dirname, "lua", `${name}.lua`), "utf8");
      this.scripts.set(name, { source, sha: createHash("sha1").update(source).digest("hex") });
    }
  }
  /** Stops issuing commands (the connection itself belongs to StateConnections). */
  onModuleDestroy(): void {
    this.destroyed = true;
  }
  /**
   * The seven declared keys of a room in script order: meta, join-receipts, lease, players,
   * commands, tickets, report. Per-question keys are derived from the same prefix in the scripts.
   */
  private keys(identity: RoomIdentity): string[] {
    if (!/^[0-9]{6}$/u.test(identity.pin) || !z.uuid().safeParse(identity.sessionId).success)
      return fail("INVALID_FORMAT");
    const prefix = `kabukineko:${this.namespace}:v2:room:{${identity.pin}}`;
    return ["meta", "join-receipts", "lease", "players", "commands", "tickets", "report"].map(
      (suffix) => `${prefix}:${suffix}`,
    );
  }
  /** Runs a script for a room and returns its raw reply (STATE_UNAVAILABLE on any failure). */
  private async evaluate(name: ScriptName, identity: RoomIdentity, operation: object) {
    const keys = this.keys(identity);
    const script = this.scripts.get(name);
    if (!script || this.destroyed) return fail("STATE_UNAVAILABLE");
    const args = [keys.length, ...keys, identity.sessionId, JSON.stringify(operation)] as const;
    try {
      try {
        return (await this.redis.evalsha(script.sha, ...args)) as unknown;
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) throw error;
        // EVAL routes to the room's cluster node and repopulates that node's script cache.
        return (await this.redis.eval(script.source, ...args)) as unknown;
      }
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
  }
  /** Runs a JSON-replying operation and maps `{error}` replies to domain errors. */
  private async run(
    name: ScriptName,
    identity: RoomIdentity,
    operation: object,
  ): Promise<Record<string, unknown>> {
    const raw = await this.evaluate(name, identity, operation);
    let parsed: unknown;
    try {
      parsed = JSON.parse(z.string().parse(raw));
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
    const result = objectSchema.safeParse(parsed);
    if (!result.success) return fail("STATE_UNAVAILABLE");
    if (result.data.error !== undefined) {
      const code = z.enum(ERROR_CODES).safeParse(result.data.error);
      return fail(code.success ? code.data : "STATE_UNAVAILABLE");
    }
    return result.data;
  }
  /** Decodes a `read` reply into room pieces; null for a missing room or another session. */
  private async readRaw(identity: RoomIdentity, mode: "full" | "window"): Promise<RawRead | null> {
    const reply = await this.evaluate("v2-room", identity, { kind: "read", mode });
    if (!Array.isArray(reply)) return fail("STATE_UNAVAILABLE");
    if (reply.length === 0) return null;
    const [core, quiz, expiresAt, , now, players, commands, tickets, report, ...questions] =
      reply as unknown[];
    if (
      typeof core !== "string" ||
      typeof quiz !== "string" ||
      typeof expiresAt !== "string" ||
      typeof now !== "string" ||
      (report !== null && typeof report !== "string") ||
      questions.length % 4 !== 0
    )
      return fail("STATE_UNAVAILABLE");
    const rawPlayers = pairs(players);
    const rawCommands = pairs(commands);
    const rawTickets = pairs(tickets);
    const parts: RoomParts = {
      core: piece(roomCoreSchema, core),
      quiz: piece(quizSnapshotSchema, quiz),
      players: pieces(activePlayerSchema, rawPlayers),
      answers: {},
      closedQuestions: {},
      results: {},
      commands: pieces(commandReceiptSchema, rawCommands),
      tickets: pieces(friendlyTicketSchema, rawTickets),
      frozenReport: typeof report === "string" ? piece(frozenReportSchema, report) : null,
    };
    const text = [core, quiz, report ?? "", JSON.stringify([rawPlayers, rawCommands, rawTickets])];
    for (let i = 0; i < questions.length; i += 4) {
      const [q, answers, closed, result] = questions.slice(i, i + 4);
      if (
        typeof q !== "string" ||
        (closed !== null && typeof closed !== "string") ||
        (result !== null && typeof result !== "string")
      )
        return fail("STATE_UNAVAILABLE");
      const rawAnswers = pairs(answers);
      if (Object.keys(rawAnswers).length > 0)
        parts.answers[q] = pieces(storedAnswerSchema, rawAnswers);
      if (typeof closed === "string")
        parts.closedQuestions[q] = piece(closedQuestionSchema, closed);
      if (typeof result === "string") parts.results[q] = piece(questionResultSchema, result);
      text.push(q, JSON.stringify(rawAnswers), closed ?? "", result ?? "");
    }
    if (parts.core.sessionId !== identity.sessionId || parts.core.pinCode !== identity.pin)
      return fail("STATE_UNAVAILABLE");
    return {
      parts,
      expiresAt: Number(expiresAt),
      now: Number(now),
      fingerprint: text.join("\u0000"),
    };
  }
  /** Whether the room is logically expired at Redis time `now` (same rules as v1). */
  private expired(state: Readonly<ActiveRoomState>, expiresAt: number, now: number): boolean {
    return state.phase === "FINISHED"
      ? now >= state.timing.phaseStartedAt + 3_600_000
      : now >= Math.min(expiresAt, state.hardExpiresAt) ||
          (state.phase === "LOBBY" && now >= state.lobbyActiveAt + 7_200_000);
  }

  /** Creates the room's keys from a validated state; EXISTS when its PIN is already taken. */
  async createRoom(
    pin: string,
    state: ActiveRoomState,
    ttlMs: number,
  ): Promise<"CREATED" | "EXISTS"> {
    const parsed = activeRoomStateSchema.parse(state);
    if (pin !== parsed.pinCode || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      return fail("INVALID_FORMAT");
    const identity = { pin, sessionId: parsed.sessionId };
    try {
      const reply = await this.run("v2-room", identity, {
        kind: "create",
        parts: splitRoomState(parsed),
        ttlMs,
      });
      return z.enum(["CREATED", "EXISTS"]).parse(reply.result);
    } catch (error: unknown) {
      if (error instanceof StateDomainError && error.code === "ROOM_NOT_FOUND") return "EXISTS";
      throw error;
    }
  }
  /** Complete private state, assembled from every key and fully validated. */
  async getPrivateSnapshot(identity: RoomIdentity): Promise<ActiveRoomState | null> {
    const read = await this.readRaw(identity, "full");
    if (!read) return null;
    const state = activeRoomStateSchema.safeParse(assembleRoomState(read.parts));
    return state.success ? state.data : fail("STATE_UNAVAILABLE");
  }
  /**
   * Read-only window (current + latest scored question; ADR-13): structurally restored but not
   * validated (the state is written only by this store, from validated input and its own
   * scripts), and reused while its raw pieces are unchanged. Never mutate the result.
   */
  async readPrivateSnapshot(identity: RoomIdentity): Promise<Readonly<ActiveRoomState> | null> {
    const read = await this.readRaw(identity, "window");
    if (!read) {
      this.windowCache.delete(identity.sessionId);
      return null;
    }
    const cached = this.windowCache.get(identity.sessionId);
    if (cached && cached.fingerprint === read.fingerprint) return cached.state;
    const state = assembleRoomState(read.parts);
    this.windowCache.delete(identity.sessionId);
    this.windowCache.set(identity.sessionId, { fingerprint: read.fingerprint, state });
    if (this.windowCache.size > WINDOW_CACHE_ROOMS) {
      const oldest = this.windowCache.keys().next().value;
      if (oldest !== undefined) this.windowCache.delete(oldest);
    }
    return state;
  }
  /** Role snapshot (host or bound player) projected from the read window; null when expired. */
  async getRoleSnapshot(identity: RoomIdentity, principal: Principal) {
    const read = await this.readRaw(identity, "window");
    if (!read) return null;
    const state = assembleRoomState(read.parts);
    if (this.expired(state, read.expiresAt, read.now)) return null;
    if (principal.role === "host") {
      if (state.hostId !== principal.hostId) return fail("FORBIDDEN");
    } else {
      const player = state.players[principal.playerId];
      if (!player) return fail("INVALID_SESSION_TOKEN");
      if (player.kickedAt !== null) return fail("PLAYER_KICKED");
      if (player.connectionGeneration !== principal.generation) return fail("SESSION_REPLACED");
    }
    return this.project(state, principal, read.now);
  }
  /** See IGameStateStore.expireToPodium; Redis TIME decides whether the lifetime has passed. */
  async expireToPodium(identity: RoomIdentity, expectedPhaseVersion: number) {
    const reply = await this.run("v2-room", identity, {
      kind: "expireToPodium",
      expectedPhaseVersion,
    });
    return z.boolean().parse(reply.result);
  }
  /** New scheduler lease (epoch + 1), null while another owner holds it, ROOM_NOT_FOUND if gone. */
  async acquireLease(identity: RoomIdentity, ownerId: string, ttlMs: number) {
    const result = (await this.run("v2-room", identity, { kind: "acquireLease", ownerId, ttlMs }))
      .result;
    if (result === false) return fail("ROOM_NOT_FOUND");
    return leaseSchema.nullable().parse(result);
  }
  /** Extends a lease still held by the same owner and epoch. */
  async renewLease(identity: RoomIdentity, lease: Lease, ttlMs: number) {
    const reply = await this.run("v2-room", identity, { kind: "renewLease", ...lease, ttlMs });
    return z.boolean().parse(reply.result);
  }
  /** Releases a lease held by the same owner and epoch. */
  async releaseLease(identity: RoomIdentity, lease: Lease) {
    const reply = await this.run("v2-room", identity, { kind: "releaseLease", ...lease });
    return z.boolean().parse(reply.result);
  }
  /** Deletes every key of the room unless a frozen report is not yet durable and ready. */
  async releaseRoom(identity: RoomIdentity) {
    this.windowCache.delete(identity.sessionId);
    const reply = await this.run("v2-room", identity, { kind: "releaseRoom" });
    return z.boolean().parse(reply.result);
  }
  /** Stores the immutable frozen report once (revision CAS) and keeps the room past its TTL. */
  async freezeReport(
    identity: RoomIdentity,
    expectedRevision: number,
    report: FrozenReport,
  ): Promise<"COMMITTED" | "RETRY"> {
    const reply = await this.run("v2-room", identity, {
      kind: "freezeReport",
      expectedRevision,
      report: frozenReportSchema.parse(report),
    });
    return z.enum(["COMMITTED", "RETRY"]).parse(reply.result);
  }
  /** Marks the frozen report durable in SQL, which allows `ready` and the release. */
  async acknowledgeDurableReport(identity: RoomIdentity): Promise<void> {
    await this.run("v2-room", identity, { kind: "acknowledgeDurableReport" });
  }
  /** Mirrors the finalization status into the room; returns the new revision. */
  async markFinalization(identity: RoomIdentity, status: FinalizeStatus) {
    const reply = await this.run("v2-room", identity, {
      kind: "markFinalization",
      status: finalizeStatusSchema.parse(status),
    });
    return z.number().int().parse(reply.revision);
  }

  /**
   * Applies one host command with v1 semantics: identity checks, the `expectedPhaseVersion`
   * fence, deduplication by requestId in `:commands` (same ACK on replay, IDEMPOTENCY_CONFLICT on
   * another payload). Lock, kick, start and next run in `lua/v2-question.lua`; skip and end run in
   * `lua/v2-answer.lua`, where they freeze an answering question and wait (up to 5 s, polling
   * every 25 ms) for the result commit that writes their ACK.
   */
  async applyCommand(input: ApplyCommandInput): Promise<CommandResult> {
    const { command } = input;
    clientContracts[command.event].request.parse(command.request);
    if (
      command.request.sessionId !== input.sessionId ||
      command.request.pinCode !== input.pin ||
      command.request.requestId !== input.requestId
    )
      return fail("INVALID_REFERENCE");
    if (
      "expectedPhaseVersion" in command.request &&
      command.request.expectedPhaseVersion !== input.expectedPhaseVersion
    )
      return fail("STALE_PHASE");
    const delayed = command.event === "host:skip_timer" || command.event === "host:end_game";
    // next_step needs the quiz length; the script never decodes the quiz.
    const quiz = command.event === "host:next_step" ? await this.sessionQuiz(input) : null;
    const op = {
      ...command.request,
      kind: delayed ? "hostCommand" : "command",
      event: command.event,
      hostId: input.hostId,
      requestId: input.requestId,
      payloadHash: input.payloadHash,
      expectedPhaseVersion: input.expectedPhaseVersion,
      ...(quiz ? { questionCount: quiz.questions.length } : {}),
    };
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return commandResultSchema.parse(
          restoreArrays(
            commandResultSchema,
            await this.run(delayed ? "v2-answer" : "v2-question", input, op),
          ),
        );
      } catch (error: unknown) {
        if (
          !delayed ||
          !(error instanceof StateDomainError) ||
          error.code !== "OPERATION_PENDING" ||
          Date.now() >= deadline
        )
          throw error;
        await delay(25);
      }
    }
  }
  /**
   * Binds a connection to a player slot: a new join (with a 120 s idempotent join receipt and,
   * for friendly-nickname rooms, a consumed ticket) or a token recovery. The player's snapshot is
   * projected on a candidate first, so a projection failure never consumes a slot or a ticket.
   */
  async bindPlayer(input: BindPlayerInput): Promise<BindPlayerResult> {
    const binding = input.binding;
    if (binding.kind === "join") {
      activePlayerSchema.parse(binding.player);
      if (
        createHash("sha256").update(binding.sessionToken).digest("hex") !== binding.player.tokenHash
      )
        return fail("INVALID_SESSION_TOKEN");
      joinReceiptSchema.parse({
        requestId: input.requestId,
        payloadHash: input.payloadHash,
        playerId: binding.player.id,
        sessionToken: binding.sessionToken,
        expiresAt: Date.now() + 120000,
      });
    }
    // Fail closed if the projector is missing or would reject the bound player.
    const initial = await this.readRaw(input, "window");
    if (!initial) return fail("ROOM_NOT_FOUND");
    const candidate = assembleRoomState(structuredClone(initial.parts));
    if (this.expired(candidate, initial.expiresAt, initial.now)) return fail("ROOM_EXPIRED");
    const playerId = binding.kind === "join" ? binding.player.id : binding.playerId;
    if (binding.kind === "join" && !candidate.players[playerId])
      candidate.players[playerId] = binding.player;
    const candidatePlayer = candidate.players[playerId];
    if (candidatePlayer) {
      candidatePlayer.connectionGeneration++;
      candidatePlayer.connected = true;
      candidatePlayer.connectionId = input.connectionId;
    }
    this.project(
      candidate,
      { role: "player", playerId, generation: candidatePlayer?.connectionGeneration ?? 1 },
      initial.now,
    );
    const result = z
      .object({
        player: activePlayerSchema,
        token: z.string().nullable(),
        generation: z.number().int(),
      })
      .parse(
        restoreArrays(
          z.object({ player: activePlayerSchema }),
          await this.run("v2-player", input, {
            ...binding,
            requestId: input.requestId,
            payloadHash: input.payloadHash,
            connectionId: input.connectionId,
          }),
        ),
      );
    const snapshot = await this.getRoleSnapshot(input, {
      role: "player",
      playerId: result.player.id,
      generation: result.generation,
    });
    if (!snapshot) return fail("ROOM_EXPIRED");
    return { ...result, snapshot: playerRoomSyncSchema.parse(snapshot) };
  }
  /**
   * The quiz snapshot of a room session, read once with one `HMGET` of `:meta` and cached: a
   * session's quiz never changes, and a reused PIN has another session id (another cache key).
   * Null when the room is missing or belongs to another session.
   */
  private async sessionQuiz(identity: RoomIdentity): Promise<QuizSnapshot | null> {
    const cacheKey = `${identity.pin}:${identity.sessionId}`;
    const cached = this.quizCache.get(cacheKey);
    if (cached) return cached;
    const [meta] = this.keys(identity);
    if (!meta || this.destroyed) return fail("STATE_UNAVAILABLE");
    let reply: (string | null)[];
    try {
      reply = await this.redis.hmget(meta, "sessionId", "quiz");
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
    const [sessionId, raw] = reply;
    if (sessionId !== identity.sessionId || typeof raw !== "string") return null;
    const quiz = quizSnapshotSchema.safeParse(piece(quizSnapshotSchema, raw));
    if (!quiz.success) return fail("STATE_UNAVAILABLE");
    if (this.quizCache.size >= QUIZ_CACHE_SESSIONS) {
      const oldest = this.quizCache.keys().next().value;
      if (oldest !== undefined) this.quizCache.delete(oldest);
    }
    this.quizCache.set(cacheKey, quiz.data);
    return quiz.data;
  }
  /**
   * Admits one answer (`lua/v2-answer.lua` `admit`): Redis TIME intake with an inclusive
   * deadline, replay of the same submission, ALREADY_ANSWERED otherwise, and the ALL_ANSWERED
   * freeze in the same script when the last required player answers. The answer is validated here
   * against the session's cached quiz, so neither side decodes the room's played questions.
   */
  async admitAnswer(input: AdmitAnswerInput): Promise<StoredAnswer> {
    let quiz = await this.sessionQuiz(input);
    if (!quiz) return fail("ROOM_NOT_FOUND");
    let question = quiz.questions[input.questionIndex];
    if (!question || question.id !== input.questionId) {
      // A mismatch against a cached quiz is re-checked once against the stored one.
      this.quizCache.delete(`${input.pin}:${input.sessionId}`);
      quiz = await this.sessionQuiz(input);
      if (!quiz) return fail("ROOM_NOT_FOUND");
      question = quiz.questions[input.questionIndex];
    }
    if (!question || question.id !== input.questionId) return fail("QUESTION_MISMATCH");
    const parsed = answerSchemaForQuestion(question).safeParse(input.answer);
    if (!parsed.success) return fail("INVALID_ANSWER");
    const result = await this.run("v2-answer", input, {
      ...input,
      kind: "admit",
      answer: parsed.data,
      question: {
        id: question.id,
        type: question.type,
        optionCount: question.publicOptions.length,
      },
    });
    return storedAnswerSchema.parse(restoreArrays(storedAnswerSchema, result.answer));
  }
  /**
   * Freezes the current question (`lua/v2-answer.lua` `close`) for TIMER, HOST_SKIP, HOST_END,
   * ALL_ANSWERED or EXPIRED; ALREADY_CLOSED when it is frozen already.
   */
  async closeQuestion(input: CloseQuestionInput): Promise<ClosedQuestion | "ALREADY_CLOSED"> {
    const result = await this.run("v2-answer", input, { ...input, kind: "close" });
    if (result.result === "ALREADY_CLOSED") return "ALREADY_CLOSED";
    return closedQuestionSchema.parse(restoreArrays(closedQuestionSchema, result.closed));
  }
  /**
   * Commits the scored result of the frozen current question (`lua/v2-question.lua` `commit`):
   * RETRY unless the core revision and the closed-question hash still match and no result exists.
   */
  async commitQuestionResult(input: CommitQuestionInput): Promise<"COMMITTED" | "RETRY"> {
    const result = await this.run("v2-question", input, {
      ...input,
      kind: "commit",
      result: questionResultSchema.parse(input.result),
    });
    return z.enum(["COMMITTED", "RETRY"]).parse(result.result);
  }
  /** Reserves a friendly nickname for one socket in the lobby (replaces its earlier ticket). */
  async reserveFriendlyTicket(identity: RoomIdentity, ticket: FriendlyTicket): Promise<void> {
    await this.run("v2-player", identity, {
      kind: "ticket",
      ticket: friendlyTicketSchema.parse(ticket),
    });
  }
  /** Connected/disconnected for the player's current connection generation (false if stale). */
  async setPresence(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    connected: boolean,
  ): Promise<boolean> {
    const reply = await this.run("v2-player", identity, {
      kind: "presence",
      playerId,
      generation,
      connected,
    });
    return z.boolean().parse(reply.result);
  }
  /** LOBBY-only avatar change for the bound player connection; returns the new revision. */
  async updateAvatar(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    avatar: { style: string; seed: string },
  ): Promise<number> {
    const parsed = avatarSchema.safeParse(avatar);
    if (!parsed.success) return fail("INVALID_FORMAT");
    const reply = await this.run("v2-player", identity, {
      kind: "avatar",
      playerId,
      generation,
      avatar: parsed.data,
    });
    return z.number().int().positive().parse(reply.revision);
  }
  /**
   * Scheduled phase change with a phaseVersion CAS (`lua/v2-question.lua` `transition`). Redis
   * TIME, not the caller's `timing`, builds the new timing; entering QUESTION_ANSWERING takes the
   * question's time limit from the session's quiz.
   */
  async transitionPhase(
    identity: RoomIdentity,
    expectedPhaseVersion: number,
    phase: ActiveRoomState["phase"],
    timing: ActiveRoomState["timing"],
    questionIndex: number | null,
  ): Promise<boolean> {
    let question: { index: number; timeLimitSec: number } | null = null;
    if (phase === "QUESTION_ANSWERING" && questionIndex !== null) {
      const quiz = await this.sessionQuiz(identity);
      if (!quiz) return fail("ROOM_NOT_FOUND");
      const entry = quiz.questions[questionIndex];
      if (entry) question = { index: questionIndex, timeLimitSec: entry.timeLimitSec };
    }
    const result = await this.run("v2-question", identity, {
      kind: "transition",
      expectedPhaseVersion,
      phase,
      timing,
      questionIndex,
      question,
    });
    return z.boolean().parse(result.result);
  }
}
