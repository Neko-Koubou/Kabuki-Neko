"use client";
/**
 * F16 leaderboard with the biggest climber for host (S16 LEADERBOARD) and player (S15) screens
 * (Design §4.6, §4.7, §7.3; SA §5.5; US-13/18/21; TASK-156).
 *
 * - Renders the server's top five exactly in the order sent. Scores are never re-sorted and ties
 *   keep their shared rank and server order. Each row has the rank, a decorative avatar, the
 *   nickname (wraps and is bidi-isolated), the score, and the rank change since the previous
 *   question (arrow plus signed number; zero shows a dash).
 * - "Biggest climber: Neko, up 3 places" comes from the server's `biggestClimber` only.
 * - Player screens can mark their own row (`aria-current`) and show "You're in 7th place" from the
 *   server rank, also outside the top five.
 * - Motion: rows fade in within 300 ms at the phase start. Reduced motion, re-renders of the same
 *   phase and late renders after a reconnect show the final list immediately.
 * States:
 * - loading: no leaderboard yet;
 * - empty: no ranked players;
 * - ideal: up to five rows;
 * - partial: fewer than five players or ties;
 * - error: stale last confirmed leaderboard with a notice.
 */
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { motion } from "framer-motion";
import { useEffect, useId } from "react";
import { SCORING } from "@kabuki-neko/shared/constants/game";
import type { leaderboardSchema } from "@kabuki-neko/shared/schemas/game.schema";
import type { z } from "zod";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { useLocale } from "@/providers/locale-provider";
import { CHART_ANIMATION_MS, useCuePlan } from "./result-chart";

/** Leaderboard payload of the LEADERBOARD phase. */
export type LeaderboardData = z.infer<typeof leaderboardSchema>;
/** One ranked entry (also used by the podium). */
export type LeaderboardEntry = LeaderboardData["topPlayers"][number];

/** Props of {@link Leaderboard}. */
export interface LeaderboardProps {
  /** Server leaderboard (null while it is not sent yet). */
  leaderboard: LeaderboardData | null;
  /** Session and phase version (motion runs once per key). */
  phaseKey: string;
  /** Authoritative phase start (server epoch ms). */
  phaseStartedAt: number;
  /** Server-synchronized clock (epoch ms). */
  now: () => number;
  /** Player screens: own player id, to mark the own row. */
  selfPlayerId?: string | null;
  /** Player screens: own server rank (shown even outside the top five). */
  selfRank?: number | null;
  /** The shown leaderboard is the last confirmed one and may be out of date. */
  stale?: boolean;
  /** Explicit reduced-motion preference (defaults to the system setting). */
  reducedMotion?: boolean;
}

/** F16: the top-five leaderboard and biggest climber. */
export function Leaderboard({
  leaderboard,
  phaseKey,
  phaseStartedAt,
  now,
  selfPlayerId = null,
  selfRank = null,
  stale = false,
  reducedMotion,
}: LeaderboardProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const headingId = useId();
  const plan = useCuePlan(phaseKey, phaseStartedAt, 0, now, reducedMotion);

  useEffect(() => {
    void ensureNamespaces(["host", "player", "reports"]);
  }, [ensureNamespaces]);

  if (!leaderboard)
    return (
      <p role="status" aria-live="polite" className="text-body text-muted-foreground">
        {t("reports.inventory.f16.loading")}
      </p>
    );

  const rows = leaderboard.topPlayers.slice(0, SCORING.leaderboardSize);
  const stagger = rows.length > 1 ? CHART_ANIMATION_MS / 2 / (rows.length - 1) : 0;

  return (
    <section
      aria-labelledby={headingId}
      data-motion={plan.animate ? "animate" : "static"}
      className="flex flex-col gap-4"
    >
      <h2 id={headingId} className="text-title font-bold">
        {t("host.stage.leaderboard")}
      </h2>
      {stale && (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
        >
          {t("reports.inventory.f16.error")}
        </p>
      )}
      {selfRank !== null && (
        <p className="text-body font-semibold">
          {t("player.result.rankPosition", { rank: selfRank })}
        </p>
      )}
      {rows.length === 0 ? (
        <p role="status" className="text-body text-muted-foreground">
          {t("reports.inventory.f16.empty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rows.map((entry, index) => {
            const self = entry.playerId === selfPlayerId;
            return (
              <motion.li
                key={entry.playerId}
                data-player-id={entry.playerId}
                aria-current={self || undefined}
                initial={plan.animate ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: (plan.delayMs + index * stagger) / 1000,
                  duration: CHART_ANIMATION_MS / 2 / 1000,
                }}
                className={`flex items-center gap-3 rounded-md border p-2 ${
                  self ? "border-primary bg-primary/10 ring-2 ring-primary" : "border-border"
                }`}
              >
                <span className="w-8 shrink-0 text-center text-title font-bold tabular-nums">
                  {formatNumber(entry.rank)}
                </span>
                <AvatarIllustration
                  avatar={entry.avatar}
                  nickname={entry.nickname}
                  size={40}
                  decorative
                />
                <span className="min-w-0 flex-1 text-body font-semibold break-words">
                  <bdi>{entry.nickname}</bdi>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="text-label font-bold tabular-nums">
                    {formatNumber(entry.score)}
                  </span>
                  <RankChange change={entry.rankChange} format={formatNumber} />
                </span>
              </motion.li>
            );
          })}
        </ol>
      )}
      {leaderboard.biggestClimber && (
        <p className="rounded-md bg-success-surface p-3 text-body font-semibold text-success break-words">
          {t("host.stage.biggestClimber", {
            nickname: leaderboard.biggestClimber.nickname,
            places: leaderboard.biggestClimber.ranksGained,
          })}
        </p>
      )}
    </section>
  );
}

/** Rank change since the previous question: arrow plus signed number (positive = moved up). */
function RankChange({
  change,
  format,
}: {
  change: number;
  format: (value: number, options?: Intl.NumberFormatOptions) => string;
}) {
  const Icon = change > 0 ? ArrowUp : change < 0 ? ArrowDown : Minus;
  const tone = change > 0 ? "text-success" : change < 0 ? "text-danger" : "text-muted-foreground";
  return (
    <span
      data-rank-change={change}
      className={`inline-flex items-center gap-0.5 text-small ${tone}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {change !== 0 && (
        <span className="tabular-nums">{format(change, { signDisplay: "always" })}</span>
      )}
    </span>
  );
}
