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
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RequireRoles, RolesGuard } from "../../common/guards/roles.guard";
import { RateLimitService } from "../../common/rate-limit.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";
import { UsersService } from "./users.service";
import { InvitationsService } from "./invitations.service";

const empty = new ZodValidationPipe(z.strictObject({}));
@Controller("users")
@UseGuards(JwtGuard, RolesGuard)
@RequireRoles("SUPERADMIN")
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
  ) {}
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
  @Post("invitations")
  async createInvitation(@Req() request: Request, @Body() body: unknown) {
    const actor = await this.actor(request);
    empty.transform(request.query);
    return (await this.invitations.create(actor, body, request.get("idempotency-key") ?? ""))
      .response;
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
    const user = await this.users.patch(actor, id, Number(match[1]), body);
    response.setHeader("ETag", `"${user.revision}"`);
    return user;
  }
}
