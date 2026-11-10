/**
 * TASK-156 coverage for the podium and leaderboard.
 * - Podium:
 *   - 3rd/2nd/1st reveal at the audio cues (1,200 / 3,500 / 6,500 ms) from the authoritative
 *     PODIUM start;
 *   - lazy confetti limited to 2 s;
 *   - zero, one and two winners with absent ranks skipped;
 *   - ties keep the server order and shared rank;
 *   - reduced motion and FINISHED show everything at once without confetti;
 *   - a reconnect after the cues settles without replaying, and an unchanged phaseVersion never
 *     repeats effects;
 *   - host-only report status.
 * - Leaderboard: server order (never re-sorted), rank changes, biggest climber, own row and rank,
 *   loading, empty and stale.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { renderWithLocale } from "@/test/locale";
import { Leaderboard, type LeaderboardEntry, type LeaderboardProps } from "./leaderboard";
import { Podium, podiumStage, type PodiumProps } from "./podium";

const NAMESPACES = ["common", "accessibility", "player", "host", "reports"] as const;
const START = 1_800_000_000_000;
const SESSION = "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b";
let clock = START;

/** Leaderboard entry fixture. */
function entry(
  n: number,
  nickname: string,
  rank: number,
  score: number,
  rankChange = 0,
): LeaderboardEntry {
  return {
    playerId: `00000000-0000-4000-8000-00000000000${n}`,
    nickname,
    avatar: { style: "bottts", seed: `seed${n}` },
    score,
    rank,
    rankChange,
    correctCount: 1,
  };
}

const THREE = [
  entry(1, "Neko", 1, 2_400),
  entry(2, "Tora", 2, 1_900),
  entry(3, "Kitsune", 3, 1_200),
];

/** Renders the podium with a controllable clock and fake timers. */
function renderPodium(props: Partial<PodiumProps> = {}) {
  vi.useFakeTimers();
  const onRetryFinalize = vi.fn();
  const base: PodiumProps = {
    podium: THREE,
    phase: "PODIUM",
    phaseKey: `${SESSION}:42`,
    phaseStartedAt: START,
    now: () => clock,
    role: "host",
    reducedMotion: false,
    onRetryFinalize,
    ...props,
  };
  const view = renderWithLocale(<Podium {...base} />, { namespaces: [...NAMESPACES] });
  return { ...view, onRetryFinalize, base };
}

/** Moves the server clock and the timers together, then flushes lazy imports. */
async function advance(ms: number) {
  await act(async () => {
    clock += ms;
    vi.advanceTimersByTime(ms);
    await vi.dynamicImportSettled();
  });
}

/** Stage of each entry in DOM order. */
const stages = () =>
  screen.getAllByRole("listitem", { hidden: true }).map((item) => item.getAttribute("data-stage"));
const confetti = () => document.querySelector("[data-confetti]");

afterEach(() => {
  clock = START;
  vi.useRealTimers();
});

