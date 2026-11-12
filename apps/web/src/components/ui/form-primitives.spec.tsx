/**
 * TASK-118 coverage for B01 ActionButton, B02 FormField and B03 ChoiceGroup: keyboard use,
 * disabled (with and without a reason), pending (label kept, no double submit), error (described,
 * value/selection kept), empty and partial variants, labelled controls with stable IDs, grapheme
 * counters, password reveal/paste, and the five design states of Design §6.3 (Loading, Empty,
 * Ideal, Partial, Error) for each component. Text comes from the real en catalogs.
 */
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Plus } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { ActionButton } from "./action-button";
import { ChoiceGroup, type ChoiceItem } from "./choice-group";
import { FormField, type FormFieldProps } from "./form-field";

/** Controlled FormField harness keeping its own value. */
function Field(
  props: Omit<FormFieldProps, "value" | "onChange"> & {
    initial?: string;
    spy?: (v: string) => void;
  },
) {
  const { initial = "", spy, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <FormField
      {...rest}
      value={value}
      onChange={(next) => {
        spy?.(next);
        setValue(next);
      }}
    />
  );
}

describe("B01 ActionButton", () => {
  it("Ideal: native button, press by click and keyboard, 44 px target, wrapping label", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    renderWithLocale(
      <ActionButton label="Save quiz with a very long translated label" onPress={onPress} />,
    );
    const button = screen.getByRole("button", {
      name: "Save quiz with a very long translated label",
    });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toMatch(/min-h-11/u);
    expect(button.className).toMatch(/whitespace-normal/u);
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it("Loading: pending keeps the label, stays focusable and blocks presses and submits", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    renderWithLocale(
      <form
        onSubmit={(event) => {
          onSubmit(event.nativeEvent as SubmitEvent);
        }}
      >
        <ActionButton type="submit" label="Save" pending onPress={onPress} />
      </form>,
    );
    const button = screen.getByRole("button", { name: /^Save/u });
    expect(button).toHaveTextContent("Save");
    expect(button).toHaveTextContent("Working…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await user.click(button);
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onPress).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Empty/Error: unavailable actions are disabled, with a described reason when given", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    const { rerender } = renderWithLocale(
      <>
        <ActionButton label="Delete" variant="danger" disabled onPress={onPress} />
        <ActionButton
          label="Start game"
          disabled
          disabledReason="Add at least one question first."
          onPress={onPress}
        />
      </>,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    const start = screen.getByRole("button", { name: "Start game" });
    expect(start).not.toBeDisabled();
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(start).toHaveAccessibleDescription("Add at least one question first.");
    await user.click(start);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onPress).not.toHaveBeenCalled();

    // Error recovery: once the parent clears pending, presses work again.
    rerender(<ActionButton label="Retry" onPress={onPress} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("Partial: icon-only buttons expose their accessible name and hide the icon", () => {
    renderWithLocale(<ActionButton iconOnly icon={<Plus />} accessibleName="Add slide" />);
    const button = screen.getByRole("button", { name: "Add slide" });
    expect(button.querySelector("svg")?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(button.className).toMatch(/min-w-11/u);
  });
});

describe("B02 FormField", () => {
  it("Ideal: labelled control with stable id, help description and change events", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderWithLocale(
      <Field id="quiz-title" label="Quiz title" help="Shown to players." spy={spy} required />,
    );
    const input = screen.getByRole("textbox", { name: /Quiz title/u });
    expect(input).toHaveAttribute("id", "quiz-title");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).not.toHaveAttribute("required");
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("Shown to players.");
    await user.type(input, "Kuis");
    expect(input).toHaveValue("Kuis");
    expect(spy).toHaveBeenLastCalledWith("Kuis");
  });

  it("Partial: counts graphemes, flags but never truncates over-limit input, passes IME text", () => {
    renderWithLocale(<Field id="name" label="Name" limit={3} initial={"é👍🏽"} />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription("2 / 3");
    fireEvent.change(input, { target: { value: "日本語のクイズ" } });
    expect(input).toHaveValue("日本語のクイズ");
    expect(screen.getByText("7 / 3").closest("p")).toHaveClass("text-danger");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("Error: aria-invalid with the described error, value kept", () => {
    renderWithLocale(
      <Field id="email" kind="email" label="Email" initial="x@" error="This field is required." />,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("This field is required.");
    expect(input).toHaveValue("x@");
    expect(input).toHaveAttribute("type", "email");
  });

  it("supports password managers, paste and a reveal toggle that keeps focus order", async () => {
    const user = userEvent.setup();
    renderWithLocale(
      <Field
        id="password"
        kind="password"
        name="password"
        label="Password"
        autoComplete="current-password"
      />,
    );
    const input = screen.getByLabelText("Password", { selector: "input" });
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("name", "password");
    await user.click(input);
    await user.paste("correct horse battery");
    expect(input).toHaveValue("correct horse battery");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Loading/Empty/Partial select: keeps the value while loading, labels unknown values", async () => {
    const user = userEvent.setup();
    const options = [
      { value: "ja", label: "Japanese" },
      { value: "fr", label: "French", disabled: true },
    ];
    const { rerender } = renderWithLocale(
      <FormField
        kind="select"
        id="lang"
        label="Language"
        value="ja"
        onChange={() => {}}
        options={[]}
        pending
      />,
    );
    const select = screen.getByRole("combobox", { name: "Language" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading options…");
    expect(select).toHaveAccessibleDescription("Loading options…");
    // Not yet loaded: the current value stays selected under an "Unknown" label.
    expect(select).toHaveValue("ja");
    expect(screen.getByRole("option", { name: "Unknown" })).toBeInTheDocument();

    rerender(
      <FormField
        kind="select"
        id="lang"
        label="Language"
        value=""
        onChange={() => {}}
        options={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No options available.");

    const onChange = vi.fn();
    rerender(
      <FormField
        kind="select"
        id="lang"
        label="Language"
        value=""
        placeholderOption="Choose a language"
        onChange={onChange}
        options={options}
        required
      />,
    );
    expect(screen.getByRole("option", { name: "Choose a language" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "French" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: /Language/u }), "ja");
    expect(onChange).toHaveBeenCalledWith("ja");
  });

  it("renders number and textarea controls natively", () => {
    renderWithLocale(
      <>
        <Field id="points" kind="number" label="Points" initial="10" min={0} max={2} />
        <Field id="notes" kind="textarea" label="Notes" limit={10} />
      </>,
    );
    const points = screen.getByRole("spinbutton", { name: "Points" });
    expect(points).toHaveAttribute("inputmode", "numeric");
    expect(points).toHaveAttribute("min", "0");
    const notes = screen.getByRole("textbox", { name: "Notes" });
    expect(notes.tagName).toBe("TEXTAREA");
    expect(screen.getByText("0 / 10")).toBeInTheDocument();
  });
});

describe("B03 ChoiceGroup", () => {
  // Shuffled display order: identity is the domain id, never the visual index.
  const items: ChoiceItem[] = [
    { id: "q-9", label: "Quiz" },
    { id: "q-2", label: "True or false", description: "Two fixed options." },
    { id: "q-5", label: "Poll", disabled: true, disabledReason: "Polls are not scored." },
  ];

  it("Ideal radio: labelled group, selects by domain id, check mark distinct from focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithLocale(
      <ChoiceGroup
        mode="radio"
        label="Question type"
        items={items}
        selected="q-9"
        onSelect={onSelect}
      />,
    );
    const group = screen.getByRole("group", { name: "Question type" });
    expect(group).toBeInTheDocument();
    const quiz = screen.getByRole("radio", { name: "Quiz" });
    expect(quiz).toBeChecked();
    expect(quiz.closest("label")?.querySelector("svg")).not.toBeNull();
    const truefalse = screen.getByRole("radio", { name: "True or false" });
    expect(truefalse).toHaveAccessibleDescription("Two fixed options.");
    truefalse.focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("q-2");
    const poll = screen.getByRole("radio", { name: "Poll" });
    expect(poll).toBeDisabled();
    expect(poll).toHaveAccessibleDescription("Polls are not scored.");
    expect(screen.getByText("Polls are not scored.")).toBeVisible();
  });

  it("Partial checkbox: toggles ids in and out of the selection", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [selected, setSelected] = useState<string[]>(["q-2"]);
      return (
        <ChoiceGroup
          mode="checkbox"
          label="Correct answers"
          items={items}
          selected={selected}
          onSelect={setSelected}
          orientation="horizontal"
        />
      );
    }
    renderWithLocale(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: "Quiz" }));
    expect(screen.getByRole("checkbox", { name: "Quiz" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "True or false" }));
    expect(screen.getByRole("checkbox", { name: "True or false" })).not.toBeChecked();
  });

  it("Loading/Empty/Error: pending is non-interactive, empty offers the parent action, error is described", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = renderWithLocale(
      <ChoiceGroup
        mode="radio"
        label="Type"
        items={items}
        selected="q-9"
        onSelect={onSelect}
        pending
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading choices…");
    expect(screen.getByRole("radio", { name: "Quiz" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "True or false" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "True or false" }));
    expect(onSelect).not.toHaveBeenCalled();

    rerender(
      <ChoiceGroup
        mode="radio"
        label="Type"
        items={[]}
        selected={null}
        onSelect={onSelect}
        emptyAction={<button type="button">Create one</button>}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No options available.");
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();

    rerender(
      <ChoiceGroup
        mode="radio"
        label="Type"
        items={items}
        selected="q-9"
        onSelect={onSelect}
        error="Choose a question type."
      />,
    );
    expect(screen.getByRole("group", { name: "Type" })).toHaveAccessibleDescription(
      "Choose a question type.",
    );
    expect(screen.getByRole("radio", { name: "Quiz" })).toBeChecked();
  });

  it("tabs: roving focus with arrows/Home/End, manual activation, disabled tabs skipped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const tabs: ChoiceItem[] = [
      { id: "own", label: "My quizzes" },
      { id: "locked", label: "Archived", disabled: true },
      { id: "public", label: "Public quizzes" },
    ];
    renderWithLocale(
      <ChoiceGroup
        mode="tabs"
        label="Quiz lists"
        items={tabs}
        selected="own"
        onSelect={onSelect}
        panelIdFor={(id) => `panel-${id}`}
      />,
    );
    expect(screen.getByRole("tablist", { name: "Quiz lists" })).toBeInTheDocument();
    const own = screen.getByRole("tab", { name: "My quizzes" });
    const publicTab = screen.getByRole("tab", { name: "Public quizzes" });
    expect(own).toHaveAttribute("aria-selected", "true");
    expect(own).toHaveAttribute("tabindex", "0");
    expect(publicTab).toHaveAttribute("tabindex", "-1");
    expect(publicTab).toHaveAttribute("aria-controls", "panel-public");

    await user.tab();
    expect(own).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(publicTab).toHaveFocus(); // disabled "Archived" skipped
    expect(onSelect).not.toHaveBeenCalled(); // focus moved, selection unchanged
    expect(publicTab).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowRight}");
    expect(own).toHaveFocus(); // wraps
    await user.keyboard("{End}");
    expect(publicTab).toHaveFocus();
    await user.keyboard("{Home}");
    expect(own).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("public");
    await user.click(screen.getByRole("tab", { name: "Archived" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
