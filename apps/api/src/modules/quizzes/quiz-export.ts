import { quizExportV1Schema } from "@kabuki-neko/shared/schemas/import.schema";
import { quizDetailSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";

/** Input has already passed resource authorization; export is an allowlist, not a row dump. */
export function exportQuiz(input: unknown) {
  const detail = new ZodValidationPipe(quizDetailSchema).transform(input);
  const document = quizExportV1Schema.parse({
    format: "kabukineko.quiz",
    schemaVersion: 1,
    quiz: {
      title: detail.title,
      description: detail.description,
      visibility: detail.visibility,
      bgmTrack: detail.bgmTrack,
      coverMediaRef: detail.coverMedia?.id ?? null,
    },
    media: detail.media.map((media) => ({
      ref: media.id,
      mimeType: media.mimeType,
      originalName: media.originalName,
      publicUrl: media.publicUrl,
      accessibility: media.accessibility,
    })),
    questions: detail.questions.map((q) => ({
      type: q.type,
      promptText: q.promptText,
      mediaRef: q.mediaId,
      externalVideoUrl: q.externalVideoUrl,
      videoStartSec: q.videoStartSec,
      videoEndSec: q.videoEndSec,
      mediaRevealMode: q.mediaRevealMode,
      timeLimitSec: q.timeLimitSec,
      pointsMultiplier: q.pointsMultiplier,
      explanationText: q.explanationText,
      accessibility: q.accessibility,
      options: q.options.map((o) => ({
        optionText: o.optionText,
        isCorrect: o.isCorrect,
        sortOrder: o.sortOrder,
      })),
    })),
  });
  return {
    filename: `${detail.id}.kabukineko.json`,
    contentType: "application/json; charset=utf-8",
    document,
    bytes: Buffer.from(JSON.stringify(document)),
  };
}
