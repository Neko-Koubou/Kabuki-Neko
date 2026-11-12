/**
 * TASK-152 coverage for F17 connection recovery with a real game store.
 * - The five states:
 *   - empty: no credentials → join link;
 *   - loading: first sync;
 *   - ideal: live, with controls usable;
 *   - partial: reconnecting with backoff, catching up, state-store outage, with stale content locked;
 *   - error: lost before or after the first sync, with Retry/Leave.
 * - A pending answer is never shown as accepted while syncing.
 * - Terminal outcomes clear stored credentials once and never reconnect (kicked, replaced, invalid
 *   token → room lost/expired).
 * - The host's expired sign-in.
 * - The pure view derivation.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createGameStore, draftKey, type GameState, type RoomSnapshot } from "@/stores/game.store";
import { renderWithLocale } from "@/test/locale";
import {
  ConnectionRecovery,
  recoveryView,
  type ConnectionRecoveryProps,
} from "./connection-recovery";

const NAMESPACES = ["common", "accessibility", "player", "validation", "auth"] as const;
const SESSION = "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b";
const QUESTION = "11111111-2222-4333-8444-555555555555";

/** Minimal player snapshot for the recovery layer (other fields are not read here). */
function snapshot(): RoomSnapshot {
  return {
    role: "player",
    sessionId: SESSION,
    phase: "QUESTION_ANSWERING",
    question: { id: QUESTION },
    self: { acceptedAnswer: null },
    timing: { acceptanceClosesAt: null },
  } as unknown as RoomSnapshot;
}

/** Map-backed storage holding credentials for SESSION. */
function storageWithCredentials() {
  const map = new Map<string, string>([
    [
      `kabuki:player:${SESSION}`,
      JSON.stringify({
        sessionId: SESSION,
        playerId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        sessionToken: "A".repeat(43),
        pinCode: "000123",
      }),
    ],
    ["kabuki:player-pin:000123", SESSION],
  ]);
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: vi.fn((key: string) => void map.delete(key)),
  };
}

/** Renders the recovery layer around a screen with an answer button. */
function renderRecovery(
  props: Partial<ConnectionRecoveryProps> = {},
  state: Partial<GameState> = {},
) {
  const store = props.store ?? createGameStore();
  store.setState(state);
  const onRetry = vi.fn();
  const onLeave = vi.fn();
  const answer = vi.fn();
  const view = renderWithLocale(
    <ConnectionRecovery
      role="player"
      store={store}
      sessionId={SESSION}
      onRetry={onRetry}
      onLeave={onLeave}
      {...props}
    >
      <button type="button" onClick={answer}>
        Answer A
      </button>
    </ConnectionRecovery>,
    { namespaces: [...NAMESPACES] },
  );
  return { ...view, store, onRetry, onLeave, answer };
}

const live = {
  snapshot: snapshot(),
  transport: { status: "connected" as const, lastHeartbeatAt: 1 },
};

