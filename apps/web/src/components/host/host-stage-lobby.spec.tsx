/**
 * TASK-158 coverage for the F13 host lobby.
 * - Five states:
 *   - loading;
 *   - empty roster;
 *   - ideal;
 *   - partial: disconnected players;
 *   - error: host connection lost, with controls paused.
 * - A 200-player roster in join order, with a join announced without moving focus.
 * - Kick through M09 by keyboard and pointer; the player stays until the server roster changes.
 * - Copy link, and copy unavailable with manual copy.
 * - A lock failure leaves the server state unchanged and explains why. Start is disabled with
 *   zero connected players, and End asks first.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { renderWithLocale } from "@/test/locale";
import {
  HostStageLobby,
  type CommandOutcome,
  type HostLobbyCommands,
  type HostStageLobbyProps,
} from "./host-stage-lobby";

const NAMESPACES = ["common", "accessibility", "host", "validation", "auth"] as const;
const ORIGIN = "https://kabuki.example";

/** Player fixture. */
function player(n: number, connected = true) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    nickname: `Pemain ${n}`,
    avatar: { style: "bottts", seed: `p${n}` },
    connected,
    joinOrder: n,
  };
}

/** Host lobby snapshot fixture. */
function lobby(
  players: ReturnType<typeof player>[],
  overrides: Record<string, unknown> = {},
): HostRoomSync {
  return {
    role: "host",
    phase: "LOBBY",
    sessionId: "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b",
    pinCode: "004213",
    quizTitle: "Kuis Sejarah",
    maxPlayers: 200,
    isLocked: false,
    players,
    capabilities: {
      canStart: true,
      canLock: true,
      canKick: true,
      canSkip: false,
      canNext: false,
      canEnd: true,
    },
    ...overrides,
  } as unknown as HostRoomSync;
}

/** Commands with scripted outcomes. */
function commandsWith(overrides: Partial<Record<keyof HostLobbyCommands, CommandOutcome>> = {}) {
  const ok: CommandOutcome = { status: "ok" };
  return {
    lock: vi.fn(async () => overrides.lock ?? ok),
    start: vi.fn(async () => overrides.start ?? ok),
    kick: vi.fn(async () => overrides.kick ?? ok),
    end: vi.fn(async () => overrides.end ?? ok),
  };
}

/** Renders the lobby. */
function renderLobby(props: Partial<HostStageLobbyProps> = {}) {
  const commands = commandsWith();
  const base: HostStageLobbyProps = {
    snapshot: lobby([player(1), player(2)]),
    connected: true,
    commands,
    origin: ORIGIN,
    clipboard: { writeText: vi.fn(async () => undefined) },
    generate: async () => ({ size: 21, isDark: (row, col) => (row + col) % 2 === 0 }),
    ...props,
  };
  const view = renderWithLocale(<HostStageLobby {...base} />, { namespaces: [...NAMESPACES] });
  return {
    ...view,
    base,
    rerenderLobby: (next: Partial<HostStageLobbyProps>) =>
      view.rerender(<HostStageLobby {...base} {...next} />),
  };
}

describe("HostStageLobby", () => {
  it("shows loading, then an empty roster with Start disabled and the reason", () => {
    const view = renderLobby({ snapshot: null });
    expect(screen.getByRole("status")).toHaveTextContent("Loading the game…");
    view.rerenderLobby({ snapshot: lobby([]) });
    expect(
      screen.getByText("No players yet. Share the PIN so players can join."),
    ).toBeInTheDocument();
    expect(screen.getByText("004213")).toBeInTheDocument();
    expect(screen.getByDisplayValue(`${ORIGIN}/join?pin=004213`)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: /^Start game/u });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(start).toHaveAccessibleDescription(
      "Share the PIN so players can join. You can start once at least one player is here.",
    );
  });

  it("renders 200 players in join order and announces a join without moving focus", () => {
    const roster = Array.from({ length: 200 }, (_, index) => player(200 - index));
    const view = renderLobby({ snapshot: lobby(roster) });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(200);
    expect(items[0]).toHaveAttribute("data-player-id", player(1).id);
    expect(screen.getByText("200 of 200 players")).toBeInTheDocument();
    const lock = screen.getByRole("button", { name: "Lock room" });
    lock.focus();
    view.rerenderLobby({ snapshot: lobby([...roster.slice(1), player(201)], { maxPlayers: 250 }) });
    expect(lock).toHaveFocus();
    expect(screen.getByText("Pemain 201 joined")).toBeInTheDocument();
  });

  it("kicks through M09 by keyboard and pointer and waits for the server roster", async () => {
    const user = userEvent.setup();
    const view = renderLobby();
    screen.getByRole("button", { name: "Remove: Pemain 1" }).focus();
    await user.keyboard("{Enter}");
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Remove this player from the room? They won't be able to rejoin this game.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove player" }));
    expect(view.base.commands.kick).toHaveBeenCalledWith(player(1).id);
    // Still listed until the server's roster drops the player.
    expect(screen.getByText("Pemain 1")).toBeInTheDocument();
    view.rerenderLobby({ snapshot: lobby([player(2)]) });
    expect(screen.queryByText("Pemain 1")).not.toBeInTheDocument();
    await user.pointer({
      keys: "[MouseLeft]",
      target: screen.getByRole("button", { name: "Remove: Pemain 2" }),
    });
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Affected item: Pemain 2")).toBeInTheDocument();
  });

  it("copies the link, or asks for a manual copy when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    const view = renderLobby();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(view.base.clipboard?.writeText).toHaveBeenCalledWith(`${ORIGIN}/join?pin=004213`);
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    view.unmount();
    renderLobby({ clipboard: null });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The link couldn't be copied. Select the link and copy it manually.",
    );
  });

  it("keeps the server lock state after a refused lock and pauses controls without a connection", async () => {
    const user = userEvent.setup();
    const commands = commandsWith({ lock: { status: "error", errorCode: "INVALID_PHASE" } });
    const view = renderLobby({ commands, snapshot: lobby([player(1), player(2, false)]) });
    expect(
      screen.getByText("Some players are disconnected. Your last action was already applied."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lock room" }));
    expect(commands.lock).toHaveBeenCalledWith(true);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock room" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "End game" }));
    expect(
      within(await screen.findByRole("dialog")).getByText(
        "End the game now? Players will go straight to the final results.",
      ),
    ).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    act(() => view.rerenderLobby({ connected: false }));
    expect(
      screen.getByText("Connection lost. Controls are paused until everything is back in sync."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Start game/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove: Pemain 1" })).toBeDisabled();
  });
});
