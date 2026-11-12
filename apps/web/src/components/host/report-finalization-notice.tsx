"use client";
/**
 * Host-only report finalization status after a game (S16 PODIUM/FINISHED and after the room is
 * gone; Design §6.1; SA §4.5, §6.3; US-12/14/21; TASK-160).
 *
 * - The report status is independent of the cosmetic FINISHED phase. It comes from two sources:
 *   - the host's socket (`report:status_changed` pushes, already applied to the snapshot);
 *   - `GET /reports/:sessionId/status`.
 *   The newest status by `updatedAt` wins, so a late REST answer never overrides a newer push.
 * - REST status is read only while the socket can't deliver pushes (`poll`), for example after
 *   the room expired or while the host is offline. It is read on mount and then every few seconds
 *   while saving is still pending. A 404 means there is nothing to report and hides the notice.
 * - "Try saving again" posts `retry-finalize` with an Idempotency-Key (one key per press). The
 *   button is busy while the request runs, so a double press sends one request. An uncertain
 *   outcome is reconciled through the operation lookup and then re-read from the status route,
 *   never re-sent blindly. `FINALIZATION_PENDING` just means saving is already running.
 * - "View report" appears only for `ready` with the real report id (the schema guarantees it
 *   equals the session id). Pending, failed and lost never link anywhere.
 * States:
 * - loading: first status read;
 * - empty: no finalization (hidden);
 * - ideal: ready with link;
 * - partial: pending / retry running;
 * - error: failed (with retry when retryable), lost, or a failed retry request.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { finalizeStatusSchema, type FinalizeStatus } from "@kabuki-neko/shared/schemas/game.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ApiError, apiErrorMessageKey, type ApiClient } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";

/** How often a pending status is re-read over REST while pushes are unavailable. */
export const FINALIZATION_POLL_MS = 5_000;

/** The newer of two statuses (by `updatedAt`); a null side never wins. */
export function newerStatus(
  a: FinalizeStatus | null,
  b: FinalizeStatus | null,
): FinalizeStatus | null {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** Props of {@link ReportFinalizationNotice}. */
export interface ReportFinalizationNoticeProps {
  sessionId: string;
  /** Status from the host snapshot (socket pushes); null when none was received. */
  status: FinalizeStatus | null;
  /** Authenticated API client. */
  api: Pick<ApiClient, "request" | "mutate">;
  /** Read the status over REST (pushes are not arriving). */
  poll: boolean;
  /** Poll interval (tests). */
  pollMs?: number;
  /** Idempotency key factory (tests). */
  newKey?: () => string;
}

/** Report saving status with "View report" and "Try saving again". */
export function ReportFinalizationNotice({
  sessionId,
  status,
  api,
  poll,
  pollMs = FINALIZATION_POLL_MS,
  newKey = () => crypto.randomUUID(),
}: ReportFinalizationNoticeProps) {
  const { t, ensureNamespaces } = useLocale();
  const [fetched, setFetched] = useState<FinalizeStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    void ensureNamespaces(["host", "validation"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Reads the status route; a 404 hides the notice, other failures keep the last status. */
  const load = useCallback(async () => {
    try {
      const { data } = await api.request({
        path: `/reports/${sessionId}/status`,
        schema: finalizeStatusSchema,
      });
      if (!alive.current) return;
      setFetched((previous) => newerStatus(previous, data));
      setMissing(false);
    } catch (error) {
      if (alive.current && error instanceof ApiError && error.code === "NOT_FOUND")
        setMissing(true);
    }
  }, [api, sessionId]);

  const current = newerStatus(status, fetched);
  const pending = current === null || current.status === "pending";

  // Read once when polling starts, then keep reading while saving is pending.
  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    setLoading(true);
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [poll, load]);
  useEffect(() => {
    if (!poll || !pending || missing) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [poll, pending, missing, pollMs, load]);

  /** Sends one retry; extra presses while it runs do nothing. */
  const retry = async () => {
    if (running.current) return;
    running.current = true;
    setRetrying(true);
    setProblem(null);
    try {
      const result = await api.mutate("report.retry", {
        method: "POST",
        path: `/reports/${sessionId}/retry-finalize`,
        body: {},
        schema: finalizeStatusSchema,
        idempotencyKey: newKey(),
      });
      if (result.outcome === "done" && alive.current)
        setFetched((previous) => newerStatus(previous, result.response.data));
      else await load();
    } catch (error) {
      if (error instanceof ApiError && error.code === "FINALIZATION_PENDING") await load();
      else if (alive.current)
        setProblem(t(apiErrorMessageKey(error instanceof ApiError ? error.code : "NETWORK_ERROR")));
    } finally {
      running.current = false;
      if (alive.current) setRetrying(false);
    }
  };

  if (missing && !status) return null;
  if (!current)
    return loading ? (
      <p role="status" aria-live="polite" className="text-body text-muted-foreground">
        {t("host.finalization.saving")}
      </p>
    ) : null;

  return (
    <section
      aria-label={t("reports.inventory.f10.title")}
      data-finalization={current.status}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      {current.status === "ready" && current.reportId ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-body">
            {t("host.finalization.ready")}
          </p>
          <Link
            href={`/dashboard/reports/${current.reportId}`}
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
          >
            {t("host.finalization.viewReport")}
          </Link>
        </div>
      ) : current.status === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-body text-danger">
            {t("host.finalization.failed")}
          </p>
          {current.retryable && (
            <ActionButton
              variant="secondary"
              label={t("host.finalization.retry")}
              pending={retrying}
              onPress={() => void retry()}
            />
          )}
        </div>
      ) : current.status === "lost" ? (
        <p role="alert" className="text-body text-danger">
          {t("host.finalization.lost")}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="text-body text-muted-foreground">
          {t("host.finalization.pending")}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-small text-danger">
          {problem}
        </p>
      )}
    </section>
  );
}
