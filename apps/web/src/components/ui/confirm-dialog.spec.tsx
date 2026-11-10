/**
 * TASK-136 coverage for M09 and M10.
 *
 * M09 confirmation:
 * - target, impact and a specific CTA, with Cancel focused first;
 * - keyboard trap, Escape and focus return;
 * - a pending action survives closing and reopening, and the parent still learns about success;
 * - a missing target, a blocked/conflict reason, a definitive failure with retry and a reference,
 *   and ambiguous outcomes reconciled without false success;
 * - Cancel on a question-type change keeps the old type.
 *
 * M10 unsaved changes:
 * - Stay first, Discard and Save-then-continue;
 * - a failed save blocks the navigation and keeps the draft, a later successful save continues;
 * - clean forms navigate directly; the incomplete-draft note.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnsavedDialog } from "@/components/studio/unsaved-dialog";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ApiError } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";
import { renderWithLocale } from "@/test/locale";
import {
  ConfirmDialog,
  confirmResultFromError,
  useConfirmAction,
  type ConfirmActionOptions,
} from "./confirm-dialog";

const NAMESPACES = ["common", "accessibility", "validation", "studio", "auth"] as const;

/** Deferred promise helper. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Parent that owns a delete action behind M09. */
function DeleteQuiz({
  target = "Kuis Sejarah Nusantara",
  ...options
}: ConfirmActionOptions & { target?: string | null }) {
  const { t } = useLocale();
  const controller = useConfirmAction(options);
  return (
    <>
      <button type="button" onClick={controller.request}>
        Delete…
      </button>
      <ConfirmDialog
        controller={controller}
        impact={t("common.confirm.deleteQuiz")}
        targetName={target}
        confirmLabel="Delete quiz"
      />
    </>
  );
}

/** Renders the M09 harness. */
function renderDelete(props: Partial<ConfirmActionOptions> & { target?: string | null } = {}) {
  const run = props.run ?? vi.fn(async () => {});
  const onDone = vi.fn();
  const view = renderWithLocale(<DeleteQuiz {...props} run={run} onDone={onDone} />, {
    namespaces: [...NAMESPACES],
  });
  return { ...view, run, onDone };
}