describe("Podium", () => {
  it("reveals 3rd, 2nd and 1st at the audio cues, with at most 2 s of confetti", async () => {
    renderPodium();
    expect(screen.getByRole("heading", { name: "Podium" })).toBeInTheDocument();
    expect(stages()).toEqual(["hidden", "hidden", "hidden"]);
    expect(screen.queryByText(/place:/u)).not.toBeInTheDocument();
    await advance(1_200);
    expect(stages()).toEqual(["hidden", "hidden", "animate"]);
    expect(screen.getByText("3rd place: Kitsune")).toBeInTheDocument();
    await advance(2_300);
    expect(stages()).toEqual(["hidden", "animate", "shown"]);
    expect(screen.getByText("2nd place: Tora")).toBeInTheDocument();
    expect(confetti()).toBeNull();
    await advance(3_000);
    expect(stages()).toEqual(["animate", "shown", "shown"]);
    expect(screen.getByText("1st place: Neko")).toBeInTheDocument();
    await advance(0);
    expect(confetti()).not.toBeNull();
    await advance(1_999);
    expect(confetti()).not.toBeNull();
    await advance(1);
    expect(confetti()).toBeNull();
    await advance(5_000);
    expect(confetti()).toBeNull();
    expect(podiumStage(1, 6_500, false)).toBe("animate");
    expect(podiumStage(1, 6_801, false)).toBe("shown");
    expect(podiumStage(2, 3_499, false)).toBe("hidden");
  });

  it("shows zero, one or two real winners and skips absent ranks", async () => {
    const none = renderPodium({ podium: [] });
    expect(screen.getByRole("status")).toHaveTextContent("No winners this time.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await advance(7_000);
    expect(confetti()).toBeNull();
    none.unmount();
    clock = START;

    const one = renderPodium({ podium: [entry(1, "Neko", 1, 900)] });
    await advance(3_500);
    expect(stages()).toEqual(["hidden"]);
    await advance(3_000);
    expect(stages()).toEqual(["animate"]);
    expect(screen.queryByText(/2nd place|3rd place/u)).not.toBeInTheDocument();
    one.unmount();
    clock = START;

    renderPodium({ podium: [entry(1, "Neko", 1, 900), entry(2, "Tora", 2, 500)] });
    await advance(1_200);
    expect(stages()).toEqual(["hidden", "hidden"]);
    await advance(2_300);
    expect(stages()).toEqual(["hidden", "animate"]);
    expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(2);
  });

  it("keeps ties in server order with their shared rank", async () => {
    renderPodium({
      podium: [entry(1, "Neko", 1, 900), entry(2, "Tora", 1, 900), entry(3, "Kitsune", 3, 400)],
    });
    await advance(6_500);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-player-id")?.slice(-1))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(screen.getByText("1st place: Neko")).toBeInTheDocument();
    expect(screen.getByText("1st place: Tora")).toBeInTheDocument();
    expect(stages()).toEqual(["animate", "animate", "shown"]);
  });

  it("shows everything at once without confetti for reduced motion and FINISHED", async () => {
    const reduced = renderPodium({ reducedMotion: true });
    expect(stages()).toEqual(["shown", "shown", "shown"]);
    await advance(6_500);
    expect(confetti()).toBeNull();
    reduced.unmount();
    clock = START + 8_000;
    renderPodium({ phase: "FINISHED", reducedMotion: false });
    expect(screen.getByRole("heading", { name: "Game over" })).toBeInTheDocument();
    expect(stages()).toEqual(["shown", "shown", "shown"]);
    await advance(100);
    expect(confetti()).toBeNull();
  });

  it("settles after a reconnect and never repeats effects for an unchanged phaseVersion", async () => {
    clock = START + 7_000;
    const late = renderPodium();
    await advance(0);
    expect(stages()).toEqual(["shown", "shown", "shown"]);
    expect(confetti()).toBeNull();
    late.unmount();

    clock = START + 6_500;
    const live = renderPodium();
    await advance(0);
    expect(confetti()).not.toBeNull();
    await advance(2_500);
    expect(confetti()).toBeNull();
    // The same snapshot again (unchanged phaseVersion): nothing restarts.
    live.rerender(<Podium {...live.base} />);
    await advance(100);
    expect(confetti()).toBeNull();
    expect(stages()).toEqual(["shown", "shown", "shown"]);
  });

  it("shows the report status to hosts only, with retry for failures", async () => {
    const status = (fields: Partial<FinalizeStatus>): FinalizeStatus => ({
      sessionId: SESSION,
      status: "pending",
      reportId: null,
      retryable: false,
      errorCode: null,
      updatedAt: START,
      ...fields,
    });
    const pending = renderPodium({ phase: "FINISHED", finalization: status({}) });
    expect(screen.getByText("Saving the report…")).toBeInTheDocument();
    pending.rerender(
      <Podium
        {...pending.base}
        phase="FINISHED"
        finalization={status({ status: "ready", reportId: SESSION })}
      />,
    );
    expect(screen.getByRole("link", { name: "View report" })).toHaveAttribute(
      "href",
      `/dashboard/reports/${SESSION}`,
    );
    pending.rerender(
      <Podium
        {...pending.base}
        phase="FINISHED"
        finalization={status({
          status: "failed",
          retryable: true,
          errorCode: "STATE_UNAVAILABLE" as FinalizeStatus["errorCode"],
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The report couldn't be saved.");
    vi.useRealTimers();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try saving again" }));
    expect(pending.onRetryFinalize).toHaveBeenCalledTimes(1);
    pending.rerender(
      <Podium {...pending.base} phase="FINISHED" finalization={status({ status: "lost" })} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This game's results were lost and no report is available.",
    );
    pending.unmount();
    renderPodium({
      phase: "FINISHED",
      role: "player",
      finalization: status({ status: "ready", reportId: SESSION }),
    });
    expect(screen.queryByRole("link", { name: "View report" })).not.toBeInTheDocument();
  });
});

describe("Leaderboard", () => {
  /** Renders the leaderboard. */
  const renderBoard = (props: Partial<LeaderboardProps>) =>
    renderWithLocale(
      <Leaderboard
        leaderboard={null}
        phaseKey={`${SESSION}:30`}
        phaseStartedAt={START}
        now={() => START}
        reducedMotion={false}
        {...props}
      />,
      { namespaces: [...NAMESPACES] },
    );

  it("renders the server order, rank changes, the biggest climber and the own row", () => {
    renderBoard({
      selfPlayerId: "00000000-0000-4000-8000-000000000002",
      selfRank: 2,
      leaderboard: {
        // Tie-break order from the server, kept even though the scores alone would differ.
        topPlayers: [
          entry(1, "Neko", 1, 1_500, 2),
          entry(2, "Tora", 2, 1_500, -1),
          entry(3, "AVeryLongName15", 3, 1_700, 0),
        ],
        biggestClimber: {
          playerId: "00000000-0000-4000-8000-000000000001",
          nickname: "Neko",
          ranksGained: 2,
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-player-id")?.slice(-1))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("+2")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("-1")).toBeInTheDocument();
    expect(rows[2]?.querySelector("[data-rank-change='0']")?.textContent).toBe("");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("You're in 2nd place")).toBeInTheDocument();
    expect(screen.getByText("Biggest climber: Neko, up 2 places")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("1,700")).toBeInTheDocument();
  });

  it("covers loading, empty, stale and settled motion", () => {
    const loading = renderBoard({});
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for results…");
    loading.unmount();
    const empty = renderBoard({ leaderboard: { topPlayers: [], biggestClimber: null } });
    expect(screen.getByRole("status")).toHaveTextContent("No answers or rankings to show.");
    empty.unmount();
    const stale = renderBoard({
      stale: true,
      leaderboard: { topPlayers: [entry(1, "Neko", 1, 10)], biggestClimber: null },
    });
    expect(screen.getByRole("status")).toHaveTextContent("These are the last confirmed results");
    expect(screen.getByRole("heading", { name: "Leaderboard" }).closest("section")).toHaveAttribute(
      "data-motion",
      "animate",
    );
    stale.unmount();
    renderBoard({
      reducedMotion: true,
      leaderboard: { topPlayers: [entry(1, "Neko", 1, 10)], biggestClimber: null },
    });
    expect(screen.getByRole("heading", { name: "Leaderboard" }).closest("section")).toHaveAttribute(
      "data-motion",
      "static",
    );
  });
});
