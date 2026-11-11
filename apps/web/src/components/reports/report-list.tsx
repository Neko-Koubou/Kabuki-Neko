"use client";
/**
 * S09 host report history (Design §4.4, §6.1; SA §4.5; US-14/US-21; TASK-161).
 *
 * - Lists only the signed-in host's ready reports (`GET /reports`), newest first, 15 per page.
 *   The server scopes every query to the current host, so another host's sessions never appear,
 *   even with a foreign `quizId` in the URL.
 * - Query state lives in the URL (`quizId`, `search`, `page`). Parsing clamps bad values. Only
 *   the latest request applies: a new query aborts the previous one, so slow responses never
 *   overwrite newer results. A page beyond the last one moves back to the last page.
 * - Each row shows the snapshot quiz title (long titles wrap; a deleted quiz keeps its title), the
 *   end date and time with the viewer's time zone, the player count, and how the game ended
 *   ("Completed", "Ended early by the host", "Ended because the room expired"). The title links to
 *   the report (S10).
 * - The quiz filter lists the host's own quizzes. A filtered quiz that no longer exists is still
 *   shown as the current choice.
 * States:
 * - loading: skeleton rows;
 * - empty: no finished games yet (link back to quizzes), or no matches (clear filters);
 * - ideal: the table or cards with pagination;
 * - partial: stale rows with "older data" after a failed refresh, early-ended badges;
 * - error: the failure with Retry and its reference id, never shown as "0 reports".
 * A lost session is handled by the dashboard shell (sign in again); a 403/404 shows the error.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { PAGING } from "@kabuki-neko/shared/constants/limits";
import type { endReasonSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { quizzesPageSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { sessionsPageSchema, type SessionSummary } from "@kabuki-neko/shared/schemas/report.schema";
import { ActionButton } from "@/components/ui/action-button";
import { DataCollection, type CollectionColumn } from "@/components/ui/data-collection";
import { FormField } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, createLatestRequest, type ApiClient } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Reports per page (Design §4.4). */
export const REPORTS_PAGE_SIZE = PAGING.defaults.reports;
/** Longest accepted search text. */
const MAX_SEARCH = 100;
/** Select value for "all quizzes" (an empty value collides with the select placeholder). */
const ALL = "all";
/** Lowercase UUID shape accepted for the quiz filter. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Report list query kept in the URL. */
export interface ReportsQuery {
  page: number;
  search: string;
  quizId: string | null;
}

/** Raw URL search parameters (first values). */
export type RawReportsParams = Partial<Record<"page" | "search" | "quizId", string>>;

/** Parses (and clamps) URL parameters into a report query. */
export function parseReportsQuery(raw: RawReportsParams): ReportsQuery {
  const page = Number.parseInt(raw.page ?? "1", 10);
  return {
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, PAGING.maxPage) : 1,
    search: (raw.search ?? "").slice(0, MAX_SEARCH),
    quizId: raw.quizId && UUID.test(raw.quizId) ? raw.quizId : null,
  };
}

/** URL of the report list for `query` (defaults omitted). */
export function reportsHref(query: ReportsQuery): string {
  const params = new URLSearchParams();
  if (query.quizId) params.set("quizId", query.quizId);
  if (query.search) params.set("search", query.search);
  if (query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `/dashboard/reports?${text}` : "/dashboard/reports";
}

/** Fetches one page of ready reports for the current host. */
export async function fetchReports(api: ApiClient, query: ReportsQuery, signal?: AbortSignal) {
  const { data } = await api.request({
    path: "/reports",
    query: {
      page: query.page,
      limit: REPORTS_PAGE_SIZE,
      sort: "ended_desc",
      search: query.search || undefined,
      quizId: query.quizId ?? undefined,
    },
    schema: sessionsPageSchema,
    ...(signal ? { signal } : {}),
  });
  return data;
}

/** How a game ended. */
type EndReason = (typeof endReasonSchema)["options"][number];

/** Message key of each end reason. */
const END_REASON_KEY: Record<EndReason, string> = {
  COMPLETED: "reports.detail.completed",
  HOST_ENDED: "reports.detail.earlyEnd",
  EXPIRED: "reports.detail.expired",
};

/** List state. */
type ListState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; items: SessionSummary[]; total: number; totalPages: number; stale: boolean };

/** Props of {@link ReportList}. */
export interface ReportListProps {
  query: ReportsQuery;
  onQueryChange: (query: ReportsQuery) => void;
}

