/**
 * TASK-127 coverage for the game store: reordered pushes (stale revisions, duplicates, stale
 * phases, out-of-order revisions within a phase), distinct events and role projections sharing one
 * revision, a new session that reuses the PIN (fences and drafts reset, old-session events dropped),
 * accepted-answer recovery after reconnect (locked, never re-sent) and the retry window, heartbeat
 * driven sync intent, phase timing derived from timing-less pushes, terminal events, no optimistic phase/score, and a store that survives React
 * remounts and locale providers. Fixtures are validated with the shared room schemas.
 */
import { act, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { GAME_TIMING } from "@kabuki-neko/shared/constants/game";
import {
  hostRoomSyncSchema,
  playerRoomSyncSchema,
  type HostRoomSync,
  type PlayerRoomSync,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { PushEnvelope } from "@kabuki-neko/shared/socket-events";
import { renderWithLocale } from "@/test/locale";
import {
  HEARTBEAT_STALE_MS,
  createGameStore,
  currentDraft,
  draftKey,
  retryableSubmission,
  useGame,
} from "./game.store";

const SESSION_A = "1a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const SESSION_B = "2a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const PLAYER = "3a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const QUESTION = "4a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const OPTIONS = ["5a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e50", "5a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e51"];
const SUBMISSION = "6a0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const PIN = "123456";
const T0 = 1_700_000_000_000;

/** Fresh UUID-shaped event id. */
let counter = 0;
function eventId() {
  counter += 1;
  return `7a0c2f7e-3d1a-4c6b-8e9f-${String(counter).padStart(12, "0")}`;
}

/** Shared room fields for a session in a phase. */
function room(sessionId: string, revision: number, phaseVersion: number, answering: boolean) {
  const question = {
    id: QUESTION,
    questionIndex: 0,
    totalQuestions: 2,
    type: "TRUE_FALSE" as const,
    promptText: "Tokyo is the capital of Japan.",
    pointsMultiplier: 1 as const,
    timeLimitSec: 20 as const,
    media: null,
    options: OPTIONS.map((id, index) => ({
      id,
      index,
      colorIndex: index,
      text: index === 0 ? "True" : "False",
    })),
  };
  return {
    sessionId,
    pinCode: PIN,
    revision,
    publicRevision: revision,
    phaseVersion,
    serverTime: T0,
    quizTitle: "Capitals",
    totalQuestions: 2,
    displayMode: "PROJECTOR" as const,
    friendlyNicknames: false,
    isLocked: false,
    maxPlayers: 50,
    players: [
      {
        id: PLAYER,
        nickname: "Ayu",
        avatar: { style: "bottts" as const, seed: "ayu" },
        connected: true,
        joinOrder: 1,
      },
    ],
    question: answering ? question : null,
    timing: answering
      ? {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 20_000 + GAME_TIMING.graceMs,
          questionStartedAt: T0,
          inputClosesAt: T0 + 20_000,
          acceptanceClosesAt: T0 + 20_000 + GAME_TIMING.graceMs,
        }
      : {
          phaseStartedAt: T0,
          phaseEndsAt: null,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
    reveal: null,
    leaderboard: null,
    podium: [],
    endReason: null,
    phase: answering ? ("QUESTION_ANSWERING" as const) : ("LOBBY" as const),
  };
}

/** Validated player snapshot. */
function playerSnapshot(
  options: {
    sessionId?: string;
    revision?: number;
    phaseVersion?: number;
    answering?: boolean;
    accepted?: boolean;
  } = {},
): PlayerRoomSync {
  const {
    sessionId = SESSION_A,
    revision = 10,
    phaseVersion = 3,
    answering = true,
    accepted = false,
  } = options;
  return playerRoomSyncSchema.parse({
    ...room(sessionId, revision, phaseVersion, answering),
    role: "player",
    self: {
      playerId: PLAYER,
      score: 0,
      streak: 0,
      rank: null,
      acceptedAnswer: accepted
        ? { submissionId: SUBMISSION, questionIndex: 0, receivedAt: T0 + 3_000, answer: 0 }
        : null,
      result: null,
    },
  });
}

/** Validated host snapshot. */
function hostSnapshot(revision = 10, phaseVersion = 3): HostRoomSync {
  return hostRoomSyncSchema.parse({
    ...room(SESSION_A, revision, phaseVersion, true),
    role: "host",
    bgmTrack: "kabuki",
    answeredCount: 0,
    eligibleCount: 1,
    finalization: null,
    capabilities: {
      canStart: false,
      canLock: false,
      canKick: true,
      canSkip: true,
      canNext: false,
      canEnd: true,
    },
  });
}

/** Push envelope. */
function push<T>(
  data: T,
  revision: number,
  phaseVersion: number,
  options: { sessionId?: string; id?: string } = {},
): PushEnvelope<T> {
  return {
    protocolVersion: 1,
    sessionId: options.sessionId ?? SESSION_A,
    pinCode: PIN,
    phaseVersion,
    revision,
    serverTime: T0 + revision,
    eventId: options.id ?? eventId(),
    data,
  };
}

const reveal = {
  questionIndex: 0,
  type: "TRUE_FALSE" as const,
  correctOptionIds: [OPTIONS[0]],
  acceptedTexts: [],
  correctOrderIds: [],
  optionCounts: [],
  correctCount: 1,
  partialCount: 0,
  incorrectCount: 0,
  unansweredCount: 0,
  explanationText: null,
};
const result = {
  result: "CORRECT" as const,
  isCorrect: true,
  accuracyNumerator: 1,
  accuracyDenominator: 1,
  basePoints: 950,
  streakBonus: 0,
  pointsAwarded: 950,
  currentStreak: 1,
  totalScore: 950,
  currentRank: 1,
  rankBehindPlayerName: null,
  isNoPoints: false,
};

describe("event fencing", () => {
  it("drops stale, duplicate and stale-phase pushes and never moves the phase backwards", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot({ revision: 10, phaseVersion: 3 }));
    const apply = (name: string, envelope: PushEnvelope<unknown>) =>
      store.getState().applyEvent(name, envelope);

    expect(
      apply("room:presence_changed", push({ playerId: PLAYER, connected: false }, 10, 3)),
    ).toEqual({ applied: false, reason: "stale-revision" });
    expect(
      apply("room:presence_changed", push({ playerId: PLAYER, connected: false }, 9, 3)),
    ).toEqual({ applied: false, reason: "stale-revision" });
    const presence = push({ playerId: PLAYER, connected: false }, 12, 3);
    expect(apply("room:presence_changed", presence)).toEqual({ applied: true });
    expect(apply("room:presence_changed", presence)).toEqual({
      applied: false,
      reason: "duplicate",
    });
    // Revisions need not arrive in order within a phase.
    expect(apply("room:lock_changed", push({ isLocked: true }, 11, 3))).toEqual({ applied: true });
    expect(store.getState().snapshot?.isLocked).toBe(true);

    expect(apply("game:answer_reveal", push({ reveal, result }, 13, 4))).toEqual({ applied: true });
    expect(store.getState().snapshot?.phase).toBe("ANSWER_REVEAL");
    // A late push from the previous phase must not rewind it.
    const lateAnswering = push(
      {
        question: store.getState().snapshot?.question,
        serverStartTime: T0,
        inputClosesAt: T0 + 20_000,
        acceptanceClosesAt: T0 + 21_500,
      },
      14,
      3,
    );
    expect(apply("game:question_answering", lateAnswering)).toEqual({
      applied: false,
      reason: "stale-phase",
    });
    expect(store.getState().snapshot?.phase).toBe("ANSWER_REVEAL");
    expect(store.getState().phaseVersion).toBe(4);
    expect(apply("game:unknown_thing", push({}, 15, 4))).toEqual({
      applied: false,
      reason: "unknown-event",
    });
  });

  it("applies distinct events that share one revision, with role-specific projections", () => {
    const host = createGameStore();
    host.getState().applySync(hostSnapshot(10, 3));
    expect(
      host
        .getState()
        .applyEvent(
          "game:answer_count_updated",
          push({ answeredCount: 1, totalPlayers: 1, optionalAnswerCount: 0 }, 11, 3),
        ),
    ).toEqual({ applied: true });
    expect(
      host
        .getState()
        .applyEvent("room:presence_changed", push({ playerId: PLAYER, connected: false }, 11, 3)),
    ).toEqual({ applied: true });
    const hostState = host.getState().snapshot as HostRoomSync;
    expect(hostState.answeredCount).toBe(1);
    expect(hostState.players[0]?.connected).toBe(false);
    host.getState().applyEvent("game:answer_reveal", push({ reveal }, 12, 4));
    expect(host.getState().snapshot?.reveal?.correctCount).toBe(1);

    const player = createGameStore();
    player.getState().applySync(playerSnapshot({ revision: 10, phaseVersion: 3 }));
    // The same mutation projected for the player: reveal plus personal result.
    player.getState().applyEvent("game:answer_reveal", push({ reveal, result }, 12, 4));
    const self = (player.getState().snapshot as PlayerRoomSync).self;
    expect([self.score, self.streak, self.rank, self.result?.result]).toEqual([
      950,
      1,
      1,
      "CORRECT",
    ]);
    player
      .getState()
      .applyEvent(
        "game:leaderboard",
        push({ topPlayers: [], biggestClimber: null, selfRank: 2 }, 13, 5),
      );
    expect((player.getState().snapshot as PlayerRoomSync).self.rank).toBe(2);
  });

  it("dates reveal, leaderboard, podium and finished from the push, not the previous phase", () => {
    const host = createGameStore();
    host.getState().applySync(hostSnapshot(10, 3));
    const answeringStart = host.getState().snapshot?.timing.phaseStartedAt;
    host.getState().applyEvent("game:answer_reveal", push({ reveal }, 12, 4));
    expect(host.getState().snapshot?.timing).toEqual({
      phaseStartedAt: T0 + 12,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    });
    expect(host.getState().snapshot?.timing.phaseStartedAt).not.toBe(answeringStart);
    host
      .getState()
      .applyEvent("game:leaderboard", push({ topPlayers: [], biggestClimber: null }, 13, 5));
    expect(host.getState().snapshot?.timing.phaseStartedAt).toBe(T0 + 13);
    const finalization = {
      sessionId: SESSION_A,
      status: "pending",
      reportId: null,
      retryable: true,
      errorCode: null,
      updatedAt: T0 + 14,
    };
    host
      .getState()
      .applyEvent("game:podium", push({ podium: [], finalization, reportId: null }, 14, 6));
    expect(host.getState().snapshot?.timing).toMatchObject({
      phaseStartedAt: T0 + 14,
      phaseEndsAt: T0 + 14 + GAME_TIMING.podiumMs,
    });
    host.getState().applyEvent("game:finished", push({ endReason: "COMPLETED" }, 15, 7));
    expect(host.getState().snapshot?.timing).toMatchObject({
      phaseStartedAt: T0 + 15,
      phaseEndsAt: null,
    });
  });
});

describe("sessions", () => {
  it("keeps a new session that reuses the PIN separate from the old one", () => {
    const store = createGameStore();
    store
      .getState()
      .applySync(playerSnapshot({ sessionId: SESSION_A, revision: 40, phaseVersion: 9 }));
    expect(store.getState().setDraft(QUESTION, 1)).toBe(true);
    // A push for another session with the same PIN is ignored.
    expect(
      store
        .getState()
        .applyEvent("room:lock_changed", push({ isLocked: true }, 50, 9, { sessionId: SESSION_B })),
    ).toEqual({ applied: false, reason: "other-session" });

    // Joining the new room (lower revision and phase) replaces everything.
    store
      .getState()
      .applySync(
        playerSnapshot({ sessionId: SESSION_B, revision: 2, phaseVersion: 1, answering: false }),
      );
    expect(store.getState().snapshot?.sessionId).toBe(SESSION_B);
    expect(store.getState().drafts).toEqual({});
    expect(
      store
        .getState()
        .applyEvent("room:lock_changed", push({ isLocked: true }, 3, 1, { sessionId: SESSION_B })),
    ).toEqual({ applied: true });
    expect(
      store
        .getState()
        .applyEvent(
          "room:lock_changed",
          push({ isLocked: false }, 41, 9, { sessionId: SESSION_A }),
        ),
    ).toEqual({ applied: false, reason: "other-session" });
  });

  it("recovers an accepted answer after reconnect without re-sending it", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot());
    store.getState().setDraft(QUESTION, 0);
    expect(store.getState().markSubmitting(QUESTION, SUBMISSION)).toBe(true);
    // No optimistic score or phase while the answer is in flight.
    expect((store.getState().snapshot as PlayerRoomSync).self.score).toBe(0);
    expect(store.getState().setDraft(QUESTION, 1)).toBe(false);

    store.getState().setTransport("connected");
    store.getState().setTransport("reconnecting");
    store.getState().setTransport("connected");
    expect(store.getState().syncRequested).toBe(true);

    store.getState().applySync(playerSnapshot({ revision: 12, accepted: true }));
    const draft = currentDraft(store.getState());
    expect(draft).toMatchObject({ status: "accepted", submissionId: SUBMISSION, value: 0 });
    expect(retryableSubmission(store.getState(), T0 + 5_000)).toBeNull();
    expect(store.getState().syncRequested).toBe(false);
    expect(store.getState().setDraft(QUESTION, 1)).toBe(false); // locked
  });

  it("allows retrying the identical submission only while the server still accepts answers", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot());
    store.getState().setDraft(QUESTION, 1);
    store.getState().markSubmitting(QUESTION, SUBMISSION);
    store.getState().applySync(playerSnapshot({ revision: 11 })); // not accepted
    const retry = retryableSubmission(store.getState(), T0 + 21_000);
    expect(retry).toMatchObject({ submissionId: SUBMISSION, value: 1, status: "submitting" });
    expect(retryableSubmission(store.getState(), T0 + 21_500)).toBeNull(); // window closed
    store.getState().markAccepted({ submissionId: SUBMISSION, questionIndex: 0 });
    expect(currentDraft(store.getState())?.status).toBe("accepted");
    expect(store.getState().drafts[draftKey(SESSION_A, QUESTION)]?.value).toBe(1);
  });
});

