/**
 * TASK-154 coverage for the TYPE_ANSWER and ORDER_PUZZLE pads.
 * - Text: grapheme counting for CJK, emoji and combining marks, never truncated.
 *   - The NFC + trim payload.
 *   - IME composition never submits on Enter.
 *   - Required, too-long (graphemes and bytes) and control-character errors.
 *   - Draft restore only while editable.
 *   - No send after the deadline, in grace or while offline; the accepted lock.
 * - Puzzle: game-order start with stable identity (letter, shape and label follow the item).
 *   - Keyboard reordering keeps focus on the moved item and announces its position.
 *   - Edge moves are ignored.
 *   - Drag reordering.
 *   - A frozen payload sent once.
 *   - Draft rules and locks.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import type { ChoiceOption } from "./choice-answer-pad";
import {
  PuzzleAnswerPad,
  isPuzzleOrder,
  moveEntry,
  type PuzzleAnswerPadProps,
} from "./puzzle-answer-pad";
import { TextAnswerPad, parseTextAnswer, type TextAnswerPadProps } from "./text-answer-pad";

const NAMESPACES = ["common", "accessibility", "player", "validation"] as const;

/** Renders the text pad with defaults; `rerenderPad` keeps the same callbacks. */
function renderText(props: Partial<TextAnswerPadProps> = {}) {
  const onSubmit = vi.fn();
  const onDraftChange = vi.fn();
  const base: TextAnswerPadProps = {
    questionId: "q1",
    status: "idle",
    inputOpen: true,
    onSubmit,
    onDraftChange,
    ...props,
  };
  const view = renderWithLocale(<TextAnswerPad {...base} />, { namespaces: [...NAMESPACES] });
  return {
    ...view,
    onSubmit,
    onDraftChange,
    input: () => screen.getByLabelText("Type your answer"),
    rerenderPad: (next: Partial<TextAnswerPadProps>) =>
      view.rerender(<TextAnswerPad {...base} {...next} />),
  };
}

const ITEMS: ChoiceOption[] = ["Jakarta", "Bandung", "Surabaya", "Medan"].map((text, index) => ({
  id: `00000000-0000-4000-8000-00000000001${index}`,
  index,
  colorIndex: index,
  text,
}));
const NAME = [
  "Option A, ▲: Jakarta",
  "Option B, ◆: Bandung",
  "Option C, ●: Surabaya",
  "Option D, ■: Medan",
];

/** Renders the puzzle pad with defaults; `rerenderPad` keeps the same callbacks. */
function renderPuzzle(props: Partial<PuzzleAnswerPadProps> = {}) {
  const onSubmit = vi.fn();
  const onDraftChange = vi.fn();
  const base: PuzzleAnswerPadProps = {
    questionId: "q1",
    items: ITEMS,
    status: "idle",
    inputOpen: true,
    onSubmit,
    onDraftChange,
    ...props,
  };
  const view = renderWithLocale(<PuzzleAnswerPad {...base} />, { namespaces: [...NAMESPACES] });
  return {
    ...view,
    onSubmit,
    onDraftChange,
    rerenderPad: (next: Partial<PuzzleAnswerPadProps>) =>
      view.rerender(<PuzzleAnswerPad {...base} {...next} />),
  };
}

/** Item indices in visual order. */
const visualOrder = () =>
  screen.getAllByRole("listitem").map((item) => Number(item.getAttribute("data-item-index")));
const moveUp = (item: number) => screen.getByRole("button", { name: `Move item up ${NAME[item]}` });
const moveDown = (item: number) =>
  screen.getByRole("button", { name: `Move item down ${NAME[item]}` });

