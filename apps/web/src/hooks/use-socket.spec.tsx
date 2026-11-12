/**
 * Socket lifecycle auth handling (code review MJ-22): a handshake rejected for an expired or
 * missing token refreshes the token before the next reconnect, so the reconnect carries the new
 * token instead of retrying the stale one forever; other connect errors just back off.
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SocketLike } from "@/lib/socket-client";
import { createGameStore } from "@/stores/game.store";
import { useGameSocket } from "./use-socket";

/** Socket double whose next connect attempts fail with the given error. */
class FakeSocket implements SocketLike {
  connected = false;
  connects = 0;
  failures: unknown[] = [];
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  connect() {
    this.connects += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) {
      this.fire("connect_error", failure);
      return;
    }
    this.connected = true;
    this.fire("connect");
  }
  disconnect() {
    this.connected = false;
  }
  on(event: string, listener: (...args: never[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(listener);
  }
  off(event: string, listener: (...args: never[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  emit() {}
  fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])])
      (listener as (...values: unknown[]) => void)(...args);
  }
}

/** Mounts the hook with a fake socket and an auth-error handler. */
function mount(socket: FakeSocket, onAuthError?: () => Promise<unknown>) {
  const store = createGameStore();
  function Host() {
    useGameSocket({
      url: "http://ws.test",
      role: "host",
      store,
      createSocket: () => socket,
      random: () => 0,
      ...(onAuthError ? { onAuthError } : {}),
    });
    return null;
  }
  return render(<Host />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useGameSocket auth errors (MJ-22)", () => {
  it("refreshes the token before reconnecting after an AUTH_REQUIRED handshake", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const order: string[] = [];
    socket.failures.push({ data: { errorCode: "AUTH_REQUIRED" } });
    const onAuthError = vi.fn(async () => {
      order.push(`refresh after ${socket.connects} connect(s)`);
    });
    const view = mount(socket, onAuthError);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(socket.connects).toBe(2);
    expect(socket.connected).toBe(true);
    expect(order).toEqual(["refresh after 1 connect(s)"]);
    view.unmount();
  });

  it("does not refresh for other connect errors", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.failures.push(new Error("unreachable"));
    const onAuthError = vi.fn(async () => undefined);
    const view = mount(socket, onAuthError);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(socket.connects).toBe(2);
    view.unmount();
  });
});
