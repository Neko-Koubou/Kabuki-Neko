import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, type QuestionType } from "../constants/game";
import { emptyAccessibility } from "./media.schema";
import {
  answerSchemaForQuestion,
  playableQuestionSchema,
  questionMediaIssues,
  questionPlayabilityIssues,
  questionSchema,
} from "./question.schema";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(type: QuestionType) {
  const count = type === "ORDER_PUZZLE" ? 4 : 2;
  return {
    id: uuid(1),
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
    explanationText: null,
    accessibility: emptyAccessibility(),
    options: Array.from({ length: count }, (_, i) => ({
      id: uuid(i + 2),
      optionIndex: i,
      colorIndex: type === "TYPE_ANSWER" ? 0 : i,
      optionText: `Choice ${i}`,
      isCorrect: type === "POLL" ? false : type === "TYPE_ANSWER" || i === 0,
      sortOrder: i,
    })),
  };
}
describe("draft vs playable question schemas", () => {
  it.each(QUESTION_TYPES)("accepts a playable %s and keeps incomplete drafts saveable", (type) => {
    expect(playableQuestionSchema.safeParse(fixture(type)).success).toBe(true);
    const draft = questionSchema.parse({ ...fixture(type), promptText: "", options: [] });
    expect(
      questionPlayabilityIssues(draft).some(
        (issue) => issue.code === "EMPTY_PROMPT" && issue.severity === "warning",
      ),
    ).toBe(true);
    expect(playableQuestionSchema.safeParse(draft).success).toBe(false);
    expect(
      questionPlayabilityIssues(draft, "host").every((issue) => issue.severity === "error"),
    ).toBe(true);
  });
  it("enforces exact cardinality/key rules for all six types", () => {
    for (const type of ["SINGLE_CHOICE", "TRUE_FALSE", "MULTIPLE_SELECT", "TYPE_ANSWER"] as const) {
      const question = fixture(type);
      expect(
        playableQuestionSchema.safeParse({
          ...question,
          options: question.options.map((option) => ({ ...option, isCorrect: false })),
        }).success,
      ).toBe(false);
    }
    const tf = fixture("TRUE_FALSE");
    expect(
      playableQuestionSchema.safeParse({ ...tf, options: fixture("ORDER_PUZZLE").options }).success,
    ).toBe(false);
    const single = fixture("SINGLE_CHOICE");
    expect(
      playableQuestionSchema.safeParse({
        ...single,
        options: single.options.map((option) => ({ ...option, isCorrect: true })),
      }).success,
    ).toBe(false);
    const multiple = fixture("MULTIPLE_SELECT");
    expect(
      playableQuestionSchema.safeParse({
        ...multiple,
        options: multiple.options.map((option) => ({ ...option, isCorrect: true })),
      }).success,
    ).toBe(true);
    const poll = fixture("POLL");
    expect(playableQuestionSchema.safeParse({ ...poll, pointsMultiplier: 1 }).success).toBe(false);
    expect(playableQuestionSchema.safeParse({ ...poll, options: single.options }).success).toBe(
      false,
    );
    const puzzle = fixture("ORDER_PUZZLE");
    expect(
      playableQuestionSchema.safeParse({
        ...puzzle,
        options: puzzle.options.map((option) => ({ ...option, sortOrder: 0 })),
      }).success,
    ).toBe(false);
    expect(
      playableQuestionSchema.safeParse({
        ...puzzle,
        options: puzzle.options.map((option) => ({ ...option, sortOrder: 3 - option.sortOrder })),
      }).success,
    ).toBe(true);
  });
  it("checks20-key maximum, distinct normalized values and contiguous IDs/indices", () => {
    const text = fixture("TYPE_ANSWER");
    const options = Array.from({ length: 20 }, (_, i) => ({
      id: uuid(i + 2),
      optionIndex: i,
      colorIndex: 0,
      optionText: `Key ${i}`,
      isCorrect: true,
      sortOrder: i,
    }));
    expect(playableQuestionSchema.safeParse({ ...text, options }).success).toBe(true);
    expect(
      questionSchema.safeParse({
        ...text,
        options: [...options, { ...options[0], id: uuid(99), optionIndex: 20 }],
      }).success,
    ).toBe(false);
    const question = fixture("SINGLE_CHOICE");
    expect(
      playableQuestionSchema.safeParse({
        ...question,
        options: question.options.map((option, i) => ({
          ...option,
          optionText: i ? " e\u0301 " : "É",
        })),
      }).success,
    ).toBe(false);
    expect(
      questionSchema.safeParse({
        ...question,
        options: question.options.map((option) => ({ ...option, id: uuid(2) })),
      }).success,
    ).toBe(false);
    expect(
      questionSchema.safeParse({ ...question, options: [...question.options].reverse() }).success,
    ).toBe(false);
  });
  it("rejects structural enum/range/injection errors but validates media effects in authorized context", () => {
    const question = fixture("SINGLE_CHOICE");
    for (const patch of [
      { timeLimitSec: 15 },
      { pointsMultiplier: 3 },
      { orderIndex: -1 },
      { creatorId: uuid(9) },
      { mediaRevealMode: "GRID_4X4" },
      { type: "UNSUPPORTED" },
      { videoEndSec: 10 },
    ])
      expect(questionSchema.safeParse({ ...question, ...patch }).success).toBe(false);
    const image = questionSchema.parse({ ...question, mediaId: uuid(9), mediaRevealMode: "BLUR" });
    expect(
      questionMediaIssues(image, { id: uuid(9), mimeType: "image/webp", status: "READY" }),
    ).toEqual([]);
    for (const media of [
      null,
      { id: uuid(9), mimeType: "audio/mpeg", status: "READY" as const },
      { id: uuid(9), mimeType: "image/webp", status: "FAILED" as const },
    ])
      expect(
        questionMediaIssues(image, media).some(
          (issue) => issue.code === "INCOMPATIBLE_MEDIA_EFFECT",
        ),
      ).toBe(true);
  });
});
describe("typed answer validation", () => {
  it("canonicalizes multiple selection only; puzzle order remains meaningful", () => {
    const multiple = answerSchemaForQuestion(fixture("MULTIPLE_SELECT"));
    expect(multiple.parse([1, 0])).toEqual([0, 1]);
    expect(multiple.safeParse([1, 1]).success).toBe(false);
    expect(multiple.safeParse([2]).success).toBe(false);
    const puzzle = answerSchemaForQuestion(fixture("ORDER_PUZZLE"));
    expect(puzzle.parse([3, 1, 2, 0])).toEqual([3, 1, 2, 0]);
    expect(puzzle.safeParse([0, 1, 2]).success).toBe(false);
  });
  it("binds number/string answers to the actual type and refuses client score data", () => {
    const single = answerSchemaForQuestion(fixture("SINGLE_CHOICE"));
    expect(single.parse(1)).toBe(1);
    for (const value of [2, "1", [1], { optionIndex: 1, score: 1000, timestamp: 0 }])
      expect(single.safeParse(value).success).toBe(false);
    const text = answerSchemaForQuestion(fixture("TYPE_ANSWER"));
    expect(text.parse(" e\u0301 ")).toBe("é");
    expect(text.safeParse(0).success).toBe(false);
    expect(text.safeParse(" ").success).toBe(false);
  });
});
