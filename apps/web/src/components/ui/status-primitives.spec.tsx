/**
 * TASK-120 coverage for B06 StatusNotice, B07 SkeletonBlock and B08 StatusBadge: live-region
 * semantics (assertive alerts vs polite status), persistent errors with a focusable retry and a
 * safe copyable reference ID, auto-dismissing toasts that pause on hover/focus, no render without a
 * message, de-duplicated repeated events, `contentState` never turning a failed fetch into "empty",
 * skeletons with one loading label that show a waiting message and then an error + retry instead
 * of spinning forever, and badges that always pair an icon with text and never show unknown as 0.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { SkeletonBlock } from "./skeleton-block";
import { StatusBadge } from "./status-badge";
import {
  StatusNotice,
  StatusNoticeRegion,
  contentState,
  useStatusNotices,
  type QueuedNotice,
} from "./status-notice";

describe("B06 StatusNotice", () => {
  it("keeps important errors as alerts with a focusable retry and a safe reference ID", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    renderWithLocale(
      <StatusNotice
        variant="toast"
        tone="error"
        title="Couldn't save"
        message="The server didn't respond."
        correlationId="req_8f2c-41aa"
        action={{ label: "Try again", onAction }}
        onDismiss={onDismiss}
        autoDismissMs={3000}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveTextContent("The server didn't respond.");
    expect(alert).toHaveTextContent("Reference ID: req_8f2c-41aa");
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled(); // errors never auto-dismiss
    const retry = within(alert).getByRole("button", { name: "Try again" });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith("req_8f2c-41aa");
  });

  it("hides unsafe reference IDs and renders nothing without a message", () => {
    const { container, rerender } = renderWithLocale(
      <StatusNotice tone="error" message="Failed." correlationId="<img src=x onerror=1>" />,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("Reference ID");
    rerender(<StatusNotice tone="error" message="" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<StatusNotice tone="info" pending />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing…");
    rerender(<StatusNotice variant="empty" livePriority="off" message="Nothing here yet" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("auto-dismisses polite toasts, pausing while hovered or focused", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    renderWithLocale(
      <StatusNotice
        variant="toast"
        tone="success"
        message="Saved"
        onDismiss={onDismiss}
        autoDismissMs={5000}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    fireEvent.mouseEnter(status);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(status);
    fireEvent.focus(within(status).getByRole("button", { name: "Close" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(within(status).getByRole("button", { name: "Close" }));
    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates repeated events by key in an always-present region", () => {
    let api: ReturnType<typeof useStatusNotices> | null = null;
    function Toasts() {
      const notices = useStatusNotices();
      api = notices;
      return <StatusNoticeRegion notices={notices.notices} onDismiss={notices.dismiss} />;
    }
    renderWithLocale(<Toasts />);
    const region = screen.getByRole("region", { name: "Status message" });
    expect(region).toBeEmptyDOMElement();
    const reconnect: QueuedNotice = {
      key: "socket.reconnect",
      tone: "warning",
      message: "Reconnecting…",
    };
    act(() => {
      api?.push(reconnect);
      api?.push(reconnect);
      api?.push(reconnect);
    });
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(within(region).getByText("×3")).toHaveAttribute("aria-hidden", "true");
    act(() => api?.push({ key: "save.ok", tone: "success", message: "Saved" }));
    expect(within(region).getAllByRole("status")).toHaveLength(2);
    fireEvent.click(within(region).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(region).toHaveTextContent("Saved");
  });
});

describe("contentState", () => {
  it("never reports a failed fetch as empty and never loads forever when idle", () => {
    expect(contentState({ loading: false, error: new Error("503"), items: [] })).toBe("error");
    expect(contentState({ loading: false, error: new Error("503"), items: null })).toBe("error");
    expect(contentState({ loading: true, error: null, items: null })).toBe("loading");
    expect(contentState({ loading: false, error: null, items: [] })).toBe("empty");
    expect(contentState({ loading: false, error: null, items: [1] })).toBe("ready");
    // Stale data stays visible while a refetch loads or fails (with a stale label by the caller).
    expect(contentState({ loading: true, error: null, items: [1] })).toBe("ready");
    expect(contentState({ loading: false, error: new Error("x"), items: [1] })).toBe("ready");
    expect(contentState({ loading: false, error: null, items: undefined })).toBe("idle");
  });
});

describe("B07 SkeletonBlock", () => {
  it("is decorative with one loading label, then waits visibly, then fails with a retry", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const { container } = renderWithLocale(
      <SkeletonBlock
        layout="rows"
        count={4}
        slowAfterMs={2000}
        failAfterMs={6000}
        onRetry={onRetry}
      />,
    );
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    const shapes = container.querySelector("[aria-hidden='true']");
    expect(shapes?.querySelectorAll(".motion-safe\\:animate-pulse")).toHaveLength(4);

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status")).toHaveTextContent(
      "This is taking longer than usual. Still loading…",
    );
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This content couldn't load.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  });

  it("drives a data region: failure shows error + retry, success with no rows shows empty", async () => {
    let attempt = 0;
    const fetchRows = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network");
      return [] as string[];
    });
    function Region() {
      const [state, setState] = useState<{
        loading: boolean;
        error: unknown;
        items: string[] | null;
      }>({
        loading: false,
        error: null,
        items: null,
      });
      const load = () => {
        setState((current) => ({ ...current, loading: true, error: null }));
        fetchRows().then(
          (items) => setState({ loading: false, error: null, items }),
          (error: unknown) => setState((current) => ({ ...current, loading: false, error })),
        );
      };
      const view = contentState(state);
      return (
        <section>
          <button type="button" onClick={load}>
            Load
          </button>
          {view === "loading" && <SkeletonBlock layout="rows" />}
          {view === "error" && (
            <StatusNotice
              tone="error"
              message="This content couldn't load."
              action={{ label: "Try again", onAction: load }}
            />
          )}
          {view === "empty" && (
            <StatusNotice variant="empty" livePriority="off" message="Nothing here yet" />
          )}
        </section>
      );
    }
    renderWithLocale(<Region />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // idle: no skeleton
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load" })));
    expect(screen.getByRole("alert")).toHaveTextContent("This content couldn't load.");
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });
});

describe("B08 StatusBadge", () => {
  it("pairs icon and text, formats values and never shows unknown as zero", () => {
    const { container, rerender } = renderWithLocale(<StatusBadge tone="success" label="Saved" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).toHaveTextContent("Saved");
    expect(badge.querySelector("[aria-hidden='true'] svg")).not.toBeNull();

    rerender(<StatusBadge tone="danger" label="Failed" />);
    expect(container).toHaveTextContent("Failed");
    expect(container.firstElementChild).toHaveClass("text-danger");

    rerender(<StatusBadge tone="info" label="Storage used" showValue value={null} />);
    expect(container).toHaveTextContent("Storage used Not known yet");
    expect(container).not.toHaveTextContent("0");
    expect(container.firstElementChild).toHaveClass("border-dashed");

    rerender(<StatusBadge tone="info" label="Players" showValue value={1234567} />);
    expect(container).toHaveTextContent("Players 1,234,567");
    rerender(<StatusBadge tone="info" label="Answers" showValue value={0} />);
    expect(container).toHaveTextContent("Answers 0");

    rerender(<StatusBadge tone="pending" />);
    expect(container).toHaveTextContent("Checking…");
    rerender(<StatusBadge tone="unknown" />);
    expect(container).toHaveTextContent("Not known yet");
    rerender(<StatusBadge tone="success" />);
    expect(container).toBeEmptyDOMElement(); // no meaningless empty badge
  });
});
