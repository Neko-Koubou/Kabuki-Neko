/**
 * TASK-129 coverage for clock sync and the game timer: the offset is the median of the latest
 * five RTT-midpoint samples on a monotonic clock (device wall-clock jumps are ignored), sampling
 * happens on connect, on reconnect and every 30 s, a rebase never makes the visible time grow for
 * the same deadline, the display stops at 0 with the grace waiting message and then the closed
 * message, a recovered/new phase deadline starts fresh, announcements happen once each, the timer
 * ticks without re-rendering its parent, and nothing here touches server acceptance or timing.
 */
import { act, screen } from "@testing-library/react";
import { createElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { GameTimer, displaySeconds } from "@/components/player/game-timer";
import type { SocketLike } from "@/lib/socket-client";
import { createGameSocket } from "@/lib/socket-client";
import { createGameStore } from "@/stores/game.store";
import { renderWithLocale } from "@/test/locale";
import { CLOCK_RESYNC_MS, createClockSync, sampleOffset, useGameClock } from "./use-game-clock";

const NAMESPACES = ["common", "accessibility", "player"] as const;
const T0 = 1_700_000_000_000;

describe("clock sync model", () => {
  it("uses the median of the latest five RTT-midpoint samples", () => {
    let perf = 1_000;
    const clock = createClockSync(() => perf);
    // RTT 100 ms, 10 ms server processing → midpoint correction 45 ms.
    expect(
      sampleOffset({
        sentPerf: 0,
        receivedPerf: 100,
        serverReceivedAt: T0 + 50,
        serverSentAt: T0 + 60,
      }),
    ).toBe(T0 + 60 + 45 - 100);
    const offsets = [10, 12, 9_999, 11, 13, 14]; // one outlier, six samples
    for (const offset of offsets)
      clock.addSample({
        sentPerf: 0,
        receivedPerf: 0,
        serverReceivedAt: offset,
        serverSentAt: offset,
      });
    expect(clock.sampleCount).toBe(5); // the first sample dropped
    expect(clock.offset()).toBe(13); // median of [12, 9999, 11, 13, 14]
    perf = 5_000;
    expect(clock.serverNow()).toBe(5_013);
  });

  it("ignores device wall-clock jumps and uses a provisional offset before the first sample", () => {
    let perf = 0;
    const clock = createClockSync(() => perf);
    clock.setProvisional(T0);
    expect(clock.synced).toBe(false);
    expect(clock.serverNow()).toBe(T0);
    clock.addSample({
      sentPerf: 0,
      receivedPerf: 40,
      serverReceivedAt: T0 + 20,
      serverSentAt: T0 + 20,
    });
    const before = clock.serverNow();
    vi.spyOn(Date, "now").mockReturnValue(T0 + 3_600_000); // the user changes the device clock
    perf += 1_000;
    expect(clock.serverNow()).toBe(before + 1_000);
    expect(clock.synced).toBe(true);
  });
});

/** Socket double answering `room:time` with a scripted server clock. */
class TimeSocket implements SocketLike {
  connected = false;
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  times = 0;
  constructor(private serverClock: () => number) {}
  connect() {
    this.connected = true;
    this.fire("connect");
  }
  disconnect() {
    this.connected = false;
    this.fire("disconnect", "transport close");
  }
  on(event: string, listener: (...args: never[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(listener);
  }
  off(event: string, listener: (...args: never[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string, payload: unknown, ack: (response: unknown) => void) {
    if (event !== "room:time") return;
    this.times += 1;
    const request = payload as { requestId: string; clientSentAt: number };
    const at = this.serverClock();
    queueMicrotask(() =>
      ack({
        ok: true,
        requestId: request.requestId,
        serverTime: at,
        data: { clientSentAt: request.clientSentAt, serverReceivedAt: at, serverSentAt: at },
      }),
    );
  }
  fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])])
      (listener as (...values: unknown[]) => void)(...args);
  }
}

describe("useGameClock", () => {
  it("samples on connect, every 30 s and again after a reconnect, without touching the snapshot", async () => {
    vi.useFakeTimers();
    const store = createGameStore();
    store.setState({
      snapshot: {
        sessionId: "1c0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
        pinCode: "135790",
        serverTime: T0,
        timing: { inputClosesAt: T0 + 20_000 },
      } as never,
    });
    const timingBefore = JSON.stringify(store.getState().snapshot);
    const raw = new TimeSocket(() => T0 + Date.now());
    const client = createGameSocket({
      url: "http://ws.test",
      role: "player",
      createSocket: () => raw,
    });
    const result: { synced: boolean } = { synced: false };
    function Clock() {
      const clock = useGameClock({ socket: client, store });
      result.synced = clock.synced;
      return null;
    }
    raw.connect();
    renderWithLocale(createElement(Clock), { namespaces: [...NAMESPACES] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(raw.times).toBe(1);
    expect(result.synced).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_RESYNC_MS * 2);
    });
    expect(raw.times).toBe(3);
    act(() => raw.disconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOCK_RESYNC_MS * 3);
    });
    expect(raw.times).toBe(3); // no sampling while disconnected
    act(() => raw.connect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(raw.times).toBe(4);
    expect(JSON.stringify(store.getState().snapshot)).toBe(timingBefore); // acceptance/timing untouched
  });
});

