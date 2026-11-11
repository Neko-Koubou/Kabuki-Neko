/**
 * TASK-144 coverage for the F05 question fields with a stateful parent.
 * - All six types: complete (valid), incomplete (warnings, savable) and invalid (structural
 *   errors).
 * - Grapheme counters with emoji/CJK and IME composition.
 * - The problem list focuses its field; `focusPath` focuses from outside.
 * - Type change: a lossy change asks M09 (Cancel keeps everything); a lossless one keeps option
 *   IDs and keys.
 * - Puzzle order moves keep identities.
 * - Conversion helpers.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { QuestionType } from "@kabuki-neko/shared/constants/game";
import {
  questionPlayabilityIssues,
  type Question,
} from "@kabuki-neko/shared/schemas/question.schema";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import {
  QuestionFields,
  convertQuestionType,
  typeChangeLosesData,
  type QuestionFieldsProps,
} from "./question-fields";

const NAMESPACES = [
  "common",
  "accessibility",
  "studio",
  "media",
  "validation",
  "reports",
  "player",
] as const;
const LABELS = { correct: "Correct", incorrect: "Incorrect" };

/** Parent holding the question like the studio store; `latest` exposes the current value. */
function renderFields(initial: Question, props: Partial<QuestionFieldsProps> = {}) {
  const latest: { current: Question } = { current: initial };
  function Harness() {
    const [question, setQuestion] = useState(initial);
    latest.current = question;
    return (
      <QuestionFields
        question={question}
        onChange={(update) => setQuestion((current) => update(current))}
        {...props}
      />
    );
  }
  const view = renderWithLocale(<Harness />, { namespaces: [...NAMESPACES] });
  return { ...view, latest };
}

/** A question of `type` with filled prompt and options. */
function filled(type: QuestionType, texts: string[], keys: number[] = []): Question {
  const question = blankQuestion(type);
  return {
    ...question,
    promptText: "Pertanyaan",
    options: texts.map((optionText, index) => ({
      id: crypto.randomUUID(),
      optionIndex: index,
      colorIndex: type === "TYPE_ANSWER" ? 0 : index,
      optionText,
      isCorrect: type === "TYPE_ANSWER" || keys.includes(index),
      sortOrder: index,
    })),
  } as Question;
}

