/**
 * Game store (SA §5.1, §5.3, §6.4; US-09/10/12/13; TASK-127): the authoritative room snapshot of
 * one role, kept separate from transport state and from the player's local answer draft.
 *
 * - `applySync` installs a full `room:state_sync` snapshot (host or player). A snapshot for a new
 *   session — even one that reuses the same PIN — resets fences and drafts; for the same session it
 *   keeps the draft of the current question and drops drafts of other questions.
 * - `applyEvent` fences pushes: events for another session are dropped; every event with
 *   `revision <= snapshotRevision` is dropped (the snapshot already contains it); after the
 *   snapshot, events are de-duplicated by `eventId` (several distinct events may share one
 *   revision, e.g. role projections of the same mutation) and events from an older `phaseVersion`
 *   are dropped, so the phase never moves backwards.
 * - Nothing is optimistic: phase, timing, scores and ranks only change through server snapshots or
 *   events. A submitted answer is only locked when the server accepts it (ACK or snapshot); a
 *   snapshot with an accepted answer after reconnect locks the draft and clears the pending
 *   submission, so it is never re-sent.
 * - Transport: `room:version` heartbeats newer than the snapshot, or heartbeats missing for longer
 *   than `HEARTBEAT_STALE_MS`, raise `syncRequested` (the socket layer then calls `room:sync`).
 * - The store is a plain Zustand store outside the React tree, so locale/theme changes or
 *   component remounts never reset it.
 */
import { createStore, useStore, type StoreApi } from "zustand";
import type { Answer } from "@kabuki-neko/shared/schemas/question.schema";
import type {
  HostRoomSync,
  PlayerRoomSync,
  PersonalResult,
} from "@kabuki-neko/shared/schemas/game.schema";
import type { PushEnvelope } from "@kabuki-neko/shared/socket-events";

/** Any role snapshot. */
export type RoomSnapshot = HostRoomSync | PlayerRoomSync;

/** Why an event was not applied. */
export type DropReason =
  | "no-snapshot"
  | "other-session"
  | "stale-revision"
  | "duplicate"
  | "stale-phase"
  | "unknown-event";

/** Result of `applyEvent`. */
export type EventResult = { applied: true } | { applied: false; reason: DropReason };

/** Ends of a session for this client. */
export type TerminalReason = "KICKED" | "SESSION_REPLACED" | "ROOM_EXPIRED" | "ROOM_LOST";

/** Local answer draft for one question of one session. */
export interface AnswerDraft {
  questionId: string;
  questionIndex: number;
  value: Answer | null;
  /** editing → submitting (sent, outcome unknown) → accepted (server confirmed; locked). */
  status: "editing" | "submitting" | "accepted";
  submissionId: string | null;
}

/** Transport state (owned by the socket layer, displayed by the UI). */
export interface TransportState {
  status: "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
  lastHeartbeatAt: number | null;
}

/** Store state and actions. */
export interface GameState {
  snapshot: RoomSnapshot | null;
  /** Revision of the last full snapshot; events at or below it are already included. */
  snapshotRevision: number;
  phaseVersion: number;
  seenEventIds: ReadonlySet<string>;
  transport: TransportState;
  syncRequested: boolean;
  /** Drafts keyed `${sessionId}:${questionId}`. */
  drafts: Readonly<Record<string, AnswerDraft>>;
  terminal: TerminalReason | null;
  applySync(snapshot: RoomSnapshot): void;
  applyEvent(name: string, envelope: PushEnvelope<unknown>): EventResult;
  setTransport(status: TransportState["status"]): void;
  checkHeartbeat(now: number): void;
  clearSyncRequest(): void;
  setDraft(questionId: string, value: Answer | null): boolean;
  markSubmitting(questionId: string, submissionId: string): boolean;
  markAccepted(ack: { submissionId: string; questionIndex: number }): void;
  markRejected(questionId: string): void;
  reset(): void;
}

/** A heartbeat is due every 5 s; two missed ones request a sync. */
export const HEARTBEAT_STALE_MS = 12_000;
/** Bound on remembered event IDs per snapshot. */
const MAX_SEEN_EVENTS = 1_000;

