/**
 * TASK-155 coverage for the reveal (F16) and M08 screens.
 * - Chart:
 *   - five states: waiting, no eligible players, counts, nobody answered with the key still
 *     shown, and stale results;
 *   - single choice with the correct marker in text;
 *   - multiple select counts that exceed the players, with no percentages;
 *   - polls without correctness;
 *   - TYPE_ANSWER accepted texts and ORDER_PUZZLE order, each distinct from the choice table.
 * - Motion: cue timing against the audio constants; no replay for the same phase or late renders;
 *   reduced motion.
 * - Personal result:
 *   - partial 475 shown as 375 + 100 without double addition;
 *   - every result kind;
 *   - no wrong motion for POLL/NOT_ELIGIBLE;
 *   - the streak cue.
 * - Explanation dialog: ideal, long, empty and unavailable.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PersonalResult as PersonalResultData,
  PublicQuestion,
  Reveal,
} from "@kabuki-neko/shared/schemas/game.schema";
import { PersonalResult } from "@/components/player/personal-result";
import { renderWithLocale } from "@/test/locale";
import { ExplanationDialog } from "./explanation-dialog";
import { ResultChart, cuePlan, type ResultChartProps } from "./result-chart";

const NAMESPACES = ["common", "accessibility", "player", "host", "reports"] as const;
const START = 1_800_000_000_000;
const ids = ["a", "b", "c", "d"].map(
  (letter) => `00000000-0000-4000-8000-0000000000${letter}${letter}`,
);
const options: PublicQuestion["options"] = ["Jakarta", "Bandung", "Surabaya", "Medan"].map(
  (text, index) => ({
    id: ids[index] ?? "",
    index,
    colorIndex: index,
    text,
  }),
);

/** Reveal fixture with neutral defaults for the given type. */
function reveal(type: Reveal["type"], fields: Partial<Record<string, unknown>> = {}): Reveal {
  return {
    type,
    questionIndex: 0,
    correctOptionIds: [],
    acceptedTexts: [],
    correctOrderIds: [],
    optionCounts: [],
    correctCount: 0,
    partialCount: 0,
    incorrectCount: 0,
    unansweredCount: 0,
    explanationText: null,
    ...fields,
  } as Reveal;
}

/** Renders the chart at a given clock. */
function renderChart(
  props: Partial<ResultChartProps> & Pick<ResultChartProps, "reveal">,
  at = START,
) {
  const onExplanation = vi.fn();
  const base: ResultChartProps = {
    question: { type: props.reveal?.type ?? "SINGLE_CHOICE", options },
    phaseKey: "s1:7",
    phaseStartedAt: START,
    now: () => at,
    onExplanation,
    ...props,
  };
  const view = renderWithLocale(<ResultChart {...base} />, { namespaces: [...NAMESPACES] });
  return { ...view, onExplanation, base };
}

/** Personal result fixture. */
function result(fields: Partial<PersonalResultData>): PersonalResultData {
  return {
    result: "CORRECT",
    isCorrect: true,
    accuracyNumerator: 1,
    accuracyDenominator: 1,
    basePoints: 900,
    streakBonus: 0,
    pointsAwarded: 900,
    currentStreak: 1,
    totalScore: 900,
    currentRank: 1,
    rankBehindPlayerName: null,
    isNoPoints: false,
    ...fields,
  };
}

/** Value of a definition-list entry by its label. */
const valueOf = (label: string) =>
  screen.getByText(label).closest("div")?.querySelector("dd")?.textContent;

afterEach(() => vi.restoreAllMocks());

