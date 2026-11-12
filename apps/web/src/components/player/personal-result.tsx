"use client";
/**
 * F16 personal result on the player's reveal screen (S15 ANSWER_REVEAL; Design §4.6, §7.3;
 * SA §5.3, §5.5; US-11/13/14/18/21; TASK-155).
 *
 * - Shows only the server's individual result:
 *   - CORRECT → "Correct!";
 *   - PARTIAL → "Partly correct", with the server's accuracy ratio;
 *   - INCORRECT → "Incorrect";
 *   - UNANSWERED → "No answer";
 *   - POLL → "Thanks for voting!";
 *   - NOT_ELIGIBLE → "You joined after this question started."
 * - Points come straight from the payload. The headline is `pointsAwarded` (e.g. +475), and the
 *   breakdown shows base points (375) and streak bonus (100). Nothing is added up on the client,
 *   so a bonus is never counted twice.
 *   - No-points questions say "No points for this question".
 *   - POLL and NOT_ELIGIBLE show no points line.
 *   - Total score, streak, rank and "Just behind …" are shown exactly as sent; nothing is guessed
 *     or animated as a count-up.
 * - Motion follows the audio engine's timing without playing any sound itself (the hook owns
 *   audio, so nothing is triggered twice):
 *   - the result icon pops at the phase start for correct, partial, incorrect and unanswered;
 *   - the streak badge pops after 350 ms when a positive result reaches a streak of 3 or more;
 *   - POLL and NOT_ELIGIBLE never get the wrong-answer motion;
 *   - no shaking or flashing;
 *   - reduced motion, re-renders of the same phase and late renders after a reconnect show the
 *     final state.
 * States:
 * - loading: no result yet, "Waiting for results…";
 * - empty: NOT_ELIGIBLE or UNANSWERED with no points;
 * - ideal: the result with points;
 * - partial: PARTIAL with its ratio;
 * - error: stale last confirmed result with a notice.
 */
import { Check, CircleSlash, Flame, Minus, Vote, X } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { AUDIO_TIMING } from "@kabuki-neko/shared/constants/audio";
import type { PersonalResult as PersonalResultData } from "@kabuki-neko/shared/schemas/game.schema";
import { useCuePlan } from "@/components/host/result-chart";
import { useLocale } from "@/providers/locale-provider";

/** Streak length from which the streak cue plays (matches the audio engine). */
export const STREAK_CUE_MIN = 3;

/** Message key, icon and tone for each result kind. */
const RESULT_VIEW: Record<
  PersonalResultData["result"],
  { key: string; icon: ReactNode; tone: string }
> = {
  CORRECT: {
    key: "player.result.correct",
    icon: <Check className="size-8" />,
    tone: "bg-success-surface text-success border-success",
  },
  PARTIAL: {
    key: "player.result.partial",
    icon: <Check className="size-8" />,
    tone: "bg-success-surface text-success border-success",
  },
  INCORRECT: {
    key: "player.result.incorrect",
    icon: <X className="size-8" />,
    tone: "bg-danger-surface text-danger border-danger",
  },
  UNANSWERED: {
    key: "player.result.unanswered",
    icon: <Minus className="size-8" />,
    tone: "bg-muted text-foreground border-border",
  },
  POLL: {
    key: "player.result.poll",
    icon: <Vote className="size-8" />,
    tone: "bg-muted text-foreground border-border",
  },
  NOT_ELIGIBLE: {
    key: "player.result.notEligible",
    icon: <CircleSlash className="size-8" />,
    tone: "bg-muted text-foreground border-border",
  },
};

/** Props of {@link PersonalResult}. */
export interface PersonalResultProps {
  /** The server's individual result (null while it is not sent yet). */
  result: PersonalResultData | null;
  /** Session and phase version of the reveal phase (motion runs once per key). */
  phaseKey: string;
  /** Authoritative phase start (server epoch ms). */
  phaseStartedAt: number;
  /** Server-synchronized clock (epoch ms). */
  now: () => number;
  /** The shown result is the last confirmed one and may be out of date. */
  stale?: boolean;
}