/** Draft key for a session and question. */
export function draftKey(sessionId: string, questionId: string): string {
  return `${sessionId}:${questionId}`;
}

/** The draft of the current question of the snapshot, if any. */
export function currentDraft(state: Pick<GameState, "snapshot" | "drafts">): AnswerDraft | null {
  const { snapshot } = state;
  if (!snapshot?.question) return null;
  return state.drafts[draftKey(snapshot.sessionId, snapshot.question.id)] ?? null;
}

/**
 * The pending submission may be re-sent (same submissionId and answer) only when the snapshot
 * shows it was not accepted and the server still accepts answers for that question.
 */
export function retryableSubmission(
  state: Pick<GameState, "snapshot" | "drafts">,
  serverNow: number,
): AnswerDraft | null {
  const draft = currentDraft(state);
  const snapshot = state.snapshot;
  if (!draft || draft.status !== "submitting" || !snapshot || snapshot.role !== "player")
    return null;
  if (snapshot.self.acceptedAnswer !== null || snapshot.phase !== "QUESTION_ANSWERING") return null;
  const closes = snapshot.timing.acceptanceClosesAt;
  return closes !== null && serverNow < closes ? draft : null;
}

/** Snapshot with `patch` applied (a fresh object; the union type is kept by the caller). */
function patch(snapshot: RoomSnapshot, changes: Record<string, unknown>): RoomSnapshot {
  return { ...snapshot, ...changes } as RoomSnapshot;
}

