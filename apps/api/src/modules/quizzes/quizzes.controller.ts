import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { IMPORT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import { MULTIPART_METADATA_LIMIT } from "../../common/request-context.middleware";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";
import { QuizzesService, type DownloadFile, type ImportUpload } from "./quizzes.service";
const empty = new ZodValidationPipe(z.strictObject({}));
/** Only the optional `mediaMap` JSON text field may accompany the single `file` part. */
const importFields = z.strictObject({ mediaMap: z.string().optional() });
/**
 * In-memory multipart reader for POST /quizzes/import: exactly one file part capped at the 5 MiB
 * import limit plus one bounded metadata field. Nothing is written to disk.
 */
const importParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fields: 1,
    parts: 2,
    fileSize: IMPORT_LIMITS.bytes,
    fieldSize: MULTIPART_METADATA_LIMIT,
    fieldNameSize: 32,
    headerPairs: 20,
  },
}).single("file");

/** Maps multer/busboy failures to the stable error envelope without echoing raw form input. */
function multipartError(error: unknown): ApiError {
  if (
    error instanceof MulterError &&
    (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FIELD_VALUE")
  )
    return new ApiError("PAYLOAD_TOO_LARGE", 413);
  if (error instanceof ApiError) return error;
  return new ApiError("MALFORMED_MULTIPART", 400);
}
/** Runs the bounded import parser and returns the file bytes plus the optional mediaMap text. */
async function readImport(request: Request, response: Response): Promise<ImportUpload> {
  if (!request.is("multipart/form-data")) throw new ApiError("UNSUPPORTED_CONTENT_TYPE", 415);
  await new Promise<void>((resolve, reject) => {
    importParser(request, response, (error: unknown) => {
      if (error) reject(multipartError(error));
      else resolve();
    });
  });
  const fields = importFields.safeParse({ ...(request.body as object | undefined) });
  if (!fields.success) throw new ApiError("MALFORMED_MULTIPART", 400);
  const file = request.file;
  if (!file)
    throw new ApiError("VALIDATION_FAILED", 422, {}, [
      { path: "file", code: "REQUIRED", params: {}, severity: "error" },
    ]);
  return {
    bytes: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    mediaMap: fields.data.mediaMap,
  };
}
/** Writes a download with a server-generated ASCII filename; user titles never reach headers. */
function download(response: Response, file: DownloadFile) {
  response.setHeader("Content-Type", file.contentType);
  response.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  response.setHeader("Content-Length", String(file.bytes.byteLength));
  response.end(file.bytes);
}
@Controller("quizzes")
@UseGuards(JwtGuard)
export class QuizzesController {
  constructor(
    @Inject(QuizzesService) private readonly quizzes: QuizzesService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
  ) {}
  private async actor(request: Request, tier: RateTier) {
    const principal = this.jwt.principal(request);
    await this.limiter.consume(tier, principal.user.id);
    return principal;
  }
  private revision(request: Request) {
    const match = request.get("if-match")?.match(/^"([1-9][0-9]*)"$/u);
    if (!match?.[1] || !Number.isSafeInteger(Number(match[1])))
      throw new ApiError("VALIDATION_FAILED", 422);
    return Number(match[1]);
  }
  @Get()
  async list(@Req() request: Request) {
    return this.quizzes.list(await this.actor(request, "READ"), request.query);
  }
  @Post()
  async create(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    const result = await this.quizzes.create(actor, body, request.get("idempotency-key") ?? "");
    response.setHeader("ETag", `"${result.response.revision}"`);
    return result.response;
  }
  /** GET /quizzes/import-template?format=json|csv — declared before `:id` so it is not a UUID. */
  @Get("import-template")
  async template(@Req() request: Request, @Res() response: Response) {
    const actor = await this.actor(request, "READ");
    download(response, await this.quizzes.template(actor, request.query));
  }
  /** POST /quizzes/import — multipart file + optional mediaMap, idempotent via Idempotency-Key. */
  @Post("import")
  async import(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const actor = await this.actor(request, "UPLOAD");
    empty.transform(request.query);
    const upload = await readImport(request, response);
    const result = await this.quizzes.import(actor, upload, request.get("idempotency-key") ?? "");
    response.status(result.httpStatus);
    response.setHeader("ETag", `"${result.response.revision}"`);
    return result.response;
  }
  @Get(":id")
  async detail(
    @Req() request: Request,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "READ");
    empty.transform(request.query);
    const quiz = await this.quizzes.read(actor, id);
    response.setHeader("ETag", `"${quiz.revision}"`);
    return quiz;
  }
  /** GET /quizzes/:id/export?format=json — owner or PUBLIC viewer downloads QuizExportV1. */
  @Get(":id/export")
  async export(@Req() request: Request, @Param("id") id: string, @Res() response: Response) {
    const actor = await this.actor(request, "EXPORT");
    download(response, await this.quizzes.exportFile(actor, id, request.query));
  }
  @Put(":id")
  async save(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    const quiz = await this.quizzes.save(actor, id, this.revision(request), body);
    response.setHeader("ETag", `"${quiz.revision}"`);
    return quiz;
  }
  @Post(":id/duplicate")
  async duplicate(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    empty.transform(body);
    const result = await this.quizzes.duplicate(actor, id, request.get("idempotency-key") ?? "");
    response.setHeader("ETag", `"${result.response.revision}"`);
    return result.response;
  }
  @Delete(":id")
  async delete(@Req() request: Request, @Param("id") id: string) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    return this.quizzes.delete(actor, id, this.revision(request));
  }
}