describe("transport and lifecycle", () => {
  it("requests a sync on a newer heartbeat or after missed heartbeats, and records terminal events", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot({ revision: 10 }));
    store.getState().applyEvent("room:version", push({ publicRevision: 10 }, 10, 3));
    expect(store.getState().syncRequested).toBe(false);
    store.getState().applyEvent("room:version", push({ publicRevision: 12 }, 12, 3));
    expect(store.getState().syncRequested).toBe(true);
    store.getState().clearSyncRequest();
    const last = store.getState().transport.lastHeartbeatAt ?? 0;
    store.getState().checkHeartbeat(last + HEARTBEAT_STALE_MS - 1);
    expect(store.getState().syncRequested).toBe(false);
    store.getState().checkHeartbeat(last + HEARTBEAT_STALE_MS + 1);
    expect(store.getState().syncRequested).toBe(true);

    store.getState().applyEvent("player:kicked", push({ reason: "HOST_REMOVED" }, 20, 3));
    expect(store.getState().terminal).toBe("KICKED");
    store.getState().reset();
    expect(store.getState().snapshot).toBeNull();
    expect(store.getState().terminal).toBeNull();
  });

  it("advances publicRevision with applied room-wide events so heartbeats stay quiet (MJ-25)", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot({ revision: 5 }));
    const player = store.getState().snapshot?.players[0];
    expect(player).toBeDefined();
    if (!player) return;
    store
      .getState()
      .applyEvent("room:player_joined", push({ player: { ...player, nickname: "Bima" } }, 6, 3));
    expect(store.getState().snapshot?.publicRevision).toBe(6);
    store.getState().applyEvent("room:version", push({ publicRevision: 6 }, 6, 3));
    expect(store.getState().syncRequested).toBe(false);
    store.getState().applyEvent("room:version", push({ publicRevision: 7 }, 7, 3));
    expect(store.getState().syncRequested).toBe(true);

    const host = createGameStore();
    host.getState().applySync(hostSnapshot(5));
    host
      .getState()
      .applyEvent(
        "game:answer_count_updated",
        push({ answeredCount: 1, totalPlayers: 1, optionalAnswerCount: 0 }, 7, 3),
      );
    expect(host.getState().snapshot?.publicRevision).toBe(5);
    host.getState().applyEvent("room:version", push({ publicRevision: 5 }, 7, 3));
    expect(host.getState().syncRequested).toBe(false);
  });

  it("applies room:expired despite the server's revision 1 / phaseVersion 1 (MJ-29)", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot({ revision: 10 }));
    const expired = push({ reason: "ROOM_LOST" }, 1, 1);
    expect(store.getState().applyEvent("room:expired", expired)).toEqual({ applied: true });
    expect(store.getState().terminal).toBe("ROOM_LOST");
    // Event-id dedup and the session check still apply.
    expect(store.getState().applyEvent("room:expired", expired)).toEqual({
      applied: false,
      reason: "duplicate",
    });
    const other = createGameStore();
    other.getState().applySync(playerSnapshot({ revision: 10 }));
    expect(
      other
        .getState()
        .applyEvent(
          "room:expired",
          push({ reason: "ROOM_EXPIRED" }, 1, 1, { sessionId: SESSION_B }),
        ),
    ).toEqual({ applied: false, reason: "other-session" });
    expect(other.getState().terminal).toBeNull();
  });

  it("survives remounts inside the locale provider (locale/theme never reset it)", () => {
    const store = createGameStore();
    store.getState().applySync(playerSnapshot());
    function Phase() {
      const phase = useGame(store, (state) => state.snapshot?.phase ?? "none");
      return createElement("p", null, phase);
    }
    const first = renderWithLocale(createElement(Phase), { locale: "fr" });
    expect(screen.getByText("QUESTION_ANSWERING")).toBeInTheDocument();
    first.unmount();
    renderWithLocale(createElement(Phase), { locale: "ja" });
    expect(screen.getByText("QUESTION_ANSWERING")).toBeInTheDocument();
    act(() => {
      store.getState().applyEvent("game:answer_reveal", push({ reveal, result }, 30, 4));
    });
    expect(screen.getByText("ANSWER_REVEAL")).toBeInTheDocument();
  });
});
