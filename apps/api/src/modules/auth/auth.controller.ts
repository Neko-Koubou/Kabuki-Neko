import { Controller, Get, Post, HttpCode, Inject, Req, Res, Body, UseGuards } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { z } from "zod";
import type { Request, Response } from "express";
import { loginRequestSchema } from "@kabuki-neko/shared/schemas/auth.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ConfigService } from "../../config/config.service";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RateLimitService } from "../../common/rate-limit.service";
import { AuditService } from "../../common/audit.service";
import { ApiError } from "../../common/error.filter";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { SetupService } from "./setup.service";
import {
  RefreshService,
  refreshCookieOptions,
  userDto,
  type IssuedSession,
} from "./refresh.service";

const empty = new ZodValidationPipe(z.strictObject({}));
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SetupService) private readonly setup: SetupService,
    @Inject(RefreshService) private readonly refresh: RefreshService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  private query(request: Request) {
    empty.transform(request.query);
  }
  private key(request: Request) {
    return new ZodValidationPipe(uuidSchema).transform(request.get("idempotency-key"));
  }
  private ip(response: Response): string {
    const value: unknown = response.locals.clientIp;
    if (typeof value !== "string") throw new ApiError("INTERNAL_ERROR", 500);
    return value;
  }
  private cookie(request: Request): string | undefined {
    const cookies: unknown = request.cookies;
    if (typeof cookies !== "object" || cookies === null || !("refresh_token" in cookies))
      return undefined;
    if (typeof cookies.refresh_token !== "string") throw new ApiError("AUTH_REQUIRED", 401);
    return cookies.refresh_token;
  }
  private options(expiresAt: number) {
    return refreshCookieOptions(
      new URL(this.config.get("NEXT_PUBLIC_API_URL")).protocol === "https:",
      expiresAt,
    );
  }
  private issue(response: Response, session: IssuedSession) {
    response.cookie("refresh_token", session.refreshToken, this.options(session.refreshExpiresAt));
    return { accessToken: session.accessToken, expiresIn: session.expiresIn };
  }
  @Get("setup-status")
  status(@Req() request: Request) {
    this.query(request);
    return this.setup.status();
  }

  @Post("setup")
  async initialize(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.query(request);
    await this.limiter.consume("AUTH", this.ip(response));
    const result = await this.setup.setup(body, this.key(request));
    await this.audit.record({
      actorType: "USER",
      actorId: result.response.user.id,
      action: "setup",
      resourceId: "global",
      outcome: "SUCCESS",
      correlationId: response.locals.correlationId,
    });
    return { user: result.response.user, ...this.issue(response, result.response.session) };
  }
  @Post("register")
  async register(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.query(request);
    await this.limiter.consume("AUTH", this.ip(response));
    const result = await this.setup.register(body, this.key(request));
    return { user: result.response.user, ...this.issue(response, result.response.session) };
  }
  @Post("login")
  @HttpCode(200)
  async login(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.query(request);
    await this.limiter.consume("AUTH", this.ip(response));
    const input = new ZodValidationPipe(loginRequestSchema).transform(body);
    await this.limiter.consume("AUTH_EMAIL", input.email);
    try {
      const result = await this.auth.login(input);
      return { user: result.user, ...this.issue(response, result.session) };
    } catch (error) {
      if (error instanceof ApiError && error.errorCode === "INVALID_CREDENTIALS")
        await this.audit.record({
          actorType: "ANONYMOUS",
          actorId: null,
          action: "auth.login.failure",
          resourceId: null,
          outcome: "DENIED",
          errorCode: error.errorCode,
          correlationId: response.locals.correlationId,
        });
      throw error;
    }
  }
  @Get("me")
  @UseGuards(JwtGuard)
  async me(@Req() request: Request) {
    this.query(request);
    const user = await this.jwt.current(this.jwt.principal(request));
    await this.limiter.consume("READ", user.id);
    return userDto(user);
  }
  @Post("refresh")
  @HttpCode(200)
  async rotate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.query(request);
    empty.transform(body);
    await this.limiter.consume("AUTH", this.ip(response));
    const token = this.cookie(request);
    if (!token) throw new ApiError("AUTH_REQUIRED", 401);
    return this.issue(response, await this.refresh.rotate(token));
  }
  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    this.query(request);
    empty.transform(body);
    const refreshToken = this.cookie(request),
      accessToken = request.get("authorization")?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    let actor: string;
    if (refreshToken) {
      // Establish the rate-limit identity before mutation; the lifecycle service validates again.
      try {
        const claims: unknown = new JwtService().verify(refreshToken, {
          algorithms: ["HS256"],
          secret: this.config.secrets.refreshSecret,
          issuer: "kabuki-neko",
          audience: "kabuki-neko-refresh",
        });
        actor = z.object({ sub: uuidSchema }).parse(claims).sub;
      } catch {
        throw new ApiError("TOKEN_REVOKED", 401);
      }
    } else if (accessToken) actor = (await this.refresh.authenticateAccess(accessToken)).user.id;
    else throw new ApiError("AUTH_REQUIRED", 401);
    await this.limiter.consume("WRITE", actor);
    const result = await this.refresh.logout({
      ...(refreshToken ? { refreshToken } : {}),
      ...(accessToken ? { accessToken } : {}),
    });
    const { maxAge: _maxAge, ...options } = this.options(0);
    response.clearCookie("refresh_token", options);
    await this.audit.record({
      actorType: "USER",
      actorId: actor,
      action: "auth.logout",
      resourceId: null,
      outcome: "SUCCESS",
      correlationId: response.locals.correlationId,
    });
    return result;
  }
}
