import { avatarSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { createHash } from "node:crypto";
import { GAME_TIMING, type GamePhase } from "@kabuki-neko/shared/constants/game";
import { answerSchemaForQuestion } from "@kabuki-neko/shared/schemas/question.schema";
import {
  finalizeStatusSchema,
  playerRoomSyncSchema,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { clientContracts } from "@kabuki-neko/shared/socket-events";
import { EXPIRABLE_TO_PODIUM, StateDomainError } from "./game-state.interface";
import type {
  ActiveRoomState,
  ActivePlayer,
  AdmitAnswerInput,
  ApplyCommandInput,
  BindPlayerInput,
  BindPlayerResult,
  CloseQuestionInput,
  ClosedQuestion,
  CommandAck,
  CommandResult,
  CommitQuestionInput,
  FriendlyTicket,
  FrozenReport,
  IGameStateStore,
  JoinReceipt,
  Lease,
  Principal,
  RoomIdentity,
  RoomProjector,
  StoredAnswer,
} from "./game-state.interface";
import {
  activeRoomStateSchema,
  activePlayerSchema,
  friendlyTicketSchema,
  frozenReportSchema,
  questionResultSchema,
  joinReceiptSchema,
} from "./private-state.schema";

type Pending = {
  input: ApplyCommandInput;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  promise: Promise<CommandResult>;
};
type Entry = {
  state: ActiveRoomState;
  expiresAt: number;
  durable: boolean;
  lease: Lease | null;
  epoch: number;
  receipts: Map<string, JoinReceipt>;
  pending: Map<string, Pending>;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: ConstructorParameters<typeof StateDomainError>[0]): never => {
  throw new StateDomainError(code);
};
const copy = <T>(value: T): T => structuredClone(value);

/** Single-process adapter. Every guard/write section is synchronous. The only
 * deferred operation is a host ACK waiting for the scoring worker's CAS commit. */
export class MemoryStateStore implements IGameStateStore {
  private readonly rooms = new Map<string, Entry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly project: RoomProjector,
    private readonly clock = Date.now,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 15 * 60_000);
    this.sweepTimer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    for (const entry of this.rooms.values()) this.rejectPending(entry);
    this.rooms.clear();
  }
  private rejectPending(entry: Entry): void {
    for (const pending of entry.pending.values())
      pending.reject(new StateDomainError("ROOM_EXPIRED"));
    entry.pending.clear();
  }
  private expired(entry: Entry, now: number): boolean {
    const s = entry.state;
    if (s.phase === "FINISHED") return now >= s.timing.phaseStartedAt + 3_600_000;
    return (
      now >= Math.min(entry.expiresAt, s.hardExpiresAt) ||
      (s.phase === "LOBBY" && now >= s.lobbyActiveAt + 7_200_000)
    );
  }
  private pinned(entry: Entry): boolean {
    return (
      entry.state.frozenReport !== null &&
      (!entry.durable || entry.state.finalization?.status !== "ready")
    );
  }
  sweep(): void {
    const now = this.clock();
    for (const [pin, entry] of this.rooms) {
      for (const [id, receipt] of entry.receipts)
        if (receipt.expiresAt <= now) entry.receipts.delete(id);
      for (const [id, ticket] of Object.entries(entry.state.tickets))
        if (ticket.expiresAt <= now) Reflect.deleteProperty(entry.state.tickets, id);
      if (this.expired(entry, now) && !this.pinned(entry)) {
        this.rejectPending(entry);
        this.rooms.delete(pin);
      }
    }
  }
  private lookup(identity: RoomIdentity): Entry | undefined {
    const entry = this.rooms.get(identity.pin);
    return entry?.state.sessionId === identity.sessionId ? entry : undefined;
  }
  private entry(identity: RoomIdentity, maintenance = false): Entry {
    const entry = this.lookup(identity);
    if (!entry) return fail("ROOM_NOT_FOUND");
    if (!maintenance && this.expired(entry, this.clock())) return fail("ROOM_EXPIRED");
    return entry;
  }
  private changed(s: ActiveRoomState, publicChange = true): void {
    s.revision++;
    if (publicChange) s.publicRevision = s.revision;
  }
  private player(s: ActiveRoomState, id: string, generation?: number): ActivePlayer {
    const player = s.players[id];
    if (!player) return fail("INVALID_SESSION_TOKEN");
    if (player.kickedAt !== null) return fail("PLAYER_KICKED");
    if (generation !== undefined && player.connectionGeneration !== generation)
      return fail("SESSION_REPLACED");
    return player;
  }
  async createRoom(
    pin: string,
    state: ActiveRoomState,
    ttlMs: number,
  ): Promise<"CREATED" | "EXISTS"> {
    // Only explicit conditional release/sweep can recycle a PIN.
    if (this.rooms.has(pin)) return "EXISTS";
    const parsed = activeRoomStateSchema.parse(state);
    if (pin !== parsed.pinCode || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      return fail("INVALID_FORMAT");
    this.rooms.set(pin, {
      state: parsed,
      expiresAt: this.clock() + ttlMs,
      durable: false,
      lease: null,
      epoch: 0,
      receipts: new Map(),
      pending: new Map(),
    });
    return "CREATED";
  }
  async getPrivateSnapshot(identity: RoomIdentity): Promise<ActiveRoomState | null> {
    const entry = this.lookup(identity);
    return entry ? copy(entry.state) : null;
  }
  /** Live state, no copy: a deep copy of a 200-player room cost seconds per game (TASK-185B). */
  async readPrivateSnapshot(identity: RoomIdentity): Promise<Readonly<ActiveRoomState> | null> {
    return this.lookup(identity)?.state ?? null;
  }
  async getRoleSnapshot(identity: RoomIdentity, principal: Principal) {
    const entry = this.lookup(identity);
    if (!entry || this.expired(entry, this.clock())) return null;
    if (principal.role === "host") {
      if (principal.hostId !== entry.state.hostId) return fail("FORBIDDEN");
    } else this.player(entry.state, principal.playerId, principal.generation);
    return copy(this.project(copy(entry.state), principal, this.clock()));
  }
  async reserveFriendlyTicket(identity: RoomIdentity, ticket: FriendlyTicket): Promise<void> {
    const s = this.entry(identity).state;
    const parsed = friendlyTicketSchema.parse(ticket);
    this.canJoin(s);
    const now = this.clock();
    if (parsed.consumed || parsed.expiresAt <= now || parsed.expiresAt > now + 120_000)
      return fail("NICKNAME_INVALID");
    if (
      Object.values(s.players).some((p) => p.nickname === parsed.nickname) ||
      Object.values(s.tickets).some(
        (t) =>
          t.socketId !== parsed.socketId && t.expiresAt > now && t.nickname === parsed.nickname,
      )
    )
      return fail("NICKNAME_TAKEN");
    for (const [key, existing] of Object.entries(s.tickets))
      if (existing.socketId === parsed.socketId || existing.expiresAt <= now)
        Reflect.deleteProperty(s.tickets, key);
    s.tickets[parsed.tokenHash] = parsed;
    this.changed(s, false);
  }
  private canJoin(s: ActiveRoomState): void {
    if (s.phase !== "LOBBY") return fail("GAME_IN_PROGRESS");
    if (s.isLocked) return fail("ROOM_LOCKED");
    if (Object.keys(s.players).length >= s.maxPlayers) return fail("ROOM_FULL");
  }
  async bindPlayer(input: BindPlayerInput): Promise<BindPlayerResult> {
    const entry = this.entry(input),
      original = entry.state,
      now = this.clock();
    // Stage projection too: a failed projection must not consume a ticket/slot.
    const s = copy(original);
    let player: ActivePlayer;
    let token: string | null = null;
    let receipt: JoinReceipt | undefined;
    if (input.binding.kind === "recover") {
      player = this.player(s, input.binding.playerId);
      if (player.tokenHash !== input.binding.tokenHash) return fail("INVALID_SESSION_TOKEN");
    } else {
      const prior = entry.receipts.get(input.requestId);
      if (prior && prior.expiresAt > now) {
        if (prior.payloadHash !== input.payloadHash) return fail("IDEMPOTENCY_CONFLICT");
        player = this.player(s, prior.playerId);
        token = prior.sessionToken;
      } else {
        this.canJoin(s);
        player = activePlayerSchema.parse(input.binding.player);
        if (
          s.players[player.id] ||
          Object.values(s.players).some((p) => p.nicknameKey === player.nicknameKey)
        )
          return fail("NICKNAME_TAKEN");
        if (s.friendlyNicknames) {
          const ticket = s.tickets[input.binding.friendlyTicketHash ?? ""];
          if (
            !ticket ||
            ticket.consumed ||
            ticket.expiresAt <= now ||
            ticket.socketId !== input.connectionId ||
            ticket.nickname !== player.nickname
          )
            return fail("NICKNAME_INVALID");
          ticket.consumed = true;
        }
        if (
          createHash("sha256").update(input.binding.sessionToken).digest("hex") !== player.tokenHash
        )
          return fail("INVALID_SESSION_TOKEN");
        token = input.binding.sessionToken;
        player = {
          ...player,
          joinedAt: now,
          joinOrder: Object.keys(s.players).length,
          kickedAt: null,
          connectionGeneration: 0,
          score: 0,
          streak: 0,
          maxStreak: 0,
          correctCount: 0,
          responseSumMs: 0,
          responseCount: 0,
          rank: null,
          previousRank: null,
        };
        s.players[player.id] = player;
        receipt = joinReceiptSchema.parse({
          requestId: input.requestId,
          payloadHash: input.payloadHash,
          playerId: player.id,
          sessionToken: token,
          expiresAt: now + 120_000,
        });
      }
    }
    player.connectionGeneration++;
    player.connectionId = input.connectionId;
    player.connected = true;
    player.lastSeenAt = now;
    if (s.phase === "LOBBY") s.lobbyActiveAt = now;
    this.changed(s);
    const snapshot = playerRoomSyncSchema.parse(
      this.project(
        copy(s),
        { role: "player", playerId: player.id, generation: player.connectionGeneration },
        now,
      ),
    );
    entry.state = s;
    if (receipt) entry.receipts.set(input.requestId, receipt);
    return { player: copy(player), token, generation: player.connectionGeneration, snapshot };
  }
  /** Atomic LOBBY avatar update for the bound connection; see the interface contract. */
  async updateAvatar(
    identity: RoomIdentity,
    playerId: string,
    generation: number,
    avatar: { style: string; seed: string },
  ): Promise<number> {
    const s = this.entry(identity).state;
    const parsed = avatarSchema.safeParse(avatar);
    if (!parsed.success) return fail("INVALID_FORMAT");
    const player = this.player(s, playerId, generation);
    if (s.phase !== "LOBBY") return fail("INVALID_PHASE");
    player.avatar = parsed.data;
    s.lobbyActiveAt = this.clock();
    this.changed(s);
    return s.revision;
  }
  async setPresence(
    identity: RoomIdentity,
    id: string,
    generation: number,
    connected: boolean,
  ): Promise<boolean> {
    const s = this.entry(identity).state;
    const p = s.players[id];
    if (!p || p.kickedAt !== null || p.connectionGeneration !== generation) return false;
    p.connected = connected;
    p.lastSeenAt = this.clock();
    if (!connected) p.connectionId = null;
    this.changed(s);
    return true;
  }
  async admitAnswer(input: AdmitAnswerInput): Promise<StoredAnswer> {
    const s = this.entry(input).state,
      now = this.clock();
    this.player(s, input.playerId, input.generation);
    const question = s.quiz.questions[input.questionIndex];
    if (!question || question.id !== input.questionId) return fail("QUESTION_MISMATCH");
    const parsed = answerSchemaForQuestion(question).safeParse(input.answer);
    if (!parsed.success) return fail("INVALID_ANSWER");
    const payloadHash = hash(parsed.data),
      key = `${input.questionIndex}:${input.playerId}`;
    const prior = s.answers[key];
    if (prior) {
      if (prior.submissionId === input.submissionId && prior.payloadHash === payloadHash)
        return copy(prior);
      return fail("ALREADY_ANSWERED");
    }
    if (s.questionIndex !== input.questionIndex) return fail("QUESTION_MISMATCH");
    if (s.phase !== "QUESTION_ANSWERING" || !s.accepting) return fail("INVALID_PHASE");
    if (s.timing.acceptanceClosesAt === null || now > s.timing.acceptanceClosesAt)
      return fail("TIME_EXPIRED");
    if (s.timing.questionStartedAt === null) return fail("INVALID_PHASE");
    const answer: StoredAnswer = {
      playerId: input.playerId,
      submissionId: input.submissionId,
      questionIndex: input.questionIndex,
      questionId: input.questionId,
      answer: parsed.data,
      payloadHash,
      receivedAt: now,
      responseTimeMs: Math.max(0, now - s.timing.questionStartedAt),
    };
    s.answers[key] = answer;
    if (!s.eligiblePlayerIds.includes(input.playerId)) s.eligiblePlayerIds.push(input.playerId);
    this.changed(s);
    if (
      s.requiredPlayerIds.length > 0 &&
      s.requiredPlayerIds.every((id) => s.answers[`${input.questionIndex}:${id}`])
    )
      this.freeze(s, "ALL_ANSWERED", now);
    return copy(answer);
  }
  private freeze(
    s: ActiveRoomState,
    reason: CloseQuestionInput["reason"],
    now: number,
  ): ClosedQuestion | "ALREADY_CLOSED" {
    if (s.questionIndex === null || s.phase !== "QUESTION_ANSWERING") return fail("INVALID_PHASE");
    if (s.closedQuestions[s.questionIndex]) return "ALREADY_CLOSED";
    const data = {
      questionIndex: s.questionIndex,
      phaseVersion: s.phaseVersion,
      closedAt: now,
      reason,
      requiredPlayerIds: copy(s.requiredPlayerIds),
      eligiblePlayerIds: copy(s.eligiblePlayerIds),
      answers: Object.values(s.answers)
        .filter((a) => a.questionIndex === s.questionIndex)
        .map(copy),
    };
    const closed = { ...data, hash: hash(data) };
    s.accepting = false;
    s.closedQuestions[s.questionIndex] = closed;
    this.changed(s, false);
    return copy(closed);
  }
  async closeQuestion(input: CloseQuestionInput): Promise<ClosedQuestion | "ALREADY_CLOSED"> {
    const s = this.entry(input, input.reason === "EXPIRED").state,
      now = this.clock();
    if (input.expectedPhaseVersion !== s.phaseVersion) return fail("STALE_PHASE");
    if (s.questionIndex !== null && s.closedQuestions[s.questionIndex]) return "ALREADY_CLOSED";
    if (
      input.reason === "TIMER" &&
      (s.timing.acceptanceClosesAt === null || now <= s.timing.acceptanceClosesAt)
    )
      return fail("TIME_EXPIRED");
    if (
      input.reason === "ALL_ANSWERED" &&
      (s.requiredPlayerIds.length === 0 ||
        !s.requiredPlayerIds.every((id) => s.answers[`${s.questionIndex}:${id}`]))
    )
      return fail("INVALID_PHASE");
    if (input.reason === "EXPIRED" && !this.expired(this.entry(input, true), now))
      return fail("INVALID_PHASE");
    return this.freeze(s, input.reason, now);
  }
  async commitQuestionResult(input: CommitQuestionInput): Promise<"COMMITTED" | "RETRY"> {
    const entry = this.entry(input, true),
      s = entry.state;
    const closed = s.questionIndex === null ? undefined : s.closedQuestions[s.questionIndex];
    if (
      !closed ||
      s.accepting ||
      s.phase !== "QUESTION_ANSWERING" ||
      s.revision !== input.expectedRevision ||
      closed.hash !== input.closedQuestionHash ||
      s.results[closed.questionIndex]
    )
      return "RETRY";
    const result = questionResultSchema.parse(input.result);
    if (
      result.questionIndex !== closed.questionIndex ||
      Object.keys(result.playerTotals).some((id) => !s.players[id]) ||
      Object.keys(s.players).some((id) => !result.playerTotals[id])
    )
      return fail("INVALID_REFERENCE");
    for (const [id, totals] of Object.entries(result.playerTotals))
      Object.assign(s.players[id] ?? fail("INVALID_REFERENCE"), totals);
    s.results[result.questionIndex] = result;
    const ended = closed.reason === "HOST_END" || closed.reason === "EXPIRED";
    if (ended) this.podium(s, closed.reason === "EXPIRED" ? "EXPIRED" : "HOST_ENDED");
    else this.phase(s, "ANSWER_REVEAL", this.clock(), null);
    for (const [id, pending] of entry.pending) {
      const response = this.finishCommand(s, pending.input);
      entry.pending.delete(id);
      pending.resolve(response);
    }
    return "COMMITTED";
  }
  private phase(s: ActiveRoomState, phase: GamePhase, now: number, duration: number | null): void {
    s.phase = phase;
    s.phaseVersion++;
    s.timing = {
      phaseStartedAt: now,
      phaseEndsAt: duration === null ? null : now + duration,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    };
    s.accepting = false;
    this.changed(s);
  }
  private podium(s: ActiveRoomState, reason: ActiveRoomState["endReason"]): void {
    this.phase(s, "PODIUM", this.clock(), GAME_TIMING.podiumMs);
    s.endReason = reason;
    s.finalization = {
      sessionId: s.sessionId,
      status: "pending",
      reportId: null,
      retryable: true,
      errorCode: null,
      updatedAt: this.clock(),
    };
  }
  private finishCommand(s: ActiveRoomState, input: ApplyCommandInput): CommandResult {
    let data: unknown = { phase: s.phase, phaseVersion: s.phaseVersion };
    if (input.command.event === "host:lock_room") data = { isLocked: s.isLocked };
    if (input.command.event === "host:kick_player")
      data = { kicked: true, playerId: input.command.request.playerId };
    if (input.command.event === "host:end_game")
      data = { phase: "PODIUM", phaseVersion: s.phaseVersion, finalization: s.finalization };
    const ack: CommandAck = clientContracts[input.command.event].ack.parse({
      ok: true,
      requestId: input.requestId,
      serverTime: this.clock(),
      data,
    });
    s.commands[input.requestId] = {
      actorId: input.hostId,
      payloadHash: input.payloadHash,
      ack,
      createdAt: this.clock(),
    };
    return { committed: true, revision: s.revision, phaseVersion: s.phaseVersion, ack: copy(ack) };
  }
  async applyCommand(input: ApplyCommandInput): Promise<CommandResult> {
    const entry = this.entry(input),
      s = entry.state,
      now = this.clock();
    if (s.hostId !== input.hostId) return fail("FORBIDDEN");
    const prior = s.commands[input.requestId];
    if (prior) {
      if (prior.payloadHash !== input.payloadHash || prior.actorId !== input.hostId)
        return fail("IDEMPOTENCY_CONFLICT");
      return {
        committed: false,
        revision: s.revision,
        phaseVersion: s.phaseVersion,
        ack: copy(prior.ack),
      };
    }
    const pending = entry.pending.get(input.requestId);
    if (pending) {
      if (pending.input.payloadHash !== input.payloadHash) return fail("IDEMPOTENCY_CONFLICT");
      return pending.promise.then((r) => ({ ...copy(r), committed: false }));
    }
    if (s.phaseVersion !== input.expectedPhaseVersion) return fail("STALE_PHASE");
    if (entry.pending.size > 0) return fail("OPERATION_PENDING");
    const command = input.command;
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
    switch (command.event) {
      case "host:lock_room":
        if (s.phase !== "LOBBY") return fail("INVALID_PHASE");
        s.isLocked = command.request.isLocked;
        this.changed(s);
        break;
      case "host:kick_player": {
        if (s.phase === "PODIUM" || s.phase === "FINISHED") return fail("INVALID_PHASE");
        const p = this.player(s, command.request.playerId);
        p.kickedAt = now;
        p.connected = false;
        p.connectionId = null;
        p.connectionGeneration++;
        if (
          !s.answers[`${s.questionIndex}:${p.id}`] &&
          (s.questionIndex === null || !s.closedQuestions[s.questionIndex])
        ) {
          s.requiredPlayerIds = s.requiredPlayerIds.filter((id) => id !== p.id);
          s.eligiblePlayerIds = s.eligiblePlayerIds.filter((id) => id !== p.id);
        }
        this.changed(s);
        if (
          s.phase === "QUESTION_ANSWERING" &&
          s.accepting &&
          s.requiredPlayerIds.length > 0 &&
          s.requiredPlayerIds.every((id) => s.answers[`${s.questionIndex}:${id}`])
        )
          this.freeze(s, "ALL_ANSWERED", now);
        break;
      }
      case "host:start_game":
        if (s.phase !== "LOBBY") return fail("INVALID_PHASE");
        if (!Object.values(s.players).some((p) => p.connected && p.kickedAt === null))
          return fail("NO_PLAYERS");
        s.isLocked = true;
        this.phase(s, "GAME_START_COUNTDOWN", now, GAME_TIMING.countdownMs);
        break;
      case "host:skip_timer":
      case "host:end_game":
        if (command.event === "host:skip_timer" && s.phase !== "QUESTION_ANSWERING")
          return fail("INVALID_PHASE");
        if (s.phase === "QUESTION_ANSWERING") {
          // If a natural close already won, let its worker commit before retrying end/skip.
          if (!s.accepting) return fail("OPERATION_PENDING");
          this.freeze(s, command.event === "host:end_game" ? "HOST_END" : "HOST_SKIP", now);
          let resolve: ((result: CommandResult) => void) | undefined;
          let reject: ((error: Error) => void) | undefined;
          const promise = new Promise<CommandResult>((done, failure) => {
            resolve = done;
            reject = failure;
          });
          if (!resolve || !reject) return fail("INTERNAL_ERROR");
          entry.pending.set(input.requestId, { input: copy(input), resolve, reject, promise });
          return promise;
        }
        if (s.phase !== "PODIUM" && s.phase !== "FINISHED") this.podium(s, "HOST_ENDED");
        break;
      case "host:next_step":
        if (s.phase === "ANSWER_REVEAL") {
          if (s.questionIndex === s.quiz.questions.length - 1) this.podium(s, "COMPLETED");
          else this.phase(s, "LEADERBOARD", now, null);
        } else if (s.phase === "LEADERBOARD" && s.questionIndex !== null) {
          s.questionIndex++;
          this.phase(s, "QUESTION_PREVIEW", now, GAME_TIMING.previewMs);
        } else return fail("INVALID_PHASE");
    }
    if (s.phase === "LOBBY") s.lobbyActiveAt = now;
    return this.finishCommand(s, input);
  }
  /** See IGameStateStore.expireToPodium (maintenance access: allowed after logical expiry). */
  async expireToPodium(identity: RoomIdentity, expectedPhaseVersion: number): Promise<boolean> {
    const s = this.entry(identity, true).state;
    if (s.phaseVersion !== expectedPhaseVersion) return false;
    if (!EXPIRABLE_TO_PODIUM.includes(s.phase) || this.clock() < s.hardExpiresAt)
      return fail("INVALID_PHASE");
    this.podium(s, "EXPIRED");
    return true;
  }
  async transitionPhase(
    identity: RoomIdentity,
    expected: number,
    phase: GamePhase,
    timing: ActiveRoomState["timing"],
    index: number | null,
  ): Promise<boolean> {
    const s = this.entry(identity).state,
      now = this.clock();
    if (s.phaseVersion !== expected) return false;
    const allowed =
      (s.phase === "GAME_START_COUNTDOWN" && phase === "QUESTION_PREVIEW" && index === 0) ||
      (s.phase === "QUESTION_PREVIEW" &&
        phase === "QUESTION_ANSWERING" &&
        index === s.questionIndex) ||
      (s.phase === "PODIUM" && phase === "FINISHED" && index === s.questionIndex);
    if (!allowed || s.timing.phaseEndsAt === null || now < s.timing.phaseEndsAt) return false;
    if (timing.phaseStartedAt !== now) return fail("INVALID_FORMAT");
    const question = index === null ? undefined : s.quiz.questions[index];
    const expectedTiming = {
      phaseStartedAt: now,
      phaseEndsAt:
        phase === "QUESTION_PREVIEW"
          ? now + GAME_TIMING.previewMs
          : phase === "QUESTION_ANSWERING" && question
            ? now + question.timeLimitSec * 1000
            : null,
      questionStartedAt: phase === "QUESTION_ANSWERING" ? now : null,
      inputClosesAt:
        phase === "QUESTION_ANSWERING" && question ? now + question.timeLimitSec * 1000 : null,
      acceptanceClosesAt:
        phase === "QUESTION_ANSWERING" && question
          ? now + question.timeLimitSec * 1000 + GAME_TIMING.graceMs
          : null,
    };
    if (
      Object.entries(expectedTiming).some(
        ([key, value]) => timing[key as keyof typeof timing] !== value,
      )
    )
      return fail("INVALID_FORMAT");
    s.phase = phase;
    s.phaseVersion++;
    s.questionIndex = index;
    s.timing = copy(timing);
    s.accepting = phase === "QUESTION_ANSWERING";
    if (s.accepting) {
      s.requiredPlayerIds = Object.values(s.players)
        .filter((p) => p.connected && p.kickedAt === null)
        .map((p) => p.id);
      s.eligiblePlayerIds = [...s.requiredPlayerIds];
    }
    this.changed(s);
    return true;
  }
  async acquireLease(
    identity: RoomIdentity,
    ownerId: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const e = this.entry(identity, true),
      now = this.clock();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return fail("INVALID_FORMAT");
    if (e.lease && e.lease.expiresAt > now) return null;
    e.lease = { ownerId, epoch: ++e.epoch, expiresAt: now + ttlMs };
    return copy(e.lease);
  }
  async renewLease(identity: RoomIdentity, lease: Lease, ttlMs: number): Promise<boolean> {
    const e = this.lookup(identity),
      now = this.clock();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return fail("INVALID_FORMAT");
    if (
      !e?.lease ||
      e.lease.ownerId !== lease.ownerId ||
      e.lease.epoch !== lease.epoch ||
      e.lease.expiresAt <= now
    )
      return false;
    e.lease.expiresAt = now + ttlMs;
    return true;
  }
  async releaseLease(identity: RoomIdentity, lease: Lease): Promise<boolean> {
    const e = this.lookup(identity);
    if (!e?.lease || e.lease.ownerId !== lease.ownerId || e.lease.epoch !== lease.epoch)
      return false;
    e.lease = null;
    return true;
  }
  async releaseRoom(identity: RoomIdentity): Promise<boolean> {
    const e = this.lookup(identity);
    if (!e || this.pinned(e)) return false;
    this.rejectPending(e);
    return this.rooms.delete(identity.pin);
  }
  async freezeReport(
    identity: RoomIdentity,
    expectedRevision: number,
    report: FrozenReport,
  ): Promise<"COMMITTED" | "RETRY"> {
    const e = this.entry(identity, true),
      s = e.state;
    if (s.revision !== expectedRevision || s.frozenReport) return "RETRY";
    if (s.phase !== "PODIUM" && s.phase !== "FINISHED") return fail("INVALID_PHASE");
    const parsed = frozenReportSchema.parse(report);
    if (
      parsed.session.id !== s.sessionId ||
      parsed.session.hostId !== s.hostId ||
      parsed.session.pinCode !== s.pinCode
    )
      return fail("INVALID_REFERENCE");
    s.frozenReport = parsed;
    this.changed(s, false);
    return "COMMITTED";
  }
  async acknowledgeDurableReport(identity: RoomIdentity): Promise<void> {
    const e = this.entry(identity, true);
    if (!e.state.frozenReport) return fail("INVALID_PHASE");
    e.durable = true;
  }
  async markFinalization(identity: RoomIdentity, status: FinalizeStatus): Promise<number> {
    const e = this.entry(identity, true),
      s = e.state;
    const parsed = finalizeStatusSchema.parse(status);
    if (parsed.sessionId !== s.sessionId) return fail("INVALID_REFERENCE");
    if (!s.frozenReport || (parsed.status === "ready" && !e.durable))
      return fail("FINALIZATION_PENDING");
    if (s.finalization?.status === "ready" && parsed.status !== "ready")
      return fail("INVALID_PHASE");
    s.finalization = parsed;
    this.changed(s);
    return s.revision;
  }
}
