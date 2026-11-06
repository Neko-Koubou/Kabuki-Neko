import { randomUUID } from "node:crypto";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { questionSchema, type Question } from "@kabuki-neko/shared/schemas/question.schema";
import type { QuizWrite } from "@kabuki-neko/shared/schemas/quiz.schema";
import { validateQuiz, type CurrentQuizMedia } from "./quiz-validator";
import { createQuizSnapshot } from "./quiz-snapshot";
import { shuffleQuestion } from "../game-engine/question-shuffler";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const actorId = randomUUID();
const authorization = { actorId, retainedMediaIds: new Set<string>() };
function question(type: Question["type"]): Question {
  const count = type === "ORDER_PUZZLE" ? 4 : 2;
  return questionSchema.parse({
    id: randomUUID(),
    orderIndex: 0,
    type,
    promptText: "Choose an answer",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier: type === "POLL" ? 0 : 1,
    explanationText: "Private explanation",
    accessibility: emptyAccessibility(),
    options: Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      optionIndex: i,
      colorIndex: type === "TYPE_ANSWER" ? 0 : i,
      optionText: `Answer ${i}`,
      isCorrect: type === "TYPE_ANSWER" || (type !== "POLL" && i === 0),
      sortOrder: type === "ORDER_PUZZLE" ? 3 - i : 0,
    })),
  });
}
function quiz(q: Question): QuizWrite {
  return {
    title: "Test quiz",
    description: null,
    coverMediaId: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    questions: [q],
  };
}
function asset(): CurrentQuizMedia {
  return {
    id: randomUUID(),
    uploaderId: actorId,
    status: "READY",
    storageDriver: "local",
    publicUrl: "/uploads/questions/test.webp",
    originalName: "test.webp",
    mimeType: "image/webp",
    sizeBytes: 100,
    width: 10,
    height: 10,
    durationMs: null,
    accessibility: emptyAccessibility(),
    revision: 1,
    createdAt: 1,
    inUse: true,
    canDelete: false,
  };
}
it.each<Question["type"]>([
  "SINGLE_CHOICE",
  "TRUE_FALSE",
  "MULTIPLE_SELECT",
  "TYPE_ANSWER",
  "ORDER_PUZZLE",
  "POLL",
])("validates complete and incomplete %s questions", (type) => {
  const input = quiz(question(type));
  expect(validateQuiz(input, new Map(), authorization, "host").isPlayable).toBe(true);
  required(input.questions[0]).promptText = "";
  expect(validateQuiz(input, new Map(), authorization).validationIssues).toContainEqual(
    expect.objectContaining({ code: "EMPTY_PROMPT", severity: "warning" }),
  );
  expect(() => validateQuiz(input, new Map(), authorization, "host")).toThrow("QUIZ_NOT_PLAYABLE");
  required(input.questions[0]).promptText = "Ready";
  if (type === "POLL") required(required(input.questions[0]).options[0]).isCorrect = true;
  else if (type === "ORDER_PUZZLE")
    required(input.questions[0]).options.forEach((o) => {
      o.sortOrder = 0;
    });
  else
    required(input.questions[0]).options.forEach((o) => {
      o.isCorrect = false;
    });
  expect(() => validateQuiz(input, new Map(), authorization, "host")).toThrow("QUIZ_NOT_PLAYABLE");
});
it("rejects structural errors, unauthorized/new foreign references and unavailable media", () => {
  const image = asset(),
    input = quiz(question("SINGLE_CHOICE"));
  required(input.questions[0]).mediaId = image.id;
  const media = new Map([[image.id, image]]);
  expect(validateQuiz(input, media, authorization).isPlayable).toBe(true);
  image.uploaderId = randomUUID();
  expect(() => validateQuiz(input, media, authorization)).toThrow("VALIDATION_FAILED");
  const retained = { actorId, retainedMediaIds: new Set([image.id]) };
  expect(validateQuiz(input, media, retained).isPlayable).toBe(true);
  image.status = "DELETING";
  expect(() => validateQuiz(input, media, retained, "host")).toThrow("QUIZ_NOT_PLAYABLE");
  expect(() => validateQuiz({ ...input, forged: true }, media, retained)).toThrow(
    "VALIDATION_FAILED",
  );
  expect(validateQuiz({ ...input, questions: [] }, media, authorization).isPlayable).toBe(false);
  expect(() => validateQuiz({ ...input, questions: [] }, media, authorization, "host")).toThrow(
    "QUIZ_NOT_PLAYABLE",
  );
});
it("copies source content, question accessibility and current media URLs into independent snapshots", () => {
  const image = asset(),
    input = quiz(question("ORDER_PUZZLE"));
  input.coverMediaId = image.id;
  required(input.questions[0]).mediaId = image.id;
  required(input.questions[0]).accessibility.altText = "Question context";
  image.accessibility.altText = "Library context";
  const snapshot = createQuizSnapshot(
    randomUUID(),
    1,
    input,
    new Map([[image.id, image]]),
    authorization,
  );
  const saved = JSON.stringify(snapshot);
  input.title = "Edited";
  required(required(input.questions[0]).options[0]).optionText = "Edited answer";
  required(input.questions[0]).accessibility.altText = "Edited question";
  image.publicUrl = "/uploads/questions/changed.webp";
  image.accessibility.altText = "Edited library";
  expect(JSON.stringify(snapshot)).toBe(saved);
  expect(snapshot.questions[0]?.mediaSnapshot?.accessibility.altText).toBe("Question context");
  expect(snapshot.coverMedia?.accessibility.altText).toBe("Library context");
});
it("keeps every Fisher-Yates permutation bijective, allows identity and hides private fields", () => {
  const q = question("ORDER_PUZZLE"),
    permutations = new Set<string>();
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 3; b++)
      for (let c = 0; c < 2; c++) {
        const draws = [a, b, c];
        const result = shuffleQuestion(q, () => required(draws.shift()));
        expect(new Set(result.publicToPrivateOptionIds)).toEqual(
          new Set(q.options.map((o) => o.id)),
        );
        expect(new Set(result.publicOptions.map((o) => o.id)).size).toBe(4);
        result.publicOptions.forEach((option, index) => {
          expect(option.index).toBe(index);
          expect(option.colorIndex).toBe(index);
          expect(q.options.some((source) => source.id === option.id)).toBe(false);
          expect(option.text).toBe(
            q.options.find((source) => source.id === result.publicToPrivateOptionIds[index])
              ?.optionText,
          );
          expect(Object.keys(option).sort()).toEqual(["colorIndex", "id", "index", "text"]);
        });
        permutations.add(result.publicToPrivateOptionIds.join(","));
      }
  expect(permutations.size).toBe(24);
  expect(permutations.has(q.options.map((o) => o.id).join(","))).toBe(true);
  expect(shuffleQuestion(question("TYPE_ANSWER")).publicOptions).toEqual([]);
  expect(() => shuffleQuestion(q, () => -1)).toThrow("Invalid shuffle draw");
});
