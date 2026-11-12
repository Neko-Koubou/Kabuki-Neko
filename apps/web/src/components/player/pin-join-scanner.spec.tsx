/**
 * TASK-151 unit coverage for the guest join flow (S14) with a scripted socket.
 * - PIN normalization with leading zeros and pasted separators.
 * - Empty guidance, check, then the identity step and the game route.
 * - A deep link is checked exactly once, even under StrictMode.
 * - Wrong PIN, locked, full, in progress: no polling.
 * - Rate limit waits with the server's seconds; offline/unknown offers retry.
 * - Recovery with stored credentials (also while the game runs), and dead credentials cleared
 *   before a new join.
 * - The QR scanner dialog opens and returns to manual entry.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { PinJoinScanner, normalizePin, type JoinSocket } from "./pin-join-scanner";

const NAMESPACES = ["common", "accessibility", "player", "validation"] as const;
const SESSION = "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b";
const PLAYER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TOKEN = "A".repeat(43);

/** ACK helpers. */
const ok = (data: unknown) => ({ status: "ok", requestId: "r", serverTime: 1, data });
const fail = (errorCode: string, params: Record<string, unknown> = {}) => ({
  status: "error",
  requestId: "r",
  error: { statusCode: 409, errorCode, message: "x", params, details: [], correlationId: "abc" },
});
const open = (friendlyNicknames = false) =>
  ok({ friendlyNicknames, displayMode: "PROJECTOR", maxPlayers: 50, availability: "OPEN" });
const joined = () =>
  ok({
    playerId: PLAYER,
    sessionId: SESSION,
    sessionToken: TOKEN,
    recovered: true,
    snapshot: { self: { nickname: "Neko" } },
  });

