/**
 * TASK-138 coverage for the S05 quiz library against a scripted fake API:
 * - the five states:
 *   - loading skeleton;
 *   - ideal cards with capability-based controls;
 *   - empty (no quizzes vs. no search matches with Clear search);
 *   - error with retry;
 *   - partial (a failed refresh keeps the previous list, marked possibly out of date);
 * - own vs. public permission controls (no Edit/Delete on read-only public quizzes, owner shown);
 * - invalid drafts host into their detail page;
 * - safe delete through M09 with `If-Match` (success invalidates the list; a revision conflict is
 *   never a success);
 * - stale list responses dropped;
 * - pagination in the URL query, with an out-of-range page clamped;
 * - duplicate opens the copy;
 * - Host opens M06 and then the host stage;
 * - URL helpers.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import {
  QuizLibrary,
  libraryHref,
  parseLibraryQuery,
  type LibraryQuery,
  type QuizLibraryProps,
} from "./quiz-library-detail";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/quizzes",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = ["common", "accessibility", "quizzes", "host", "validation", "auth"] as const;
const OWN: LibraryQuery = { scope: "own", page: 1, search: "", sort: "updated_desc" };
const ME = "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** Quiz summary fixture. */
function quiz(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    creatorId: ME,
    creatorName: "Ayu",
    title: `Kuis ${n}`,
    description: null,
    coverMedia: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    revision: 3,
    questionCount: 3,
    isPlayable: true,
    updatedAt: 1_790_000_000_000,
    capabilities: {
      canEdit: true,
      canDelete: true,
      canDuplicate: true,
      canHost: true,
      canExport: true,
    },
    ...overrides,
  };
}

/** Page response. */
function page(items: unknown[], total = items.length, pageNumber = 1) {
  return json(200, {
    items,
    meta: { page: pageNumber, limit: 12, total, totalPages: Math.ceil(total / 12) },
  });
}

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Error envelope. */
function failure(status: number, errorCode: string) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params: {},
    details: [],
    correlationId: CORRELATION,
  });
}

/** One recorded request. */
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
}

/** Scripted API: handler per call; records every request. */
function fakeApi(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call);
  });
  return {
    calls,
    fetchMock,
    lists: () => calls.filter((call) => call.path === "/quizzes" && call.method === "GET"),
  };
}

