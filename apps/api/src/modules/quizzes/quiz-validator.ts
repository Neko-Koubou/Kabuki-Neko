import type { Issue } from "@kabuki-neko/shared/errors";
import type { Media } from "@kabuki-neko/shared/schemas/media.schema";
import {
  questionMediaIssues,
  questionPlayabilityIssues,
} from "@kabuki-neko/shared/schemas/question.schema";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ApiError } from "../../common/error.filter";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";

export interface CurrentQuizMedia extends Media {
  status: "READY" | "UPLOADING" | "FAILED" | "DELETING";
}
/** Constructed by services from authorized persisted content, never from request fields. */
export interface QuizAuthorization {
  actorId: string;
  retainedMediaIds: ReadonlySet<string>;
}
export function validateQuiz(
  input: unknown,
  media: ReadonlyMap<string, CurrentQuizMedia>,
  authorization: QuizAuthorization,
  mode: "draft" | "host" = "draft",
) {
  const quiz = new ZodValidationPipe(quizWriteSchema).transform(input);
  const issues: Issue[] = [];
  function allowed(id: string, path: string) {
    const asset = media.get(id);
    if (
      !asset ||
      asset.status !== "READY" ||
      (asset.uploaderId !== authorization.actorId && !authorization.retainedMediaIds.has(id))
    ) {
      issues.push({ path, code: "INVALID_REFERENCE", params: {}, severity: "error" });
      return null;
    }
    return asset;
  }
  if (quiz.coverMediaId) {
    const cover = allowed(quiz.coverMediaId, "coverMediaId");
    if (cover && !cover.mimeType.startsWith("image/"))
      issues.push({
        path: "coverMediaId",
        code: "INVALID_REFERENCE",
        params: {},
        severity: "error",
      });
  }
  if (quiz.questions.length === 0)
    issues.push({
      path: "questions",
      code: "QUIZ_NOT_PLAYABLE",
      params: {},
      severity: mode === "host" ? "error" : "warning",
    });
  quiz.questions.forEach((question, index) => {
    const prefix = `questions.${index}`;
    const asset = question.mediaId ? allowed(question.mediaId, `${prefix}.mediaId`) : null;
    for (const issue of [
      ...questionPlayabilityIssues(question, mode),
      ...questionMediaIssues(question, asset),
    ]) {
      issues.push({ ...issue, path: `${prefix}.${issue.path}` });
    }
  });
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length)
    throw new ApiError(
      mode === "host" ? "QUIZ_NOT_PLAYABLE" : "VALIDATION_FAILED",
      422,
      {},
      errors.slice(0, 200),
    );
  return { quiz, validationIssues: issues.slice(0, 200), isPlayable: issues.length === 0 };
}
