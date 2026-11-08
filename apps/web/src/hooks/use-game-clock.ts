"use client";
/**
 * Server clock synchronization (SA §6.4; Design §7.1, F15; US-10/US-18; TASK-129).
 *
 * - Each `room:time` round trip gives one sample: the server time at the moment the reply arrived
 *   is estimated as `serverSentAt + RTT/2`, where `RTT = (receive − send) − (serverSentAt −
 *   serverReceivedAt)` measured with `performance.now()`. The offset is stored against the
 *   monotonic `performance.now()` clock, so a device wall-clock jump never moves game time.
 * - The offset in use is the median of the latest five samples (outliers from one slow packet
 *   are ignored). Before the first sample, the snapshot's `serverTime` gives a provisional,
 *   unsynced estimate.
 * - Samples are taken on every (re)connect and every 30 s while connected. Only sample arrival
 *   updates React state; `serverNow()` is a stable function read by timers on their own schedule,
 *   so no global re-render happens per tick.
 * - The clock only displays time: it never extends a deadline, submits answers or edits the
 *   snapshot; the server alone decides acceptance.
 */
import { useCallback, useEffect, useState } from "react";
import type { StoreApi } from "zustand";
import type { GameSocket } from "@/lib/socket-client";
import type { GameState } from "@/stores/game.store";

/** Number of recent samples whose median is used. */
export const CLOCK_SAMPLES = 5;
/** Re-sync period while connected. */
export const CLOCK_RESYNC_MS = 30_000;

/** One round-trip measurement. */
export interface ClockSample {
  /** `performance.now()` when the request was sent / the reply arrived. */
  sentPerf: number;
  receivedPerf: number;
  serverReceivedAt: number;
  serverSentAt: number;
}

/** Monotonic clock source (injectable for tests). */
export type PerfNow = () => number;

/** Offset (server epoch ms − performance.now()) estimated from one sample. */
export function sampleOffset(sample: ClockSample): number {
  const processing = Math.max(0, sample.serverSentAt - sample.serverReceivedAt);
  const rtt = Math.max(0, sample.receivedPerf - sample.sentPerf - processing);
  return sample.serverSentAt + rtt / 2 - sample.receivedPerf;
}

/** Median of a non-empty list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Pure clock model: samples in, server time out. */
export function createClockSync(perfNow: PerfNow = () => performance.now()) {
  let samples: number[] = [];
  let provisional: number | null = null;
  return {
    /** Adds a round-trip sample (keeps the latest five). */
    addSample(sample: ClockSample) {
      samples = [...samples, sampleOffset(sample)].slice(-CLOCK_SAMPLES);
    },
    /** Provisional offset from a snapshot's `serverTime` (used until the first sample). */
    setProvisional(serverTime: number) {
      provisional = serverTime - perfNow();
    },
    /** Current offset (median of samples, else provisional, else wall clock). */
    offset(): number {
      if (samples.length > 0) return median(samples);
      return provisional ?? Date.now() - perfNow();
    },
    /** Estimated server time (epoch ms), monotonic between rebases. */
    serverNow(): number {
      return perfNow() + this.offset();
    },
    get synced() {
      return samples.length > 0;
    },
    get sampleCount() {
      return samples.length;
    },
    reset() {
      samples = [];
      provisional = null;
    },
  };
}

/** The clock model type. */
export type ClockSync = ReturnType<typeof createClockSync>;

/** Options of {@link useGameClock}. */
export interface GameClockOptions {
  socket: GameSocket;
  store: StoreApi<GameState>;
  perfNow?: PerfNow;
  resyncMs?: number;
}

/** Keeps a synchronized server clock for the current room. */
export function useGameClock({
  socket,
  store,
  perfNow,
  resyncMs = CLOCK_RESYNC_MS,
}: GameClockOptions) {
  const [clock] = useState(() => createClockSync(perfNow));
  const [status, setStatus] = useState({ synced: false, samples: 0 });

  /** Measures one round trip and records it. */
  const measure = useCallback(async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot || !socket.connected) return;
    const now = perfNow ?? (() => performance.now());
    const sentPerf = now();
    const result = await socket.emit("room:time", {
      sessionId: snapshot.sessionId,
      pinCode: snapshot.pinCode,
      clientSentAt: Date.now(),
    });
    if (result.status !== "ok") return;
    clock.addSample({
      sentPerf,
      receivedPerf: now(),
      serverReceivedAt: result.data.serverReceivedAt,
      serverSentAt: result.data.serverSentAt,
    });
    setStatus({ synced: clock.synced, samples: clock.sampleCount });
  }, [socket, store, clock, perfNow]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) clearInterval(timer);
      void measure();
      timer = setInterval(() => void measure(), resyncMs);
    };
    const offConnect = socket.onLifecycle("connect", start);
    const offDisconnect = socket.onLifecycle("disconnect", () => {
      if (timer) clearInterval(timer);
      timer = null;
    });
    // A snapshot arriving before the first sample gives a provisional offset; a new snapshot
    // after a reconnect triggers a fresh measurement.
    const offStore = store.subscribe((state, previous) => {
      if (state.snapshot && state.snapshot !== previous.snapshot) {
        if (!clock.synced) clock.setProvisional(state.snapshot.serverTime);
        if (!previous.snapshot || previous.snapshot.sessionId !== state.snapshot.sessionId)
          void measure();
      }
    });
    if (socket.connected) start();
    return () => {
      if (timer) clearInterval(timer);
      offConnect();
      offDisconnect();
      offStore();
    };
  }, [socket, store, clock, measure, resyncMs]);

  const serverNow = useCallback(() => clock.serverNow(), [clock]);
  return { serverNow, synced: status.synced, samples: status.samples, measure };
}
