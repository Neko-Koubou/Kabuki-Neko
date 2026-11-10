/**
 * Root 404 (S17 "not found"; Design §4.8; TASK-133): a safe page with no hint about whether a
 * resource exists or who owns it, plus Go to home. `notFound()` from any route renders this too.
 */
import type { Metadata } from "next";
import { SessionFallback } from "@/components/ui/session-fallback";

/** Error pages are never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Not-found fallback. */
export default function NotFound() {
  return <SessionFallback variant="notFound" />;
}