/** Applies a validated event payload to the snapshot; returns null for unknown events. */
function reduce(
  snapshot: RoomSnapshot,
  name: string,
  data: Record<string, unknown>,
  envelope: PushEnvelope<unknown>,
): RoomSnapshot | null {
  const base = {
    revision: Math.max(snapshot.revision, envelope.revision),
    phaseVersion: Math.max(snapshot.phaseVersion, envelope.phaseVersion),
    serverTime: envelope.serverTime,
  };
  const players = snapshot.players;
  switch (name) {
    case "room:player_joined": {
      const player = data.player as RoomSnapshot["players"][number];
      return patch(snapshot, {
        ...base,
        players: [...players.filter((item) => item.id !== player.id), player],
      });
    }
    case "room:player_updated":
      return patch(snapshot, {
        ...base,
        players: players.map((item) =>
          item.id === data.playerId ? { ...item, avatar: data.avatar } : item,
        ),
      });
    case "room:player_left":
      return patch(snapshot, {
        ...base,
        players: players.filter((item) => item.id !== data.playerId),
      });
    case "room:presence_changed":
      return patch(snapshot, {
        ...base,
        players: players.map((item) =>
          item.id === data.playerId ? { ...item, connected: data.connected } : item,
        ),
      });
    case "room:lock_changed":
      return patch(snapshot, { ...base, isLocked: data.isLocked });
    case "game:countdown":
      return patch(snapshot, {
        ...base,
        phase: "GAME_START_COUNTDOWN",
        question: null,
        reveal: null,
        leaderboard: null,
        timing: {
          phaseStartedAt: data.phaseStartedAt,
          phaseEndsAt: data.phaseEndsAt,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      });
    case "game:question_preview":
      return patch(snapshot, {
        ...base,
        phase: "QUESTION_PREVIEW",
        question: data.question,
        reveal: null,
        timing: {
          phaseStartedAt: data.phaseStartedAt,
          phaseEndsAt: data.phaseEndsAt,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
        ...(snapshot.role === "player"
          ? { self: { ...snapshot.self, acceptedAnswer: null, result: null } }
          : { answeredCount: 0 }),
      });
    case "game:question_answering":
      return patch(snapshot, {
        ...base,
        phase: "QUESTION_ANSWERING",
        question: data.question,
        reveal: null,
        timing: {
          phaseStartedAt: data.serverStartTime,
          phaseEndsAt: data.acceptanceClosesAt,
          questionStartedAt: data.serverStartTime,
          inputClosesAt: data.inputClosesAt,
          acceptanceClosesAt: data.acceptanceClosesAt,
        },
      });
    case "game:answer_count_updated":
      return snapshot.role === "host"
        ? patch(snapshot, { ...base, answeredCount: data.answeredCount })
        : patch(snapshot, base);
    case "game:answer_reveal": {
      const result = data.result as PersonalResult | undefined;
      return patch(snapshot, {
        ...base,
        phase: "ANSWER_REVEAL",
        reveal: data.reveal,
        ...(snapshot.role === "player" && result
          ? {
              self: {
                ...snapshot.self,
                result,
                score: result.totalScore,
                streak: result.currentStreak,
                rank: result.currentRank,
              },
            }
          : {}),
      });
    }
    case "game:leaderboard": {
      const { selfRank, ...leaderboard } = data;
      return patch(snapshot, {
        ...base,
        phase: "LEADERBOARD",
        leaderboard,
        ...(snapshot.role === "player" && selfRank !== undefined
          ? { self: { ...snapshot.self, rank: selfRank } }
          : {}),
      });
    }
    case "game:podium":
      return patch(snapshot, {
        ...base,
        phase: "PODIUM",
        podium: data.podium,
        ...(snapshot.role === "host" ? { finalization: data.finalization } : {}),
        ...(snapshot.role === "player" && data.result
          ? { self: { ...snapshot.self, result: data.result } }
          : {}),
      });
    case "game:finished":
      return patch(snapshot, { ...base, phase: "FINISHED", endReason: data.endReason });
    case "report:status_changed":
      return snapshot.role === "host"
        ? patch(snapshot, { ...base, finalization: data })
        : patch(snapshot, base);
    default:
      return null;
  }
}

/** Creates a game store (one per tab). */
export function createGameStore(): StoreApi<GameState> {
  const initial = {
    snapshot: null,
    snapshotRevision: 0,
    phaseVersion: 0,
    seenEventIds: new Set<string>(),
    transport: { status: "idle" as const, lastHeartbeatAt: null },
    syncRequested: false,
    drafts: {},
    terminal: null,
  };

  return createStore<GameState>()((set, get) => ({
    ...initial,

    applySync(snapshot) {
      const previous = get().snapshot;
      const sameSession = previous?.sessionId === snapshot.sessionId;
      const questionId = snapshot.question?.id ?? null;
      // Keep only the current question's draft of the same session; lock it if accepted.
      const drafts: Record<string, AnswerDraft> = {};
      if (sameSession && questionId) {
        const key = draftKey(snapshot.sessionId, questionId);
        const kept = get().drafts[key];
        if (kept) drafts[key] = kept;
      }
      if (snapshot.role === "player" && snapshot.self.acceptedAnswer && questionId) {
        const accepted = snapshot.self.acceptedAnswer;
        drafts[draftKey(snapshot.sessionId, questionId)] = {
          questionId,
          questionIndex: accepted.questionIndex,
          value: accepted.answer,
          status: "accepted",
          submissionId: accepted.submissionId,
        };
      }
      set({
        snapshot,
        snapshotRevision: snapshot.revision,
        phaseVersion: snapshot.phaseVersion,
        seenEventIds: new Set(),
        syncRequested: false,
        drafts,
        terminal: sameSession ? get().terminal : null,
        transport: { ...get().transport, lastHeartbeatAt: Date.now() },
      });
    },

    applyEvent(name, envelope) {
      const state = get();
      const snapshot = state.snapshot;
      if (snapshot === null) return { applied: false, reason: "no-snapshot" };
      if (envelope.sessionId !== snapshot.sessionId)
        return { applied: false, reason: "other-session" };
      if (name === "room:state_sync") {
        state.applySync(envelope.data as RoomSnapshot);
        return { applied: true };
      }
      if (name === "room:version") {
        // Heartbeat: an indicator only; a newer public revision means we missed events.
        const publicRevision = (envelope.data as { publicRevision: number }).publicRevision;
        set({
          transport: { ...state.transport, lastHeartbeatAt: Date.now() },
          syncRequested: state.syncRequested || publicRevision > snapshot.publicRevision,
        });
        return { applied: true };
      }
      if (envelope.revision <= state.snapshotRevision)
        return { applied: false, reason: "stale-revision" };
      if (state.seenEventIds.has(envelope.eventId)) return { applied: false, reason: "duplicate" };
      if (envelope.phaseVersion < state.phaseVersion)
        return { applied: false, reason: "stale-phase" };
      const seen = new Set(state.seenEventIds);
      seen.add(envelope.eventId);
      if (seen.size > MAX_SEEN_EVENTS) seen.delete(seen.values().next().value ?? "");

      if (
        name === "player:kicked" ||
        name === "player:session_replaced" ||
        name === "room:expired"
      ) {
        const reason: TerminalReason =
          name === "player:kicked"
            ? "KICKED"
            : name === "player:session_replaced"
              ? "SESSION_REPLACED"
              : (envelope.data as { reason: "ROOM_EXPIRED" | "ROOM_LOST" }).reason;
        set({ seenEventIds: seen, terminal: reason });
        return { applied: true };
      }
      if (name === "room:error") {
        set({ seenEventIds: seen, syncRequested: true });
        return { applied: true };
      }
      const next = reduce(snapshot, name, envelope.data as Record<string, unknown>, envelope);
      if (next === null) return { applied: false, reason: "unknown-event" };
      set({
        snapshot: next,
        seenEventIds: seen,
        phaseVersion: Math.max(state.phaseVersion, envelope.phaseVersion),
        transport: { ...state.transport, lastHeartbeatAt: Date.now() },
      });
      return { applied: true };
    },

    setTransport(status) {
      const transport = get().transport;
      // Coming back from a reconnect always needs a fresh snapshot before answering again.
      const recovered =
        status === "connected" &&
        (transport.status === "reconnecting" || transport.status === "disconnected");
      set({ transport: { ...transport, status }, syncRequested: get().syncRequested || recovered });
    },

    checkHeartbeat(now) {
      const { transport, snapshot } = get();
      if (
        snapshot &&
        transport.lastHeartbeatAt !== null &&
        now - transport.lastHeartbeatAt > HEARTBEAT_STALE_MS
      )
        set({ syncRequested: true });
    },

    clearSyncRequest() {
      set({ syncRequested: false });
    },

    setDraft(questionId, value) {
      const { snapshot, drafts } = get();
      if (
        !snapshot ||
        snapshot.role !== "player" ||
        snapshot.phase !== "QUESTION_ANSWERING" ||
        snapshot.question?.id !== questionId
      )
        return false;
      const key = draftKey(snapshot.sessionId, questionId);
      const existing = drafts[key];
      if (existing && existing.status !== "editing") return false; // locked once submitted
      set({
        drafts: {
          ...drafts,
          [key]: {
            questionId,
            questionIndex: snapshot.question.questionIndex,
            value,
            status: "editing",
            submissionId: null,
          },
        },
      });
      return true;
    },

    markSubmitting(questionId, submissionId) {
      const { snapshot, drafts } = get();
      if (!snapshot) return false;
      const key = draftKey(snapshot.sessionId, questionId);
      const draft = drafts[key];
      if (!draft || draft.status === "accepted" || draft.value === null) return false;
      set({ drafts: { ...drafts, [key]: { ...draft, status: "submitting", submissionId } } });
      return true;
    },

    markAccepted(ack) {
      const { snapshot, drafts } = get();
      if (!snapshot) return;
      const entry = Object.entries(drafts).find(
        ([key, draft]) =>
          key.startsWith(`${snapshot.sessionId}:`) &&
          draft.submissionId === ack.submissionId &&
          draft.questionIndex === ack.questionIndex,
      );
      if (!entry) return;
      const [key, draft] = entry;
      set({ drafts: { ...drafts, [key]: { ...draft, status: "accepted" } } });
    },

    markRejected(questionId) {
      const { snapshot, drafts } = get();
      if (!snapshot) return;
      const key = draftKey(snapshot.sessionId, questionId);
      const draft = drafts[key];
      if (draft && draft.status === "submitting")
        set({ drafts: { ...drafts, [key]: { ...draft, status: "editing", submissionId: null } } });
    },

    reset() {
      set({ ...initial, seenEventIds: new Set() });
    },
  }));
}

/** React binding for a game store. */
export function useGame<T>(store: StoreApi<GameState>, selector: (state: GameState) => T): T {
  return useStore(store, selector);
}
