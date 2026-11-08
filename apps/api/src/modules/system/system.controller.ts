/**
 * System REST routes (SA §4.4): public health, public-config, locales and About; SUPERADMIN
 * settings read/PATCH and storage orphan cleanup.
 *
 * Public routes charge the per-IP PUBLIC tier and expose only redacted data. Administrative
 * routes require a current SUPERADMIN, the ADMIN (or CLEANUP) tier and — for mutations — the
 * global Origin guard, a quoted If-Match revision or an Idempotency-Key. Settings are returned even
 * when storage metrics are unavailable. The locale registry is served `no-cache` with the buildId
 * as a strong ETag so clients revalidate cheaply.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { publicConfigSchema } from "@kabuki-neko/shared/schemas/system.schema";
import { AuditService } from "../../common/audit.service";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { MediaGcService } from "../media/media-gc.service";
import { AudioCatalogService } from "./audio-catalog.service";
import { HealthService } from "./health.service";
import { LocaleRegistryService, readAbout } from "./locale-registry.service";
import { SystemService } from "./system.service";

const empty = new ZodValidationPipe(z.strictObject({}));

@Controller("system")
export class SystemController {
  constructor(
    @Inject(SystemService) private readonly system: SystemService,
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(LocaleRegistryService) private readonly locales: LocaleRegistryService,
    @Inject(AudioCatalogService) private readonly audio: AudioCatalogService,
    @Inject(MediaGcService) private readonly gc: MediaGcService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Charges the per-IP PUBLIC tier and rejects query strings on public routes. */
  private async anonymous(request: Request, response: Response) {
    const ip = typeof response.locals.clientIp === "string" ? response.locals.clientIp : "unknown";
    await this.limiter.consume("PUBLIC", ip);
    empty.transform(request.query);
  }
  /** Verified principal after charging an administrative tier (role checked by the service). */
  private async admin(request: Request, tier: RateTier = "ADMIN") {
    const principal = this.jwt.principal(request);
    await this.limiter.consume(tier, principal.user.id);
    empty.transform(request.query);
    return principal;
  }
  /** Quoted positive revision from If-Match, otherwise 422. */
  private revision(request: Request) {
    const match = request.get("if-match")?.match(/^"([1-9][0-9]*)"$/u);
    if (!match?.[1] || !Number.isSafeInteger(Number(match[1])))
      throw new ApiError("VALIDATION_FAILED", 422);
    return Number(match[1]);
  }
  /** Records an administrative audit event with the request correlation ID. */
  private async record(
    principal: VerifiedPrincipal,
    response: Response,
    action: "settings.update" | "registration.policy.change" | "cleanup",
    error?: unknown,
  ) {
    await this.audit.record({
      actorType: "USER",
      actorId: principal.user.id,
      action,
      resourceId: "global",
      outcome: error ? "FAILURE" : "SUCCESS",
      errorCode: error instanceof ApiError ? error.errorCode : error ? "INTERNAL_ERROR" : null,
      correlationId: response.locals.correlationId,
    });
  }

  /** GET /system/health — 200 when every dependency is up, 503 with the same body otherwise. */
  @Get("health")
  async getHealth(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.anonymous(request, response);
    const health = await this.health.check();
    response.status(health.status === "ok" ? 200 : 503);
    return health;
  }

  /** GET /system/settings — current settings and storage metrics (SUPERADMIN). */
  @Get("settings")
  @UseGuards(JwtGuard)
  async getSettings(@Req() request: Request) {
    return this.system.read(await this.admin(request));
  }

  /** PATCH /system/settings — strict partial update with If-Match; responds with the new ETag. */
  @Patch("settings")
  @UseGuards(JwtGuard)
  async patchSettings(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = await this.admin(request);
    const result = await this.system.update(principal, this.revision(request), body);
    await this.record(principal, response, "settings.update");
    if (result.registrationChanged)
      await this.record(principal, response, "registration.policy.change");
    response.setHeader("ETag", `"${result.settings.revision}"`);
    return result.settings;
  }

  /** POST /system/storage/cleanup-orphans — one bounded cleanup batch (SUPERADMIN, `{}` body). */
  @Post("storage/cleanup-orphans")
  @UseGuards(JwtGuard)
  @HttpCode(200)
  async cleanup(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = await this.admin(request, "CLEANUP");
    empty.transform(body ?? {});
    const actor = await this.jwt.current(principal);
    if (actor.role !== "SUPERADMIN") throw new ApiError("FORBIDDEN", 403);
    const lease = await this.limiter.acquire("CLEANUP", actor.id);
    try {
      const result = await this.gc.cleanup(actor.id, request.get("idempotency-key") ?? "");
      await this.record(principal, response, "cleanup");
      return result;
    } catch (error) {
      await this.record(principal, response, "cleanup", error);
      throw error;
    } finally {
      await lease.release();
    }
  }

  /** GET /system/public-config — display settings, effective default locale and lobby tracks. */
  @Get("public-config")
  async publicConfig(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.anonymous(request, response);
    const settings = await this.system.publicSettings();
    return publicConfigSchema.parse({
      instanceName: settings.instanceName,
      defaultLocale: this.locales.effectiveDefault(settings.defaultLocale),
      registrationMode: settings.registrationMode,
      limits: settings.limits,
      catalogVersion: "1",
      audioTracks: this.audio.lobbyTracks(),
    });
  }

  /** GET /system/locales — installed registry; `no-cache` + ETag buildId with 304 revalidation. */
  @Get("locales")
  async getLocales(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.anonymous(request, response);
    const registry = this.locales.current();
    const etag = this.locales.etag();
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("ETag", etag);
    if (request.get("if-none-match") === etag) {
      response.status(304);
      return undefined;
    }
    return registry;
  }

  /** GET /system/about — build version and legal/guide URLs. */
  @Get("about")
  async about(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.anonymous(request, response);
    return readAbout();
  }
}
