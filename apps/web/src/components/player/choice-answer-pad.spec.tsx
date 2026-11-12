/**
 * TASK-153 coverage for the choice answer pad.
 * - Fixed letters, shapes and color tokens with full accessible names.
 * - Keyboard sending.
 * - No double submit while submitting or after acceptance.
 * - True/false two-card layout; neutral poll copy.
 * - Multiple select requires a choice, sends the chosen set and never hints at the key count.
 * - Projector shape-first view with a show-text toggle; Streamer full text.
 * - Deadline, grace, closed and offline locks.
 * - A new question resets the selection.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { ChoiceAnswerPad, type ChoiceAnswerPadProps, type ChoiceOption } from "./choice-answer-pad";

const NAMESPACES = ["common", "accessibility", "player"] as const;
const TEXTS = ["Jakarta", "Bandung", "Surabaya", "Medan"];
/** Options fixture. */
const options = (count = 4): ChoiceOption[] =>
  TEXTS.slice(0, count).map((text, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    index,
    colorIndex: index,
    text,
  }));

/** Renders the pad with defaults. */
function renderPad(props: Partial<ChoiceAnswerPadProps> = {}) {
  const onSubmit = vi.fn();
  const base: ChoiceAnswerPadProps = {
    questionId: "q1",
    type: "SINGLE_CHOICE",
    options: options(),
    displayMode: "STREAMER",
    status: "idle",
    inputOpen: true,
    onSubmit,
    ...props,
  };
  const view = renderWithLocale(<ChoiceAnswerPad {...base} />, { namespaces: [...NAMESPACES] });
  return {
    ...view,
    onSubmit,
    rerenderPad: (next: Partial<ChoiceAnswerPadProps>) =>
      view.rerender(<ChoiceAnswerPad {...base} {...next} />),
  };
}

describe("ChoiceAnswerPad", () => {
  it("renders fixed letters, shapes and colors and sends a single choice once from the keyboard", async () => {
    const user = userEvent.setup();
    const { onSubmit, rerenderPad } = renderPad();
    const buttons = screen.getAllByRole("button", { name: /^Option /u });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Option A, ▲: Jakarta",
      "Option B, ◆: Bandung",
      "Option C, ●: Surabaya",
      "Option D, ■: Medan",
    ]);
    expect(buttons[0]?.className).toContain("bg-[var(--answer-a)]");
    expect(buttons[2]?.className).toContain("text-[var(--answer-c-foreground)]");
    expect(
      screen.getByText("Select one answer. It's sent as soon as you tap it."),
    ).toBeInTheDocument();
    await user.tab();
    await user.tab();
    expect(buttons[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(1);
    rerenderPad({ status: "submitting", chosen: [1] });
    expect(screen.getByRole("status")).toHaveTextContent("Submitting…");
    await user.click(screen.getByRole("button", { name: "Option C, ●: Surabaya" }));
    rerenderPad({ status: "accepted", chosen: [1] });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Answer received Your answer is locked in.",
    );
    expect(screen.getByRole("button", { name: "Option B, ◆: Bandung" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Option A, ▲: Jakarta" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("lays out two true/false cards and keeps polls neutral", async () => {
    const user = userEvent.setup();
    const tf = renderPad({ type: "TRUE_FALSE", options: options(2) });
    expect(screen.getAllByRole("button", { name: /^Option /u })).toHaveLength(2);
    tf.unmount();
    const poll = renderPad({ type: "POLL" });
    expect(
      screen.getByText("This is a poll. There are no points and no wrong answers."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Option D, ■: Medan" }));
    expect(poll.onSubmit).toHaveBeenCalledWith(3);
    expect(screen.queryByText(/correct/iu)).not.toBeInTheDocument();
  });

  it("requires a selection for multiple select and sends the chosen set without hinting the key count", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderPad({ type: "MULTIPLE_SELECT" });
    expect(screen.getByText("Select all answers that apply.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit answer (0)" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an answer first.");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Option C, ●: Surabaya" }));
    await user.click(screen.getByRole("button", { name: "Option A, ▲: Jakarta" }));
    await user.click(screen.getByRole("button", { name: "Option D, ■: Medan" }));
    await user.click(screen.getByRole("button", { name: "Option D, ■: Medan" }));
    expect(screen.getByRole("button", { name: "Option A, ▲: Jakarta" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit answer (2)" }));
    expect(onSubmit).toHaveBeenCalledWith([0, 2]);
    expect(document.body.textContent).not.toMatch(/\b2 correct|choose 2\b/iu);
  });

  it("shows shapes first in projector rooms with an optional text toggle", async () => {
    const user = userEvent.setup();
    renderPad({ displayMode: "PROJECTOR" });
    expect(screen.queryByText("Jakarta")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Option A, ▲: Jakarta" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show question text on this device" }));
    expect(screen.getByText("Jakarta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide question text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("locks input during grace, after closing and while offline", async () => {
    const user = userEvent.setup();
    const { onSubmit, rerenderPad } = renderPad({ inputOpen: false, grace: true });
    expect(screen.getByRole("status")).toHaveTextContent("Time's up.");
    await user.click(screen.getByRole("button", { name: "Option A, ▲: Jakarta" }));
    rerenderPad({ inputOpen: false, grace: false });
    expect(screen.getByRole("status")).toHaveTextContent("Answers are closed.");
    rerenderPad({ inputOpen: true, offline: true });
    expect(screen.getByRole("button", { name: "Option B, ◆: Bandung" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Option B, ◆: Bandung" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("resets the local selection for a new question", async () => {
    const user = userEvent.setup();
    const { rerenderPad } = renderPad({ type: "MULTIPLE_SELECT" });
    await user.click(screen.getByRole("button", { name: "Option A, ▲: Jakarta" }));
    expect(screen.getByRole("button", { name: "Submit answer (1)" })).toBeInTheDocument();
    rerenderPad({ questionId: "q2" });
    expect(screen.getByRole("button", { name: "Submit answer (0)" })).toBeInTheDocument();
  });
});
