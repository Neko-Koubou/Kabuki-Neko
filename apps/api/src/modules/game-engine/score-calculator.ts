/**
 * Deterministic answer evaluation and scoring (SA §5.5, ADR-07, BR-10).
 *
 * Scoring happens only after a question is frozen, from the server-persisted intake timestamp:
 * `t = max(0, receivedAt − questionStartedAt)`; `t < 500 ms` earns the full `1000 × m`, otherwise
 * `round(1000 × m × (1 − min(1, t / limit) / 2))`. Accuracy is 1 for a correct answer, `C/K` for a
 * MULTIPLE_SELECT with C of K keys and no wrong option, else 0; `basePoints = round(base ×
 * accuracy)`. A positive accuracy with m > 0 increments the streak and earns
 * `min(500, 100 × (streak − 1))` on top (never multiplied). POLL never scores and leaves the streak
 * untouched; a non-POLL m = 0 question, a wrong or a missing answer resets it. TYPE_ANSWER compares
 * NFC/trim/lowercase text exactly, then allows one code-point edit for keys of ≥ 6 code points.
 * ORDER_PUZZLE answers are public option indices mapped back to the private sort order.
 */
import { SCORING } from "@kabuki-neko/shared/constants/game";
import type { z } from "zod";
import type { personalResultSchema, revealSchema } from "@kabuki-neko/shared/schemas/game.schema";
import type { Answer } from "@kabuki-neko/shared/schemas/question.schema";
import { matchesTextAnswer } from "@kabuki-neko/shared/unicode";
import type {
  ActivePlayer,
  ClosedQuestion,
  QuestionResult,
  QuizSnapshot,
  StoredAnswer,
} from "../../providers/state/game-state.interface";
import { buildLeaderboard, orderPlayers, type RankablePlayer } from "./ranking";

export type PrivateQuestion = QuizSnapshot["questions"][number];
export type PersonalResult = z.infer<typeof personalResultSchema>;
export type Reveal = z.infer<typeof revealSchema>;
type Outcome = "CORRECT" | "PARTIAL" | "INCORRECT" | "UNANSWERED" | "POLL" | "NOT_ELIGIBLE";

/** Correctness of one answer before any timing or streak is applied. */
export interface Evaluation {
  result: Outcome;
  isCorrect: boolean | null;
  accuracyNumerator: number;
  accuracyDenominator: number;
}
/** Fully scored outcome of one player on one question. */
export interface ScoredAnswer extends Evaluation {
  basePoints: number;
  streakBonus: number;
  pointsAwarded: number;
  currentStreak: number;
  responseTimeMs: number | null;
}

/** Private option behind a public option index, or undefined for an out-of-range index. */
function privateOption(question: PrivateQuestion, publicIndex: number) {
  const id = question.publicToPrivateOptionIds[publicIndex];
  return question.options.find((option) => option.id === id);
}
/** Classifies an answer for the question type (no timing, no streak). */
export function evaluateAnswer(question: PrivateQuestion, answer: Answer): Evaluation {
  const wrong = (denominator = 1): Evaluation => ({
    result: "INCORRECT",
    isCorrect: false,
    accuracyNumerator: 0,
    accuracyDenominator: denominator,
  });
  switch (question.type) {
    case "POLL":
      return { result: "POLL", isCorrect: null, accuracyNumerator: 0, accuracyDenominator: 1 };
    case "SINGLE_CHOICE":
    case "TRUE_FALSE": {
      if (typeof answer !== "number") return wrong();
      return privateOption(question, answer)?.isCorrect
        ? { result: "CORRECT", isCorrect: true, accuracyNumerator: 1, accuracyDenominator: 1 }
        : wrong();
    }
    case "MULTIPLE_SELECT": {
      const keys = question.options.filter((option) => option.isCorrect).length;
      if (!Array.isArray(answer) || keys === 0) return wrong(Math.max(1, keys));
      let correct = 0;
      for (const index of new Set(answer)) {
        const option = privateOption(question, index);
        if (!option?.isCorrect) return wrong(keys);
        correct++;
      }
      if (correct === 0) return wrong(keys);
      return {
        result: correct === keys ? "CORRECT" : "PARTIAL",
        isCorrect: true,
        accuracyNumerator: correct,
        accuracyDenominator: keys,
      };
    }
    case "TYPE_ANSWER": {
      if (typeof answer !== "string") return wrong();
      return question.options.some(
        (option) => option.isCorrect && matchesTextAnswer(answer, option.optionText),
      )
        ? { result: "CORRECT", isCorrect: true, accuracyNumerator: 1, accuracyDenominator: 1 }
        : wrong();
    }
    case "ORDER_PUZZLE": {
      if (!Array.isArray(answer) || answer.length !== question.options.length) return wrong();
      const correct = answer.every(
        (publicIndex, position) => privateOption(question, publicIndex)?.sortOrder === position,
      );
      return correct && new Set(answer).size === answer.length
        ? { result: "CORRECT", isCorrect: true, accuracyNumerator: 1, accuracyDenominator: 1 }
        : wrong();
    }
  }
}
/** Speed-weighted base points before accuracy (already rounded). */
export function speedPoints(multiplier: number, timeLimitSec: number, responseMs: number): number {
  const full = SCORING.basePoints * multiplier;
  const t = Math.max(0, responseMs);
  if (t < SCORING.instantThresholdMs) return full;
  const fraction = Math.min(1, t / (timeLimitSec * 1000));
  return Math.round(full * (1 - fraction * SCORING.minimumSpeedFactor));
}
/** Streak bonus for a newly reached streak length. */
export function streakBonus(streak: number): number {
  return Math.min(SCORING.maximumStreakBonus, SCORING.streakBonusStep * Math.max(0, streak - 1));
}
/**
 * Scores one player's outcome. `answer` is null when an eligible player did not answer;
 * `eligible=false` produces NOT_ELIGIBLE and leaves the streak unchanged.
 */
