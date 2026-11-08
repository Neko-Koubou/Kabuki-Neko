"use client";
/**
 * B04 `ModalSheet` (Design §4.9, §5.1, §6.3; US-18/US-21; TASK-119): the single dialog pattern
 * for M01–M12, built on Radix Dialog (the Shadcn base).
 *
 * - Modal: focus is trapped inside (Tab/Shift+Tab wrap), the rest of the page is hidden from
 *   assistive technology and not interactive, scrolling is locked, and on close focus returns to
 *   the element that opened the dialog. `initialFocus` picks the first focused control — Cancel for
 *   destructive confirmations.
 * - Escape, the close button and (unless disabled) an outside press only *request* closing through
 *   `onCloseRequest`; nothing destructive runs. Closing while `pending` does not cancel the
 *   parent's request — the parent keeps the request state and reconciles when reopened.
 * - One active modal: if another ModalSheet opens on top, this one steps back (its focus trap is
 *   released) and returns when the other closes — focus traps are never stacked.
 * - Layout: desktop max-width 480 (`normal`), 880 (`media`) or 1040 (`detail`); mobile uses the
 *   viewport width minus 32 px, `fullHeight` sheets (M02/M05/M12) fill the height. Header (title,
 *   optional back, close) and footer stay visible; only the body scrolls, and the inline error sits
 *   between body and footer so the sticky footer never covers it or focused content.
 * - States: `loading` shows a busy body with the title and close still available, `empty` shows
 *   "Nothing to show here." with a Close action, `ready` renders the content; `error` is an inline
 *   alert that keeps the dialog closable.
 */
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";

/** Why the dialog asks to close. */
export type CloseReason = "escape" | "outside" | "close-button";

/** Props of {@link ModalSheet}. */
export interface ModalSheetProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Desktop width: 480 normal / 880 media & import / 1040 detail. */
  size?: "normal" | "media" | "detail";
  /** Full-height sheet on mobile (scanner, media picker, answer detail). */
  fullHeight?: boolean;
  /** Control focused when the dialog opens (e.g. Cancel for destructive confirmations). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** The parent's request is in flight; closing stays possible and does not cancel it. */
  pending?: boolean;
  /** Body state: loading placeholder, empty notice or the children. */
  state?: "loading" | "empty" | "ready";
  /** Inline error shown above the footer; the dialog stays closable. */
  error?: ReactNode;
  footer?: ReactNode;
  /** Optional mobile-style back action in the header. */
  onBack?: () => void;
  /** Allow an outside press to request closing (default true). */
  dismissOnOutside?: boolean;
  onCloseRequest: (reason: CloseReason) => void;
  children?: ReactNode;
}

/** Ids of open modals, most recent last; only the last one is active. */
let openModals: readonly string[] = [];
const modalListeners = new Set<() => void>();
/** Replaces the open-modal list and notifies subscribers. */
function setOpenModals(next: readonly string[]) {
  openModals = next;
  for (const listener of modalListeners) listener();
}
/** Subscribes to open-modal changes. */
function subscribeModals(listener: () => void) {
  modalListeners.add(listener);
  return () => modalListeners.delete(listener);
}
/** Current open-modal list (server: none). */
const modalSnapshot = () => openModals;
const serverModalSnapshot = (): readonly string[] => [];

/** Desktop widths per size. */
const SIZE_CLASS = {
  normal: "md:max-w-[480px]",
  media: "md:max-w-[880px]",
  detail: "md:max-w-[1040px]",
} as const;

/** Accessible modal dialog / mobile sheet with the five design states. */
export function ModalSheet({
  open,
  title,
  description,
  size = "normal",
  fullHeight = false,
  initialFocus,
  pending = false,
  state = "ready",
  error,
  footer,
  onBack,
  dismissOnOutside = true,
  onCloseRequest,
  children,
}: ModalSheetProps) {
  const { t } = useLocale();
  const id = useId();
  const stack = useSyncExternalStore(subscribeModals, modalSnapshot, serverModalSnapshot);
  const active = open && stack[stack.length - 1] === id;
  // The element that opened the dialog; focus returns there when it really closes.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined")
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  // Register while open so a later modal can take over and give control back afterwards.
  useEffect(() => {
    if (!open) return;
    setOpenModals([...openModals.filter((item) => item !== id), id]);
    return () => setOpenModals(openModals.filter((item) => item !== id));
  }, [open, id]);

  const invalid = error !== undefined && error !== null && error !== false;

  let body: ReactNode = children;
  if (state === "loading")
    body = (
      <div aria-busy="true" className="flex min-h-24 items-center text-muted-foreground">
        <p role="status">{t("common.inventory.b04.loading")}</p>
      </div>
    );
  else if (state === "empty")
    body = (
      <div className="flex flex-col items-start gap-3">
        <p role="status" className="text-muted-foreground">
          {t("common.inventory.b04.empty")}
        </p>
        <ActionButton
          variant="secondary"
          label={t("common.actions.close")}
          onPress={() => onCloseRequest("close-button")}
        />
      </div>
    );

  return (
    <Dialog.Root open={active}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--layer-scrim)] bg-scrim" />
        <Dialog.Content
          aria-busy={pending || undefined}
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(event) => {
            const target = initialFocus?.current;
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Covered by another modal: that one takes focus. Really closed: back to the opener.
            if (!open) {
              const target = opener.current;
              if (target?.isConnected) target.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            onCloseRequest("escape");
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
            if (dismissOnOutside) onCloseRequest("outside");
          }}
          className={[
            "fixed top-1/2 left-1/2 z-[var(--layer-dialog)] flex w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-panel text-foreground shadow-3",
            fullHeight
              ? "h-[calc(100dvh-32px)] md:h-auto md:max-h-[calc(100dvh-64px)]"
              : "max-h-[calc(100dvh-32px)]",
            SIZE_CLASS[size],
          ].join(" ")}
        >
          <header className="flex items-start gap-2 border-b border-border p-4">
            {onBack && (
              <ActionButton variant="ghost" label={t("common.actions.back")} onPress={onBack} />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className="text-title-sm break-words">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="text-small break-words text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <button
              type="button"
              onClick={() => onCloseRequest("close-button")}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md hover:bg-subtle"
            >
              <X aria-hidden="true" className="size-5" />
              <span className="sr-only">{t("accessibility.controls.closeDialog")}</span>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
          {invalid && (
            <div
              role="alert"
              className="border-t border-border px-4 py-3 text-small break-words text-danger"
            >
              {error}
            </div>
          )}
          {footer && state !== "empty" && (
            <footer className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
              {footer}
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
