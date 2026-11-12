"use client";
/**
 * F16 podium and final results for host (S16 PODIUM/FINISHED) and player (S15) screens
 * (Design §4.6, §4.7, §7.3; SA §5.5; Audio revision; US-13/14/18/21; TASK-156).
 *
 * - Shows only the server's actual winners (up to three), in server order. Ties keep their shared
 *   rank and order, and absent ranks are skipped. Nobody is invented when fewer than three players
 *   scored. Zero winners show "No winners this time." with no winner effects. Long nicknames wrap.
 * - Reveal timing has one source with the audio engine (AUDIO_TIMING), measured from the
 *   authoritative PODIUM start:
 *   - 3rd place at 1,200 ms, 2nd at 3,500 ms, 1st at 6,500 ms, with confetti of at most 2 s at the
 *     first-place cue;
 *   - the server moves to FINISHED at 8,000 ms.
 *   The component only animates; useAudioEngine plays the spotlights, buildup and victory, so
 *   nothing is triggered twice.
 * - No replay:
 *   - an entry whose cue passed more than the cue tolerance ago (reconnect, hidden tab, remount)
 *     appears in its final state;
 *   - confetti runs only when the first-place cue is seen live;
 *   - re-renders of the same phase (unchanged phaseVersion) never restart anything.
 *   FINISHED and reduced motion show every winner at once, without confetti.
 * - Desktop shows classic columns (2nd, 1st, 3rd); phones stack in final order 1, 2, 3. The DOM
 *   order is always the server order for assistive technology, and each reveal is announced
 *   ("1st place: Neko").
 * - Hosts see the report status (saving, ready with "View report", failed with retry, lost).
 *   Players never get a report link.
 * States:
 * - loading: winners not revealed yet;
 * - empty: no winners;
 * - ideal: three winners;
 * - partial: fewer than three winners or ties;
 * - error: stale results, or failed/lost report saving.
 */
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { Suspense, lazy, useEffect, useId, useState } from "react";
import { AUDIO_TIMING } from "@kabuki-neko/shared/constants/audio";
import { SCORING } from "@kabuki-neko/shared/constants/game";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { ActionButton } from "@/components/ui/action-button";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { CUE_TOLERANCE_MS } from "@/hooks/useAudioEngine";
import { useLocale } from "@/providers/locale-provider";
import { CONFETTI_MS } from "./confetti-burst";
import type { LeaderboardEntry } from "./leaderboard";

/** Confetti is its own chunk, loaded only when a live first-place reveal needs it. */
const ConfettiBurst = lazy(() => import("./confetti-burst"));

/** Reveal offset of each podium rank from the PODIUM start (shared with the audio engine). */
export const PODIUM_OFFSETS: Readonly<Record<number, number>> = {
  3: AUDIO_TIMING.podiumThirdMs,
  2: AUDIO_TIMING.podiumSecondMs,
  1: AUDIO_TIMING.podiumFirstMs,
};

/** Reveal offset of a rank (ranks without their own cue use the closest earlier one). */
export function podiumOffset(rank: number): number {
  return PODIUM_OFFSETS[rank] ?? AUDIO_TIMING.podiumThirdMs;
}

/** Visual stage of a podium entry. */
export type PodiumStage = "hidden" | "animate" | "shown";

/**
 * Stage of an entry `elapsed` ms after the PODIUM start: hidden before its cue, animated when
 * the cue is seen live (within the audio tolerance), otherwise shown in its final state.
 * `settled` (FINISHED or reduced motion) shows everything at once.
 */
export function podiumStage(rank: number, elapsed: number, settled: boolean): PodiumStage {
  if (settled) return "shown";
  const late = elapsed - podiumOffset(rank);
  if (late < 0) return "hidden";
  return late <= CUE_TOLERANCE_MS ? "animate" : "shown";
}

/** Props of {@link Podium}. */
export interface PodiumProps {
  /** Server winners (up to three), in server order. */
  podium: readonly LeaderboardEntry[];
  phase: "PODIUM" | "FINISHED";
  /** Session and phase version (effects run once per key). */
  phaseKey: string;
  /** Authoritative PODIUM phase start (server epoch ms). */
  phaseStartedAt: number;
  /** Server-synchronized clock (epoch ms). */
  now: () => number;
  role: "host" | "player";
  /** Player screens: own player id, to mark the own entry. */
  selfPlayerId?: string | null;
  /** Host only: report finalization status. */
  finalization?: FinalizeStatus | null;
  /** Host only: retry saving the report. */
  onRetryFinalize?: () => void;
  /** The shown results are the last confirmed ones and may be out of date. */
  stale?: boolean;
  /** Explicit reduced-motion preference (defaults to the system setting). */
  reducedMotion?: boolean;
}

/** Column order and pedestal height for the desktop layout, by server position. */
const COLUMN_CLASS = ["sm:order-2", "sm:order-1", "sm:order-3"] as const;
const PEDESTAL_CLASS: Readonly<Record<number, string>> = {
  1: "h-16 sm:h-40",
  2: "h-12 sm:h-28",
  3: "h-10 sm:h-20",
};