export function scoreAnswer(
  question: PrivateQuestion,
  previousStreak: number,
  answer: { answer: Answer; responseTimeMs: number } | null,
  eligible = true,
): ScoredAnswer {
  const none = { basePoints: 0, streakBonus: 0, pointsAwarded: 0 };
  if (!eligible)
    return {
      result: "NOT_ELIGIBLE",
      isCorrect: null,
      accuracyNumerator: 0,
      accuracyDenominator: 1,
      ...none,
      currentStreak: previousStreak,
      responseTimeMs: null,
    };
  if (!answer) {
    return {
      result: "UNANSWERED",
      isCorrect: null,
      accuracyNumerator: 0,
      accuracyDenominator: 1,
      ...none,
      currentStreak: question.type === "POLL" ? previousStreak : 0,
      responseTimeMs: null,
    };
  }
  const evaluation = evaluateAnswer(question, answer.answer);
  if (evaluation.result === "POLL")
    return {
      ...evaluation,
      ...none,
      currentStreak: previousStreak,
      responseTimeMs: answer.responseTimeMs,
    };
  const multiplier = question.pointsMultiplier;
  if (evaluation.accuracyNumerator === 0 || multiplier === 0)
    return { ...evaluation, ...none, currentStreak: 0, responseTimeMs: answer.responseTimeMs };
  const base = speedPoints(multiplier, question.timeLimitSec, answer.responseTimeMs);
  const basePoints = Math.round(
    (base * evaluation.accuracyNumerator) / evaluation.accuracyDenominator,
  );
  const currentStreak = previousStreak + 1;
  const bonus = streakBonus(currentStreak);
  return {
    ...evaluation,
    basePoints,
    streakBonus: bonus,
    pointsAwarded: basePoints + bonus,
    currentStreak,
    responseTimeMs: answer.responseTimeMs,
  };
}

/** Public reveal for a frozen question (type-specific keys, counts over eligible players). */
export function buildReveal(
  question: PrivateQuestion,
  questionIndex: number,
  answers: readonly StoredAnswer[],
  outcomes: readonly Outcome[],
): Reveal {
  const publicOf = (privateId: string) =>
    question.publicOptions[question.publicToPrivateOptionIds.indexOf(privateId)]?.id;
  const counts = new Map(question.publicOptions.map((option) => [option.id, 0]));
  if (["SINGLE_CHOICE", "TRUE_FALSE", "MULTIPLE_SELECT", "POLL"].includes(question.type))
    for (const stored of answers) {
      const indices = Array.isArray(stored.answer) ? stored.answer : [stored.answer];
      for (const index of new Set(indices)) {
        const option = typeof index === "number" ? question.publicOptions[index] : undefined;
        if (option) counts.set(option.id, (counts.get(option.id) ?? 0) + 1);
      }
    }
  const tally = (wanted: Outcome) => outcomes.filter((outcome) => outcome === wanted).length;
  const correctOptionIds = ["SINGLE_CHOICE", "TRUE_FALSE", "MULTIPLE_SELECT"].includes(
    question.type,
  )
    ? question.options
        .filter((option) => option.isCorrect)
        .map((option) => publicOf(option.id))
        .filter((id): id is string => id !== undefined)
    : [];
  return {
    questionIndex,
    type: question.type,
    correctOptionIds,
    acceptedTexts:
      question.type === "TYPE_ANSWER"
        ? question.options.filter((option) => option.isCorrect).map((option) => option.optionText)
        : [],
    correctOrderIds:
      question.type === "ORDER_PUZZLE"
        ? [...question.options]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((option) => publicOf(option.id))
            .filter((id): id is string => id !== undefined)
        : [],
    optionCounts:
      question.type === "TYPE_ANSWER" || question.type === "ORDER_PUZZLE"
        ? []
        : question.publicOptions.map((option) => ({
            optionId: option.id,
            count: counts.get(option.id) ?? 0,
          })),
    correctCount: question.type === "POLL" ? 0 : tally("CORRECT"),
    partialCount: question.type === "POLL" ? 0 : tally("PARTIAL"),
    incorrectCount: question.type === "POLL" ? 0 : tally("INCORRECT"),
    unansweredCount: tally("UNANSWERED"),
    explanationText: question.explanationText,
  } as Reveal;
}