describe("TextAnswerPad", () => {
  it("counts graphemes for CJK, emoji and combining marks and sends the NFC, trimmed text", async () => {
    const user = userEvent.setup();
    const { input, onSubmit, onDraftChange } = renderText();
    expect(screen.getByText("0 / 250")).toBeInTheDocument();
    await user.type(input(), "  小猫👨‍👩‍👧 Café ");
    // 2 spaces + 2 CJK + 1 family emoji + space + "Café" (4) + space = 11 graphemes.
    expect(screen.getByText("11 / 250")).toBeInTheDocument();
    expect(onDraftChange).toHaveBeenLastCalledWith("  小猫👨‍👩‍👧 Café ");
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("小猫👨‍👩‍👧 Café");
    expect(onSubmit.mock.calls[0]?.[0]).toBe("小猫👨‍👩‍👧 Café");
  });

  it("never submits on Enter while an IME composition is active", () => {
    const { input, onSubmit } = renderText();
    const field = input();
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "ねこ" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field);
    // Safari reports the confirming Enter after compositionend with keyCode 229.
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("ねこ");
  });

  it("explains empty, too long and invalid answers without truncating the text", async () => {
    const user = userEvent.setup();
    const { input, onSubmit } = renderText();
    await user.type(input(), "   {Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("This field is required.");
    expect(input()).toHaveFocus();
    const long = "猫".repeat(251);
    fireEvent.change(input(), { target: { value: long } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("251 / 250").closest("p")).toHaveClass("text-danger");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(input()).toHaveValue(long);
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(screen.getByRole("alert")).toHaveTextContent("This is too long.");
    // 100 graphemes of 81 bytes each: within the grapheme limit, over the 8,000-byte limit.
    expect(parseTextAnswer(`e${"́".repeat(40)}`.repeat(100))).toEqual({
      ok: false,
      problem: "tooLong",
    });
    expect(parseTextAnswer("cat\u0007")).toEqual({ ok: false, problem: "invalidFormat" });
    expect(parseTextAnswer(" 猫 ")).toEqual({ ok: true, answer: "猫" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("locks after sending, during grace and while offline, and never sends twice", async () => {
    const user = userEvent.setup();
    const { input, onSubmit, rerenderPad } = renderText();
    await user.type(input(), "Neko{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rerenderPad({ status: "submitting", submitted: "Neko" });
    expect(input()).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent("Submitting…");
    fireEvent.keyDown(input(), { key: "Enter" });
    rerenderPad({ status: "accepted", submitted: "Neko" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Answer received Your answer is locked in.",
    );
    expect(input()).toHaveValue("Neko");
    expect(screen.queryByRole("button", { name: "Submit answer" })).not.toBeInTheDocument();
    rerenderPad({ status: "idle", inputOpen: false, grace: true });
    expect(screen.getByRole("status")).toHaveTextContent("Time's up.");
    fireEvent.keyDown(input(), { key: "Enter" });
    rerenderPad({ status: "idle", offline: true });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("restores a draft only for the same, still editable question", () => {
    const editable = renderText({ draft: "Bandung" });
    expect(editable.input()).toHaveValue("Bandung");
    editable.rerenderPad({ questionId: "q2", draft: null });
    expect(editable.input()).toHaveValue("");
    editable.rerenderPad({ questionId: "q3", draft: "Medan" });
    expect(editable.input()).toHaveValue("Medan");
    editable.unmount();
    const closed = renderText({ draft: "Bandung", inputOpen: false });
    expect(closed.input()).toHaveValue("");
    closed.unmount();
    const accepted = renderText({ draft: "Bandung", status: "accepted", submitted: "Surabaya" });
    expect(accepted.input()).toHaveValue("Surabaya");
  });
});

describe("PuzzleAnswerPad", () => {
  it("validates permutations and moves entries purely", () => {
    expect(isPuzzleOrder([3, 1, 0, 2], ITEMS)).toBe(true);
    expect(isPuzzleOrder([0, 0, 1, 2], ITEMS)).toBe(false);
    expect(isPuzzleOrder([0, 1, 2], ITEMS)).toBe(false);
    expect(isPuzzleOrder([0, 1, 2, 7], ITEMS)).toBe(false);
    const list = [0, 1, 2, 3];
    expect(moveEntry(list, 3, 0)).toEqual([3, 0, 1, 2]);
    expect(list).toEqual([0, 1, 2, 3]);
  });

  it("starts in game order and reorders by keyboard with focus kept on the moved item", async () => {
    const user = userEvent.setup();
    const { onDraftChange } = renderPuzzle();
    expect(screen.getByText("Put the items in the right order.")).toBeInTheDocument();
    expect(visualOrder()).toEqual([0, 1, 2, 3]);
    moveUp(2).focus();
    await user.keyboard("{Enter}");
    expect(visualOrder()).toEqual([0, 2, 1, 3]);
    expect(moveUp(2)).toHaveFocus();
    expect(screen.getByText("Surabaya, position 2")).toBeInTheDocument();
    expect(onDraftChange).toHaveBeenLastCalledWith([0, 2, 1, 3]);
    // Identity follows the item: the second row is still C with its own label and shape.
    const second = screen.getAllByRole("listitem")[1];
    expect(second).toBeDefined();
    if (second) {
      expect(within(second).getByText("C")).toBeInTheDocument();
      expect(within(second).getByText(NAME[2] ?? "")).toHaveClass("sr-only");
    }
    await user.keyboard("{Enter}");
    expect(visualOrder()).toEqual([2, 0, 1, 3]);
    expect(moveUp(2)).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(visualOrder()).toEqual([2, 0, 1, 3]);
    expect(moveUp(2)).toHaveFocus();
    moveDown(3).focus();
    await user.keyboard(" ");
    expect(visualOrder()).toEqual([2, 0, 1, 3]);
    moveDown(0).focus();
    await user.keyboard("{Enter}");
    expect(visualOrder()).toEqual([2, 1, 0, 3]);
    expect(moveDown(0)).toHaveFocus();
    expect(screen.getByText("Jakarta, position 3")).toBeInTheDocument();
  });

  it("reorders by dragging the handle and announces the final position", () => {
    const { onDraftChange } = renderPuzzle();
    screen.getAllByRole("listitem").forEach((item) => {
      const row = Number(item.getAttribute("data-item-index"));
      vi.spyOn(item, "getBoundingClientRect").mockImplementation(() => {
        const position = visualOrder().indexOf(row);
        return {
          top: position * 100,
          height: 100,
          bottom: position * 100 + 100,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: position * 100,
          toJSON: () => ({}),
        };
      });
    });
    const handle = screen.getAllByRole("listitem")[0]?.querySelector("[data-drag-handle]");
    expect(handle).not.toBeNull();
    if (!handle) return;
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: "touch", clientY: 50 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 260 }));
    });
    expect(visualOrder()).toEqual([1, 2, 0, 3]);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientY: 260 }));
    });
    expect(screen.getByText("Jakarta, position 3")).toBeInTheDocument();
    expect(onDraftChange).toHaveBeenLastCalledWith([1, 2, 0, 3]);
    // After release, moving the pointer does nothing.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 0 }));
    });
    expect(visualOrder()).toEqual([1, 2, 0, 3]);
  });

  it("sends a frozen order once and locks moves while submitting, accepted, in grace or offline", async () => {
    const user = userEvent.setup();
    const { onSubmit, rerenderPad } = renderPuzzle();
    await user.click(moveDown(0));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSubmit).toHaveBeenCalledWith([1, 0, 2, 3]);
    const payload = onSubmit.mock.calls[0]?.[0] as readonly number[];
    expect(Object.isFrozen(payload)).toBe(true);
    rerenderPad({ status: "submitting", submitted: payload });
    await user.click(moveDown(0));
    await user.click(screen.getByRole("button", { name: /^Submit answer/u }));
    expect(visualOrder()).toEqual([1, 0, 2, 3]);
    expect(payload).toEqual([1, 0, 2, 3]);
    rerenderPad({ status: "accepted", submitted: payload });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Answer received Your answer is locked in.",
    );
    expect(moveUp(3)).toHaveAttribute("aria-disabled", "true");
    rerenderPad({ status: "idle", submitted: null, inputOpen: false, grace: true });
    expect(screen.getByRole("status")).toHaveTextContent("Time's up.");
    await user.click(moveUp(3));
    rerenderPad({ status: "idle", submitted: null, offline: true });
    await user.click(moveUp(3));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(visualOrder()).toEqual([1, 0, 2, 3]);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("restores only valid, editable drafts and resets for a new question", () => {
    const view = renderPuzzle({ draft: [3, 2, 1, 0] });
    expect(visualOrder()).toEqual([3, 2, 1, 0]);
    view.rerenderPad({ questionId: "q2", draft: [0, 0, 1, 2] });
    expect(visualOrder()).toEqual([0, 1, 2, 3]);
    view.unmount();
    renderPuzzle({ draft: [3, 2, 1, 0], inputOpen: false });
    expect(visualOrder()).toEqual([0, 1, 2, 3]);
  });
});
