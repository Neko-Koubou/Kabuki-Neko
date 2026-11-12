"use client";
/**
 * Session recovery and safe answer submission (SA §5.1–5.2, §6.4; US-07/08/10/12; TASK-128).
 *
 * - Player credentials: only the room-scoped `{ sessionId, playerId, sessionToken, pinCode }` is
 *   kept, in localStorage under `kabuki:player:<sessionId>` plus a PIN pointer
 *   `kabuki:player-pin:<pin>` — never a user JWT. Kick, replacement, expiry, an invalid token or a
 *   vanished room clear it.
 * - On every (re)connect the player rejoins with the stored token (recovery join, retried with the
 *   same requestId when the ACK is lost) and the host recovers its room; a host whose access token
 *   expired gets a fresh one through `onAuthExpired`, announces it with `auth:update` and retries.
 *   After a terminal outcome nothing rejoins automatically.
 * - `room:sync` runs whenever the store requests it (missed heartbeat, reconnect, unknown ACK).
 * - `submit` sends a new answer only before `inputClosesAt` (no new input during the grace period).
 *   An unknown ACK never re-sends blindly: it requests a sync; only if the snapshot then shows the
 *   answer was not accepted and the server still accepts answers is the identical submission
 *   (same submissionId and payload) sent again.
 */
import { useCallback, useEffect, useRef } from "react";
import type { StoreApi } from "zustand";
import { pinCodeSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { sessionTokenSchema } from "@kabuki-neko/shared/socket-events";
import { backoffDelay, type GameSocket } from "@/lib/socket-client";
import {
  currentDraft,
  retryableSubmission,
  type GameState,
  type RoomSnapshot,
  type TerminalReason,
} from "@/stores/game.store";

/** Stored player credentials for one room session. */
export interface PlayerSessionRecord {
  sessionId: string;
  playerId: string;
  sessionToken: string;
  pinCode: string;
}

/** Storage keys. */
export const PLAYER_KEY_PREFIX = "kabuki:player:";
export const PLAYER_PIN_PREFIX = "kabuki:player-pin:";

/** Storage surface (localStorage or a test double). */
export type RecordStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Default storage: localStorage, or null when unavailable. */
function defaultStorage(): RecordStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Saves a player's room credentials and the PIN pointer. */
export function savePlayerSession(record: PlayerSessionRecord, storage = defaultStorage()): void {
  try {
    storage?.setItem(`${PLAYER_KEY_PREFIX}${record.sessionId}`, JSON.stringify(record));
    storage?.setItem(`${PLAYER_PIN_PREFIX}${record.pinCode}`, record.sessionId);
  } catch {
    // Storage denied: recovery after reload is not possible, the live session still works.
  }
}

/** Loads and validates the credentials of a session. */
export function loadPlayerSession(
  sessionId: string,
  storage = defaultStorage(),
): PlayerSessionRecord | null {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(`${PLAYER_KEY_PREFIX}${sessionId}`) ?? "null");
    const record = raw as Partial<PlayerSessionRecord> | null;
    if (
      record &&
      uuidSchema.safeParse(record.sessionId).success &&
      uuidSchema.safeParse(record.playerId).success &&
      sessionTokenSchema.safeParse(record.sessionToken).success &&
      pinCodeSchema.safeParse(record.pinCode).success &&
      record.sessionId === sessionId
    )
      return record as PlayerSessionRecord;
  } catch {
    // Corrupt entry: treated as absent.
  }
  return null;
}

/** Credentials of the session last joined with `pinCode`, if still stored. */
export function findPlayerSessionByPin(
  pinCode: string,
  storage = defaultStorage(),
): PlayerSessionRecord | null {
  try {
    const sessionId = storage?.getItem(`${PLAYER_PIN_PREFIX}${pinCode}`);
    const record = sessionId ? loadPlayerSession(sessionId, storage) : null;
    return record?.pinCode === pinCode ? record : null;
  } catch {
    return null;
  }
}

/** Removes a session's credentials (and its PIN pointer when it still points to it). */
export function clearPlayerSession(sessionId: string, storage = defaultStorage()): void {
  try {
    const record = loadPlayerSession(sessionId, storage);
    storage?.removeItem(`${PLAYER_KEY_PREFIX}${sessionId}`);
    if (record && storage?.getItem(`${PLAYER_PIN_PREFIX}${record.pinCode}`) === sessionId)
      storage.removeItem(`${PLAYER_PIN_PREFIX}${record.pinCode}`);
  } catch {
    // Nothing else to do.
  }
}

