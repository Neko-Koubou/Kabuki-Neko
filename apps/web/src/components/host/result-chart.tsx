"use client";
/**
 * F16 answer reveal chart for host (S16) and player (S15) screens (Design §4.7, §7.3; SA §5.3;
 * US-11/13/14/18/21; TASK-155).
 *
 * - SINGLE_CHOICE, TRUE_FALSE, MULTIPLE_SELECT and POLL show one row per option in game order, as
 *   a real table. Each row has the option's fixed shape, letter, color swatch and text, a
 *   decorative bar and the exact number of players who picked it.
 *   - Bars are scaled to the largest count, never to a total. Multiple select can have more
 *     picks than players, so nothing is shown as a percentage that assumes 100%.
 *   - Correct options get a check plus the visible text "Correct answer" (never color alone).
 *   - Polls never mark anything as correct and use the neutral poll wording.
 * - TYPE_ANSWER lists the accepted answers, and ORDER_PUZZLE shows the correct order with each
 *   item's shape and letter. Both appear only here, in the reveal payload, never while answering.
 * - Outcome counts come straight from the server: correct, partly correct (multiple select, or
 *   when any exist), incorrect and no answer. The client never derives scores.
 * - Motion: the bars grow (300 ms) at the reveal-bar cue, 450 ms after the authoritative phase
 *   start, so they land with the audio engine's revealBar sound. The component never plays sound
 *   itself, so nothing is triggered twice. Labels and numbers are final immediately.
 *   - Reduced motion shows the final chart at once.
 *   - A reconnect or late render more than the cue tolerance past the cue settles without
 *     replaying.
 * - "Explanation" opens M08 when the reveal carries an explanation.
 * States:
 * - loading: no reveal yet, "Waiting for results…";
 * - empty: no eligible players;
 * - ideal: the counts;
 * - partial: nobody answered, but the key is still shown;
 * - error: stale last confirmed results with a notice.
 */
import { Check } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useState } from "react";
import { AUDIO_TIMING } from "@kabuki-neko/shared/constants/audio";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import type { PublicQuestion, Reveal } from "@kabuki-neko/shared/schemas/game.schema";
import { ActionButton } from "@/components/ui/action-button";
import { AnswerShape, SHAPE_SYMBOL } from "@/components/player/choice-answer-pad";
import { CUE_TOLERANCE_MS } from "@/hooks/useAudioEngine";
import { useLocale } from "@/providers/locale-provider";

/** Chart bar animation length (Design §7.3). */
export const CHART_ANIMATION_MS = 300;

/** Solid answer colors for swatches and bars (the same tokens as the answer pads). */
const SWATCH_CLASS = [
  "bg-[var(--answer-a)] text-[var(--answer-a-foreground)]",
  "bg-[var(--answer-b)] text-[var(--answer-b-foreground)]",
  "bg-[var(--answer-c)] text-[var(--answer-c-foreground)]",
  "bg-[var(--answer-d)] text-[var(--answer-d-foreground)]",
] as const;
const BAR_CLASS = [
  "bg-[var(--answer-a)]",
  "bg-[var(--answer-b)]",
  "bg-[var(--answer-c)]",
  "bg-[var(--answer-d)]",
] as const;

/** How a visual cue should run: animated after `delayMs`, or shown in its final state. */
export interface CuePlan {
  animate: boolean;
  delayMs: number;
}

/** A cue that is shown in its final state immediately. */
export const STATIC_CUE: CuePlan = { animate: false, delayMs: 0 };

/**
 * Plans a visual cue at `offsetMs` after the authoritative phase start, using the same tolerance
 * as the audio engine. Cues already late by more than the tolerance (reconnect, hidden tab, late
 * render) and reduced motion settle immediately instead of replaying.
 */
export function cuePlan(
  phaseStartedAt: number,
  offsetMs: number,
  now: number,
  reducedMotion: boolean,
): CuePlan {
  const late = now - (phaseStartedAt + offsetMs);
  if (reducedMotion || late > CUE_TOLERANCE_MS) return STATIC_CUE;
  return { animate: true, delayMs: Math.max(0, -late) };
}

/**
 * The cue plan for one phase, computed once per `phaseKey` (session + phaseVersion), so re-renders
 * and unchanged snapshots never restart an animation. Switching to reduced motion settles at once.
 * `reducedMotionOverride` replaces the system preference (tests, explicit F16 `reducedMotion`).
 */
