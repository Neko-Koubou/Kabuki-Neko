import { describe, expect, it } from "vitest";
import { QUESTION_TYPES, type QuestionType } from "../constants/game";
import { IMPORT_LIMITS } from "../constants/limits";
import {
  importIssuesSchema,
  importStructureGuardSchema,
  mediaMapSchema,
  QUIZ_CSV_HEADERS,
  quizExportV1Schema,
} from "./import.schema";
import { emptyAccessibility } from "./media.schema";
import { quizCreateSchema, quizQuerySchema, quizWriteSchema } from "./quiz.schema";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function question(type: QuestionType, orderIndex = 0) {
  return {
    id: uuid(orderIndex * 100 + 1),
    orderIndex,
    type,
    promptText: "",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier: type === "POLL" ? 0 : 1,
    explanationText: null,
    accessibility: emptyAccessibility(),
    options: Array.from({ length: type === "ORDER_PUZZLE" ? 4 : 2 }, (_, i) => ({
      id: uuid(orderIndex * 100 + i + 2),
      optionIndex: i,
      colorIndex: type === "TYPE_ANSWER" ? 0 : i,
      optionText: "",
      isCorrect: type === "TYPE_ANSWER" || (i === 0 && type !== "POLL"),
      sortOrder: type === "ORDER_PUZZLE" ? 3 - i : i,
    })),
  };
}
function write() {
  return {
    title: "Quiz",
    description: null,
    coverMediaId: null,
    visibility: "PUBLIC",
    bgmTrack: "random",
    questions: QUESTION_TYPES.map((type, i) => question(type, i)),
  };
}
function exported() {
  const source = write();
  return {
    format: "kabukineko.quiz",
    schemaVersion: 1,
    quiz: {
      title: source.title,
      description: source.description,
      visibility: source.visibility,
      bgmTrack: source.bgmTrack,
      coverMediaRef: source.coverMediaId,
    },
    media: [],
    questions: source.questions.map((q) => ({
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
      options: q.options.map((option) => ({
        optionText: option.optionText,
        isCorrect: option.isCorrect,
        sortOrder: option.sortOrder,
      })),
    })),
  };
}
describe("quiz write and metadata boundaries", () => {
  it("creates metadata only with private/random defaults and refuses ownership injection", () => {
    expect(quizCreateSchema.parse({ title: " Draft " })).toEqual({
      title: "Draft",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
    });
    for (const field of ["creatorId", "capabilities", "questions", "revision"])
      expect(quizCreateSchema.safeParse({ title: "Quiz", [field]: [] }).success).toBe(false);
    expect(quizCreateSchema.parse({ title: "Quiz", bgmTrack: "kabuki-matsuri" }).bgmTrack).toBe(
      "kabuki-matsuri",
    );
  });
  it("allows empty/incomplete drafts but not malformed IDs/order/configuration", () => {
    expect(quizWriteSchema.parse(write()).questions).toHaveLength(6);
    expect(quizWriteSchema.parse({ ...write(), questions: [] }).questions).toEqual([]);
    expect(quizWriteSchema.safeParse({ ...write(), creatorId: uuid(999) }).success).toBe(false);
    expect(
      quizWriteSchema.safeParse({ ...write(), questions: [...write().questions].reverse() })
        .success,
    ).toBe(false);
    const source = write();
    const first = source.questions[0];
    const second = source.questions[1];
    if (!first || !second || !first.options[0] || !second.options[0]) throw new Error("fixture");
    second.options[0].id = first.options[0].id;
    expect(quizWriteSchema.safeParse(source).success).toBe(false);
    expect(
      quizWriteSchema.safeParse({
        ...write(),
        questions: Array.from({ length: 201 }, (_, i) => question("POLL", i)),
      }).success,
    ).toBe(false);
    expect(quizQuerySchema.safeParse({ scope: "public", visibility: "PRIVATE" }).success).toBe(
      false,
    );
  });
  it("applies5MiB to the entire serialized write, not just individual field limits", () => {
    const questions = Array.from({ length: 60 }, (_, i) => ({
      ...question("POLL", i),
      accessibility: { ...emptyAccessibility(), transcript: "界".repeat(30_000) },
    }));
    const result = quizWriteSchema.safeParse({ ...write(), questions });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message === "PAYLOAD_TOO_LARGE")).toBe(true);
  });
});
describe("versioned interchange contracts", () => {
  it("roundtrips all six incomplete types, nullable fields and puzzle order without ownership IDs", () => {
    const data = exported();
    expect(quizExportV1Schema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data);
    expect(
      quizExportV1Schema
        .parse(data)
        .questions.find((q) => q.type === "ORDER_PUZZLE")
        ?.options.map((option) => option.sortOrder),
    ).toEqual([3, 2, 1, 0]);
    expect(quizExportV1Schema.safeParse({ ...data, schemaVersion: 2 }).success).toBe(false);
    expect(
      quizExportV1Schema.safeParse({ ...data, quiz: { ...data.quiz, creatorId: uuid(999) } })
        .success,
    ).toBe(false);
    expect(
      quizExportV1Schema.safeParse({ ...data, quiz: { ...data.quiz, coverMediaRef: undefined } })
        .success,
    ).toBe(false);
    expect(
      quizExportV1Schema.safeParse({ ...data, questions: [{ ...data.questions[0], id: uuid(1) }] })
        .success,
    ).toBe(false);
  });
  it("requires references to be declared, bounds mappings and preserves issue counts/row locations", () => {
    const data = exported();
    expect(
      quizExportV1Schema.safeParse({ ...data, quiz: { ...data.quiz, coverMediaRef: uuid(99) } })
        .success,
    ).toBe(false);
    expect(mediaMapSchema.parse({ [uuid(1)]: uuid(2) })).toEqual({ [uuid(1)]: uuid(2) });
    expect(mediaMapSchema.safeParse({ wrong: uuid(2) }).success).toBe(false);
    expect(
      mediaMapSchema.safeParse(
        Object.fromEntries(Array.from({ length: 202 }, (_, i) => [uuid(i + 1), uuid(900)])),
      ).success,
    ).toBe(false);
    const details = [
      {
        path: "rows.3.options_json.1.isCorrect",
        code: "INVALID_TYPE",
        params: { row: 3, column: "options_json" },
        severity: "error",
      },
    ];
    expect(importIssuesSchema.parse({ details, params: { actual: 500 } }).params.actual).toBe(500);
    expect(importIssuesSchema.safeParse({ details, params: { actual: 0 } }).success).toBe(false);
  });
  it("bounds JSON depth/nodes and never accepts cyclic structures", () => {
    let deep: unknown = 0;
    for (let i = 0; i <= IMPORT_LIMITS.jsonDepth; i++) deep = { child: deep };
    expect(importStructureGuardSchema.safeParse(deep).success).toBe(false);
    expect(
      importStructureGuardSchema.safeParse(
        Array.from({ length: IMPORT_LIMITS.jsonNodes }, () => null),
      ).success,
    ).toBe(false);
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;
    expect(importStructureGuardSchema.safeParse(cycle).success).toBe(false);
    expect(importStructureGuardSchema.safeParse([{ value: 1 }, { value: 1 }]).success).toBe(true);
  });
  it("uses the exact17-column interoperable CSV header", () => {
    expect(QUIZ_CSV_HEADERS.join(",")).toBe(
      "schema_version,quiz_title,quiz_description,bgm_track,question_index,type,prompt_text,time_limit_sec,points_multiplier,media_ref,external_video_url,video_start_sec,video_end_sec,media_reveal_mode,explanation_text,options_json,accessibility_json",
    );
  });
});