/** Renders the library (rerender keeps the providers). */
function renderLibrary(api: ReturnType<typeof fakeApi>, props: Partial<QuizLibraryProps> = {}) {
  const onQueryChange = vi.fn();
  const navigate = vi.fn();
  const store = createThemePreferenceStore({ storage: () => null });
  const wrap = (node: ReactElement) => (
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={api.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        {node}
      </AuthProvider>
    </ThemeProvider>
  );
  const element = (query: LibraryQuery) => (
    <QuizLibrary query={query} onQueryChange={onQueryChange} navigate={navigate} {...props} />
  );
  const view = renderWithLocale(wrap(element(props.query ?? OWN)), { namespaces: [...NAMESPACES] });
  return {
    ...view,
    onQueryChange,
    navigate,
    setQuery: (query: LibraryQuery) => view.rerender(wrap(element(query))),
  };
}

/** Deferred response helper. */
function deferred() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("QuizLibrary", () => {
  it("shows a skeleton, then cards with the owner's controls and the 12-per-page query", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const api = fakeApi(() => gate.promise);
    renderLibrary(api);
    expect(screen.getByRole("heading", { level: 1, name: "Quizzes" })).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () =>
      gate.resolve(page([quiz(1), quiz(2, { visibility: "PUBLIC", questionCount: 1 })])),
    );
    const first = screen.getByRole("link", { name: "Kuis 1" }).closest("article") ?? document.body;
    expect(screen.getByRole("link", { name: "Kuis 1" })).toHaveAttribute(
      "href",
      `/dashboard/quizzes/${quiz(1).id}`,
    );
    expect(within(first as HTMLElement).getByText("3 questions")).toBeInTheDocument();
    expect(screen.getByText("1 question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Host a game: Kuis 1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit quiz: Kuis 1" })).toHaveAttribute(
      "href",
      `/studio/${quiz(1).id}`,
    );
    await user.click(screen.getByRole("button", { name: "Quiz actions: Kuis 1" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Duplicate quiz", "Delete quiz"]);
    const list = api.lists()[0];
    expect(Object.fromEntries(list?.query ?? [])).toEqual({
      page: "1",
      limit: "12",
      scope: "own",
      sort: "updated_desc",
    });
  });

  it("keeps public quizzes of other creators read-only and sends invalid drafts to their problems", async () => {
    const user = userEvent.setup();
    const readOnly = {
      canEdit: false,
      canDelete: false,
      canDuplicate: true,
      canHost: true,
      canExport: true,
    };
    const api = fakeApi(() =>
      page([
        quiz(3, { creatorName: "Budi", visibility: "PUBLIC", capabilities: readOnly }),
        quiz(4, {
          creatorName: "Citra",
          visibility: "PUBLIC",
          isPlayable: false,
          capabilities: readOnly,
        }),
      ]),
    );
    const { navigate } = renderLibrary(api, { query: { ...OWN, scope: "public" } });
    await screen.findByRole("link", { name: "Kuis 3" });
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Edit quiz/u })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This public quiz belongs to another creator. You can view, duplicate or host it, but not edit it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This draft has problems that must be fixed before you can host it."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quiz actions: Kuis 3" }));
    expect(
      within(await screen.findByRole("menu"))
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Duplicate quiz"]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Host a game: Kuis 4" }));
    expect(navigate).toHaveBeenCalledWith(`/dashboard/quizzes/${quiz(4).id}`);
    expect(screen.queryByRole("dialog", { name: "Host a game" })).not.toBeInTheDocument();
    expect(api.lists()[0]?.query.get("scope")).toBe("public");
  });

  it("separates an empty library, an empty search and a failed load", async () => {
    const user = userEvent.setup();
    const empty = renderLibrary(fakeApi(() => page([])));
    expect(
      await screen.findByText(
        "You don't have any quizzes yet. Create or import one to get started.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create quiz" }).length).toBeGreaterThan(1);
    empty.unmount();

    const search = renderLibrary(
      fakeApi(() => page([])),
      { query: { ...OWN, search: "zzz" } },
    );
    expect(await screen.findByText("No quizzes match your search.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search.onQueryChange).toHaveBeenCalledWith({ ...OWN, search: "", page: 1 });
    search.unmount();

    let fail = true;
    const api = fakeApi(() => (fail ? failure(500, "INTERNAL_ERROR") : page([quiz(1)])));
    renderLibrary(api);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your quizzes couldn't load. Try again.");
    expect(alert).toHaveTextContent(`Reference ID: ${CORRELATION}`);
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Kuis 1" })).toBeInTheDocument();
  });

  it("deletes with the card revision, invalidates the list and never reports a conflict as success", async () => {
    const user = userEvent.setup();
    let deleted = false;
    let refreshFails = false;
    const api = fakeApi((call) => {
      if (call.method === "DELETE") {
        if (call.path.endsWith(quiz(2).id) && !refreshFails)
          return failure(409, "REVISION_CONFLICT");
        deleted = true;
        return json(200, { deleted: true });
      }
      if (refreshFails) return failure(503, "DEPENDENCY_UNAVAILABLE");
      return page(deleted ? [quiz(2)] : [quiz(1), quiz(2)]);
    });
    renderLibrary(api);
    await user.click(await screen.findByRole("button", { name: "Quiz actions: Kuis 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete quiz" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm action" });
    expect(within(dialog).getByText("Affected item: Kuis 1")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete quiz" }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Kuis 1" })).not.toBeInTheDocument(),
    );
    const del = api.calls.find((call) => call.method === "DELETE");
    expect(del?.headers.get("If-Match")).toBe('"3"');
    expect(api.lists()).toHaveLength(2);

    // A revision conflict: blocked with the reason, the quiz stays.
    await user.click(screen.getByRole("button", { name: "Quiz actions: Kuis 2" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete quiz" }));
    const conflict = await screen.findByRole("dialog");
    await user.click(within(conflict).getByRole("button", { name: "Delete quiz" }));
    expect(await within(conflict).findByRole("alert")).toHaveTextContent(
      "This action isn't allowed right now.",
    );
    await user.click(within(conflict).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("link", { name: "Kuis 2" })).toBeInTheDocument();

    // A successful delete whose list refresh fails keeps the previous list, marked possibly out
    // of date (partial).
    refreshFails = true;
    await user.click(screen.getByRole("button", { name: "Quiz actions: Kuis 2" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete quiz" }));
    const again = await screen.findByRole("dialog");
    await user.click(within(again).getByRole("button", { name: "Delete quiz" }));
    expect(await screen.findByText("May be out of date")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kuis 2" })).toBeInTheDocument();
  });

  it("drops stale list responses when the query changes", async () => {
    const own = deferred();
    const pub = deferred();
    const api = fakeApi((call) =>
      call.query.get("scope") === "public" ? pub.promise : own.promise,
    );
    const { setQuery } = renderLibrary(api);
    setQuery({ ...OWN, scope: "public" });
    await act(async () => pub.resolve(page([quiz(7, { title: "Publik Baru" })])));
    expect(await screen.findByRole("link", { name: "Publik Baru" })).toBeInTheDocument();
    await act(async () => own.resolve(page([quiz(8, { title: "Lama Milik Saya" })])));
    expect(screen.queryByRole("link", { name: "Lama Milik Saya" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Publik Baru" })).toBeInTheDocument();
  });

  it("paginates through the URL query and clamps a page past the end", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 12 }, (_, index) => quiz(index + 1));
    const first = renderLibrary(fakeApi(() => page(items, 30)));
    const nav = await screen.findByRole("navigation", { name: "Pagination" });
    expect(within(nav).getByText("Page 1 of 3")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(within(nav).getByRole("button", { name: "Next page" }));
    expect(first.onQueryChange).toHaveBeenCalledWith({ ...OWN, page: 2 });
    first.unmount();

    const past = renderLibrary(
      fakeApi(() => page([], 30, 5)),
      { query: { ...OWN, page: 5 } },
    );
    await waitFor(() => expect(past.onQueryChange).toHaveBeenCalledWith({ ...OWN, page: 3 }));
  });

  it("duplicates into a new studio and hosts a playable quiz through M06", async () => {
    const user = userEvent.setup();
    const copy = {
      ...quiz(9, { title: "Kuis 1 (copy)", questionCount: 1, isPlayable: false }),
      createdAt: 1,
      questions: [{ ...blankQuestion(), orderIndex: 0 }],
      media: [],
      validationIssues: [],
    };
    const api = fakeApi((call) =>
      call.method === "POST" && call.path.endsWith("/duplicate")
        ? json(201, copy)
        : page([quiz(1)]),
    );
    const createRoom = vi.fn(async (request: { requestId: string }) => ({
      status: "ok" as const,
      requestId: request.requestId,
      serverTime: 1,
      data: {
        pinCode: "012345",
        sessionId: "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b",
        phaseVersion: 1 as const,
      },
    }));
    const { navigate } = renderLibrary(api, { createRoom });
    await user.click(await screen.findByRole("button", { name: "Quiz actions: Kuis 1" }));
    await user.click(await screen.findByRole("menuitem", { name: "Duplicate quiz" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/studio/${copy.id}`));
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);

    await user.click(screen.getByRole("button", { name: "Host a game: Kuis 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Host a game" });
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/host/3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b"),
    );
    expect(createRoom.mock.calls[0]?.[0]).toMatchObject({ quizId: quiz(1).id, quizRevision: 3 });
  });

  it("parses and writes the URL query", () => {
    expect(parseLibraryQuery({})).toEqual(OWN);
    expect(
      parseLibraryQuery({ scope: "public", page: "3", search: "sejarah", sort: "title_asc" }),
    ).toEqual({
      scope: "public",
      page: 3,
      search: "sejarah",
      sort: "title_asc",
    });
    expect(parseLibraryQuery({ scope: "admin", page: "-2", sort: "x" })).toEqual(OWN);
    expect(parseLibraryQuery({ page: "abc", search: "x".repeat(300) }).search).toHaveLength(100);
    expect(libraryHref(OWN)).toBe("/dashboard/quizzes");
    expect(libraryHref({ scope: "public", page: 2, search: "a b", sort: "title_asc" })).toBe(
      "/dashboard/quizzes?scope=public&search=a+b&sort=title_asc&page=2",
    );
  });
});
