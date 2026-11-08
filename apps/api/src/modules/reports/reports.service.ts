/**
 * Report reading, analytics, status/retry and CSV export (SA §4.5, §6.3, §7; US-14).
 *
 * Analytics ("weighted-success-scored-opportunities-v1"):
 * - An opportunity is one stored answer row (eligible player, frozen before any kick) on a PLAYED
 *   question that is not POLL and has `pointsMultiplier > 0`. CORRECT counts 1, PARTIAL C/K,
 *   INCORRECT/UNANSWERED 0; accuracy = Σ credit / opportunities, and `value = null` (never 0) when
 *   there is no opportunity. The same rule gives player, question and session accuracy.
 * - Question counts cover every type: accepted = submitted answers, unanswered = eligible −
 *   accepted, correct/partial/incorrect for non-POLL; option counts per authoring option for
 *   choice/poll questions (UNPLAYED questions report zeros).
 * - Hardest questions: at most 5 PLAYED questions with a non-zero denominator, by lowest accuracy
 *   (exact cross-product comparison), then larger denominator, then question index.
 * - Answer rows: NOT_PLAYED, NOT_ELIGIBLE, ANSWERED or UNANSWERED with base points = awarded − bonus.
 *
 * Access: every read goes through the repository gate (current active host only, even for the
 * source quiz owner or a SUPERADMIN): unknown/foreign → 404, pending → 409 FINALIZATION_PENDING,
 * failed → 503 REPORT_SAVE_FAILED. Status and retry are answered from the history, the durable
 * job, or the still-present frozen room; a lost room reports `lost` / not retryable.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AuditRepository,
  ReportsRepository,
  RuntimeRepository,
  UsersRepository,
  type Allocation,
  type ReportAnswerRow,
  type ReportPlayerRow,
  type ReportQuestionRow,
  type ReportSessionRow,
} from "@kabuki-neko/database";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import type { Question } from "@kabuki-neko/shared/schemas/question.schema";
import {
  answerReportsPageSchema,
  fullReportSchema,
  playerReportsPageSchema,
  reportPlayersQuerySchema,
  sessionsPageSchema,
  type AnswerReport,
  type Metric,
  type PlayerReport,
  type QuestionReport,
  type SessionFullReport,
  type SessionSummary,
} from "@kabuki-neko/shared/schemas/report.schema";
import { ApiError } from "../../common/error.filter";
import {
  GAME_STATE_STORE,
  type IGameStateStore,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { privateQuestionSnapshotSchema } from "../../providers/state/private-state.schema";
import { GAME_CLOCK } from "../game-engine/game.service";
import { reportCsv, reportCsvFilename, type CsvPlayer } from "./report-csv";
import { ReportWorker } from "./report-worker";

/** Accuracy definition identifier exposed with every full report. */
export const ACCURACY_DEFINITION = "weighted-success-scored-opportunities-v1" as const;
/** Size of the players page embedded in the full report. */
const DETAIL_PLAYERS = 20;
/** Maximum number of hardest questions. */
const HARDEST = 5;
/** Question types whose answers select options (option counts are reported). */
const CHOICE = new Set<Question["type"]>([
  "SINGLE_CHOICE",
  "TRUE_FALSE",
  "MULTIPLE_SELECT",
  "POLL",
]);

/** Question snapshot as stored in history: the authoring question plus its public mapping. */
type StoredQuestion = Question & { publicToPrivateOptionIds: string[] };
/** Running credit/opportunity sums of a metric. */
interface Tally {
  numerator: number;
  denominator: number;
}