/** Error codes that end a player's or host's session for good. */
const TERMINAL_CODES: Partial<Record<string, TerminalReason>> = {
  PLAYER_KICKED: "KICKED",
  INVALID_SESSION_TOKEN: "SESSION_REPLACED",
  SESSION_REPLACED: "SESSION_REPLACED",
  ROOM_NOT_FOUND: "ROOM_LOST",
  ROOM_LOST: "ROOM_LOST",
  ROOM_EXPIRED: "ROOM_EXPIRED",
  NOT_FOUND: "ROOM_LOST",
};

/** Outcome of `submit`. */
export type SubmitOutcome = "accepted" | "pending" | "rejected" | "closed" | "invalid";

/** Options of {@link useSessionRecovery}. */
export interface SessionRecoveryOptions {
  socket: GameSocket;
  store: StoreApi<GameState>;
  role: "player" | "host";
  /** Player: the PIN being played (credentials are looked up by it). */
  pinCode?: string;
  /** Host: the session to recover. */
  sessionId?: string;
  storage?: RecordStorage | null;
  /** Server-synchronized clock (epoch ms). */
  serverNow?: () => number;
  /** Host: obtains a fresh access token after a 401; null when the user must sign in. */
  onAuthExpired?: () => Promise<string | null>;
}

/** Recovers sessions on connect, keeps the snapshot in sync and submits answers safely. */
export function useSessionRecovery(options: SessionRecoveryOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { socket, store } = options;

  /** Stores credentials from a successful join/recovery ACK. */
  const remember = useCallback(
    (data: {
      sessionId: string;
      playerId: string;
      sessionToken: string;
      snapshot: RoomSnapshot;
    }) => {
      const opts = latest.current;
      savePlayerSession(
        {
          sessionId: data.sessionId,
          playerId: data.playerId,
          sessionToken: data.sessionToken,
          pinCode: data.snapshot.pinCode,
        },
        opts.storage === undefined ? defaultStorage() : opts.storage,
      );
    },
    [],
  );

  /** Ends the session locally: clears stored credentials and marks the store terminal. */
  const terminate = useCallback(
    (reason: TerminalReason, sessionId: string | null) => {
      const opts = latest.current;
      if (sessionId)
        clearPlayerSession(sessionId, opts.storage === undefined ? defaultStorage() : opts.storage);
      store.getState().setTerminal(reason);
    },
    [store],
  );

  /** Re-sends the identical pending submission when the snapshot allows it. */
  const retryPending = useCallback(async () => {
    const opts = latest.current;
    const state = store.getState();
    const draft = retryableSubmission(state, (opts.serverNow ?? Date.now)());
    const snapshot = state.snapshot;
    if (!draft || !snapshot || draft.value === null || draft.submissionId === null) return;
    const result = await socket.emit("player:submit_answer", {
      sessionId: snapshot.sessionId,
      pinCode: snapshot.pinCode,
      questionIndex: draft.questionIndex,
      questionId: draft.questionId,
      submissionId: draft.submissionId,
      answer: draft.value,
    });
    if (result.status === "ok") store.getState().markAccepted(result.data);
    else if (result.status === "unknown") store.getState().requestSync();
  }, [socket, store]);

  /** Rejoins (player) or recovers (host) after a connect. */
  const recover = useCallback(
    async (requestId?: string, attempt = 0): Promise<void> => {
      const opts = latest.current;
      const state = store.getState();
      if (state.terminal !== null) return; // never auto-rejoin after kick/replacement/expiry
      const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
      if (opts.role === "host") {
        const sessionId = state.snapshot?.sessionId ?? opts.sessionId;
        if (!sessionId) return;
        const result = await socket.emit("host:recover_room", {
          sessionId,
          ...(requestId ? { requestId } : {}),
        });
        if (result.status === "ok") {
          store.getState().applySync(result.data.snapshot);
          return;
        }
        if (result.status === "unknown") {
          setTimeout(() => void recover(result.requestId, attempt + 1), backoffDelay(attempt));
          return;
        }
        const code = result.error.errorCode;
        if (
          (code === "TOKEN_EXPIRED" || code === "AUTH_REQUIRED") &&
          attempt === 0 &&
          opts.onAuthExpired
        ) {
          const token = await opts.onAuthExpired();
          if (token) {
            const updated = await socket.emit("auth:update", { accessToken: token });
            if (updated.status === "ok") await recover(undefined, 1);
          }
          return;
        }
        const terminal = TERMINAL_CODES[code];
        if (terminal) terminate(terminal, null);
        return;
      }
      const pinCode = state.snapshot?.pinCode ?? opts.pinCode;
      const record = state.snapshot
        ? loadPlayerSession(state.snapshot.sessionId, storage)
        : pinCode
          ? findPlayerSessionByPin(pinCode, storage)
          : null;
      if (!record) return; // nothing to recover; a fresh join comes from the join form
      const result = await socket.emit("player:join_room", {
        pinCode: record.pinCode,
        sessionId: record.sessionId,
        sessionToken: record.sessionToken,
        ...(requestId ? { requestId } : {}),
      });
      if (result.status === "ok") {
        remember(result.data);
        store.getState().applySync(result.data.snapshot);
        await retryPending();
        return;
      }
      if (result.status === "unknown") {
        // Lost ACK: retry with the same requestId to get the same slot/token back.
        setTimeout(() => void recover(result.requestId, attempt + 1), backoffDelay(attempt));
        return;
      }
      const terminal = TERMINAL_CODES[result.error.errorCode];
      if (terminal) terminate(terminal, record.sessionId);
    },
    [socket, store, remember, retryPending, terminate],
  );

  /** Fetches a fresh snapshot when the store asks for one. */
  const sync = useCallback(async () => {
    const state = store.getState();
    const snapshot = state.snapshot;
    if (!snapshot || state.terminal !== null || !socket.connected) return;
    store.getState().clearSyncRequest();
    const result = await socket.emit("room:sync", {
      sessionId: snapshot.sessionId,
      pinCode: snapshot.pinCode,
    });
    if (result.status === "ok") {
      store.getState().applySync(result.data.snapshot);
      if (latest.current.role === "player") await retryPending();
      return;
    }
    if (result.status === "unknown") {
      store.getState().requestSync();
      return;
    }
    const code = result.error.errorCode;
    if (code === "AUTH_REQUIRED" || code === "FORBIDDEN" || code === "TOKEN_EXPIRED") {
      await recover();
      return;
    }
    const terminal = TERMINAL_CODES[code];
    if (terminal) terminate(terminal, latest.current.role === "player" ? snapshot.sessionId : null);
  }, [socket, store, recover, retryPending, terminate]);

  // Wire connect → recover, sync requests → room:sync, terminal → clear credentials (once).
  useEffect(() => {
    const offConnect = socket.onLifecycle("connect", () => void recover());
    const offStore = store.subscribe((state, previous) => {
      if (state.syncRequested && !previous.syncRequested) void sync();
      if (
        state.terminal !== null &&
        previous.terminal === null &&
        latest.current.role === "player"
      ) {
        const sessionId = state.snapshot?.sessionId ?? previous.snapshot?.sessionId;
        if (sessionId)
          clearPlayerSession(
            sessionId,
            latest.current.storage === undefined ? defaultStorage() : latest.current.storage,
          );
      }
    });
    // The socket hook may already have connected before this effect subscribed.
    if (socket.connected) void recover();
    return () => {
      offConnect();
      offStore();
    };
  }, [socket, store, recover, sync]);

  /** Sends the current draft once; never during the grace period, never twice on doubt. */
  const submit = useCallback(async (): Promise<SubmitOutcome> => {
    const opts = latest.current;
    const state = store.getState();
    const snapshot = state.snapshot;
    const draft = currentDraft(state);
    if (
      !snapshot ||
      snapshot.role !== "player" ||
      snapshot.phase !== "QUESTION_ANSWERING" ||
      !snapshot.question
    )
      return "invalid";
    if (!draft || draft.status !== "editing" || draft.value === null) return "invalid";
    const closes = snapshot.timing.inputClosesAt;
    if (closes === null || (opts.serverNow ?? Date.now)() >= closes) return "closed";
    const submissionId = crypto.randomUUID();
    store.getState().markSubmitting(draft.questionId, submissionId);
    const result = await socket.emit("player:submit_answer", {
      sessionId: snapshot.sessionId,
      pinCode: snapshot.pinCode,
      questionIndex: draft.questionIndex,
      questionId: draft.questionId,
      submissionId,
      answer: draft.value,
    });
    if (result.status === "ok") {
      store.getState().markAccepted(result.data);
      return "accepted";
    }
    if (result.status === "unknown") {
      store.getState().requestSync(); // outcome unknown: sync decides, nothing is re-sent blindly
      return "pending";
    }
    const code = result.error.errorCode;
    if (code === "ALREADY_ANSWERED") {
      store.getState().requestSync();
      return "pending";
    }
    store.getState().markRejected(draft.questionId);
    return code === "TIME_EXPIRED" ? "closed" : "rejected";
  }, [socket, store]);

  return { submit, recover, sync };
}
