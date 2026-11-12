/**
 * Game state machine orchestration and host controls (SA §5.5, §6.1, §6.3).
 *
 * The state store owns every atomic guard (host binding, requestId dedup + payload hash,
 * expectedPhaseVersion CAS, answer admission, freeze). This service drives it:
 * - host commands are re-authorized against the current account on every call, hashed for dedup
 *   and, for skip/end during answering, completed by committing the frozen question's result;
 * - timed transitions (countdown → preview → answering, timer close, podium → finished) run in
 *   `tick`, always as phase CAS with the store's clock;
 * - a frozen question is scored deterministically (`computeQuestionResult`) by whichever caller
 *   gets there first and committed with a CAS on revision + closed-question hash, so a crash after
 *   freeze is recovered by the next `settle`/`tick` without double scoring;
 * - entering PODIUM freezes an immutable FrozenReport once and hands it to the finalization hook;
 *   `syncFinalization` lets the scheduler re-drive a frozen report whose status is not yet `ready`
 *   (failed enqueue, worker commit whose state update was lost) through a second typed callback.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { canonicalRequestHash } from "@kabuki-neko/database";
import { GAME_TIMING } from "@kabuki-neko/shared/constants/game";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import {
  GAME_STATE_STORE,
  StateDomainError,
  type ActiveRoomState,
  type CommandAck,
  type FrozenReport,
  type HostCommand,
  type IGameStateStore,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { stateError } from "./recovery.service";
import { computeQuestionResult, scoreAnswer } from "./score-calculator";

/** Optional injected clock; must match the state store's clock (tests use a fake one). */
export const GAME_CLOCK = Symbol("GAME_CLOCK");
/** Called once per room after its FrozenReport is stored (finalization queue hook). */
export type ReportHook = (identity: RoomIdentity, report: FrozenReport) => Promise<void>;
/**
 * Re-drives finalization for a frozen report that is not `ready` yet (scheduler recovery): the
 * implementation (report worker) re-enqueues it if needed and mirrors the durable job status.
 */
export type FinalizationSync = (
  identity: RoomIdentity,
  report: FrozenReport,
  current: ActiveRoomState["finalization"],
) => Promise<void>;
/** Socket binding of a player connection. */
export interface PlayerBinding extends RoomIdentity {
  playerId: string;
  generation: number;
}
/** Validated `player:submit_answer` fields. */
export interface SubmitRequest {
  questionIndex: number;
  questionId: string;
  submissionId: string;
  answer: number | number[] | string;
}

type Timing = ActiveRoomState["timing"];
/** Settle rounds of one room: the round in flight and the one round queued behind it. */
interface SettleSlot {
  running: Promise<boolean> | null;
  queued: Promise<boolean> | null;
}
type FrozenAnswer = FrozenReport["answers"][number];
/** Phases that freeze a report on entry. */
const FINAL = new Set<ActiveRoomState["phase"]>(["PODIUM", "FINISHED"]);

/** Hash of a request without its requestId (dedup compares payloads, not IDs). */
function payloadHash(request: object): string {
  const { requestId: _requestId, ...rest } = request as { requestId?: unknown };
  return canonicalRequestHash(JSON.parse(JSON.stringify(rest)));
}
/** Promise-based delay used while a delayed command waits for its result commit. */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Immutable FrozenReport from a final-phase room: every quiz question (PLAYED with its close
 * data or UNPLAYED), every player including kicked ones, and one answer row per eligible player
 * per played question. Kicked players who answered are re-scored with their previous streak, which
 * reproduces exactly the points already added to their totals.
 */
