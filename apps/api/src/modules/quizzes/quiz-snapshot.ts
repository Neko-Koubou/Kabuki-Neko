import { z } from "zod";
import { mediaPayloadSchema } from "@kabuki-neko/shared/schemas/game.schema";
import type { Accessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { quizSnapshotSchema } from "../../providers/state/private-state.schema";
import { shuffleQuestion } from "../game-engine/question-shuffler";
import { validateQuiz, type CurrentQuizMedia, type QuizAuthorization } from "./quiz-validator";

function payload(
  asset: CurrentQuizMedia,
  accessibility: Accessibility,
  startSec = 0,
  endSec: number | null = null,
  revealMode: "NONE" | "GRID_3X3" | "GRID_5X5" | "BLUR" = "NONE",
) {
  return mediaPayloadSchema.parse({
    kind: asset.mimeType.startsWith("image/")
      ? "image"
      : asset.mimeType.startsWith("audio/")
        ? "audio"
        : "video",
    url: asset.publicUrl,
    width: asset.width,
    height: asset.height,
    startSec,
    endSec,
    revealMode,
    accessibility,
  });
}
/** The caller reads and pins these current assets in its room-creation transaction. */
export function createQuizSnapshot(
  quizId: string,
  revision: number,
  input: unknown,
  media: ReadonlyMap<string, CurrentQuizMedia>,
  authorization: QuizAuthorization,
): z.infer<typeof quizSnapshotSchema> {
  const { quiz } = validateQuiz(input, media, authorization, "host");
  const cover = quiz.coverMediaId ? media.get(quiz.coverMediaId) : undefined;
  return quizSnapshotSchema.parse({
    schemaVersion: 1,
    quizId,
    revision,
    title: quiz.title,
    description: quiz.description,
    bgmTrack: quiz.bgmTrack,
    coverMedia: cover ? payload(cover, cover.accessibility) : null,
    questions: quiz.questions.map((question) => {
      const asset = question.mediaId ? media.get(question.mediaId) : undefined;
      const mediaSnapshot = asset
        ? payload(
            asset,
            question.accessibility,
            question.videoStartSec,
            question.videoEndSec,
            question.mediaRevealMode,
          )
        : question.externalVideoUrl
          ? mediaPayloadSchema.parse({
              kind: "youtube",
              url: question.externalVideoUrl,
              width: null,
              height: null,
              startSec: question.videoStartSec,
              endSec: question.videoEndSec,
              revealMode: "NONE",
              accessibility: question.accessibility,
            })
          : null;
      return { ...question, ...shuffleQuestion(question), mediaSnapshot };
    }),
  });
}
