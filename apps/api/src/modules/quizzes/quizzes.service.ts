import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { QuizzesRepository, type MediaRow } from "@kabuki-neko/database";
import type { EntityManager } from "typeorm";
import { DEFAULT_AUDIO_TRACK } from "@kabuki-neko/shared/constants/audio";
import { IMPORT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import type { Issue } from "@kabuki-neko/shared/errors";
import {
  QUIZ_CSV_HEADERS,
  importMetadataSchema,
  importTemplateQuerySchema,
  quizExportQuerySchema,
  quizExportV1Schema,
  type QuizExportV1,
} from "@kabuki-neko/shared/schemas/import.schema";
import { emptyAccessibility, mediaSchema } from "@kabuki-neko/shared/schemas/media.schema";
import {
  quizCreateSchema,
  quizDetailSchema,
  quizQuerySchema,
  quizWriteSchema,
  type QuizWrite,
} from "@kabuki-neko/shared/schemas/quiz.schema";
import { revisionSchema, uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ApiError } from "../../common/error.filter";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { exportQuiz } from "./quiz-export";
import { importQuiz, parseImportDocument } from "./quiz-import";
import { validateQuiz, type CurrentQuizMedia } from "./quiz-validator";

/** A downloadable file body with server-chosen, ASCII-only metadata (never user-supplied names). */
export interface DownloadFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}
/** One multipart import request after the controller has parsed and bounded the form parts. */
export interface ImportUpload {
  bytes: Buffer;
  originalName: string;
  mimeType: string;
  mediaMap: string | undefined;
}
/**
 * Client-declared MIME types accepted per import extension. The extension selects the parser and
 * the MIME type must corroborate it; parsing remains the authoritative content check (SA §7.2).
 */
const IMPORT_MIME_TYPES = {
  json: new Set(["application/json", "text/json", "text/plain", "application/octet-stream"]),
  csv: new Set([
    "text/csv",
    "application/csv",
    "text/plain",
    "application/vnd.ms-excel",
    "application/octet-stream",
  ]),
} as const;

/** Selects the import parser from the file extension and rejects uncorroborated MIME types. */
function importFormat(upload: ImportUpload): "json" | "csv" {
  const extension = extname(upload.originalName).toLowerCase();
  const format = extension === ".json" ? "json" : extension === ".csv" ? "csv" : undefined;
  const mime = upload.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!format || !IMPORT_MIME_TYPES[format].has(mime))
    throw new ApiError("UNSUPPORTED_CONTENT_TYPE", 415);
  return format;
}
/** Parses the optional multipart `mediaMap` JSON field into exported-ref → owned-media-ID pairs. */
function importMediaMap(raw: string | undefined): Record<string, string> {
  let value: unknown = {};
  if (raw !== undefined && raw !== "") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ApiError("VALIDATION_FAILED", 422, {}, [
        { path: "mediaMap", code: "MALFORMED_JSON", params: {}, severity: "error" },
      ]);
    }
  }
  const parsed = importMetadataSchema.safeParse({ mediaMap: value });
  if (!parsed.success)
    throw new ApiError(
      "VALIDATION_FAILED",
      422,
      { actual: parsed.error.issues.length },
      parsed.error.issues.slice(0, IMPORT_LIMITS.returnedIssues).map((issue) => ({
        path: ["mediaMap", ...issue.path.slice(1).map(String)].join("."),
        code: issue.message === "TOO_MANY_ITEMS" ? "TOO_MANY_ITEMS" : "INVALID_FORMAT",
        params: {},
        severity: "error" as const,
      })),
    );
  return parsed.data.mediaMap;
}
/** Every media reference an import document can contain, before mediaMap substitution. */
function documentReferences(document: Omit<QuizExportV1, "media">) {
  return [document.quiz.coverMediaRef, ...document.questions.map((q) => q.mediaRef)].filter(
    (ref): ref is string => ref !== null,
  );
}
/** Option rows for the template: one entry per [text, isCorrect, sortOrder] tuple. */
function templateOptions(rows: readonly (readonly [string, boolean, number])[]) {
  return rows.map(([optionText, isCorrect, sortOrder]) => ({ optionText, isCorrect, sortOrder }));
}
/**
 * Import template covering all six question types (SA §7.2). It is a complete, playable quiz so a
 * creator can import it unchanged, and it keeps puzzle order and multiple accepted keys explicit.
 */