/** Metric from a tally: value is null without opportunities (never 0). */
export function metric(tally: Tally): Metric {
  return {
    numerator: tally.numerator,
    denominator: tally.denominator,
    value: tally.denominator === 0 ? null : tally.numerator / tally.denominator,
  };
}
/** Parses a stored question snapshot back to its authoring question and option mapping. */
export function storedQuestion(snapshot: unknown): StoredQuestion {
  const {
    publicOptions: _public,
    mediaSnapshot: _media,
    ...rest
  } = privateQuestionSnapshotSchema.parse(snapshot);
  return rest;
}
/** True when answers to the question are scored opportunities (non-POLL, multiplier > 0). */
export function isScored(question: Pick<Question, "type" | "pointsMultiplier">): boolean {
  return question.type !== "POLL" && question.pointsMultiplier > 0;
}
/** Credit of one answer row: CORRECT 1, PARTIAL C/K, everything else 0. */
function credit(
  answer: Pick<ReportAnswerRow, "result" | "accuracy_numerator" | "accuracy_denominator">,
) {
  if (answer.result !== "CORRECT" && answer.result !== "PARTIAL") return 0;
  return answer.accuracy_denominator === 0
    ? 0
    : answer.accuracy_numerator / answer.accuracy_denominator;
}

/** Per-question analytics from its stored row and the answers of its eligible players. */
export function questionReport(
  row: Pick<ReportQuestionRow, "question_index" | "snapshot" | "status" | "eligible_player_ids">,
  answers: readonly ReportAnswerRow[],
): QuestionReport & { scoredTally: Tally } {
  const question = storedQuestion(row.snapshot);
  const played = row.status === "PLAYED";
  const eligible = new Set(played ? row.eligible_player_ids : []);
  const own = answers.filter(
    (a) => a.question_index === row.question_index && eligible.has(a.player_id),
  );
  const accepted = own.filter((a) => a.submitted_payload !== null);
  const choiceCounts = new Map(question.options.map((option) => [option.id, 0]));
  if (CHOICE.has(question.type))
    for (const answer of accepted) {
      const payload = answer.submitted_payload;
      const indexes = Array.isArray(payload) ? payload : [payload];
      for (const index of new Set(indexes)) {
        const id = typeof index === "number" ? question.publicToPrivateOptionIds[index] : undefined;
        if (id !== undefined && choiceCounts.has(id))
          choiceCounts.set(id, (choiceCounts.get(id) ?? 0) + 1);
      }
    }
  const poll = question.type === "POLL";
  const count = (result: string) => (poll ? 0 : accepted.filter((a) => a.result === result).length);
  const scoredTally: Tally =
    played && isScored(question)
      ? { numerator: own.reduce((sum, a) => sum + credit(a), 0), denominator: eligible.size }
      : { numerator: 0, denominator: 0 };
  const { publicToPrivateOptionIds: _mapping, ...authoring } = question;
  return {
    questionIndex: row.question_index,
    question: authoring as Question,
    status: row.status,
    eligibleCount: eligible.size,
    acceptedCount: accepted.length,
    correctCount: count("CORRECT"),
    partialCount: count("PARTIAL"),
    incorrectCount: count("INCORRECT"),
    unansweredCount: eligible.size - accepted.length,
    accuracy: metric(scoredTally),
    optionCounts: CHOICE.has(question.type)
      ? question.options.map((option) => ({
          optionId: option.id,
          count: choiceCounts.get(option.id) ?? 0,
        }))
      : [],
    scoredTally,
  };
}

/**
 * Hardest question indexes: PLAYED with denominator > 0, lowest accuracy first (compared with
 * cross products, no float rounding), then larger denominator, then lower index; at most 5.
 */
export function hardestQuestions(questions: readonly QuestionReport[]): number[] {
  return questions
    .filter((q) => q.status === "PLAYED" && q.accuracy.denominator > 0)
    .sort(
      (a, b) =>
        a.accuracy.numerator * b.accuracy.denominator -
          b.accuracy.numerator * a.accuracy.denominator ||
        b.accuracy.denominator - a.accuracy.denominator ||
        a.questionIndex - b.questionIndex,
    )
    .slice(0, HARDEST)
    .map((q) => q.questionIndex);
}

/** Accuracy tally of each player over scored opportunities of PLAYED questions. */
export function playerTallies(
  questions: readonly Pick<ReportQuestionRow, "question_index" | "snapshot" | "status">[],
  answers: readonly ReportAnswerRow[],
): Map<string, Tally> {
  const scored = new Set(
    questions
      .filter((q) => q.status === "PLAYED" && isScored(storedQuestion(q.snapshot)))
      .map((q) => q.question_index),
  );
  const tallies = new Map<string, Tally>();
  for (const answer of answers) {
    if (!scored.has(answer.question_index)) continue;
    const tally = tallies.get(answer.player_id) ?? { numerator: 0, denominator: 0 };
    tally.numerator += credit(answer);
    tally.denominator += 1;
    tallies.set(answer.player_id, tally);
  }
  return tallies;
}

