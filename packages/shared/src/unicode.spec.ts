import { describe, expect, it } from "vitest";
import { ERROR_CODES, errorCodeSchema, internalError, safeParamsSchema } from "./errors";
import {
  codePointLength,
  graphemeLength,
  hasForbiddenControls,
  isWithinOneEdit,
  matchesTextAnswer,
  nicknameKey,
  normalizeText,
  passwordSchema,
  textSchema,
  utf8ByteLength,
} from "./unicode";

describe("Unicode boundary normalization", () => {
  it("counts joined emoji and combining sequences as graphemes, with independent byte caps", () => {
    expect(graphemeLength("👨‍👩‍👧‍👦🇮🇩e\u0301中文")).toBe(5);
    expect(codePointLength("👨‍👩‍👧‍👦")).toBe(7);
    expect(utf8ByteLength("中文")).toBe(6);
    expect(textSchema({ max: 1 }).parse("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(textSchema({ max: 1 }).safeParse("a" + "\u0301".repeat(40)).success).toBe(false);
    expect(textSchema({ max: 2 }).safeParse("中文日").success).toBe(false);
  });
  it("uses NFC and locale-independent lowercase without transliteration", () => {
    expect(normalizeText("e\u0301")).toBe("é");
    expect(nicknameKey(" E\u0301COLE ")).toBe("école");
    expect(nicknameKey("I")).toBe("i");
    expect(nicknameKey("İ")).toBe("i\u0307");
    expect(nicknameKey("北京")).toBe("北京");
    expect(nicknameKey("é")).not.toBe(nicknameKey("e"));
  });
  it("rejects controls before trimming and isolates only for identifiers", () => {
    expect(textSchema({ max: 10, trim: true }).safeParse("\tname").success).toBe(false);
    expect(textSchema({ max: 10, multiline: true }).parse("a\n\tb")).toBe("a\n\tb");
    expect(hasForbiddenControls("\r", { multiline: true })).toBe(true);
    expect(hasForbiddenControls("\0", { multiline: true })).toBe(true);
    expect(hasForbiddenControls("a\u2066b", { identifier: true })).toBe(true);
    expect(hasForbiddenControls("a\u2066b")).toBe(false);
    expect(textSchema({ max: 10 }).safeParse("\uD800").success).toBe(false);
    expect(textSchema({ min: 1, max: 10, trim: true }).safeParse("  ").success).toBe(false);
  });
  it("preserves password spaces and decomposed characters without NFC", () => {
    const password = " e\u0301 password ";
    expect(passwordSchema.parse(password)).toBe(password);
    expect(passwordSchema.parse(" ".repeat(12))).toBe(" ".repeat(12));
    expect(passwordSchema.parse("😀".repeat(128))).toBe("😀".repeat(128));
    expect(passwordSchema.safeParse("😀".repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse("short").success).toBe(false);
  });
});
describe("code-point answer matching", () => {
  it("accepts exact normalized keys and tolerates one edit only for keys >=6 code points", () => {
    expect(matchesTextAnswer(" E\u0301COLE ", "école")).toBe(true);
    expect(matchesTextAnswer("ecole", "école")).toBe(false);
    expect(matchesTextAnswer("plnet", "planet")).toBe(true);
    expect(matchesTextAnswer("planets", "planet")).toBe(true);
    expect(matchesTextAnswer("planat", "planet")).toBe(true);
    expect(matchesTextAnswer("palnet", "planet")).toBe(false);
    expect(matchesTextAnswer("😀abcd", "😀abcde")).toBe(true);
    expect(matchesTextAnswer("abcdef", "abcde")).toBe(false);
  });
  it("agrees with an independent dynamic-programming distance for short Unicode strings", () => {
    function distance(a: string, b: string): number {
      const x = Array.from(a),
        y = Array.from(b);
      let row = Array.from({ length: y.length + 1 }, (_, i) => i);
      x.forEach((char, i) => {
        const next = [i + 1];
        y.forEach((other, j) => {
          next.push(
            Math.min(
              (next[j] ?? 0) + 1,
              (row[j + 1] ?? 0) + 1,
              (row[j] ?? 0) + (char === other ? 0 : 1),
            ),
          );
        });
        row = next;
      });
      return row[y.length] ?? 0;
    }
    const words = ["", "a", "b", "😀", "aa", "ab", "ba", "a😀", "😀a", "😀😀", "aaa", "aba"];
    for (const a of words)
      for (const b of words) expect(isWithinOneEdit(a, b)).toBe(distance(a, b) <= 1);
  });
});
describe("safe error contracts", () => {
  it("has unique closed codes including capacity and credential replay outcomes", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of [
      "CAPACITY_TOO_SMALL",
      "SETUP_REQUIRED",
      "OPERATION_COMPLETED_REAUTH_REQUIRED",
      "INVITE_CODE_ALREADY_ISSUED",
    ])
      expect(errorCodeSchema.parse(code)).toBe(code);
    expect(errorCodeSchema.safeParse("SQL_PASSWORD_LEAK").success).toBe(false);
    expect(safeParamsSchema.safeParse({ password: "secret" }).success).toBe(false);
    expect(safeParamsSchema.safeParse({ actual: Infinity }).success).toBe(false);
    expect(safeParamsSchema.safeParse({ row: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it("creates a fixed generic internal response with a validated correlation ID", () => {
    expect(internalError("8a16b9fb-64e1-4e98-9daf-4bfe691d518b")).toEqual({
      statusCode: 500,
      errorCode: "INTERNAL_ERROR",
      message: "An internal error occurred",
      params: {},
      details: [],
      correlationId: "8a16b9fb-64e1-4e98-9daf-4bfe691d518b",
    });
  });
});
