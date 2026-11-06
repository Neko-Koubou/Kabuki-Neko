import { Inject, Injectable } from "@nestjs/common";
import { QuizzesRepository, type MediaRow } from "@kabuki-neko/database";
import type { EntityManager } from "typeorm";
import { mediaSchema } from "@kabuki-neko/shared/schemas/media.schema";
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
import { validateQuiz, type CurrentQuizMedia } from "./quiz-validator";

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
