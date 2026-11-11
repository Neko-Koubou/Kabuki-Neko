/**
 * TASK-147 coverage for the S11 settings, storage and health panels against a scripted API.
 * - Admin guard: creators see a permission notice and no settings request is made.
 * - Five states per panel:
 *   - loading;
 *   - empty: no files / not checked;
 *   - ideal;
 *   - partial: stale metrics, degraded health, partial cleanup;
 *   - error: retry.
 * - Only changed fields are sent (never untouched defaults), and nothing is sent without changes.
 * - A stale revision keeps the entries and offers a reload.
 * - Health 200 vs 503 are both results; other failures are errors.
 * - Cleanup uses M09 with a new Idempotency-Key per batch and reports partial failures and
 *   "more remain".
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { LOCALE_NAMESPACES } from "@kabuki-neko/shared/schemas/locale.schema";
import type { Health } from "@kabuki-neko/shared/schemas/system.schema";
import { ApiError } from "@/lib/api-client";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import {
  AdminSettingsHealth,
  changedFields,
  formOf,
  type HealthLoader,
} from "./admin-settings-health";

const NAMESPACES = ["common", "accessibility", "admin", "validation", "auth"] as const;
const NOW = 1_790_000_000_000;
const BUILD = "a".repeat(64);

/** Settings fixture. */
const SETTINGS = {
  instanceName: "SMA Contoh",
  registrationMode: "INVITE_ONLY",
  maxImageSizeMb: 5,
  maxAudioSizeMb: 10,
  maxVideoSizeMb: 50,
  maxPlayersPerRoom: 200,
  profanityWords: ["kasar"],
  defaultLocale: "en",
  revision: 3,
  updatedAt: NOW,
} as const;

/** Installed locale registry with English and Indonesian. */
const REGISTRY = {
  buildId: BUILD,
  catalogVersion: "1",
  locales: (
    [
      ["en", "English"],
      ["id", "Bahasa Indonesia"],
    ] as const
  ).map(([tag, nativeName]) => ({
    tag,
    nativeName,
    direction: "ltr",
    packageVersion: "1.0.0",
    coverage: 1,
    catalogVersion: "1",
    namespaces: LOCALE_NAMESPACES.map((name) => ({
      name,
      url: `/locales/${BUILD}/${tag}/${name}.json`,
      sha256: "b".repeat(64),
    })),
  })),
};

/** Health fixture. */
function health(overrides: Partial<Health> = {}): Health {
  const part = { status: "up" as const, checkedAt: NOW, errorCode: null };
  return {
    app: "Kabuki Neko",
    status: "ok",
    dbDriver: "sqlite",
    storageDriver: "local",
    stateDriver: "memory",
    storageHealth: "up",
    checkedAt: NOW,
    db: part,
    storage: part,
    state: part,
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
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

/** Scripted API; `route` answers non-auth calls. */
function fakeApi(
  role: "CREATOR" | "SUPERADMIN",
  route: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v1", "");
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    if (path === "/auth/refresh") return json(200, { accessToken: "access-1", expiresIn: 900 });
    if (path === "/auth/me")
      return json(200, {
        id: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
        email: "ayu@example.com",
        name: "Ayu",
        role,
        avatar: { style: "bottts", seed: "ayu" },
        isActive: true,
        revision: 1,
        createdAt: 1,
      });
    if (path === "/system/locales") return json(200, REGISTRY);
    return route(call);
  });
  return {
    calls,
    fetchMock,
    settingsCalls: () => calls.filter((call) => call.path.startsWith("/system/settings")),
  };
}

/** Starts the session like the dashboard shell does. */
function Session({ children }: { children: ReactNode }) {
  const { ensureSession } = useAuth();
  useEffect(() => {
    void ensureSession();
  }, [ensureSession]);
  return <>{children}</>;
}

/** Renders the page inside the providers. */
function renderPage(
  api: ReturnType<typeof fakeApi>,
  loadHealth: HealthLoader = async () => health(),
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
          <AdminSettingsHealth loadHealth={loadHealth} />
        </Session>
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
}

/** Settings response. */
const settingsResponse = (
  metrics: Partial<{ fileCount: number; totalBytes: number; status: string }> = {},
) =>
  json(200, {
    settings: SETTINGS,
    metrics: { fileCount: 12, totalBytes: 3_400_000, checkedAt: NOW, status: "fresh", ...metrics },
  });