function templateDocument(): QuizExportV1 {
  const question = (
    type: QuizExportV1["questions"][number]["type"],
    promptText: string,
    options: QuizExportV1["questions"][number]["options"],
    pointsMultiplier: 0 | 1 | 2 = 1,
  ): QuizExportV1["questions"][number] => ({
    type,
    promptText,
    mediaRef: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier,
    explanationText: null,
    accessibility: emptyAccessibility(),
    options,
  });
  return quizExportV1Schema.parse({
    format: "kabukineko.quiz",
    schemaVersion: 1,
    quiz: {
      title: "Kabuki Neko import template",
      description: "Replace these sample questions with your own content.",
      visibility: "PRIVATE",
      bgmTrack: DEFAULT_AUDIO_TRACK,
      coverMediaRef: null,
    },
    media: [],
    questions: [
      question(
        "SINGLE_CHOICE",
        "Which planet is known as the Red Planet?",
        templateOptions([
          ["Mars", true, 0],
          ["Venus", false, 0],
          ["Jupiter", false, 0],
          ["Mercury", false, 0],
        ]),
      ),
      question(
        "TRUE_FALSE",
        "Water boils at 100 degrees Celsius at sea level.",
        templateOptions([
          ["True", true, 0],
          ["False", false, 0],
        ]),
      ),
      question(
        "MULTIPLE_SELECT",
        "Which of these are prime numbers?",
        templateOptions([
          ["2", true, 0],
          ["3", true, 0],
          ["4", false, 0],
          ["9", false, 0],
        ]),
      ),
      question(
        "TYPE_ANSWER",
        "What is the capital city of Japan?",
        templateOptions([
          ["Tokyo", true, 0],
          ["Tokio", true, 0],
        ]),
      ),
      question(
        "ORDER_PUZZLE",
        "Put these numbers in ascending order.",
        templateOptions([
          ["Three", true, 2],
          ["One", true, 0],
          ["Four", true, 3],
          ["Two", true, 1],
        ]),
      ),
      question(
        "POLL",
        "Which topic should the next quiz cover?",
        templateOptions([
          ["History", false, 0],
          ["Science", false, 0],
          ["Music", false, 0],
        ]),
        0,
      ),
    ],
  });
}
/** Serializes one RFC4180 cell, quoting only when a delimiter, quote or line break is present. */
function csvCell(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}
/** Renders an export document as the exact 17-column CSV import format (no cover, no media rows). */
function documentCsv(document: QuizExportV1) {
  const rows = document.questions.map((q, index) =>
    [
      "1",
      document.quiz.title,
      document.quiz.description ?? "",
      document.quiz.bgmTrack,
      String(index),
      q.type,
      q.promptText,
      String(q.timeLimitSec),
      String(q.pointsMultiplier),
      q.mediaRef ?? "",
      q.externalVideoUrl ?? "",
      String(q.videoStartSec),
      q.videoEndSec === null ? "" : String(q.videoEndSec),
      q.mediaRevealMode,
      q.explanationText ?? "",
      JSON.stringify(q.options),
      JSON.stringify(q.accessibility),
    ]
      .map(csvCell)
      .join(","),
  );
  return [QUIZ_CSV_HEADERS.join(","), ...rows].join("\r\n") + "\r\n";
}

