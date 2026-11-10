"use client";
/**
 * F02 quiz library (S05; Design §4.2, §7; SA §4.3, §6.4; US-03/05/07/21; TASK-138).
 *
 * - Scope tabs (My quizzes / Public quizzes), search, sort and pagination (12 per page) live in the
 *   URL (`scope`, `search`, `sort`, `page`), so going back restores the same list. The server
 *   decides what is visible (`scope=public` never lists PRIVATE quizzes); the client never filters
 *   private resources in.
 * - Cards show the title (full text kept, visually clamped), cover with a safe fallback, question
 *   count, visibility, last update, the owner for public quizzes and an "invalid draft" notice.
 *   Actions follow the server `capabilities`: Host (playable quizzes open M06; invalid drafts go
 *   to the detail page with the problem summary), Edit, Duplicate and Delete (M09). Public quizzes
 *   of other creators are read-only (no Edit/Delete).
 * - Create opens M03 and then the studio. Import is offered through `onImport` (dialog integrated
 *   later).
 * - Requests: only the latest list response is applied (stale responses are dropped), and every
 *   mutation invalidates the list (re-fetch). Duplicate and room creation reconcile lost responses
 *   through their operation keys. Delete sends `If-Match` with the card revision; a lost DELETE is
 *   reconciled by re-reading the quiz (404 = deleted).
 * States: loading (skeleton grid), empty (no quizzes: create/import; no matches: clear search),
 * ideal (grid), partial (a refresh failed: the previous list stays, marked possibly out of date)
 * and error (first load failed: retry).
 */
import { MoreHorizontal, Plus, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { PAGING } from "@kabuki-neko/shared/constants/limits";
import {
  quizDeletedSchema,
  quizDetailSchema,
  quizzesPageSchema,
  type QuizSummary,
} from "@kabuki-neko/shared/schemas/quiz.schema";
import { clientContracts } from "@kabuki-neko/shared/socket-events";
import {
  HostConfigDialog,
  type CreateRoomRequest,
  type CreatedRoom,
} from "@/components/host/host-config-dialog";
import { QuizSettingsModal } from "@/components/studio/QuizSettingsModal";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { ContentCard } from "@/components/ui/content-card";
import { MenuPopover } from "@/components/ui/menu-popover";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, createLatestRequest, type ApiClient } from "@/lib/api-client";
import { createGameSocket, type EmitResult } from "@/lib/socket-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Quizzes per page (PRD). */
export const LIBRARY_PAGE_SIZE = 12;
/** Longest accepted search text. */
const MAX_SEARCH = 100;

/** Library query kept in the URL. */
export interface LibraryQuery {
  scope: "own" | "public";
  page: number;
  search: string;
  sort: "updated_desc" | "title_asc";
}

/** Raw URL search parameters (first values). */
export type RawLibraryParams = Partial<Record<"scope" | "page" | "search" | "sort", string>>;

/** Parses (and clamps) URL parameters into a library query. */
export function parseLibraryQuery(raw: RawLibraryParams): LibraryQuery {
  const page = Number.parseInt(raw.page ?? "1", 10);
  return {
    scope: raw.scope === "public" ? "public" : "own",
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, PAGING.maxPage) : 1,
    search: (raw.search ?? "").slice(0, MAX_SEARCH),
    sort: raw.sort === "title_asc" ? "title_asc" : "updated_desc",
  };
}

