"use client";
/**
 * Root error boundary (S17; Design §4.8; TASK-133). Maps the thrown error to a safe fallback:
 * API errors use their code (not found, no access, expired sign-in, room gone, kicked, replaced),
 * everything else is a service failure with Try again. Only fixed translated messages are shown —
 * never the error text — and the reference is the API correlation ID or the server digest when it
 * is a safe token.
 *
 * Retry re-renders the segment in a transition (busy "Trying again…"). If it fails again the
 * boundary remounts this page; a retry within the last few seconds is remembered so the page
 * says it is still not working instead of looking like a first failure.
 */
import { useTransition } from "react";
import { describeError, fallbackForError, SessionFallback } from "@/components/ui/session-fallback";

/** How long a retry counts as "just tried" for a remounted boundary (ms). */
const RETRY_MEMORY_MS = 10_000;
/** Time of the last retry started from this boundary (module scope survives the remount). */
let lastRetryAt = 0;

/** Props passed by Next.js to an error boundary. */
interface ErrorPageProps {
  error: unknown;
  retry: () => void;
}

/** Error boundary page. */
export default function ErrorPage({ error, retry }: ErrorPageProps) {
  const [, startTransition] = useTransition();
  const { code, reference } = describeError(error);
  const variant = fallbackForError(code);
  const retriedRecently = Date.now() - lastRetryAt < RETRY_MEMORY_MS;
  const returnTo = typeof window === "undefined" ? null : window.location.pathname;

  return (
    <SessionFallback
      variant={variant}
      correlationId={reference}
      retryFailed={retriedRecently}
      returnTo={returnTo}
      onRetry={() =>
        new Promise<boolean>((resolve) => {
          lastRetryAt = Date.now();
          startTransition(() => {
            retry();
            resolve(true);
          });
        })
      }
    />
  );
}