export function useCuePlan(
  phaseKey: string,
  phaseStartedAt: number,
  offsetMs: number,
  now: () => number,
  reducedMotionOverride?: boolean,
): CuePlan {
  const systemReduced = useReducedMotion() ?? false;
  const reducedMotion = reducedMotionOverride ?? systemReduced;
  const [entry, setEntry] = useState(() => ({
    key: phaseKey,
    plan: cuePlan(phaseStartedAt, offsetMs, now(), reducedMotion),
  }));
  if (entry.key !== phaseKey) {
    const next = { key: phaseKey, plan: cuePlan(phaseStartedAt, offsetMs, now(), reducedMotion) };
    setEntry(next);
    return next.plan;
  }
  return reducedMotion ? STATIC_CUE : entry.plan;
}

/** Props of {@link ResultChart}. */
export interface ResultChartProps {
  question: Pick<PublicQuestion, "type" | "options">;
  /** Reveal payload of the current question (null while results are not sent yet). */
  reveal: Reveal | null;
  /** Session and phase version of the reveal phase (animations run once per key). */
  phaseKey: string;
  /** Authoritative phase start (server epoch ms). */
  phaseStartedAt: number;
  /** Server-synchronized clock (epoch ms). */
  now: () => number;
  /** The shown results are the last confirmed ones and may be out of date. */
  stale?: boolean;
  /** Opens the explanation (M08); the button shows only when an explanation exists. */
  onExplanation?: () => void;
}

