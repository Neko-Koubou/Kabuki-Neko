/**
 * TASK-077 coverage: capacity plans for 1 and 5000 configured players and a 200-question
 * worst-case quiz, then fully serialized worst-case FrozenReports and host roster snapshots
 * (escaped control text answers, widest numbers/timestamps, long Unicode nicknames) must never
 * exceed the reserved bytes. Oversized public questions and impossible capacity fail explicitly.
 */
import { randomUUID } from "node:crypto";
import { ROOM_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type { QuizSnapshot } from "../../providers/state/game-state.interface";
import {
  answerBound,
  hasSeat,
  planCapacity,
  publicQuestionBytes,
  serializedBytes,
} from "./room-capacity";

type QuestionType = QuizSnapshot["questions"][number]["type"];
const TS = 9_999_999_999_999;
/** Long multi-code-point grapheme (family emoji) used for worst-case Unicode text. */
const FAMILY = "👨‍👩‍👧‍👦";
/** Worst-case JSON-escaping prompt/option text (quotes, backslashes, newlines and emoji). */
function heavyText(graphemes: number): string {
  const pattern = ['"', "\\", "\n", FAMILY];
  return Array.from({ length: graphemes }, (_, i) => pattern[i % pattern.length]).join("");
}
/** A private question snapshot with worst-case texts for its type. */
function question(type: QuestionType, index: number) {
  const count = type === "TYPE_ANSWER" ? 20 : type === "TRUE_FALSE" ? 2 : 4;
  const options = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    optionIndex: i,
    colorIndex: type === "TYPE_ANSWER" ? 0 : i,
    optionText: heavyText(250),
    isCorrect: type !== "POLL",
    sortOrder: type === "ORDER_PUZZLE" ? i : 0,
  }));
  const publicOptions =
    type === "TYPE_ANSWER"
      ? []
      : options.map((option, i) => ({
          id: randomUUID(),
          index: i,
          colorIndex: i,
          text: option.optionText,
        }));
  return {
    id: randomUUID(),
    orderIndex: index,
    type,
    promptText: heavyText(500),
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 240,
    pointsMultiplier: type === "POLL" ? 0 : 2,
    explanationText: heavyText(1_000),
    accessibility: {
      altText: heavyText(1_000),
      transcript: null,
      captions: [],
      visualDescription: null,
    },
    options,
    publicOptions,
    publicToPrivateOptionIds: type === "TYPE_ANSWER" ? [] : options.map((o) => o.id),
    mediaSnapshot: null,
  };
}
/** Quiz snapshot with the given question types. */
function quiz(types: QuestionType[]): QuizSnapshot {
  return {
    schemaVersion: 1,
    quizId: randomUUID(),
    revision: 1,
    title: heavyText(150),
    description: heavyText(500),
    bgmTrack: "random",
    coverMedia: null,
    questions: types.map((type, index) => question(type, index)),
  } as unknown as QuizSnapshot;
}
/** Worst-case serialized answer payload for a type. */
function worstAnswer(type: QuestionType): string | number | number[] {
  if (type === "TYPE_ANSWER") return "\u0001".repeat(8_000);
  if (type === "MULTIPLE_SELECT" || type === "ORDER_PUZZLE") return [3, 2, 1, 0];
  return 3;
}
/** Fully populated worst-case FrozenReport for `players` players. */
function worstReport(snapshot: QuizSnapshot, players: number) {
  const ids = Array.from({ length: players }, () => randomUUID());
  return {
    schemaVersion: 1,
    session: {
      id: randomUUID(),
      quizId: snapshot.quizId,
      quizTitleSnapshot: snapshot.title,
      quizRevision: Number.MAX_SAFE_INTEGER,
      hostId: randomUUID(),
      pinCode: "999999",
      displayMode: "PROJECTOR",
      endReason: "HOST_ENDED",
      totalPlayers: players,
      totalQuestions: snapshot.questions.length,
      playedQuestions: snapshot.questions.length,
      startedAt: TS,
      endedAt: TS,
    },
    quiz: snapshot,
    players: ids.map((id, joinOrder) => ({
      id,
      sessionId: randomUUID(),
      nickname: FAMILY.repeat(15),
      avatarStyle: "big-smile",
      avatarSeed: "x".repeat(100),
      joinOrder: 99_999 + joinOrder,
      isKicked: true,
      finalScore: 999_999_999,
      finalRank: 99_999,
      correctCount: 99_999,
      unansweredCount: 99_999,
      maxStreak: 99_999,
      avgResponseTimeMs: 999_999_999,
      joinedAt: TS,
      kickedAt: TS,
    })),
    questions: snapshot.questions.map((item, questionIndex) => ({
      questionIndex,
      sourceQuestionId: item.id,
      snapshot: item,
      status: "PLAYED",
      openedAt: TS,
      closedAt: TS,
      closeReason: "ALL_ANSWERED",
      eligiblePlayerIds: ids,
    })),
    answers: ids.flatMap((playerId) =>
      snapshot.questions.map((item, questionIndex) => ({
        playerId,
        questionIndex,
        questionId: item.id,
        submissionId: randomUUID(),
        submittedPayload: worstAnswer(item.type),
        result: "UNANSWERED",
        isCorrect: false,
        accuracyNumerator: 9_999,
        accuracyDenominator: 9_999,
        responseTimeMs: 999_999_999,
        receivedAt: TS,
        pointsAwarded: 999_999,
        streakBonusAwarded: 500,
        currentStreak: 99_999,
      })),
    ),
  };
}

