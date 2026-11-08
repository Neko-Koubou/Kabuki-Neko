/**
 * Report CSV export format (SA §7, BR-20): a stable, locale-independent contract.
 *
 * - UTF-8 with BOM, comma delimiter, CRLF records, exactly the 18 English snake_case columns of
 *   `REPORT_CSV_COLUMNS`, one row per player (ranked by rank, then kicked players by join order).
 * - Times are ISO-8601 UTC, decimals use a dot (accuracy 6 decimals, average 3 decimals), booleans
 *   are `true`/`false` and unavailable values are empty. Numbers are never quoted or coerced.
 * - Every text value is RFC 4180 quoted; text whose first non-whitespace character is `=`, `+`,
 *   `-` or `@`, or which starts with TAB/CR/LF, is prefixed with an apostrophe first so spreadsheet
 *   software never evaluates it as a formula. Other control characters are replaced by U+FFFD.
 * - The filename is fixed ASCII built from the session UUID only (no user text in headers).
 */
import type { Metric } from "@kabuki-neko/shared/schemas/report.schema";

/** The 18 stable report CSV columns, in order. */
export const REPORT_CSV_COLUMNS = [
  "session_id",
  "quiz_title",
  "pin_code",
  "end_reason",
  "started_at_utc",
  "ended_at_utc",
  "player_id",
  "nickname",
  "is_kicked",
  "final_rank",
  "final_score",
  "correct_count",
  "unanswered_count",
  "max_streak",
  "avg_response_time_ms",
  "accuracy_numerator",
  "accuracy_denominator",
  "accuracy",
] as const;
/** UTF-8 byte order mark written before the header. */
export const CSV_BOM = "﻿";
/** Record separator (RFC 4180). */
const CRLF = "\r\n";
/** Characters that make spreadsheet software treat a cell as a formula. */
const FORMULA = /^\s*[=+\-@]/u;
/** TAB, CR or LF at the very start of a cell (also formula/DDE vectors). */
const LEADING_CONTROL = /^[\t\r\n]/u;
/** C0/C1 controls other than TAB/CR/LF, plus DEL. */
// eslint-disable-next-line no-control-regex -- the pattern deliberately matches control characters.
const OTHER_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Session-level values repeated on every row. */
export interface CsvSession {
  id: string;
  quizTitle: string;
  pinCode: string;
  endReason: string;
  startedAt: number | null;
  endedAt: number;
}
/** One player row's values. */
export interface CsvPlayer {
  id: string;
  nickname: string;
  isKicked: boolean;
  finalRank: number | null;
  finalScore: number;
  correctCount: number;
  unansweredCount: number;
  maxStreak: number;
  avgResponseTimeMs: number | null;
  accuracy: Metric;
}

/** Download filename: stable ASCII derived from the session UUID only. */
export function reportCsvFilename(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(sessionId)) throw new Error("INVALID_FORMAT");
  return `kabuki-neko-report-${sessionId}.csv`;
}

/** RFC 4180 text cell with the formula-injection guard applied first. */
export function csvText(value: string): string {
  let text = value.replace(OTHER_CONTROLS, "�");
  if (FORMULA.test(text) || LEADING_CONTROL.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
/** Plain ASCII number with a fixed number of decimals, or an empty cell. */
export function csvDecimal(value: number | null, decimals: number): string {
  if (value === null) return "";
  if (!Number.isFinite(value)) throw new Error("INVALID_FORMAT");
  return value.toFixed(decimals);
}
/** Integer cell (empty when unavailable). */
function csvInteger(value: number | null): string {
  if (value === null) return "";
  if (!Number.isSafeInteger(value)) throw new Error("INVALID_FORMAT");
  return String(value);
}
/** ISO-8601 UTC timestamp text cell, or empty. */
function csvTime(value: number | null): string {
  return value === null ? "" : csvText(new Date(value).toISOString());
}
/** Accuracy numerator: integer as-is, fractional (partial credit) with 6 decimals. */
function csvNumerator(value: number): string {
  return Number.isInteger(value) ? csvInteger(value) : csvDecimal(value, 6);
}

/** Header record (with BOM). */
export function csvHeader(): string {
  return CSV_BOM + REPORT_CSV_COLUMNS.join(",") + CRLF;
}
/** One CRLF-terminated record for a player. */
export function csvRecord(session: CsvSession, player: CsvPlayer): string {
  const cells = [
    csvText(session.id),
    csvText(session.quizTitle),
    csvText(session.pinCode),
    csvText(session.endReason),
    csvTime(session.startedAt),
    csvTime(session.endedAt),
    csvText(player.id),
    csvText(player.nickname),
    player.isKicked ? "true" : "false",
    csvInteger(player.finalRank),
    csvInteger(player.finalScore),
    csvInteger(player.correctCount),
    csvInteger(player.unansweredCount),
    csvInteger(player.maxStreak),
    csvDecimal(player.avgResponseTimeMs, 3),
    csvNumerator(player.accuracy.numerator),
    csvInteger(player.accuracy.denominator),
    csvDecimal(player.accuracy.value, 6),
  ];
  if (cells.length !== REPORT_CSV_COLUMNS.length) throw new Error("INVALID_FORMAT");
  return cells.join(",") + CRLF;
}

/**
 * Streams the complete CSV (header, then one record per player in the given order). All data is
 * loaded before the first chunk, so a failure never produces a partial file.
 */
export function* reportCsv(session: CsvSession, players: readonly CsvPlayer[]): Generator<string> {
  yield csvHeader();
  for (const player of players) yield csvRecord(session, player);
}