/** F16: the reveal chart and outcome counts. */
export function ResultChart({
  question,
  reveal,
  phaseKey,
  phaseStartedAt,
  now,
  stale = false,
  onExplanation,
}: ResultChartProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const headingId = useId();
  const plan = useCuePlan(phaseKey, phaseStartedAt, AUDIO_TIMING.revealBarDelayMs, now);

  useEffect(() => {
    void ensureNamespaces(["host", "reports", "player", "accessibility"]);
  }, [ensureNamespaces]);

  if (!reveal)
    return (
      <p role="status" aria-live="polite" className="text-body text-muted-foreground">
        {t("reports.inventory.f16.loading")}
      </p>
    );

  const isPoll = reveal.type === "POLL";
  const counts = new Map(reveal.optionCounts.map((entry) => [entry.optionId, entry.count]));
  const correct = new Set(reveal.correctOptionIds);
  const largest = Math.max(1, ...reveal.optionCounts.map((entry) => entry.count));
  const eligible = isPoll
    ? reveal.optionCounts.reduce((sum, entry) => sum + entry.count, 0) + reveal.unansweredCount
    : reveal.correctCount + reveal.partialCount + reveal.incorrectCount + reveal.unansweredCount;
  const answered = eligible - reveal.unansweredCount;
  const byId = new Map(question.options.map((option) => [option.id, option]));

  /** Letter, shape symbol and text of an option (the same label the answer pads use). */
  const optionLabel = (option: { index: number; text: string }) => {
    const geometry = ANSWER_GEOMETRY[option.index] ?? ANSWER_GEOMETRY[0];
    return t("accessibility.game.optionLabel", {
      label: geometry.label,
      shape: SHAPE_SYMBOL[geometry.shape],
      text: option.text,
    });
  };

  /** Shape and letter tile of an option. */
  const swatch = (index: number) => (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-label font-bold ${SWATCH_CLASS[index] ?? SWATCH_CLASS[0]}`}
    >
      <AnswerShape index={index} className="size-5" />
      {(ANSWER_GEOMETRY[index] ?? ANSWER_GEOMETRY[0]).label}
    </span>
  );

  const correctBadge = (
    <span className="inline-flex items-center gap-1 text-small font-semibold text-success">
      <Check aria-hidden="true" className="size-4" />
      {t("reports.answer.correctAnswer")}
    </span>
  );

  const outcomes: { key: string; label: string; value: number }[] = isPoll
    ? [{ key: "unanswered", label: t("reports.answer.unanswered"), value: reveal.unansweredCount }]
    : [
        { key: "correct", label: t("reports.table.correct"), value: reveal.correctCount },
        ...(reveal.type === "MULTIPLE_SELECT" || reveal.partialCount > 0
          ? [{ key: "partial", label: t("reports.answer.partial"), value: reveal.partialCount }]
          : []),
        { key: "incorrect", label: t("player.result.incorrect"), value: reveal.incorrectCount },
        { key: "unanswered", label: t("reports.answer.unanswered"), value: reveal.unansweredCount },
      ];

  let body;
  if (reveal.type === "TYPE_ANSWER") {
    body = (
      <div className="flex flex-col gap-2">
        <h3 className="text-label font-semibold">{t("reports.answer.correctAnswer")}</h3>
        <ul className="flex flex-wrap gap-2">
          {reveal.acceptedTexts.map((text, index) => (
            <li
              key={`${index}-${text}`}
              dir="auto"
              className="max-w-full rounded-md border border-success bg-success-surface px-3 py-1 text-body break-words text-foreground"
            >
              {text}
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (reveal.type === "ORDER_PUZZLE") {
    body = (
      <div className="flex flex-col gap-2">
        <h3 className="text-label font-semibold">{t("reports.answer.correctAnswer")}</h3>
        <ol className="flex flex-col gap-2">
          {reveal.correctOrderIds.map((id, position) => {
            const option = byId.get(id);
            if (!option) return null;
            return (
              <li
                key={id}
                data-option-index={option.index}
                className="flex items-center gap-2 rounded-md border border-border p-2"
              >
                <span aria-hidden="true" className="w-6 text-center text-title tabular-nums">
                  {formatNumber(position + 1)}
                </span>
                {swatch(option.index)}
                <span className="sr-only">{optionLabel(option)}</span>
                <span aria-hidden="true" className="min-w-0 flex-1 text-body break-words">
                  {option.text}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  } else {
    body = (
      <table className="w-full border-separate border-spacing-y-2">
        <thead className="sr-only">
          <tr>
            <th scope="col">{t("accessibility.game.answerOption")}</th>
            <th scope="col">{t("reports.answer.answered")}</th>
          </tr>
        </thead>
        <tbody>
          {question.options.map((option) => {
            const count = counts.get(option.id) ?? 0;
            const isCorrect = !isPoll && correct.has(option.id);
            return (
              <tr key={option.id} data-option-index={option.index}>
                <th scope="row" className="pe-3 text-start align-middle font-normal">
                  <span className="flex items-start gap-2">
                    {swatch(option.index)}
                    <span className="sr-only">{optionLabel(option)}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                      <span aria-hidden="true" className="text-body break-words">
                        {option.text}
                      </span>
                      {isCorrect && correctBadge}
                    </span>
                  </span>
                </th>
                <td className="w-2/5 min-w-28 align-middle">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 flex-1 overflow-hidden rounded-pill bg-muted"
                    >
                      <motion.span
                        className={`block h-full rounded-pill ${BAR_CLASS[option.index] ?? BAR_CLASS[0]}`}
                        initial={plan.animate ? { width: "0%" } : false}
                        animate={{ width: `${(count / largest) * 100}%` }}
                        transition={{
                          delay: plan.delayMs / 1000,
                          duration: CHART_ANIMATION_MS / 1000,
                        }}
                      />
                    </span>
                    <span className="w-10 text-end text-label font-semibold tabular-nums">
                      {formatNumber(count)}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  const explanation = reveal.explanationText?.trim() ? reveal.explanationText : null;

  return (
    <section
      aria-labelledby={headingId}
      data-motion={plan.animate ? "animate" : "static"}
      className="flex flex-col gap-4"
    >
      <h2 id={headingId} className="text-title font-bold">
        {t("host.stage.reveal")}
      </h2>
      {stale && (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
        >
          {t("reports.inventory.f16.error")}
        </p>
      )}
      {isPoll && (
        <p className="text-small text-muted-foreground">{t("player.answer.pollNoPoints")}</p>
      )}
      {eligible === 0 ? (
        <p role="status" className="text-body text-muted-foreground">
          {t("host.stage.noEligiblePlayers")}
        </p>
      ) : (
        answered === 0 && (
          <p role="status" className="text-body text-muted-foreground">
            {t("host.stage.noAnswers")}
          </p>
        )
      )}
      {body}
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {outcomes.map((outcome) => (
          <div
            key={outcome.key}
            data-outcome={outcome.key}
            className="flex flex-col rounded-md border border-border p-2"
          >
            <dt className="text-small text-muted-foreground">{outcome.label}</dt>
            <dd className="text-title font-bold tabular-nums">{formatNumber(outcome.value)}</dd>
          </div>
        ))}
      </dl>
      {explanation && onExplanation && (
        <ActionButton
          variant="secondary"
          label={t("host.stage.explanation")}
          onPress={onExplanation}
          className="self-start"
        />
      )}
    </section>
  );
}