/** URL of the library for `query` (defaults omitted). */
export function libraryHref(query: LibraryQuery): string {
  const params = new URLSearchParams();
  if (query.scope !== "own") params.set("scope", query.scope);
  if (query.search) params.set("search", query.search);
  if (query.sort !== "updated_desc") params.set("sort", query.sort);
  if (query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `/dashboard/quizzes?${text}` : "/dashboard/quizzes";
}

/** Room creation over a short-lived host socket (the host stage reconnects and recovers). */
export type CreateRoomFn = (request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>;

/** Default room creation: connect a host socket, send once, disconnect after the outcome. */
function socketCreateRoom(getToken: () => string | null): CreateRoomFn {
  return async (request) => {
    const socket = createGameSocket({
      url: process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001",
      role: "host",
      getAccessToken: getToken,
      ackTimeoutMs: 10_000,
    });
    socket.connect();
    try {
      clientContracts["host:create_room"].request.parse(request);
      return await socket.emit("host:create_room", request);
    } finally {
      socket.disconnect();
    }
  };
}

/** List load state. */
type ListState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; items: QuizSummary[]; total: number; totalPages: number; stale: boolean };

/** Fetches one page of the library. */
async function fetchPage(api: ApiClient, query: LibraryQuery, signal: AbortSignal) {
  const { data } = await api.request({
    path: "/quizzes",
    query: {
      page: query.page,
      limit: LIBRARY_PAGE_SIZE,
      scope: query.scope,
      sort: query.sort,
      ...(query.search ? { search: query.search } : {}),
    },
    schema: quizzesPageSchema,
    signal,
  });
  return data;
}

/** Props of {@link QuizLibrary}. */
export interface QuizLibraryProps {
  query: LibraryQuery;
  onQueryChange: (query: LibraryQuery) => void;
  /** Navigation (studio, detail, host stage). */
  navigate: (href: string) => void;
  /** Room creation (defaults to a short-lived host socket). */
  createRoom?: CreateRoomFn;
  /** Opens the import dialog (integrated later). */
  onImport?: () => void;
}

/** The S05 library. */
export function QuizLibrary({
  query,
  onQueryChange,
  navigate,
  createRoom,
  onImport,
}: QuizLibraryProps) {
  const { t, formatDate, ensureNamespaces } = useLocale();
  const { api, getAccessToken } = useAuth();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const [searchText, setSearchText] = useState(query.search);
  const [createOpen, setCreateOpen] = useState(false);
  const [hostQuiz, setHostQuiz] = useState<QuizSummary | null>(null);
  const [deleting, setDeleting] = useState<QuizSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useMemo(() => createLatestRequest(), []);
  const searchId = useId();
  const roomCreator = useMemo(
    () => createRoom ?? socketCreateRoom(getAccessToken),
    [createRoom, getAccessToken],
  );

  useEffect(() => {
    void ensureNamespaces(["quizzes", "host", "validation", "auth"]);
  }, [ensureNamespaces]);

  // Keep the search box in sync with back/forward navigation.
  useEffect(() => {
    setSearchText(query.search);
  }, [query.search]);

  // Load the page for the current query (only the latest response is applied).
  useEffect(() => {
    let active = true;
    setState((current) =>
      current.status === "ready" ? { ...current, stale: false } : { status: "loading" },
    );
    latest
      .run((signal) => fetchPage(api, query, signal))
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
        },
        (error: unknown) => {
          if (!active) return;
          setState((current) =>
            current.status === "ready" ? { ...current, stale: true } : { status: "error", error },
          );
        },
      );
    return () => {
      active = false;
    };
    // `onQueryChange` is a navigation callback; the request depends on the query values only.
  }, [api, latest, query.scope, query.page, query.search, query.sort, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  /** Re-fetches the list (after mutations or a failed load). */
  const invalidate = useCallback(() => setVersion((n) => n + 1), []);

  /** Duplicates a quiz and opens the copy in the studio (reconciling a lost response). */
  const duplicate = async (quiz: QuizSummary) => {
    setNotice(null);
    const key = crypto.randomUUID();
    try {
      const { data } = await api.request({
        method: "POST",
        path: `/quizzes/${quiz.id}/duplicate`,
        body: {},
        schema: quizDetailSchema,
        idempotencyKey: key,
      });
      invalidate();
      navigate(`/studio/${data.id}`);
    } catch (error) {
      if (error instanceof ApiError && !error.uncertain) {
        setNotice(t("common.inventory.b01.error"));
        return;
      }
      const outcome = await api.reconcileOperation(key, "quiz.duplicate").catch(() => null);
      if (outcome?.status === "done" && outcome.resourceId) {
        invalidate();
        navigate(`/studio/${outcome.resourceId}`);
      } else setNotice(t("auth.recovery.uncertainRequest"));
    }
  };

  const confirmDelete = useConfirmAction({
    run: async () => {
      if (!deleting) return;
      await api.request({
        method: "DELETE",
        path: `/quizzes/${deleting.id}`,
        schema: quizDeletedSchema,
        ifMatch: deleting.revision,
      });
    },
    reconcile: async () => {
      if (!deleting) return "unknown";
      try {
        await api.request({ path: `/quizzes/${deleting.id}`, schema: quizDetailSchema });
        return "not-done";
      } catch (error) {
        return error instanceof ApiError && error.code === "NOT_FOUND" ? "done" : "unknown";
      }
    },
    onDone: invalidate,
  });

  /** Opens M06 for playable quizzes; invalid drafts go to their problem summary. */
  const host = (quiz: QuizSummary) => {
    if (!quiz.isPlayable || quiz.questionCount === 0) {
      navigate(`/dashboard/quizzes/${quiz.id}`);
      return;
    }
    setHostQuiz(quiz);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    onQueryChange({ ...query, search: searchText.trim().slice(0, MAX_SEARCH), page: 1 });
  };

  const items = state.status === "ready" ? state.items : [];
  const searching = query.search !== "";

  let body;
  if (state.status === "loading")
    body = (
      <ul aria-busy="true" className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <li key={index}>
            <ContentCard state="loading" />
          </li>
        ))}
        <li className="sr-only">
          <SkeletonBlock label={t("quizzes.inventory.s05.loading")} count={1} />
        </li>
      </ul>
    );
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("quizzes.inventory.s05.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: invalidate }}
      />
    );
  else if (items.length === 0)
    body = searching ? (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-6">
        <p role="status">{t("quizzes.library.noMatches")}</p>
        <ActionButton
          variant="secondary"
          label={t("common.actions.clearSearch")}
          onPress={() => onQueryChange({ ...query, search: "", page: 1 })}
        />
      </div>
    ) : (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-6">
        <p role="status">
          {query.scope === "own"
            ? t("quizzes.inventory.s05.empty")
            : t("quizzes.library.noQuizzes")}
        </p>
        {query.scope === "own" && (
          <ActionButton
            icon={<Plus />}
            label={t("quizzes.library.create")}
            onPress={() => setCreateOpen(true)}
          />
        )}
      </div>
    );
  else
    body = (
      <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {items.map((quiz) => {
          const menu = [
            ...(quiz.capabilities.canDuplicate
              ? [{ id: "duplicate", label: t("quizzes.detail.duplicate") }]
              : []),
            ...(quiz.capabilities.canDelete
              ? [{ id: "delete", label: t("quizzes.detail.delete"), destructive: true }]
              : []),
          ];
          return (
            <li key={quiz.id} className="min-w-0">
              <ContentCard
                heading={quiz.title}
                href={`/dashboard/quizzes/${quiz.id}`}
                media={quiz.coverMedia?.publicUrl ? { src: quiz.coverMedia.publicUrl } : null}
                metadata={[
                  {
                    label: t("quizzes.detail.questions"),
                    value: t("quizzes.detail.questionCount", { count: quiz.questionCount }),
                  },
                  {
                    label: t("quizzes.metadata.visibility"),
                    value:
                      quiz.visibility === "PUBLIC"
                        ? t("common.visibility.public")
                        : t("common.visibility.private"),
                  },
                  {
                    label: t("common.status.saved"),
                    value: formatDate(quiz.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
                  },
                  ...(query.scope === "public"
                    ? [{ label: t("quizzes.detail.owner"), value: quiz.creatorName }]
                    : []),
                ]}
                badges={
                  !quiz.isPlayable ? (
                    <p className="text-caption text-warning">{t("quizzes.detail.invalidDraft")}</p>
                  ) : !quiz.capabilities.canEdit ? (
                    <p className="text-caption text-muted-foreground">
                      {t("common.visibility.readOnly")}
                    </p>
                  ) : null
                }
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    {quiz.capabilities.canHost && (
                      <ActionButton
                        size="md"
                        label={t("quizzes.detail.host")}
                        accessibleName={`${t("quizzes.detail.host")}: ${quiz.title}`}
                        onPress={() => host(quiz)}
                      />
                    )}
                    {quiz.capabilities.canEdit && (
                      <Link
                        href={`/studio/${quiz.id}`}
                        aria-label={`${t("quizzes.detail.edit")}: ${quiz.title}`}
                        className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-label font-semibold hover:bg-subtle"
                      >
                        {t("quizzes.detail.edit")}
                      </Link>
                    )}
                    {menu.length > 0 && (
                      <MenuPopover
                        iconOnly
                        triggerIcon={<MoreHorizontal aria-hidden="true" className="size-5" />}
                        triggerLabel={`${t("quizzes.inventory.f02.title")}: ${quiz.title}`}
                        items={menu}
                        onAction={(id) => {
                          if (id === "duplicate") void duplicate(quiz);
                          if (id === "delete") {
                            setDeleting(quiz);
                            confirmDelete.request();
                          }
                        }}
                      />
                    )}
                  </div>
                }
              />
            </li>
          );
        })}
      </ul>
    );

  const totalPages = state.status === "ready" ? state.totalPages : 0;

  return (
    <section aria-labelledby={`${searchId}-title`} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id={`${searchId}-title`} className="text-title font-bold">
          {t("quizzes.library.title")}
        </h1>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            variant="secondary"
            icon={<Upload />}
            label={t("quizzes.library.import")}
            disabled={!onImport}
            onPress={() => onImport?.()}
          />
          <ActionButton
            icon={<Plus />}
            label={t("quizzes.library.create")}
            onPress={() => setCreateOpen(true)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <ChoiceGroup
          mode="tabs"
          label={t("quizzes.library.title")}
          hideLabel
          items={[
            { id: "own", label: t("quizzes.library.own") },
            { id: "public", label: t("quizzes.library.public") },
          ]}
          selected={query.scope}
          onSelect={(id) =>
            onQueryChange({ ...query, scope: id === "public" ? "public" : "own", page: 1 })
          }
        />
        <div className="flex w-full flex-wrap items-end gap-2 md:w-auto">
          <form
            role="search"
            onSubmit={submitSearch}
            className="flex w-full items-end gap-2 sm:w-auto"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={searchId} className="text-label font-semibold">
                {t("quizzes.library.search")}
              </label>
              <input
                id={searchId}
                type="search"
                value={searchText}
                maxLength={MAX_SEARCH}
                onChange={(event) => setSearchText(event.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body sm:w-64"
              />
            </div>
            <ActionButton type="submit" variant="secondary" label={t("common.actions.search")} />
          </form>
          <label className="flex flex-col gap-1 text-label font-semibold">
            <span className="sr-only">{t("common.actions.select")}</span>
            <select
              value={query.sort}
              aria-label={t("quizzes.library.sortUpdated")}
              onChange={(event) =>
                onQueryChange({
                  ...query,
                  sort: event.target.value === "title_asc" ? "title_asc" : "updated_desc",
                  page: 1,
                })
              }
              className="min-h-11 rounded-md border border-input bg-background px-3 text-body font-normal"
            >
              <option value="updated_desc">{t("quizzes.library.sortUpdated")}</option>
              <option value="title_asc">{t("quizzes.library.sortTitle")}</option>
            </select>
          </label>
        </div>
      </div>
      {notice && <StatusNotice tone="error" message={notice} onDismiss={() => setNotice(null)} />}
      {state.status === "ready" && state.stale && (
        <StatusNotice
          tone="warning"
          message={t("common.status.stale")}
          action={{ label: t("common.actions.retry"), onAction: invalidate }}
        />
      )}
      {query.scope === "public" && state.status === "ready" && items.length > 0 && (
        <p className="text-small text-muted-foreground">{t("quizzes.detail.publicReadOnly")}</p>
      )}
      {body}
      {state.status === "ready" && totalPages > 1 && (
        <nav
          aria-label={t("common.pagination.label")}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <ActionButton
            variant="secondary"
            label={t("common.pagination.previous")}
            disabled={query.page <= 1}
            onPress={() => onQueryChange({ ...query, page: query.page - 1 })}
          />
          <span aria-current="page" className="text-label tabular-nums">
            {t("common.pagination.pageOf", { page: query.page, totalPages })}
          </span>
          <ActionButton
            variant="secondary"
            label={t("common.pagination.next")}
            disabled={query.page >= totalPages}
            onPress={() => onQueryChange({ ...query, page: query.page + 1 })}
          />
        </nav>
      )}
      <QuizSettingsModal
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onCreated={(quiz) => {
          setCreateOpen(false);
          invalidate();
          navigate(`/studio/${quiz.id}`);
        }}
      />
      {hostQuiz && (
        <HostConfigDialog
          open
          onClose={() => setHostQuiz(null)}
          quiz={hostQuiz}
          createRoom={roomCreator}
          onCreated={(room: CreatedRoom) => {
            setHostQuiz(null);
            navigate(`/host/${room.sessionId}`);
          }}
        />
      )}
      <ConfirmDialog
        controller={confirmDelete}
        impact={t("common.confirm.deleteQuiz")}
        targetName={deleting?.title ?? null}
        confirmLabel={t("quizzes.detail.delete")}
      />
    </section>
  );
}

/** Route wrapper: query from the URL parameters, changes pushed back into the URL. */
export function QuizLibraryRoute({ params }: { params: RawLibraryParams }) {
  const router = useRouter();
  const query = parseLibraryQuery(params);
  return (
    <QuizLibrary
      query={query}
      onQueryChange={(next) => router.push(libraryHref(next))}
      navigate={(href) => router.push(href)}
    />
  );
}
