/**
 * TASK-128 coverage for the socket lifecycle and session recovery against a fake `/game` server:
 * a lost submit ACK is resolved by sync (accepted → locked, no re-send) or by re-sending the
 * identical submission while acceptance is open; a page refresh after an accepted answer recovers
 * it without resubmitting; a kick or replacement clears the stored player token and never rejoins
 * automatically; an invalid recovery token ends the session; reconnects follow the backoff and
 * retry-after; a host recovers after refreshing its access token with `auth:update`; and locale
 * switches or re-renders never add duplicate socket listeners.
 */
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GAME_TIMING } from "@kabuki-neko/shared/constants/game";
import { hostRoomSyncSchema, playerRoomSyncSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { deserializeCatalog, type CatalogLoader } from "@/lib/i18n/catalog-loader";
import type { SocketLike } from "@/lib/socket-client";
import { LocaleProvider, createLocalePreferences, useLocale } from "@/providers/locale-provider";
import { createGameStore, currentDraft, type GameState } from "@/stores/game.store";
import { testInitialLocale } from "@/test/locale";
import type { StoreApi } from "zustand";
import { useGameSocket } from "./use-socket";
import {
  PLAYER_KEY_PREFIX,
  PLAYER_PIN_PREFIX,
  savePlayerSession,
  useSessionRecovery,
  type SubmitOutcome,
} from "./use-session-recovery";

const SESSION = "1b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const PLAYER = "2b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const QUESTION = "3b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const OPTIONS = ["4b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e50", "4b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e51"];
const TOKEN = "A".repeat(43);
const PIN = "246810";
const T0 = 1_700_000_000_000;
const DROP = Symbol("drop");

/** Room fields in the answering phase. */
function roomFields(revision: number) {
  return {
    sessionId: SESSION,
    pinCode: PIN,
    revision,
    publicRevision: revision,
    phaseVersion: 3,
    serverTime: T0,
    quizTitle: "Capitals",
    totalQuestions: 2,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
    isLocked: false,
    maxPlayers: 50,
    players: [
      {
        id: PLAYER,
        nickname: "Ayu",
        avatar: { style: "bottts", seed: "ayu" },
        connected: true,
        joinOrder: 1,
      },
    ],
    question: {
      id: QUESTION,
      questionIndex: 0,
      totalQuestions: 2,
      type: "TRUE_FALSE",
      promptText: "Tokyo is the capital of Japan.",
      pointsMultiplier: 1,
      timeLimitSec: 20,
      media: null,
      options: OPTIONS.map((id, index) => ({
        id,
        index,
        colorIndex: index,
        text: index === 0 ? "True" : "False",
      })),
    },
    timing: {
      phaseStartedAt: T0,
      phaseEndsAt: T0 + 20_000 + GAME_TIMING.graceMs,
      questionStartedAt: T0,
      inputClosesAt: T0 + 20_000,
      acceptanceClosesAt: T0 + 20_000 + GAME_TIMING.graceMs,
    },
    reveal: null,
    leaderboard: null,
    podium: [],
    endReason: null,
    phase: "QUESTION_ANSWERING",
  };
}

/** Validated player snapshot (optionally with an accepted answer). */
function playerSnapshot(
  revision: number,
  accepted: { submissionId: string; answer: number } | null = null,
) {
  return playerRoomSyncSchema.parse({
    ...roomFields(revision),
    role: "player",
    self: {
      playerId: PLAYER,
      score: 0,
      streak: 0,
      rank: null,
      acceptedAnswer: accepted
        ? {
            submissionId: accepted.submissionId,
            questionIndex: 0,
            receivedAt: T0 + 2_000,
            answer: accepted.answer,
          }
        : null,
      result: null,
    },
  });
}

/** Validated host snapshot. */
function hostSnapshot(revision: number) {
  return hostRoomSyncSchema.parse({
    ...roomFields(revision),
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

/** ACK helpers. */
function ok(requestId: string, data: unknown) {
  return { ok: true, requestId, serverTime: T0, data };
}
function fail(requestId: string, statusCode: number, errorCode: string) {
  return {
    ok: false,
    requestId,
    serverTime: T0,
    error: {
      statusCode,
      errorCode,
      message: "x",
      params: {},
      details: [],
      correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
    },
  };
}

/** Push envelope helper. */
let pushes = 0;
function envelope(data: unknown, revision: number) {
  pushes += 1;
  return {
    protocolVersion: 1,
    sessionId: SESSION,
    pinCode: PIN,
    phaseVersion: 3,
    revision,
    serverTime: T0,
    eventId: `5b0c2f7e-3d1a-4c6b-8e9f-${String(pushes).padStart(12, "0")}`,
    data,
  };
}

/** Socket double driven by a scripted server. */
class FakeSocket implements SocketLike {
  connected = false;
  connects = 0;
  /** Number of upcoming connect attempts that fail with `connect_error`. */
  failNext = 0;
  /** Error detail sent with those failures. */
  failDetail: unknown = new Error("unreachable");
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  emitted: { event: string; payload: Record<string, unknown> }[] = [];
  constructor(public server: (event: string, payload: Record<string, unknown>) => unknown) {}
  connect() {
    this.connects += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.fire("connect_error", this.failDetail);
      return;
    }
    this.connected = true;
    this.fire("connect");
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.fire("disconnect", "io client disconnect");
  }
  drop(reason = "transport close") {
    this.connected = false;
    this.fire("disconnect", reason);
  }
  on(event: string, listener: (...args: never[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(listener);
  }
  off(event: string, listener: (...args: never[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, payload: unknown, ack: (response: unknown) => void) {
    const request = payload as Record<string, unknown>;
    this.emitted.push({ event, payload: request });
    const response = this.server(event, request);
    if (response !== DROP) queueMicrotask(() => ack(response));
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])])
      (listener as (...values: unknown[]) => void)(...args);
  }
  count(event?: string) {
    return event
      ? this.emitted.filter((item) => item.event === event).length
      : [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }
}

/** Map-backed storage. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

/** Mounts socket + recovery hooks for a role and exposes `submit`. */
function mount(options: {
  role: "player" | "host";
  socket: FakeSocket;
  store: StoreApi<GameState>;
  storage: ReturnType<typeof memoryStorage>;
  onAuthExpired?: () => Promise<string | null>;
}) {
  const api: { submit: (() => Promise<SubmitOutcome>) | null } = { submit: null };
  function Game() {
    const socket = useGameSocket({
      url: "http://ws.test",
      role: options.role,
      store: options.store,
      createSocket: () => options.socket,
      random: () => 0,
    });
    const recovery = useSessionRecovery({
      socket,
      store: options.store,
      role: options.role,
      pinCode: PIN,
      sessionId: SESSION,
      storage: options.storage,
      serverNow: () => T0 + 5_000,
      ...(options.onAuthExpired ? { onAuthExpired: options.onAuthExpired } : {}),
    });
    api.submit = recovery.submit;
    return null;
  }
  const view = render(
    <LocaleProvider
      initial={testInitialLocale("en", ["common"])}
      preferences={createLocalePreferences({ storage: () => null, writeCookie: () => {} })}
    >
      <Game />
    </LocaleProvider>,
  );
  return { ...view, submit: () => api.submit?.() ?? Promise.resolve("invalid" as SubmitOutcome) };
}

/** Lets microtasks and pending timers settle. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("session recovery", () => {
  it("resolves a lost submit ACK by sync: accepted answers are locked and never re-sent", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage,
    );
    let accepted: { submissionId: string; answer: number } | null = null;
    const socket = new FakeSocket((event, payload) => {
      const requestId = String(payload.requestId);
      if (event === "player:join_room")
        return ok(requestId, {
          playerId: PLAYER,
          sessionId: SESSION,
          sessionToken: TOKEN,
          recovered: true,
          snapshot: playerSnapshot(10),
        });
      if (event === "player:submit_answer") {
        accepted = { submissionId: String(payload.submissionId), answer: Number(payload.answer) };
        return DROP; // processed, ACK lost
      }
      if (event === "room:sync") return ok(requestId, { snapshot: playerSnapshot(12, accepted) });
      return DROP;
    });
    const store = createGameStore();
    const view = mount({ role: "player", socket, store, storage });
    await settle();
    expect(store.getState().snapshot?.sessionId).toBe(SESSION);
    expect(store.getState().setDraft(QUESTION, 0)).toBe(true);

    let outcome: SubmitOutcome | null = null;
    void view.submit().then((value) => (outcome = value));
    await settle(5_000);
    expect(outcome).toBe("pending");
    await settle();
    expect(currentDraft(store.getState())).toMatchObject({ status: "accepted", value: 0 });
    expect(socket.count("player:submit_answer")).toBe(1);
    expect(socket.count("room:sync")).toBe(1);
  });

  it("re-sends only the identical submission when sync shows it never arrived", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage,
    );
    let submits = 0;
    const socket = new FakeSocket((event, payload) => {
      const requestId = String(payload.requestId);
      if (event === "player:join_room")
        return ok(requestId, {
          playerId: PLAYER,
          sessionId: SESSION,
          sessionToken: TOKEN,
          recovered: true,
          snapshot: playerSnapshot(10),
        });
      if (event === "player:submit_answer") {
        submits += 1;
        if (submits === 1) return DROP; // lost on the way: never processed
        return ok(requestId, {
          accepted: true,
          submissionId: payload.submissionId,
          questionIndex: 0,
          receivedAt: T0 + 6_000,
        });
      }
      if (event === "room:sync") return ok(requestId, { snapshot: playerSnapshot(11) });
      return DROP;
    });
    const store = createGameStore();
    const view = mount({ role: "player", socket, store, storage });
    await settle();
    store.getState().setDraft(QUESTION, 1);
    void view.submit();
    await settle(5_000);
    await settle();
    const sent = socket.emitted
      .filter((item) => item.event === "player:submit_answer")
      .map((item) => item.payload);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.submissionId).toBe(sent[0]?.submissionId);
    expect(sent[1]?.answer).toBe(sent[0]?.answer);
    expect(currentDraft(store.getState())?.status).toBe("accepted");
  });

  it("recovers an accepted answer after a page refresh without resubmitting", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage,
    );
    const submissionId = "6b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
    const socket = new FakeSocket((event, payload) =>
      event === "player:join_room"
        ? ok(String(payload.requestId), {
            playerId: PLAYER,
            sessionId: SESSION,
            sessionToken: TOKEN,
            recovered: true,
            snapshot: playerSnapshot(20, { submissionId, answer: 0 }),
          })
        : DROP,
    );
    const store = createGameStore(); // fresh page: empty store
    mount({ role: "player", socket, store, storage });
    await settle();
    expect(socket.emitted[0]).toMatchObject({
      event: "player:join_room",
      payload: { sessionId: SESSION, sessionToken: TOKEN, pinCode: PIN },
    });
    expect(currentDraft(store.getState())).toMatchObject({
      status: "accepted",
      submissionId,
      value: 0,
    });
    expect(socket.count("player:submit_answer")).toBe(0);
    expect(store.getState().setDraft(QUESTION, 1)).toBe(false);
  });

  it("clears the token after a kick and never rejoins automatically", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage,
    );
    const socket = new FakeSocket((event, payload) =>
      event === "player:join_room"
        ? ok(String(payload.requestId), {
            playerId: PLAYER,
            sessionId: SESSION,
            sessionToken: TOKEN,
            recovered: true,
            snapshot: playerSnapshot(10),
          })
        : DROP,
    );
    const store = createGameStore();
    mount({ role: "player", socket, store, storage });
    await settle();
    act(() => socket.fire("player:kicked", envelope({ reason: "HOST_REMOVED" }, 11)));
    expect(store.getState().terminal).toBe("KICKED");
    expect(storage.data.has(`${PLAYER_KEY_PREFIX}${SESSION}`)).toBe(false);
    expect(storage.data.has(`${PLAYER_PIN_PREFIX}${PIN}`)).toBe(false);
    expect(socket.connected).toBe(false);
    await settle(60_000);
    act(() => socket.connect()); // even if the transport comes back
    await settle();
    expect(socket.count("player:join_room")).toBe(1);
  });

  it("ends a replaced session and an invalid recovery token without reconnecting", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage,
    );
    const socket = new FakeSocket((event, payload) =>
      event === "player:join_room"
        ? ok(String(payload.requestId), {
            playerId: PLAYER,
            sessionId: SESSION,
            sessionToken: TOKEN,
            recovered: true,
            snapshot: playerSnapshot(10),
          })
        : DROP,
    );
    const store = createGameStore();
    mount({ role: "player", socket, store, storage });
    await settle();
    act(() => socket.fire("player:session_replaced", envelope({ reason: "SESSION_REPLACED" }, 11)));
    act(() => socket.drop("io server disconnect"));
    await settle(60_000);
    expect(store.getState().terminal).toBe("SESSION_REPLACED");
    expect(socket.connects).toBe(1);
    expect(storage.data.size).toBe(0);

    const storage2 = memoryStorage();
    savePlayerSession(
      { sessionId: SESSION, playerId: PLAYER, sessionToken: TOKEN, pinCode: PIN },
      storage2,
    );
    const rejected = new FakeSocket((event, payload) =>
      event === "player:join_room"
        ? fail(String(payload.requestId), 401, "INVALID_SESSION_TOKEN")
        : DROP,
    );
    const store2 = createGameStore();
    mount({ role: "player", socket: rejected, store: store2, storage: storage2 });
    await settle();
    expect(store2.getState().terminal).toBe("SESSION_REPLACED");
    expect(storage2.data.size).toBe(0);
  });

  it("reconnects with backoff over consecutive failures and honours retry-after", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(() => DROP);
    const store = createGameStore();
    mount({ role: "player", socket, store, storage: memoryStorage() });
    await settle();
    expect(socket.connects).toBe(1);
    socket.failNext = 2; // the next two attempts fail
    act(() => socket.drop());
    await settle(999);
    expect(socket.connects).toBe(1);
    await settle(1); // 1 s → attempt 2 fails
    expect(socket.connects).toBe(2);
    await settle(1_999);
    expect(socket.connects).toBe(2);
    await settle(1); // 2 s → attempt 3 fails
    expect(socket.connects).toBe(3);
    await settle(3_999);
    expect(socket.connects).toBe(3);
    await settle(1); // 4 s → attempt 4 succeeds; the backoff resets
    expect(socket.connects).toBe(4);
    expect(store.getState().transport.status).toBe("connected");
    // A rate-limited reconnect: the server's retry-after outlasts the backoff step.
    socket.failNext = 1;
    socket.failDetail = { data: { params: { retryAfterMs: 9_000 } } };
    act(() => socket.drop());
    await settle(1_000); // attempt fails with retry-after 9 s
    const after = socket.connects;
    await settle(8_999);
    expect(socket.connects).toBe(after);
    await settle(1);
    expect(socket.connects).toBe(after + 1);
  });

  it("refreshes the host token with auth:update and recovers the room", async () => {
    vi.useFakeTimers();
    let authorized = false;
    const socket = new FakeSocket((event, payload) => {
      const requestId = String(payload.requestId);
      if (event === "host:recover_room")
        return authorized
          ? ok(requestId, { snapshot: hostSnapshot(30) })
          : fail(requestId, 401, "TOKEN_EXPIRED");
      if (event === "auth:update") {
        authorized = payload.accessToken === "fresh-token";
        return ok(requestId, { authenticated: true });
      }
      return DROP;
    });
    const store = createGameStore();
    const onAuthExpired = vi.fn(async () => "fresh-token");
    mount({ role: "host", socket, store, storage: memoryStorage(), onAuthExpired });
    await settle();
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(socket.emitted.map((item) => item.event)).toEqual([
      "host:recover_room",
      "auth:update",
      "host:recover_room",
    ]);
    expect(store.getState().snapshot?.role).toBe("host");
  });
});

describe("listeners", () => {
  it("never adds duplicate socket listeners on re-renders or locale switches", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket(() => DROP);
    const store = createGameStore();
    const loader = {
      registry: { buildId: "test", catalogVersion: "1", locales: [] } as never,
      installed: ["en", "fr"],
      entry: (tag: string) => ({ tag }) as never,
      load: async (tag: string) => deserializeCatalog(testInitialLocale(tag, ["common"]).catalog),
    } as CatalogLoader;
    const holder: {
      setLocale: ((tag: string) => Promise<boolean>) | null;
      bump: (() => void) | null;
    } = { setLocale: null, bump: null };
    function Game() {
      const { setLocale, t } = useLocale();
      const [, setTick] = useState(0);
      holder.setLocale = setLocale;
      holder.bump = () => setTick((value) => value + 1);
      const client = useGameSocket({
        url: "http://ws.test",
        role: "player",
        store,
        createSocket: () => socket,
        random: () => 0,
      });
      useSessionRecovery({
        socket: client,
        store,
        role: "player",
        pinCode: PIN,
        storage: memoryStorage(),
      });
      return <p>{t("common.language.label")}</p>;
    }
    const view = render(
      <LocaleProvider
        initial={testInitialLocale("en", ["common"])}
        loader={loader}
        preferences={createLocalePreferences({ storage: () => null, writeCookie: () => {} })}
      >
        <Game />
      </LocaleProvider>,
    );
    await settle();
    const before = socket.count();
    expect(socket.listeners.get("game:answer_reveal")?.size).toBe(1);
    await act(async () => {
      await holder.setLocale?.("fr");
    });
    expect(view.getByText("Langue")).toBeInTheDocument();
    for (let i = 0; i < 5; i++) act(() => holder.bump?.());
    expect(socket.count()).toBe(before);
    expect(socket.listeners.get("connect")?.size).toBe(2); // use-socket + recovery, once each
    view.unmount();
    expect(socket.count()).toBe(0);
  });
});
