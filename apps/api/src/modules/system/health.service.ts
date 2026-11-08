/**
 * Dependency health (SA §4.4 GET /system/health, §6.4 cache rules).
 *
 * Database, storage and state are probed in parallel (at most three at once), each bounded by a
 * 2 s timeout. A dependency that answers with a failure is `down`; a probe that cannot complete in
 * time is `unknown` — never an invented up/down. Results carry only enum states, the actual check
 * time and a safe error code: no URLs, credentials or exception text. The snapshot is cached for
 * 5 s and concurrent callers share one in-flight check.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CACHE_LIMITS } from "@kabuki-neko/shared/constants/limits";
import type { ErrorCode } from "@kabuki-neko/shared/errors";
import { healthSchema, type Health } from "@kabuki-neko/shared/schemas/system.schema";
import { ConfigService } from "../../config/config.service";
import { StateConnections } from "../../providers/state/state.module";
import { StorageRegistry } from "../../providers/storage/storage-registry";

/** One dependency's state as exposed publicly. */
export type HealthPart = Health["db"];
/** Tunables, injectable for tests; production uses the SA limits. */
export interface HealthOptions {
  probeTimeoutMs?: number;
  cacheMs?: number;
  parallelProbes?: number;
}
/** Injection token for optional health tunables. */
export const HEALTH_OPTIONS = Symbol("HEALTH_OPTIONS");

/** Sentinel distinguishing a timed-out probe from a failed one. */
const TIMEOUT = Symbol("timeout");

/** Runs async tasks with at most `limit` in flight, preserving result order. */
export async function limitConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

@Injectable()
export class HealthService {
  private readonly probeTimeoutMs: number;
  private readonly cacheMs: number;
  private readonly parallel: number;
  private cached: { health: Health; at: number } | undefined;
  private inflight: Promise<Health> | undefined;

  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(StorageRegistry) private readonly storage: StorageRegistry,
    @Inject(StateConnections) private readonly state: StateConnections,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject(HEALTH_OPTIONS) options: HealthOptions | null = null,
  ) {
    this.probeTimeoutMs = options?.probeTimeoutMs ?? CACHE_LIMITS.probeTimeoutMs;
    this.cacheMs = options?.cacheMs ?? CACHE_LIMITS.healthMs;
    this.parallel = options?.parallelProbes ?? CACHE_LIMITS.parallelProbes;
  }

  /**
   * Runs one probe under the timeout. `probe` resolves to the dependency's own verdict (`up` or
   * `down`/`unknown` from adapters that report it); a rejection is `down`, a timeout `unknown`.
   */
  private async part(
    probe: () => Promise<Pick<HealthPart, "status" | "errorCode">>,
    failure: ErrorCode,
  ): Promise<HealthPart> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        probe().then(
          (result) => result,
          () => ({ status: "down" as const, errorCode: failure }),
        ),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), this.probeTimeoutMs);
          timer.unref();
        }),
      ]);
      if (outcome === TIMEOUT)
        return { status: "unknown", checkedAt: Date.now(), errorCode: failure };
      return {
        status: outcome.status,
        checkedAt: Date.now(),
        errorCode: outcome.status === "up" ? null : (outcome.errorCode ?? failure),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Database: a trivial parameterless query on the pooled connection. */
  private async probeDb(): Promise<Pick<HealthPart, "status" | "errorCode">> {
    await this.db.query("SELECT 1");
    return { status: "up", errorCode: null };
  }
  /** Storage: the active origin adapter's own health check (already redacted). */
  private async probeStorage(): Promise<Pick<HealthPart, "status" | "errorCode">> {
    const result = await this.storage.active.checkHealth();
    return { status: result.status, errorCode: result.errorCode };
  }
  /** State: memory is in-process; Redis must answer PING on the command connection. */
  private async probeState(): Promise<Pick<HealthPart, "status" | "errorCode">> {
    if (this.config.values.STATE_DRIVER === "memory") return { status: "up", errorCode: null };
    if (!this.state.command) return { status: "down", errorCode: "STATE_UNAVAILABLE" };
    await this.state.command.ping();
    return { status: "up", errorCode: null };
  }

  /** Performs a fresh check of all dependencies and assembles the redacted snapshot. */
  private async compute(): Promise<Health> {
    const [db, storage, state] = await limitConcurrency(
      [
        () => this.part(() => this.probeDb(), "DEPENDENCY_UNAVAILABLE"),
        () => this.part(() => this.probeStorage(), "STORAGE_UNAVAILABLE"),
        () => this.part(() => this.probeState(), "STATE_UNAVAILABLE"),
      ],
      this.parallel,
    );
    if (!db || !storage || !state) throw new Error("Health probe missing");
    const env = this.config.values;
    return healthSchema.parse({
      app: "Kabuki Neko",
      status: [db, storage, state].every((item) => item.status === "up") ? "ok" : "degraded",
      dbDriver: env.DB_DRIVER,
      storageDriver: env.STORAGE_DRIVER,
      stateDriver: env.STATE_DRIVER,
      storageHealth: storage.status,
      checkedAt: Math.max(db.checkedAt, storage.checkedAt, state.checkedAt),
      db,
      storage,
      state,
    });
  }

  /** Cached (5 s) health snapshot; concurrent callers share one in-flight check. */
  async check(): Promise<Health> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.health;
    this.inflight ??= this.compute()
      .then((health) => {
        this.cached = { health, at: Date.now() };
        return health;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Drops the cached snapshot (e.g. after a configuration change). */
  invalidate(): void {
    this.cached = undefined;
  }
}
