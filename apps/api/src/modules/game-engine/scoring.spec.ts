/**
 * TASK-075 coverage for deterministic scoring and ranking with the SA §5.5 diagnostic fixtures:
 * the 500 ms full-points boundary, 950/750/500 speed curve, partial 375 + streak 100 = 475,
 * wrong/POLL/multiplier-0 streak rules, Unicode text matching, puzzle public→private mapping,
 * response-time tie-breaks without floating point, leaderboard climber, and empty/1/2-winner podia.
 */
import { randomUUID } from "node:crypto";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type { ActivePlayer, ClosedQuestion } from "../../providers/state/game-state.interface";
import { buildLeaderboard, buildPodium, rankPlayers, type RankablePlayer } from "./ranking";
import {
  computeQuestionResult,
  evaluateAnswer,
  scoreAnswer,
  speedPoints,
  type PrivateQuestion,
} from "./score-calculator";

type QuestionType = PrivateQuestion["type"];

/** Builds a private question snapshot with an explicit public option order. */
function question(
  type: QuestionType,
  options: { text: string; correct: boolean; sortOrder?: number }[],
  extra: { limit?: 5 | 10 | 20 | 30; multiplier?: 0 | 1 | 2; publicOrder?: number[] } = {},
): PrivateQuestion {
  const privateOptions = options.map((option, index) => ({
    id: randomUUID(),
    optionIndex: index,
    colorIndex: type === "TYPE_ANSWER" ? 0 : index,
    optionText: option.text,
    isCorrect: option.correct,
    sortOrder: option.sortOrder ?? 0,
  }));
  const order =
    type === "TYPE_ANSWER" ? [] : (extra.publicOrder ?? privateOptions.map((_, i) => i));
  return {
    id: randomUUID(),
    orderIndex: 0,
    type,
    promptText: "Prompt",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: extra.limit ?? 20,
    pointsMultiplier: extra.multiplier ?? (type === "POLL" ? 0 : 1),
    explanationText: "Because.",
    accessibility: emptyAccessibility(),
    options: privateOptions,
    publicOptions: order.map((privateIndex, index) => ({
      id: randomUUID(),
      index,
      colorIndex: index,
      text: privateOptions[privateIndex]?.optionText ?? "",
    })),
    publicToPrivateOptionIds: order.map((privateIndex) => privateOptions[privateIndex]?.id ?? ""),
    mediaSnapshot: null,
  } as PrivateQuestion;
}
/** A ranking participant with defaults. */
function rankable(overrides: Partial<RankablePlayer> & { id: string }): RankablePlayer {
  return {
    nickname: `P-${overrides.id.slice(0, 4)}`,
    avatar: { style: "bottts", seed: "seed" },
    joinOrder: 0,
    kicked: false,
    score: 0,
    correctCount: 0,
    responseSumMs: 0,
    responseCount: 0,
    previousRank: null,
    ...overrides,
  };
}
/** An active player record with zeroed totals. */
function player(joinOrder: number, overrides: Partial<ActivePlayer> = {}): ActivePlayer {
  return {
    id: randomUUID(),
    nickname: `Player${joinOrder}`,
    nicknameKey: `player${joinOrder}`,
    avatar: { style: "bottts", seed: `s${joinOrder}` },
    joinOrder,
    joinedAt: 1,
    kickedAt: null,
    tokenHash: "a".repeat(64),
    connectionGeneration: 1,
    connected: true,
    connectionId: null,
    lastSeenAt: 1,
    score: 0,
    streak: 0,
    maxStreak: 0,
    correctCount: 0,
    responseSumMs: 0,
    responseCount: 0,
    rank: null,
    previousRank: null,
    ...overrides,
  };
}

