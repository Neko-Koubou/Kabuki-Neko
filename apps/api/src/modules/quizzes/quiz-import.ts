import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IMPORT_LIMITS, QUIZ_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { ERROR_CODES, type ErrorCode, type Issue } from "@kabuki-neko/shared/errors";
import {
  QUIZ_CSV_HEADERS,
  exportQuestionSchema,
  importStructureGuardSchema,
  mediaMapSchema,
  quizExportV1Schema,
  type QuizExportV1,
} from "@kabuki-neko/shared/schemas/import.schema";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ApiError } from "../../common/error.filter";
import { validateQuiz, type CurrentQuizMedia } from "./quiz-validator";

function invalid(details: Issue[]): never {
  throw new ApiError(
    "IMPORT_VALIDATION_FAILED",
    422,
    { actual: details.length },
    details.slice(0, IMPORT_LIMITS.returnedIssues),
  );
}
function issue(
  path: string,
  code: ErrorCode = "INVALID_FORMAT",
  row?: number,
  column?: string,
): Issue {
  return {
    path,
    code,
    params: row === undefined ? {} : { row, ...(column ? { column } : {}) },
    severity: "error",
  };
}
function checked<T>(schema: z.ZodType<T>, input: unknown, prefix = ""): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  invalid(
    result.error.issues.map((error) =>
      issue(
        [prefix, ...error.path.map(String)].filter(Boolean).join("."),
        ERROR_CODES.includes(error.message as ErrorCode)
          ? (error.message as ErrorCode)
          : "INVALID_FORMAT",
      ),
    ),
  );
}
function json(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError("MALFORMED_JSON", 400);
  }
  if (!importStructureGuardSchema.safeParse(value).success)
    throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  return value;
}
/** Bounded RFC4180 reader; quotes are only valid at cell start and doubled inside quoted cells. */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  function field() {
    row.push(cell);
    cell = "";
    closed = false;
    if (row.length > QUIZ_CSV_HEADERS.length) throw new ApiError("MALFORMED_CSV", 400);
  }
  function record() {
    field();
    rows.push(row);
    row = [];
    if (rows.length > QUIZ_LIMITS.questions + 1) throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ",") field();
    else if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (text[i + 1] !== "\n") throw new ApiError("MALFORMED_CSV", 400);
        i++;
      }
      record();
    } else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new ApiError("MALFORMED_CSV", 400);
      cell += char;
    }
  }
  if (quoted) throw new ApiError("MALFORMED_CSV", 400);
  if (cell || row.length || closed) record();
  return rows;
}
function fromCsv(text: string): Omit<QuizExportV1, "media"> {
  const rows = csv(text),
    header = rows.shift();
  if (
    !header ||
    header.length !== QUIZ_CSV_HEADERS.length ||
    header.some((value, index) => value !== QUIZ_CSV_HEADERS[index])
  )
    throw new ApiError("MALFORMED_CSV", 400);
  const first = rows[0];
  if (!first) invalid([issue("rows", "REQUIRED")]);
  const errors: Issue[] = [];
  const questions: QuizExportV1["questions"] = [];
  rows.forEach((cells, index) => {
    const row = index + 2;
    if (cells.length !== QUIZ_CSV_HEADERS.length) {
      errors.push(issue(`rows.${row}`, "INVALID_FORMAT", row));
      return;
    }
    const get = (column: (typeof QUIZ_CSV_HEADERS)[number]) =>
      cells[QUIZ_CSV_HEADERS.indexOf(column)] ?? "";
    const number = (column: (typeof QUIZ_CSV_HEADERS)[number], fallback?: number | null) => {
      const value = get(column);
      if (value === "" && fallback !== undefined) return fallback;
      if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        errors.push(issue(`rows.${row}.${column}`, "INVALID_FORMAT", row, column));
        return undefined;
      }
      return Number(value);
    };
    if (get("schema_version") !== "1")
      errors.push(
        issue(`rows.${row}.schema_version`, "UNSUPPORTED_IMPORT_VERSION", row, "schema_version"),
      );
    if (number("question_index") !== index)
      errors.push(
        issue(`rows.${row}.question_index`, "NONCONTIGUOUS_ORDER", row, "question_index"),
      );
    for (const column of ["quiz_title", "quiz_description", "bgm_track"] as const) {
      if (get(column) !== first[QUIZ_CSV_HEADERS.indexOf(column)])
        errors.push(issue(`rows.${row}.${column}`, "INVALID_FORMAT", row, column));
    }
    const cellJson = (column: "options_json" | "accessibility_json") => {
      try {
        return json(get(column));
      } catch (error) {
        if (error instanceof ApiError && error.errorCode === "PAYLOAD_TOO_LARGE") throw error;
        errors.push(issue(`rows.${row}.${column}`, "INVALID_FORMAT", row, column));
        return undefined;
      }
    };
    const value = {
      type: get("type"),
      promptText: get("prompt_text"),
      mediaRef: get("media_ref") || null,
      externalVideoUrl: get("external_video_url") || null,
      videoStartSec: number("video_start_sec", 0),
      videoEndSec: number("video_end_sec", null),
      mediaRevealMode: get("media_reveal_mode"),
      timeLimitSec: number("time_limit_sec"),
      pointsMultiplier: number("points_multiplier"),
      explanationText: get("explanation_text") || null,
      options: cellJson("options_json"),
      accessibility: get("accessibility_json")
        ? cellJson("accessibility_json")
        : emptyAccessibility(),
    };
    const result = exportQuestionSchema.safeParse(value);
    if (result.success) questions.push(result.data);
    else
      for (const error of result.error.issues) {
        const field = String(error.path[0]);
        const column =
          (
            {
              options: "options_json",
              accessibility: "accessibility_json",
              promptText: "prompt_text",
              mediaRef: "media_ref",
              externalVideoUrl: "external_video_url",
              videoStartSec: "video_start_sec",
              videoEndSec: "video_end_sec",
              mediaRevealMode: "media_reveal_mode",
              timeLimitSec: "time_limit_sec",
              pointsMultiplier: "points_multiplier",
              explanationText: "explanation_text",
            } as Record<string, string>
          )[field] ?? field;
        errors.push(
          issue(
            `rows.${row}.${[column, ...error.path.slice(1)].join(".")}`,
            "INVALID_FORMAT",
            row,
            column,
          ),
        );
      }
  });
  if (errors.length) invalid(errors);
  return {
    format: "kabukineko.quiz",
    schemaVersion: 1,
    quiz: {
      title: first[1] ?? "",
      description: first[2] || null,
      visibility: "PRIVATE",
      bgmTrack: first[3] ?? "",
      coverMediaRef: null,
    },
    questions,
  };
}
export function importQuiz(
  bytes: Uint8Array,
  format: "json" | "csv",
  actorId: string,
  media: ReadonlyMap<string, CurrentQuizMedia>,
  mapping: unknown = {},
) {
  if (bytes.byteLength > IMPORT_LIMITS.bytes) throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
  } catch {
    throw new ApiError("MALFORMED_IMPORT", 400);
  }
  const mediaMap = checked(mediaMapSchema, mapping, "mediaMap");
  let document: Omit<QuizExportV1, "media">;
  if (format === "json") {
    const value = json(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      value.schemaVersion !== 1
    )
      throw new ApiError("UNSUPPORTED_IMPORT_VERSION", 422);
    document = checked(quizExportV1Schema, value);
  } else document = fromCsv(text);
  if (!importStructureGuardSchema.safeParse(document).success)
    throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  const errors: Issue[] = [];
  function resolve(ref: string | null, path: string) {
    if (ref === null) return null;
    const id = mediaMap[ref] ?? ref,
      asset = media.get(id);
    if (!asset || asset.status !== "READY" || asset.uploaderId !== actorId)
      errors.push(issue(path, "INVALID_REFERENCE"));
    return id;
  }
  const quiz = checked(quizWriteSchema, {
    title: document.quiz.title,
    description: document.quiz.description,
    visibility: "PRIVATE",
    bgmTrack: document.quiz.bgmTrack,
    coverMediaId: resolve(document.quiz.coverMediaRef, "quiz.coverMediaRef"),
    questions: document.questions.map(({ mediaRef, options, ...question }, index) => ({
      ...question,
      id: randomUUID(),
      orderIndex: index,
      mediaId: resolve(
        mediaRef,
        format === "csv" ? `rows.${index + 2}.media_ref` : `questions.${index}.mediaRef`,
      ),
      options: options.map((option, optionIndex) => ({
        ...option,
        id: randomUUID(),
        optionIndex,
        colorIndex: question.type === "TYPE_ANSWER" ? 0 : optionIndex,
      })),
    })),
  });
  if (errors.length) invalid(errors);
  try {
    const result = validateQuiz(quiz, media, { actorId, retainedMediaIds: new Set() });
    if (document.quiz.visibility === "PUBLIC")
      result.validationIssues.push({
        path: "visibility",
        code: "IMPORTED_AS_PRIVATE",
        params: {},
        severity: "warning",
      });
    return {
      ...result,
      validationIssues: result.validationIssues.slice(0, IMPORT_LIMITS.returnedIssues),
    };
  } catch (error) {
    if (error instanceof ApiError) invalid(error.details);
    throw error;
  }
}
