/**
 * TASK-161 coverage for S09 (host report history) against a scripted API.
 * - L/E/I/P/X:
 *   - loading skeleton;
 *   - empty: no finished games (link back to quizzes) vs. no matches (clear filters);
 *   - ideal: snapshot title, end date with time zone, player count, end reason badges;
 *   - partial: failed refresh keeps rows as older data;
 *   - error: fetch failure with Retry, never shown as "no reports".
 * - Query: 15 per page, newest first, search and quiz filter in the request; pagination; a page
 *   beyond the end moves back to the last page; a slow earlier response never overwrites a newer
 *   one (and is aborted).
 * - Auth: an expired token is refreshed once and the list loads; a 404 shows the error safely.
 * - URL helpers clamp and omit defaults; a foreign quiz id stays a visible filter choice.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import { ReportList, parseReportsQuery, reportsHref, type ReportsQuery } from "./report-list";

const NAMESPACES = [
  "common",
  "accessibility",
  "reports",
  "quizzes",
  "validation",
  "media",
] as const;
const ME = "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const QUIZ = "20000000-0000-4000-8000-000000000001";
const ENDED = Date.UTC(2026, 10, 1, 14, 30);
const LONG_TITLE = `Kuis sejarah ${"panjang ".repeat(14)}`.trim();

/** Ready session fixture. */
function session(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    quizId: QUIZ,
    quizTitle: `Kuis ${n}`,
    hostId: ME,
    pinCode: "123456",
    displayMode: "PROJECTOR",
    endReason: "COMPLETED",
    totalPlayers: n * 3,
    startedAt: ENDED - 600_000,
    endedAt: ENDED,
    status: "ready",
    ...overrides,
  };
}

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Page response with an explicit total. */
function page(items: unknown[], total = items.length, pageNumber = 1) {
  return json(200, {
    items,
    meta: { page: pageNumber, limit: 15, total, totalPages: Math.ceil(total / 15) },
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
    correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
  });
}

/** One recorded request. */
interface Call {
  path: string;
  query: URLSearchParams;
  signal: AbortSignal | null;
}

/** Own quiz page for the filter. */
const QUIZZES = page(
  [
    {
      id: QUIZ,
      creatorId: ME,
      creatorName: "Ayu",
      title: "Kuis Sejarah",
      description: null,
      coverMedia: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      revision: 2,
      questionCount: 3,
      isPlayable: true,
      updatedAt: ENDED,
      capabilities: {
        canEdit: true,
        canDelete: true,
        canDuplicate: true,
        canHost: true,
        canExport: true,
      },
    },
  ],
  1,
);

/** Scripted API: `reports` answers `/reports`, quizzes answer from the fixture. */
function fakeApi(reports: (call: Call) => Response | Promise<Response>, quizzes = QUIZZES) {
  const calls: Call[] = [];
  let refreshes = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    if (call.path === "/auth/refresh") {
      refreshes += 1;
      return json(200, { accessToken: `access-${refreshes}`, expiresIn: 900 });
    }
    if (call.path === "/auth/me")
      return json(200, {
        id: ME,
        email: "ayu@example.com",
        name: "Ayu",
        role: "CREATOR",
        avatar: { style: "bottts", seed: "ayu" },
        isActive: true,
        revision: 1,
        createdAt: ENDED,
      });
    if (call.path === "/quizzes") return quizzes.clone();
    return reports(call);
  });
  return { calls, fetchMock, reportCalls: () => calls.filter((c) => c.path === "/reports") };
}

/** Starts the session like the dashboard shell does. */
function Session({ children }: { children: ReactNode }) {
  const { ensureSession, status } = useAuth();
  useEffect(() => {
    void ensureSession();
  }, [ensureSession]);
  return status === "authenticated" ? <>{children}</> : null;
}

/** The list with URL-like query state; `onQuery` sees every navigation. */
function Harness({
  initial,
  onQuery,
}: {
  initial: ReportsQuery;
  onQuery?: (query: ReportsQuery) => void;
}) {
  const [query, setQuery] = useState(initial);
  return (
    <ReportList
      query={query}
      onQueryChange={(next) => {
        onQuery?.(next);
        setQuery(next);
      }}
    />
  );
}

