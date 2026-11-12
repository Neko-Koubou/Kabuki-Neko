"use client";
/**
 * B10 `DataCollection` (Design §5.1, §6.3; US-18/US-21; TASK-121): a table on wide screens and
 * compact cards on small screens, with sorting and pagination whose state is owned by the page
 * (URL query) — this component is fully controlled and only reports `onSort`/`onPage`.
 *
 * - Table: `<caption>`, column headers with scope, sortable headers as buttons with `aria-sort` on
 *   the header cell; long and CJK content wraps. Rows are keyed by `rowKey`, never by index.
 * - Mobile: each row becomes a card listing "header: value" pairs in a labelled list.
 * - Pagination: Previous/Next buttons and "Page X of Y" when the total is known; when it is not,
 *   only the current page number and `hasNextPage` drive the controls — an unknown total is never
 *   shown as 0 results.
 * - States: loading without data → skeleton rows; loading with data → the current rows stay, marked
 *   stale and busy; error with data → rows stay with "You're seeing older data." + Retry; error
 *   without data → error + Retry (never the empty message); success with no rows → the empty
 *   message plus an optional action (e.g. clear filters).
 */
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";
import { SkeletonBlock } from "./skeleton-block";
import { StatusNotice, contentState } from "./status-notice";

/** Sort direction. */
export type SortDirection = "ascending" | "descending";

/** Column definition. */
export interface CollectionColumn<T> {
  id: string;
  header: string;
  cell: (item: T) => ReactNode;
  sortable?: boolean;
  align?: "start" | "end";
  /** Shown as the card title on mobile. */
  primary?: boolean;
}

/** Props of {@link DataCollection}. */
export interface DataCollectionProps<T> {
  caption: string;
  /** Hide the caption visually (it still names the table). */
  hideCaption?: boolean;
  items: readonly T[] | null;
  columns: readonly CollectionColumn<T>[];
  rowKey: (item: T) => string;
  page: number;
  /** Total pages, or null when the total is unknown. */
  pageCount: number | null;
  /** For unknown totals: whether another page exists. */
  hasNextPage?: boolean;
  /** Known total result count (shown as "N results"); null/undefined = unknown, not shown. */
  totalCount?: number | null;
  sort?: { column: string; direction: SortDirection } | null;
  onSort?: (column: string) => void;
  onPage: (page: number) => void;
  pending?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyMessage?: string;
  emptyAction?: ReactNode;
}

/** Controlled table/list with pagination and honest loading/empty/stale/error states. */
export function DataCollection<T>({
  caption,
  hideCaption = false,
  items,
  columns,
  rowKey,
  page,
  pageCount,
  hasNextPage,
  totalCount,
  sort,
  onSort,
  onPage,
  pending = false,
  error,
  onRetry,
  emptyMessage,
  emptyAction,
}: DataCollectionProps<T>) {
  const { t, formatNumber } = useLocale();
  const captionId = useId();
  const view = contentState({ loading: pending, error, items });
  const failed = error !== null && error !== undefined;
  const rows = items ?? [];
  const stale = view === "ready" && (pending || failed);
  const primary = columns.find((column) => column.primary) ?? columns[0];

  if (view === "idle") return null;
  if (view === "loading")
    return <SkeletonBlock layout="rows" count={5} label={t("common.inventory.b10.loading")} />;
  if (view === "error")
    return (
      <StatusNotice
        tone="error"
        message={t("common.inventory.b09.error")}
        {...(onRetry ? { action: { label: t("common.actions.retry"), onAction: onRetry } } : {})}
      />
    );
  if (view === "empty")
    return (
      <div className="flex flex-col items-start gap-3">
        <StatusNotice
          variant="empty"
          livePriority="off"
          message={emptyMessage ?? t("common.inventory.b10.empty")}
        />
        {emptyAction}
      </div>
    );

  const canPrevious = page > 1;
  const canNext = pageCount !== null ? page < pageCount : hasNextPage === true;

  return (
    <div aria-busy={pending || undefined} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={captionId} className={clsx("text-label font-semibold", hideCaption && "sr-only")}>
          {caption}
        </h2>
        {typeof totalCount === "number" && (
          <p className="text-small text-muted-foreground">
            {t("common.pagination.resultCount", { count: totalCount })}
          </p>
        )}
      </div>
      {stale && (
        <StatusNotice
          tone="warning"
          livePriority={failed ? "assertive" : "polite"}
          message={failed ? t("common.inventory.b10.error") : t("common.status.stale")}
          {...(failed && onRetry
            ? { action: { label: t("common.actions.retry"), onAction: onRetry } }
            : {})}
        />
      )}

      {/* Wide screens: a real table in a labelled horizontal scroll container. */}
      <div
        className="hidden overflow-x-auto md:block"
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
      >
        <table className={clsx("w-full border-collapse text-small", stale && "opacity-70")}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => {
                const active = sort?.column === column.id;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={column.sortable ? (active ? sort?.direction : "none") : undefined}
                    className={clsx(
                      "px-3 py-2 font-semibold",
                      column.align === "end" ? "text-end" : "text-start",
                    )}
                  >
                    {column.sortable && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(column.id)}
                        className="inline-flex min-h-11 items-center gap-1 rounded-sm hover:underline"
                      >
                        {column.header}
                        <span aria-hidden="true" className="inline-flex [&>svg]:size-4">
                          {active ? (
                            sort?.direction === "ascending" ? (
                              <ArrowUp />
                            ) : (
                              <ArrowDown />
                            )
                          ) : (
                            <ArrowUpDown />
                          )}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={rowKey(item)} className="border-b border-border align-top">
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={clsx(
                      "max-w-[32ch] px-3 py-2 break-words [overflow-wrap:anywhere]",
                      column.align === "end" && "text-end",
                    )}
                  >
                    {column.cell(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Small screens: compact cards with header/value pairs. */}
      <ul
        aria-labelledby={captionId}
        className={clsx("flex flex-col gap-2 md:hidden", stale && "opacity-70")}
      >
        {rows.map((item) => (
          <li key={rowKey(item)} className="rounded-md border border-border bg-card p-3">
            {primary && (
              <div className="font-semibold break-words [overflow-wrap:anywhere]">
                {primary.cell(item)}
              </div>
            )}
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
              {columns
                .filter((column) => column !== primary)
                .map((column) => (
                  <div key={column.id} className="contents">
                    <dt className="text-muted-foreground">{column.header}</dt>
                    <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
                      {column.cell(item)}
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>

      {(canPrevious || canNext || (pageCount !== null && pageCount > 1)) && (
        <nav
          aria-label={t("common.pagination.label")}
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <ActionButton
            variant="secondary"
            label={t("common.pagination.previous")}
            disabled={!canPrevious}
            onPress={() => onPage(page - 1)}
          />
          <p className="text-small tabular-nums">
            {pageCount !== null
              ? t("common.pagination.pageOf", { page, totalPages: pageCount })
              : formatNumber(page)}
          </p>
          <ActionButton
            variant="secondary"
            label={t("common.pagination.next")}
            disabled={!canNext}
            onPress={() => onPage(page + 1)}
          />
        </nav>
      )}
    </div>
  );
}
