import { z } from "zod";
import { QUIZ_VISIBILITIES } from "../constants/game";
import { PAGING, QUIZ_LIMITS, TEXT_LIMITS } from "../constants/limits";
import { issueSchema } from "../errors";
import { textSchema, utf8ByteLength } from "../unicode";
import { bgmTrackCreateSchema, bgmTrackSchema } from "./audio.schema";
import { mediaSchema } from "./media.schema";
import { type Question, questionSchema } from "./question.schema";
import {
  nameSchema,
  pageSchema,
  pagingQueryShape,
  revisionSchema,
  searchSchema,
  timestampSchema,
  uuidSchema,
} from "./users.schema";

export const quizTitleSchema = textSchema({ min: 1, max: TEXT_LIMITS.title, trim: true });
export const quizDescriptionSchema = textSchema({
  max: TEXT_LIMITS.description,
  multiline: true,
}).nullable();
export const quizVisibilitySchema = z.enum(QUIZ_VISIBILITIES);
/** Validate serialized input before transforms/unknown-field removal can hide oversized data. */
export function jsonByteLimitSchema(maxBytes: number) {
  return z.unknown().superRefine((value, ctx) => {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && utf8ByteLength(serialized) > maxBytes)
        ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
    }
  });
}
const quizMetadataFields = {
  title: quizTitleSchema,
  description: quizDescriptionSchema,
  coverMediaId: uuidSchema.nullable(),
  visibility: quizVisibilitySchema,
  bgmTrack: bgmTrackSchema,
};
export const quizCreateSchema = z.strictObject({
  title: quizTitleSchema,
  description: quizDescriptionSchema.default(null),
  coverMediaId: uuidSchema.nullable().default(null),
  visibility: quizVisibilitySchema.default("PRIVATE"),
  bgmTrack: bgmTrackCreateSchema,
});
function validateQuestionOrder(questions: Question[], ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  questions.forEach((question, index) => {
    if (question.orderIndex !== index)
      ctx.addIssue({ code: "custom", message: "NONCONTIGUOUS_ORDER", path: [index, "orderIndex"] });
    for (const entry of [
      { id: question.id, path: [index, "id"] },
      ...question.options.map((option, oi) => ({
        id: option.id,
        path: [index, "options", oi, "id"],
      })),
    ]) {
      if (ids.has(entry.id))
        ctx.addIssue({ code: "custom", message: "DUPLICATE_ID", path: entry.path });
      ids.add(entry.id);
    }
  });
}
export const quizQuestionsSchema = z
  .array(questionSchema)
  .max(QUIZ_LIMITS.questions)
  .superRefine(validateQuestionOrder);
export const quizWriteSchema = jsonByteLimitSchema(QUIZ_LIMITS.writeBytes).pipe(
  z.strictObject({ ...quizMetadataFields, questions: quizQuestionsSchema }),
);
export type QuizWrite = z.infer<typeof quizWriteSchema>;
export type QuizCreate = z.infer<typeof quizCreateSchema>;
export const quizCapabilitiesSchema = z.strictObject({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canDuplicate: z.boolean(),
  canHost: z.boolean(),
  canExport: z.boolean(),
});
export const quizSummarySchema = z.strictObject({
  id: uuidSchema,
  creatorId: uuidSchema,
  creatorName: nameSchema,
  title: quizTitleSchema,
  description: quizDescriptionSchema,
  coverMedia: mediaSchema.nullable(),
  visibility: quizVisibilitySchema,
  bgmTrack: bgmTrackSchema,
  revision: revisionSchema,
  questionCount: z.number().int().min(0).max(QUIZ_LIMITS.questions),
  isPlayable: z.boolean(),
  updatedAt: timestampSchema,
  capabilities: quizCapabilitiesSchema,
});
export const quizDetailSchema = quizSummarySchema
  .extend({
    createdAt: timestampSchema,
    questions: quizQuestionsSchema,
    media: z.array(mediaSchema).max(QUIZ_LIMITS.questions + 1),
    validationIssues: z.array(issueSchema),
  })
  .superRefine((quiz, ctx) => {
    if (quiz.questionCount !== quiz.questions.length)
      ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE", path: ["questionCount"] });
    if (new Set(quiz.media.map((media) => media.id)).size !== quiz.media.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_ID", path: ["media"] });
  });
export type QuizSummary = z.infer<typeof quizSummarySchema>;
export type QuizDetail = z.infer<typeof quizDetailSchema>;
export const quizQuerySchema = z
  .strictObject({
    ...pagingQueryShape(PAGING.defaults.quizzes),
    search: searchSchema.default(""),
    scope: z.enum(["own", "public"]).default("own"),
    visibility: quizVisibilitySchema.optional(),
    sort: z.enum(["updated_desc", "title_asc"]).default("updated_desc"),
  })
  .refine((value) => !(value.scope === "public" && value.visibility === "PRIVATE"), {
    message: "INVALID_ENUM",
    path: ["visibility"],
  });
export const quizzesPageSchema = pageSchema(quizSummarySchema);
export const quizDeletedSchema = z.strictObject({ deleted: z.literal(true) });
export const operationNames = [
  "quiz.create",
  "quiz.duplicate",
  "quiz.import",
  "media.upload",
  "cleanup",
  "report.retry",
  "room.create",
] as const;
export const operationQuerySchema = z.strictObject({ operation: z.enum(operationNames) });
export const operationStatusSchema = z.strictObject({
  key: uuidSchema,
  operation: z.enum(operationNames),
  status: z.enum(["pending", "done"]),
  resourceId: z.string().nullable(),
});
