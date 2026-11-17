/**
 * TASK-076 leak scan for role projections: every one of the 8 phases, host and player roles,
 * PROJECTOR and STREAMER modes and a reconnect (new connection generation) are projected,
 * serialized and searched recursively for private markers — answer keys, accepted texts,
 * explanations, private option IDs/mappings, token hashes, nickname keys, connection IDs, tickets,
 * command receipts and other players' answers. Also verifies schema validity and that both display
 * modes receive identical permitted content.
 */
import { randomUUID } from "node:crypto";
import { GAME_TIMING } from "@kabuki-neko/shared/constants/game";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type {
  ActivePlayer,
  ActiveRoomState,
  ClosedQuestion,
  QuizSnapshot,
} from "../../providers/state/game-state.interface";
import { StateDomainError } from "../../providers/state/game-state.interface";
import {
  projectFinalization,
  projectHost,
  projectPlayer,
  projectPlayerPodium,
  projectPlayerReveal,
  projectRoom,
} from "./room-projector";
import { computeQuestionResult } from "./score-calculator";

type Phase = ActiveRoomState["phase"];
const PHASES: Phase[] = [
  "LOBBY",
  "GAME_START_COUNTDOWN",
  "QUESTION_PREVIEW",
  "QUESTION_ANSWERING",
  "ANSWER_REVEAL",
  "LEADERBOARD",
  "PODIUM",
  "FINISHED",
];
const NOW = 1_800_000_000_000;
const EXPLANATION = "SECRET_EXPLANATION_TEXT";
const TYPED = "SecretTypedAnswer";
const TOKEN_HASH = "e".repeat(64);
const TICKET_HASH = "f".repeat(64);