function references(quiz: QuizWrite) {
  return new Set(
    [quiz.coverMediaId, ...quiz.questions.map((q) => q.mediaId)].filter(
      (id): id is string => id !== null,
    ),
  );
}
function currentMedia(row: MediaRow): CurrentQuizMedia {
  return {
    ...mediaSchema.parse({
      id: row.id,
      uploaderId: row.uploader_id,
      storageDriver: row.storage_driver,
      publicUrl: row.public_url,
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
      accessibility: row.accessibility,
      revision: row.revision,
      createdAt: row.created_at,
      inUse: true,
      canDelete: false,
    }),
    status: row.state,
  };
}
@Injectable()
export class QuizzesService {
  constructor(
    @Inject(QuizzesRepository) private readonly quizzes: QuizzesRepository,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
  ) {}
  private async boundary<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error) {
        if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
        if (error.message === "FORBIDDEN") throw new ApiError("FORBIDDEN", 403);
        if (error.message === "REVISION_CONFLICT") throw new ApiError("REVISION_CONFLICT", 409);
        if (
          ["INVALID_REFERENCE", "INVALID_VIDEO_RANGE", "INCOMPATIBLE_MEDIA_EFFECT"].includes(
            error.message,
          )
        )
          throw new ApiError("VALIDATION_FAILED", 422);
      }
      throw error;
    }
  }
  private async detail(actorId: string, id: string, manager?: EntityManager) {
    const source = await this.quizzes.read(actorId, id, manager);
    const media = new Map(source.media.map((row) => [row.id, currentMedia(row)]));
    const validated = validateQuiz(source.content, media, {
      actorId,
      retainedMediaIds: references(source.content),
    });
    const cover = source.content.coverMediaId ? media.get(source.content.coverMediaId) : undefined;
    return quizDetailSchema.parse({
      id: source.row.id,
      creatorId: source.row.creator_id,
      creatorName: source.creatorName,
      title: source.content.title,
      description: source.content.description,
      visibility: source.content.visibility,
      bgmTrack: source.content.bgmTrack,
      coverMedia: cover ? this.publicMedia(cover) : null,
      revision: source.row.revision,
      questionCount: source.content.questions.length,
      isPlayable: validated.isPlayable,
      updatedAt: source.row.updated_at,
      createdAt: source.row.created_at,
      capabilities: source.capabilities,
      questions: source.content.questions,
      media: [...media.values()].map((asset) => this.publicMedia(asset)),
      validationIssues: validated.validationIssues,
    });
  }
  private publicMedia(asset: CurrentQuizMedia) {
    const { status: _status, ...dto } = asset;
    return dto;
  }
  async list(principal: VerifiedPrincipal, input: unknown) {
    const actor = await this.jwt.current(principal);
    const query = new ZodValidationPipe(quizQuerySchema).transform(input);
    return this.boundary(async () => {
      const page = await this.quizzes.list(actor.id, query);
      const items = [];
      for (const row of page.items) {
        const {
          createdAt: _created,
          questions: _questions,
          media: _media,
          validationIssues: _issues,
          ...summary
        } = await this.detail(actor.id, row.id);
        items.push(summary);
      }
      return { items, meta: page.meta };
    });
  }
  async read(principal: VerifiedPrincipal, id: unknown) {
    const actor = await this.jwt.current(principal);
    const quizId = new ZodValidationPipe(uuidSchema).transform(id);
    return this.boundary(() => this.detail(actor.id, quizId));
  }
  async create(principal: VerifiedPrincipal, input: unknown, key: string) {
    const actor = await this.jwt.current(principal);
    const body = new ZodValidationPipe(quizCreateSchema).transform(input);
    return this.boundary(() =>
      this.operations.execute(
        {
          actorScope: actor.id,
          operation: "quiz.create",
          key,
          method: "POST",
          path: "/api/v1/quizzes",
          query: {},
          body,
        },
        async (manager) => {
          const id = await this.quizzes.create(actor.id, body, Date.now(), manager);
          return {
            httpStatus: 201,
            resourceId: id,
            response: await this.detail(actor.id, id, manager),
          };
        },
        async (id) => this.read(principal, id),
        async (id) => {
          await this.read(principal, id);
        },
      ),
    );
  }
  async save(principal: VerifiedPrincipal, id: unknown, revision: unknown, input: unknown) {
    const actor = await this.jwt.current(principal);
    const quizId = new ZodValidationPipe(uuidSchema).transform(id);
    const version = new ZodValidationPipe(revisionSchema).transform(revision);
    const body = new ZodValidationPipe(quizWriteSchema).transform(input);
    return this.boundary(async () => {
      const source = await this.quizzes.read(actor.id, quizId);
      if (!source.capabilities.canEdit) throw new ApiError("FORBIDDEN", 403);
      const media = new Map(
        (await this.quizzes.media([...references(body)])).map((row) => [row.id, currentMedia(row)]),
      );
      validateQuiz(body, media, {
        actorId: actor.id,
        retainedMediaIds: references(source.content),
      });
      await this.quizzes.save(actor.id, quizId, version, body, Date.now());
      return this.detail(actor.id, quizId);
    });
  }
  async duplicate(principal: VerifiedPrincipal, id: unknown, key: string) {
    const actor = await this.jwt.current(principal);
    const quizId = new ZodValidationPipe(uuidSchema).transform(id);
    return this.boundary(() =>
      this.operations.execute(
        {
          actorScope: actor.id,
          operation: "quiz.duplicate",
          key,
          method: "POST",
          path: `/api/v1/quizzes/${quizId}/duplicate`,
          query: {},
          body: {},
        },
        async (manager) => {
          const copyId = await this.quizzes.duplicate(actor.id, quizId, Date.now(), manager);
          return {
            httpStatus: 201,
            resourceId: copyId,
            response: await this.detail(actor.id, copyId, manager),
          };
        },
        async (copyId) => this.read(principal, copyId),
        async (copyId) => {
          await this.read(principal, copyId);
        },
      ),
    );
  }
  /** GET /quizzes/:id/export — owner or PUBLIC viewer receives the allowlisted QuizExportV1 file. */
  async exportFile(
    principal: VerifiedPrincipal,
    id: unknown,
    query: unknown,
  ): Promise<DownloadFile> {
    new ZodValidationPipe(quizExportQuerySchema).transform(query);
    const { filename, contentType, bytes } = exportQuiz(await this.read(principal, id));
    return { filename, contentType, bytes };
  }
  /** GET /quizzes/import-template — static six-type template as JSON or the exact-header CSV. */
  async template(principal: VerifiedPrincipal, query: unknown): Promise<DownloadFile> {
    await this.jwt.current(principal);
    const { format } = new ZodValidationPipe(importTemplateQuerySchema).transform(query);
    const document = templateDocument();
    return format === "json"
      ? {
          filename: "kabukineko-import-template.json",
          contentType: "application/json; charset=utf-8",
          bytes: Buffer.from(JSON.stringify(document, null, 2) + "\n"),
        }
      : {
          filename: "kabukineko-import-template.csv",
          contentType: "text/csv; charset=utf-8",
          bytes: Buffer.from(documentCsv(document)),
        };
  }
  /**
   * POST /quizzes/import — bounded parse first, then one operation transaction that reserves the
   * idempotency receipt, rechecks owned READY media, validates the whole graph and inserts the
   * PRIVATE draft. Any failure rolls back the receipt and every row, so no partial quiz remains.
   */
  async import(principal: VerifiedPrincipal, upload: ImportUpload, key: string) {
    const actor = await this.jwt.current(principal);
    const format = importFormat(upload);
    const mediaMap = importMediaMap(upload.mediaMap);
    const document = parseImportDocument(upload.bytes, format);
    const fileSha256 = createHash("sha256").update(upload.bytes).digest("hex");
    return this.boundary(() =>
      this.operations.execute(
        {
          actorScope: actor.id,
          operation: "quiz.import",
          key,
          method: "POST",
          path: "/api/v1/quizzes/import",
          query: {},
          body: { format, mediaMap },
          fileSha256,
        },
        async (manager) => {
          const ids = documentReferences(document).map((ref) => mediaMap[ref] ?? ref);
          const rows = ids.length ? await this.quizzes.media(ids, manager) : [];
          const media = new Map(rows.map((row) => [row.id, currentMedia(row)]));
          const imported = importQuiz(upload.bytes, format, actor.id, media, mediaMap);
          const id = await this.quizzes.importDraft(actor.id, imported.quiz, Date.now(), manager);
          const detail = await this.detail(actor.id, id, manager);
          const notices: Issue[] = imported.validationIssues.filter(
            (issue) => issue.code === "IMPORTED_AS_PRIVATE",
          );
          return {
            httpStatus: 201,
            resourceId: id,
            response: {
              ...detail,
              validationIssues: [...notices, ...detail.validationIssues].slice(
                0,
                IMPORT_LIMITS.returnedIssues,
              ),
            },
          };
        },
        async (id) => this.read(principal, id),
        async (id) => {
          await this.read(principal, id);
        },
      ),
    );
  }
  async delete(principal: VerifiedPrincipal, id: unknown, revision: unknown) {
    const actor = await this.jwt.current(principal);
    const quizId = new ZodValidationPipe(uuidSchema).transform(id);
    const version = new ZodValidationPipe(revisionSchema).transform(revision);
    return this.boundary(async () => {
      await this.quizzes.delete(actor.id, quizId, version);
      return { deleted: true as const };
    });
  }
}