/** Public player report from a stored player and their accuracy tally. */
export function playerReport(row: ReportPlayerRow, tally: Tally | undefined): PlayerReport {
  return {
    id: row.id,
    nickname: row.nickname,
    avatar: { style: row.avatar_style, seed: row.avatar_seed } as PlayerReport["avatar"],
    isKicked: row.is_kicked,
    finalScore: row.final_score,
    finalRank: row.is_kicked ? null : row.final_rank,
    correctCount: row.correct_count,
    unansweredCount: row.unanswered_count,
    maxStreak: row.max_streak,
    avgResponseTimeMs: row.avg_response_time_ms,
    accuracy: metric(tally ?? { numerator: 0, denominator: 0 }),
  };
}

/** One player's answer row for a question (NOT_PLAYED / NOT_ELIGIBLE / ANSWERED / UNANSWERED). */
export function answerReport(
  question: Pick<ReportQuestionRow, "question_index" | "status" | "snapshot">,
  answer: ReportAnswerRow | null,
): AnswerReport {
  const none = {
    questionIndex: question.question_index,
    submittedPayload: null,
    result: null,
    isCorrect: null,
    accuracyNumerator: 0 as const,
    accuracyDenominator: 0 as const,
    responseTimeMs: null,
    pointsAwarded: 0 as const,
    streakBonus: 0 as const,
    basePoints: 0 as const,
  };
  if (question.status !== "PLAYED") return { ...none, status: "NOT_PLAYED" };
  if (!answer) return { ...none, status: "NOT_ELIGIBLE" };
  const poll = storedQuestion(question.snapshot).type === "POLL" || answer.result === "POLL";
  const denominator = poll ? 0 : answer.accuracy_denominator;
  if (answer.submitted_payload === null)
    return {
      ...none,
      status: "UNANSWERED",
      result: answer.result === "POLL" ? "POLL" : "UNANSWERED",
      accuracyDenominator: denominator,
    };
  return {
    status: "ANSWERED",
    questionIndex: question.question_index,
    submittedPayload: answer.submitted_payload,
    result: answer.result as "CORRECT" | "PARTIAL" | "INCORRECT" | "POLL",
    isCorrect: poll ? null : answer.is_correct,
    accuracyNumerator: poll ? 0 : answer.accuracy_numerator,
    accuracyDenominator: denominator,
    responseTimeMs: answer.response_time_ms ?? 0,
    pointsAwarded: answer.points_awarded,
    streakBonus: answer.streak_bonus_awarded,
    basePoints: answer.points_awarded - answer.streak_bonus_awarded,
  };
}

/** Public session summary of a stored history session. */
export function sessionSummary(row: ReportSessionRow): SessionSummary {
  return {
    id: row.id,
    quizId: row.quiz_id,
    quizTitle: row.quiz_title_snapshot,
    hostId: row.host_id,
    pinCode: row.pin_code,
    displayMode: row.display_mode,
    endReason: row.end_reason,
    totalPlayers: row.total_players,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: "ready",
  };
}

/** CSV download: fixed filename and the fully prepared chunk stream. */
export interface CsvDownload {
  filename: string;
  chunks: Iterable<string>;
}

@Injectable()
export class ReportsService {
  private readonly clock: () => number;

