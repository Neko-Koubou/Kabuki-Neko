/**
 * Scheduled retention for durable bookkeeping tables (code review MJ-01; SA §2.3, §4.1, §10.1):
 * - `audit_events` older than AUDIT_RETENTION_DAYS (via AuditService.purge);
 * - completed `request_dedup` receipts past their 24 h expiry (OperationsRepository.purge). This
 *   also removes receipts written before CR-01 changed how auth request hashes are computed;
 * - `refresh_tokens` that expired more than 24 h ago (AuthRepository.purgeExpired).
 * Every purge deletes at most 1000 rows per call. A run loops each purge while full batches come
 * back, within a time budget, so a backlog drains over a few runs without holding the database for
 * long. Runs start at boot and then every hour; the timer is unref'd and stopped on shutdown.
 * Failures never crash the process: they are written as one structured stderr line without
 * internals and retried on the next run.
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { AuthRepository, OperationsRepository } from "@kabuki-neko/database";
import { AuditService } from "./audit.service";

/** Rows each purge call deletes at most (repository contract). */
export const RETENTION_BATCH = 1000;
/** Interval between scheduled runs. */
export const RETENTION_INTERVAL_MS = 3_600_000;
/** Wall-clock budget of one run; remaining backlog waits for the next run. */
export const RETENTION_BUDGET_MS = 30_000;

/** One purge target: a name for diagnostics and a call that deletes one batch. */
interface Purger {
  readonly table: "audit_events" | "request_dedup" | "refresh_tokens";
  readonly purge: (now: number) => Promise<number>;
}

/** Deleted rows per table for one run. */
export type RetentionResult = Record<Purger["table"], number>;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<RetentionResult | undefined> | undefined;
  private readonly purgers: readonly Purger[];

  constructor(
    @Inject(AuditService) audit: AuditService,
    @Inject(OperationsRepository) operations: OperationsRepository,
    @Inject(AuthRepository) accounts: AuthRepository,
    private readonly clock: () => number = Date.now,
    private readonly output: (line: string) => void = (line) => {
      process.stderr.write(`${line}\n`);
    },
  ) {
    this.purgers = [
      { table: "audit_events", purge: () => audit.purge() },
      { table: "request_dedup", purge: (now) => operations.purge(now) },
      { table: "refresh_tokens", purge: (now) => accounts.purgeExpired(now) },
    ];
  }

  /**
   * Runs every purge in full batches until a batch comes back short or the budget is spent.
   * Returns the deleted counts; a failing purge is logged and the others still run.
   */
  async runOnce(budgetMs = RETENTION_BUDGET_MS): Promise<RetentionResult> {
    const started = this.clock();
    const result: RetentionResult = { audit_events: 0, request_dedup: 0, refresh_tokens: 0 };
    for (const purger of this.purgers) {
      try {
        for (;;) {
          const deleted = await purger.purge(this.clock());
          result[purger.table] += deleted;
          if (deleted < RETENTION_BATCH || this.clock() - started >= budgetMs) break;
        }
      } catch {
        this.output(
          JSON.stringify({ level: "error", event: "retention_purge_failed", table: purger.table }),
        );
      }
    }
    return result;
  }

  /** Starts the boot run and the hourly schedule (one run at a time). */
  onModuleInit(): void {
    const run = () => {
      if (this.pending) return;
      this.pending = this.runOnce().finally(() => {
        this.pending = undefined;
      });
    };
    run();
    this.timer = setInterval(run, RETENTION_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stops the schedule and waits for a run in progress. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
