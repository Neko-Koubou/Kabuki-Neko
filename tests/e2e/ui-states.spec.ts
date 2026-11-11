/**
 * TASK-171 five-state UI inventory against the real API and the production web build (Design §6;
 * SA §11.2).
 *
 * 1. The inventory (`fixtures/ui-state-cases.ts`) must account for S01–S17, M01–M12, B01–B12 and
 *    F01–F20 in all five states. Every cell names at least one existing test by file and exact
 *    title, so a removed or renamed test breaks this check instead of leaving a silent gap.
 * 2. Browser checks for the screen states that depend on real API traffic:
 *    - Loading: the response is held.
 *    - Empty: the real empty state of a brand-new creator.
 *    - Error: an offline fetch (aborted request) or a 503.
 *    - Ideal: what the real API then returns.
 *    Assertions check text and roles, not screenshots, and that a failed fetch is never shown as
 *    empty.
 *
 * Accounts: a superadmin from earlier specs (API sign-in, refresh cookie reused by the browser,
 * as in host.spec) and a new creator registered through the API under PUBLIC registration.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import {
  REQUIRED_IDS,
  declaresTest,
  UI_STATES,
  UI_STATE_CASES,
  UI_STATE_TESTS,
  failRequests,
  holdRequests,
  serviceUnavailable,
} from "./fixtures/ui-state-cases";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may have (created by earlier specs). */
const ADMINS = [
  "admin@example.com",
  "rival@example.com",
  "reports-admin@example.com",
  "host-admin@example.com",
  "studio-admin@example.com",
  "player-admin@example.com",
  "join-admin@example.com",
  "audio-admin@example.com",
];
/** The creator this spec registers (a fresh workspace: no quizzes, media or reports). */
const CREATOR = { name: "Ui States", email: `ui-states-${randomUUID().slice(0, 8)}@example.com` };

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared sessions. */
const state: {
  admin: APIRequestContext | null;
  adminToken: string;
  creator: APIRequestContext | null;
  creatorToken: string;
  contexts: BrowserContext[];
} = { admin: null, adminToken: "", creator: null, creatorToken: "", contexts: [] };

/** API context presenting a fixed client address (per-IP auth limits). */
function apiContext(address: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": address },
  });
}

/**
 * Signs in the first administrator that exists. Earlier specs sign the same administrator in, so
 * a per-email limit (429) is waited out once with its Retry-After.
 */
async function signInAdmin(api: APIRequestContext): Promise<string> {
  for (const email of ADMINS)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const login = await api.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
      if (login.status() === 200)
        return ((await login.json()) as { accessToken: string }).accessToken;
      if (login.status() !== 429) break;
      const wait = Number(login.headers()["retry-after"] ?? "60");
      await new Promise((resolve) => setTimeout(resolve, (Math.min(wait, 65) + 1) * 1_000));
    }
  throw new Error("No administrator could sign in");
}

/** Makes sure registration is PUBLIC (optimistic concurrency on the settings revision). */
async function publicRegistration(api: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const current = await api.get("/api/v1/system/settings", { headers });
  expect(current.status()).toBe(200);
  const { settings } = (await current.json()) as {
    settings: { revision: number; registrationMode: string };
  };
  if (settings.registrationMode === "PUBLIC") return;
  const patched = await api.patch("/api/v1/system/settings", {
    headers: { ...headers, "If-Match": `"${settings.revision}"` },
    data: { registrationMode: "PUBLIC" },
  });
  expect(patched.status()).toBe(200);
}

/** One browser context per API session: its refresh cookie rotates, so it is never copied twice. */
const signedIn = new Map<APIRequestContext, BrowserContext>();
/**
 * Client address the signed-in contexts present. Every full page load renews the session, and
 * renewals are limited per address, so each section of a test moves to a fresh address.
 */
let clientAddress = "10.71.1.1";
/** Moves the signed-in contexts to `address` for the following requests. */
const useAddress = (address: string) => {
  clientAddress = address;
};

/**
 * The browser context signed in with the refresh cookie of `api` (created once, with its own
 * client address). Only one page of a context renews the session at a time, so callers close
 * their page before the next test opens another.
 */
async function signedInContext(browser: Browser, api: APIRequestContext) {
  const existing = signedIn.get(api);
  if (existing) return existing;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: await api.storageState(),
  });
  state.contexts.push(context);
  signedIn.set(api, context);
  await context.route(`${API}/**`, (route) =>
    // A request the app aborted meanwhile is already handled; nothing to continue then.
    route
      .continue({ headers: { ...route.request().headers(), "x-forwarded-for": clientAddress } })
      .catch(() => undefined),
  );
  return context;
}

/** The latest error alert with a Try again button. */
const retryAlert = (page: import("@playwright/test").Page) =>
  page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Try again" }) });

