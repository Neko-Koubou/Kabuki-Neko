"use client";
/**
 * B08 `StatusBadge` (Design §5.1, §6.3; US-18/US-21; TASK-120): a compact status label that always
 * pairs an icon with text, so meaning never depends on color or the icon alone.
 *
 * - Tones: neutral, info, success, warning, danger, plus `pending` ("Checking…" with a spinner, only
 *   when a check is really running) and `unknown` ("Not known yet").
 * - A numeric `value` is formatted for the active locale; `null`/`undefined` means unknown and is
 *   never shown as 0 or as success.
 * - Without a label (and not pending/unknown) nothing renders — no empty badge without meaning.
 * - Long labels and large numbers wrap instead of overflowing.
 */
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Circle, HelpCircle, Info, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";

/** Badge tone. */
export type BadgeTone =
  "neutral" | "info" | "success" | "warning" | "danger" | "pending" | "unknown";

/** Props of {@link StatusBadge}. */
export interface StatusBadgeProps {
  label?: ReactNode;
  tone?: BadgeTone;
  /** Optional count/metric; `null` or `undefined` with `showValue` means "Not known yet". */
  value?: number | null;
  /** Render `value` (true when the badge is a metric). */
  showValue?: boolean;
  /** Overrides the tone icon (still decorative; the text carries the meaning). */
  icon?: ReactNode;
}

/** Tone styles and default icons. */
const TONES: Record<BadgeTone, { className: string; icon: ReactNode }> = {
  neutral: { className: "border-border bg-subtle text-foreground", icon: <Circle /> },
  info: { className: "border-border bg-subtle text-foreground", icon: <Info /> },
  success: { className: "border-success bg-success-surface text-success", icon: <CheckCircle2 /> },
  warning: { className: "border-warning bg-warning-surface text-warning", icon: <AlertTriangle /> },
  danger: { className: "border-danger bg-danger-surface text-danger", icon: <AlertTriangle /> },
  pending: {
    className: "border-border bg-subtle text-muted-foreground",
    icon: <LoaderCircle className="motion-safe:animate-spin" />,
  },
  unknown: {
    className: "border-dashed border-border bg-transparent text-muted-foreground",
    icon: <HelpCircle />,
  },
};

/** Icon + text status badge; renders nothing when it would carry no meaning. */
export function StatusBadge({
  label,
  tone = "neutral",
  value,
  showValue = false,
  icon,
}: StatusBadgeProps) {
  const { t, formatNumber } = useLocale();
  const unknownValue = showValue && (value === null || value === undefined);
  const effectiveTone: BadgeTone = unknownValue && tone !== "pending" ? "unknown" : tone;
  // The value part: a formatted number, or "Not known yet" — never 0 for an unknown metric.
  const valueText =
    showValue && tone !== "pending"
      ? typeof value === "number"
        ? formatNumber(value)
        : t("common.inventory.b08.empty")
      : null;
  let text: ReactNode = label;
  if (effectiveTone === "pending") text = label ?? t("common.inventory.b08.loading");
  else if (effectiveTone === "unknown" && (label === undefined || label === null))
    text = valueText === null ? t("common.inventory.b08.empty") : null;
  if ((text === undefined || text === null || text === "") && valueText === null) return null;

  return (
    <span
      className={clsx(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-caption font-semibold break-words",
        TONES[effectiveTone].className,
      )}
    >
      <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-4">
        {icon ?? TONES[effectiveTone].icon}
      </span>
      <span className="min-w-0">
        {text}
        {text !== null && text !== undefined && valueText !== null && " "}
        {valueText !== null && <bdi className="tabular-nums">{valueText}</bdi>}
      </span>
    </span>
  );
}