/**
 * Complete result of a frozen question: reveal, personal results for every non-kicked player,
 * updated totals for every player (kicked players keep their history but no rank) and the
 * leaderboard. Pure and deterministic, so any worker can recompute it after a crash.
 */
export function computeQuestionResult(input: {
  question: PrivateQuestion;
  questionIndex: number;
  players: Readonly<Record<string, ActivePlayer>>;
  closed: Readonly<ClosedQuestion>;
}): QuestionResult {
  const { question, questionIndex, players, closed } = input;
  const eligible = new Set(closed.eligiblePlayerIds);
  const byPlayer = new Map(closed.answers.map((answer) => [answer.playerId, answer]));
  const scored = new Map<string, ScoredAnswer>();
  for (const player of Object.values(players)) {
    if (player.kickedAt !== null && !byPlayer.has(player.id)) continue;
    const stored = byPlayer.get(player.id);
    scored.set(
      player.id,
      scoreAnswer(
        question,
        player.streak,
        stored ? { answer: stored.answer, responseTimeMs: stored.responseTimeMs } : null,
        eligible.has(player.id),
      ),
    );
  }
  const totals: QuestionResult["playerTotals"] = {};
  const rankable: RankablePlayer[] = [];
  for (const player of Object.values(players)) {
    const outcome = scored.get(player.id);
    const answered = outcome?.responseTimeMs ?? null;
    const next = {
      score: player.score + (outcome?.pointsAwarded ?? 0),
      streak: outcome ? outcome.currentStreak : player.streak,
      maxStreak: Math.max(player.maxStreak, outcome?.currentStreak ?? 0),
      correctCount: player.correctCount + (outcome?.isCorrect === true ? 1 : 0),
      responseSumMs: player.responseSumMs + (answered ?? 0),
      responseCount: player.responseCount + (answered === null ? 0 : 1),
      rank: player.rank,
      previousRank: player.rank,
    };
    totals[player.id] = next;
    rankable.push({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      joinOrder: player.joinOrder,
      kicked: player.kickedAt !== null,
      score: next.score,
      correctCount: next.correctCount,
      responseSumMs: next.responseSumMs,
      responseCount: next.responseCount,
      previousRank: player.rank,
    });
  }
  const ordered = orderPlayers(rankable);
  ordered.forEach((player, index) => {
    const total = totals[player.id];
    if (total) total.rank = index + 1;
  });
  for (const player of Object.values(players))
    if (player.kickedAt !== null) {
      const total = totals[player.id];
      if (total) total.rank = null;
    }
  const personal: QuestionResult["personal"] = {};
  for (const player of Object.values(players)) {
    const outcome = scored.get(player.id);
    const total = totals[player.id];
    if (player.kickedAt !== null || !outcome || !total) continue;
    const position = ordered.findIndex((candidate) => candidate.id === player.id);
    const ahead = position > 0 ? ordered[position - 1] : undefined;
    const result: PersonalResult = {
      result: outcome.result,
      isCorrect: outcome.isCorrect,
      accuracyNumerator: outcome.accuracyNumerator,
      accuracyDenominator: outcome.accuracyDenominator,
      basePoints: outcome.basePoints,
      streakBonus: outcome.streakBonus,
      pointsAwarded: outcome.pointsAwarded,
      currentStreak: outcome.currentStreak,
      totalScore: total.score,
      currentRank: total.rank,
      rankBehindPlayerName: ahead?.nickname ?? null,
      isNoPoints: question.type === "POLL" || question.pointsMultiplier === 0,
    };
    personal[player.id] = result;
  }
  const outcomes = closed.eligiblePlayerIds
    .map((id) => scored.get(id)?.result)
    .filter((result): result is Outcome => result !== undefined);
  return {
    questionIndex,
    reveal: buildReveal(question, questionIndex, closed.answers, outcomes),
    personal,
    leaderboard: buildLeaderboard(rankable),
    playerTotals: totals,
  };
}
