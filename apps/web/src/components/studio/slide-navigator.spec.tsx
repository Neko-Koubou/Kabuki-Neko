/**
 * TASK-143 coverage for the F04 slide navigator, with a stateful parent like the studio.
 * - States: loading, empty (Add slide), ideal list, partial scroll hint for many slides, and a
 *   rejected move (order restored).
 * - Keyboard alternative to dragging: Move up / Move down keep focus on the moved slide and
 *   announce the new position; edges are unavailable.
 * - Stable IDs: entries follow their UUID, never the index.
 * - Duplicate selects and focuses the copy; delete moves focus to a neighbour, or to Add slide
 *   when the last slide is gone.
 * - Long prompts stay complete for assistive technology.
 * - The per-slide problem indicator jumps to the slide's issues.
 * - 150 slides keep focus while moving one in the middle.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { SlideNavigator, type SlideNavigatorProps, type SlideSummary } from "./slide-navigator";

const NAMESPACES = ["common", "accessibility", "studio", "quizzes"] as const;

/** Slide fixture with a stable UUID. */
function slide(n: number, overrides: Partial<SlideSummary> = {}): SlideSummary {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "SINGLE_CHOICE",
    promptText: `Soal ${n}`,
    issueCount: 0,
    ...overrides,
  };
}

/** Parent holding the slide order, like the studio store. */
function Harness({
  initial,
  rejectMoves = false,
  spy,
  extra = {},
}: {
  initial: SlideSummary[];
  rejectMoves?: boolean;
  spy: { onShowIssues: (id: string) => void };
  extra?: Partial<SlideNavigatorProps>;
}) {
  const [slides, setSlides] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  let counter = 900;
  return (
    <SlideNavigator
      slides={slides}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onAdd={(afterId) => {
        counter += 1;
        const created = slide(counter, { promptText: "" });
        setSlides((list) => {
          const at = afterId ? list.findIndex((item) => item.id === afterId) + 1 : list.length;
          return [...list.slice(0, at), created, ...list.slice(at)];
        });
        setSelectedId(created.id);
        return created.id;
      }}
      onMove={(id, toIndex) => {
        if (rejectMoves) return false;
        setSlides((list) => {
          const next = list.filter((item) => item.id !== id);
          const moved = list.find((item) => item.id === id);
          if (moved) next.splice(toIndex, 0, moved);
          return next;
        });
        return true;
      }}
      onDuplicate={(id) => {
        const copy = slide(800 + slides.length, {
          promptText: `${slides.find((item) => item.id === id)?.promptText ?? ""} (2)`,
        });
        setSlides((list) => {
          const at = list.findIndex((item) => item.id === id) + 1;
          return [...list.slice(0, at), copy, ...list.slice(at)];
        });
        setSelectedId(copy.id);
        return copy.id;
      }}
      onDelete={(id) => setSlides((list) => list.filter((item) => item.id !== id))}
      onShowIssues={spy.onShowIssues}
      {...extra}
    />
  );
}

/** Renders the harness. */
function renderNavigator(
  initial: SlideSummary[],
  options: { rejectMoves?: boolean; extra?: Partial<SlideNavigatorProps> } = {},
) {
  const spy = { onShowIssues: vi.fn<(id: string) => void>() };
  const view = renderWithLocale(<Harness initial={initial} spy={spy} {...options} />, {
    namespaces: [...NAMESPACES],
  });
  return { ...view, spy };
}

/** Slide ids in DOM order. */
const order = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => Number(item.getAttribute("data-slide-id")?.slice(-12)));