export function buildFrozenReport(state: Readonly<ActiveRoomState>, endedAt: number): FrozenReport {
  const answers: FrozenAnswer[] = [];
  const unanswered = new Map<string, number>();
  const questions = state.quiz.questions.map((snapshot, questionIndex) => {
    const closed = state.closedQuestions[String(questionIndex)];
    const result = state.results[String(questionIndex)];
    if (!closed || !result)
      return {
        questionIndex,
        sourceQuestionId: snapshot.id,
        snapshot,
        status: "UNPLAYED" as const,
        openedAt: null,
        closedAt: null,
        closeReason: null,
        eligiblePlayerIds: [],
      };
    const stored = new Map(closed.answers.map((answer) => [answer.playerId, answer]));
    const previous = state.results[String(questionIndex - 1)];
    for (const playerId of closed.eligiblePlayerIds) {
      const answer = stored.get(playerId);
      const personal =
        result.personal[playerId] ??
        scoreAnswer(
          snapshot,
          previous?.personal[playerId]?.currentStreak ?? 0,
          answer ? { answer: answer.answer, responseTimeMs: answer.responseTimeMs } : null,
          true,
        );
      const outcome = personal.result === "NOT_ELIGIBLE" ? "UNANSWERED" : personal.result;
      // Unanswered counts only scored opportunities: POLL and ×0 questions never count (SA §4.5;
      // code review MJ-07).
      if (outcome === "UNANSWERED" && snapshot.type !== "POLL" && snapshot.pointsMultiplier > 0)
        unanswered.set(playerId, (unanswered.get(playerId) ?? 0) + 1);
      answers.push({
        playerId,
        questionIndex,
        questionId: snapshot.id,
        submissionId: answer?.submissionId ?? null,
        submittedPayload: answer?.answer ?? null,
        result: outcome,
        isCorrect: outcome === "UNANSWERED" || outcome === "POLL" ? null : personal.isCorrect,
        accuracyNumerator: personal.accuracyNumerator,
        accuracyDenominator: personal.accuracyDenominator,
        responseTimeMs: answer?.responseTimeMs ?? null,
        receivedAt: answer?.receivedAt ?? null,
        pointsAwarded: personal.pointsAwarded,
        streakBonusAwarded: personal.streakBonus,
        currentStreak: personal.currentStreak,
      });
    }
    const first = closed.answers[0];
    return {
      questionIndex,
      sourceQuestionId: snapshot.id,
      snapshot,
      status: "PLAYED" as const,
      openedAt: first ? first.receivedAt - first.responseTimeMs : null,
      closedAt: closed.closedAt,
      closeReason: closed.reason,
      eligiblePlayerIds: closed.eligiblePlayerIds,
    };
  });
  const players = Object.values(state.players)
    .sort((a, b) => a.joinOrder - b.joinOrder)
    .map((player) => ({
      id: player.id,
      sessionId: state.sessionId,
      nickname: player.nickname,
      avatarStyle: player.avatar.style,
      avatarSeed: player.avatar.seed,
      joinOrder: player.joinOrder,
      isKicked: player.kickedAt !== null,
      finalScore: player.score,
      finalRank: player.kickedAt === null ? player.rank : null,
      correctCount: player.correctCount,
      unansweredCount: unanswered.get(player.id) ?? 0,
      maxStreak: player.maxStreak,
      avgResponseTimeMs:
        player.responseCount === 0 ? null : Math.round(player.responseSumMs / player.responseCount),
      joinedAt: player.joinedAt,
      kickedAt: player.kickedAt,
    }));
  const opened = questions.find((question) => question.openedAt !== null)?.openedAt ?? null;
  return {
    schemaVersion: 1,
    session: {
      id: state.sessionId,
      quizId: state.quiz.quizId,
      quizTitleSnapshot: state.quiz.title,
      quizRevision: state.quiz.revision,
      hostId: state.hostId,
      pinCode: state.pinCode,
      displayMode: state.displayMode,
      endReason: state.endReason ?? "COMPLETED",
      totalPlayers: players.length,
      totalQuestions: questions.length,
      playedQuestions: questions.filter((question) => question.status === "PLAYED").length,
      startedAt: opened,
      endedAt,
    },
    quiz: state.quiz,
    players,
    questions,
    answers,
  };
}

/** Why a room's state was dropped, as sent to clients in `room:expired`. */
export type RoomEndReason = "ROOM_EXPIRED" | "ROOM_LOST";

@Injectable()
export class GameService {
  private hook: ReportHook | null = null;
  private sync: FinalizationSync | null = null;
  private readonly clock: () => number;
  /** Per-room settle rounds (keyed by sessionId); see `settle`. Empty while no room settles. */
  private readonly settling = new Map<string, SettleSlot>();