  constructor(
    @Inject(ReportsRepository) private readonly reports: ReportsRepository,
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(ReportWorker) private readonly worker: ReportWorker,
    @Optional() @Inject(GAME_CLOCK) clock: (() => number) | null = null,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Maps repository gate errors to API errors (404 hidden, 409 pending, 503 failed). */
  private async gate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError || !(error instanceof Error)) throw error;
      if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
      if (error.message === "FINALIZATION_PENDING") throw new ApiError("FINALIZATION_PENDING", 409);
      if (error.message === "REPORT_SAVE_FAILED") throw new ApiError("REPORT_SAVE_FAILED", 503);
      throw error;
    }
  }

  /** Ready reports of the current host (`GET /reports`). */
  list(hostId: string, query: unknown) {
    return this.gate(async () => {
      const page = await this.reports.list(hostId, query);
      return sessionsPageSchema.parse({ items: page.items.map(sessionSummary), meta: page.meta });
    });
  }

  /** Full report: session, all question analytics, hardest questions and the first player page. */
  detail(hostId: string, sessionId: string): Promise<SessionFullReport> {
    return this.gate(async () => {
      const session = await this.reports.session(hostId, sessionId);
      const [questions, answers, players] = await Promise.all([
        this.reports.questions(hostId, sessionId),
        this.reports.allAnswers(hostId, sessionId),
        this.reports.players(hostId, sessionId, { page: 1, limit: DETAIL_PLAYERS }),
      ]);
      const analytics = questions.map((q) => questionReport(q, answers));
      const overall = analytics.reduce<Tally>(
        (sum, q) => ({
          numerator: sum.numerator + q.scoredTally.numerator,
          denominator: sum.denominator + q.scoredTally.denominator,
        }),
        { numerator: 0, denominator: 0 },
      );
      const reports = analytics.map(({ scoredTally: _tally, ...report }) => report);
      const tallies = playerTallies(questions, answers);
      return fullReportSchema.parse({
        session: sessionSummary(session),
        totalQuestions: session.total_questions,
        playedQuestions: session.played_questions,
        accuracy: metric(overall),
        accuracyDefinition: ACCURACY_DEFINITION,
        questions: reports,
        hardestQuestionIndexes: hardestQuestions(reports),
        players: {
          items: players.items.map((p) => playerReport(p, tallies.get(p.id))),
          meta: players.meta,
        },
        displayTimezone: "UTC",
        snapshotVersion: 1,
      });
    });
  }

  /** Player page (rank order, optional nickname search) with per-player accuracy. */
  players(hostId: string, sessionId: string, query: unknown) {
    return this.gate(async () => {
      const parsed = reportPlayersQuerySchema.parse(query);
      const [page, questions, answers] = await Promise.all([
        this.reports.players(hostId, sessionId, parsed),
        this.reports.questions(hostId, sessionId),
        this.reports.allAnswers(hostId, sessionId),
      ]);
      const tallies = playerTallies(questions, answers);
      return playerReportsPageSchema.parse({
        items: page.items.map((p) => playerReport(p, tallies.get(p.id))),
        meta: page.meta,
      });
    });
  }

  /** One player's answers, one row per question in question order (404 for a foreign player). */
  answers(hostId: string, sessionId: string, playerId: string, query: unknown) {
    return this.gate(async () => {
      const page = await this.reports.answerPage(hostId, sessionId, playerId, query);
      return answerReportsPageSchema.parse({
        items: page.items.map((item) => answerReport(item.question, item.answer)),
        meta: page.meta,
      });
    });
  }

  /** CSV export: every row is computed before streaming starts (no partial file on error). */
  exportCsv(hostId: string, sessionId: string): Promise<CsvDownload> {
    return this.gate(async () => {
      const session = await this.reports.session(hostId, sessionId);
      const [questions, answers, players] = await Promise.all([
        this.reports.questions(hostId, sessionId),
        this.reports.allAnswers(hostId, sessionId),
        this.reports.allPlayers(hostId, sessionId),
      ]);
      const tallies = playerTallies(questions, answers);
      const rows: CsvPlayer[] = players.map((p) => playerReport(p, tallies.get(p.id)));
      const csvSession = {
        id: session.id,
        quizTitle: session.quiz_title_snapshot,
        pinCode: session.pin_code,
        endReason: session.end_reason,
        startedAt: session.started_at,
        endedAt: session.ended_at,
      };
      return { filename: reportCsvFilename(session.id), chunks: [...reportCsv(csvSession, rows)] };
    });
  }

  /** Allocation of a session owned by an active host, or null. */
  private async allocation(hostId: string, sessionId: string): Promise<Allocation | null> {
    const [row, host] = await Promise.all([
      this.runtime.find(sessionId),
      this.users.current(hostId),
    ]);
    if (!row || row.host_id !== hostId || !host?.is_active) return null;
    return row;
  }
  /** Lost status (the room disappeared before its report became durable). */
  private lost(sessionId: string): FinalizeStatus {
    return {
      sessionId,
      status: "lost",
      reportId: null,
      retryable: false,
      errorCode: null,
      updatedAt: this.clock(),
    };
  }
  /** Status from the repository gate outcome of a session (ready / pending / failed), or null. */
  private async durableStatus(hostId: string, sessionId: string): Promise<FinalizeStatus | null> {
    const base = { sessionId, updatedAt: this.clock() };
    try {
      await this.reports.session(hostId, sessionId);
      return { ...base, status: "ready", reportId: sessionId, retryable: false, errorCode: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "FINALIZATION_PENDING")
        return { ...base, status: "pending", reportId: null, retryable: true, errorCode: null };
      if (message === "REPORT_SAVE_FAILED")
        return {
          ...base,
          status: "failed",
          reportId: null,
          retryable: true,
          errorCode: "REPORT_SAVE_FAILED",
        };
      if (message === "NOT_FOUND") return null;
      throw error;
    }
  }

  /**
   * Finalization status (`GET /reports/:id/status`): history READY, else the durable job, else the
   * frozen room's status, else `lost` for a lost room or an audited loss; otherwise 404.
   */
  async status(hostId: string, sessionId: string): Promise<FinalizeStatus> {
    const durable = await this.durableStatus(hostId, sessionId);
    if (durable) return durable;
    const row = await this.allocation(hostId, sessionId);
    if (row?.status === "LOST") return this.lost(sessionId);
    if (row) {
      const state = await this.store.getPrivateSnapshot({ pin: row.pin_code, sessionId });
      if (state?.finalization) return state.finalization;
      throw new ApiError("NOT_FOUND", 404);
    }
    const host = await this.users.current(hostId);
    if (host?.is_active && (await this.audit.loss(hostId, sessionId, this.clock())))
      return this.lost(sessionId);
    throw new ApiError("NOT_FOUND", 404);
  }

  /**
   * Retry (`POST /reports/:id/retry-finalize`): already READY → ready; queued/running → 409
   * FINALIZATION_PENDING; FAILED job → manual retry (attempts reset); no job but a frozen room →
   * re-enqueue (503 REPORT_SAVE_FAILED while storage is down); lost → lost / not retryable.
   */
  async retry(hostId: string, sessionId: string): Promise<FinalizeStatus> {
    const durable = await this.durableStatus(hostId, sessionId);
    if (durable?.status === "ready") return durable;
    if (durable?.status === "pending") throw new ApiError("FINALIZATION_PENDING", 409);
    const row = await this.allocation(hostId, sessionId);
    const identity: RoomIdentity | null = row ? { pin: row.pin_code, sessionId } : null;
    if (durable?.status === "failed") {
      const retried = await this.worker.manualRetry(sessionId, hostId, identity);
      if (retried) return retried;
      throw new ApiError("FINALIZATION_PENDING", 409);
    }
    if (row?.status === "LOST") return this.lost(sessionId);
    if (!identity) {
      const host = await this.users.current(hostId);
      if (host?.is_active && (await this.audit.loss(hostId, sessionId, this.clock())))
        return this.lost(sessionId);
      throw new ApiError("NOT_FOUND", 404);
    }
    const state = await this.store.getPrivateSnapshot(identity);
    if (!state?.frozenReport) {
      if (state) throw new ApiError("NOT_FOUND", 404);
      throw new ApiError("REPORT_SAVE_FAILED", 503);
    }
    const status = await this.worker.sync(identity, state.frozenReport, state.finalization);
    if (status.status === "failed" && status.errorCode === "REPORT_SAVE_FAILED")
      throw new ApiError("REPORT_SAVE_FAILED", 503);
    return status;
  }
}