describe("SlideNavigator", () => {
  it("shows loading, then the empty canvas with Add slide", async () => {
    const user = userEvent.setup();
    const loading = renderNavigator([], { extra: { loading: true } });
    expect(screen.getByRole("status")).toHaveTextContent("Loading slides…");
    expect(screen.getByRole("button", { name: "Add slide" })).toBeDisabled();
    loading.unmount();
    renderNavigator([]);
    expect(screen.getByText("No slides yet. Add a question to create one.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add slide" }));
    expect(order()).toEqual([901]);
    expect(screen.getByRole("button", { name: /^Slide 1 of 1 · Single choice/u })).toHaveFocus();
  });

  it("moves with the keyboard alternative, keeps focus on the moved slide and announces it", async () => {
    const user = userEvent.setup();
    renderNavigator([slide(1), slide(2), slide(3)]);
    const first = screen.getByRole("button", { name: /^Slide 1 of 3 · Single choice/u });
    expect(first).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Move up: Slide 1 of 3" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    screen.getByRole("button", { name: "Move down: Slide 1 of 3" }).focus();
    await user.keyboard("{Enter}");
    expect(order()).toEqual([2, 1, 3]);
    // Same slide (stable id), now at position 2, still focused.
    expect(screen.getByRole("button", { name: "Move down: Slide 2 of 3" })).toHaveFocus();
    expect(screen.getByText("Slide 2 of 3", { selector: "p" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(order()).toEqual([2, 3, 1]);
    const last = screen.getByRole("button", { name: "Move down: Slide 3 of 3" });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(order()).toEqual([2, 3, 1]);
    // Selection follows the id, not the position.
    expect(
      within(screen.getAllByRole("listitem")[2] as HTMLElement).getByRole("button", {
        name: /Soal 1/u,
      }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("selects and focuses a duplicate, and moves focus to a neighbour or Add slide on delete", async () => {
    const user = userEvent.setup();
    renderNavigator([slide(1), slide(2)]);
    await user.click(screen.getByRole("button", { name: "Duplicate slide: Slide 1 of 2" }));
    const copy = screen.getByRole("button", {
      name: /^Slide 2 of 3 · Single choice Soal 1 \(2\)/u,
    });
    expect(copy).toHaveAttribute("aria-current", "true");
    expect(copy).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Delete slide: Slide 2 of 3" }));
    expect(
      screen.getByRole("button", { name: /^Slide 2 of 2 · Single choice Soal 2/u }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Delete slide: Slide 2 of 2" }));
    await user.click(screen.getByRole("button", { name: "Delete slide: Slide 1 of 1" }));
    expect(screen.getByText("No slides yet. Add a question to create one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add slide" })).toHaveFocus();
  });

  it("keeps long prompts whole, labels empty prompts and jumps to a slide's problems", async () => {
    const user = userEvent.setup();
    const long = "Pertanyaan yang sangat panjang ".repeat(12).trim();
    const { spy } = renderNavigator([
      slide(1, { promptText: long, type: "ORDER_PUZZLE" }),
      slide(2, { promptText: "", issueCount: 2, type: "TYPE_ANSWER" }),
    ]);
    expect(
      screen.getByRole("button", {
        name: `Slide 1 of 2 · Puzzle (put in order) ${long} Selected`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Slide 2 of 2 · Type the answer Question$/u }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2 problems found: Slide 2 of 2" }));
    expect(spy.onShowIssues).toHaveBeenCalledWith(slide(2).id);
  });

  it("explains a rejected move and keeps the previous order", async () => {
    const user = userEvent.setup();
    renderNavigator([slide(1), slide(2)], { rejectMoves: true });
    await user.click(screen.getByRole("button", { name: "Move down: Slide 1 of 2" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The slides couldn't be reordered. The previous order has been restored.",
    );
    expect(order()).toEqual([1, 2]);
  });

  it("handles 150 slides with a scroll hint and stable focus", async () => {
    const user = userEvent.setup();
    renderNavigator(
      Array.from({ length: 150 }, (_, index) => slide(index + 1)),
      { extra: { maxSlides: 150 } },
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(150);
    expect(
      screen.getByText("This quiz has many slides. Scroll to see them all."),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Move up: Slide 75 of 150" }).focus();
    await user.keyboard("{Enter}");
    expect(order().slice(72, 76)).toEqual([73, 75, 74, 76]);
    expect(screen.getByRole("button", { name: "Move up: Slide 74 of 150" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Add slide" })).toBeDisabled();
  });
});