describe("speed curve and points", () => {
  it("awards full points below 500 ms and the documented curve from 500 ms", () => {
    expect(speedPoints(1, 20, 0)).toBe(1000);
    expect(speedPoints(1, 20, 499)).toBe(1000);
    expect(speedPoints(1, 20, 500)).toBe(988);
    expect(speedPoints(1, 20, 2_000)).toBe(950);
    expect(speedPoints(1, 20, 10_000)).toBe(750);
    expect(speedPoints(1, 20, 21_000)).toBe(500);
    expect(speedPoints(2, 20, 2_000)).toBe(1900);
    expect(speedPoints(1, 20, -50)).toBe(1000);
  });

  it("scores partial multiple-select with a streak bonus (375 + 100 = 475)", () => {
    const q = question("MULTIPLE_SELECT", [
      { text: "a", correct: true },
      { text: "b", correct: true },
      { text: "c", correct: false },
    ]);
    const partial = scoreAnswer(q, 1, { answer: [0], responseTimeMs: 10_000 });
    expect(partial).toMatchObject({
      result: "PARTIAL",
      isCorrect: true,
      accuracyNumerator: 1,
      accuracyDenominator: 2,
      basePoints: 375,
      streakBonus: 100,
      pointsAwarded: 475,
      currentStreak: 2,
    });
    expect(scoreAnswer(q, 3, { answer: [0, 2], responseTimeMs: 1_000 })).toMatchObject({
      result: "INCORRECT",
      pointsAwarded: 0,
      currentStreak: 0,
    });
    expect(scoreAnswer(q, 9, { answer: [1, 0], responseTimeMs: 0 })).toMatchObject({
      result: "CORRECT",
      basePoints: 1000,
      streakBonus: 500,
      currentStreak: 10,
    });
  });

  it("applies POLL, multiplier-0, wrong, unanswered and not-eligible streak rules", () => {
    const poll = question("POLL", [
      { text: "x", correct: false },
      { text: "y", correct: false },
    ]);
    expect(scoreAnswer(poll, 4, { answer: 1, responseTimeMs: 100 })).toMatchObject({
      result: "POLL",
      isCorrect: null,
      pointsAwarded: 0,
      currentStreak: 4,
    });
    expect(scoreAnswer(poll, 4, null)).toMatchObject({ result: "UNANSWERED", currentStreak: 4 });
    const zero = question(
      "SINGLE_CHOICE",
      [
        { text: "a", correct: true },
        { text: "b", correct: false },
      ],
      { multiplier: 0 },
    );
    expect(scoreAnswer(zero, 4, { answer: 0, responseTimeMs: 100 })).toMatchObject({
      result: "CORRECT",
      pointsAwarded: 0,
      currentStreak: 0,
    });
    const single = question("SINGLE_CHOICE", [
      { text: "a", correct: true },
      { text: "b", correct: false },
    ]);
    expect(scoreAnswer(single, 4, { answer: 1, responseTimeMs: 100 })).toMatchObject({
      result: "INCORRECT",
      isCorrect: false,
      currentStreak: 0,
    });
    expect(scoreAnswer(single, 4, null)).toMatchObject({
      result: "UNANSWERED",
      isCorrect: null,
      currentStreak: 0,
    });
    expect(scoreAnswer(single, 4, null, false)).toMatchObject({
      result: "NOT_ELIGIBLE",
      currentStreak: 4,
    });
    expect(scoreAnswer(single, 0, { answer: 3, responseTimeMs: 100 }).result).toBe("INCORRECT");
  });
});

describe("answer evaluation", () => {
  it("matches typed answers with Unicode normalization and one edit for long keys", () => {
    const q = question("TYPE_ANSWER", [
      { text: "Tōkyō", correct: true },
      { text: "Cat", correct: true },
    ]);
    expect(evaluateAnswer(q, "  tōkyō ").result).toBe("CORRECT");
    expect(evaluateAnswer(q, "TŌKYŌ").result).toBe("CORRECT");
    expect(evaluateAnswer(q, "cat").result).toBe("CORRECT");
    expect(evaluateAnswer(q, "cats").result).toBe("INCORRECT");
    const long = question("TYPE_ANSWER", [{ text: "Matcha", correct: true }]);
    expect(evaluateAnswer(long, "macha").result).toBe("CORRECT");
    expect(evaluateAnswer(long, "mocho").result).toBe("INCORRECT");
    expect(evaluateAnswer(q, "Tokyo").result).toBe("INCORRECT");
  });

  it("maps shuffled puzzle indices back to the private order", () => {
    const q = question(
      "ORDER_PUZZLE",
      [
        { text: "one", correct: true, sortOrder: 0 },
        { text: "two", correct: true, sortOrder: 1 },
        { text: "three", correct: true, sortOrder: 2 },
        { text: "four", correct: true, sortOrder: 3 },
      ],
      { publicOrder: [2, 0, 3, 1] },
    );
    expect(evaluateAnswer(q, [1, 3, 0, 2]).result).toBe("CORRECT");
    expect(evaluateAnswer(q, [0, 1, 2, 3]).result).toBe("INCORRECT");
    expect(evaluateAnswer(q, [1, 1, 0, 2]).result).toBe("INCORRECT");
  });
});

