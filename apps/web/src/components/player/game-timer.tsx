"use client";
/**
 * F15 `GameTimer` (Design §5.2, §7.1, §7.3; SA §6.4; US-10/US-18; TASK-129): a ring and a number of
 * seconds counting down to the authoritative input deadline.
 *
 * - Remaining time is `inputClosesAt − serverNow()`, re-read locally every 200 ms inside this
 *   component only (no global per-tick re-render). It is clamped at 0 and never increases for the
 *   same deadline, so a clock rebase can shorten but never extend the visible time.
 * - At the deadline the input closes in the UI (`onInputClosed`, called once) — the server still
 *   decides acceptance; during the grace period until `acceptanceClosesAt` the timer shows 0 and a
 *   waiting message, and afterwards "Answers are closed."
 * - Screen readers hear three polite announcements per question, each once: the opening time, five
 *   seconds left, and "Time's up." The visible number itself is not a live region.
 * - Untimed phases (no deadline) render nothing; the ring animation stops under reduced motion.
 */
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/providers/locale-provider";

/** Props of {@link GameTimer}. */
export interface GameTimerProps {
  questionStartedAt: number | null;
  inputClosesAt: number | null;
  acceptanceClosesAt: number | null;
  /** Server-synchronized clock (epoch ms). */
  serverNow: () => number;
  /** Called once when the input deadline passes (locks the answer UI only). */
  onInputClosed?: () => void;
  size?: "player" | "host";
  /** Refresh period of the local display (ms). */
  tickMs?: number;
}

/** Whole seconds shown for `remainingMs` (ceil, so "1" is visible until the deadline). */
export function displaySeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** Countdown ring + number with milestone announcements. */
export function GameTimer({
  questionStartedAt,
  inputClosesAt,
  acceptanceClosesAt,
  serverNow,
  onInputClosed,
  size = "player",
  tickMs = 200,
}: GameTimerProps) {
  const { t } = useLocale();
  const compute = () => (inputClosesAt === null ? 0 : Math.max(0, inputClosesAt - serverNow()));
  const [remaining, setRemaining] = useState(compute);
  const [now, setNow] = useState(() => serverNow());
  const [announcement, setAnnouncement] = useState("");
  const shown = useRef<{ deadline: number | null; remaining: number }>({
    deadline: inputClosesAt,
    remaining: Number.POSITIVE_INFINITY,
  });
  const announced = useRef<{
    deadline: number | null;
    opening: boolean;
    five: boolean;
    closed: boolean;
  }>({
    deadline: null,
    opening: false,
    five: false,
    closed: false,
  });
  const closedCallback = useRef<number | null>(null);
  const onClosed = useRef(onInputClosed);
  onClosed.current = onInputClosed;

  useEffect(() => {
    if (inputClosesAt === null) return;
    // A new deadline (next question or recovered phase) starts fresh.
    if (shown.current.deadline !== inputClosesAt)
      shown.current = { deadline: inputClosesAt, remaining: Number.POSITIVE_INFINITY };
    if (announced.current.deadline !== inputClosesAt)
      announced.current = { deadline: inputClosesAt, opening: false, five: false, closed: false };

    const update = () => {
      const current = serverNow();
      // Never show more time than before for the same deadline (rebases cannot extend it).
      const value = Math.min(shown.current.remaining, Math.max(0, inputClosesAt - current));
      shown.current.remaining = value;
      setRemaining(value);
      setNow(current);
      const seconds = displaySeconds(value);
      const marks = announced.current;
      if (!marks.opening && value > 0) {
        marks.opening = true;
        setAnnouncement(t("player.answer.secondsRemaining", { seconds }));
      } else if (!marks.five && value > 0 && seconds <= 5 && marks.opening) {
        marks.five = true;
        setAnnouncement(t("player.answer.secondsRemaining", { seconds }));
      }
      if (value === 0) {
        if (!marks.closed) {
          marks.closed = true;
          setAnnouncement(t("player.answer.timeExpired"));
        }
        if (closedCallback.current !== inputClosesAt) {
          closedCallback.current = inputClosesAt;
          onClosed.current?.();
        }
      }
    };
    update();
    const timer = setInterval(update, tickMs);
    return () => clearInterval(timer);
  }, [inputClosesAt, serverNow, tickMs, t]);

  if (inputClosesAt === null) return null;
  const total =
    questionStartedAt !== null
      ? Math.max(1, inputClosesAt - questionStartedAt)
      : Math.max(1, remaining);
  const fraction = Math.min(1, remaining / total);
  const seconds = displaySeconds(remaining);
  const inGrace = remaining === 0 && acceptanceClosesAt !== null && now < acceptanceClosesAt;
  const dimension = size === "host" ? 128 : 88;
  const radius = 44;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        role="timer"
        aria-label={t("accessibility.game.timerLabel")}
        className="relative"
        style={{ width: dimension, height: dimension }}
      >
        <svg viewBox="0 0 100 100" aria-hidden="true" className="h-full w-full -rotate-90">
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            strokeWidth="8"
            className="stroke-subtle"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className={clsx(
              seconds <= 5 ? "stroke-danger" : "stroke-primary",
              "motion-safe:transition-[stroke-dashoffset] motion-safe:duration-200",
            )}
          />
        </svg>
        <span
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 flex items-center justify-center font-mono font-extrabold tabular-nums",
            size === "host" ? "text-[56px]" : "text-[28px]",
          )}
        >
          {seconds}
        </span>
        <span className="sr-only">{t("player.answer.secondsRemaining", { seconds })}</span>
      </div>
      {remaining === 0 && (
        <p className="text-small text-muted-foreground">
          {inGrace ? t("player.result.waitingForResults") : t("player.answer.inputClosed")}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
