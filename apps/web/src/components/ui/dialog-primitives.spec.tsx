/**
 * TASK-119 coverage for B04 ModalSheet and B05 MenuPopover: focus trap with Tab/Shift+Tab wrap,
 * Escape/outside/close requests (never an action), focus returned to the opener, initial focus on
 * Cancel for destructive confirmations, inert background, closing during a pending request keeps
 * the parent's request state, one active modal at a time, the five design states (loading, empty,
 * ready, partial/long body, error) and keyboard menus (open, arrows, disabled items, Escape, empty
 * menu removes its trigger, loading keeps it). Text comes from the real en catalogs.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { ActionButton } from "./action-button";
import { MenuPopover } from "./menu-popover";
import { ModalSheet, type CloseReason } from "./modal-sheet";

/** Dialog harness: opener button, a background control and a two-button footer. */
function Harness(props: {
  onClose?: (reason: CloseReason) => void;
  destructive?: boolean;
  dismissOnOutside?: boolean;
  state?: "loading" | "empty" | "ready";
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <button type="button">Background control</button>
      <ModalSheet
        open={open}
        title="Delete quiz"
        description="This permanently deletes “World capitals”."
        {...(props.destructive ? { initialFocus: cancel } : {})}
        {...(props.state ? { state: props.state } : {})}
        {...(props.error ? { error: props.error } : {})}
        {...(props.dismissOnOutside === false ? { dismissOnOutside: false } : {})}
        onCloseRequest={(reason) => {
          props.onClose?.(reason);
          setOpen(false);
        }}
        footer={
          <>
            <ActionButton
              ref={cancel}
              variant="secondary"
              label="Cancel"
              onPress={() => setOpen(false)}
            />
            <ActionButton variant="danger" label="Delete" />
          </>
        }
      >
        <label>
          Confirmation text
          <input />
        </label>
      </ModalSheet>
    </>
  );
}

/** The dialog's scrim (overlay) element. */
function scrim(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".bg-scrim");
  if (element === null) throw new Error("no scrim rendered");
  return element;
}

