/**
 * TASK-132 coverage for the public and dashboard shells: landmarks and skip link; public header
 * (logo, Join, Sign in, language, theme) and legal footer with the music credits dialog (safe
 * rendering, focus return); public shell states (loading default name, ideal instance name, empty
 * name, partial missing logo → monogram and long wrapping names, error banner with retry); the
 * protected dashboard (no flash while the session is checked, anonymous redirect with a safe
 * returnTo, creator vs superadmin navigation, direct navigation to an admin path, aria-current),
 * the small-screen menu (toggle, Escape with focus return, closes on navigation), the profile menu
 * (theme without remount, sign out) and the inert page with a sign-in prompt after a lost session.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import { DashboardShell, isActivePath, loginHref, navItemsFor } from "./dashboard-shell";
import {
  PublicShell,
  monogramOf,
  type PublicConfig,
  type PublicConfigLoader,
} from "./public-shell";

const nav = vi.hoisted(() => {
  const replace = vi.fn();
  const router = {
    replace,
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  };
  return { pathname: "/dashboard/quizzes" as string | null, router, replace };
});
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
}));

const BASE = "http://api.test/api/v1";
const NAMESPACES = ["common", "accessibility", "auth", "player", "about"] as const;
const LONG_NAME =
  "Sekolah Menengah Atas Negeri Pembangunan Berkelanjutan Nusantara Raya Internasional";

/** Public configuration fixture. */
function config(instanceName: string): PublicConfig {
  return {
    instanceName,
    defaultLocale: "en",
    registrationMode: "INVITE_ONLY",
    limits: { imageMb: 5, audioMb: 10, videoMb: 50 },
    catalogVersion: "1",
    audioTracks: [],
  } as unknown as PublicConfig;
}

/** JSON response helper. */
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
    correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
  });
}

/** Fake API: session cookie, role, revocation and an optional public config. */
function fakeApi(options: { loggedIn?: boolean; role?: "CREATOR" | "SUPERADMIN"; name?: string }) {
  const state = {
    loggedIn: options.loggedIn ?? true,
    revoked: false,
    configStatus: 503,
  };
  const log: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace("/api/v1", "");
    log.push(path);
    if (path === "/auth/refresh") {
      if (state.revoked) return failure(401, "TOKEN_REVOKED");
      return state.loggedIn
        ? json(200, { accessToken: "access-1", expiresIn: 900 })
        : failure(401, "AUTH_REQUIRED");
    }
    if (path === "/auth/me")
      return json(200, {
        id: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
        email: "ayu@example.com",
        name: options.name ?? "Ayu",
        role: options.role ?? "CREATOR",
        avatar: { style: "bottts", seed: "ayu" },
        isActive: true,
        revision: 1,
        createdAt: 1,
      });
    if (path === "/auth/logout") {
      state.loggedIn = false;
      return json(200, { success: true });
    }
    if (path === "/quizzes")
      return state.revoked ? failure(401, "TOKEN_EXPIRED") : json(200, { items: [] });
    if (path === "/system/public-config") return failure(state.configStatus, "SERVICE_UNAVAILABLE");
    return failure(404, "NOT_FOUND");
  });
  return { state, log, fetchMock };
}

