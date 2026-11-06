import { Inject, Injectable, Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Request } from "express";
import { AuditRepository, UsersRepository, QuizzesRepository } from "@kabuki-neko/database";
import { DatabaseModule } from "../providers/database/database.module";
import { StateModule, StateConnections } from "../providers/state/state.module";
import { ConfigService } from "../config/config.service";
import { RefreshService } from "../modules/auth/refresh.service";
import { JwtGuard } from "./guards/jwt.guard";
import { RolesGuard } from "./guards/roles.guard";
import { OwnershipGuard } from "./guards/ownership.guard";
import { OriginGuard, rateLimiter } from "./guards/origin.guard";
import { IdempotencyService } from "./idempotency.service";
import { OperationsAccess, OperationsController } from "./operations.controller";
import { RateLimitService } from "./rate-limit.service";
import { MetricsService } from "./metrics.service";
import { AuditService } from "./audit.service";
import { ApiError } from "./error.filter";

@Injectable()
class SqlOperationsAccess extends OperationsAccess {
  constructor(
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(QuizzesRepository) private readonly quizzes: QuizzesRepository,
    @Inject(DataSource) private readonly database: DataSource,
  ) {
    super();
  }
  async authenticate(request: Request) {
    const token = request.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    if (!token) throw new ApiError("AUTH_REQUIRED", 401);
    const principal = await this.jwt.authenticate(token);
    await this.limiter.consume("READ", principal.user.id);
    return principal.user.id;
  }
  async authorize(actor: string, operation: string, id: string | null) {
    const user = await this.users.current(actor);
    if (!user?.is_active) throw new ApiError("TOKEN_REVOKED", 401);
    if (operation === "cleanup") {
      if (user.role !== "SUPERADMIN") throw new ApiError("FORBIDDEN", 403);
      return;
    }
    // A reservation may not yet have a resource; the receipt itself is actor-scoped.
    if (id === null) return;
    if (["quiz.create", "quiz.duplicate", "quiz.import"].includes(operation)) {
      try {
        await this.quizzes.read(actor, id);
        return;
      } catch (error) {
        if (error instanceof Error && error.message === "NOT_FOUND")
          throw new ApiError("NOT_FOUND", 404);
        throw error;
      }
    }
    let exists = false;
    if (operation === "media.upload")
      exists = await this.database
        .getRepository("media_assets")
        .existsBy({ id, uploader_id: actor });
    if (operation === "room.create")
      exists = await this.database
        .getRepository("room_allocations")
        .existsBy({ id, host_id: actor });
    if (operation === "report.retry")
      exists =
        (await this.database.getRepository("game_sessions").existsBy({ id, host_id: actor })) ||
        (await this.database
          .getRepository("finalization_jobs")
          .existsBy({ session_id: id, host_id: actor }));
    if (!exists) throw new ApiError("NOT_FOUND", 404);
  }
}
const services = [RefreshService, JwtGuard, RolesGuard, OwnershipGuard, IdempotencyService];
@Module({
  imports: [DatabaseModule, StateModule],
  controllers: [OperationsController],
  providers: [
    ...services,
    {
      provide: RateLimitService,
      inject: [ConfigService, StateConnections],
      useFactory: rateLimiter,
    },
    {
      provide: OriginGuard,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new OriginGuard(config.get("CORS_ORIGIN")),
    },
    { provide: MetricsService, useFactory: () => new MetricsService() },
    {
      provide: AuditService,
      inject: [AuditRepository, MetricsService, ConfigService],
      useFactory: (repository: AuditRepository, metrics: MetricsService, config: ConfigService) =>
        new AuditService(repository, metrics, config.get("AUDIT_RETENTION_DAYS")),
    },
    { provide: OperationsAccess, useClass: SqlOperationsAccess },
  ],
  exports: [...services, RateLimitService, OriginGuard, AuditService, MetricsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class CommonModule {}
