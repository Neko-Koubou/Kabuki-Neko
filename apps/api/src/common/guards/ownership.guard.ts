import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { QuizzesRepository, ReportsRepository } from "@kabuki-neko/database";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { JwtGuard, type VerifiedPrincipal } from "./jwt.guard";
import { ApiError } from "../error.filter";

interface OwnershipPolicy {
  kind: "quiz" | "report";
  action: "read" | "write";
  parameter?: string;
}
const ownershipKey = Symbol("resource-ownership");
export const RequireOwnership = (policy: OwnershipPolicy) => SetMetadata(ownershipKey, policy);
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(QuizzesRepository) private readonly quizzes: QuizzesRepository,
    @Inject(ReportsRepository) private readonly reports: ReportsRepository,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  private id(id: string) {
    if (!uuidSchema.safeParse(id).success) throw new ApiError("VALIDATION_FAILED", 422);
  }
  private async boundary<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error) {
        if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
        if (error.message === "FINALIZATION_PENDING")
          throw new ApiError("FINALIZATION_PENDING", 409);
        if (error.message === "REPORT_SAVE_FAILED") throw new ApiError("REPORT_SAVE_FAILED", 503);
      }
      throw error;
    }
  }
  async quiz(
    principal: VerifiedPrincipal,
    id: string,
    action: "read" | "write",
  ): ReturnType<QuizzesRepository["read"]> {
    this.id(id);
    const user = await this.jwt.current(principal);
    const resource = await this.boundary(() => this.quizzes.read(user.id, id));
    if (action === "write" && resource.row.creator_id !== user.id)
      throw new ApiError("FORBIDDEN", 403);
    return resource;
  }
  async report(principal: VerifiedPrincipal, id: string): ReturnType<ReportsRepository["session"]> {
    this.id(id);
    const user = await this.jwt.current(principal);
    return this.boundary(() => this.reports.session(user.id, id));
  }
  /** hostId comes from private server room state, never the command body/playerId. */
  async host(principal: VerifiedPrincipal, hostId: string) {
    const user = await this.jwt.current(principal);
    if (user.id !== hostId) throw new ApiError("NOT_FOUND", 404);
    return user;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<OwnershipPolicy>(ownershipKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw new ApiError("INTERNAL_ERROR", 500);
    const request = context.switchToHttp().getRequest<Request>(),
      principal = this.jwt.principal(request);
    const id = request.params[policy.parameter ?? "id"];
    if (typeof id !== "string") throw new ApiError("VALIDATION_FAILED", 422);
    if (policy.kind === "quiz") await this.quiz(principal, id, policy.action);
    else await this.report(principal, id);
    return true;
  }
}