/** Renders the list inside the providers. */
function renderList(
  api: ReturnType<typeof fakeApi>,
  initial: ReportsQuery = { page: 1, search: "", quizId: null },
  onQuery?: (query: ReportsQuery) => void,
) {
  const store = createThemePreferenceStore({ storage: () => null });
  return renderWithLocale(
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={api.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        <Session>
          <Harness initial={initial} {...(onQuery ? { onQuery } : {})} />
        </Session>
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
}

describe("report list URL helpers", () => {
  it("clamps bad values and omits defaults", () => {
    expect(parseReportsQuery({ page: "-3", search: "x".repeat(150), quizId: "nope" })).toEqual({
      page: 1,
      search: "x".repeat(100),
      quizId: null,
    });
    expect(parseReportsQuery({ page: "4", quizId: QUIZ })).toEqual({
      page: 4,
      search: "",
      quizId: QUIZ,
    });
    expect(reportsHref({ page: 1, search: "", quizId: null })).toBe("/dashboard/reports");
    expect(reportsHref({ page: 2, search: "neko", quizId: QUIZ })).toBe(
      `/dashboard/reports?quizId=${QUIZ}&search=neko&page=2`,
    );
  });
});

describe("ReportList", () => {
  it("loads, then shows snapshot titles, time zone, players and end reasons", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = fakeApi(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    renderList(api);
    expect(await screen.findByText("Loading results…")).toBeInTheDocument();
    release(
      page([
        session(1, { quizTitle: LONG_TITLE, quizId: null }),
        session(2, { endReason: "HOST_ENDED" }),
        session(3, { endReason: "EXPIRED" }),
      ]),
    );
    const [link] = await screen.findAllByRole("link", { name: LONG_TITLE });
    expect(link).toHaveAttribute("href", `/dashboard/reports/${session(1).id}`);
    expect(link?.className).toContain("break-words");
    expect(screen.getAllByText(/Ended Nov 1, 2026 at 2:30\s?PM \(UTC\)/u).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Ended early by the host").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ended because the room expired").length).toBeGreaterThan(0);
    expect(screen.getAllByText("9").length).toBeGreaterThan(0);
    const request = api.reportCalls()[0]?.query;
    expect(request?.get("limit")).toBe("15");
    expect(request?.get("sort")).toBe("ended_desc");
    expect(request?.get("page")).toBe("1");
    expect(await screen.findByRole("option", { name: "Kuis Sejarah" })).toBeInTheDocument();
  });

  it("tells no finished games apart from no matches, and clears filters", async () => {
    const user = userEvent.setup();
    const api = fakeApi(() => page([]));
    renderList(api);
    expect(
      await screen.findByText("No finished games yet. Go back to your quizzes to host one."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Quizzes" })).toHaveAttribute(
      "href",
      "/dashboard/quizzes",
    );
    await user.type(screen.getByLabelText(/^Search reports/u), "zzz");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No reports yet.")).toBeInTheDocument();
    expect(api.reportCalls().at(-1)?.query.get("search")).toBe("zzz");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      await screen.findByText("No finished games yet. Go back to your quizzes to host one."),
    ).toBeInTheDocument();
    expect(api.reportCalls().at(-1)?.query.get("search")).toBeNull();
  });

  it("shows a fetch failure with Retry (never as no reports), then keeps older data", async () => {
    const user = userEvent.setup();
    const answers = [
      failure(503, "DEPENDENCY_UNAVAILABLE"),
      page([session(1)], 16),
      failure(503, "DEPENDENCY_UNAVAILABLE"),
    ];
    const api = fakeApi(() => answers.shift() ?? page([]));
    renderList(api);
    expect(await screen.findByText("Your reports couldn't load. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/No finished games yet/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByRole("link", { name: "Kuis 1" })).length).toBeGreaterThan(0);
    // Next page fails: the current rows stay, marked as older data.
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      await screen.findByText("This list couldn't be refreshed. You're seeing older data."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Kuis 1" }).length).toBeGreaterThan(0);
  });

  it("paginates and moves back from a page beyond the end", async () => {
    const user = userEvent.setup();
    const seen: ReportsQuery[] = [];
    const api = fakeApi((call) => {
      const requested = Number(call.query.get("page"));
      return requested > 3 ? page([], 31, requested) : page([session(requested)], 31, requested);
    });
    renderList(api, { page: 9, search: "", quizId: QUIZ }, (query) => seen.push(query));
    expect((await screen.findAllByRole("link", { name: "Kuis 3" })).length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ page: 3, search: "", quizId: QUIZ });
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(api.reportCalls()[0]?.query.get("quizId")).toBe(QUIZ);
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect((await screen.findAllByRole("link", { name: "Kuis 2" })).length).toBeGreaterThan(0);
    expect(api.reportCalls().at(-1)?.query.get("page")).toBe("2");
  });

  it("applies only the latest of overlapping searches and aborts the older one", async () => {
    const user = userEvent.setup();
    let slow: (response: Response) => void = () => undefined;
    const api = fakeApi((call) => {
      const search = call.query.get("search");
      if (search === "lama")
        return new Promise<Response>((resolve) => {
          slow = resolve;
        });
      return page([session(search === "baru" ? 2 : 1)]);
    });
    renderList(api);
    expect((await screen.findAllByRole("link", { name: "Kuis 1" })).length).toBeGreaterThan(0);
    const box = screen.getByLabelText(/^Search reports/u);
    await user.type(box, "lama");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.reportCalls().at(-1)?.query.get("search")).toBe("lama"));
    const older = api.reportCalls().at(-1);
    await user.clear(box);
    await user.type(box, "baru");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findAllByRole("link", { name: "Kuis 2" })).length).toBeGreaterThan(0);
    expect(older?.signal?.aborted).toBe(true);
    slow(page([session(9)]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryAllByRole("link", { name: "Kuis 9" })).toHaveLength(0);
    expect(screen.getAllByRole("link", { name: "Kuis 2" }).length).toBeGreaterThan(0);
  });

  it("refreshes an expired token once, shows a 404 safely and keeps a foreign quiz filter", async () => {
    const answers = [failure(401, "TOKEN_EXPIRED"), page([session(1)])];
    const api = fakeApi(() => answers.shift() ?? page([]));
    const view = renderList(api);
    expect((await screen.findAllByRole("link", { name: "Kuis 1" })).length).toBeGreaterThan(0);
    expect(api.calls.filter((call) => call.path === "/auth/refresh")).toHaveLength(2);
    view.unmount();

    const foreign = "40000000-0000-4000-8000-000000000009";
    const missing = fakeApi(() => failure(404, "NOT_FOUND"));
    renderList(missing, { page: 1, search: "", quizId: foreign });
    expect(await screen.findByText("Your reports couldn't load. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: foreign })).toBeInTheDocument();
    expect((screen.getByLabelText(/^Filter by quiz/u) as HTMLSelectElement).value).toBe(foreign);
  });
});