/** Renders `ui` with the locale, theme and auth providers of the root layout. */
function renderShell(ui: ReactElement, api = fakeApi({})) {
  const store = createThemePreferenceStore({ storage: () => null });
  const view = renderWithLocale(
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl={BASE}
        fetch={api.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        {ui}
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
  return { ...view, api, store };
}

/** Child page with local state (to prove the shell never remounts it) and an API call. */
function Page({ title = "Quiz library" }: { title?: string }) {
  const { api } = useAuth();
  const [note, setNote] = useState("");
  return (
    <div>
      <h1>{title}</h1>
      <label>
        Draft
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button type="button" onClick={() => void api.request({ path: "/quizzes" }).catch(() => {})}>
        Load quizzes
      </button>
    </div>
  );
}

/** Deferred promise helper. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  nav.pathname = "/dashboard/quizzes";
  delete document.documentElement.dataset.theme;
});

describe("PublicShell", () => {
  it("renders landmarks, skip link, header navigation and the legal footer (loading → ideal)", async () => {
    const user = userEvent.setup();
    const pending = deferred<PublicConfig>();
    const loadConfig: PublicConfigLoader = () => pending.promise;
    renderShell(
      <PublicShell loadConfig={loadConfig}>
        <Page title="Welcome" />
      </PublicShell>,
    );
    // Loading: the shell and logo render at once with the product name.
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("link", { name: "Kabuki Neko" })).toHaveAttribute("href", "/");
    await act(async () => pending.resolve(config("SMA Negeri 1 Contoh")));
    expect(within(banner).getByRole("link", { name: "SMA Negeri 1 Contoh" })).toHaveAttribute(
      "href",
      "/",
    );
    const menu = within(banner).getByRole("navigation", { name: "Menu" });
    expect(within(menu).getByRole("link", { name: "Join a game" })).toHaveAttribute(
      "href",
      "/join",
    );
    expect(within(menu).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(within(menu).getByRole("button", { name: /^Language/u })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Theme" })).toBeInTheDocument();

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(within(main).getByRole("heading", { level: 1, name: "Welcome" })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );

    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent("SMA Negeri 1 Contoh · Kabuki Neko");
    const legal = within(footer).getByRole("navigation", { name: "About" });
    expect(within(legal).getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
    expect(within(legal).getByRole("link", { name: "Code license" })).toHaveAttribute(
      "href",
      "/legal/LICENSE.txt",
    );
    expect(within(legal).getByRole("link", { name: "Third-party notices" })).toHaveAttribute(
      "href",
      "/legal/THIRD-PARTY-NOTICES.txt",
    );
    expect(within(legal).getByRole("link", { name: "Add a language" })).toHaveAttribute(
      "href",
      "/help/languages",
    );
  });

  it("shows the error banner with retry while static content stays, then recovers", async () => {
    const user = userEvent.setup();
    const api = fakeApi({});
    renderShell(
      <PublicShell>
        <Page title="Welcome" />
      </PublicShell>,
      api,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The service is unavailable right now. Please try again shortly.",
    );
    expect(api.log).toContain("/system/public-config");
    // Static content and navigation stay usable.
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Join a game" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kabuki Neko" })).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(api.log.filter((path) => path === "/system/public-config")).toHaveLength(2),
    );
  });

  it("covers empty names, a missing logo (monogram) and long wrapping names", async () => {
    const loader = vi
      .fn<PublicConfigLoader>()
      .mockResolvedValueOnce(config("  "))
      .mockResolvedValueOnce(config(LONG_NAME));
    const first = renderShell(
      <PublicShell loadConfig={loader}>
        <p>Body</p>
      </PublicShell>,
    );
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Kabuki Neko" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/^Kabuki Neko/u);
    first.unmount();

    renderShell(
      <PublicShell loadConfig={loader}>
        <p>Body</p>
      </PublicShell>,
    );
    const brand = await screen.findByRole("link", { name: LONG_NAME });
    expect(brand.querySelector("span")?.className).toMatch(/overflow-wrap:anywhere/u);
    const logo = brand.querySelector("img");
    expect(logo).toHaveAttribute("src", "/brand/favicon.svg");
    expect(logo).toHaveAttribute("alt", "");
    fireEvent.error(logo as HTMLImageElement);
    expect(await within(brand).findByTestId("brand-monogram")).toHaveTextContent("SM");
    expect(brand).toHaveAccessibleName(LONG_NAME);
    expect(monogramOf("Kabuki Neko")).toBe("KN");
    expect(monogramOf("<script>")).toBe("SC");
    expect(monogramOf("!!!")).toBe("KN");
  });

  it("switches the theme without remounting and opens the credits safely from the footer", async () => {
    const user = userEvent.setup();
    const fetchCredits = vi.fn(
      async () =>
        new Response("# Credits <script>alert(1)</script>\n\n[x](javascript:alert(2)) by GT-K", {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchCredits);
    renderShell(
      <PublicShell loadConfig={async () => config("Contoh")}>
        <Page title="Welcome" />
      </PublicShell>,
    );
    await user.type(screen.getByLabelText("Draft"), "kept");
    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByLabelText("Draft")).toHaveValue("kept");

    const trigger = within(screen.getByRole("contentinfo")).getByRole("button", {
      name: "Music and sound credits",
    });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Music and sound credits" });
    await within(dialog).findByText(/by GT-K/u);
    expect(fetchCredits).toHaveBeenCalledWith("/audio/CREDITS.md", { cache: "no-cache" });
    expect(document.querySelector("script")).toBeNull();
    expect(within(dialog).queryByRole("link", { name: "x" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("DashboardShell", () => {
  it("renders nothing protected until the session check finishes, then the creator navigation", async () => {
    nav.pathname = "/dashboard/quizzes/123";
    renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page />
      </DashboardShell>,
    );
    // Loading: only the status, no navigation or page content (no unauthorized flash).
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Quiz library" })).not.toBeInTheDocument();

    const menu = await screen.findByRole("navigation", { name: "Menu" });
    const links = within(menu).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Quizzes", "/dashboard/quizzes"],
      ["Media", "/dashboard/media"],
      ["Reports", "/dashboard/reports"],
      ["About", "/dashboard/about"],
    ]);
    expect(within(menu).getByRole("link", { name: "Quizzes" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(menu).getByRole("link", { name: "Media" })).not.toHaveAttribute("aria-current");
    expect(
      within(menu).getByRole("button", { name: "Music and sound credits" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Quiz library" }),
    );
    // Credits live in the sidebar only (no duplicate in the footer).
    expect(screen.getAllByRole("button", { name: "Music and sound credits" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contoh" })).toHaveAttribute(
      "href",
      "/dashboard/quizzes",
    );
  });

  it("adds Settings and Users for superadmins only; direct navigation keeps a safe shell", async () => {
    nav.pathname = "/dashboard/users";
    const admin = renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page title="Users" />
      </DashboardShell>,
      fakeApi({ role: "SUPERADMIN" }),
    );
    const menu = await screen.findByRole("navigation", { name: "Menu" });
    expect(within(menu).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/dashboard/settings",
    );
    expect(within(menu).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    admin.unmount();

    // A creator typing an admin URL: no admin links, nothing marked current.
    nav.pathname = "/dashboard/settings";
    renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page title="Settings" />
      </DashboardShell>,
      fakeApi({ role: "CREATOR" }),
    );
    const creatorMenu = await screen.findByRole("navigation", { name: "Menu" });
    expect(within(creatorMenu).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(creatorMenu).queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(creatorMenu.querySelector("[aria-current]")).toBeNull();
    expect(navItemsFor(null)).toEqual([]);
    expect(navItemsFor("CREATOR").some((item) => item.superadminOnly)).toBe(false);
  });

  it("redirects anonymous visitors to sign in with a safe returnTo and never shows the page", async () => {
    nav.pathname = "/dashboard/reports";
    const api = fakeApi({ loggedIn: false });
    renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page />
      </DashboardShell>,
      api,
    );
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith("/login?returnTo=%2Fdashboard%2Freports"),
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fdashboard%2Freports",
    );
    expect(screen.queryByRole("heading", { name: "Quiz library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(loginHref("//evil.example/x")).toBe("/login?returnTo=%2Fdashboard");
    expect(loginHref(null)).toBe("/login?returnTo=%2Fdashboard");
    expect(isActivePath("/dashboard/quizzesx", "/dashboard/quizzes")).toBe(false);
    expect(isActivePath("/dashboard/quizzes", "/dashboard/quizzes")).toBe(true);
  });

  it("toggles the small-screen menu, closes it on Escape and on navigation, and wraps long names", async () => {
    const user = userEvent.setup();
    const view = renderShell(
      <DashboardShell loadConfig={async () => config(LONG_NAME)}>
        <Page />
      </DashboardShell>,
      fakeApi({ name: LONG_NAME }),
    );
    const toggle = await screen.findByRole("button", { name: "Menu" });
    const menu = screen.getByRole("navigation", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", menu.id);
    expect(menu.className).toMatch(/(^|\s)hidden(\s|$)/u);
    expect(menu.className).toMatch(/lg:flex/u);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(menu.className).not.toMatch(/(^|\s)hidden(\s|$)/u);
    within(menu).getByRole("link", { name: "Media" }).focus();
    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    nav.pathname = "/dashboard/media";
    view.rerender(
      <ThemeProvider store={view.store}>
        <AuthProvider
          apiBaseUrl={BASE}
          fetch={view.api.fetchMock as unknown as typeof fetch}
          locks={null}
          channel={null}
          storage={null}
        >
          <DashboardShell loadConfig={async () => config(LONG_NAME)}>
            <Page />
          </DashboardShell>
        </AuthProvider>
      </ThemeProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    const brand = await screen.findByRole("link", { name: LONG_NAME });
    expect(brand.querySelector("span")?.className).toMatch(/overflow-wrap:anywhere/u);
    expect(screen.getByRole("button", { name: LONG_NAME })).toBeInTheDocument();
  });

  it("changes the theme and signs out from the profile menu", async () => {
    const user = userEvent.setup();
    const api = fakeApi({});
    renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page />
      </DashboardShell>,
      api,
    );
    await user.type(await screen.findByLabelText("Draft"), "kept");
    await user.click(screen.getByRole("button", { name: "Ayu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Theme: Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByLabelText("Draft")).toHaveValue("kept");
    await user.click(screen.getByRole("button", { name: "Ayu" }));
    expect(
      await screen.findByRole("menuitem", { name: "Theme: Dark (Selected)" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
    expect(api.log).toContain("/auth/logout");
  });

  it("keeps the page mounted but inert with a sign-in prompt when the session is lost", async () => {
    const user = userEvent.setup();
    nav.pathname = "/dashboard/quizzes";
    const api = fakeApi({});
    renderShell(
      <DashboardShell loadConfig={async () => config("Contoh")}>
        <Page />
      </DashboardShell>,
      api,
    );
    await user.type(await screen.findByLabelText("Draft"), "unsaved idea");
    api.state.revoked = true;
    await user.click(screen.getByRole("button", { name: "Load quizzes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your session has expired. Please sign in again.");
    const again = within(alert).getByRole("link", { name: "Sign in again" });
    expect(again).toHaveAttribute("href", "/login?returnTo=%2Fdashboard%2Fquizzes");
    await waitFor(() => expect(again).toHaveFocus());
    const draft = document.querySelector("input") as HTMLInputElement;
    expect(draft.value).toBe("unsaved idea");
    expect(draft.closest("[inert]")).not.toBeNull();
  });
});