describe("ranking", () => {
  it("breaks ties by correct count, average response (missing last) and join order", () => {
    const [a, b, c, d, e] = Array.from({ length: 5 }, () => randomUUID()) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const ranks = rankPlayers([
      rankable({
        id: a,
        score: 900,
        correctCount: 1,
        responseSumMs: 3_000,
        responseCount: 2,
        joinOrder: 0,
      }),
      rankable({
        id: b,
        score: 900,
        correctCount: 1,
        responseSumMs: 1_000,
        responseCount: 1,
        joinOrder: 1,
      }),
      rankable({
        id: c,
        score: 900,
        correctCount: 1,
        responseSumMs: 0,
        responseCount: 0,
        joinOrder: 2,
      }),
      rankable({
        id: d,
        score: 900,
        correctCount: 2,
        responseSumMs: 9_000,
        responseCount: 1,
        joinOrder: 3,
      }),
      rankable({ id: e, score: 1_000, kicked: true, joinOrder: 4 }),
    ]);
    expect([...ranks.entries()]).toEqual([
      [d, 1],
      [b, 2],
      [a, 3],
      [c, 4],
    ]);
    const tie = rankPlayers([
      rankable({ id: a, score: 10, responseSumMs: 2, responseCount: 2, joinOrder: 5 }),
      rankable({ id: b, score: 10, responseSumMs: 3, responseCount: 3, joinOrder: 4 }),
    ]);
    expect(tie.get(b)).toBe(1);
  });

  it("builds top five, biggest climber and empty/one/two winner podia", () => {
    expect(buildPodium([])).toEqual([]);
    const solo = randomUUID();
    expect(buildPodium([rankable({ id: solo, score: 5 })]).map((e) => e.rank)).toEqual([1]);
    const two = [
      rankable({ id: randomUUID(), score: 5 }),
      rankable({ id: randomUUID(), score: 7, joinOrder: 1 }),
    ];
    expect(buildPodium(two).map((e) => e.score)).toEqual([7, 5]);
    expect(buildPodium([rankable({ id: randomUUID(), kicked: true })])).toEqual([]);
    const players = Array.from({ length: 7 }, (_, i) =>
      rankable({ id: randomUUID(), score: i * 100, joinOrder: i, previousRank: i + 1 }),
    );
    const board = buildLeaderboard(players);
    expect(board.topPlayers).toHaveLength(5);
    expect(board.topPlayers[0]).toMatchObject({ score: 600, rank: 1, rankChange: 6 });
    expect(board.biggestClimber).toMatchObject({ playerId: players[6]?.id, ranksGained: 6 });
    expect(
      buildLeaderboard(players.map((p) => ({ ...p, previousRank: null }))).biggestClimber,
    ).toBeNull();
  });
});

