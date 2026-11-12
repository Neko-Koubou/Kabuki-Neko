"use client";
/**
 * F14 typed answer input for TYPE_ANSWER questions (Design §2.2, §4.6, §7.1; SA §3.1;
 * US-09/10/18/21; TASK-154).
 *
 * - One labelled text field ("Type your answer") with a counter of user-perceived characters
 *   (extended grapheme clusters, the same `graphemeLength` the shared schema uses). The value is
 *   never truncated: CJK, emoji sequences and combining marks are kept whole, and going over the
 *   limit only marks the counter.
 * - The answer is sent explicitly with "Submit answer" or Enter. Enter while an input method editor
 *   (IME) is composing only confirms the composition and never submits. This covers
 *   `compositionstart`…`compositionend`, `isComposing` and the Safari `keyCode 229` order.
 * - Before sending, the text is validated with the shared `textAnswerSchema`:
 *   - NFC, then trim;
 *   - 1–250 graphemes and at most 8,000 UTF-8 bytes;
 *   - no control characters.
 *   The normalized string is the request payload, so later edits cannot change it.
 * - No accepted answers ever reach this component before the reveal (it has no prop for them).
 *   Nothing hints at correctness.
 * - A stored draft is restored only for the same question while it is still editable (not
 *   submitted, not accepted, input open). A new question starts from its own draft or empty.
 * - Locks: while submitting, once accepted, after answers close, during grace ("Time's up.") and
 *   while offline. The field turns read-only, keeping focus and showing the sent text, and nothing
 *   can be sent twice or after the deadline.
 * States:
 * - loading: submitting;
 * - empty: no text yet, with label and counter;
 * - ideal: typing and sending;
 * - partial: accepted and waiting, or grace;
 * - error: validation message, rejected, or offline lock.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { graphemeLength, textAnswerSchema } from "@kabuki-neko/shared/unicode";
import { ActionButton } from "@/components/ui/action-button";
import { useLocale } from "@/providers/locale-provider";
import { AnswerStatusLine, isAnswerLocked, type AnswerLockState } from "./choice-answer-pad";

/** Validation problem of a typed answer (maps to `validation.errors.*`). */
export type TextAnswerProblem = "required" | "tooLong" | "invalidFormat";

/** Result of {@link parseTextAnswer}. */
export type ParsedTextAnswer =
  { ok: true; answer: string } | { ok: false; problem: TextAnswerProblem };

/**
 * Validates and normalizes a typed answer with the shared contract (NFC → trim, 1–250 graphemes,
 * ≤8,000 bytes, no control characters). The returned string is exactly what the server receives.
 */
export function parseTextAnswer(value: string): ParsedTextAnswer {
  const result = textAnswerSchema.safeParse(value);
  if (result.success) return { ok: true, answer: result.data };
  const messages = new Set(result.error.issues.map((issue) => issue.message));
  if (messages.has("INVALID_FORMAT")) return { ok: false, problem: "invalidFormat" };
  if (messages.has("TOO_LONG")) return { ok: false, problem: "tooLong" };
  return { ok: false, problem: "required" };
}

/**
 * True when an Enter key press belongs to an IME composition and must not submit. Covers the
 * composition events, the standard `isComposing` flag and Safari's late `keyCode 229`.
 */
export function isComposingEnter(event: KeyboardEvent<HTMLInputElement>, composing: boolean) {
  return composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

/** Props of {@link TextAnswerPad}. */
export interface TextAnswerPadProps extends AnswerLockState {
  questionId: string;
  /** Text already sent for this question (shown read-only while submitting or accepted). */
  submitted?: string | null;
  /** Stored local draft of this question (restored only while it is still editable). */
  draft?: string | null;
  /** Reports every edit so the game store can keep the draft for this question. */
  onDraftChange?: (value: string) => void;
  /** Sends the normalized answer (called at most once per editable period). */
  onSubmit: (answer: string) => void;
}

/** The TYPE_ANSWER input pad. */
export function TextAnswerPad({
  questionId,
  status,
  inputOpen,
  grace = false,
  offline = false,
  submitted = null,
  draft = null,
  onDraftChange,
  onSubmit,
}: TextAnswerPadProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const inputId = useId();
  const counterId = `${inputId}-counter`;
  const errorId = `${inputId}-error`;
  const locked = isAnswerLocked({ status, inputOpen, grace, offline });
  const [value, setValue] = useState(() => (!locked && draft ? draft : ""));
  const [problem, setProblem] = useState<TextAnswerProblem | null>(null);
  const composing = useRef(false);
  const lastQuestion = useRef(questionId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void ensureNamespaces(["player", "accessibility", "validation"]);
  }, [ensureNamespaces]);

  // A new question starts from its own draft (only while editable) or empty.
  useEffect(() => {
    if (lastQuestion.current === questionId) return;
    lastQuestion.current = questionId;
    setValue(!locked && draft ? draft : "");
    setProblem(null);
  }, [questionId, locked, draft]);

  const shown = locked && submitted !== null ? submitted : value;
  const length = graphemeLength(shown);
  const overLimit = length > TEXT_LIMITS.answer;

  /** Keeps the typed text (never truncated) and reports it as the draft. */
  const change = (next: string) => {
    if (locked) return;
    setValue(next);
    if (problem) setProblem(null);
    onDraftChange?.(next);
  };

  /** Validates and sends the normalized answer once. */
  const send = () => {
    if (locked) return;
    const parsed = parseTextAnswer(value);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      inputRef.current?.focus();
      return;
    }
    onSubmit(parsed.answer);
  };

  /** Enter sends, except while an IME composition is being confirmed. */
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (isComposingEnter(event, composing.current)) return;
    send();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-label font-semibold">
          {t("player.answer.typeAnswer")}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          dir="auto"
          value={shown}
          readOnly={locked}
          aria-invalid={problem !== null || overLimit || undefined}
          aria-describedby={problem ? `${counterId} ${errorId}` : counterId}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          onChange={(event) => change(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={keyDown}
          className={`min-h-12 w-full rounded-md border bg-background px-3 py-2 text-body text-foreground read-only:bg-muted read-only:text-muted-foreground ${
            problem !== null || overLimit ? "border-danger" : "border-input"
          }`}
        />
        <p
          id={counterId}
          className={`text-small tabular-nums ${overLimit ? "text-danger" : "text-muted-foreground"}`}
        >
          <bdi>{`${formatNumber(length)} / ${formatNumber(TEXT_LIMITS.answer)}`}</bdi>
        </p>
        {problem && (
          <p id={errorId} role="alert" className="text-small text-danger">
            {t(`validation.errors.${problem}`)}
          </p>
        )}
      </div>
      {status !== "accepted" && (
        <ActionButton
          size="lg"
          pending={status === "submitting"}
          disabled={locked && status !== "submitting"}
          label={t("player.answer.submit")}
          onPress={send}
        />
      )}
      <AnswerStatusLine status={status} inputOpen={inputOpen} grace={grace} />
    </section>
  );
}
