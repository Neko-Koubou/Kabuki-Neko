"use client";
/**
 * `useGameSocket` (SA §5.1, §6.4; US-07/10/12; TASK-128): one stable `/game` connection per page
 * that feeds the game store.
 *
 * - The client is created once; every server push and lifecycle listener is registered in a single
 *   effect keyed only on the client and store, so re-renders, locale or theme switches never add
 *   duplicate listeners. Unmount disconnects and removes all listeners and timers.
 * - Pushes go straight to `store.applyEvent` (fencing lives in the store). Transport status is
 *   mirrored into the store; a heartbeat watchdog checks every 2 s for missed `room:version`.
 * - Reconnection is manual with the SA backoff (1/2/4/8/16/30 s + jitter, at least a server
 *   `retryAfterMs`), reset after a successful connect, and stopped for good when the store records a
 *   terminal outcome (kicked, replaced, expired) or the page disconnects deliberately.
 */
import { useEffect, useRef, useState } from "react";
import type { StoreApi } from "zustand";
import { hostEventDataSchemas, playerEventDataSchemas } from "@kabuki-neko/shared/socket-events";
import {
  backoffDelay,
  createGameSocket,
  type GameSocket,
  type GameSocketOptions,
} from "@/lib/socket-client";
import type { GameState } from "@/stores/game.store";

/** Options of {@link useGameSocket}. */
export interface UseGameSocketOptions extends Omit<GameSocketOptions, "getAccessToken"> {
  store: StoreApi<GameState>;
  getAccessToken?: () => string | null;
  /** Randomness for jitter (tests). */
  random?: () => number;
}

/** How often missed heartbeats are checked. */
const HEARTBEAT_CHECK_MS = 2_000;

/** Retry-after hint carried by a Socket.IO connect error, if any. */
function retryAfterOf(error: unknown): number | null {
  const data = (error as { data?: { params?: { retryAfterMs?: unknown } } } | undefined)?.data;
  const value = data?.params?.retryAfterMs;
  return typeof value === "number" && value >= 0 ? value : null;
}

/** Creates, connects and supervises the page's game socket. */
export function useGameSocket(options: UseGameSocketOptions): GameSocket {
  const tokenGetter = useRef(options.getAccessToken);
  tokenGetter.current = options.getAccessToken;
  const [client] = useState(() =>
    createGameSocket({
      url: options.url,
      role: options.role,
      getAccessToken: () => tokenGetter.current?.() ?? null,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
      ...(options.ackTimeoutMs ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
    }),
  );
  const { store, role } = options;
  const random = useRef(options.random ?? Math.random);

  useEffect(() => {
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dueAt = 0;
    let stopped = false;
    const unsubscribers: (() => void)[] = [];
    const events = Object.keys(role === "host" ? hostEventDataSchemas : playerEventDataSchemas);

    /** Schedules the next reconnect unless the session ended or the page stopped. */
    const scheduleReconnect = (retryAfterMs: number | null) => {
      if (stopped || store.getState().terminal !== null) return;
      if (timer !== null) {
        // Already scheduled: only a longer server retry-after may push it back.
        if (retryAfterMs === null || Date.now() + retryAfterMs <= dueAt) return;
        clearTimeout(timer);
        timer = null;
      }
      const delay = backoffDelay(attempt, retryAfterMs, random.current);
      attempt += 1;
      dueAt = Date.now() + delay;
      timer = setTimeout(() => {
        timer = null;
        if (!stopped && store.getState().terminal === null) {
          store.getState().setTransport("connecting");
          client.connect();
        }
      }, delay);
    };

    for (const event of events)
      unsubscribers.push(
        client.on(event, (envelope) => store.getState().applyEvent(event, envelope)),
      );
    unsubscribers.push(
      client.onLifecycle("connect", () => {
        attempt = 0;
        store.getState().setTransport("connected");
      }),
      client.onLifecycle("disconnect", (reason) => {
        if (stopped || reason === "io client disconnect" || store.getState().terminal !== null) {
          store.getState().setTransport("disconnected");
          return;
        }
        store.getState().setTransport("reconnecting");
        scheduleReconnect(null);
      }),
      client.onLifecycle("connect_error", (error) => {
        store.getState().setTransport("reconnecting");
        scheduleReconnect(retryAfterOf(error));
      }),
    );
    // A terminal outcome ends the connection and any pending reconnect.
    unsubscribers.push(
      store.subscribe((state, previous) => {
        if (state.terminal !== null && previous.terminal === null) {
          if (timer) clearTimeout(timer);
          timer = null;
          client.disconnect();
        }
      }),
    );
    const watchdog = setInterval(
      () => store.getState().checkHeartbeat(Date.now()),
      HEARTBEAT_CHECK_MS,
    );

    store.getState().setTransport("connecting");
    client.connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(watchdog);
      for (const unsubscribe of unsubscribers) unsubscribe();
      client.disconnect();
    };
  }, [client, store, role]);

  return client;
}