describe("QuestionFields", () => {
  it("guides an incomplete single choice, then accepts one key and flags duplicates", async () => {
    const user = userEvent.setup();
    const { latest } = renderFields(blankQuestion("SINGLE_CHOICE"));
    const ids = latest.current.options.map((option) => option.id);
    expect(
      screen.getByText(
        "Some questions are incomplete. You can save the draft, but you can't host it yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "The question needs text." })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /^Question/u }), "Ibu kota?");
    for (const [index, text] of ["Jakarta", "Bandung", "Surabaya", "Medan"].entries())
      await user.type(
        screen.getByLabelText(new RegExp(`^Answer option ${"ABCD"[index]}`, "u")),
        text,
      );
    await user.click(screen.getByRole("radio", { name: "Correct answer: B" }));
    expect(latest.current.options.map((option) => option.isCorrect)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(latest.current.options.map((option) => option.id)).toEqual(ids);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Correct answer: A" }));
    expect(latest.current.options.filter((option) => option.isCorrect)).toHaveLength(1);
    await user.clear(screen.getByLabelText(/^Answer option D/u));
    await user.type(screen.getByLabelText(/^Answer option D/u), "jakarta");
    expect(screen.getByRole("alert")).toHaveTextContent("Two options have the same text.");
  });

  it("counts graphemes for emoji and CJK, survives IME composition and blocks text over the limit", async () => {
    const { latest } = renderFields(blankQuestion("SINGLE_CHOICE"));
    const prompt = screen.getByRole("textbox", { name: /^Question/u });
    fireEvent.compositionStart(prompt);
    fireEvent.change(prompt, { target: { value: "ねこ👨‍👩‍👧" } });
    fireEvent.compositionEnd(prompt);
    expect(latest.current.promptText).toBe("ねこ👨‍👩‍👧");
    expect(screen.getByText("3 / 500")).toBeInTheDocument();
    fireEvent.change(prompt, { target: { value: "猫".repeat(501) } });
    expect(screen.getByText("501 / 500").closest("p")).toHaveClass("text-danger");
    expect(screen.getByRole("alert")).toHaveTextContent("This is too long.");
    expect(latest.current.promptText).toHaveLength(501);
  });

  it("edits multiple select, true/false and poll keys per type", async () => {
    const user = userEvent.setup();
    const multi = renderFields(filled("MULTIPLE_SELECT", ["A1", "B1", "C1"]));
    expect(
      screen.getByText("The number of correct answers isn't valid for this question type.", {
        selector: "p",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Correct answer: A" }));
    await user.click(screen.getByRole("checkbox", { name: "Correct answer: C" }));
    expect(multi.latest.current.options.map((option) => option.isCorrect)).toEqual([
      true,
      false,
      true,
    ]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    multi.unmount();

    const tf = renderFields(filled("TRUE_FALSE", ["Benar", "Salah"], [0]));
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add option" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove option/u })).not.toBeInTheDocument();
    tf.unmount();

    renderFields(filled("POLL", ["Merah", "Biru"]));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByText("This is a poll. There are no points and no wrong answers."),
    ).toBeInTheDocument();
  });

  it("manages accepted answers up to 20 and keeps them all correct", async () => {
    const user = userEvent.setup();
    const { latest } = renderFields(filled("TYPE_ANSWER", ["Neko"]));
    expect(
      screen.queryByRole("button", { name: /^Remove accepted answer/u }),
    ).not.toBeInTheDocument();
    for (let count = 1; count < 20; count += 1)
      await user.click(screen.getByRole("button", { name: "Add accepted answer" }));
    expect(latest.current.options).toHaveLength(20);
    expect(
      latest.current.options.every((option) => option.isCorrect && option.colorIndex === 0),
    ).toBe(true);
    const add = screen.getByRole("button", { name: /^Add accepted answer/u });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription(
      "Some limits have been reached. Changing the question type may remove answers.",
    );
    await user.click(
      screen.getByRole("button", { name: "Remove accepted answer: Accepted answers 20" }),
    );
    expect(latest.current.options).toHaveLength(19);
  });

  it("orders puzzle items by moving them while keeping their identity", async () => {
    const user = userEvent.setup();
    const { latest } = renderFields(filled("ORDER_PUZZLE", ["Satu", "Dua", "Tiga", "Empat"]));
    const ids = latest.current.options.map((option) => option.id);
    await user.click(screen.getByRole("button", { name: "Move down: A" }));
    const sorted = [...latest.current.options].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(sorted.map((option) => option.optionText)).toEqual(["Dua", "Satu", "Tiga", "Empat"]);
    expect(latest.current.options.map((option) => option.id)).toEqual(ids);
    expect(screen.getByRole("button", { name: "Move up: B" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("asks before a lossy type change, keeps everything on Cancel and keeps IDs when nothing is lost", async () => {
    const user = userEvent.setup();
    const { latest } = renderFields(
      filled("SINGLE_CHOICE", ["Jakarta", "Bandung", "Surabaya"], [0]),
    );
    const ids = latest.current.options.map((option) => option.id);
    await user.selectOptions(screen.getByLabelText(/^Question type/u), "MULTIPLE_SELECT");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(latest.current.type).toBe("MULTIPLE_SELECT");
    expect(latest.current.options.map((option) => option.id)).toEqual(ids);
    expect(latest.current.options[0]?.isCorrect).toBe(true);
    await user.selectOptions(screen.getByLabelText(/^Question type/u), "TRUE_FALSE");
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Change the question type? Answers that don't fit the new type will be removed.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(latest.current.type).toBe("MULTIPLE_SELECT");
    expect(latest.current.options).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText(/^Question type/u), "TRUE_FALSE");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }),
    );
    expect(latest.current.type).toBe("TRUE_FALSE");
    expect(latest.current.options.map((option) => option.id)).toEqual(ids.slice(0, 2));
    expect(latest.current.options.map((option) => option.optionText)).toEqual([
      "Jakarta",
      "Bandung",
    ]);
  });

  it("focuses a field from the problem list and from focusPath", async () => {
    const user = userEvent.setup();
    const question = filled("SINGLE_CHOICE", ["Jakarta", ""], [0]);
    const view = renderFields(question, { focusPath: "options.1.optionText" });
    expect(screen.getByLabelText(/^Answer option B/u)).toHaveFocus();
    view.unmount();
    renderFields({ ...question, promptText: "" } as Question);
    await user.click(screen.getByRole("button", { name: "The question needs text." }));
    expect(screen.getByRole("textbox", { name: /^Question/u })).toHaveFocus();
  });

  it("converts types with the shared rules", () => {
    const single = filled("SINGLE_CHOICE", ["Jakarta", "Bandung"], [1]);
    const poll = convertQuestionType(single, "POLL", LABELS);
    expect(poll.pointsMultiplier).toBe(0);
    expect(poll.options.some((option) => option.isCorrect)).toBe(false);
    expect(convertQuestionType(poll, "SINGLE_CHOICE", LABELS).pointsMultiplier).toBe(1);
    const text = convertQuestionType(single, "TYPE_ANSWER", LABELS);
    expect(
      text.options.map((option) => [option.optionText, option.isCorrect, option.colorIndex]),
    ).toEqual([["Bandung", true, 0]]);
    const tf = convertQuestionType(blankQuestion("TYPE_ANSWER"), "TRUE_FALSE", LABELS);
    expect(tf.options.map((option) => option.optionText)).toEqual(["Correct", "Incorrect"]);
    const puzzle = convertQuestionType(single, "ORDER_PUZZLE", LABELS);
    expect(puzzle.options.map((option) => option.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(typeChangeLosesData(single, "MULTIPLE_SELECT", LABELS)).toBe(false);
    expect(typeChangeLosesData(single, "POLL", LABELS)).toBe(true);
    expect(typeChangeLosesData(blankQuestion("SINGLE_CHOICE"), "TRUE_FALSE", LABELS)).toBe(false);
    // A blank typed-answer question has a correct (empty) accepted answer, not a key-count problem.
    expect(
      questionPlayabilityIssues(blankQuestion("TYPE_ANSWER")).map((issue) => issue.code),
    ).not.toContain("INVALID_KEY_COUNT");
  });
});