  constructor(
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Optional() @Inject(GAME_CLOCK) clock: (() => number) | null = null,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Installs the finalization hook (typed callback, so there is no DI import cycle). */
  setReportHook(hook: ReportHook | null): void {
    this.hook = hook;
  }

  /** Installs the finalization recovery callback used by `syncFinalization` (typed, no DI cycle). */
  setFinalizationSync(sync: FinalizationSync | null): void {
    this.sync = sync;
  }

  /**
   * Scheduler recovery for a final room: when its report is frozen but the status is not `ready`,
   * hands it to the sync callback. Returns true when the callback ran.
   */
  async syncFinalization(identity: RoomIdentity): Promise<boolean> {
    if (!this.sync) return false;
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state || !FINAL.has(state.phase) || !state.frozenReport) return false;
    if (state.finalization?.status === "ready" || state.finalization?.status === "lost")
      return false;
    await this.sync(identity, state.frozenReport, state.finalization);
    return true;
  }

  /**
   * Executes a host command as the current host. lock/kick carry no expectedPhaseVersion, so the
   * current one is read and retried on a concurrent phase change; the store re-checks atomically.
   */
  async hostCommand(principal: VerifiedPrincipal, command: HostCommand): Promise<CommandAck> {
    const host = await this.jwt.current(principal);
    const identity = { pin: command.request.pinCode, sessionId: command.request.sessionId };
    const delayed = command.event === "host:skip_timer" || command.event === "host:end_game";
    for (let attempt = 0; ; attempt++) {
      let expected: number;
      if ("expectedPhaseVersion" in command.request)
        expected = command.request.expectedPhaseVersion;
      else {
        const current = await this.store.getPrivateSnapshot(identity);
        if (!current) stateError(new StateDomainError("ROOM_NOT_FOUND"));
        expected = current.phaseVersion;
      }
      try {
        const run = this.store.applyCommand({
          ...identity,
          hostId: host.id,
          requestId: command.request.requestId,
          payloadHash: payloadHash(command.request),
          expectedPhaseVersion: expected,
          command,
        });
        if (delayed) await this.completeDelayed(identity, run);
        const result = await run;
        if (command.event === "host:kick_player")
          await this.closeIfAllAnswered(identity).catch(() => false);
        await this.settle(identity).catch(() => false);
        await this.finalize(identity).catch(() => null);
        return result.ack;
      } catch (error) {
        const stale =
          !("expectedPhaseVersion" in command.request) &&
          error instanceof StateDomainError &&
          error.code === "STALE_PHASE";
        // A natural close (timer/all answered) won the race: commit it, then retry once so the
        // command observes the committed phase (usually STALE_PHASE for skip/end).
        const pending =
          delayed && error instanceof StateDomainError && error.code === "OPERATION_PENDING";
        if (pending) await this.settle(identity).catch(() => false);
        if (!(stale || pending) || attempt >= 2) stateError(error);
      }
    }
  }

  /**
   * Closes the open question with ALL_ANSWERED when every remaining required player has answered
   * (code review MJ-03). A kick removes an unanswered player from the required set; the memory
   * store freezes in the same step, the Redis script does not, so the close is driven here for
   * both (the store re-validates atomically; ALREADY_CLOSED or a lost race is harmless). Also
   * called from `tick`, so a crash between the kick and the close cannot leave everyone waiting
   * for the timer. Returns true when this call froze the question.
   */
  async closeIfAllAnswered(identity: RoomIdentity): Promise<boolean> {
    const state = await this.store.getPrivateSnapshot(identity);
    const index = state?.questionIndex ?? null;
    if (!state || index === null || state.phase !== "QUESTION_ANSWERING" || !state.accepting)
      return false;
    const required = state.requiredPlayerIds;
    if (required.length === 0 || !required.every((id) => state.answers[`${index}:${id}`]))
      return false;
    try {
      const closed = await this.store.closeQuestion({
        ...identity,
        expectedPhaseVersion: state.phaseVersion,
        reason: "ALL_ANSWERED",
      });
      return closed !== "ALREADY_CLOSED";
    } catch (error) {
      if (error instanceof StateDomainError) return false;
      throw error;
    }
  }

