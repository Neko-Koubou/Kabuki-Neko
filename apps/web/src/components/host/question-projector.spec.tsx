/**
 * TASK-159 coverage for the host question stage and phase controls.
 * - The full 500-character prompt and 250-character options are shown, never cut. A long prompt
 *   is in a keyboard-scrollable region with an expand toggle.
 * - No key before the reveal: nothing is marked correct while answering.
 * - The preview shows the prompt without options; countdown and answer count come from the server.
 * - A media failure is reported inside the media box while the controls stay usable.
 * - Controls:
 *   - a double click emits one pending command;
 *   - Next labels follow the server state (leaderboard / podium / next question);
 *   - End asks first;
 *   - a refusal is explained;
 *   - a lost connection pauses everything.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { renderWithLocale } from "@/test/locale";
import { HostPhaseControls, nextLabelKey, type HostPhaseCommands } from "./host-phase-controls";
import type { CommandOutcome } from "./host-stage-lobby";
import { QuestionProjector } from "./question-projector";

const NAMESPACES = [
  "common",
  "accessibility",
  "host",
  "studio",
  "player",
  "media",
  "validation",
] as const;
const NOW = 1_800_000_000_000;
const PROMPT = "P".repeat(499) + "!";
const OPTION = "O".repeat(249) + "?";

/** Host snapshot fixture for a phase. */
function host(phase: string, overrides: Record<string, unknown> = {}): HostRoomSync {
  return {
    role: "host",
    phase,
    phaseVersion: 7,
    sessionId: "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b",
    pinCode: "004213",
    quizTitle: "Kuis Sejarah",
    answeredCount: 3,
    eligibleCount: 8,
    timing: {
      phaseStartedAt: NOW,
      phaseEndsAt: NOW + 3_000,
      questionStartedAt: NOW,
      inputClosesAt: NOW + 20_000,
      acceptanceClosesAt: NOW + 21_500,
    },
    question: {
      id: "11111111-2222-4333-8444-555555555555",
      questionIndex: 2,
      totalQuestions: 10,
      type: "SINGLE_CHOICE",
      promptText: PROMPT,
      pointsMultiplier: 2,
      timeLimitSec: 20,
      media: null,
      options:
        phase === "QUESTION_PREVIEW"
          ? []
          : [OPTION, "Bandung", "Surabaya", "Medan"].map((text, index) => ({
              id: `00000000-0000-4000-8000-00000000000${index}`,
              index,
              colorIndex: index,
              text,
            })),
    },
    capabilities: {
      canStart: false,
      canLock: false,
      canKick: false,
      canSkip: true,
      canNext: true,
      canEnd: true,
    },
    ...overrides,
  } as unknown as HostRoomSync;
}

/** Scripted phase commands. */
function commands(
  outcome: CommandOutcome | Promise<CommandOutcome> = { status: "ok" },
): HostPhaseCommands & Record<string, ReturnType<typeof vi.fn>> {
  return {
    start: vi.fn(async () => outcome),
    skip: vi.fn(async () => outcome),
    next: vi.fn(async () => outcome),
    end: vi.fn(async () => outcome),
  };
}

