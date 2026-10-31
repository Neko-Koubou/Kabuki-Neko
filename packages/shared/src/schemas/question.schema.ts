import { z } from "zod";
import {
  POINTS_MULTIPLIERS,
  QUESTION_TYPES,
  REVEAL_MODES,
  TIME_LIMITS_SEC,
} from "../constants/game";
import { QUIZ_LIMITS, TEXT_LIMITS } from "../constants/limits";
import { type ErrorCode, type Issue } from "../errors";
import { normalizeTextAnswer, textAnswerSchema, textSchema } from "../unicode";
import {
  accessibilitySchema,
  mediaAttachmentFields,
  mediaAttachmentSchema,
  validateAttachmentContext,
} from "./media.schema";
import { uuidSchema } from "./users.schema";

export const optionSchema = z.strictObject({
  id: uuidSchema,
  optionIndex: z
    .number()
    .int()
    .min(0)
    .max(QUIZ_LIMITS.textKeys - 1),
  colorIndex: z.number().int().min(0).max(3),
  optionText: textSchema({ max: TEXT_LIMITS.option }),
  isCorrect: z.boolean(),
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(QUIZ_LIMITS.textKeys - 1),
});
export type Option = z.infer<typeof optionSchema>;
const visualOptionSchema = optionSchema.extend({
  optionIndex: z.number().int().min(0).max(3),
  sortOrder: z.number().int().min(0).max(3),
});
const textOptionSchema = optionSchema.extend({ colorIndex: z.literal(0) });
export const questionFields = {
  id: uuidSchema,
  orderIndex: z
    .number()
    .int()
    .min(0)
    .max(QUIZ_LIMITS.questions - 1),
  promptText: textSchema({ max: TEXT_LIMITS.prompt, multiline: true }),
  ...mediaAttachmentFields,
  mediaRevealMode: z.enum(REVEAL_MODES),
  timeLimitSec: z.union(TIME_LIMITS_SEC.map((value) => z.literal(value))),
  pointsMultiplier: z.union(POINTS_MULTIPLIERS.map((value) => z.literal(value))),
  explanationText: textSchema({ max: TEXT_LIMITS.explanation, multiline: true }).nullable(),
  accessibility: accessibilitySchema,
};
const draftUnion = z.discriminatedUnion("type", [
  z.strictObject({
    ...questionFields,
    type: z.literal("SINGLE_CHOICE"),
    options: z.array(visualOptionSchema).max(QUIZ_LIMITS.options),
  }),
  z.strictObject({
    ...questionFields,
    type: z.literal("TRUE_FALSE"),
    options: z.array(visualOptionSchema).max(QUIZ_LIMITS.options),
  }),
  z.strictObject({
    ...questionFields,
    type: z.literal("MULTIPLE_SELECT"),
    options: z.array(visualOptionSchema).max(QUIZ_LIMITS.options),
  }),
  z.strictObject({
    ...questionFields,
    type: z.literal("TYPE_ANSWER"),
    options: z.array(textOptionSchema).max(QUIZ_LIMITS.textKeys),
  }),
  z.strictObject({
    ...questionFields,
    type: z.literal("ORDER_PUZZLE"),
    options: z.array(visualOptionSchema).max(QUIZ_LIMITS.options),
  }),
  z.strictObject({
    ...questionFields,
    type: z.literal("POLL"),
    options: z.array(visualOptionSchema).max(QUIZ_LIMITS.options),
  }),
]);
export const questionSchema = draftUnion.superRefine((question, ctx) => {
  const ids = new Set<string>([question.id]);
  question.options.forEach((option, index) => {
    if (ids.has(option.id))
      ctx.addIssue({ code: "custom", message: "DUPLICATE_ID", path: ["options", index, "id"] });
    ids.add(option.id);
    if (option.optionIndex !== index)
      ctx.addIssue({
        code: "custom",
        message: "NONCONTIGUOUS_ORDER",
        path: ["options", index, "optionIndex"],
      });
  });
  const attachment = mediaAttachmentSchema.safeParse({
    mediaId: question.mediaId,
    externalVideoUrl: question.externalVideoUrl,
    videoStartSec: question.videoStartSec,
    videoEndSec: question.videoEndSec,
  });
  if (!attachment.success)
    for (const issue of attachment.error.issues)
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
});
export type Question = z.infer<typeof questionSchema>;
const draftWarningCodes: ReadonlySet<ErrorCode> = new Set([
  "EMPTY_PROMPT",
  "EMPTY_OPTION",
  "INVALID_OPTION_COUNT",
  "INVALID_KEY_COUNT",
  "INVALID_PUZZLE_ORDER",
]);
export function questionPlayabilityIssues(
  question: Question,
  mode: "draft" | "host" = "draft",
): Issue[] {
  const issues: Issue[] = [];
  function issue(code: ErrorCode, path: string) {
    issues.push({
      code,
      path,
      params: {},
      severity: mode === "draft" && draftWarningCodes.has(code) ? "warning" : "error",
    });
  }
  if (!question.promptText.trim()) issue("EMPTY_PROMPT", "promptText");
  const values = new Set<string>();
  question.options.forEach((option, i) => {
    const key = normalizeTextAnswer(option.optionText);
    if (!key) issue("EMPTY_OPTION", `options.${i}.optionText`);
    else if (values.has(key)) issue("DUPLICATE_OPTION", `options.${i}.optionText`);
    else values.add(key);
  });
  const count = question.options.length;
  const keys = question.options.filter((option) => option.isCorrect).length;
  switch (question.type) {
    case "SINGLE_CHOICE":
      if (count < 2 || count > 4) issue("INVALID_OPTION_COUNT", "options");
      if (keys !== 1) issue("INVALID_KEY_COUNT", "options");
      break;
    case "TRUE_FALSE":
      if (count !== 2) issue("INVALID_OPTION_COUNT", "options");
      if (keys !== 1) issue("INVALID_KEY_COUNT", "options");
      break;
    case "MULTIPLE_SELECT":
      if (count < 2 || count > 4) issue("INVALID_OPTION_COUNT", "options");
      if (keys < 1) issue("INVALID_KEY_COUNT", "options");
      break;
    case "TYPE_ANSWER":
      if (count < 1 || count > 20) issue("INVALID_OPTION_COUNT", "options");
      if (keys !== count || keys === 0) issue("INVALID_KEY_COUNT", "options");
      break;
    case "ORDER_PUZZLE":
      if (count !== 4) issue("INVALID_OPTION_COUNT", "options");
      if (
        count !== 4 ||
        [...question.options]
          .map((option) => option.sortOrder)
          .sort((a, b) => a - b)
          .some((order, index) => order !== index)
      )
        issue("INVALID_PUZZLE_ORDER", "options");
      break;
    case "POLL":
      if (count < 2 || count > 4) issue("INVALID_OPTION_COUNT", "options");
      if (keys !== 0) issue("INVALID_KEY_COUNT", "options");
      if (question.pointsMultiplier !== 0) issue("OUT_OF_RANGE", "pointsMultiplier");
      break;
  }
  return issues;
}
export const playableQuestionSchema = questionSchema.superRefine((question, ctx) => {
  for (const issue of questionPlayabilityIssues(question, "host"))
    ctx.addIssue({
      code: "custom",
      message: issue.code,
      path: issue.path.split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part)),
    });
});
export function questionMediaIssues(
  question: Question,
  media: Parameters<typeof validateAttachmentContext>[1],
): Issue[] {
  const issues = validateAttachmentContext(question, media);
  if (
    question.mediaRevealMode !== "NONE" &&
    (question.externalVideoUrl !== null ||
      question.mediaId === null ||
      media?.id !== question.mediaId ||
      media.status !== "READY" ||
      !media.mimeType.startsWith("image/"))
  ) {
    issues.push({
      code: "INCOMPATIBLE_MEDIA_EFFECT",
      path: "mediaRevealMode",
      params: {},
      severity: "error",
    });
  }
  return issues;
}
const answerIndex = z.number().int().min(0).max(3);
const answerIndices = z
  .array(answerIndex)
  .min(1)
  .max(4)
  .refine((indices) => new Set(indices).size === indices.length, { message: "INVALID_ANSWER" });
