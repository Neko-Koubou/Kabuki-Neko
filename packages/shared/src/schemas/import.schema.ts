import { z } from "zod";
import { QUESTION_TYPES } from "../constants/game";
import { IMPORT_LIMITS, QUIZ_LIMITS } from "../constants/limits";
import { issueSchema } from "../errors";
import { bgmTrackSchema } from "./audio.schema";
import { accessibilitySchema, mediaAttachmentSchema, mediaSchema } from "./media.schema";
import { optionSchema, questionFields } from "./question.schema";
import {
  jsonByteLimitSchema,
  quizDescriptionSchema,
  quizTitleSchema,
  quizVisibilitySchema,
} from "./quiz.schema";
import { uuidSchema } from "./users.schema";

export const QUIZ_CSV_HEADERS = [
  "schema_version",
  "quiz_title",
  "quiz_description",
  "bgm_track",
  "question_index",
  "type",
  "prompt_text",
  "time_limit_sec",
  "points_multiplier",
  "media_ref",
  "external_video_url",
  "video_start_sec",
  "video_end_sec",
  "media_reveal_mode",
  "explanation_text",
  "options_json",
  "accessibility_json",
] as const;
export const exportOptionSchema = optionSchema.pick({
  optionText: true,
  isCorrect: true,
  sortOrder: true,
});
export const exportQuestionSchema = z
  .strictObject({
    type: z.enum(QUESTION_TYPES),
    promptText: questionFields.promptText,
    mediaRef: uuidSchema.nullable(),
    externalVideoUrl: questionFields.externalVideoUrl,
    videoStartSec: questionFields.videoStartSec,
    videoEndSec: questionFields.videoEndSec,
    mediaRevealMode: questionFields.mediaRevealMode,
    timeLimitSec: questionFields.timeLimitSec,
    pointsMultiplier: questionFields.pointsMultiplier,
    explanationText: questionFields.explanationText,
    accessibility: accessibilitySchema,
    options: z.array(exportOptionSchema).max(QUIZ_LIMITS.textKeys),
  })
  .superRefine((question, ctx) => {
    if (question.type !== "TYPE_ANSWER") {
      if (question.options.length > QUIZ_LIMITS.options)
        ctx.addIssue({ code: "custom", message: "TOO_MANY_ITEMS", path: ["options"] });
      question.options.forEach((option, index) => {
        if (option.sortOrder >= QUIZ_LIMITS.options)
          ctx.addIssue({
            code: "custom",
            message: "OUT_OF_RANGE",
            path: ["options", index, "sortOrder"],
          });
      });
    }
    const attachment = mediaAttachmentSchema.safeParse({
      mediaId: question.mediaRef,
      externalVideoUrl: question.externalVideoUrl,
      videoStartSec: question.videoStartSec,
      videoEndSec: question.videoEndSec,
    });
    if (!attachment.success)
      for (const issue of attachment.error.issues)
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path.map((part) => (part === "mediaId" ? "mediaRef" : part)),
        });
  });
export const exportMediaSchema = z.strictObject({
  ref: uuidSchema,
  mimeType: mediaSchema.shape.mimeType,
  originalName: mediaSchema.shape.originalName,
  publicUrl: mediaSchema.shape.publicUrl,
  accessibility: accessibilitySchema,
});
/** Structural walk is bounded before schema traversal; parser also applies these limits. */
export const importStructureGuardSchema = z.unknown().superRefine((value, ctx) => {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > IMPORT_LIMITS.jsonNodes || item.depth > IMPORT_LIMITS.jsonDepth) {
      ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
      return;
    }
    if (item.value !== null && typeof item.value === "object") {
      const children = Object.values(item.value);
      if (nodes + stack.length + children.length > IMPORT_LIMITS.jsonNodes) {
        ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
        return;
      }
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
});
const exportObjectSchema = z
  .strictObject({
    format: z.literal("kabukineko.quiz"),
    schemaVersion: z.literal(1),
    quiz: z.strictObject({
      title: quizTitleSchema,
      description: quizDescriptionSchema,
      visibility: quizVisibilitySchema,
      bgmTrack: bgmTrackSchema,
      coverMediaRef: uuidSchema.nullable(),
    }),
    media: z.array(exportMediaSchema).max(IMPORT_LIMITS.mediaMapEntries),
    questions: z.array(exportQuestionSchema).max(QUIZ_LIMITS.questions),
  })
  .superRefine((value, ctx) => {
    const refs = new Set(value.media.map((media) => media.ref));
    if (refs.size !== value.media.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_ID", path: ["media"] });
    if (value.quiz.coverMediaRef !== null && !refs.has(value.quiz.coverMediaRef))
      ctx.addIssue({
        code: "custom",
        message: "INVALID_REFERENCE",
        path: ["quiz", "coverMediaRef"],
      });
    value.questions.forEach((question, index) => {
      if (question.mediaRef !== null && !refs.has(question.mediaRef))
        ctx.addIssue({
          code: "custom",
          message: "INVALID_REFERENCE",
          path: ["questions", index, "mediaRef"],
        });
    });
  });
export const quizExportV1Schema = importStructureGuardSchema
  .pipe(jsonByteLimitSchema(IMPORT_LIMITS.bytes))
  .pipe(exportObjectSchema);
export type QuizExportV1 = z.infer<typeof quizExportV1Schema>;
export const mediaMapSchema = z
  .record(uuidSchema, uuidSchema)
  .refine((value) => Object.keys(value).length <= IMPORT_LIMITS.mediaMapEntries, {
    message: "TOO_MANY_ITEMS",
  });
export const importMetadataSchema = z.strictObject({ mediaMap: mediaMapSchema.default({}) });
export const importIssuesSchema = z
  .strictObject({
    details: z.array(issueSchema).max(IMPORT_LIMITS.returnedIssues),
    params: z.strictObject({ actual: z.number().int().nonnegative() }),
  })
  .refine((value) => value.params.actual >= value.details.length, { message: "OUT_OF_RANGE" });
export const quizExportQuerySchema = z.strictObject({ format: z.literal("json").default("json") });
export const importTemplateQuerySchema = z.strictObject({
  format: z.enum(["json", "csv"]).default("json"),
});
