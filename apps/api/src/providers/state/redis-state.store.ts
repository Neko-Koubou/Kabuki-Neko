import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Redis, Cluster } from "ioredis";
import { z } from "zod";
import { ERROR_CODES } from "@kabuki-neko/shared/errors";
import { clientContracts } from "@kabuki-neko/shared/socket-events";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { answerSchemaForQuestion } from "@kabuki-neko/shared/schemas/question.schema";
import {
  finalizeStatusSchema,
  pinCodeSchema,
  playerRoomSyncSchema,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import type { GamePhase } from "@kabuki-neko/shared/constants/game";
import { StateDomainError } from "./game-state.interface";
import type {
  ActiveRoomState,
  AdmitAnswerInput,
  ApplyCommandInput,
  BindPlayerInput,
  CloseQuestionInput,
  CommitQuestionInput,
  FriendlyTicket,
  FrozenReport,
  IGameStateStore,
  Lease,
  Principal,
  RoomIdentity,
  RoomProjector,
} from "./game-state.interface";
import {
  activeRoomStateSchema,
  activePlayerSchema,
  closedQuestionSchema,
  commandAckSchema,
  friendlyTicketSchema,
  frozenReportSchema,
  joinReceiptSchema,
  leaseSchema,
  questionResultSchema,
  storedAnswerSchema,
} from "./private-state.schema";

const objectSchema = z.record(z.string(), z.unknown());
const fail = (code: ConstructorParameters<typeof StateDomainError>[0]): never => {
  throw new StateDomainError(code);
};
const commandResultSchema = z.object({
  committed: z.boolean(),
  revision: z.number().int(),
  phaseVersion: z.number().int(),
  ack: commandAckSchema,
});
const readScript = `
local raw=redis.call('HGET',KEYS[1],'state')
if not raw or redis.call('HGET',KEYS[1],'sessionId') ~= ARGV[1] then return cjson.encode({missing=true}) end
local t=redis.call('TIME')
return cjson.encode({state=raw,expiresAt=tonumber(redis.call('HGET',KEYS[1],'expiresAt')),now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)})`;

/** Restore only schema-declared arrays encoded as {} by Redis cjson. Records,
 * including empty player/result maps, retain their object representation. */
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  let current: unknown = value;
  for (let pass = 0; pass < 20; pass++) {
    const result = schema.safeParse(current);
    if (result.success) return result.data;
    let changed = false;
    for (const issue of result.error.issues) {
      if (issue.code !== "invalid_type" || issue.expected !== "array") continue;
      let parent: unknown = current;
      for (const key of issue.path.slice(0, -1)) {
        if (!parent || typeof parent !== "object") break;
        parent = Reflect.get(parent, key);
      }
      const key = issue.path.at(-1);
      const target: unknown =
        key === undefined
          ? current
          : parent && typeof parent === "object"
            ? Reflect.get(parent, key)
            : null;
      if (
        !target ||
        Array.isArray(target) ||
        typeof target !== "object" ||
        Object.keys(target).length !== 0
      )
        continue;
      if (key === undefined) current = [];
      else if (parent && typeof parent === "object") Reflect.set(parent, key, []);
      changed = true;
    }
    if (!changed) return fail("STATE_UNAVAILABLE");
  }
  return fail("STATE_UNAVAILABLE");
}

/** Scripts alone mutate gameplay. Preliminary reads validate immutable quiz data;
 * every session, generation, phase and revision guard is repeated atomically. */
