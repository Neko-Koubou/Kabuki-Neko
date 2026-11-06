import { randomUUID } from "node:crypto";
import { QUIZ_CSV_HEADERS, type QuizExportV1 } from "@kabuki-neko/shared/schemas/import.schema";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { importQuiz } from "./quiz-import";
import { exportQuiz } from "./quiz-export";
import type { CurrentQuizMedia } from "./quiz-validator";
const actorId = randomUUID();
function document(): QuizExportV1 {
  return {
    format: "kabukineko.quiz",
    schemaVersion: 1,
    quiz: {
      title: "Import, 猫",
      description: null,
      visibility: "PUBLIC",
      bgmTrack: "random",
      coverMediaRef: null,
    },
    media: [],
    questions: (
      [
        "SINGLE_CHOICE",
        "TRUE_FALSE",
        "MULTIPLE_SELECT",
        "TYPE_ANSWER",
        "ORDER_PUZZLE",
        "POLL",
      ] as const
    ).map((type) => ({
      type,
      promptText: 'Question "one"\nnext line',
      mediaRef: null,
      externalVideoUrl: null,
      videoStartSec: 0,
      videoEndSec: null,
      mediaRevealMode: "NONE",
      timeLimitSec: 20,
      pointsMultiplier: type === "POLL" ? 0 : 1,
      explanationText: null,
      accessibility: emptyAccessibility(),
      options: Array.from({ length: type === "ORDER_PUZZLE" ? 4 : 2 }, (_, i) => ({
        optionText: `Option ${i}`,
        isCorrect:
          type === "TYPE_ANSWER" || type === "MULTIPLE_SELECT" || (type !== "POLL" && i === 0),
        sortOrder: type === "ORDER_PUZZLE" ? 3 - i : 0,
      })),
    })),
  };
}
function bytes(input: unknown) {
  return Buffer.from(JSON.stringify(input));
}
function csv(doc: QuizExportV1) {
  const quote = (v: string) => `"${v.replace(/"/gu, '""')}"`;
  return Buffer.from(
    "\uFEFF" +
      QUIZ_CSV_HEADERS.join(",") +
      "\r\n" +
      doc.questions
        .map((q, i) =>
          [
            "1",
            doc.quiz.title,
            doc.quiz.description ?? "",
            doc.quiz.bgmTrack,
            String(i),
            q.type,
            q.promptText,
            String(q.timeLimitSec),
            String(q.pointsMultiplier),
            q.mediaRef ?? "",
            q.externalVideoUrl ?? "",
            String(q.videoStartSec),
            q.videoEndSec === null ? "" : String(q.videoEndSec),
            q.mediaRevealMode,
            q.explanationText ?? "",
            JSON.stringify(q.options),
            JSON.stringify(q.accessibility),
          ]
            .map(quote)
            .join(","),
        )
        .join("\r\n") +
      "\r\n",
  );
}
it.each(["json", "csv"] as const)(
  "round-trips all six types and incomplete drafts through %s",
  (format) => {
    const doc = document();
    const first = doc.questions[0];
    if (!first) throw new Error("Missing fixture");
    first.promptText = "";
    const imported = importQuiz(
      format === "json" ? bytes(doc) : csv(doc),
      format,
      actorId,
      new Map(),
    );
    expect(imported.quiz.visibility).toBe("PRIVATE");
    expect(imported.isPlayable).toBe(false);
    expect(
      imported.quiz.questions.map((q) =>
        q.options.map(({ optionText, isCorrect, sortOrder }) => ({
          optionText,
          isCorrect,
          sortOrder,
        })),
      ),
    ).toEqual(doc.questions.map((q) => q.options));
    const exported = exportQuiz({
      id: randomUUID(),
      creatorId: actorId,
      creatorName: "Creator",
      title: imported.quiz.title,
      description: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      coverMedia: null,
      revision: 1,
      questionCount: 6,
      isPlayable: false,
      createdAt: 1,
      updatedAt: 1,
      capabilities: {
        canEdit: true,
        canDelete: true,
        canDuplicate: true,
        canHost: true,
        canExport: true,
      },
      questions: imported.quiz.questions,
      media: [],
      validationIssues: imported.validationIssues,
    });
    expect(exported.filename).toMatch(/^[a-f0-9-]+\.kabukineko\.json$/u);
    expect(JSON.stringify(exported.document)).not.toMatch(/creatorId|optionIndex|colorIndex/);
    const again = importQuiz(exported.bytes, "json", actorId, new Map());
    expect(again.quiz.questions[0]?.id).not.toBe(imported.quiz.questions[0]?.id);
    expect(again.quiz.questions.map((q) => q.type)).toEqual(doc.questions.map((q) => q.type));
  },
);
it("rejects malformed UTF-8/JSON, unsupported versions, depth and byte limits", () => {
  expect(() => importQuiz(Buffer.from([0xff]), "json", actorId, new Map())).toThrow(
    "MALFORMED_IMPORT",
  );
  expect(() => importQuiz(Buffer.from("{"), "json", actorId, new Map())).toThrow("MALFORMED_JSON");
  expect(() =>
    importQuiz(bytes({ ...document(), schemaVersion: 2 }), "json", actorId, new Map()),
  ).toThrow("UNSUPPORTED_IMPORT_VERSION");
  expect(() =>
    importQuiz(Buffer.from("[".repeat(14) + "0" + "]".repeat(14)), "json", actorId, new Map()),
  ).toThrow("PAYLOAD_TOO_LARGE");
  expect(() => importQuiz(Buffer.alloc(5 * 1024 * 1024 + 1), "json", actorId, new Map())).toThrow(
    "PAYLOAD_TOO_LARGE",
  );
});
it("rejects invalid CSV quoting/headers/cells and reports bounded row diagnostics", () => {
  const valid = csv(document()).toString();
  expect(() =>
    importQuiz(
      Buffer.from(valid.replace("schema_version,quiz_title", "quiz_title,schema_version")),
      "csv",
      actorId,
      new Map(),
    ),
  ).toThrow("MALFORMED_CSV");
  expect(() => importQuiz(Buffer.from(valid + '"unterminated'), "csv", actorId, new Map())).toThrow(
    "MALFORMED_CSV",
  );
  expect(() =>
    importQuiz(
      Buffer.from(valid.replace('"[{""optionText', '"[{INVALID""optionText')),
      "csv",
      actorId,
      new Map(),
    ),
  ).toThrow("IMPORT_VALIDATION_FAILED");
  const doc = document();
  const first = doc.questions[0];
  if (!first) throw new Error("Missing fixture");
  doc.questions = Array.from({ length: 200 }, () => ({
    ...first,
    type: "UNKNOWN" as typeof first.type,
    timeLimitSec: -1 as typeof first.timeLimitSec,
  }));
  try {
    importQuiz(csv(doc), "csv", actorId, new Map());
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toMatchObject({
      errorCode: "IMPORT_VALIDATION_FAILED",
      params: { actual: expect.any(Number) },
    });
    if (!(error instanceof Error) || !("details" in error) || !("params" in error)) throw error;
    expect(error.details).toHaveLength(200);
    expect(error.params).toEqual({ actual: 600 });
    expect(error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "rows.2.type", params: { row: 2, column: "type" } }),
      ]),
    );
  }
});
it("requires owned READY media mappings and never fetches embedded URLs", () => {
  const doc = document(),
    ref = randomUUID(),
    localId = randomUUID();
  doc.quiz.coverMediaRef = ref;
  doc.media = [
    {
      ref,
      mimeType: "image/webp",
      originalName: "remote.webp",
      publicUrl: "https://example.invalid/private.webp",
      accessibility: emptyAccessibility(),
    },
  ];
  const local: CurrentQuizMedia = {
    id: localId,
    uploaderId: actorId,
    status: "READY",
    storageDriver: "local",
    publicUrl: `/uploads/${localId}.webp`,
    originalName: "local.webp",
    mimeType: "image/webp",
    sizeBytes: 1,
    width: null,
    height: null,
    durationMs: null,
    accessibility: emptyAccessibility(),
    revision: 1,
    createdAt: 1,
    inUse: false,
    canDelete: true,
  };
  const spy = jest.spyOn(globalThis, "fetch");
  expect(() => importQuiz(bytes(doc), "json", actorId, new Map())).toThrow(
    "IMPORT_VALIDATION_FAILED",
  );
  const media = new Map([[localId, local]]);
  const imported = importQuiz(bytes(doc), "json", actorId, media, { [ref]: localId });
  expect(imported.quiz.coverMediaId).toBe(localId);
  expect(imported.validationIssues.some((i) => i.code === "IMPORTED_AS_PRIVATE")).toBe(true);
  local.uploaderId = randomUUID();
  expect(() => importQuiz(bytes(doc), "json", actorId, media, { [ref]: localId })).toThrow(
    "IMPORT_VALIDATION_FAILED",
  );
  local.uploaderId = actorId;
  local.status = "UPLOADING";
  expect(() => importQuiz(bytes(doc), "json", actorId, media, { [ref]: localId })).toThrow(
    "IMPORT_VALIDATION_FAILED",
  );
  const descriptor = doc.media[0];
  if (!descriptor) throw new Error("Missing media descriptor");
  doc.media[0] = { ...descriptor, publicUrl: "javascript:alert(1)" };
  expect(() => importQuiz(bytes(doc), "json", actorId, media)).toThrow("IMPORT_VALIDATION_FAILED");
  expect(spy).not.toHaveBeenCalled();
});