/** The player's own result for the revealed question. */
export function PersonalResult({
  result,
  phaseKey,
  phaseStartedAt,
  now,
  stale = false,
}: PersonalResultProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const resultCue = useCuePlan(phaseKey, phaseStartedAt, 0, now);
  const streakCue = useCuePlan(phaseKey, phaseStartedAt, AUDIO_TIMING.streakFireDelayMs, now);

  useEffect(() => {
    void ensureNamespaces(["player", "reports"]);
  }, [ensureNamespaces]);

  if (!result)
    return (
      <p role="status" aria-live="polite" className="text-body text-muted-foreground">
        {t("player.result.waitingForResults")}
      </p>
    );

  const view = RESULT_VIEW[result.result];
  const scored = result.result === "CORRECT" || result.result === "PARTIAL";
  const neutral = result.result === "POLL" || result.result === "NOT_ELIGIBLE";
  const popResult = resultCue.animate && !neutral;
  const popStreak = streakCue.animate && scored && result.currentStreak >= STREAK_CUE_MIN;

  let points: ReactNode = null;
  if (result.isNoPoints && !neutral)
    points = <p className="text-body text-muted-foreground">{t("player.result.noPoints")}</p>;
  else if (!neutral)
    points = (
      <div className="flex flex-col gap-2">
        <p className="text-display font-bold tabular-nums">
          {t("player.result.pointsAwarded", { points: result.pointsAwarded })}
        </p>
        {scored && (
          <dl className="grid grid-cols-2 gap-2">
            <div className="flex flex-col rounded-md border border-border p-2">
              <dt className="text-small text-muted-foreground">{t("reports.detail.basePoints")}</dt>
              <dd className="text-title font-bold tabular-nums">
                {formatNumber(result.basePoints)}
              </dd>
            </div>
            <div className="flex flex-col rounded-md border border-border p-2">
              <dt className="text-small text-muted-foreground">
                {t("reports.detail.streakBonus")}
              </dt>
              <dd className="text-title font-bold tabular-nums">
                {formatNumber(result.streakBonus)}
              </dd>
            </div>
          </dl>
        )}
      </div>
    );

  return (
    <section
      aria-live="polite"
      data-result={result.result}
      data-motion={popResult ? "animate" : "static"}
      className="flex flex-col gap-4"
    >
      {stale && (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
        >
          {t("reports.inventory.f16.error")}
        </p>
      )}
      <div className={`flex items-center gap-3 rounded-lg border-2 p-4 ${view.tone}`}>
        <motion.span
          aria-hidden="true"
          className="flex shrink-0"
          initial={popResult ? { scale: 0.6, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: resultCue.delayMs / 1000, duration: 0.24 }}
        >
          {view.icon}
        </motion.span>
        <div className="flex min-w-0 flex-col">
          <h2 className="text-title font-bold break-words">{t(view.key)}</h2>
          {result.result === "PARTIAL" && (
            <p className="text-small">
              {t("reports.detail.accuracyRatio", {
                numerator: result.accuracyNumerator,
                denominator: result.accuracyDenominator,
              })}
            </p>
          )}
        </div>
      </div>
      {points}
      <dl className="flex flex-col gap-1 text-body">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-muted-foreground">{t("reports.detail.totalScore")}</dt>
          <dd className="text-title font-bold tabular-nums">{formatNumber(result.totalScore)}</dd>
        </div>
      </dl>
      {result.currentStreak > 0 && (
        <motion.p
          data-streak-motion={popStreak ? "animate" : "static"}
          className="inline-flex items-center gap-2 self-start rounded-pill bg-warning-surface px-3 py-1 text-label font-semibold text-warning"
          initial={popStreak ? { scale: 0.6, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: streakCue.delayMs / 1000, duration: 0.24 }}
        >
          <Flame aria-hidden="true" className="size-5" />
          {t("player.result.streakCount", { count: result.currentStreak })}
        </motion.p>
      )}
      {result.currentRank !== null && (
        <p className="text-body font-semibold">
          {t("player.result.rankPosition", { rank: result.currentRank })}
        </p>
      )}
      {result.rankBehindPlayerName && (
        <p className="text-body text-muted-foreground break-words">
          {t("player.result.behindPlayer", { nickname: result.rankBehindPlayerName })}
        </p>
      )}
    </section>
  );
}