  /**
   * Called by the scheduler when a room's state is dropped (code review MJ-05): `reason` tells
   * connected clients why (`room:expired`), null when the room is released quietly after its
   * retention. The base service has no transport; NotifyingGameService forwards to the gateway.
   */
  async roomEnded(_identity: RoomIdentity, _reason: RoomEndReason | null): Promise<void> {
    // No transport attached.
  }

  /** Commits the frozen question while a skip/end command waits for it (bounded ~5 s). */
  private async completeDelayed(identity: RoomIdentity, run: Promise<unknown>) {
    let done = false;
    void run.then(
      () => (done = true),
      () => (done = true),
    );
    for (let attempt = 0; attempt < 250 && !done; attempt++) {
      await this.settle(identity).catch(() => false);
      if (!done) await sleep(20);
    }
  }

  /**
   * `player:submit_answer` — atomic admission, then scoring if this answer closed the question.
   * The settle is coalesced with the room's other admissions (see `settle`).
   */
  async submitAnswer(binding: PlayerBinding, request: SubmitRequest) {
    try {
      const stored = await this.store.admitAnswer({
        pin: binding.pin,
        sessionId: binding.sessionId,
        playerId: binding.playerId,
        generation: binding.generation,
        submissionId: request.submissionId,
        questionId: request.questionId,
        questionIndex: request.questionIndex,
        answer: request.answer,
      });
      await this.settle(binding).catch(() => false);
      return {
        accepted: true as const,
        submissionId: stored.submissionId,
        questionIndex: stored.questionIndex,
        receivedAt: stored.receivedAt,
      };
    } catch (error) {
      stateError(error);
    }
  }

  /**
   * Scores and commits a frozen-but-unscored question. Returns true when the round this caller
   * waited for committed. Safe to call from any worker at any time; CAS makes concurrent calls
   * commit at most once.
   *
   * Calls for one room are single-flight and coalesced: while a round runs, every new caller
   * shares one queued round that starts after it. A burst of N admitted answers therefore reads
   * the full private state at most twice per wave instead of N times (each read is a deep copy in
   * memory mode, a fetch and parse in Redis mode), and each caller still waits for a round that
   * started after its own admission, so the answer that closes the question is scored before its
   * ACK and the gateway publishes the reveal at once (QA follow-up TASK-183).
   */
  settle(identity: RoomIdentity): Promise<boolean> {
    const key = identity.sessionId;
    let slot = this.settling.get(key);
    if (!slot) {
      slot = { running: null, queued: null };
      this.settling.set(key, slot);
    }
    if (slot.queued) return slot.queued;
    if (!slot.running) return this.settleRound(key, slot, identity);
    const current = slot;
    const queued = slot.running
      .catch(() => false)
      .then(() => {
        current.queued = null;
        return this.settleRound(key, current, identity);
      });
    current.queued = queued;
    return queued;
  }

  /** Runs one settle round for a room and forgets the room's slot once nothing is pending. */
  private settleRound(key: string, slot: SettleSlot, identity: RoomIdentity): Promise<boolean> {
    const running = this.settleOnce(identity).finally(() => {
      slot.running = null;
      if (!slot.queued && this.settling.get(key) === slot) this.settling.delete(key);
    });
    slot.running = running;
    return running;
  }

  /** One settle round: scores and commits the frozen question if it is still unscored. */
  private async settleOnce(identity: RoomIdentity): Promise<boolean> {
    // Copy-free read (TASK-185D): everything taken from the live state (revision, hash and the
    // computed result) is read before the commit's await; the store validates and copies the
    // result, so it shares nothing with the state.
    const state = await this.store.readPrivateSnapshot(identity);
    const index = state?.questionIndex ?? null;
    if (!state || index === null || state.phase !== "QUESTION_ANSWERING" || state.accepting)
      return false;
    const closed = state.closedQuestions[String(index)];
    const question = state.quiz.questions[index];
    if (!closed || !question || state.results[String(index)]) return false;
    const result = computeQuestionResult({
      question,
      questionIndex: index,
      players: state.players,
      closed,
    });
    const outcome = await this.store.commitQuestionResult({
      ...identity,
      expectedRevision: state.revision,
      closedQuestionHash: closed.hash,
      result,
    });
    if (outcome === "COMMITTED") await this.finalize(identity).catch(() => null);
    return outcome === "COMMITTED";
  }

