"use client";
/**
 * B06 `StatusNotice` (Design §5.1, §6.3; US-18/US-21; TASK-120): banners, toasts and empty-state
 * notices with correct live-region semantics, plus helpers that keep loading/empty/error honest.
 *
 * - Semantics: errors use `role="alert"` (assertive) and never auto-dismiss; other tones use
 *   `role="status"` (polite). `livePriority="off"` renders static text (e.g. an empty state the
 *   user navigated to). `pending` shows the translated "Processing…" status.
 * - A notice without a message renders nothing — no empty boxes.
 * - Important errors stay until dismissed; an action (e.g. Retry) is a focusable button. A safe
 *   correlation ID (`[A-Za-z0-9_-]{1,128}`) is shown as "Reference ID: …" with a Copy button, wraps
 *   when long and is never mixed into the message; unsafe values are not displayed.
 * - Toasts of non-error tones may auto-dismiss after `autoDismissMs`, paused while hovered or
 *   focused so they never vanish under the user's hand.
 * - `useStatusNotices` keeps one entry per `key`: a repeated event refreshes the existing notice
 *   (and counts repeats) instead of stacking duplicates.
 * - `contentState` decides what a data region shows; a failed fetch is an error, never "empty".
 */
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";

/** Notice tone. */
export type NoticeTone = "info" | "success" | "warning" | "error";

/** An action offered by the notice (e.g. Retry). */
export interface NoticeAction {
  label: string;
  onAction: () => void;
  pending?: boolean;
}

/** Props of {@link StatusNotice}. */
export interface StatusNoticeProps {
  variant?: "banner" | "toast" | "empty";
  tone?: NoticeTone;
  title?: ReactNode;
  message?: ReactNode;
  /** Shows the translated "Processing…" status instead of a message. */
  pending?: boolean;
  action?: NoticeAction;
  /** Server correlation/reference ID; shown only when it is a safe token. */
  correlationId?: string | null;
  /** Live announcement priority (default: assertive for errors, polite otherwise). */
  livePriority?: "polite" | "assertive" | "off";
  onDismiss?: () => void;
  /** Toast auto-dismiss delay; ignored for errors (important errors persist). */
  autoDismissMs?: number;
  /** How many times the same event happened (shown when > 1). */
  repeatCount?: number;
}

/** Correlation IDs are displayed only when they are plain tokens. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Tone styles and icons; meaning is always carried by text too. */
const TONES: Record<NoticeTone, { className: string; icon: ReactNode }> = {
  info: { className: "border-border bg-subtle text-foreground", icon: <Info /> },
  success: { className: "border-success bg-success-surface text-success", icon: <CheckCircle2 /> },
  warning: { className: "border-warning bg-warning-surface text-warning", icon: <AlertTriangle /> },
  error: { className: "border-danger bg-danger-surface text-danger", icon: <AlertTriangle /> },
};