describe("QuestionProjector", () => {
  it("shows the full prompt and options while answering, with no key and the answer count", async () => {
    const user = userEvent.setup();
    renderWithLocale(
      <QuestionProjector snapshot={host("QUESTION_ANSWERING")} serverNow={() => NOW + 1_000} />,
      {
        namespaces: [...NAMESPACES],
      },
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(PROMPT);
    const region = screen.getByRole("region");
    expect(region).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(OPTION)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("Option A, ▲: " + OPTION)).toBeInTheDocument();
    expect(screen.getByText("3 of 8 answered")).toBeInTheDocument();
    expect(
      screen.getByText(/Question 3 of 10 · Single choice · Double points/u),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/correct/iu);
  });

  it("shows the preview without options and the countdown from the server", () => {
    const preview = renderWithLocale(
      <QuestionProjector snapshot={host("QUESTION_PREVIEW")} serverNow={() => NOW} />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PROMPT);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByText("Next question")).toBeInTheDocument();
    preview.unmount();
    renderWithLocale(
      <QuestionProjector snapshot={host("GAME_START_COUNTDOWN")} serverNow={() => NOW + 1_200} />,
      {
        namespaces: [...NAMESPACES],
      },
    );
    expect(screen.getByRole("status")).toHaveTextContent("Get ready…");
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("reports a media failure without blocking the controls", async () => {
    const snapshot = host("QUESTION_ANSWERING", {});
    const withMedia = {
      ...snapshot,
      question: {
        ...snapshot.question,
        media: {
          kind: "image",
          url: "javascript:alert(1)",
          width: 10,
          height: 10,
          startSec: 0,
          endSec: null,
          revealMode: "NONE",
          accessibility: { altText: null, transcript: null, captions: [], visualDescription: null },
        },
      },
    } as unknown as HostRoomSync;
    const cmds = commands();
    renderWithLocale(
      <>
        <QuestionProjector snapshot={withMedia} serverNow={() => NOW + 1_000} />
        <HostPhaseControls snapshot={withMedia} connected commands={cmds} />
      </>,
      { namespaces: [...NAMESPACES] },
    );
    expect(await screen.findAllByText("This media isn't available.")).not.toHaveLength(0);
    const skip = screen.getByRole("button", { name: "Skip timer" });
    expect(skip).toBeEnabled();
    fireEvent.click(skip);
    await waitFor(() => expect(cmds.skip).toHaveBeenCalledTimes(1));
  });
});

describe("HostPhaseControls", () => {
  it("sends one command for a double click and labels Next from the server state", async () => {
    let finish: (value: CommandOutcome) => void = () => {};
    const cmds = commands(new Promise<CommandOutcome>((resolve) => (finish = resolve)));
    const reveal = host("ANSWER_REVEAL");
    const view = renderWithLocale(
      <HostPhaseControls snapshot={reveal} connected commands={cmds} />,
      {
        namespaces: [...NAMESPACES],
      },
    );
    const next = screen.getByRole("button", { name: "Show leaderboard" });
    fireEvent.click(next);
    fireEvent.click(next);
    expect(cmds.next).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^Show leaderboard/u })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    finish({ status: "ok" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show leaderboard" })).not.toHaveAttribute(
        "aria-busy",
      ),
    );
    expect(screen.queryByRole("button", { name: "Skip timer" })).not.toBeInTheDocument();
    view.rerender(<HostPhaseControls snapshot={host("LEADERBOARD")} connected commands={cmds} />);
    expect(screen.getByRole("button", { name: "Next question" })).toBeInTheDocument();
    expect(
      nextLabelKey(host("ANSWER_REVEAL", { question: { ...reveal.question, questionIndex: 9 } })),
    ).toBe("host.controls.podium");
  });

  it("explains a refusal, confirms End and pauses without a connection", async () => {
    const user = userEvent.setup();
    const cmds = commands({ status: "error", errorCode: "STALE_PHASE" });
    const view = renderWithLocale(
      <HostPhaseControls snapshot={host("QUESTION_ANSWERING")} connected commands={cmds} />,
      {
        namespaces: [...NAMESPACES],
      },
    );
    await user.click(screen.getByRole("button", { name: "Skip timer" }));
    expect(
      await screen.findByText("The game has moved on. Your screen has been updated."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "End game" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("End the game now? Players will go straight to the final results."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(cmds.end).not.toHaveBeenCalled();
    view.rerender(
      <HostPhaseControls snapshot={host("QUESTION_ANSWERING")} connected={false} commands={cmds} />,
    );
    expect(
      screen.getByText("Controls are paused until the connection is restored."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip timer" })).toBeDisabled();
  });
});
