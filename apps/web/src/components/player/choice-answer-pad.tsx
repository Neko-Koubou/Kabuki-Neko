"use client";
/**
 * F14 choice answer pad for SINGLE_CHOICE, TRUE_FALSE, POLL and MULTIPLE_SELECT
 * (Design §2.2, §4.6; SA §5.3; US-09/10/18/21; TASK-153).
 *
 * - Two to four options from the player-safe snapshot, in a 2×2 grid (two options = two cards).
 *   Each has the fixed solid color and SVG shape of its index (A ▲ red, B ◆ blue, C ● yellow with
 *   ink text, D ■ green), never tinted or swapped by theme. The accessible name always carries the
 *   letter, shape and option text ("Option A, ▲: Jakarta"), even when the card hides the text.
 * - Single choice, true/false and poll send on the first tap. Multiple select toggles options and
 *   sends with "Submit answer (n selected)" only when at least one is chosen; without a choice it
 *   explains "Choose an answer first." It never hints at how many answers are correct.
 * - Projector rooms show shapes and letters first (the text is on the shared screen); "Show
 *   question text on this device" adds the text. Streamer rooms always show the full text, and long
 *   text wraps.
 * - Locks: while submitting, once accepted, after the time is up (grace: "Time's up." while waiting
 *   for results), when answers are closed, and while offline. Nothing is sent twice, and no
 *   correctness is shown before the server's result. Polls use neutral wording.
 * States: loading (submitting), empty (no selection yet: instructions / hint), ideal (choose and
 * send), partial (accepted and waiting / grace) and error (rejected / offline lock).
 */
import { Check } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import { ActionButton } from "@/components/ui/action-button";
import { useLocale } from "@/providers/locale-provider";

/** Choice question types handled here. */
export type ChoiceType = "SINGLE_CHOICE" | "TRUE_FALSE" | "MULTIPLE_SELECT" | "POLL";

/** One option of the player-safe snapshot. */
export interface ChoiceOption {
  id: string;
  index: number;
  colorIndex: number;
  text: string;
}

/** Answer status of the current question (from the game store draft). */
export type PadStatus = "idle" | "submitting" | "accepted" | "rejected";

/** Unicode geometric symbols (announced by screen readers in the user's language). */
const SHAPE_SYMBOL = { triangle: "▲", diamond: "◆", circle: "●", square: "■" } as const;

/** CSS color tokens per answer index (solid pairs from globals.css). */
const COLOR_CLASS = [
  "bg-[var(--answer-a)] text-[var(--answer-a-foreground)]",
  "bg-[var(--answer-b)] text-[var(--answer-b-foreground)]",
  "bg-[var(--answer-c)] text-[var(--answer-c-foreground)]",
  "bg-[var(--answer-d)] text-[var(--answer-d-foreground)]",
] as const;

/** SVG shape for an answer index (fixed geometry, decorative). */
export function AnswerShape({
  index,
  className = "size-10",
}: {
  index: number;
  className?: string;
}) {
  const shape = ANSWER_GEOMETRY[index]?.shape ?? "square";
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      {shape === "triangle" && <path d="M12 3 22 20H2Z" />}
      {shape === "diamond" && <path d="M12 2 22 12 12 22 2 12Z" />}
      {shape === "circle" && <circle cx="12" cy="12" r="10" />}
      {shape === "square" && <rect x="3" y="3" width="18" height="18" rx="1" />}
    </svg>
  );
}

/** Props of {@link ChoiceAnswerPad}. */
export interface ChoiceAnswerPadProps {
  questionId: string;
  type: ChoiceType;
  options: readonly ChoiceOption[];
  displayMode: "PROJECTOR" | "STREAMER";
  status: PadStatus;
  /** Indices of the submitted/accepted answer (shown as chosen). */
  chosen?: readonly number[] | null;
  /** The server still accepts new input (before the natural deadline). */
  inputOpen: boolean;
  /** Natural deadline passed and the grace period runs (waiting for results). */
  grace?: boolean;
  /** The connection is not live: everything is locked. */
  offline?: boolean;
  /** Projector rooms: show option text on this device initially. */
  defaultShowText?: boolean;
  onSubmit: (answer: number | number[]) => void;
}