test.beforeAll(async () => {
  // Waiting out a per-email sign-in limit can take a minute.
  test.setTimeout(150_000);
  state.admin = await apiContext("10.71.0.1");
  state.adminToken = await signInAdmin(state.admin);
  await publicRegistration(state.admin, state.adminToken);
  state.creator = await apiContext("10.71.0.2");
  const registered = await state.creator.post("/api/v1/auth/register", {
    headers: { "Idempotency-Key": randomUUID() },
    data: { ...CREATOR, password: PASSWORD },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  state.creatorToken = ((await registered.json()) as { accessToken: string }).accessToken;
});

test.afterAll(async () => {
  for (const context of state.contexts) await context.close();
  await state.admin?.dispose();
  await state.creator?.dispose();
});

test(UI_STATE_TESTS.inventory, () => {
  const ids = UI_STATE_CASES.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([...REQUIRED_IDS].sort());
  expect(REQUIRED_IDS).toHaveLength(61);
  const sources = new Map<string, string>();
  let cells = 0;
  for (const entry of UI_STATE_CASES)
    for (const letter of UI_STATES) {
      const cell = entry.states[letter];
      cells += 1;
      expect({ cell: `${entry.id}.${letter}`, expectation: cell.expectation.length > 0 }).toEqual({
        cell: `${entry.id}.${letter}`,
        expectation: true,
      });
      expect({ cell: `${entry.id}.${letter}`, evidence: cell.evidence.length > 0 }).toEqual({
        cell: `${entry.id}.${letter}`,
        evidence: true,
      });
      for (const evidence of cell.evidence) {
        if (!sources.has(evidence.file)) {
          expect({ file: evidence.file, exists: existsSync(evidence.file) }).toEqual({
            file: evidence.file,
            exists: true,
          });
          sources.set(evidence.file, readFileSync(evidence.file, "utf8"));
        }
        // Titles are declared as string literals or through the shared title constants.
        const declared = declaresTest(sources.get(evidence.file) ?? "", evidence.title);
        expect({ cell: `${entry.id}.${letter}`, ...evidence, declared }).toEqual({
          cell: `${entry.id}.${letter}`,
          ...evidence,
          declared: true,
        });
      }
    }
  expect(cells).toBe(305);
});

test(UI_STATE_TESTS.workspace, async ({ browser }) => {
  if (!state.creator) throw new Error("setup missing");
  const context = await signedInContext(browser, state.creator);
  const page = await context.newPage();

  useAddress("10.71.1.1");
  // S05 — Loading (held list), Empty (a new creator), Error (offline fetch) → retry → Empty.
  const quizzes = /\/api\/v1\/quizzes\?/u;
  const heldQuizzes = await holdRequests(page, quizzes);
  await page.goto("/dashboard/quizzes");
  await expect.poll(heldQuizzes.held).toBeGreaterThan(0);
  await expect(page.locator("[aria-busy='true']").first()).toBeVisible();
  await expect(page.getByText(/You don't have any quizzes yet/u)).toHaveCount(0);
  await heldQuizzes.release();
  const noQuizzes = page.getByText(
    "You don't have any quizzes yet. Create or import one to get started.",
  );
  await expect(noQuizzes).toBeVisible();
  const offlineQuizzes = await failRequests(page, quizzes);
  await page.reload();
  await expect(retryAlert(page)).toBeVisible();
  await expect(noQuizzes).toHaveCount(0);
  await offlineQuizzes.stop();
  await retryAlert(page).getByRole("button", { name: "Try again" }).click();
  await expect(noQuizzes).toBeVisible();
  // Ideal: the creator's own quiz appears.
  const created = await state.creator.post("/api/v1/quizzes", {
    headers: { Authorization: `Bearer ${state.creatorToken}`, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Lima State" },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByRole("link", { name: "Kuis Lima State" }).first()).toBeVisible();

  useAddress("10.71.1.2");
  // S08 — Loading, Empty, Error → retry.
  const media = /\/api\/v1\/media\?/u;
  const heldMedia = await holdRequests(page, media);
  await page.goto("/dashboard/media");
  await expect.poll(heldMedia.held).toBeGreaterThan(0);
  await expect(page.locator("[aria-busy='true']").first()).toBeVisible();
  await heldMedia.release();
  const noMedia = page.getByText(
    "No media yet. Upload images, audio or video to use in your quizzes.",
  );
  await expect(noMedia).toBeVisible();
  const offlineMedia = await failRequests(page, media);
  await page.reload();
  await expect(retryAlert(page)).toBeVisible();
  await expect(noMedia).toHaveCount(0);
  await offlineMedia.stop();
  await retryAlert(page).getByRole("button", { name: "Try again" }).click();
  await expect(noMedia).toBeVisible();

  useAddress("10.71.1.3");
  // S09 — Loading, Empty, Error → retry.
  const reports = /\/api\/v1\/reports\?/u;
  const heldReports = await holdRequests(page, reports);
  await page.goto("/dashboard/reports");
  await expect.poll(heldReports.held).toBeGreaterThan(0);
  await expect(page.locator("[aria-busy='true']").first()).toBeVisible();
  await heldReports.release();
  const noReports = page.getByText("No finished games yet. Go back to your quizzes to host one.");
  await expect(noReports).toBeVisible();
  const offlineReports = await failRequests(page, reports);
  await page.reload();
  await expect(page.getByText("Your reports couldn't load. Try again.")).toBeVisible();
  await expect(noReports).toHaveCount(0);
  await offlineReports.stop();
  await retryAlert(page).getByRole("button", { name: "Try again" }).click();
  await expect(noReports).toBeVisible();
  await page.close();
});

test(UI_STATE_TESTS.fallback, async ({ browser }) => {
  if (!state.creator) throw new Error("setup missing");
  const context = await signedInContext(browser, state.creator);
  const page = await context.newPage();
  useAddress("10.71.2.1");
  // S06: an unknown (or foreign) quiz shows one fixed message without any title.
  await page.goto(`/dashboard/quizzes/${randomUUID()}`);
  await expect(
    page.getByText(
      "This quiz isn't available. It may have been deleted, or you may not have access.",
    ),
  ).toBeVisible();
  // S10: a malformed report id and a report that isn't the creator's both read "not found",
  // with no report data and no CSV action.
  const notFound = page.getByText(
    "This couldn't be found. It may have been deleted, or you may not have access.",
  );
  await page.goto("/dashboard/reports/not-a-session");
  await expect(notFound).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to home" })).toHaveAttribute("href", "/");
  await page.goto(`/dashboard/reports/${randomUUID()}`);
  await expect(notFound).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
  // S17: a creator on an administrator page gets the permission message, no settings data.
  await page.goto("/dashboard/settings");
  await expect(
    page.getByRole("main").getByRole("alert").filter({ hasText: "You don't have permission" }),
  ).toHaveText("You don't have permission to do this.");
  await expect(page.getByText("Clean up unused files")).toHaveCount(0);
  // S17 signed-out variant: a protected page sends an anonymous visitor to sign in.
  const anonymous = await browser.newPage();
  await anonymous.goto("/dashboard/media");
  await expect(anonymous).toHaveURL(/\/login\?returnTo=%2Fdashboard%2Fmedia$/u);
  const unknown = await anonymous.goto("/nowhere-to-be-found");
  expect(unknown?.status()).toBe(404);
  await expect(anonymous.getByRole("link", { name: "Go to home" })).toBeVisible();
  await anonymous.close();
  await page.close();
});

test(UI_STATE_TESTS.admin, async ({ browser }) => {
  if (!state.admin) throw new Error("setup missing");
  const context = await signedInContext(browser, state.admin);
  const page = await context.newPage();
  useAddress("10.71.3.1");
  // S11: health fails offline while the settings panel still loads; retry recovers.
  const health = await failRequests(page, /\/api\/v1\/system\/health/u);
  await page.goto("/dashboard/settings");
  await expect(page.getByText("Clean up unused files")).toBeVisible();
  await expect(
    page.getByText(
      "Something couldn't load or save. Your unsaved settings are kept; retry each panel separately.",
    ),
  ).toBeVisible();
  await expect(page.getByText("All systems working")).toHaveCount(0);
  await health.stop();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("All systems working")).toBeVisible();

  useAddress("10.71.3.2");
  // S12: users list fails, retry recovers; an empty search offers a reset.
  const users = await failRequests(page, /\/api\/v1\/users\?/u);
  await page.goto("/dashboard/users");
  await expect(retryAlert(page).first()).toBeVisible();
  await users.stop();
  await retryAlert(page).first().getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(CREATOR.email)).toBeVisible();
  await page.getByLabel(/^Search users/u).fill(`zz-${randomUUID()}`);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(
    page.getByText(
      "No invitations yet, or no users match your search. Create an invitation or clear the filters.",
    ),
  ).toBeVisible();
  await expect(page.getByText(CREATOR.email)).toHaveCount(0);
  await page.close();
});

test(UI_STATE_TESTS.public, async ({ browser }) => {
  const page = await browser.newPage();
  // S01: the public configuration answers 503 → banner + retry; static content stays.
  const config = await serviceUnavailable(page, /\/api\/v1\/system\/public-config/u);
  await page.goto("/");
  await expect(
    page.getByText("The service is unavailable right now. Please try again shortly."),
  ).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(main.getByRole("link", { name: "Join a game" })).toHaveAttribute("href", "/join");
  await config.stop();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("The service is unavailable right now. Please try again shortly."),
  ).toHaveCount(0);

  // S13: version and license sources fail → labels and the official link, never invented text.
  const about = await failRequests(page, /\/api\/v1\/system\/about/u);
  const license = await failRequests(page, /\/legal\/LICENSE\.txt/u);
  await page.goto("/about");
  await expect(
    page.getByText("Version unknown. The guides below are still available."),
  ).toBeVisible();
  await expect(page.getByText("The original document isn't available right now.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Official source" }).first()).toBeVisible();
  await about.stop();
  await license.stop();
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByLabel("Original license text")).toContainText("Commons Clause");
  await page.close();
});