describe("AdminSettingsHealth", () => {
  it("keeps creators out without requesting settings", async () => {
    const api = fakeApi("CREATOR", () => settingsResponse());
    renderPage(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to do this.",
    );
    expect(api.settingsCalls()).toHaveLength(0);
  });

  it("sends only changed fields with If-Match and nothing without changes", async () => {
    const user = userEvent.setup();
    const api = fakeApi("SUPERADMIN", (call) =>
      call.method === "PATCH"
        ? json(200, { ...SETTINGS, maxPlayersPerRoom: 50, revision: 4 })
        : settingsResponse(),
    );
    renderPage(api);
    const save = await screen.findByRole("button", { name: "Save settings" });
    expect(save).toBeDisabled();
    expect(screen.getByLabelText(/^Default language/u)).toHaveValue("en");
    const players = screen.getByLabelText(/^Maximum players per game/u);
    await user.clear(players);
    await user.type(players, "50");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch?.headers.get("If-Match")).toBe('"3"');
    expect(patch?.body).toEqual({ maxPlayersPerRoom: 50 });
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("keeps entries on a stale revision and reloads only on request", async () => {
    const user = userEvent.setup();
    const api = fakeApi("SUPERADMIN", (call) =>
      call.method === "PATCH" ? failure(409, "REVISION_CONFLICT") : settingsResponse(),
    );
    renderPage(api);
    const name = await screen.findByLabelText(/^Instance name/u);
    await user.clear(name);
    await user.type(name, "Sekolah Baru");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(
      await screen.findByText(
        "These settings were changed by someone else. Reload them before saving.",
      ),
    ).toBeInTheDocument();
    expect(name).toHaveValue("Sekolah Baru");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText(/^Instance name/u)).toHaveValue("SMA Contoh"));
  });

  it("shows storage states and runs cleanup batches with new keys", async () => {
    const user = userEvent.setup();
    const batches = [
      { deletedCount: 3, freedBytes: 2_048, failedCount: 1, hasMore: true },
      { deletedCount: 0, freedBytes: 0, failedCount: 0, hasMore: false },
    ];
    let metrics: Parameters<typeof settingsResponse>[0] = { status: "stale" };
    const api = fakeApi("SUPERADMIN", (call) => {
      if (call.path === "/system/storage/cleanup-orphans") {
        const batch = batches.shift();
        return json(200, {
          scannedCount: 10,
          skippedInUseCount: 0,
          failures: batch?.failedCount
            ? [{ mediaId: "00000000-0000-4000-8000-000000000001", errorCode: "DELETE_FAILED" }]
            : [],
          checkedAt: NOW,
          ...batch,
        });
      }
      return settingsResponse(metrics);
    });
    renderPage(api);
    expect(await screen.findByText("These figures may be out of date.")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    metrics = { fileCount: 0, totalBytes: 0 };
    await user.click(screen.getByRole("button", { name: "Clean up unused files" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Delete media files that aren't used by any quiz or game? This can't be undone.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Clean up unused files" }));
    expect(
      await screen.findByText("3 files deleted, 2,048 bytes freed, 1 failure"),
    ).toBeInTheDocument();
    expect(screen.getByText("Cleanup finished with some failures.")).toBeInTheDocument();
    expect(
      screen.getByText("More unused files remain. Run cleanup again to continue."),
    ).toBeInTheDocument();
    expect(await screen.findByText("No files stored yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clean up unused files" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Clean up unused files",
      }),
    );
    expect(
      await screen.findByText("No files deleted, 0 bytes freed, no failures"),
    ).toBeInTheDocument();
    const keys = api.calls
      .filter((call) => call.path === "/system/storage/cleanup-orphans")
      .map((call) => call.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("keeps unavailable storage distinct from zero and retries a failed settings panel", async () => {
    const user = userEvent.setup();
    const answers = [
      failure(503, "DEPENDENCY_UNAVAILABLE"),
      settingsResponse({ status: "unavailable", fileCount: 0 }),
    ];
    const api = fakeApi("SUPERADMIN", () => answers.shift() ?? settingsResponse());
    renderPage(api);
    expect(
      await screen.findByText(
        "Something couldn't load or save. Your entries are kept; retry each panel separately.",
      ),
    ).toBeInTheDocument();
    // The health panel loads independently.
    expect(await screen.findByText("All systems working")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Storage isn't available.")).toBeInTheDocument();
    expect(screen.queryByText("No files stored yet.")).not.toBeInTheDocument();
  });

  it("shows 200 and 503 health as results, other failures as errors with retry", async () => {
    const user = userEvent.setup();
    const answers: (() => Promise<Health>)[] = [
      async () =>
        health({
          status: "degraded",
          storageHealth: "down",
          storage: { status: "down", checkedAt: NOW, errorCode: "STORAGE_UNAVAILABLE" },
          state: { status: "unknown", checkedAt: NOW, errorCode: null },
        }),
      async () => {
        throw new ApiError(500, "INTERNAL_ERROR");
      },
      async () => health(),
    ];
    const loader: HealthLoader = () => (answers.shift() ?? (async () => health()))();
    renderPage(
      fakeApi("SUPERADMIN", () => settingsResponse()),
      loader,
    );
    expect(await screen.findByText("Degraded")).toBeInTheDocument();
    const storage = document.querySelector('[data-health="storage"]');
    expect(storage).toHaveAttribute("data-status", "down");
    expect(within(storage as HTMLElement).getByText("(local)")).toBeInTheDocument();
    expect(document.querySelector('[data-health="state"]')).toHaveTextContent("Not checked yet");
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByText(
        "Something couldn't load or save. Your unsaved settings are kept; retry each panel separately.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("All systems working")).toBeInTheDocument();
  });

  it("computes the changed fields only", () => {
    const form = formOf(SETTINGS as never);
    expect(changedFields(SETTINGS as never, form)).toBeNull();
    expect(
      changedFields(SETTINGS as never, { ...form, profanityWords: "kasar\n\n jahat " }),
    ).toEqual({
      profanityWords: ["kasar", "jahat"],
    });
  });
});
