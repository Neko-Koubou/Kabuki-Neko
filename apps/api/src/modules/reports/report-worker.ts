/**
 * Durable finalization queue worker and retry policy (SA §6.3, ADR-08).
 *
 * - Polls `finalization_jobs` and claims due jobs with the repository's conditional UPDATE (no
 *   SKIP LOCKED, so it works on SQLite, PostgreSQL and MySQL). A claim is a 30 s lease renewed every
 *   10 s; at most `FINALIZE_CONCURRENCY` (default 2) jobs run per process. A crashed worker's lease
 *   simply expires and another worker re-claims the job, so durable jobs survive process restarts.
 * - Each claimed job is written by `ReportFinalizer.persist` in one SQL transaction. Only after that
 *   commit is the room state marked `ready` (reportId = sessionId) and the host status listener
 *   called, so no report link is ever published before the history is readable.
 * - A failed write rolls back, the job becomes FAILED and is retried after 1/5/30/120/600 s; after
 *   five automated attempts it waits for `manualRetry`, which resets the attempts. A payload hash
 *   mismatch is an invariant violation: it is logged as an alert and never overwrites history.
 * - `sync` is the scheduler recovery callback: it re-enqueues a frozen report whose enqueue failed
 *   (idempotent by session ID) and mirrors the durable job's status into the room state. A pending
 *   in-memory frozen report is never discarded by the worker.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  JobsRepository,
  finalizationPayloadHash,
  type FinalizationJob,
} from "@kabuki-neko/database";
import { ZodError } from "zod";
import { FINALIZATION_LIMITS } from "@kabuki-neko/shared/constants/limits";
import type { ErrorCode } from "@kabuki-neko/shared/errors";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { ConfigService } from "../../config/config.service";
import {
  GAME_STATE_STORE,
  type ActiveRoomState,
  type FrozenReport,
  type IGameStateStore,
  type RoomIdentity,
} from "../../providers/state/game-state.interface";
import { frozenReportSchema } from "../../providers/state/private-state.schema";
import { GAME_CLOCK } from "../game-engine/game.service";
import { ReportFinalizer } from "./report-finalizer";

/** Interval between queue polls while the worker runs. */
export const REPORT_POLL_MS = 1_000;
/** Message used by the repositories for a payload hash mismatch (invariant violation). */
const HASH_MISMATCH = "Finalization payload hash mismatch";
/** Upper bound of memoized frozen-report hashes (one per final room awaiting a ready report). */
const MAX_MEMOIZED_HASHES = 10_000;

/** Called after a room's finalization status changed (host-only `report:status_changed`). */
export type ReportStatusListener = (
  identity: RoomIdentity | null,
  status: FinalizeStatus,
) => Promise<void>;

/** Outcome of one processed job. */
export type ProcessOutcome = "READY" | "FAILED" | "LEASE_LOST";

/** Room identity (PIN + session) recorded in a job's frozen payload, or null if unreadable. */
export function jobIdentity(job: Pick<FinalizationJob, "payload">): RoomIdentity | null {
  const parsed = frozenReportSchema.safeParse(job.payload);
  return parsed.success
    ? { pin: parsed.data.session.pinCode, sessionId: parsed.data.session.id }
    : null;
}

/** Finalization status mirrored from a durable job row. */
export function statusFromJob(
  job: Pick<FinalizationJob, "session_id" | "state" | "last_error_code">,
  now: number,
): FinalizeStatus {
  if (job.state === "READY")
    return {
      sessionId: job.session_id,
      status: "ready",
      reportId: job.session_id,
      retryable: false,
      errorCode: null,
      updatedAt: now,
    };
  const failed = job.state === "FAILED";
  return {
    sessionId: job.session_id,
    status: failed ? "failed" : "pending",
    reportId: null,
    retryable: true,
    errorCode: failed ? (job.last_error_code ?? "REPORT_SAVE_FAILED") : null,
    updatedAt: now,
  };
}

