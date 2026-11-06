import type { OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { z } from "zod";
import type { AuditRepository } from "@kabuki-neko/database";
import { errorCodeSchema } from "@kabuki-neko/shared/errors";
import { ApiError } from "./error.filter";
import { MetricsService } from "./metrics.service";

export const AUDIT_ACTIONS = [
  "setup",
  "auth.login.failure",
  "auth.logout",
  "auth.refresh.reuse",
  "user.role.change",
  "user.status.change",
  "registration.policy.change",
  "settings.update",
  "invitation.create",
  "room.create",
  "room.kick",
  "room.lock",
  "room.end",
  "room.release.lost",
  "quiz.import",
  "quiz.export",
  "quiz.create",
  "quiz.update",
  "quiz.delete",
  "quiz.duplicate",
  "media.upload",
  "media.delete",
  "report.finalize",
  "report.retry",
  "report.export",
  "cleanup",
] as const;
const uuid = z.uuidv4().regex(/^[a-f0-9-]+$/u);
// Projection strips arbitrary input fields rather than recursively logging and redacting.
const eventSchema = z.object({
  actorType: z.enum(["USER", "GUEST", "SYSTEM", "ANONYMOUS"]),
  actorId: uuid.nullable(),
  action: z.enum(AUDIT_ACTIONS),
  resourceId: z.union([uuid, z.literal("global")]).nullable(),
  outcome: z.enum(["SUCCESS", "DENIED", "FAILURE"]),
  correlationId: uuid,
  errorCode: errorCodeSchema.nullish(),
});
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly repository: AuditRepository,
    private readonly metrics: MetricsService,
    private readonly retentionDays = 30,
    private readonly output: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365)
      throw new Error("Invalid audit retention");
  }
  async record(input: unknown): Promise<void> {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 422);
    const event = { ...parsed.data, errorCode: parsed.data.errorCode ?? null };
    const now = this.clock();
    try {
      this.output(
        JSON.stringify({ type: "audit", occurredAt: new Date(now).toISOString(), ...event }),
      );
      await this.repository.append(event, now);
    } catch {
      this.metrics.increment("audit_failures", "DEPENDENCY_UNAVAILABLE");
      throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    }
  }
  async purge(): Promise<number> {
    try {
      return await this.repository.purge(this.clock(), this.retentionDays);
    } catch {
      this.metrics.increment("audit_failures", "DEPENDENCY_UNAVAILABLE");
      throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    }
  }
  onModuleInit(): void {
    const run = () => {
      if (this.pending) return;
      this.pending = this.purge()
        .then(
          () => undefined,
          () => {
            this.output(
              JSON.stringify({
                level: "error",
                event: "audit_purge_failed",
                errorCode: "DEPENDENCY_UNAVAILABLE",
              }),
            );
          },
        )
        .finally(() => {
          this.pending = undefined;
        });
    };
    run();
    this.timer = setInterval(run, 86400000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