/** The choice answer pad. */
export function ChoiceAnswerPad({
  questionId,
  type,
  options,
  displayMode,
  status,
  chosen = null,
  inputOpen,
  grace = false,
  offline = false,
  defaultShowText = false,
  onSubmit,
}: ChoiceAnswerPadProps) {
  const { t, ensureNamespaces } = useLocale();
  const hintId = useId();
  const [selection, setSelection] = useState<number[]>([]);
  const [showText, setShowText] = useState(defaultShowText || displayMode === "STREAMER");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void ensureNamespaces(["player", "accessibility"]);
  }, [ensureNamespaces]);

  // A new question starts with an empty local selection.
  useEffect(() => {
    setSelection([]);
    setMissing(false);
  }, [questionId]);

  const multiple = type === "MULTIPLE_SELECT";
  const locked = status === "submitting" || status === "accepted" || !inputOpen || grace || offline;
  const marked = new Set(chosen ?? (multiple ? selection : []));
  const textVisible = displayMode === "STREAMER" || showText;

  /** One tap: single types send immediately, multiple select toggles. */
  const press = (index: number) => {
    if (locked) return;
    if (!multiple) {
      onSubmit(index);
      return;
    }
    setMissing(false);
    setSelection((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index].sort(),
    );
  };

  /** Sends a multiple-select answer (at least one option). */
  const send = () => {
    if (locked) return;
    if (selection.length === 0) {
      setMissing(true);
      return;
    }
    onSubmit([...selection]);
  };

  let statusText = "";
  if (status === "submitting") statusText = t("player.answer.submitting");
  else if (status === "accepted")
    statusText = `${t("player.answer.accepted")} ${t("player.answer.locked")}`;
  else if (grace) statusText = t("player.answer.timeExpired");
  else if (!inputOpen) statusText = t("player.answer.inputClosed");

  const instructions =
    type === "POLL"
      ? t("player.answer.pollNoPoints")
      : multiple
        ? t("player.answer.selectMultiple")
        : t("player.answer.selectOne");

  return (
    <section aria-describedby={hintId} className="flex flex-col gap-3">
      <p id={hintId} className="text-small text-muted-foreground">
        {instructions}
      </p>
      {displayMode === "PROJECTOR" && (
        <ActionButton
          variant="ghost"
          aria-pressed={showText}
          label={showText ? t("player.answer.hideText") : t("player.answer.showText")}
          onPress={() => setShowText((value) => !value)}
          className="self-start"
        />
      )}
      <div
        className={`grid gap-3 ${options.length > 2 || textVisible ? "grid-cols-1 min-[420px]:grid-cols-2" : "grid-cols-2"}`}
      >
        {options.map((option) => {
          const geometry = ANSWER_GEOMETRY[option.index] ?? ANSWER_GEOMETRY[0];
          const isMarked = marked.has(option.index);
          const name = t("accessibility.game.optionLabel", {
            label: geometry.label,
            shape: SHAPE_SYMBOL[geometry.shape],
            text: option.text,
          });
          return (
            <button
              key={option.id}
              type="button"
              aria-label={name}
              aria-pressed={isMarked}
              aria-disabled={locked || undefined}
              data-answer-index={option.index}
              onClick={() => press(option.index)}
              className={`relative flex min-h-28 items-center gap-3 rounded-md p-4 text-start font-semibold transition-transform motion-safe:active:scale-[0.98] focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-white focus-visible:ring-4 focus-visible:ring-[#18181B] ${COLOR_CLASS[option.index] ?? COLOR_CLASS[0]} ${
                isMarked
                  ? "outline outline-4 outline-offset-2 outline-[#18181B] ring-4 ring-white"
                  : ""
              } ${locked && !isMarked ? "opacity-80" : ""}`}
            >
              <AnswerShape
                index={option.index}
                className={textVisible ? "size-10 shrink-0" : "size-16 shrink-0"}
              />
              <span aria-hidden="true" className="text-title font-bold">
                {geometry.label}
              </span>
              {textVisible && (
                <span
                  aria-hidden="true"
                  className="min-w-0 text-body break-words [overflow-wrap:anywhere]"
                >
                  {option.text}
                </span>
              )}
              {isMarked && (
                <Check
                  aria-hidden="true"
                  className="absolute end-2 top-2 size-6 rounded-pill bg-white p-0.5 text-[#18181B]"
                />
              )}
            </button>
          );
        })}
      </div>
      {multiple && status !== "accepted" && (
        <ActionButton
          size="lg"
          pending={status === "submitting"}
          disabled={locked && status !== "submitting"}
          label={`${t("player.answer.submit")} (${selection.length})`}
          onPress={send}
        />
      )}
      {missing && (
        <p role="alert" className="text-small text-danger">
          {t("player.answer.noSelection")}
        </p>
      )}
      {status === "rejected" && (
        <p role="alert" className="text-small text-danger">
          {t("player.answer.inputClosed")}
        </p>
      )}
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {statusText}
      </p>
    </section>
  );
}