/** F16: the podium, final results and the host's report status. */
export function Podium({
  podium,
  phase,
  phaseKey,
  phaseStartedAt,
  now,
  role,
  selfPlayerId = null,
  finalization = null,
  onRetryFinalize,
  stale = false,
  reducedMotion,
}: PodiumProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const headingId = useId();
  const systemReduced = useReducedMotion() ?? false;
  const settled = phase === "FINISHED" || (reducedMotion ?? systemReduced);
  const [, setTick] = useState(0);
  const [confettiPhase, setConfettiPhase] = useState<string | null>(null);
  const winners = podium.slice(0, SCORING.podiumSize);
  const elapsed = now() - phaseStartedAt;

  useEffect(() => {
    void ensureNamespaces(["host", "reports"]);
  }, [ensureNamespaces]);

  // Confetti starts only when the first-place cue is seen live in this phase.
  const firstAt = AUDIO_TIMING.podiumFirstMs;
  const firstLive =
    !settled &&
    winners.some((entry) => entry.rank === 1) &&
    elapsed >= firstAt &&
    elapsed - firstAt <= CUE_TOLERANCE_MS;
  if (firstLive && confettiPhase !== phaseKey) setConfettiPhase(phaseKey);
  const confetti = !settled && confettiPhase === phaseKey && elapsed < firstAt + CONFETTI_MS;

  // Re-render at the next cue (or when the confetti ends); nothing runs once settled.
  useEffect(() => {
    if (settled) return;
    const upcoming = [
      ...winners.map((entry) => podiumOffset(entry.rank)),
      ...(confetti ? [firstAt + CONFETTI_MS] : []),
    ]
      .filter((offset) => offset > elapsed)
      .sort((left, right) => left - right)[0];
    if (upcoming === undefined) return;
    const timer = setTimeout(() => setTick((value) => value + 1), upcoming - elapsed);
    return () => clearTimeout(timer);
  });

  return (
    <section
      aria-labelledby={headingId}
      data-phase={phase}
      className="relative flex flex-col gap-4"
    >
      <h2 id={headingId} className="text-title font-bold">
        {phase === "FINISHED" ? t("host.stage.finished") : t("host.stage.podium")}
      </h2>
      {stale && (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
        >
          {t("reports.inventory.f16.error")}
        </p>
      )}
      {winners.length === 0 ? (
        <p role="status" className="text-body text-muted-foreground">
          {t("host.stage.noWinners")}
        </p>
      ) : (
        <ol
          aria-live="polite"
          className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-center"
        >
          {winners.map((entry, index) => {
            const stage = podiumStage(entry.rank, elapsed, settled);
            const self = entry.playerId === selfPlayerId;
            return (
              <li
                key={entry.playerId}
                data-player-id={entry.playerId}
                data-stage={stage}
                aria-hidden={stage === "hidden" || undefined}
                aria-current={self || undefined}
                className={`flex min-w-0 flex-1 flex-col items-stretch sm:max-w-56 ${COLUMN_CLASS[index] ?? ""}`}
              >
                {stage === "hidden" ? (
                  <div className="invisible min-h-24" />
                ) : (
                  <motion.div
                    initial={stage === "animate" ? { opacity: 0, y: 24, scale: 0.92 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.4 }}
                    className={`flex flex-col items-center gap-1 rounded-md p-3 text-center ${
                      self ? "bg-primary/10 ring-2 ring-primary" : ""
                    }`}
                  >
                    <p className="sr-only">
                      {t("host.stage.winner", { rank: entry.rank, nickname: entry.nickname })}
                    </p>
                    <AvatarIllustration
                      avatar={entry.avatar}
                      nickname={entry.nickname}
                      size={entry.rank === 1 ? 88 : 64}
                      decorative
                    />
                    <p aria-hidden="true" className="w-full text-body font-bold break-words">
                      <bdi>{entry.nickname}</bdi>
                    </p>
                    <dl className="flex flex-col items-center">
                      <dt className="sr-only">{t("reports.table.score")}</dt>
                      <dd className="text-label font-semibold tabular-nums">
                        {formatNumber(entry.score)}
                      </dd>
                    </dl>
                  </motion.div>
                )}
                <div
                  aria-hidden="true"
                  className={`flex items-start justify-center rounded-t-md bg-muted pt-1 text-title font-bold tabular-nums ${
                    PEDESTAL_CLASS[entry.rank] ?? PEDESTAL_CLASS[3]
                  }`}
                >
                  {formatNumber(entry.rank)}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {confetti && (
        <Suspense fallback={null}>
          <ConfettiBurst />
        </Suspense>
      )}
      {role === "host" && finalization && (
        <ReportStatus status={finalization} onRetry={onRetryFinalize} />
      )}
    </section>
  );
}

/** Host-only report status after the game (saving, ready, failed with retry, lost). */
function ReportStatus({
  status,
  onRetry,
}: {
  status: FinalizeStatus;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useLocale();
  if (status.status === "ready" && status.reportId)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-body">
          {t("host.finalization.ready")}
        </p>
        <Link
          href={`/dashboard/reports/${status.reportId}`}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
        >
          {t("host.finalization.viewReport")}
        </Link>
      </div>
    );
  if (status.status === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-body text-danger">
          {t("host.finalization.failed")}
        </p>
        {status.retryable && onRetry && (
          <ActionButton
            variant="secondary"
            label={t("host.finalization.retry")}
            onPress={onRetry}
          />
        )}
      </div>
    );
  if (status.status === "lost")
    return (
      <p role="alert" className="text-body text-danger">
        {t("host.finalization.lost")}
      </p>
    );
  return (
    <p role="status" aria-live="polite" className="text-body text-muted-foreground">
      {t("host.finalization.pending")}
    </p>
  );
}
