"use client";
/**
 * Progressive image reveal (GRID_3X3, GRID_5X5, BLUR; Design §7.3, SA §7.1, US-06/US-09;
 * TASK-122).
 *
 * - Progress is a pure function of the server-synchronized clock and the authoritative window
 *   (`startsAt` = question start, `endsAt` = input close): `(now - startsAt) / (endsAt - startsAt)`,
 *   clamped to 0–1. The component only re-reads the clock on a timer, so a throttled tab, dropped
 *   frames or a late mount never drift: every device shows the same step at the same server time.
 * - Grids uncover `floor(progress × cells)` tiles (all of them at the deadline) in an order derived
 *   from `seed` (the question id) with a seeded Fisher–Yates shuffle, identical for host and
 *   players. Blur goes from 24 px to 0.
 * - Reduced motion: tiles appear without fades and blur moves in four discrete steps — the same
 *   progress, no smooth animation.
 * - The overlay is decorative (`aria-hidden`); the media keeps its own text alternative. A failing
 *   image underneath never pauses the reveal or the game timer, which this component does not own.
 */
import { clsx } from "clsx";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RevealMode } from "@kabuki-neko/shared/constants/game";

/** Maximum blur at the start of a BLUR reveal. */
export const MAX_BLUR_PX = 24;
/** Discrete blur steps under reduced motion. */
const REDUCED_BLUR_STEPS = 4;
/** How often the clock is re-read (progress itself never depends on this). */
const TICK_MS = 100;

/** Number of tiles per grid mode. */
export function gridCells(mode: RevealMode): number {
  return mode === "GRID_3X3" ? 9 : mode === "GRID_5X5" ? 25 : 0;
}

/** Reveal progress 0–1 at server time `now` for the window [startsAt, endsAt]. */
export function revealProgress(now: number, startsAt: number, endsAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return 0;
  if (endsAt <= startsAt) return now >= endsAt ? 1 : 0;
  return Math.min(1, Math.max(0, (now - startsAt) / (endsAt - startsAt)));
}

/** Tiles uncovered at `progress`: floor(progress × cells), all at the deadline. */
export function revealedCellCount(mode: RevealMode, progress: number): number {
  const cells = gridCells(mode);
  return progress >= 1 ? cells : Math.floor(progress * cells);
}

/** Blur radius at `progress`; reduced motion snaps to discrete steps. */
export function blurRadius(progress: number, reducedMotion: boolean): number {
  const remaining = 1 - Math.min(1, Math.max(0, progress));
  const stepped = reducedMotion
    ? Math.ceil(remaining * REDUCED_BLUR_STEPS) / REDUCED_BLUR_STEPS
    : remaining;
  return Math.round(stepped * MAX_BLUR_PX * 100) / 100;
}

/** 32-bit FNV-1a hash of a string (seed for the tile order). */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Deterministic tile order for `seed`: a seeded (mulberry32) Fisher–Yates permutation. */
export function cellOrder(mode: RevealMode, seed: string): number[] {
  const order = Array.from({ length: gridCells(mode) }, (_, index) => index);
  let state = fnv1a(`${mode}:${seed}`);
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap] ?? 0, order[index] ?? 0];
  }
  return order;
}

/** Reduced-motion preference as an external store (false on the server). */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(listener: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function reducedMotionSnapshot() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/** Props of {@link MediaReveal}. */
export interface MediaRevealProps {
  mode: RevealMode;
  /** Shared seed for the tile order (the question id). */
  seed: string;
  /** Authoritative window in server epoch milliseconds. */
  startsAt: number;
  endsAt: number;
  /** Server-synchronized clock (epoch ms). */
  now: () => number;
  /** Force a full reveal (e.g. after the answer phase). */
  complete?: boolean;
  children: ReactNode;
}

/** Wraps media with a deterministic, clock-driven grid or blur reveal. */
export function MediaReveal({
  mode,
  seed,
  startsAt,
  endsAt,
  now,
  complete = false,
  children,
}: MediaRevealProps) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const [clock, setClock] = useState(() => now());
  const progress = complete ? 1 : revealProgress(clock, startsAt, endsAt);
  const active = mode !== "NONE" && progress < 1;

  // Re-read the clock while the reveal is running; progress is always derived from it.
  useEffect(() => {
    setClock(now());
    if (!active) return;
    const timer = setInterval(() => setClock(now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active, now]);

  if (mode === "NONE") return <>{children}</>;

  if (mode === "BLUR") {
    const radius = blurRadius(progress, reducedMotion);
    return (
      <div className="relative overflow-hidden" data-reveal-progress={progress.toFixed(3)}>
        <div
          style={{ filter: radius > 0 ? `blur(${radius}px)` : undefined }}
          className={clsx(!reducedMotion && "transition-[filter] duration-100 ease-linear")}
        >
          {children}
        </div>
      </div>
    );
  }

  const cells = gridCells(mode);
  const shown = revealedCellCount(mode, progress);
  const order = cellOrder(mode, seed);
  const uncovered = new Set(order.slice(0, shown));
  const columns = mode === "GRID_3X3" ? 3 : 5;

  return (
    <div className="relative overflow-hidden" data-reveal-progress={progress.toFixed(3)}>
      {children}
      <div
        aria-hidden="true"
        className="absolute inset-0 grid"
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      >
        {Array.from({ length: cells }, (_, index) => (
          <span
            key={index}
            data-covered={!uncovered.has(index)}
            className={clsx(
              "border border-panel bg-subtle",
              uncovered.has(index) ? "opacity-0" : "opacity-100",
              !reducedMotion && "transition-opacity duration-300",
            )}
          />
        ))}
      </div>
    </div>
  );
}
