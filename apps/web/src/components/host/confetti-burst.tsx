"use client";
/**
 * Confetti for the first-place podium cue (Design §7.3; TASK-156). Loaded lazily by the podium
 * (its own chunk), mounted only for a live first-place reveal, and removed after at most 2 s.
 *
 * - Purely decorative (aria-hidden, no pointer events), so it never covers controls for input.
 * - Deterministic layout (no randomness per render), using the four answer colors.
 * - Never rendered under reduced motion or for missed cues (the podium decides).
 */
import { motion } from "framer-motion";

/** Total confetti lifetime (delay + fall) in milliseconds. */
export const CONFETTI_MS = 2_000;
/** Number of pieces. */
const PIECES = 28;
/** Answer colors for the pieces. */
const COLORS = ["var(--answer-a)", "var(--answer-b)", "var(--answer-c)", "var(--answer-d)"];

/** A short, one-shot confetti burst across the podium. */
export default function ConfettiBurst() {
  return (
    <div
      aria-hidden="true"
      data-confetti=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {Array.from({ length: PIECES }, (_, index) => {
        const delay = (index % 7) * 0.05;
        return (
          <motion.span
            key={index}
            className="absolute top-0 block h-3 w-2 rounded-sm"
            style={{
              left: `${(index * 37) % 100}%`,
              backgroundColor: COLORS[index % COLORS.length],
            }}
            initial={{ y: -16, rotate: 0, opacity: 1 }}
            animate={{ y: 320 + (index % 5) * 40, rotate: 180 + (index % 4) * 90, opacity: 0 }}
            transition={{ delay, duration: CONFETTI_MS / 1000 - delay, ease: "easeIn" }}
          />
        );
      })}
    </div>
  );
}