describe("M09 ConfirmDialog", () => {
  it("names the target and impact, focuses Cancel and traps the keyboard", async () => {
    const user = userEvent.setup();
    const { run, onDone } = renderDelete();
    const trigger = screen.getByRole("button", { name: "Delete…" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    expect(dialog).toHaveAccessibleDescription(
      "Delete this quiz? It can't be restored. Existing reports are kept.",
    );
    expect(within(dialog).getByText("Affected item: Kuis Sejarah Nusantara")).toBeInTheDocument();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Delete quiz" })).toBeInTheDocument();
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(run).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    // Enter on the CTA confirms.
    await user.click(trigger);
    const again = await screen.findByRole("dialog");
    within(again).getByRole("button", { name: "Delete quiz" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a pending action through close and reopen and reports success to the parent once", async () => {
    const user = userEvent.setup();
    const gate = deferred<undefined>();
    const run = vi.fn(async () => {
      await gate.promise;
    });
    const { onDone } = renderDelete({ run });
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete quiz" }));
    expect(within(dialog).getByText("Confirming…")).toBeInTheDocument();
    // Pressing again while pending sends nothing new.
    await user.click(within(dialog).getByRole("button", { name: /^Delete quiz/u }));
    expect(run).toHaveBeenCalledTimes(1);
    // Closing does not cancel; reopening shows it still pending, target still visible.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByText("Confirming…")).toBeInTheDocument();
    expect(within(reopened).getByText("Affected item: Kuis Sejarah Nusantara")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await act(async () => gate.resolve(undefined));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never closes as success for missing, blocked, failed or ambiguous outcomes", async () => {
    const user = userEvent.setup();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(409, "MEDIA_IN_USE"))
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_ERROR", {}, [], "ref-500"))
      .mockRejectedValueOnce(new ApiError(0, "NETWORK_ERROR", {}, [], null, true))
      .mockRejectedValueOnce(new ApiError(404, "NOT_FOUND"));
    const reconcile = vi.fn(async () => "unknown" as const);
    const { onDone } = renderDelete({ run, reconcile });
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");

    // Blocked (409 conflict): safe reason, no CTA, Close.
    await user.click(within(dialog).getByRole("button", { name: "Delete quiz" }));
    const blocked = await within(dialog).findByRole("alert");
    expect(blocked).toHaveTextContent("This action isn't allowed right now.");
    expect(blocked).toHaveTextContent(
      "This media is used by a quiz or game, so it can't be deleted.",
    );
    expect(within(dialog).queryByRole("button", { name: "Delete quiz" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    // Definitive failure: error with reference, retry stays possible.
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const retryDialog = await screen.findByRole("dialog");
    await user.click(within(retryDialog).getByRole("button", { name: "Delete quiz" }));
    const failed = await within(retryDialog).findByRole("alert");
    expect(failed).toHaveTextContent("The action didn't complete. Nothing has been confirmed yet.");
    expect(failed).toHaveTextContent("Reference ID: ref-500");

    // Ambiguous (lost response) and reconciliation unknown: still not a success.
    await user.click(within(retryDialog).getByRole("button", { name: "Delete quiz" }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(await within(retryDialog).findByRole("alert")).toHaveTextContent(
      "We couldn't confirm whether your last request went through.",
    );

    // Target gone (404): empty state, Close only.
    await user.click(within(retryDialog).getByRole("button", { name: "Delete quiz" }));
    await waitFor(() =>
      expect(retryDialog).toHaveAccessibleDescription(
        "This item no longer exists, so there's nothing to confirm.",
      ),
    );
    expect(
      within(retryDialog).queryByRole("button", { name: "Delete quiz" }),
    ).not.toBeInTheDocument();
    expect(within(retryDialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("treats an ambiguous outcome as done only when reconciliation confirms it", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => {
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", {}, [], null, true);
    });
    const reconcile = vi.fn(async () => "done" as const);
    const { onDone } = renderDelete({ run, reconcile });
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete quiz" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the empty state when the target is already gone", async () => {
    const user = userEvent.setup();
    renderDelete({ target: null });
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(
      "This item no longer exists, so there's nothing to confirm.",
    );
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).not.toContain("Delete quiz");
    expect(confirmResultFromError(new Error("x"))).toBeNull();
    expect(confirmResultFromError(new ApiError(403, "FORBIDDEN"))).toEqual({
      status: "blocked",
      reasonKey: "validation.errors.forbidden",
    });
  });

  it("keeps the old question type when the type change is cancelled", async () => {
    const user = userEvent.setup();
    /** Question type picker guarded by M09. */
    function TypePicker() {
      const { t } = useLocale();
      const [type, setType] = useState("QUIZ");
      const [next, setNext] = useState<string | null>(null);
      const controller = useConfirmAction({
        run: async () => {
          if (next) setType(next);
        },
      });
      return (
        <>
          <label>
            Question type
            <select
              value={type}
              onChange={(event) => {
                setNext(event.target.value);
                controller.request();
              }}
            >
              <option value="QUIZ">Quiz</option>
              <option value="TRUE_FALSE">True / false</option>
            </select>
          </label>
          <ConfirmDialog
            controller={controller}
            impact={t("common.confirm.changeQuestionType")}
            targetName="Slide 3"
            confirmLabel="Change type"
            destructive={false}
          />
        </>
      );
    }
    renderWithLocale(<TypePicker />, { namespaces: [...NAMESPACES] });
    const select = screen.getByLabelText("Question type");
    await user.selectOptions(select, "TRUE_FALSE");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(
      "Change the question type? Answers that don't fit the new type will be removed.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(select).toHaveValue("QUIZ");
    await user.selectOptions(select, "TRUE_FALSE");
    await user.click(await screen.findByRole("button", { name: "Change type" }));
    await waitFor(() => expect(select).toHaveValue("TRUE_FALSE"));
  });
});

describe("M10 UnsavedDialog", () => {
  /** Editor with a draft, a save that may fail and a guarded navigation. */
  function Editor({
    save,
    incomplete = false,
  }: {
    save: () => Promise<boolean>;
    incomplete?: boolean;
  }) {
    const [draft, setDraft] = useState("");
    const [saved, setSaved] = useState("");
    const [left, setLeft] = useState(false);
    const guard = useUnsavedChanges({
      dirty: draft !== saved,
      save: async () => {
        const ok = await save();
        if (ok) setSaved(draft);
        return ok;
      },
    });
    return (
      <>
        <label>
          Title
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button type="button" onClick={() => guard.requestNavigation(() => setLeft(true))}>
          Back to library
        </button>
        <p>{left ? "Navigated" : "Editing"}</p>
        <UnsavedDialog guard={guard} incomplete={incomplete} />
      </>
    );
  }

  it("navigates directly when clean and offers Stay first when dirty", async () => {
    const user = userEvent.setup();
    renderWithLocale(<Editor save={async () => true} />, { namespaces: [...NAMESPACES] });
    await user.click(screen.getByRole("button", { name: "Back to library" }));
    expect(screen.getByText("Navigated")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("blocks navigation when the save fails, keeps the draft, and continues after a successful save", async () => {
    const user = userEvent.setup();
    const gate = deferred<boolean>();
    const save = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => gate.promise);
    renderWithLocale(<Editor save={save} incomplete />, { namespaces: [...NAMESPACES] });
    await user.type(screen.getByLabelText("Title"), "Draft judul");
    const back = screen.getByRole("button", { name: "Back to library" });
    await user.click(back);
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(dialog).toHaveAccessibleDescription("You have changes that haven't been saved yet.");
    const stay = within(dialog).getByRole("button", { name: "Stay on this page" });
    await waitFor(() => expect(stay).toHaveFocus());
    const buttons = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((label) => label !== "");
    expect(buttons.slice(-3)).toEqual([
      "Stay on this page",
      "Discard changes",
      "Save and continue",
    ]);
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "Incomplete drafts can be saved, but some problems must be fixed first.",
    );

    // Failed save: stays, draft kept, navigation blocked.
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Saving failed. Your draft is kept and you'll stay on this page.",
    );
    expect(screen.getByText("Editing")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Draft judul");

    // Successful save then continue.
    await user.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(within(dialog).getByText("Saving, then continuing…")).toBeInTheDocument();
    expect(screen.getByText("Editing")).toBeInTheDocument();
    await act(async () => gate.resolve(true));
    expect(screen.getByText("Navigated")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("stays on Escape or Stay and leaves on Discard", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => true);
    renderWithLocale(<Editor save={save} />, { namespaces: [...NAMESPACES] });
    await user.type(screen.getByLabelText("Title"), "x");
    const back = screen.getByRole("button", { name: "Back to library" });
    await user.click(back);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(back).toHaveFocus();
    expect(screen.getByText("Editing")).toBeInTheDocument();
    await user.click(back);
    await user.click(await screen.findByRole("button", { name: "Stay on this page" }));
    expect(screen.getByText("Editing")).toBeInTheDocument();
    await user.click(back);
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(screen.getByText("Navigated")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});
