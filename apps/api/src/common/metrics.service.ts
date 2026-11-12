import { errorCodeSchema, type ErrorCode } from "@kabuki-neko/shared/errors";

const COUNTERS = [
  "room_count",
  "answers_admitted",
  "answers_rejected",
  "command_cas_retries",
  "report_queue_failures",
  "storage_failures",
  "locale_load_failures",
  "audit_failures",
  "finalization_pending_alarms",
] as const;
const DURATIONS = [
  "state_store_duration_ms",
  "broadcast_latency_ms",
  "report_queue_age_ms",
] as const;
type Counter = (typeof COUNTERS)[number];
type Duration = (typeof DURATIONS)[number];
const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 1000, 5000, 60000] as const;
interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}
/** Metric dimensions are closed enums, never IDs, locale names, URLs or user input. */
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<Duration, Histogram>();
  private lastAlarm = -Infinity;
  constructor(
    private readonly output: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly clock: () => number = Date.now,
  ) {}
  increment(name: Counter, code?: ErrorCode): void {
    if (
      !COUNTERS.includes(name) ||
      (code !== undefined && !errorCodeSchema.safeParse(code).success)
    )
      throw new Error("Invalid metric dimension");
    const key = code === undefined ? name : `${name}:${code}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  observe(name: Duration, milliseconds: number): void {
    if (!DURATIONS.includes(name) || !Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Invalid metric observation");
    const histogram = this.durations.get(name) ?? {
      count: 0,
      sum: 0,
      buckets: BOUNDS.map(() => 0),
    };
    histogram.count++;
    histogram.sum += milliseconds;
    BOUNDS.forEach((bound, i) => {
      if (milliseconds <= bound) histogram.buckets[i] = (histogram.buckets[i] ?? 0) + 1;
    });
    this.durations.set(name, histogram);
  }
  reportJobFailed(code: ErrorCode): void {
    this.increment("report_queue_failures", code);
    const now = this.clock();
    if (now - this.lastAlarm >= 60000) {
      this.lastAlarm = now;
      this.output(
        JSON.stringify({
          level: "error",
          event: "report_queue_failed",
          occurredAt: new Date(now).toISOString(),
          errorCode: code,
        }),
      );
    }
  }
  /**
   * A frozen report still not durable 24 h after its game (code review MJ-16): counted and written
   * as one structured error event for log-based alerting. The session ID stays in the scheduler's
   * own log line; metric dimensions never carry IDs.
   */
  finalizationPendingAlarm(): void {
    this.increment("finalization_pending_alarms");
    this.output(
      JSON.stringify({
        level: "error",
        event: "finalization_pending_alarm",
        occurredAt: new Date(this.clock()).toISOString(),
        errorCode: "FINALIZATION_PENDING",
      }),
    );
  }
  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries(
        [...this.durations].map(([name, value]) => [
          name,
          { count: value.count, sum: value.sum, bounds: [...BOUNDS], buckets: [...value.buckets] },
        ]),
      ),
    };
  }
}
