/**
 * TASK-125 coverage for the auth provider and the cross-tab refresh coordinator, against a fake
 * API that rotates the shared refresh cookie and revokes the family when a consumed token is
 * replayed: parallel tabs refresh once (Web Locks and the lease fallback) while uncoordinated tabs
 * would be revoked; a revoked/consumed refresh never loops; a lost session keeps the page mounted
 * but inert; a deactivated user (401 on /auth/me) and anonymous visitors never see protected
 * content; sign-out ends every tab; the access token never touches storage; unsafe `returnTo`
 * values fall back to the dashboard.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createRefreshCoordinator,
  type ChannelLike,
  type LocksLike,
  type RefreshOutcome,
} from "@/lib/refresh-coordinator";
import { testInitialLocale } from "@/test/locale";
import { LocaleProvider, createLocalePreferences } from "./locale-provider";
import {
  AuthProvider,
  DEFAULT_RETURN_TO,
  RequireAuth,
  safeReturnTo,
  useAuth,
  type AuthContextValue,
} from "./auth-provider";

const BASE = "http://api.test/api/v1";
const USER = {
  id: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
  email: "ayu@example.com",
  name: "Ayu",
  role: "CREATOR",
  avatar: { style: "bottts", seed: "ayu" },
  isActive: true,
  revision: 1,
  createdAt: 1,
};
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** Error envelope response. */
function failure(status: number, errorCode: string) {
  return new Response(
    JSON.stringify({
      statusCode: status,
      errorCode,
      message: "x",
      params: {},
      details: [],
      correlationId: CORRELATION,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
/** JSON response. */
function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Fake API with one browser cookie jar: refresh rotates the cookie; replaying a consumed cookie
 * revokes the family (every later refresh fails).
 */
function fakeServer(
  options: { meStatus?: number; latencyMs?: number; meTransientFailures?: number } = {},
) {
  let transient = options.meTransientFailures ?? 0;
  const jar = { cookie: "r1" as string | null };
  const consumed = new Set<string>();
  let revoked = false;
  let issued = 0;
  const log: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    log.push(path);
    if (path === "/auth/refresh") {
      const sent = jar.cookie;
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs ?? 5));
      if (sent === null) return failure(401, "AUTH_REQUIRED");
      if (revoked || consumed.has(sent)) {
        revoked = true;
        return failure(401, "TOKEN_REVOKED");
      }
      consumed.add(sent);
      issued += 1;
      jar.cookie = `r${issued + 1}`;
      return ok({ accessToken: `access-${issued}`, expiresIn: 900 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (path === "/auth/me") {
      if (options.meStatus) return failure(options.meStatus, "AUTH_REQUIRED");
      if (transient > 0) {
        transient -= 1;
        return failure(503, "DEPENDENCY_UNAVAILABLE");
      }
      return auth ? ok(USER) : failure(401, "AUTH_REQUIRED");
    }
    if (path === "/auth/logout") {
      jar.cookie = null;
      return ok({ success: true });
    }
    if (path === "/quizzes")
      return auth === `Bearer access-${issued}` && !revoked
        ? ok({ items: [] })
        : failure(401, "TOKEN_EXPIRED");
    return failure(404, "NOT_FOUND");
  });
  return {
    jar,
    fetchMock,
    log,
    refreshCount: () => log.filter((path) => path === "/auth/refresh").length,
    isRevoked: () => revoked,
  };
}

/** BroadcastChannel stand-in shared by fake tabs. */
function fakeBus() {
  const channels = new Set<FakeChannel>();
  class FakeChannel implements ChannelLike {
    listeners = new Set<(event: MessageEvent) => void>();
    constructor() {
      channels.add(this);
    }
    postMessage(message: unknown) {
      for (const channel of channels)
        if (channel !== this)
          for (const listener of channel.listeners)
            queueMicrotask(() => listener({ data: structuredClone(message) } as MessageEvent));
    }
    addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
      this.listeners.add(listener);
    }
    removeEventListener(_type: "message", listener: (event: MessageEvent) => void) {
      this.listeners.delete(listener);
    }
    close() {
      channels.delete(this);
    }
  }
  return () => new FakeChannel();
}

/** Web Locks stand-in: one exclusive queue shared by fake tabs. */
function fakeLocks(): LocksLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => Promise<T>) {
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** Map-backed localStorage stand-in shared by fake tabs. */
function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

/** Refresh function for a coordinator using the fake server. */
function refreshVia(server: ReturnType<typeof fakeServer>) {
  return async (): Promise<RefreshOutcome> => {
    const response = await server.fetchMock(`${BASE}/auth/refresh`, { method: "POST" });
    if (!response.ok) return { ok: false, reason: "revoked" };
    const body = (await response.json()) as { accessToken: string };
    return { ok: true, token: { accessToken: body.accessToken, expiresAt: Date.now() + 900_000 } };
  };
}

describe("refresh coordinator", () => {
  it("serializes parallel tabs with Web Locks so only one refresh hits the server", async () => {
    const server = fakeServer({ latencyMs: 20 });
    const bus = fakeBus();
    const locks = fakeLocks();
    const tabs = [0, 1, 2].map(() =>
      createRefreshCoordinator({ refresh: refreshVia(server), locks, channel: bus() }),
    );
    const results = await Promise.all(tabs.map((tab) => tab.refresh("access-0")));
    expect(server.refreshCount()).toBe(1);
    expect(results.every((result) => result.ok && result.token.accessToken === "access-1")).toBe(
      true,
    );
    expect(server.isRevoked()).toBe(false);
  });

  it("uses a bounded lease when Web Locks is missing", async () => {
    const server = fakeServer({ latencyMs: 30 });
    const bus = fakeBus();
    const storage = fakeStorage();
    const tabs = [0, 1].map(() =>
      createRefreshCoordinator({
        refresh: refreshVia(server),
        locks: null,
        channel: bus(),
        storage,
      }),
    );
    const results = await Promise.all(tabs.map((tab) => tab.refresh("access-0")));
    expect(server.refreshCount()).toBe(1);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(storage.getItem("kabuki-neko:auth-refresh-lease")).toBeNull();
  });

  it("shows why coordination matters: uncoordinated tabs replay the cookie and get revoked", async () => {
    const server = fakeServer({ latencyMs: 20 });
    await Promise.all([refreshVia(server)(), refreshVia(server)()]);
    // Both requests carried the same cookie; the second replayed a consumed token.
    expect(server.isRevoked()).toBe(true);
  });
});

/** Renders providers for one tab and captures the auth context. */
function renderTab(
  server: ReturnType<typeof fakeServer>,
  children: ReactNode,
  shared?: { channel: () => ChannelLike; locks: LocksLike },
) {
  const holder: { auth: AuthContextValue | null } = { auth: null };
  function Capture() {
    holder.auth = useAuth();
    return null;
  }
  const view = render(
    <LocaleProvider
      initial={testInitialLocale("en", ["common", "accessibility", "auth"])}
      preferences={createLocalePreferences({ storage: () => null, writeCookie: () => {} })}
    >
      <AuthProvider
        apiBaseUrl={BASE}
        fetch={server.fetchMock as unknown as typeof fetch}
        locks={shared?.locks ?? fakeLocks()}
        channel={shared ? shared.channel() : null}
        storage={null}
      >
        <Capture />
        {children}
      </AuthProvider>
    </LocaleProvider>,
  );
  return {
    ...view,
    auth: () => {
      if (holder.auth === null) throw new Error("not rendered");
      return holder.auth;
    },
  };
}

/** Protected page with local (draft) state. */
function Dashboard() {
  const [draft, setDraft] = useState("");
  return (
    <section>
      <h1>Dashboard</h1>
      <label>
        Draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
    </section>
  );
}

describe("refresh coordinator channel lifecycle", () => {
  it("keeps a successful refresh when broadcasting fails and reopens a factory channel", async () => {
    const token = { accessToken: "access-1", expiresAt: Date.now() + 900_000 };
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, token }));
    // A channel that throws once closed, like a real BroadcastChannel.
    const opened: { posted: unknown[]; closed: boolean }[] = [];
    const factory = () => {
      const state = { posted: [] as unknown[], closed: false };
      opened.push(state);
      return {
        postMessage(message: unknown) {
          if (state.closed) throw new DOMException("closed", "InvalidStateError");
          state.posted.push(message);
        },
        addEventListener() {},
        removeEventListener() {},
        close() {
          state.closed = true;
        },
      } satisfies ChannelLike;
    };
    const coordinator = createRefreshCoordinator({
      refresh,
      locks: null,
      channel: factory,
      storage: null,
    });
    // StrictMode-style effect cleanup and re-run.
    coordinator.close();
    coordinator.reopen();
    await expect(coordinator.refresh(null)).resolves.toEqual({ ok: true, token });
    expect(opened).toHaveLength(2);
    expect(opened[0]?.posted).toEqual([]);
    expect(opened[1]?.posted).toEqual([{ type: "token", token }]);

    // A plain (non-factory) channel that was closed only loses the broadcast.
    const broken = factory();
    broken.close();
    const plain = createRefreshCoordinator({
      refresh,
      locks: null,
      channel: broken,
      storage: null,
    });
    await expect(plain.refresh(null)).resolves.toEqual({ ok: true, token });
    expect(() => plain.share(token)).not.toThrow();
    expect(() => plain.announceLogout()).not.toThrow();
  });
});