/** Private question with marker texts. */
function question(type: "SINGLE_CHOICE" | "TYPE_ANSWER" | "ORDER_PUZZLE", index: number) {
  const count = type === "TYPE_ANSWER" ? 1 : type === "ORDER_PUZZLE" ? 4 : 2;
  const options = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    optionIndex: i,
    colorIndex: type === "TYPE_ANSWER" ? 0 : i,
    optionText: type === "TYPE_ANSWER" ? TYPED : `Option ${i}`,
    isCorrect: type === "SINGLE_CHOICE" ? i === 1 : true,
    sortOrder: type === "ORDER_PUZZLE" ? i : 0,
  }));
  const order = type === "TYPE_ANSWER" ? [] : type === "ORDER_PUZZLE" ? [3, 1, 0, 2] : [1, 0];
  return {
    id: randomUUID(),
    orderIndex: index,
    type,
    promptText: `Prompt ${index}`,
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE" as const,
    timeLimitSec: 20 as const,
    pointsMultiplier: 1 as const,
    explanationText: EXPLANATION,
    accessibility: emptyAccessibility(),
    options,
    publicOptions: order.map((privateIndex, i) => ({
      id: randomUUID(),
      index: i,
      colorIndex: i,
      text: options[privateIndex]?.optionText ?? "",
    })),
    publicToPrivateOptionIds: order.map((privateIndex) => options[privateIndex]?.id ?? ""),
    mediaSnapshot: null,
  };
}
/** Player record with marker credentials. */
function player(joinOrder: number, overrides: Partial<ActivePlayer> = {}): ActivePlayer {
  return {
    id: randomUUID(),
    nickname: `Player${joinOrder}`,
    nicknameKey: `nickkey-secret-${joinOrder}`,
    avatar: { style: "bottts", seed: `seed${joinOrder}` },
    joinOrder,
    joinedAt: NOW - 60_000,
    kickedAt: null,
    tokenHash: TOKEN_HASH,
    connectionGeneration: 1,
    connected: true,
    connectionId: `conn-secret-${joinOrder}`,
    lastSeenAt: NOW,
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

const quiz: QuizSnapshot = {
  schemaVersion: 1,
  quizId: randomUUID(),
  revision: 3,
  title: "Leak scan",
  description: null,
  bgmTrack: "random",
  coverMedia: null,
  questions: [
    question("SINGLE_CHOICE", 0),
    question("TYPE_ANSWER", 1),
    question("ORDER_PUZZLE", 2),
  ],
} as QuizSnapshot;
const alice = player(0),
  bob = player(1),
  carol = player(2, { connected: false }),
  kicked = player(3, { kickedAt: NOW - 1_000 });
const players = Object.fromEntries([alice, bob, carol, kicked].map((p) => [p.id, p]));
const TYPED_INDEX = 1;
const typedQuestion = quiz.questions[TYPED_INDEX];

/** Stored answer for the typed question. */
function answer(who: ActivePlayer, text: string, ms: number) {
  return {
    playerId: who.id,
    submissionId: randomUUID(),
    questionIndex: TYPED_INDEX,
    questionId: typedQuestion?.id ?? "",
    answer: text,
    payloadHash: "a".repeat(64),
    receivedAt: NOW + ms,
    responseTimeMs: ms,
  };
}
const answers = [
  answer(alice, "secrettypedanswer", 1_200),
  answer(bob, "wrong guess", 3_000),
  answer(kicked, "x", 900),
];
const closed: ClosedQuestion = {
  questionIndex: TYPED_INDEX,
  phaseVersion: 6,
  closedAt: NOW + 21_500,
  reason: "TIMER",
  hash: "b".repeat(64),
  requiredPlayerIds: [alice.id, bob.id],
  eligiblePlayerIds: [alice.id, bob.id],
  answers: answers.filter((a) => a.playerId !== kicked.id),
};
const result = computeQuestionResult({
  question: typedQuestion as never,
  questionIndex: TYPED_INDEX,
  players,
  closed,
});

/** Timing consistent with the schema for each phase. */
function timing(phase: Phase) {
  const base = {
    phaseStartedAt: NOW,
    phaseEndsAt: null,
    questionStartedAt: null,
    inputClosesAt: null,
    acceptanceClosesAt: null,
  };
  if (phase === "GAME_START_COUNTDOWN")
    return { ...base, phaseEndsAt: NOW + GAME_TIMING.countdownMs };
  if (phase === "QUESTION_PREVIEW") return { ...base, phaseEndsAt: NOW + GAME_TIMING.previewMs };
  if (phase === "PODIUM") return { ...base, phaseEndsAt: NOW + GAME_TIMING.podiumMs };
  if (phase === "QUESTION_ANSWERING")
    return {
      ...base,
      questionStartedAt: NOW,
      inputClosesAt: NOW + 20_000,
      acceptanceClosesAt: NOW + 21_500,
    };
  return base;
}
/** A complete private room in `phase`, full of data that must never be projected. */
function room(phase: Phase, displayMode: "PROJECTOR" | "STREAMER"): ActiveRoomState {
  const revealed = ["ANSWER_REVEAL", "LEADERBOARD", "PODIUM", "FINISHED"].includes(phase);
  const withQuestion = !["LOBBY", "GAME_START_COUNTDOWN"].includes(phase);
  const totals = revealed ? result.playerTotals : {};
  return {
    schemaVersion: 1,
    sessionId: randomUUID(),
    pinCode: "246810",
    hostId: "11111111-1111-4111-8111-111111111111",
    quiz,
    displayMode,
    friendlyNicknames: true,
    isLocked: phase !== "LOBBY",
    maxPlayers: 200,
    phase,
    phaseVersion: 7,
    revision: 40,
    publicRevision: 30,
    questionIndex: withQuestion ? TYPED_INDEX : null,
    timing: timing(phase),
    createdAt: NOW - 120_000,
    hardExpiresAt: NOW + 8 * 3_600_000,
    lobbyActiveAt: NOW - 60_000,
    accepting: phase === "QUESTION_ANSWERING",
    requiredPlayerIds: withQuestion ? [alice.id, bob.id] : [],
    eligiblePlayerIds: withQuestion ? [alice.id, bob.id] : [],
    players: Object.fromEntries(
      Object.values(players).map((p) => [p.id, { ...p, ...(totals[p.id] ?? {}) }]),
    ),
    answers:
      withQuestion && phase !== "QUESTION_PREVIEW"
        ? Object.fromEntries(answers.map((a) => [`${a.questionIndex}:${a.playerId}`, a]))
        : {},
    closedQuestions: revealed ? { [String(TYPED_INDEX)]: closed } : {},
    results: revealed ? { [String(TYPED_INDEX)]: result } : {},
    commands: {
      [randomUUID()]: {
        actorId: alice.id,
        payloadHash: "d".repeat(64),
        ack: { ok: true } as never,
        createdAt: NOW,
      },
    },
    tickets: {
      [TICKET_HASH]: {
        nickname: "Friendly Fox",
        tokenHash: TICKET_HASH,
        socketId: "socket-secret",
        expiresAt: NOW + 60_000,
        consumed: false,
      },
    },
    frozenReport: null,
    finalization:
      phase === "PODIUM" || phase === "FINISHED"
        ? {
            sessionId: "",
            status: "pending",
            reportId: null,
            retryable: true,
            errorCode: null,
            updatedAt: NOW,
          }
        : null,
    endReason: phase === "PODIUM" || phase === "FINISHED" ? "COMPLETED" : null,
    reservations: { baseBytes: 1_000, perPlayerBytes: 2_048, maxPublicQuestionBytes: 4_096 },
  } as ActiveRoomState;
}
/** Recursively collects every key and string value of a serialized projection. */
function collect(value: unknown, keys: Set<string>, strings: Set<string>) {
  if (typeof value === "string") strings.add(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, keys, strings);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collect(child, keys, strings);
    }
}
const privateOptionIds = quiz.questions.flatMap((q) => q.options.map((o) => o.id));
const ALWAYS_FORBIDDEN_KEYS = [
  "sortOrder",
  "publicToPrivateOptionIds",
  "tokenHash",
  "nicknameKey",
  "connectionId",
  "tickets",
  "commands",
  "frozenReport",
  "hostId",
  "answers",
  "mediaId",
  "optionText",
];

it.each(
  PHASES.flatMap((phase) =>
    (["PROJECTOR", "STREAMER"] as const).map((mode) => [phase, mode] as const),
  ),
)("%s / %s projections expose only allowlisted data", (phase, mode) => {
  const state = room(phase, mode);
  if (state.finalization) state.finalization.sessionId = state.sessionId;
  const host = projectHost(state, state.hostId, NOW);
  const own = projectPlayer(state, alice.id, 1, NOW);
  const revealed = phase === "ANSWER_REVEAL" || phase === "LEADERBOARD";
  for (const [role, snapshot] of [
    ["host", host],
    ["player", own],
  ] as const) {
    const text = JSON.stringify(snapshot);
    const keys = new Set<string>(),
      strings = new Set<string>();
    collect(JSON.parse(text), keys, strings);
    // The only legitimate `isCorrect` is the requesting player's own PersonalResult after reveal.
    const withoutOwnResult = JSON.parse(text) as { self?: { result: unknown } };
    if (withoutOwnResult.self) withoutOwnResult.self.result = null;
    const residual = new Set<string>();
    collect(withoutOwnResult, residual, new Set());
    expect(residual.has("isCorrect")).toBe(false);
    expect(ALWAYS_FORBIDDEN_KEYS.filter((key) => keys.has(key))).toEqual([]);
    for (const marker of [
      TOKEN_HASH,
      TICKET_HASH,
      "socket-secret",
      ...privateOptionIds,
      ...Object.values(players).flatMap((p) => [p.nicknameKey, p.connectionId ?? ""]),
    ])
      expect(text).not.toContain(marker);
    expect(strings.has(EXPLANATION)).toBe(revealed);
    expect(strings.has(TYPED)).toBe(revealed);
    expect(text).not.toContain(answers[1]?.submissionId);
    expect(text).not.toContain(answers[2]?.submissionId);
    expect(snapshot.players.map((p) => p.id)).not.toContain(kicked.id);
    if (role === "host") {
      expect(text).not.toContain(answers[0]?.submissionId);
      expect(keys.has("self")).toBe(false);
    } else {
      expect(keys.has("finalization")).toBe(false);
      expect(keys.has("capabilities")).toBe(false);
    }
  }
  if (phase === "QUESTION_PREVIEW")
    expect(own.question).toMatchObject({ options: [], media: null });
  if (phase === "QUESTION_ANSWERING") {
    expect(own.question?.options).toEqual([]);
    expect(own.self.acceptedAnswer?.submissionId).toBe(answers[0]?.submissionId);
    expect(own.self.result).toBeNull();
    expect(own.self.score).toBe(0);
  }
  if (revealed) {
    expect(own.self.result?.result).toBe("CORRECT");
    expect(own.reveal?.acceptedTexts).toEqual([TYPED]);
  }
  if (phase === "PODIUM" || phase === "FINISHED") {
    expect(host.podium.map((entry) => entry.playerId)[0]).toBe(alice.id);
    expect(host.finalization?.status).toBe("pending");
  }
  const other = room(phase, mode === "PROJECTOR" ? "STREAMER" : "PROJECTOR");
  other.sessionId = state.sessionId;
  if (other.finalization) other.finalization.sessionId = state.sessionId;
  const strip = (value: object) => ({ ...value, displayMode: "_" });
  expect(strip(projectPlayer(other, alice.id, 1, NOW))).toEqual(strip(own));
  expect(strip(projectHost(other, other.hostId, NOW))).toEqual(strip(host));
});

it("exposes public puzzle options without the private order and rejects stale bindings", () => {
  const state = room("QUESTION_ANSWERING", "PROJECTOR");
  state.questionIndex = 2;
  state.answers = {};
  const puzzle = quiz.questions[2];
  const host = projectRoom(state, { role: "host", hostId: state.hostId }, NOW);
  expect(host.question?.options.map((o) => o.text)).toEqual(
    puzzle?.publicOptions.map((o) => o.text),
  );
  expect(host.question?.options.map((o) => o.id)).toEqual(puzzle?.publicOptions.map((o) => o.id));
  expect(() => projectRoom(state, { role: "host", hostId: randomUUID() }, NOW)).toThrow(
    StateDomainError,
  );
  const reconnected = room("QUESTION_ANSWERING", "PROJECTOR");
  const alicePlayer = reconnected.players[alice.id];
  if (alicePlayer) alicePlayer.connectionGeneration = 2;
  expect(() => projectPlayer(reconnected, alice.id, 1, NOW)).toThrow("SESSION_REPLACED");
  expect(projectPlayer(reconnected, alice.id, 2, NOW).self.playerId).toBe(alice.id);
  expect(() => projectPlayer(reconnected, kicked.id, 1, NOW)).toThrow("PLAYER_KICKED");
  expect(() => projectPlayer(reconnected, randomUUID(), 1, NOW)).toThrow("INVALID_SESSION_TOKEN");
});

describe("per-player reveal and podium pushes (TASK-185C)", () => {
  type QuestionType =
    "SINGLE_CHOICE" | "TRUE_FALSE" | "POLL" | "MULTIPLE_SELECT" | "TYPE_ANSWER" | "ORDER_PUZZLE";
  /** A question of any type, built from the fixture's three shapes. */
  function anyQuestion(type: QuestionType) {
    if (type === "TYPE_ANSWER" || type === "ORDER_PUZZLE") return question(type, 0);
    const base = question("SINGLE_CHOICE", 0);
    return {
      ...base,
      type,
      // A POLL is never scored (×0 by schema).
      pointsMultiplier: type === "POLL" ? 0 : base.pointsMultiplier,
      options: base.options.map((option, i) => ({
        ...option,
        isCorrect: type === "POLL" ? false : type === "MULTIPLE_SELECT" ? true : i === 1,
      })),
    };
  }
  /** What each player answered, in the stored (public index / text) form. */
  function answerFor(type: QuestionType, right: boolean): unknown {
    if (type === "TYPE_ANSWER") return right ? TYPED.toLowerCase() : "nope";
    if (type === "ORDER_PUZZLE") return right ? [2, 1, 3, 0] : [0, 1, 2, 3];
    if (type === "MULTIPLE_SELECT") return right ? [0, 1] : [0];
    return right ? 0 : 1;
  }
  /** A room at `phase` whose only played question is `type`, answered by Alice and Bob. */
  function played(type: QuestionType, phase: "ANSWER_REVEAL" | "PODIUM") {
    const q = anyQuestion(type);
    const stored = [alice, bob].map((who, i) => ({
      playerId: who.id,
      submissionId: randomUUID(),
      questionIndex: 0,
      questionId: q.id,
      answer: answerFor(type, i === 0),
      payloadHash: "a".repeat(64),
      receivedAt: NOW + 1_000 + i,
      responseTimeMs: 1_000 + i,
    }));
    const closedQuestion = {
      ...closed,
      questionIndex: 0,
      answers: stored,
    } as ClosedQuestion;
    const scored = computeQuestionResult({
      question: q as never,
      questionIndex: 0,
      players,
      closed: closedQuestion,
    });
    const state = room(phase, "STREAMER");
    if (state.finalization) state.finalization.sessionId = state.sessionId;
    return {
      ...state,
      quiz: { ...quiz, questions: [q] } as QuizSnapshot,
      questionIndex: 0,
      answers: Object.fromEntries(stored.map((a) => [`0:${a.playerId}`, a])),
      closedQuestions: { "0": closedQuestion },
      results: { "0": scored },
    } as ActiveRoomState;
  }
  const TYPES: QuestionType[] = [
    "SINGLE_CHOICE",
    "TRUE_FALSE",
    "POLL",
    "MULTIPLE_SELECT",
    "TYPE_ANSWER",
    "ORDER_PUZZLE",
  ];

  it.each(TYPES)("%s: the reveal push equals projectPlayer's reveal and own result", (type) => {
    const state = played(type, "ANSWER_REVEAL");
    const { reveal } = projectHost(state, state.hostId, NOW);
    expect(reveal).not.toBeNull();
    if (!reveal) return;
    for (const who of [alice, bob, carol]) {
      const view = projectPlayer(state, who.id, 1, NOW);
      const data = projectPlayerReveal(state, who.id, reveal);
      if (!view.self.result) expect(data).toBeNull();
      else expect(data).toEqual({ reveal: view.reveal, result: view.self.result });
    }
    // Only the player's own result: nothing about the other player's answer or score.
    const own = JSON.stringify(projectPlayerReveal(state, alice.id, reveal));
    const bobsAnswer = state.answers[`0:${bob.id}`];
    expect(own).not.toContain(bob.id);
    expect(own).not.toContain(bobsAnswer?.submissionId);
  });

  it.each(TYPES)("%s: the podium push equals projectPlayer's podium and result", (type) => {
    const state = played(type, "PODIUM");
    const { podium } = projectHost(state, state.hostId, NOW);
    for (const who of [alice, bob, carol]) {
      const view = projectPlayer(state, who.id, 1, NOW);
      expect(projectPlayerPodium(state, who.id, podium)).toEqual({
        podium: view.podium,
        result: view.self.result,
      });
    }
  });

  it("projects the host-only finalization status without the room", () => {
    const state = room("PODIUM", "PROJECTOR");
    if (state.finalization) state.finalization.sessionId = state.sessionId;
    expect(projectFinalization(state)).toEqual(projectHost(state, state.hostId, NOW).finalization);
    expect(projectFinalization(room("LOBBY", "PROJECTOR"))).toBeNull();
  });
});