/** Wire format stays number | number[] | string, with no client correctness or timestamp. */
export const answerSchema = z.union([answerIndex, answerIndices, textAnswerSchema]);
export type Answer = z.infer<typeof answerSchema>;
export function answerSchemaForQuestion(question: {
  type: (typeof QUESTION_TYPES)[number];
  options: readonly unknown[];
}) {
  return answerSchema
    .superRefine((answer, ctx) => {
      const invalid = () => ctx.addIssue({ code: "custom", message: "INVALID_ANSWER" });
      switch (question.type) {
        case "TYPE_ANSWER":
          if (typeof answer !== "string") invalid();
          break;
        case "ORDER_PUZZLE":
          if (
            !Array.isArray(answer) ||
            answer.length !== 4 ||
            answer.some((index) => index >= question.options.length)
          )
            invalid();
          break;
        case "MULTIPLE_SELECT":
          if (!Array.isArray(answer) || answer.some((index) => index >= question.options.length))
            invalid();
          break;
        default:
          if (typeof answer !== "number" || answer >= question.options.length) invalid();
          break;
      }
    })
    .transform((answer) =>
      question.type === "MULTIPLE_SELECT" && Array.isArray(answer)
        ? [...answer].sort((a, b) => a - b)
        : answer,
    );
}