describe("GameTimer", () => {
  it("never grows on a rebase, stops at zero with the grace message, then closes", () => {
    vi.useFakeTimers();
    let server = T0 + 2_000;
    const onInputClosed = vi.fn();
    renderWithLocale(
      createElement(GameTimer, {
        questionStartedAt: T0,
        inputClosesAt: T0 + 20_000,
        acceptanceClosesAt: T0 + 21_500,
        serverNow: () => server,
        onInputClosed,
        tickMs: 100,
      }),
      { namespaces: [...NAMESPACES] },
    );
    const timer = screen.getByRole("timer", { name: "Time remaining" });
    expect(timer).toHaveTextContent("18 seconds left");
    // A rebase makes the server clock appear 3 s earlier: the display must not go back up.
    server -= 3_000;
    act(() => vi.advanceTimersByTime(100));
    expect(timer).toHaveTextContent("18 seconds left");
    // The other way it shortens immediately.
    server += 7_000;
    act(() => vi.advanceTimersByTime(100));
    expect(timer).toHaveTextContent("14 seconds left");

    server = T0 + 20_000; // deadline
    act(() => vi.advanceTimersByTime(100));
    expect(timer).toHaveTextContent("No time left");
    expect(screen.getByText("Waiting for results…")).toBeInTheDocument();
    expect(onInputClosed).toHaveBeenCalledTimes(1);
    server = T0 + 25_000; // past grace; still clamped at zero
    act(() => vi.advanceTimersByTime(500));
    expect(timer.textContent).toContain("0");
    expect(screen.getByText("Answers are closed.")).toBeInTheDocument();
    expect(onInputClosed).toHaveBeenCalledTimes(1);
    expect(displaySeconds(-50)).toBe(0);
    expect(displaySeconds(1)).toBe(1);
  });

  it("announces opening, five seconds and closing once each, and starts fresh for a new deadline", () => {
    vi.useFakeTimers();
    let server = T0;
    const announcements: string[] = [];
    const { rerender } = renderWithLocale(
      createElement(GameTimer, {
        questionStartedAt: T0,
        inputClosesAt: T0 + 10_000,
        acceptanceClosesAt: T0 + 11_500,
        serverNow: () => server,
        tickMs: 100,
      }),
      { namespaces: [...NAMESPACES] },
    );
    const live = screen.getByRole("status");
    const record = () => {
      const text = live.textContent ?? "";
      if (text && announcements.at(-1) !== text) announcements.push(text);
    };
    record();
    for (let step = 0; step < 120; step++) {
      server += 100;
      act(() => vi.advanceTimersByTime(100));
      record();
    }
    expect(announcements).toEqual(["10 seconds left", "5 seconds left", "Time's up."]);

    // Recovered into the next question: a new deadline resets the display and announcements.
    server = T0 + 30_000;
    rerender(
      createElement(GameTimer, {
        questionStartedAt: T0 + 30_000,
        inputClosesAt: T0 + 50_000,
        acceptanceClosesAt: T0 + 51_500,
        serverNow: () => server,
        tickMs: 100,
      }),
    );
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByRole("timer")).toHaveTextContent("20 seconds left");
    expect(live).toHaveTextContent("20 seconds left");
  });

  it("ticks without re-rendering its parent and renders nothing when untimed", () => {
    vi.useFakeTimers();
    let server = T0;
    const renders = { parent: 0 };
    function Parent() {
      const count = useRef(0);
      count.current += 1;
      renders.parent = count.current;
      return createElement(GameTimer, {
        questionStartedAt: T0,
        inputClosesAt: T0 + 20_000,
        acceptanceClosesAt: null,
        serverNow: () => server,
        tickMs: 100,
      });
    }
    renderWithLocale(createElement(Parent), { namespaces: [...NAMESPACES] });
    const initial = renders.parent;
    for (let i = 0; i < 30; i++) {
      server += 100;
      act(() => vi.advanceTimersByTime(100));
    }
    expect(renders.parent).toBe(initial);
    expect(screen.getByRole("timer")).toHaveTextContent("17 seconds left");

    const { container } = renderWithLocale(
      createElement(GameTimer, {
        questionStartedAt: null,
        inputClosesAt: null,
        acceptanceClosesAt: null,
        serverNow: () => server,
      }),
      { namespaces: [...NAMESPACES] },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