describe("ResultChart", () => {
  it("waits for results, then shows single-choice counts with the correct answer in text", async () => {
    const user = userEvent.setup();
    const waiting = renderChart({ reveal: null });
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for results…");
    waiting.unmount();
    const { onExplanation } = renderChart({
      reveal: reveal("SINGLE_CHOICE", {
        correctOptionIds: [ids[1]],
        optionCounts: ids.map((optionId, index) => ({ optionId, count: [2, 5, 1, 0][index] })),
        correctCount: 5,
        incorrectCount: 3,
        unansweredCount: 2,
        explanationText: "Bandung is the capital of West Java.",
      }),
    });
    expect(screen.getByRole("heading", { level: 2, name: "Answer" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const second = rows[1];
    expect(second).toBeDefined();
    if (!second) return;
    expect(within(second).getByRole("rowheader")).toHaveTextContent("Option B, ◆: Bandung");
    expect(within(second).getByText("Correct answer")).toBeInTheDocument();
    expect(within(second).getByRole("cell")).toHaveTextContent("5");
    expect(screen.getAllByText("Correct answer")).toHaveLength(1);
    expect(valueOf("Correct")).toBe("5");
    expect(valueOf("Incorrect")).toBe("3");
    expect(valueOf("No answer")).toBe("2");
    expect(screen.queryByText("Partly correct")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explanation" }));
    expect(onExplanation).toHaveBeenCalledTimes(1);
  });

  it("shows multiple-select picks that exceed the players without percentages", () => {
    renderChart({
      reveal: reveal("MULTIPLE_SELECT", {
        correctOptionIds: [ids[0], ids[2]],
        optionCounts: ids.map((optionId, index) => ({ optionId, count: [4, 1, 4, 0][index] })),
        correctCount: 2,
        partialCount: 2,
        incorrectCount: 1,
        unansweredCount: 0,
      }),
    });
    // 9 picks from 5 players: shown as counts, never as shares of 100%.
    expect(document.body.textContent).not.toContain("%");
    expect(screen.getAllByText("Correct answer")).toHaveLength(2);
    expect(valueOf("Partly correct")).toBe("2");
    expect(screen.queryByRole("button", { name: "Explanation" })).not.toBeInTheDocument();
  });

  it("keeps polls neutral, without any correctness", () => {
    renderChart({
      reveal: reveal("POLL", {
        optionCounts: ids.map((optionId, index) => ({ optionId, count: [3, 3, 0, 1][index] })),
        unansweredCount: 1,
      }),
    });
    expect(
      screen.getByText("This is a poll. There are no points and no wrong answers."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Correct answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Correct")).not.toBeInTheDocument();
    expect(screen.queryByText("Incorrect")).not.toBeInTheDocument();
    expect(valueOf("No answer")).toBe("1");
  });

  it("shows accepted texts and the puzzle order distinctly from the option table", () => {
    const text = renderChart({
      question: { type: "TYPE_ANSWER", options: [] },
      reveal: reveal("TYPE_ANSWER", {
        acceptedTexts: ["Neko", "猫"],
        correctCount: 3,
        incorrectCount: 1,
      }),
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const accepted = screen.getByRole("heading", { name: "Correct answer" }).nextElementSibling;
    expect(accepted?.tagName).toBe("UL");
    expect(
      within(accepted as HTMLElement)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Neko", "猫"]);
    text.unmount();
    renderChart({
      question: { type: "ORDER_PUZZLE", options },
      reveal: reveal("ORDER_PUZZLE", {
        correctOrderIds: [ids[2], ids[0], ids[3], ids[1]],
        correctCount: 1,
        incorrectCount: 2,
      }),
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const order = screen.getAllByRole("listitem");
    expect(order.map((item) => item.getAttribute("data-option-index"))).toEqual([
      "2",
      "0",
      "3",
      "1",
    ]);
    expect(order[0]).toHaveTextContent("Option C, ●: Surabaya");
  });

  it("covers no eligible players, nobody answering and stale results", () => {
    const none = renderChart({ reveal: reveal("SINGLE_CHOICE", { correctOptionIds: [ids[0]] }) });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No players were able to answer this question.",
    );
    none.unmount();
    const silent = renderChart({
      reveal: reveal("SINGLE_CHOICE", { correctOptionIds: [ids[0]], unansweredCount: 4 }),
    });
    expect(screen.getByRole("status")).toHaveTextContent("No one answered this question.");
    // The key is still revealed.
    expect(screen.getByText("Correct answer")).toBeInTheDocument();
    silent.unmount();
    renderChart({
      stale: true,
      reveal: reveal("SINGLE_CHOICE", { correctOptionIds: [ids[0]], correctCount: 1 }),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "These are the last confirmed results; they may be out of date.",
    );
  });

  it("times the bars with the reveal cue, never replays them and respects reduced motion", () => {
    expect(cuePlan(START, 450, START, false)).toEqual({ animate: true, delayMs: 450 });
    expect(cuePlan(START, 450, START + 600, false)).toEqual({ animate: true, delayMs: 0 });
    expect(cuePlan(START, 450, START + 1_000, false)).toEqual({ animate: false, delayMs: 0 });
    expect(cuePlan(START, 450, START, true)).toEqual({ animate: false, delayMs: 0 });
    const data = reveal("SINGLE_CHOICE", { correctOptionIds: [ids[0]], correctCount: 1 });
    const live = renderChart({ reveal: data });
    const section = () => screen.getByRole("heading", { name: "Answer" }).closest("section");
    expect(section()).toHaveAttribute("data-motion", "animate");
    // The same phase re-rendered later keeps its plan instead of restarting the animation.
    live.rerender(<ResultChart {...live.base} now={() => START + 5_000} />);
    expect(section()).toHaveAttribute("data-motion", "animate");
    live.unmount();
    // A reconnect long after the cue shows the final chart.
    renderChart({ reveal: data }, START + 5_000);
    expect(section()).toHaveAttribute("data-motion", "static");
  });
});

describe("PersonalResult", () => {
  /** Renders a personal result at a given clock. */
  const renderResult = (data: PersonalResultData | null, at = START, stale = false) =>
    renderWithLocale(
      <PersonalResult
        result={data}
        phaseKey="s1:7"
        phaseStartedAt={START}
        now={() => at}
        stale={stale}
      />,
      { namespaces: [...NAMESPACES] },
    );

  it("shows a partial 475 as 375 + 100 without adding the bonus twice", () => {
    renderResult(
      result({
        result: "PARTIAL",
        accuracyNumerator: 2,
        accuracyDenominator: 3,
        basePoints: 375,
        streakBonus: 100,
        pointsAwarded: 475,
        currentStreak: 3,
        totalScore: 2_475,
        currentRank: 2,
        rankBehindPlayerName: "Tora",
      }),
    );
    expect(screen.getByRole("heading", { name: "Partly correct" })).toBeInTheDocument();
    expect(screen.getByText("2 of 3 scored answers")).toBeInTheDocument();
    expect(screen.getByText("+475 points")).toBeInTheDocument();
    expect(valueOf("Base points")).toBe("375");
    expect(valueOf("Streak bonus")).toBe("100");
    expect(document.body.textContent).not.toMatch(/575/u);
    expect(screen.getByText("Total score").nextElementSibling).toHaveTextContent("2,475");
    expect(screen.getByText("3 answers in a row").closest("p")).toHaveAttribute(
      "data-streak-motion",
      "animate",
    );
    expect(screen.getByText("You're in 2nd place")).toBeInTheDocument();
    expect(screen.getByText("Just behind Tora")).toBeInTheDocument();
  });

  it("covers waiting, incorrect, unanswered, no-points, poll and not eligible results", () => {
    const waiting = renderResult(null);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for results…");
    waiting.unmount();
    const cases: [PersonalResultData, string, string | null][] = [
      [
        result({
          result: "INCORRECT",
          isCorrect: false,
          accuracyNumerator: 0,
          basePoints: 0,
          pointsAwarded: 0,
          currentStreak: 0,
        }),
        "Incorrect",
        "+0 points",
      ],
      [
        result({
          result: "UNANSWERED",
          isCorrect: null,
          accuracyNumerator: 0,
          accuracyDenominator: 0,
          basePoints: 0,
          pointsAwarded: 0,
          currentStreak: 0,
        }),
        "No answer",
        "+0 points",
      ],
      [
        result({ isNoPoints: true, basePoints: 0, pointsAwarded: 0 }),
        "Correct!",
        "No points for this question",
      ],
      [
        result({
          result: "POLL",
          isCorrect: null,
          accuracyNumerator: 0,
          accuracyDenominator: 0,
          basePoints: 0,
          pointsAwarded: 0,
          currentStreak: 0,
          isNoPoints: true,
        }),
        "Thanks for voting!",
        null,
      ],
      [
        result({
          result: "NOT_ELIGIBLE",
          isCorrect: null,
          accuracyNumerator: 0,
          accuracyDenominator: 0,
          basePoints: 0,
          pointsAwarded: 0,
          currentStreak: 0,
          currentRank: null,
        }),
        "You joined after this question started.",
        null,
      ],
    ];
    for (const [data, heading, points] of cases) {
      const view = renderResult(data);
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      if (points) expect(screen.getByText(points)).toBeInTheDocument();
      else expect(document.body.textContent).not.toMatch(/points?\b/u);
      const neutral = data.result === "POLL" || data.result === "NOT_ELIGIBLE";
      expect(screen.getByRole("heading", { name: heading }).closest("section")).toHaveAttribute(
        "data-motion",
        neutral ? "static" : "animate",
      );
      view.unmount();
    }
  });

  it("settles motion on late renders and shows stale results", () => {
    renderResult(
      result({ currentStreak: 4, streakBonus: 100, pointsAwarded: 1_000 }),
      START + 5_000,
      true,
    );
    expect(screen.getByRole("heading", { name: "Correct!" }).closest("section")).toHaveAttribute(
      "data-motion",
      "static",
    );
    expect(screen.getByText("4 answers in a row").closest("p")).toHaveAttribute(
      "data-streak-motion",
      "static",
    );
    expect(screen.getByRole("status")).toHaveTextContent("These are the last confirmed results");
  });
});

describe("ExplanationDialog", () => {
  /** Renders the dialog. */
  const renderDialog = (explanationText: string | null | undefined) => {
    const onClose = vi.fn();
    const view = renderWithLocale(
      <ExplanationDialog
        open
        promptText="Which city is the capital of West Java?"
        explanationText={explanationText}
        onClose={onClose}
      />,
      { namespaces: [...NAMESPACES] },
    );
    return { ...view, onClose };
  };

  it("shows the prompt and full explanation, with a scroll hint for long text, and closes", async () => {
    const user = userEvent.setup();
    const long = "猫は可愛い。".repeat(80);
    const { onClose } = renderDialog(long);
    const dialog = screen.getByRole("dialog", { name: "Explanation" });
    expect(within(dialog).getByText("Which city is the capital of West Java?")).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Explanation" })).toHaveTextContent(long);
    expect(
      within(dialog).getByText("This explanation is long. Scroll to read all of it."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("explains an empty or unavailable explanation", () => {
    const empty = renderDialog("   ");
    expect(screen.getByText("No explanation for this question.")).toBeInTheDocument();
    empty.unmount();
    renderDialog(undefined);
    expect(
      screen.getByText("The explanation couldn't load. Close this and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Explanation" })).not.toBeInTheDocument();
  });
});