describe("B04 ModalSheet", () => {
  it("traps Tab/Shift+Tab, hides the background and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithLocale(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete quiz" });
    expect(dialog).toHaveAccessibleDescription("This permanently deletes “World capitals”.");
    // Background is inert for assistive technology while the dialog is open.
    expect(screen.queryByRole("button", { name: "Background control" })).not.toBeInTheDocument();

    const close = within(dialog).getByRole("button", { name: "Close dialog" });
    const input = within(dialog).getByRole("textbox", { name: "Confirmation text" });
    const del = within(dialog).getByRole("button", { name: "Delete" });
    expect(close).toHaveFocus(); // first tabbable
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(del).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus(); // wraps forward
    await user.tab({ shift: true });
    expect(del).toHaveFocus(); // wraps backward

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("focuses Cancel first for destructive confirmations; outside press only requests closing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = renderWithLocale(<Harness destructive onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // The page behind is inert (pointer-events: none); a press lands on the scrim.
    expect(document.body.style.pointerEvents).toBe("none");
    await user.click(scrim());
    expect(onClose).toHaveBeenCalledWith("outside");
    unmount();

    const stay = vi.fn();
    renderWithLocale(<Harness dismissOnOutside={false} onClose={stay} />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    await user.click(scrim());
    expect(stay).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closing during a pending request keeps the parent's request state", async () => {
    const user = userEvent.setup();
    let finish: (() => void) | null = null;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    function PendingHarness() {
      const [open, setOpen] = useState(false);
      const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Edit
          </button>
          <output aria-label="request">{status}</output>
          <ModalSheet
            open={open}
            title="Rename"
            pending={status === "saving"}
            onCloseRequest={() => setOpen(false)}
            footer={
              <ActionButton
                label="Save"
                pending={status === "saving"}
                onPress={() => {
                  setStatus("saving");
                  void save().then(() => setStatus("saved"));
                }}
              />
            }
          >
            <p>Body</p>
          </ModalSheet>
        </>
      );
    }
    renderWithLocale(<PendingHarness />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("request")).toHaveTextContent("saving");

    // Reopened while the request is still in flight: still pending, no second request.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const saveButton = screen.getByRole("button", { name: /^Save/u });
    expect(saveButton).toHaveAttribute("aria-busy", "true");
    await user.click(saveButton);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
    expect(screen.getByLabelText("request")).toHaveTextContent("saved");
  });

  it("keeps a single active modal: a second dialog takes over and gives control back", async () => {
    const user = userEvent.setup();
    function Stacked() {
      const [picker, setPicker] = useState(false);
      const [confirm, setConfirm] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setPicker(true)}>
            Pick media
          </button>
          <ModalSheet open={picker} title="Media library" onCloseRequest={() => setPicker(false)}>
            <button type="button" onClick={() => setConfirm(true)}>
              Delete file
            </button>
          </ModalSheet>
          <ModalSheet open={confirm} title="Delete file?" onCloseRequest={() => setConfirm(false)}>
            <p>Unused files only.</p>
          </ModalSheet>
        </>
      );
    }
    renderWithLocale(<Stacked />);
    await user.click(screen.getByRole("button", { name: "Pick media" }));
    await user.click(screen.getByRole("button", { name: "Delete file" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Delete file?" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const picker = screen.getByRole("dialog", { name: "Media library" });
    expect(picker).toBeInTheDocument();
    expect(picker).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick media" })).toHaveFocus();
  });

  it("renders the loading, empty, partial and error states with the close action available", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = renderWithLocale(<Harness state="loading" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    let dialog = screen.getByRole("dialog", { name: "Delete quiz" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading content…");
    expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
    unmount();

    const { unmount: unmountEmpty } = renderWithLocale(<Harness state="empty" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Nothing to show here.");
    expect(within(dialog).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledWith("close-button");
    unmountEmpty();

    renderWithLocale(<Harness error="The quiz is in use by a live game." />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The quiz is in use by a live game.",
    );
    // Partial/long body: only the body scrolls; header and footer stay outside the scroller.
    const body = within(dialog).getByRole("textbox").closest(".overflow-y-auto");
    expect(body).not.toBeNull();
    expect(body).not.toContainElement(within(dialog).getByRole("button", { name: "Delete" }));
    expect(body).not.toContainElement(within(dialog).getByRole("alert"));
    expect(within(dialog).getByRole("button", { name: "Close dialog" })).toBeEnabled();
  });

  it("offers a back action in the header when provided", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderWithLocale(
      <ModalSheet open title="Scanner" fullHeight onBack={onBack} onCloseRequest={() => {}}>
        <p>Camera</p>
      </ModalSheet>,
    );
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("B05 MenuPopover", () => {
  const items = [
    { id: "edit", label: "Edit quiz" },
    { id: "archive", label: "Archive", disabled: true },
    {
      id: "delete",
      label: "Delete quiz permanently with a long translated label",
      destructive: true,
    },
  ];

  it("opens from the keyboard, skips disabled items, runs one action and returns focus", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderWithLocale(
      <MenuPopover triggerLabel="Quiz actions" iconOnly items={items} onAction={onAction} />,
    );
    const trigger = screen.getByRole("button", { name: "Quiz actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu");
    const edit = within(menu).getByRole("menuitem", { name: "Edit quiz" });
    expect(edit).toHaveFocus();
    expect(within(menu).getByRole("menuitem", { name: "Archive" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    const del = within(menu).getByRole("menuitem", { name: /^Delete quiz permanently/u });
    expect(del).toHaveFocus();
    expect(del.className).toMatch(/whitespace-normal/u);
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("delete");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("hides the trigger when empty and keeps it with a loading menu", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithLocale(
      <MenuPopover triggerLabel="More" items={[]} onAction={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    rerender(<MenuPopover triggerLabel="More" items={[]} loading onAction={() => {}} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("menu")).getByRole("status")).toHaveTextContent(
      "Loading actions…",
    );
  });
});