/** Scripted socket. */
function fakeSocket(handler: (event: string, payload: Record<string, unknown>) => unknown) {
  const calls: { event: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    emit: vi.fn(async (event: string, payload: Record<string, unknown>) => {
      calls.push({ event, payload });
      return handler(event, payload);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as JoinSocket;
  return { socket, calls, checks: () => calls.filter((call) => call.event === "player:check_pin") };
}

/** Map-backed storage. */
function memoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Renders the flow. */
function renderJoin(
  socket: JoinSocket,
  props: { initialPin?: string; storage?: ReturnType<typeof memoryStorage>; strict?: boolean } = {},
) {
  const navigate = vi.fn();
  const element = (
    <PinJoinScanner
      initialPin={props.initialPin ?? null}
      navigate={navigate}
      socket={socket}
      allowedOrigin="https://kabuki.example"
      storage={props.storage ?? memoryStorage()}
      audio={{ playSfx: vi.fn(async () => true), unlock: vi.fn(async () => true) }}
    />
  );
  const view = renderWithLocale(props.strict ? <StrictMode>{element}</StrictMode> : element, {
    namespaces: [...NAMESPACES],
  });
  return { ...view, navigate };
}

describe("PinJoinScanner", () => {
  it("normalizes PINs and keeps leading zeros", () => {
    expect(normalizePin("000 123")).toBe("000123");
    expect(normalizePin("0-0-0-1-2-3-4")).toBe("000123");
    expect(normalizePin("１２３４５６")).toBe("");
  });

  it("guides an empty PIN, then checks once and joins as a guest", async () => {
    const user = userEvent.setup();
    const { socket, calls, checks } = fakeSocket((event) =>
      event === "player:check_pin" ? open() : joined(),
    );
    const { navigate } = renderJoin(socket);
    expect(screen.getByRole("heading", { level: 1, name: "Join a game" })).toBeInTheDocument();
    expect(screen.getByText("Enter the 6-digit game PIN.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the 6-digit PIN shown by the host.");
    expect(checks()).toHaveLength(0);

    const field = screen.getByLabelText("Game PIN");
    expect(field).toHaveAttribute("inputmode", "numeric");
    await user.click(field);
    await user.paste("000 123");
    expect(field).toHaveValue("000123");
    await user.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByRole("heading", { name: "Choose your look" })).toBeInTheDocument();
    expect(checks()).toEqual([{ event: "player:check_pin", payload: { pinCode: "000123" } }]);
    await user.type(screen.getByLabelText(/^Nickname/u), "Neko");
    await user.click(screen.getByRole("button", { name: "Join game" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/play/000123"));
    expect(calls.find((call) => call.event === "player:join_room")?.payload).toMatchObject({
      pinCode: "000123",
      nickname: "Neko",
    });
  });

  it("checks a deep-linked PIN exactly once, even under StrictMode", async () => {
    const { socket, checks } = fakeSocket(() => fail("ROOM_NOT_FOUND"));
    renderJoin(socket, { initialPin: "000123", strict: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("No game found with that PIN.");
    expect(screen.getByLabelText("Game PIN")).toHaveValue("000123");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checks()).toHaveLength(1);
    expect(screen.getByLabelText("Game PIN")).toHaveAttribute("aria-invalid", "true");
  });

  it("explains locked, full and started rooms and waits for rate limits without polling", async () => {
    const user = userEvent.setup();
    const answers: unknown[] = [
      fail("ROOM_LOCKED"),
      fail("ROOM_FULL"),
      fail("GAME_IN_PROGRESS"),
      fail("RATE_LIMITED", { retryAfterMs: 3000 }),
      { status: "unknown", requestId: "r" },
      open(),
    ];
    const { socket, checks } = fakeSocket(() => answers.shift());
    renderJoin(socket);
    const field = screen.getByLabelText("Game PIN");
    await user.type(field, "123456");
    const join = screen.getByRole("button", { name: "Join" });
    for (const text of [
      "The host has locked this game.",
      "This game is full.",
      "This game has already started.",
    ]) {
      await user.click(join);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
    }
    await user.click(join);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Too many attempts. Try again in 3 seconds.",
      ),
    );
    const waiting = screen.getByRole("button", { name: /^Join/u });
    expect(waiting).toHaveAttribute("aria-disabled", "true");
    expect(waiting).toHaveAccessibleDescription("Too many attempts. Try again in 3 seconds.");
    // Pressing while waiting sends nothing (no polling).
    await user.click(waiting);
    expect(checks()).toHaveLength(4);
  });

  it("offers Try again after an unknown result", async () => {
    const user = userEvent.setup();
    const answers: unknown[] = [{ status: "unknown", requestId: "r" }, open()];
    const { socket } = fakeSocket(() => answers.shift());
    renderJoin(socket, { initialPin: "654321" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You're offline or the check failed. Try again.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Choose your look" })).toBeInTheDocument();
  });

  it("rejoins with stored credentials, even while the game is running", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage({
      [`kabuki:player:${SESSION}`]: JSON.stringify({
        sessionId: SESSION,
        playerId: PLAYER,
        sessionToken: TOKEN,
        pinCode: "000123",
      }),
      "kabuki:player-pin:000123": SESSION,
    });
    const { socket, calls } = fakeSocket((event) =>
      event === "player:check_pin" ? fail("GAME_IN_PROGRESS") : joined(),
    );
    const { navigate } = renderJoin(socket, { initialPin: "000123", storage });
    const rejoin = await screen.findByRole("button", { name: "Rejoin your game" });
    await user.click(rejoin);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/play/000123"));
    expect(calls.find((call) => call.event === "player:join_room")?.payload).toMatchObject({
      sessionId: SESSION,
      sessionToken: TOKEN,
      pinCode: "000123",
    });
  });

  it("clears dead credentials and continues with a new identity", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage({
      [`kabuki:player:${SESSION}`]: JSON.stringify({
        sessionId: SESSION,
        playerId: PLAYER,
        sessionToken: TOKEN,
        pinCode: "000123",
      }),
      "kabuki:player-pin:000123": SESSION,
    });
    const { socket } = fakeSocket((event) =>
      event === "player:check_pin" ? open(true) : fail("INVALID_SESSION_TOKEN"),
    );
    renderJoin(socket, { initialPin: "000123", storage });
    await user.click(await screen.findByRole("button", { name: "Rejoin your game" }));
    expect(await screen.findByRole("heading", { name: "Choose your look" })).toBeInTheDocument();
    expect(storage.map.has(`kabuki:player:${SESSION}`)).toBe(false);
    // Friendly room: no free nickname field.
    expect(screen.queryByLabelText(/^Nickname/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give me a random nickname" })).toBeInTheDocument();
  });

  it("opens the QR scanner and returns to manual entry", async () => {
    const user = userEvent.setup();
    const { socket } = fakeSocket(() => open());
    renderJoin(socket);
    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    const dialog = await screen.findByRole("dialog", { name: "Scan QR code" });
    await user.click(within(dialog).getByRole("button", { name: "Enter the PIN instead" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("Game PIN")).toHaveFocus());
  });
});