it("matches the documented answer bounds", () => {
  expect(answerBound("TYPE_ANSWER")).toBe(48_002);
  expect(serializedBytes("\u0001".repeat(8_000))).toBe(48_002);
  expect(answerBound("MULTIPLE_SELECT")).toBe(32);
  expect(answerBound("ORDER_PUZZLE")).toBe(32);
  expect(answerBound("SINGLE_CHOICE")).toBe(2);
  expect(answerBound("POLL")).toBe(2);
});

it("plans 1 and 5000 configured players for a short quiz within both byte budgets", () => {
  const short = quiz(["SINGLE_CHOICE"]);
  expect(planCapacity(short, 1).maxPlayers).toBe(1);
  const plan = planCapacity(short, 5_000);
  const { baseBytes, perPlayerBytes, maxPublicQuestionBytes } = plan.reservations;
  expect(perPlayerBytes).toBe(2_048 + 1_024 + 2);
  expect(plan.maxPlayers).toBe(
    Math.floor((ROOM_LIMITS.roleSnapshotBytes - maxPublicQuestionBytes) / 1_024),
  );
  expect(plan.maxPlayers).toBeLessThan(5_000);
  expect(baseBytes + plan.maxPlayers * perPlayerBytes).toBeLessThanOrEqual(
    ROOM_LIMITS.frozenReportBytes,
  );
  expect(maxPublicQuestionBytes + plan.maxPlayers * 1_024).toBeLessThanOrEqual(
    ROOM_LIMITS.roleSnapshotBytes,
  );
  const report = worstReport(short, plan.maxPlayers);
  expect(serializedBytes(report)).toBeLessThanOrEqual(baseBytes + plan.maxPlayers * perPlayerBytes);
  const roster = Array.from({ length: plan.maxPlayers }, (_, i) => ({
    id: randomUUID(),
    nickname: FAMILY.repeat(15),
    avatar: { style: "big-smile", seed: "x".repeat(100) },
    connected: true,
    joinOrder: 99_999 + i,
  }));
  expect(serializedBytes(roster) + maxPublicQuestionBytes).toBeLessThanOrEqual(
    ROOM_LIMITS.roleSnapshotBytes,
  );
});

it("never lets a worst-case 200-question report exceed its reservation", () => {
  const types: QuestionType[] = ["TYPE_ANSWER", "MULTIPLE_SELECT", "ORDER_PUZZLE", "SINGLE_CHOICE"];
  const worst = quiz(
    Array.from({ length: 200 }, (_, i) => types[i % types.length] ?? "SINGLE_CHOICE"),
  );
  const plan = planCapacity(worst, 5_000);
  const { baseBytes, perPlayerBytes } = plan.reservations;
  expect(plan.maxPlayers).toBeGreaterThanOrEqual(1);
  expect(plan.maxPlayers).toBe(
    Math.floor((ROOM_LIMITS.frozenReportBytes - baseBytes) / perPlayerBytes),
  );
  const actual = serializedBytes(worstReport(worst, plan.maxPlayers));
  expect(actual).toBeLessThanOrEqual(baseBytes + plan.maxPlayers * perPlayerBytes);
  expect(actual).toBeLessThanOrEqual(ROOM_LIMITS.frozenReportBytes);
  for (const [index, item] of worst.questions.entries())
    expect(publicQuestionBytes(item, index, 200)).toBeLessThanOrEqual(
      plan.reservations.maxPublicQuestionBytes,
    );
}, 60_000);

it("rejects oversized public questions and impossible capacity before ACTIVE", () => {
  const huge = quiz(["SINGLE_CHOICE"]);
  const first = huge.questions[0];
  if (!first) throw new Error("missing question");
  (first.publicOptions as { text: string }[]).forEach((option) => {
    option.text = "x".repeat(140 * 1_024);
  });
  expect(() => planCapacity(huge, 200)).toThrow(
    expect.objectContaining({ errorCode: "PAYLOAD_TOO_LARGE" }),
  );
  expect(() => planCapacity(quiz(["POLL"]), 0)).toThrow(
    expect.objectContaining({ errorCode: "CAPACITY_TOO_SMALL" }),
  );
});

it("counts retained kicked players against the seat limit", () => {
  const players = Object.fromEntries(
    Array.from({ length: 3 }, (_, i) => [String(i), { kickedAt: i === 0 ? TS : null }]),
  );
  expect(hasSeat({ players: players as never, maxPlayers: 3 })).toBe(false);
  expect(hasSeat({ players: players as never, maxPlayers: 4 })).toBe(true);
});