@Injectable()
export class ReportWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReportWorker.name);
  private readonly clock: () => number;
  private readonly concurrency: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  private listener: ReportStatusListener | null = null;
  /** sessionId → payload hash of its frozen report (see `reportHash`). */
  private readonly hashes = new Map<string, string>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private stopped = true;

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ReportFinalizer) private readonly finalizer: ReportFinalizer,
    @Inject(GAME_STATE_STORE) private readonly store: IGameStateStore,
    @Inject(ConfigService) config: ConfigService,
    @Optional() @Inject(GAME_CLOCK) clock: (() => number) | null = null,
  ) {
    this.clock = clock ?? Date.now;
    this.concurrency = config.values.FINALIZE_CONCURRENCY;
  }

  /** Installs the host status listener (typed callback, so the worker never imports the gateway). */
  setStatusListener(listener: ReportStatusListener | null): void {
    this.listener = listener;
  }

  /** Starts polling once the application is up; jobs left by a previous process are picked up. */
  onApplicationBootstrap(): void {
    this.start();
  }
  /** Stops polling and waits for running jobs (their leases are kept and expire if cut short). */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts the poll loop (idempotent). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.interval = setInterval(() => this.fill(), REPORT_POLL_MS);
    this.interval.unref();
    this.fill();
  }
  /** Stops the poll loop and waits for in-flight jobs. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.interval);
    this.interval = undefined;
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Starts one claim attempt per free slot (never more than the concurrency limit). An empty queue
   * frees its slot immediately; a finished job re-fills so a backlog drains without waiting.
   */
  private fill(): void {
    while (!this.stopped && this.inFlight.size < this.concurrency) {
      const run: Promise<unknown> = this.runOnce()
        .catch((error: unknown) => {
          this.logger.warn(`finalization poll failed: ${(error as Error).message}`);
          return null;
        })
        .finally(() => {
          this.inFlight.delete(run);
        });
      this.inFlight.add(run);
    }
  }

  /** Number of jobs currently being claimed or written by this process. */
  get active(): number {
    return this.inFlight.size;
  }

  /** Claims and processes one due job; null when nothing is due. */
  async runOnce(): Promise<ProcessOutcome | null> {
    const job = await this.jobs.claim(this.clock());
    if (!job) return null;
    const outcome = await this.process(job);
    // Keep draining a backlog once this slot is released (the `finally` above runs first).
    if (!this.stopped) setImmediate(() => this.fill());
    return outcome;
  }

  /**
   * Writes one claimed job under a renewed lease. The room status becomes `ready` only after the
   * history transaction committed; a failure records FAILED with the retry backoff.
   */
  async process(job: FinalizationJob): Promise<ProcessOutcome> {
    const owner = job.lease_owner;
    if (!owner) return "LEASE_LOST";
    let lost = false;
    const renewal = setInterval(() => {
      void this.jobs
        .renew(job.session_id, owner, this.clock())
        .then((renewed) => {
          if (!renewed) lost = true;
        })
        .catch(() => undefined);
    }, FINALIZATION_LIMITS.renewalMs);
    renewal.unref();
    const identity = jobIdentity(job);
    try {
      await this.finalizer.persist(job);
    } catch (error) {
      clearInterval(renewal);
      const message = error instanceof Error ? error.message : String(error);
      if (lost || message === "RESOURCE_BUSY") return "LEASE_LOST";
      const code: ErrorCode = message === HASH_MISMATCH ? "INTERNAL_ERROR" : "REPORT_SAVE_FAILED";
      if (code === "INTERNAL_ERROR")
        this.logger.error(`finalization invariant violated for session ${job.session_id}`);
      try {
        await this.jobs.fail(job.session_id, owner, code, this.clock());
      } catch {
        return "LEASE_LOST";
      }
      await this.publish(identity, {
        sessionId: job.session_id,
        status: "failed",
        reportId: null,
        retryable: true,
        errorCode: code,
        updatedAt: this.clock(),
      });
      return "FAILED";
    }
    clearInterval(renewal);
    // Committed: the report is readable, so the stable reportId may now be published.
    await this.publish(identity, statusFromJob({ ...job, state: "READY" }, this.clock()));
    return "READY";
  }

  /**
   * Mirrors a status into the room state (if it still exists) and notifies the listener. The state
   * is marked durable first, since a READY job proves the frozen report is safe in SQL.
   */
  private async publish(identity: RoomIdentity | null, status: FinalizeStatus): Promise<void> {
    if (identity) {
      if (status.status === "ready")
        await this.store.acknowledgeDurableReport(identity).catch(() => undefined);
      await this.store.markFinalization(identity, status).catch(() => 0);
    }
    await this.listener?.(identity, status).catch(() => undefined);
  }

  /**
   * Scheduler recovery (`GameService.setFinalizationSync`): makes sure the frozen report has a
   * durable job and mirrors that job's status into the room state. A database outage keeps the
   * frozen report in the state store as failed/retryable.
   *
   * Runs every few seconds per final room until the report is ready (code review MJ-13), so the
   * common path is light: when the session already has a job, only its status row is read (no
   * payload) and the frozen report is neither validated nor hashed again. That report is immutable
   * in the state store and was checked against the job's hash when the job was enqueued. Only a
   * session without a job pays for validation, canonical JSON and SHA-256 (idempotent enqueue).
   */
  async sync(
    identity: RoomIdentity,
    report: FrozenReport,
    current: ActiveRoomState["finalization"],
  ): Promise<FinalizeStatus> {
    if (report.session.id !== identity.sessionId || report.session.pinCode !== identity.pin)
      throw new Error("INVALID_REFERENCE");
    let job: Pick<FinalizationJob, "session_id" | "state" | "last_error_code"> | null;
    try {
      const existing = await this.jobs.statusOf(identity.sessionId);
      if (existing && existing.host_id !== report.session.hostId)
        throw new Error("INVALID_REFERENCE");
      job = existing;
      if (existing && existing.payload_hash !== this.reportHash(identity.sessionId, report))
        throw new Error(HASH_MISMATCH);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_REFERENCE") throw error;
      if (error instanceof Error && error.message === HASH_MISMATCH) {
        this.logger.error(`finalization invariant violated for session ${identity.sessionId}`);
        throw error;
      }
      if (error instanceof ZodError) throw error;
      return this.saveFailed(identity, current);
    }
    if (!job) {
      const parsed = frozenReportSchema.parse(report);
      try {
        const created = await this.jobs.enqueue(
          parsed.session.id,
          parsed.session.hostId,
          parsed as unknown as Record<string, unknown>,
          this.clock(),
        );
        this.hashes.set(identity.sessionId, created.payload_hash);
        job = created;
      } catch (error) {
        if (error instanceof Error && error.message === HASH_MISMATCH) {
          this.logger.error(`finalization invariant violated for session ${identity.sessionId}`);
          throw error;
        }
        return this.saveFailed(identity, current);
      }
    }
    await this.store.acknowledgeDurableReport(identity);
    const status = statusFromJob(job, this.clock());
    // A ready report is never synced again: drop its memoized hash.
    if (status.status === "ready") this.hashes.delete(identity.sessionId);
    if (
      current?.status !== status.status ||
      current.errorCode !== status.errorCode ||
      current.reportId !== status.reportId
    )
      await this.publish(identity, status);
    return status;
  }

  /**
   * SHA-256 of a frozen report as stored in its job's `payload_hash`, computed once per session
   * and process (validation + canonical JSON + hash of up to 64 MiB) and then reused by every
   * later sync (code review MJ-13). The frozen report never changes once stored. The memo is
   * dropped when the report is ready and is bounded.
   */
  private reportHash(sessionId: string, report: FrozenReport): string {
    const known = this.hashes.get(sessionId);
    if (known) return known;
    const hash = finalizationPayloadHash(
      frozenReportSchema.parse(report) as unknown as Record<string, unknown>,
    );
    if (this.hashes.size >= MAX_MEMOIZED_HASHES) this.hashes.clear();
    this.hashes.set(sessionId, hash);
    return hash;
  }

  /** Publishes (once) and returns the retryable REPORT_SAVE_FAILED status of a database outage. */
  private async saveFailed(
    identity: RoomIdentity,
    current: ActiveRoomState["finalization"],
  ): Promise<FinalizeStatus> {
    const failed: FinalizeStatus = {
      sessionId: identity.sessionId,
      status: "failed",
      reportId: null,
      retryable: true,
      errorCode: "REPORT_SAVE_FAILED",
      updatedAt: this.clock(),
    };
    if (current?.status !== "failed") await this.publish(identity, failed);
    return failed;
  }

  /**
   * Manual retry after the automated attempts are exhausted (or earlier): resets a FAILED job owned
   * by the host to PENDING with zero attempts. Returns the new status, or null if no FAILED job of
   * that host exists (the caller may then fall back to `sync` with a still-present frozen room).
   */
  async manualRetry(
    sessionId: string,
    hostId: string,
    identity: RoomIdentity | null,
  ): Promise<FinalizeStatus | null> {
    if (!(await this.jobs.manualRetry(sessionId, hostId, this.clock()))) return null;
    const status: FinalizeStatus = {
      sessionId,
      status: "pending",
      reportId: null,
      retryable: true,
      errorCode: null,
      updatedAt: this.clock(),
    };
    await this.publish(identity, status);
    if (!this.stopped) this.fill();
    return status;
  }
}