  /** Freezes the FrozenReport once in PODIUM/FINISHED and invokes the hook; retried by `tick`. */
  async finalize(identity: RoomIdentity): Promise<FrozenReport | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.store.getPrivateSnapshot(identity);
      if (!state || !FINAL.has(state.phase)) return null;
      if (state.frozenReport) return state.frozenReport;
      const endedAt =
        state.phase === "PODIUM"
          ? state.timing.phaseStartedAt
          : (state.timing.phaseStartedAt ?? this.clock());
      const report = buildFrozenReport(state, endedAt);
      if ((await this.store.freezeReport(identity, state.revision, report)) === "COMMITTED") {
        if (this.hook) await this.hook(identity, report);
        return report;
      }
    }
    return null;
  }

  /** CAS transition with the store's clock; retried if the store observed a different ms. */
  private async transition(
    identity: RoomIdentity,
    state: Readonly<ActiveRoomState>,
    phase: "QUESTION_PREVIEW" | "QUESTION_ANSWERING" | "FINISHED",
    index: number | null,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.clock();
      const limit = index === null ? 0 : (state.quiz.questions[index]?.timeLimitSec ?? 0) * 1000;
      const timing: Timing =
        phase === "QUESTION_PREVIEW"
          ? {
              phaseStartedAt: now,
              phaseEndsAt: now + GAME_TIMING.previewMs,
              questionStartedAt: null,
              inputClosesAt: null,
              acceptanceClosesAt: null,
            }
          : phase === "QUESTION_ANSWERING"
            ? {
                phaseStartedAt: now,
                phaseEndsAt: now + limit,
                questionStartedAt: now,
                inputClosesAt: now + limit,
                acceptanceClosesAt: now + limit + GAME_TIMING.graceMs,
              }
            : {
                phaseStartedAt: now,
                phaseEndsAt: null,
                questionStartedAt: null,
                inputClosesAt: null,
                acceptanceClosesAt: null,
              };
      try {
        return await this.store.transitionPhase(identity, state.phaseVersion, phase, timing, index);
      } catch (error) {
        if (!(error instanceof StateDomainError && error.code === "INVALID_FORMAT")) throw error;
      }
    }
    return false;
  }

  /**
   * Performs whatever timed step is due at `now`: countdown → preview(0), preview → answering,
   * timer close (strictly after acceptanceClosesAt) + scoring, crash recovery of an unscored
   * freeze, report freeze in PODIUM and PODIUM → FINISHED after 8 s. Every step is a CAS.
   */
  async tick(identity: RoomIdentity, now: number = this.clock()): Promise<void> {
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state) return;
    const due = state.timing.phaseEndsAt !== null && now >= state.timing.phaseEndsAt;
    switch (state.phase) {
      case "GAME_START_COUNTDOWN":
        if (due) await this.transition(identity, state, "QUESTION_PREVIEW", 0);
        return;
      case "QUESTION_PREVIEW":
        if (due) await this.transition(identity, state, "QUESTION_ANSWERING", state.questionIndex);
        return;
      case "QUESTION_ANSWERING": {
        await this.closeIfAllAnswered(identity);
        const closes = state.timing.acceptanceClosesAt;
        if (state.accepting && closes !== null && now > closes) {
          try {
            await this.store.closeQuestion({
              ...identity,
              expectedPhaseVersion: state.phaseVersion,
              reason: "TIMER",
            });
          } catch (error) {
            if (!(error instanceof StateDomainError)) throw error;
          }
        }
        await this.settle(identity);
        return;
      }
      case "PODIUM":
        await this.finalize(identity);
        if (due) await this.transition(identity, state, "FINISHED", state.questionIndex);
        return;
      case "FINISHED":
        await this.finalize(identity);
        return;
      default:
        return;
    }
  }
}