describe("question result", () => {
  it("adds correctCount only for questions worth points (×0 is not counted; MJ-07)", () => {
    const zero = question(
      "SINGLE_CHOICE",
      [
        { text: "right", correct: true },
        { text: "wrong", correct: false },
      ],
      { multiplier: 0, publicOrder: [0, 1] },
    );
    const ann = player(0);
    const closed: ClosedQuestion = {
      questionIndex: 0,
      phaseVersion: 3,
      closedAt: 30_000,
      reason: "TIMER",
      hash: "c".repeat(64),
      requiredPlayerIds: [ann.id],
      eligiblePlayerIds: [ann.id],
      answers: [
        {
          playerId: ann.id,
          submissionId: randomUUID(),
          questionIndex: 0,
          questionId: zero.id,
          answer: 0,
          payloadHash: "b".repeat(64),
          receivedAt: 2_000,
          responseTimeMs: 1_000,
        },
      ],
    };
    const result = computeQuestionResult({
      question: zero,
      questionIndex: 0,
      players: { [ann.id]: ann },
      closed,
    });
    expect(result.personal[ann.id]).toMatchObject({ result: "CORRECT", pointsAwarded: 0 });
    expect(result.playerTotals[ann.id]?.correctCount).toBe(ann.correctCount);
  });

  it("computes reveal, personal results, totals and ranks deterministically", () => {
    const q = question(
      "SINGLE_CHOICE",
      [
        { text: "right", correct: true },
        { text: "wrong", correct: false },
      ],
      { publicOrder: [1, 0] },
    );
    const fast = player(0, { streak: 1 }),
      slow = player(1),
      silent = player(2, { streak: 3 }),
      late = player(3, { connected: false }),
      kicked = player(4, { kickedAt: 5 });
    const players = Object.fromEntries([fast, slow, silent, late, kicked].map((p) => [p.id, p]));
    const answer = (who: ActivePlayer, index: number, ms: number) => ({
      playerId: who.id,
      submissionId: randomUUID(),
      questionIndex: 0,
      questionId: q.id,
      answer: index,
      payloadHash: "b".repeat(64),
      receivedAt: 1_000 + ms,
      responseTimeMs: ms,
    });
    const closed: ClosedQuestion = {
      questionIndex: 0,
      phaseVersion: 3,
      closedAt: 30_000,
      reason: "TIMER",
      hash: "c".repeat(64),
      requiredPlayerIds: [fast.id, slow.id, silent.id],
      eligiblePlayerIds: [fast.id, slow.id, silent.id],
      answers: [answer(fast, 1, 2_000), answer(slow, 0, 10_000)],
    };
    const result = computeQuestionResult({ question: q, questionIndex: 0, players, closed });
    expect(result).toEqual(
      computeQuestionResult({ question: q, questionIndex: 0, players, closed }),
    );
    expect(result.reveal).toMatchObject({
      type: "SINGLE_CHOICE",
      correctOptionIds: [q.publicOptions[1]?.id],
      correctCount: 1,
      incorrectCount: 1,
      unansweredCount: 1,
      explanationText: "Because.",
    });
    expect(result.reveal.optionCounts).toEqual([
      { optionId: q.publicOptions[0]?.id, count: 1 },
      { optionId: q.publicOptions[1]?.id, count: 1 },
    ]);
    expect(result.personal[fast.id]).toMatchObject({
      result: "CORRECT",
      pointsAwarded: 1050,
      currentStreak: 2,
      totalScore: 1050,
      currentRank: 1,
      rankBehindPlayerName: null,
    });
    expect(result.personal[slow.id]).toMatchObject({
      result: "INCORRECT",
      currentRank: 2,
      rankBehindPlayerName: fast.nickname,
    });
    expect(result.personal[silent.id]).toMatchObject({ result: "UNANSWERED", currentStreak: 0 });
    expect(result.personal[late.id]).toMatchObject({ result: "NOT_ELIGIBLE" });
    expect(result.personal[kicked.id]).toBeUndefined();
    expect(result.playerTotals[kicked.id]?.rank).toBeNull();
    expect(result.playerTotals[fast.id]).toMatchObject({
      score: 1050,
      streak: 2,
      maxStreak: 2,
      correctCount: 1,
      responseSumMs: 2_000,
      responseCount: 1,
      rank: 1,
    });
    expect(result.leaderboard.topPlayers.map((entry) => entry.playerId)).toEqual([
      fast.id,
      slow.id,
      silent.id,
      late.id,
    ]);
  });
});