describe("AuthProvider", () => {
  it("hides protected content until the lazy check succeeds and keeps the token in memory only", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const server = fakeServer();
    renderTab(
      server,
      <RequireAuth fallback={<p>Please sign in</p>} reauthPrompt={<p>Sign in again</p>}>
        <Dashboard />
      </RequireAuth>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(server.log).toEqual(["/auth/refresh", "/auth/me"]);
    for (const [, value] of setItem.mock.calls) expect(String(value)).not.toContain("access-");
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("access-");
  });

  it("never shows protected content to anonymous visitors or deactivated users", async () => {
    const anonymous = fakeServer();
    anonymous.jar.cookie = null;
    const first = renderTab(
      anonymous,
      <RequireAuth fallback={<p>Please sign in</p>} reauthPrompt={null}>
        <Dashboard />
      </RequireAuth>,
    );
    expect(await screen.findByText("Please sign in")).toBeInTheDocument();
    expect(first.auth().status).toBe("anonymous");
    first.unmount();

    const inactive = fakeServer({ meStatus: 401 });
    const second = renderTab(
      inactive,
      <RequireAuth fallback={<p>Please sign in</p>} reauthPrompt={null}>
        <Dashboard />
      </RequireAuth>,
    );
    expect(await screen.findByText("Please sign in")).toBeInTheDocument();
    expect(second.auth().user).toBeNull();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
  });

  it("keeps the token on a transient /auth/me failure and offers a retry instead of signing out (MJ-30)", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ meTransientFailures: 1 });
    const tab = renderTab(
      server,
      <RequireAuth fallback={<p>Please sign in</p>} reauthPrompt={null}>
        <Dashboard />
      </RequireAuth>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Still not working. Check your connection and try again.",
    );
    expect(tab.auth().status).toBe("unavailable");
    expect(tab.auth().getAccessToken()).not.toBeNull();
    expect(screen.queryByText("Please sign in")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(tab.auth().status).toBe("authenticated");
  });

  it("does not loop after a consumed/revoked refresh and keeps the page mounted but inert", async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    const tab = renderTab(
      server,
      <RequireAuth
        fallback={<p>Please sign in</p>}
        reauthPrompt={<p role="alert">Sign in again</p>}
      >
        <Dashboard />
      </RequireAuth>,
    );
    await screen.findByRole("heading", { name: "Dashboard" });
    await user.type(screen.getByLabelText("Draft"), "unsaved idea");

    // The session works with the current access token.
    await expect(tab.auth().api.request({ path: "/quizzes" })).resolves.toBeDefined();
    // Someone replays the consumed first cookie: the server revokes the whole family. The next
    // call needs a refresh, which is now rejected as revoked.
    await act(async () => {
      server.jar.cookie = "r1";
      await server.fetchMock(`${BASE}/auth/refresh`, { method: "POST" });
      await tab
        .auth()
        .api.request({ path: "/quizzes" })
        .catch(() => undefined);
    });
    await waitFor(() => expect(tab.auth().status).toBe("reauth"));
    expect(screen.getByRole("alert")).toHaveTextContent("Sign in again");
    const refreshesBefore = server.refreshCount();
    await act(async () => {
      for (let i = 0; i < 3; i++)
        await tab
          .auth()
          .api.request({ path: "/quizzes" })
          .catch(() => undefined);
    });
    expect(server.refreshCount()).toBe(refreshesBefore); // no refresh loop
    // The page was not remounted: the draft survives behind the inert wrapper.
    const draft = document.querySelector("input") as HTMLInputElement;
    expect(draft.value).toBe("unsaved idea");
    expect(draft.closest("[inert]")).not.toBeNull();
  });

  it("signs out every tab and aborts session-bound requests", async () => {
    const server = fakeServer();
    const bus = fakeBus();
    const locks = fakeLocks();
    const a = renderTab(server, null, { channel: bus, locks });
    const b = renderTab(server, null, { channel: bus, locks });
    await act(async () => {
      await a.auth().ensureSession();
      await b.auth().ensureSession();
    });
    expect(a.auth().status).toBe("authenticated");
    expect(b.auth().status).toBe("authenticated");
    expect(server.refreshCount()).toBe(1); // tab B reused tab A's broadcast token
    const signal = b.auth().sessionSignal;
    await act(async () => {
      await a.auth().signOut();
    });
    expect(server.log).toContain("/auth/logout");
    await waitFor(() => expect(b.auth().status).toBe("anonymous"));
    expect(a.auth().user).toBeNull();
    expect(signal.aborted).toBe(true);
  });
});

describe("safeReturnTo", () => {
  it.each([
    "//evil.example/dashboard",
    "https://evil.example/dashboard",
    "/\\evil.example",
    "javascript:alert(1)",
    "dashboard",
    "/login?returnTo=/dashboard",
    "/setup",
    "/dashboard/../login",
    "/dashboard\u0000",
    null,
    undefined,
  ])("rejects %j", (value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_TO);
  });

  it("keeps safe app paths with their query and hash", () => {
    expect(safeReturnTo("/dashboard/quizzes?page=2#top")).toBe("/dashboard/quizzes?page=2#top");
    expect(safeReturnTo("/host/7f1d7a8e")).toBe("/host/7f1d7a8e");
    expect(safeReturnTo("/join?pin=123456")).toBe("/join?pin=123456");
  });
});
