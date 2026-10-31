import { z } from "zod";
import { SCORING } from "./constants/game";
import { TEXT_LIMITS } from "./constants/limits";

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const encoder = new TextEncoder();
const bidiOverrideOrIsolate = /[\u202A-\u202E\u2066-\u2069]/u;

export function normalizeText(value: string): string {
  return value.normalize("NFC");
}
export function graphemeLength(value: string): number {
  return Array.from(segmenter.segment(value)).length;
}
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
export function codePointLength(value: string): number {
  return Array.from(value).length;
}
export function nicknameKey(value: string): string {
  return normalizeText(value).trim().toLowerCase();
}
export const normalizeTextAnswer = nicknameKey;

export interface TextRules {
  readonly max: number;
  readonly min?: number;
  readonly trim?: boolean;
  readonly multiline?: boolean;
  readonly identifier?: boolean;
}

/** Checks raw controls before trim, so forbidden edge characters cannot disappear. */
export function hasForbiddenControls(
  value: string,
  rules: Pick<TextRules, "multiline" | "identifier"> = {},
): boolean {
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point !== undefined && point < 32 && !(rules.multiline && (point === 9 || point === 10)))
      return true;
  }
  return rules.identifier === true && bidiOverrideOrIsolate.test(value);
}

/** Display text only. Passwords must use passwordSchema without normalization. */
export function textSchema(rules: TextRules) {
  return z
    .string()
    .superRefine((value, ctx) => {
      if (/[\uD800-\uDFFF]/u.test(value) || hasForbiddenControls(value, rules)) {
        ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
      }
      // Check before NFC too: combining-mark abuse must not be hidden by normalization.
      if (utf8ByteLength(value) > rules.max * TEXT_LIMITS.bytesPerGrapheme) {
        ctx.addIssue({ code: "custom", message: "TOO_LONG" });
      }
    })
    .transform((value) => (rules.trim ? normalizeText(value).trim() : normalizeText(value)))
    .superRefine((value, ctx) => {
      const length = graphemeLength(value);
      if (length < (rules.min ?? 0)) ctx.addIssue({ code: "custom", message: "REQUIRED" });
      if (length > rules.max || utf8ByteLength(value) > rules.max * TEXT_LIMITS.bytesPerGrapheme) {
        ctx.addIssue({ code: "custom", message: "TOO_LONG" });
      }
    });
}

export const nicknameSchema = textSchema({
  min: 1,
  max: TEXT_LIMITS.nickname,
  trim: true,
  identifier: true,
});
export const textAnswerSchema = textSchema({ min: 1, max: TEXT_LIMITS.answer, trim: true });
export const passwordSchema = z.string().superRefine((value, ctx) => {
  const length = codePointLength(value);
  if (/[\uD800-\uDFFF]/u.test(value) || hasForbiddenControls(value))
    ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
  if (
    length < TEXT_LIMITS.passwordMinCodePoints ||
    length > TEXT_LIMITS.passwordMaxCodePoints ||
    utf8ByteLength(value) > TEXT_LIMITS.passwordBytes
  ) {
    ctx.addIssue({ code: "custom", message: "OUT_OF_RANGE" });
  }
});

/** Levenshtein <=1 on code points, in linear time and without a quadratic matrix. */
export function isWithinOneEdit(left: string, right: string): boolean {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

/** Key length controls typo tolerance; no accent folding or locale-specific case. */
export function matchesTextAnswer(input: string, correctKey: string): boolean {
  const answer = normalizeTextAnswer(input);
  const key = normalizeTextAnswer(correctKey);
  if (answer === key) return true;
  return codePointLength(key) >= SCORING.fuzzyKeyMinCodePoints && isWithinOneEdit(answer, key);
}
