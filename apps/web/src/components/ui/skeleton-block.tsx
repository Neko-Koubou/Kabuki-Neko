"use client";
/**
 * B07 `SkeletonBlock` (Design §5.1, §6.3; US-18; TASK-120): a loading placeholder with stable
 * dimensions that can never become an endless skeleton.
 *
 * - The shapes are decorative (`aria-hidden`); exactly one visually hidden loading label is
 *   announced through `role="status"`, and the wrapper sets `aria-busy`. Pulsing is disabled under
 *   `prefers-reduced-motion` (static placeholder).
 * - Layouts reserve the final size (text lines, card, row list, media 16:9, avatar), so content
 *   replacing them does not shift the page.
 * - After `slowAfterMs` (default 8 s) a visible "This is taking longer than usual. Still
 *   loading…" message appears. After `failAfterMs` the skeleton is replaced by the error text
 *   "This content couldn't load." and a Retry action (when `onRetry` is given) — the placeholder
 *   never spins forever.
 */
import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";

/** Placeholder shapes. */
export type SkeletonLayout = "text" | "card" | "rows" | "media" | "avatar";

/** Props of {@link SkeletonBlock}. */
export interface SkeletonBlockProps {
  layout?: SkeletonLayout;
  /** Lines (text) or rows (rows) to reserve. */
  count?: number;
  /** Announced loading label (default: translated "Loading…"). */
  label?: string;
  /** Show the "taking longer" message after this many ms. */
  slowAfterMs?: number;
  /** Replace the skeleton with an error after this many ms (no endless skeleton). */
  failAfterMs?: number;
  onRetry?: () => void;
  className?: string;
}

/** One decorative bar. */
function Bar({ className }: { className: string }) {
  return (
    <span className={clsx("block rounded-sm bg-subtle motion-safe:animate-pulse", className)} />
  );
}

/** Decorative loading placeholder with a single loading label and a timeout. */
export function SkeletonBlock({
  layout = "text",
  count = 3,
  label,
  slowAfterMs = 8_000,
  failAfterMs,
  onRetry,
  className,
}: SkeletonBlockProps) {
  const { t } = useLocale();
  const [phase, setPhase] = useState<"loading" | "slow" | "failed">("loading");

  useEffect(() => {
    const timers = [setTimeout(() => setPhase((p) => (p === "loading" ? "slow" : p)), slowAfterMs)];
    if (failAfterMs !== undefined) timers.push(setTimeout(() => setPhase("failed"), failAfterMs));
    return () => timers.forEach(clearTimeout);
  }, [slowAfterMs, failAfterMs]);

  if (phase === "failed")
    return (
      <div role="alert" className={clsx("flex flex-col items-start gap-2 text-small", className)}>
        <p className="text-danger">{t("common.inventory.b07.error")}</p>
        {onRetry && (
          <ActionButton
            variant="secondary"
            label={t("common.actions.retry")}
            onPress={() => {
              setPhase("loading");
              onRetry();
            }}
          />
        )}
      </div>
    );

  let shapes;
  if (layout === "card")
    shapes = (
      <span className="flex flex-col gap-3 rounded-md border border-border p-4">
        <Bar className="aspect-video w-full" />
        <Bar className="h-5 w-2/3" />
        <Bar className="h-4 w-1/2" />
      </span>
    );
  else if (layout === "rows")
    shapes = (
      <span className="flex flex-col gap-2">
        {Array.from({ length: count }, (_, index) => (
          <Bar key={index} className="h-11 w-full" />
        ))}
      </span>
    );
  else if (layout === "media") shapes = <Bar className="aspect-video w-full" />;
  else if (layout === "avatar") shapes = <Bar className="size-16 rounded-full" />;
  else
    shapes = (
      <span className="flex flex-col gap-2">
        {Array.from({ length: count }, (_, index) => (
          <Bar key={index} className={clsx("h-4", index === count - 1 ? "w-2/3" : "w-full")} />
        ))}
      </span>
    );

  return (
    <div aria-busy="true" className={clsx("flex flex-col gap-2", className)}>
      <span aria-hidden="true">{shapes}</span>
      <p
        role="status"
        className={phase === "slow" ? "text-small text-muted-foreground" : "sr-only"}
      >
        {phase === "slow"
          ? t("common.inventory.b07.partial")
          : (label ?? t("common.inventory.b07.loading"))}
      </p>
    </div>
  );
}