/** Banner, toast or empty-state notice; renders nothing without a message. */
export function StatusNotice({
  variant = "banner",
  tone = "info",
  title,
  message,
  pending = false,
  action,
  correlationId,
  livePriority,
  onDismiss,
  autoDismissMs,
  repeatCount = 1,
}: StatusNoticeProps) {
  const { t, formatNumber } = useLocale();
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const isError = tone === "error";
  const priority = livePriority ?? (isError ? "assertive" : "polite");
  const timed = variant === "toast" && !isError && autoDismissMs !== undefined && onDismiss;

  // Auto-dismiss non-error toasts, paused while hovered or focused.
  useEffect(() => {
    if (!timed || paused) return;
    const timer = setTimeout(() => onDismiss?.(), autoDismissMs);
    return () => clearTimeout(timer);
  }, [timed, paused, autoDismissMs, onDismiss]);

  const hasMessage = pending || (message !== undefined && message !== null && message !== "");
  if (!hasMessage) return null;

  const safeId = correlationId && SAFE_CORRELATION_ID.test(correlationId) ? correlationId : null;
  const role = priority === "off" ? undefined : priority === "assertive" ? "alert" : "status";

  /** Copies the reference ID; failures are silent (the ID stays selectable). */
  async function copyId() {
    if (!safeId) return;
    try {
      await navigator.clipboard.writeText(safeId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      role={role}
      aria-live={priority === "off" ? undefined : priority}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      className={clsx(
        "flex min-w-0 items-start gap-3 rounded-md border p-3 text-small",
        variant === "toast" && "shadow-2",
        variant === "empty"
          ? "border-dashed border-border bg-transparent text-foreground"
          : TONES[tone].className,
      )}
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 [&>svg]:size-5">
        {pending ? <LoaderCircle className="motion-safe:animate-spin" /> : TONES[tone].icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-foreground">
        {title && <p className="font-semibold break-words">{title}</p>}
        <p className="break-words">{pending ? t("common.inventory.b06.loading") : message}</p>
        {safeId && (
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span className="break-all">
              {t("common.error.correlation", { correlationId: safeId })}
            </span>
            <button
              type="button"
              onClick={() => void copyId()}
              className="min-h-11 rounded-md px-2 text-label underline hover:bg-subtle"
            >
              {t("common.actions.copy")}
            </button>
            {copied && <span className="sr-only">{t("common.inventory.b06.ideal")}</span>}
          </p>
        )}
        {action && (
          <div>
            <ActionButton
              variant="secondary"
              label={action.label}
              pending={action.pending ?? false}
              onPress={action.onAction}
            />
          </div>
        )}
      </div>
      {repeatCount > 1 && (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-pill bg-panel px-2 text-caption tabular-nums"
        >
          {`×${formatNumber(repeatCount)}`}
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md hover:bg-panel"
        >
          <X aria-hidden="true" className="size-5" />
          <span className="sr-only">{t("common.actions.close")}</span>
        </button>
      )}
    </div>
  );
}

/** One queued notice; `key` identifies repeats of the same event. */
export interface QueuedNotice extends Omit<StatusNoticeProps, "onDismiss" | "repeatCount"> {
  key: string;
}

/** A queued notice with its repeat count. */
export interface ActiveNotice extends QueuedNotice {
  repeatCount: number;
}

/** Notice queue that de-duplicates repeated events by key. */
export function useStatusNotices() {
  const [notices, setNotices] = useState<ActiveNotice[]>([]);
  const push = useCallback((notice: QueuedNotice) => {
    setNotices((current) => {
      const existing = current.find((item) => item.key === notice.key);
      if (existing === undefined) return [...current, { ...notice, repeatCount: 1 }];
      return current.map((item) =>
        item.key === notice.key ? { ...item, ...notice, repeatCount: item.repeatCount + 1 } : item,
      );
    });
  }, []);
  const dismiss = useCallback((key: string) => {
    setNotices((current) => current.filter((item) => item.key !== key));
  }, []);
  return { notices, push, dismiss };
}

/** Always-present toast region, so polite announcements are reliable. */
export function StatusNoticeRegion({
  notices,
  onDismiss,
}: {
  notices: readonly ActiveNotice[];
  onDismiss: (key: string) => void;
}) {
  const { t } = useLocale();
  // Stable dismiss callbacks per key, so a toast's auto-dismiss timer is not reset by re-renders.
  const dismissers = useRef(new Map<string, () => void>());
  for (const key of dismissers.current.keys())
    if (!notices.some((notice) => notice.key === key)) dismissers.current.delete(key);
  return (
    <section
      aria-label={t("common.inventory.b06.title")}
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[var(--layer-toast)] flex flex-col items-end gap-2"
    >
      {notices.map(({ key, ...notice }) => {
        let dismiss = dismissers.current.get(key);
        if (dismiss === undefined) {
          dismiss = () => onDismiss(key);
          dismissers.current.set(key, dismiss);
        }
        return (
          <div key={key} className="pointer-events-auto w-full max-w-sm">
            <StatusNotice variant="toast" {...notice} onDismiss={dismiss} />
          </div>
        );
      })}
    </section>
  );
}

/** What a data region should render (`idle`: nothing requested yet, so no skeleton). */
export type ContentState = "idle" | "loading" | "error" | "empty" | "ready";

/**
 * Decides the state of a data region: loading first (unless data is already shown), then error —
 * a failed fetch is never reported as "empty" — then empty only for a successful, known-empty
 * result; with nothing requested yet it is idle (render no skeleton), else ready. Stale data stays "ready" while a refetch is loading or failed (callers show
 * a stale label next to it).
 */
export function contentState(input: {
  loading: boolean;
  error: unknown;
  items: readonly unknown[] | null | undefined;
}): ContentState {
  const known = Array.isArray(input.items);
  if (known && (input.items?.length ?? 0) > 0) return "ready";
  if (input.loading) return "loading";
  if (input.error !== null && input.error !== undefined) return "error";
  if (!known) return "idle";
  return "empty";
}
