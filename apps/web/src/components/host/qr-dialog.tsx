"use client";
/**
 * Host join QR code and the M07 enlarged QR dialog (US-07/08/18; Design §4.9 M07; SA §8.3; TASK-131).
 *
 * - `QrCodeImage` draws the same-origin join link `${APP_URL}/join?pin=<PIN>` as a high-contrast SVG
 *   (black modules on white, 4-module quiet zone kept inside the image, forced colors ignored) at a
 *   fixed square size, max min(320 px, available width). It shows a placeholder of the same size
 *   while the lazily loaded generator runs and reports failures.
 * - `QrDialog` (M07) shows the QR, the link and the PIN as alternatives, with "Copy link". When the
 *   clipboard is unavailable or copying fails, the link text is selected for manual copying.
 *   States: empty (no room PIN yet), loading, ideal, partial (no clipboard) and error (QR failed —
 *   the link and PIN stay usable).
 * - `QrEnlargeButton` opens the dialog from the lobby (focus returns to it on close).
 */
import { useEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import {
  buildJoinUrl,
  configuredAppOrigin,
  createQrMatrix,
  qrSvgPath,
  type QrMatrix,
  type QrSvgPath,
} from "@/lib/qr";
import { useLocale } from "@/providers/locale-provider";

/** QR matrix generator (injectable in tests). */
export type QrGenerator = (text: string) => Promise<QrMatrix>;
/** Clipboard surface used for "Copy link" (null = unavailable). */
export type ClipboardLike = Pick<Clipboard, "writeText"> | null;

/** Generation state of one QR value. */
type QrState = { status: "loading" } | { status: "ready"; svg: QrSvgPath } | { status: "error" };

/** Generates the SVG drawing for `value`; state is keyed by value so stale results never show. */
export function useQrSvg(value: string, generate: QrGenerator = createQrMatrix): QrState {
  const [result, setResult] = useState<{ value: string; state: QrState } | null>(null);
  useEffect(() => {
    let active = true;
    generate(value).then(
      (matrix) => {
        if (active) setResult({ value, state: { status: "ready", svg: qrSvgPath(matrix) } });
      },
      () => {
        if (active) setResult({ value, state: { status: "error" } });
      },
    );
    return () => {
      active = false;
    };
  }, [value, generate]);
  return result && result.value === value ? result.state : { status: "loading" };
}

/** Same-origin join link for a PIN, or null when the PIN or origin is missing/invalid. */
export function joinLinkFor(pin: string | null, origin: string | null): string | null {
  if (!pin || !origin) return null;
  try {
    return buildJoinUrl(origin, pin);
  } catch {
    return null;
  }
}

/** Props of {@link QrCodeImage}. */
export interface QrCodeImageProps {
  value: string;
  /** Accessible name of the image. */
  label: string;
  generate?: QrGenerator;
  className?: string;
}

/** High-contrast QR image with a same-size loading placeholder and an error notice. */
export function QrCodeImage({ value, label, generate, className = "" }: QrCodeImageProps) {
  const { t } = useLocale();
  const state = useQrSvg(value, generate);
  const frame = `mx-auto aspect-square w-full max-w-[320px] ${className}`;
  if (state.status === "ready")
    return (
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${state.svg.viewBox} ${state.svg.viewBox}`}
        shapeRendering="crispEdges"
        className={`${frame} block forced-color-adjust-none`}
      >
        <rect width={state.svg.viewBox} height={state.svg.viewBox} fill="#ffffff" />
        <path d={state.svg.path} fill="#000000" />
      </svg>
    );
  return (
    <div
      role={state.status === "error" ? "alert" : "status"}
      className={`${frame} flex items-center justify-center rounded-md border border-dashed border-border bg-subtle p-4 text-center text-small`}
    >
      {state.status === "error" ? t("host.inventory.m07.error") : t("host.inventory.m07.loading")}
    </div>
  );
}

/** Selects the whole text of an element (manual copy fallback). */
function selectContents(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Default clipboard: the async Clipboard API when present. */
function defaultClipboard(): ClipboardLike {
  if (typeof navigator === "undefined") return null;
  return typeof navigator.clipboard?.writeText === "function" ? navigator.clipboard : null;
}

/** Props of {@link QrDialog}. */
export interface QrDialogProps {
  open: boolean;
  onClose: () => void;
  /** Room PIN (null while the room is not ready). */
  pin: string | null;
  /** Join origin; defaults to the configured app origin. */
  origin?: string;
  generate?: QrGenerator;
  /** Clipboard (tests); defaults to `navigator.clipboard`. */
  clipboard?: ClipboardLike;
}

/** M07: enlarged QR with link, PIN and Copy link. */
export function QrDialog({ open, onClose, pin, origin, generate, clipboard }: QrDialogProps) {
  const { t } = useLocale();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const linkRef = useRef<HTMLParagraphElement | null>(null);
  const joinUrl = joinLinkFor(pin, origin ?? configuredAppOrigin());
  const board = clipboard === undefined ? defaultClipboard() : clipboard;

  // A reopened dialog starts without a stale copy message.
  useEffect(() => {
    if (!open) setCopy("idle");
  }, [open]);

  /** Copies the link, falling back to selecting it. */
  const copyLink = async () => {
    if (!joinUrl) return;
    try {
      if (!board) throw new Error("Clipboard unavailable");
      await board.writeText(joinUrl);
      setCopy("copied");
    } catch {
      setCopy("failed");
      if (linkRef.current) {
        linkRef.current.focus();
        selectContents(linkRef.current);
      }
    }
  };

  return (
    <ModalSheet
      open={open}
      title={t("host.qr.title")}
      description={joinUrl ? t("host.inventory.m07.ideal") : undefined}
      size="normal"
      onCloseRequest={onClose}
      footer={
        <div className="flex flex-wrap gap-2">
          {joinUrl && board && (
            <ActionButton label={t("host.qr.copyLink")} onPress={() => void copyLink()} />
          )}
          <ActionButton variant="secondary" label={t("host.qr.close")} onPress={onClose} />
        </div>
      }
    >
      {joinUrl && pin ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <QrCodeImage
            value={joinUrl}
            label={t("host.qr.title")}
            {...(generate ? { generate } : {})}
          />
          <p
            ref={linkRef}
            tabIndex={-1}
            className="w-full rounded-md bg-subtle px-2 py-1 font-mono text-small break-all select-all"
          >
            {joinUrl}
          </p>
          <div>
            <p className="text-small text-muted-foreground">{t("host.lobby.sharePin")}</p>
            <p className="text-display font-semibold tracking-[0.2em] tabular-nums">{pin}</p>
          </div>
          {!board && (
            <p role="note" className="text-small text-muted-foreground">
              {t("host.inventory.m07.partial")}
            </p>
          )}
          <div role="status" aria-live="polite" className="min-h-6 text-small">
            {copy === "copied" && t("host.qr.copied")}
            {copy === "failed" && `${t("host.qr.copyFailed")} ${t("host.qr.manualCopy")}`}
          </div>
        </div>
      ) : (
        <div className="mx-auto flex aspect-square w-full max-w-[320px] items-center justify-center rounded-md border border-dashed border-border p-4 text-center text-small text-muted-foreground">
          {t("host.inventory.m07.empty")}
        </div>
      )}
    </ModalSheet>
  );
}

/** Props of {@link QrEnlargeButton}. */
export interface QrEnlargeButtonProps {
  pin: string | null;
  origin?: string;
  generate?: QrGenerator;
  clipboard?: ClipboardLike;
}

/** Lobby trigger that opens the enlarged QR dialog. */
export function QrEnlargeButton({ pin, ...rest }: QrEnlargeButtonProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton
        variant="secondary"
        label={t("host.qr.enlarge")}
        disabled={!pin}
        disabledReason={t("host.inventory.m07.empty")}
        onPress={() => setOpen(true)}
      />
      <QrDialog open={open} onClose={() => setOpen(false)} pin={pin} {...rest} />
    </>
  );
}
