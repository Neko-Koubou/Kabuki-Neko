/**
 * Host command auth renewal (code review MJ-22): the server re-checks the socket's access token
 * on every host command and tokens live 15 minutes, so an auth error renews the token once,
 * announces it, and re-sends the same command with the same requestId.
 */
import { describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";
import type { GameSocket } from "@/lib/socket-client";
import type { GameState } from "@/stores/game.store";
import { createHostCommands } from "./host-stage";

const SESSION = "1b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";

/** Store double holding a synced host snapshot. */
function hostStore() {
  const requestSync = vi.fn();
  const state = {
    snapshot: { role: "host", sessionId: SESSION, pinCode: "246810", phaseVersion: 4 },
    requestSync,
  };
  return { store: { getState: () => state } as unknown as StoreApi<GameState>, requestSync };
}

/** Emit double answering with the scripted results in order. */
function emitter(results: unknown[]) {
  const emit = vi.fn(async (_event: string, payload: Record<string, unknown>) => {
    const next = results.shift() as Record<string, unknown>;
    return { requestId: payload.requestId ?? "11111111-1111-4111-8111-111111111111", ...next };
  });
  return { socket: { emit } as unknown as Pick<GameSocket, "emit">, emit };
}

const expired = { status: "error", error: { errorCode: "TOKEN_EXPIRED", message: "x" } };

describe("host command auth renewal (MJ-22)", () => {
  it("renews an expired token and re-sends the command once with the same requestId", async () => {
    const { store } = hostStore();
    const { socket, emit } = emitter([expired, { status: "ok", data: {} }]);
    const renewAuth = vi.fn(async () => true);
    const commands = createHostCommands(socket, store, renewAuth);
    await expect(commands.next()).resolves.toEqual({ status: "ok" });
    expect(renewAuth).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toBe("host:next_step");
    expect(emit.mock.calls[1]?.[1]).toMatchObject({
      sessionId: SESSION,
      expectedPhaseVersion: 4,
      requestId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("returns the auth error when renewal fails and does not re-send", async () => {
    const { store } = hostStore();
    const { socket, emit } = emitter([expired]);
    const commands = createHostCommands(socket, store, async () => false);
    await expect(commands.kick("2b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f")).resolves.toEqual({
      status: "error",
      errorCode: "TOKEN_EXPIRED",
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("never retries other errors, and works without a renewer", async () => {
    const { store } = hostStore();
    const stale = { status: "error", error: { errorCode: "STALE_PHASE", message: "x" } };
    const renewAuth = vi.fn(async () => true);
    const first = emitter([stale]);
    await expect(createHostCommands(first.socket, store, renewAuth).start()).resolves.toEqual({
      status: "error",
      errorCode: "STALE_PHASE",
    });
    expect(renewAuth).not.toHaveBeenCalled();
    const second = emitter([expired]);
    await expect(createHostCommands(second.socket, store).lock(true)).resolves.toEqual({
      status: "error",
      errorCode: "TOKEN_EXPIRED",
    });
    expect(second.emit).toHaveBeenCalledTimes(1);
  });
});
