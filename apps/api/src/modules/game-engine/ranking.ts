/**
 * Deterministic server-side ranking (SA §5.5).
 *
 * Order: score DESC, correctCount DESC, average accepted response time ASC (players without any
 * accepted response last), joinOrder ASC. Averages are compared with integer cross-products
 * (`aSum * bCount` vs `bSum * aCount`) so floating-point rounding can never reorder ties. Ranks are
 * sequential 1..N over non-kicked players only. The leaderboard shows the top five with rank
 * changes and at most one "biggest climber"; the podium has up to three real players — never
 * synthetic winners.
 */
import { SCORING } from "@kabuki-neko/shared/constants/game";
import type { z } from "zod";
import type {
  leaderboardEntrySchema,
  leaderboardSchema,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { avatarSchema } from "@kabuki-neko/shared/schemas/users.schema";

export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;
export type Leaderboard = z.infer<typeof leaderboardSchema>;

/** The ranking-relevant view of one player. */
export interface RankablePlayer {
  id: string;
  nickname: string;
  avatar: z.infer<typeof avatarSchema>;
  joinOrder: number;
  kicked: boolean;
  score: number;
  correctCount: number;
  responseSumMs: number;
  responseCount: number;
  /** Rank after the previous ranked question; null before the first ranking. */
  previousRank: number | null;
}

/** Compares average response times without division; missing averages sort last. */
function compareAverage(a: RankablePlayer, b: RankablePlayer): number {
  if (a.responseCount === 0 || b.responseCount === 0)
    return (a.responseCount === 0 ? 1 : 0) - (b.responseCount === 0 ? 1 : 0);
  return a.responseSumMs * b.responseCount - b.responseSumMs * a.responseCount;
}
/** Total order used for every ranking decision. */
export function compareRank(a: RankablePlayer, b: RankablePlayer): number {
  return (
    b.score - a.score ||
    b.correctCount - a.correctCount ||
    compareAverage(a, b) ||
    a.joinOrder - b.joinOrder
  );
}
/** Non-kicked players in rank order. */
export function orderPlayers(players: readonly RankablePlayer[]): RankablePlayer[] {
  return players.filter((player) => !player.kicked).sort(compareRank);
}
/** Sequential ranks 1..N for non-kicked players; kicked players are absent from the map. */
export function rankPlayers(players: readonly RankablePlayer[]): Map<string, number> {
  return new Map(orderPlayers(players).map((player, index) => [player.id, index + 1]));
}
/** Leaderboard entry for an already-ranked player. */
function entry(player: RankablePlayer, rank: number): LeaderboardEntry {
  return {
    playerId: player.id,
    nickname: player.nickname,
    avatar: player.avatar,
    score: player.score,
    rank,
    rankChange: player.previousRank === null ? 0 : player.previousRank - rank,
    correctCount: player.correctCount,
  };
}
/**
 * Top-five leaderboard plus the biggest positive climber (largest previousRank − rank; ties by
 * current rank then join order). No climber on the first ranking or without improvement.
 */
export function buildLeaderboard(players: readonly RankablePlayer[]): Leaderboard {
  const ordered = orderPlayers(players);
  let climber: { player: RankablePlayer; rank: number; gained: number } | null = null;
  ordered.forEach((player, index) => {
    const rank = index + 1;
    if (player.previousRank === null) return;
    const gained = player.previousRank - rank;
    if (gained <= 0) return;
    if (
      !climber ||
      gained > climber.gained ||
      (gained === climber.gained &&
        (rank < climber.rank ||
          (rank === climber.rank && player.joinOrder < climber.player.joinOrder)))
    )
      climber = { player, rank, gained };
  });
  const found = climber as { player: RankablePlayer; rank: number; gained: number } | null;
  return {
    topPlayers: ordered
      .slice(0, SCORING.leaderboardSize)
      .map((player, index) => entry(player, index + 1)),
    biggestClimber: found
      ? { playerId: found.player.id, nickname: found.player.nickname, ranksGained: found.gained }
      : null,
  };
}
/** Up to three real winners in rank order (empty when nobody is ranked). */
export function buildPodium(players: readonly RankablePlayer[]): LeaderboardEntry[] {
  return orderPlayers(players)
    .slice(0, SCORING.podiumSize)
    .map((player, index) => entry(player, index + 1));
}
