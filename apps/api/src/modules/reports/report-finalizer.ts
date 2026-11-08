/**
 * Report finalization: freeze-to-queue and the history writer (SA §6.3, ADR-08).
 *
 * - `enqueue` validates the immutable FrozenReport (schema, cross references and the 64 MiB cap),
 *   upserts the durable `finalization_jobs` row keyed by the stable session ID (same payload →
 *   idempotent, different payload → refused, never overwritten) and only then marks the room's
 *   frozen state durable. If the database is unavailable the frozen state is kept and the host
 *   sees `failed` / retryable with `reportId = null`; a later call retries the enqueue.
 * - `persist` writes one claimed job in a single SQL transaction (session, question snapshots,
 *   players, answers, job READY) through `ReportsRepository.persist`, which derives deterministic
 *   UUIDv5 history IDs, nulls source quiz/question references deleted meanwhile (under locks) and
 *   rolls back everything on any failure. A READY job with the same payload is idempotent.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  JobsRepository,
  ReportsRepository,
  type FinalizationJob,
  type ReportBatch,
} from "@kabuki-neko/database";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { ApiError } from "../../common/error.filter";
import {
  GAME_STATE_STORE,
  type FrozenReport,
  type IGameStateStore,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { frozenReportSchema } from "../../providers/state/private-state.schema";
import { GAME_CLOCK } from "../game-engine/game.service";

/** Maps a validated FrozenReport onto the history tables' records (snake_case, no socket data). */
export function projectReport(payload: unknown): ReportBatch {
  const report = frozenReportSchema.parse(payload);
  const session = report.session;
  return {
    session: {
      id: session.id,
      host_id: session.hostId,
      quiz_id: session.quizId,
      quiz_title_snapshot: session.quizTitleSnapshot,
      quiz_revision: session.quizRevision,
      pin_code: session.pinCode,
      display_mode: session.displayMode,
      end_reason: session.endReason,
      total_players: session.totalPlayers,
      total_questions: session.totalQuestions,
      played_questions: session.playedQuestions,
      started_at: session.startedAt,
      ended_at: session.endedAt,
      created_at: session.endedAt,
      schema_version: 1,
      snapshot: report.quiz,
    },
    questions: report.questions.map((question) => ({
      source_question_id: question.sourceQuestionId,
      question_index: question.questionIndex,
      snapshot: question.snapshot,
      status: question.status,
      opened_at: question.openedAt,
      closed_at: question.closedAt,
      close_reason: question.closeReason,
      eligible_player_ids: question.eligiblePlayerIds,
    })),
    players: report.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      avatar_style: player.avatarStyle,
      avatar_seed: player.avatarSeed,
      join_order: player.joinOrder,
      is_kicked: player.isKicked,
      final_score: player.finalScore,
      final_rank: player.finalRank,
      correct_count: player.correctCount,
      unanswered_count: player.unansweredCount,
      max_streak: player.maxStreak,
      avg_response_time_ms: player.avgResponseTimeMs,
      joined_at: player.joinedAt,
      kicked_at: player.kickedAt,
    })),
    answers: report.answers.map((answer) => ({
      player_id: answer.playerId,
      question_id: answer.questionId,
      question_index: answer.questionIndex,
      submission_id: answer.submissionId,
      submitted_payload: answer.submittedPayload,
      result: answer.result,
      is_correct: answer.isCorrect,
      accuracy_numerator: answer.accuracyNumerator,
      accuracy_denominator: answer.accuracyDenominator,
      response_time_ms: answer.responseTimeMs,
      received_at: answer.receivedAt,
      points_awarded: answer.pointsAwarded,
      streak_bonus_awarded: answer.streakBonusAwarded,
      current_streak: answer.currentStreak,
    })),
  };
}

@Injectable()
export class ReportFinalizer {
  private readonly clock: () => number;

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ReportsRepository) private readonly reports: ReportsRepository,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Optional() @Inject(GAME_CLOCK) clock: (() => number) | null = null,
  ) {
    this.clock = clock ?? Date.now;
  }

  /** Finalization status record for a room. */
  private status(
    sessionId: string,
    status: FinalizeStatus["status"],
    errorCode: FinalizeStatus["errorCode"] = null,
  ): FinalizeStatus {
    return {
      sessionId,
      status,
      reportId: status === "ready" ? sessionId : null,
      retryable: status === "failed",
      errorCode,
      updatedAt: this.clock(),
    };
  }

  /**
   * Freeze-to-queue: durable job first, then the state is marked durable. On a database failure
   * the frozen report stays in the state store and the host sees failed/retryable.
   */
  async enqueue(identity: RoomIdentity, report: FrozenReport): Promise<FinalizeStatus> {
    const parsed = frozenReportSchema.parse(report);
    if (parsed.session.id !== identity.sessionId || parsed.session.pinCode !== identity.pin)
      throw new ApiError("INVALID_REFERENCE", 422);
    try {
      await this.jobs.enqueue(
        parsed.session.id,
        parsed.session.hostId,
        parsed as unknown as Record<string, unknown>,
        this.clock(),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Finalization payload hash mismatch")
        throw error;
      const failed = this.status(identity.sessionId, "failed", "REPORT_SAVE_FAILED");
      await this.store.markFinalization(identity, failed).catch(() => 0);
      return failed;
    }
    await this.store.acknowledgeDurableReport(identity);
    const pending = this.status(identity.sessionId, "pending");
    await this.store.markFinalization(identity, pending).catch(() => 0);
    return pending;
  }

  /** Writes one claimed job's history atomically; returns the stable reportId (= sessionId). */
  persist(
    job: Pick<FinalizationJob, "session_id" | "lease_owner" | "payload_hash">,
  ): Promise<string> {
    if (!job.lease_owner) throw new ApiError("RESOURCE_BUSY", 409);
    return this.reports.persist(
      job.session_id,
      job.lease_owner,
      job.payload_hash,
      this.clock(),
      projectReport,
    );
  }
}