/** S09: the host's report history. */
export function ReportList({ query, onQueryChange }: ReportListProps) {
  const { t, formatNumber, timeZoneLabel, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [pending, setPending] = useState(false);
  const [version, setVersion] = useState(0);
  const [searchText, setSearchText] = useState(query.search);
  const [quizzes, setQuizzes] = useState<{ id: string; title: string }[]>([]);
  const latest = useMemo(() => createLatestRequest(), []);

  useEffect(() => {
    void ensureNamespaces(["reports", "quizzes", "validation"]);
  }, [ensureNamespaces]);

  // Keep the search box in sync with back/forward navigation.
  useEffect(() => setSearchText(query.search), [query.search]);

  // The host's own quizzes for the filter (a failure only leaves the filter with "All").
  useEffect(() => {
    const controller = new AbortController();
    api
      .request({
        path: "/quizzes",
        query: { scope: "own", limit: PAGING.maxLimit, sort: "title_asc" },
        schema: quizzesPageSchema,
        signal: controller.signal,
      })
      .then(
        ({ data }) => setQuizzes(data.items.map((quiz) => ({ id: quiz.id, title: quiz.title }))),
        () => undefined,
      );
    return () => controller.abort();
  }, [api]);

  // Load the page for the current query (only the latest response is applied).
  useEffect(() => {
    let active = true;
    setPending(true);
    latest
      .run((signal) => fetchReports(api, query, signal))
      .then(
        (result) => {
          if (!active || result.stale) return;
          const { items, meta } = result.value;
          if (meta.total > 0 && query.page > meta.totalPages) {
            onQueryChange({ ...query, page: meta.totalPages });
            return;
          }
          setState({
            status: "ready",
            items,
            total: meta.total,
            totalPages: meta.totalPages,
            stale: false,
          });
          setPending(false);
        },
        (error: unknown) => {
          if (!active) return;
          setPending(false);
          setState((current) =>
            current.status === "ready" ? { ...current, stale: true } : { status: "error", error },
          );
        },
      );
    return () => {
      active = false;
    };
    // `onQueryChange` is a navigation callback; the request depends on the query values only.
  }, [api, latest, query.page, query.search, query.quizId, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  const retry = useCallback(() => setVersion((n) => n + 1), []);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    onQueryChange({ ...query, search: searchText.trim().slice(0, MAX_SEARCH), page: 1 });
  };

  const filtered = query.search !== "" || query.quizId !== null;
  const items = state.status === "ready" ? state.items : null;
  const quizOptions = [
    { value: ALL, label: t("media.library.all") },
    ...quizzes.map((quiz) => ({ value: quiz.id, label: quiz.title })),
  ];
  // A filtered quiz that is gone (or not loaded) stays visible as the current choice.
  if (query.quizId && !quizzes.some((quiz) => quiz.id === query.quizId))
    quizOptions.push({
      value: query.quizId,
      label: items?.find((item) => item.quizId === query.quizId)?.quizTitle ?? query.quizId,
    });

  const columns: CollectionColumn<SessionSummary>[] = [
    {
      id: "title",
      header: t("quizzes.metadata.quizTitle"),
      primary: true,
      cell: (session) => (
        <Link
          href={`/dashboard/reports/${session.id}`}
          dir="auto"
          className="font-semibold break-words text-primary underline-offset-2 hover:underline"
        >
          {session.quizTitle}
        </Link>
      ),
    },
    {
      id: "ended",
      header: t("reports.list.sortEnded"),
      cell: (session) => (
        <span>
          {t("reports.detail.sessionEndedAt", {
            endedAt: session.endedAt,
            timezone: timeZoneLabel(session.endedAt),
          })}
        </span>
      ),
    },
    {
      id: "players",
      header: t("reports.detail.participants"),
      align: "end",
      cell: (session) => <span className="tabular-nums">{formatNumber(session.totalPlayers)}</span>,
    },
    {
      id: "status",
      header: t("reports.table.status"),
      cell: (session) => (
        <StatusBadge
          tone={session.endReason === "COMPLETED" ? "success" : "warning"}
          label={t(END_REASON_KEY[session.endReason])}
        />
      ),
    },
  ];

  let body;
  if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("reports.inventory.s09.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: retry }}
      />
    );
  else
    body = (
      <DataCollection
        caption={t("reports.inventory.s09.ideal")}
        items={items}
        columns={columns}
        rowKey={(session) => session.id}
        page={query.page}
        pageCount={state.status === "ready" ? Math.max(1, state.totalPages) : null}
        totalCount={state.status === "ready" ? state.total : null}
        onPage={(page) => onQueryChange({ ...query, page })}
        pending={pending}
        error={state.status === "ready" && state.stale ? new Error("stale") : null}
        onRetry={retry}
        emptyMessage={filtered ? t("reports.list.empty") : t("reports.inventory.s09.empty")}
        emptyAction={
          filtered ? (
            <ActionButton
              variant="secondary"
              label={t("common.actions.clearFilters")}
              onPress={() => onQueryChange({ page: 1, search: "", quizId: null })}
            />
          ) : (
            <Link
              href="/dashboard/quizzes"
              className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-label font-semibold"
            >
              {t("common.navigation.quizzes")}
            </Link>
          )
        }
      />
    );

  return (
    <section className="flex flex-col gap-6" aria-labelledby="reports-title">
      <div className="flex flex-col gap-1">
        <h1 id="reports-title" className="text-title font-bold">
          {t("reports.list.title")}
        </h1>
        <p className="text-small text-muted-foreground">{t("reports.inventory.s09.ideal")}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <form role="search" onSubmit={submitSearch} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <FormField
              label={t("reports.list.search")}
              value={searchText}
              onChange={setSearchText}
            />
          </div>
          <ActionButton type="submit" variant="secondary" label={t("common.actions.search")} />
        </form>
        <FormField
          kind="select"
          label={t("reports.list.quizFilter")}
          value={query.quizId ?? ALL}
          options={quizOptions}
          onChange={(value) =>
            onQueryChange({ ...query, quizId: value === ALL ? null : value, page: 1 })
          }
        />
      </div>
      {body}
    </section>
  );
}

/** Route wrapper with Next navigation (URL query is the list state). */
export function ReportListRoute({ params }: { params: RawReportsParams }) {
  const router = useRouter();
  const query = parseReportsQuery(params);
  return <ReportList query={query} onQueryChange={(next) => router.push(reportsHref(next))} />;
}