export class RedisStateStore implements IGameStateStore {
  private readonly scripts = new Map<string, { source: string; sha: string }>();
  private destroyed = false;
  constructor(
    private readonly redis: Redis | Cluster,
    private readonly project: RoomProjector,
    private readonly namespace = "default",
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(namespace)) fail("INVALID_FORMAT");
    for (const name of [
      "mutate-room",
      "bind-player",
      "release-room",
      "admit-answer",
      "close-question",
    ]) {
      const source = readFileSync(path.join(__dirname, "lua", `${name}.lua`), "utf8");
      this.scripts.set(name, { source, sha: createHash("sha1").update(source).digest("hex") });
    }
    this.scripts.set("read", {
      source: readScript,
      sha: createHash("sha1").update(readScript).digest("hex"),
    });
  }
  onModuleDestroy(): void {
    this.destroyed = true;
  }
  private keys(identity: RoomIdentity): string[] {
    pinCodeSchema.parse(identity.pin);
    uuidSchema.parse(identity.sessionId);
    const prefix = `kabukineko:${this.namespace}:room:{${identity.pin}}`;
    return ["meta", "join-receipts", "lease"].map((suffix) => `${prefix}:${suffix}`);
  }
  private async run(
    name: string,
    identity: RoomIdentity,
    operation: object,
  ): Promise<Record<string, unknown>> {
    const keys = this.keys(identity);
    const script = this.scripts.get(name);
    if (!script || this.destroyed) return fail("STATE_UNAVAILABLE");
    let raw: unknown;
    try {
      try {
        raw = await this.redis.evalsha(
          script.sha,
          keys.length,
          ...keys,
          identity.sessionId,
          JSON.stringify(operation),
        );
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.startsWith("NOSCRIPT")) throw error;
        // EVAL routes to the room's cluster node and repopulates that node's cache.
        raw = await this.redis.eval(
          script.source,
          keys.length,
          ...keys,
          identity.sessionId,
          JSON.stringify(operation),
        );
      }
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(z.string().parse(raw));
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
    const result = decode(objectSchema, parsed);
    if (result.error !== undefined) return fail(decode(z.enum(ERROR_CODES), result.error));
    return result;
  }
  private async read(identity: RoomIdentity) {
    const result = await this.run("read", identity, {});
    if (result.missing === true) return null;
    const envelope = decode(
      z.object({ state: z.string(), expiresAt: z.number(), now: z.number() }),
      result,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(envelope.state);
    } catch {
      return fail("STATE_UNAVAILABLE");
    }
    const state = decode(activeRoomStateSchema, raw);
    if (state.sessionId !== identity.sessionId || state.pinCode !== identity.pin)
      return fail("STATE_UNAVAILABLE");
    return {
      state,
      now: envelope.now,
      expired:
        state.phase === "FINISHED"
          ? envelope.now >= state.timing.phaseStartedAt + 3_600_000
          : envelope.now >= Math.min(envelope.expiresAt, state.hardExpiresAt) ||
            (state.phase === "LOBBY" && envelope.now >= state.lobbyActiveAt + 7_200_000),
    };
  }
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
      return decode(
        z.enum(["CREATED", "EXISTS"]),
        (await this.run("mutate-room", identity, { kind: "create", state: parsed, ttlMs })).result,
      );
    } catch (error: unknown) {
      if (error instanceof StateDomainError && error.code === "ROOM_NOT_FOUND") return "EXISTS";
      throw error;
    }
  }
  async getPrivateSnapshot(identity: RoomIdentity) {
    return (await this.read(identity))?.state ?? null;
  }
  async getRoleSnapshot(identity: RoomIdentity, principal: Principal) {
    const entry = await this.read(identity);
    if (!entry || entry.expired) return null;
    if (principal.role === "host") {
      if (entry.state.hostId !== principal.hostId) return fail("FORBIDDEN");
    } else {
      const p = entry.state.players[principal.playerId];
      if (!p) return fail("INVALID_SESSION_TOKEN");
      if (p.kickedAt !== null) return fail("PLAYER_KICKED");
      if (p.connectionGeneration !== principal.generation) return fail("SESSION_REPLACED");
    }
    return this.project(entry.state, principal, entry.now);
  }
  async bindPlayer(input: BindPlayerInput) {
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
    // Fail closed if the projector has not been installed by the domain module.
    const initial = await this.read(input);
    if (!initial) return fail("ROOM_NOT_FOUND");
    if (initial.expired) return fail("ROOM_EXPIRED");
    const playerId = binding.kind === "join" ? binding.player.id : binding.playerId;
    const candidate = structuredClone(initial.state);
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
    const result = decode(
      z.object({
        player: activePlayerSchema,
        token: z.string().nullable(),
        generation: z.number().int(),
      }),
      await this.run("bind-player", input, {
        ...binding,
        requestId: input.requestId,
        payloadHash: input.payloadHash,
        connectionId: input.connectionId,
      }),
    );
    const snapshot = await this.getRoleSnapshot(input, {
      role: "player",
      playerId: result.player.id,
      generation: result.generation,
    });
    if (!snapshot) return fail("ROOM_EXPIRED");
    return { ...result, snapshot: playerRoomSyncSchema.parse(snapshot) };
  }
  async applyCommand(input: ApplyCommandInput) {
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
    const op = {
      ...command.request,
      kind: delayed ? "hostCommand" : "command",
      event: command.event,
      hostId: input.hostId,
      requestId: input.requestId,
      payloadHash: input.payloadHash,
      expectedPhaseVersion: input.expectedPhaseVersion,
    };
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return decode(
          commandResultSchema,
          await this.run(delayed ? "close-question" : "mutate-room", input, op),
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
  async admitAnswer(input: AdmitAnswerInput) {
    const state = await this.getPrivateSnapshot(input);
    if (!state) return fail("ROOM_NOT_FOUND");
    const question = state.quiz.questions[input.questionIndex];
    if (!question || question.id !== input.questionId) return fail("QUESTION_MISMATCH");
    const parsed = answerSchemaForQuestion(question).safeParse(input.answer);
    if (!parsed.success) return fail("INVALID_ANSWER");
    return decode(
      storedAnswerSchema,
      (await this.run("admit-answer", input, { ...input, answer: parsed.data })).answer,
    );
  }
  async closeQuestion(input: CloseQuestionInput) {
    const result = await this.run("close-question", input, { ...input, kind: "close" });
    return result.result === "ALREADY_CLOSED"
      ? ("ALREADY_CLOSED" as const)
      : decode(closedQuestionSchema, result.closed);
  }
  async commitQuestionResult(input: CommitQuestionInput): Promise<"COMMITTED" | "RETRY"> {
    return decode(
      z.enum(["COMMITTED", "RETRY"]),
      (
        await this.run("close-question", input, {
          ...input,
          kind: "commit",
          result: questionResultSchema.parse(input.result),
        })
      ).result,
    );
  }
  async reserveFriendlyTicket(identity: RoomIdentity, ticket: FriendlyTicket): Promise<void> {
    await this.run("mutate-room", identity, {
      kind: "ticket",
      ticket: friendlyTicketSchema.parse(ticket),
    });
  }
  async setPresence(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    connected: boolean,
  ) {
    return decode(
      z.boolean(),
      (
        await this.run("mutate-room", identity, {
          kind: "presence",
          playerId,
          generation,
          connected,
        })
      ).result,
    );
  }
  async transitionPhase(
    identity: RoomIdentity,
    expectedPhaseVersion: number,
    phase: GamePhase,
    timing: ActiveRoomState["timing"],
    questionIndex: number | null,
  ) {
    // Redis TIME, rather than the API process clock, constructs the timing update.
    return decode(
      z.boolean(),
      (
        await this.run("mutate-room", identity, {
          kind: "transition",
          expectedPhaseVersion,
          phase,
          timing,
          questionIndex,
        })
      ).result,
    );
  }
  async acquireLease(identity: RoomIdentity, ownerId: string, ttlMs: number) {
    const result = (
      await this.run("release-room", identity, { kind: "acquireLease", ownerId, ttlMs })
    ).result;
    if (result === false) return fail("ROOM_NOT_FOUND");
    return decode(leaseSchema.nullable(), result);
  }
  async renewLease(identity: RoomIdentity, lease: Lease, ttlMs: number) {
    return decode(
      z.boolean(),
      (await this.run("release-room", identity, { kind: "renewLease", ...lease, ttlMs })).result,
    );
  }
  async releaseLease(identity: RoomIdentity, lease: Lease) {
    return decode(
      z.boolean(),
      (await this.run("release-room", identity, { kind: "releaseLease", ...lease })).result,
    );
  }
  async releaseRoom(identity: RoomIdentity) {
    return decode(
      z.boolean(),
      (await this.run("release-room", identity, { kind: "releaseRoom" })).result,
    );
  }
  async freezeReport(
    identity: RoomIdentity,
    expectedRevision: number,
    report: FrozenReport,
  ): Promise<"COMMITTED" | "RETRY"> {
    return decode(
      z.enum(["COMMITTED", "RETRY"]),
      (
        await this.run("mutate-room", identity, {
          kind: "freezeReport",
          expectedRevision,
          report: frozenReportSchema.parse(report),
        })
      ).result,
    );
  }
  async acknowledgeDurableReport(identity: RoomIdentity): Promise<void> {
    await this.run("mutate-room", identity, { kind: "acknowledgeDurableReport" });
  }
  async markFinalization(identity: RoomIdentity, status: FinalizeStatus) {
    return decode(
      z.number().int(),
      (
        await this.run("mutate-room", identity, {
          kind: "markFinalization",
          status: finalizeStatusSchema.parse(status),
        })
      ).revision,
    );
  }
}
