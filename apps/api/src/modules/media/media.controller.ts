/**
 * Media REST routes (SA §4.4): upload, owner library, accessibility PATCH and delete.
 *
 * Uploads are parsed in memory with per-request caps from the current settings (the original
 * byte count is limited before buffering), at most two concurrent uploads per user, and an
 * Idempotency-Key. Responses only ever contain READY media; private metadata responses inherit the
 * boundary's `private, no-store` caching while public files are served immutable by `/uploads`.
 */
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
import multer, { MulterError } from "multer";
import { z } from "zod";
import { AuditService } from "../../common/audit.service";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import { MULTIPART_METADATA_LIMIT } from "../../common/request-context.middleware";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { MediaGcService } from "./media-gc.service";
import { MediaService, type MediaUpload } from "./media.service";

const empty = new ZodValidationPipe(z.strictObject({}));
/** Audit events accept only server-generated v4 UUIDs as resource IDs. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Only `folder` and an optional `accessibility` JSON text field may accompany the file part. */
const uploadFields = z.strictObject({
  folder: z.string().max(32).optional(),
  accessibility: z.string().optional(),
});

/** Maps multer/busboy failures to the stable envelope without echoing raw form input. */
function multipartError(error: unknown): ApiError {
  if (
    error instanceof MulterError &&
    (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FIELD_VALUE")
  )
    return new ApiError("PAYLOAD_TOO_LARGE", 413);
  if (error instanceof ApiError) return error;
  return new ApiError("MALFORMED_MULTIPART", 400);
}
/** Parses one in-memory upload capped at `fileSize` original bytes plus two metadata fields. */
async function readUpload(request: Request, response: Response, fileSize: number) {
  if (!request.is("multipart/form-data")) throw new ApiError("UNSUPPORTED_CONTENT_TYPE", 415);
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      fields: 2,
      parts: 3,
      fileSize,
      fieldSize: MULTIPART_METADATA_LIMIT,
      fieldNameSize: 32,
      headerPairs: 20,
    },
  }).single("file");
  await new Promise<void>((resolve, reject) => {
    parser(request, response, (error: unknown) => {
      if (error) reject(multipartError(error));
      else resolve();
    });
  });
  const fields = uploadFields.safeParse({ ...(request.body as object | undefined) });
  if (!fields.success) throw new ApiError("MALFORMED_MULTIPART", 400);
  const file = request.file;
  if (!file)
    throw new ApiError("VALIDATION_FAILED", 422, {}, [
      { path: "file", code: "REQUIRED", params: {}, severity: "error" },
    ]);
  let accessibility: unknown;
  if (fields.data.accessibility !== undefined) {
    try {
      accessibility = JSON.parse(fields.data.accessibility);
    } catch {
      throw new ApiError("VALIDATION_FAILED", 422, {}, [
        { path: "accessibility", code: "MALFORMED_JSON", params: {}, severity: "error" },
      ]);
    }
  }
  return {
    bytes: file.buffer,
    originalName: file.originalname,
    declaredMime: file.mimetype,
    folder: fields.data.folder,
    accessibility,
  } satisfies MediaUpload;
}

@Controller("media")
@UseGuards(JwtGuard)
export class MediaController {
  constructor(
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(MediaGcService) private readonly gc: MediaGcService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Verified principal after charging the route's rate tier. */
  private async actor(request: Request, tier: RateTier) {
    const principal = this.jwt.principal(request);
    await this.limiter.consume(tier, principal.user.id);
    return principal;
  }
  /** Quoted positive revision from If-Match, otherwise 422. */
  private revision(request: Request) {
    const match = request.get("if-match")?.match(/^"([1-9][0-9]*)"$/u);
    if (!match?.[1] || !Number.isSafeInteger(Number(match[1])))
      throw new ApiError("VALIDATION_FAILED", 422);
    return Number(match[1]);
  }
  /** Records a media audit event; resource IDs only, never URLs or storage credentials. */
  private async record(
    principal: VerifiedPrincipal,
    response: Response,
    action: "media.upload" | "media.delete",
    resourceId: string | null,
    error?: unknown,
  ) {
    await this.audit.record({
      actorType: "USER",
      actorId: principal.user.id,
      action,
      resourceId: resourceId && UUID_V4.test(resourceId) ? resourceId : null,
      outcome: error ? "FAILURE" : "SUCCESS",
      errorCode: error instanceof ApiError ? error.errorCode : error ? "INTERNAL_ERROR" : null,
      correlationId: response.locals.correlationId,
    });
  }

  /** POST /media/upload — multipart `file` + `folder` + optional `accessibility` JSON. */
  @Post("upload")
  async upload(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const actor = await this.actor(request, "UPLOAD");
    empty.transform(request.query);
    const lease = await this.limiter.acquire("UPLOAD", actor.user.id);
    try {
      const upload = await readUpload(request, response, await this.media.parserByteCap());
      const result = await this.media.upload(actor, upload, request.get("idempotency-key") ?? "");
      await this.record(actor, response, "media.upload", result.response.id);
      response.status(result.httpStatus);
      response.setHeader("ETag", `"${result.response.revision}"`);
      return result.response;
    } catch (error) {
      await this.record(actor, response, "media.upload", null, error);
      throw error;
    } finally {
      await lease.release();
    }
  }

  /** GET /media — the caller's READY library page. */
  @Get()
  async list(@Req() request: Request) {
    return this.media.list(await this.actor(request, "READ"), request.query);
  }

  /** PATCH /media/:id — accessibility metadata with If-Match; responds with the new ETag. */
  @Patch(":id")
  async patch(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    const media = await this.media.updateAccessibility(actor, id, this.revision(request), body);
    response.setHeader("ETag", `"${media.revision}"`);
    return media;
  }

  /** DELETE /media/:id — owner deletion when unreferenced (409 in use/busy, 503 origin down). */
  @Delete(":id")
  async delete(
    @Req() request: Request,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    try {
      const result = await this.gc.deleteOwned(actor.user.id, id);
      await this.record(actor, response, "media.delete", id);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.errorCode !== "VALIDATION_FAILED")
        await this.record(actor, response, "media.delete", id, error);
      throw error;
    }
  }
}