describe("ConnectionRecovery", () => {
  it("covers empty, first sync and the live screen", async () => {
    const user = userEvent.setup();
    const empty = renderRecovery({ sessionId: null });
    expect(screen.getByText("Join a game to connect.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Join a game" })).toHaveAttribute("href", "/join");
    empty.unmount();

    const first = renderRecovery(
      {},
      { transport: { status: "connecting", lastHeartbeatAt: null } },
    );
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    expect(screen.queryByRole("button", { name: "Answer A" })).not.toBeInTheDocument();
    act(() => first.store.setState(live));
    expect(screen.getByRole("status")).toHaveTextContent("Connected");
    await user.click(screen.getByRole("button", { name: "Answer A" }));
    expect(first.answer).toHaveBeenCalledTimes(1);
  });

  it("locks stale content while reconnecting, catching up or during a state-store outage", async () => {
    const user = userEvent.setup();
    const view = renderRecovery(
      { nextRetryInSec: 3.2 },
      { ...live, transport: { status: "reconnecting", lastHeartbeatAt: 1 } },
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Reconnecting… (4 sec)");
    const stale = screen.getByRole("button", { name: "Answer A" });
    expect(stale.closest("[inert]")).not.toBeNull();
    await user.click(within(banner).getByRole("button", { name: "Try again" }));
    expect(view.onRetry).toHaveBeenCalledTimes(1);
    await user.click(within(banner).getByRole("button", { name: "Go to home" }));
    expect(view.onLeave).toHaveBeenCalledTimes(1);

    act(() =>
      view.store.setState({
        transport: { status: "connected", lastHeartbeatAt: 2 },
        syncRequested: true,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "You were away for a moment. Catching up with the game…",
    );
    expect(screen.getByRole("button", { name: "Answer A" }).closest("[inert]")).not.toBeNull();

    view.rerender(
      <ConnectionRecovery
        role="player"
        store={view.store}
        sessionId={SESSION}
        outage
        onRetry={view.onRetry}
        onLeave={view.onLeave}
      >
        <button type="button">Answer A</button>
      </ConnectionRecovery>,
    );
    act(() => view.store.setState({ syncRequested: false }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The game service is temporarily unavailable. Please try again shortly.",
    );
    expect(screen.getByRole("button", { name: "Answer A" }).closest("[inert]")).not.toBeNull();
  });

  it("reports a pending answer as unconfirmed while syncing, never as accepted", () => {
    renderRecovery(
      {},
      {
        ...live,
        transport: { status: "reconnecting", lastHeartbeatAt: 1 },
        drafts: {
          [draftKey(SESSION, QUESTION)]: {
            questionId: QUESTION,
            questionIndex: 0,
            value: { kind: "single", optionId: "x" } as never,
            status: "submitting",
            submissionId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          } as never,
        },
      },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sending your answer… Catching up with the game…",
    );
    expect(screen.queryByText("Answer received")).not.toBeInTheDocument();
  });

  it("shows the error state when the connection is lost before or after the first sync", async () => {
    const user = userEvent.setup();
    const first = renderRecovery(
      {},
      { transport: { status: "disconnected", lastHeartbeatAt: null } },
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Couldn't reconnect. Try again, or join again if your session has ended.",
    );
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(first.onRetry).toHaveBeenCalledTimes(1);
    first.unmount();

    renderRecovery({}, { ...live, transport: { status: "disconnected", lastHeartbeatAt: 1 } });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reconnect.");
    expect(screen.getByRole("button", { name: "Answer A" }).closest("[inert]")).not.toBeNull();
  });

  it("clears credentials once on terminal outcomes (kicked, lost) but keeps them when replaced, and never retries", () => {
    for (const [reason, text] of [
      ["KICKED", "The host removed you from this game."],
      [
        "SESSION_REPLACED",
        "This game was opened on another tab or device, so this one was disconnected.",
      ],
      ["ROOM_LOST", "This game has ended or expired."],
    ] as const) {
      const storage = storageWithCredentials();
      const view = renderRecovery({ storage }, { ...live, terminal: reason });
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Answer A" })).not.toBeInTheDocument();
      // A replaced session keeps the record for the replacing tab (MJ-28); others clear it.
      const kept = reason === "SESSION_REPLACED";
      expect(storage.map.has(`kabuki:player:${SESSION}`)).toBe(kept);
      expect(storage.map.has("kabuki:player-pin:000123")).toBe(kept);
      const removals = storage.removeItem.mock.calls.length;
      // Re-rendering the terminal screen does not clear (or reconnect) again.
      act(() => view.store.setState({ transport: { status: "disconnected", lastHeartbeatAt: 1 } }));
      expect(storage.removeItem.mock.calls.length).toBe(removals);
      expect(view.onRetry).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("asks a host with an expired sign-in to sign in again", () => {
    renderRecovery({ role: "host", authExpired: true }, live);
    expect(screen.getByText("Your session has expired. Please sign in again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fdashboard",
    );
  });

  it("derives the view from state and flags", () => {
    const base = {
      snapshot: null,
      transport: { status: "idle" as const, lastHeartbeatAt: null },
      syncRequested: false,
      terminal: null,
    };
    const flags = { hasCredentials: true, outage: false, authExpired: false };
    expect(recoveryView(base, { ...flags, hasCredentials: false })).toEqual({ kind: "empty" });
    expect(recoveryView(base, flags)).toEqual({ kind: "connecting" });
    expect(recoveryView({ ...base, ...live }, flags)).toEqual({ kind: "live" });
    expect(recoveryView({ ...base, ...live }, { ...flags, outage: true })).toEqual({
      kind: "stale",
      reason: "outage",
    });
    expect(recoveryView({ ...base, terminal: "KICKED" }, { ...flags, authExpired: true })).toEqual({
      kind: "terminal",
      reason: "KICKED",
    });
  });
});
