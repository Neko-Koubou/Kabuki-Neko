import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { userPatchSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { AuditService } from "../../common/audit.service";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { RequireRoles, RolesGuard } from "../../common/guards/roles.guard";
import { RateLimitService } from "../../common/rate-limit.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";
import { UsersService } from "./users.service";
import { InvitationsService } from "./invitations.service";

const empty = new ZodValidationPipe(z.strictObject({}));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Audited administrative actions of this controller (SA §10.1; AC-20-01; code review MJ-02). */
type AdminAction = "user.role.change" | "user.status.change" | "invitation.create";
@Controller("users")
@UseGuards(JwtGuard, RolesGuard)
@RequireRoles("SUPERADMIN")
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  /**
   * Records one administrative audit event: SUCCESS, DENIED for a policy refusal (the last
   * SUPERADMIN cannot be demoted or deactivated) or FAILURE for any other error. Only IDs and the
   * error code are stored, never request bodies or invite codes.
   */
  private async record(
    principal: VerifiedPrincipal,
    response: Response,
    action: AdminAction,
    resourceId: string | null,
    error?: unknown,
  ) {
    const errorCode = error instanceof ApiError ? error.errorCode : error ? "INTERNAL_ERROR" : null;
    await this.audit.record({
      actorType: "USER",
      actorId: principal.user.id,
      action,
      resourceId: resourceId && UUID_V4.test(resourceId) ? resourceId : null,
      outcome: !error ? "SUCCESS" : errorCode === "LAST_SUPERADMIN" ? "DENIED" : "FAILURE",
      errorCode,
      correlationId: response.locals.correlationId,
    });
  }
  private async actor(request: Request) {
    const principal = this.jwt.principal(request);
    await this.limiter.consume("ADMIN", principal.user.id);
    return principal;
  }
  @Get()
  async list(@Req() request: Request) {
    return this.users.list(await this.actor(request), request.query);
  }
  @Get("invitations")
  async listInvitations(@Req() request: Request) {
    return this.invitations.list(await this.actor(request), request.query);
  }
  /** POST /users/invitations — audited as `invitation.create` (the invite code is never logged). */
  @Post("invitations")
  async createInvitation(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request);
    empty.transform(request.query);
    const result = await this.invitations.create(actor, body, request.get("idempotency-key") ?? "");
    await this.record(actor, response, "invitation.create", result.response.invitation.id);
    return result.response;
  }
  @Delete("invitations/:id")
  async revokeInvitation(@Req() request: Request, @Param("id") id: string) {
    const actor = await this.actor(request);
    empty.transform(request.query);
    return this.invitations.revoke(actor, id);
  }
  @Patch(":id")
  async patch(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request);
    empty.transform(request.query);
    const match = request.get("if-match")?.match(/^"([1-9][0-9]*)"$/u);
    if (!match?.[1] || !Number.isSafeInteger(Number(match[1])))
      throw new ApiError("VALIDATION_FAILED", 422);
    // A body that does not parse is rejected by the service before anything changes; a valid one
    // names the audited actions (role and/or status).
    const parsed = userPatchSchema.safeParse(body);
    const actions: AdminAction[] = parsed.success
      ? [
          ...(parsed.data.role !== undefined ? (["user.role.change"] as const) : []),
          ...(parsed.data.isActive !== undefined ? (["user.status.change"] as const) : []),
        ]
      : [];
    try {
      const user = await this.users.patch(actor, id, Number(match[1]), body);
      for (const action of actions) await this.record(actor, response, action, id);
      response.setHeader("ETag", `"${user.revision}"`);
      return user;
    } catch (error) {
      for (const action of actions) await this.record(actor, response, action, id, error);
      throw error;
    }
  }
}
