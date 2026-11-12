/**
 * TASK-135 end-to-end auth flows against the real API (isolated SQLite runtime) and `next dev`.
 *
 * 1. First run: two browser tabs race the two-step setup. Exactly one wins and lands on the
 *    dashboard; the other ends on "Setup was already completed… Sign in". Exactly one SUPERADMIN
 *    (and one account) exists, and `/setup` then redirects to `/login`.
 * 2. Sign in with a wrong password, then the right one, returning to the intended page. A live
 *    session skips the form; an unsafe `returnTo` falls back to the dashboard. After logout the
 *    form shows again. No password or token ever reaches browser storage or the HTML.
 * 3. Registration policies switched by the administrator: SINGLE_ADMIN is closed (no form),
 *    INVITE_ONLY needs a one-time invite code that cannot be reused, and PUBLIC needs no code.
 *
 * Every browser context presents its own client address (`X-Forwarded-For` through a loopback
 * proxy the API trusts in this test runtime), so per-IP auth rate limits apply per simulated
 * client. Titles are checked as the localized server-rendered `<title>`.
 */
import { randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
const RACE_TEXT =
  "Setup was already completed in another tab or by someone else. Sign in to continue.";

/** A person filling an auth form. */
interface Person {
  name: string;
  email: string;
}
const FIRST: Person = { name: "Ayu Admin", email: "admin@example.com" };
const SECOND: Person = { name: "Budi Rival", email: "rival@example.com" };

/** Page of users as returned by `GET /users`. */
interface UsersPage {
  items: { email: string; role: string }[];
  meta: { total: number };
}

test.describe.configure({ mode: "serial" });

/** The administrator created by whichever setup tab won the race. */
let owner: Person | null = null;
/** Cached administrator API session (logins per email are rate limited). */
let admin: { api: APIRequestContext; headers: Record<string, string> } | null = null;
let clientNumber = 0;

/** New browser context that presents its own client address to the API. */
async function newClient(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  clientNumber += 1;
  const address = `10.20.0.${clientNumber}`;
  await context.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  );
  return context;
}

/** Administrator API session (bearer) for checks and policy changes. */
async function adminApi() {
  if (admin) return admin;
  if (!owner) throw new Error("Setup has not completed");
  const api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.99.0.1" },
  });
  const response = await api.post("/api/v1/auth/login", {
    data: { email: owner.email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
  const { accessToken } = (await response.json()) as { accessToken: string };
  admin = { api, headers: { Authorization: `Bearer ${accessToken}` } };
  return admin;
}

/** Users matching `query` (as the administrator). */
async function users(query = ""): Promise<UsersPage> {
  const { api, headers } = await adminApi();
  const response = await api.get(`/api/v1/users?page=1&limit=20${query}`, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as UsersPage;
}

/** Switches the registration policy through the settings API (optimistic concurrency). */
async function setRegistrationMode(mode: "SINGLE_ADMIN" | "INVITE_ONLY" | "PUBLIC") {
  const { api, headers } = await adminApi();
  const current = await api.get("/api/v1/system/settings", { headers });
  expect(current.status()).toBe(200);
  const { settings } = (await current.json()) as { settings: { revision: number } };
  const patched = await api.patch("/api/v1/system/settings", {
    headers: { ...headers, "If-Match": `"${settings.revision}"` },
    data: { registrationMode: mode },
  });
  expect(patched.status()).toBe(200);
}

/** Creates a one-time invite code. */
async function createInvite(): Promise<string> {
  const { api, headers } = await adminApi();
  const response = await api.post("/api/v1/users/invitations", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: {},
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { inviteCode: string }).inviteCode;
}

/** Fills both setup steps (nothing is sent before "Finish setup"). */
async function fillSetup(page: Page, instanceName: string, person: Person) {
  await page.getByLabel(/^Instance name/u).fill(instanceName);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toContainText("Administrator account");
  await page.getByLabel(/^Name/u).fill(person.name);
  await page.getByLabel(/^Email/u).fill(person.email);
  await page.getByLabel(/^Password/u).fill(PASSWORD);
}

/** Fills the registration form (invite code only when given). */
async function fillRegister(page: Page, person: Person, inviteCode?: string) {
  await page.getByLabel(/^Name/u).fill(person.name);
  await page.getByLabel(/^Email/u).fill(person.email);
  await page.getByLabel(/^Password/u).fill(PASSWORD);
  if (inviteCode !== undefined) await page.getByLabel(/^Invite code/u).fill(inviteCode);
}

/** Asserts no password or bearer token sits in browser storage or the rendered HTML. */
async function expectNoSecrets(page: Page) {
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]),
  );
  expect(stored).not.toContain(PASSWORD);
  expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/u);
  const html = await page.content();
  expect(html).not.toContain(PASSWORD);
  expect(html).not.toMatch(/accessToken/u);
}

test("first run: two tabs race the setup and exactly one SUPERADMIN exists", async ({
  browser,
}) => {
  const a = await (await newClient(browser)).newPage();
  const b = await (await newClient(browser)).newPage();
  await a.goto("/setup");
  await b.goto("/setup");
  await expect(a).toHaveTitle("Set up Kabuki Neko · Kabuki Neko");
  await expect(a.getByRole("heading", { level: 1, name: "Set up your instance" })).toBeVisible();
  await fillSetup(a, "SMA Negeri 1 Contoh", FIRST);
  await fillSetup(b, "Rival Instance", SECOND);

  // Both finish at the same time: exactly one may win.
  await Promise.all([
    a.getByRole("button", { name: /^Finish setup/u }).click(),
    b.getByRole("button", { name: /^Finish setup/u }).click(),
  ]);
  const winner = await Promise.race([
    a.waitForURL("**/dashboard/quizzes").then(() => "a" as const),
    b.waitForURL("**/dashboard/quizzes").then(() => "b" as const),
  ]);
  const lost = winner === "a" ? b : a;
  owner = winner === "a" ? FIRST : SECOND;
  await expect(lost.getByText(RACE_TEXT)).toBeVisible();
  await expect(lost.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login",
  );
  await expectNoSecrets(a);
  await expectNoSecrets(b);

  const supers = await users("&role=SUPERADMIN");
  expect(supers.meta.total).toBe(1);
  expect(supers.items[0]?.email).toBe(owner.email);
  expect((await users()).meta.total).toBe(1);

  // An initialized instance redirects /setup to /login on the server.
  await lost.goto("/setup");
  await expect(lost).toHaveURL(/\/login$/u);
});

test("sign in returns to the intended page, a live session skips the form, logout ends it", async ({
  browser,
}) => {
  if (!owner) throw new Error("Setup has not completed");
  const page = await (await newClient(browser)).newPage();
  await page.goto("/login?returnTo=%2Fdashboard%2Freports");
  await expect(page).toHaveTitle("Sign in · Kabuki Neko");
  await page.getByLabel(/^Email/u).fill(owner.email);
  await page.getByLabel(/^Password/u).fill("not the right password");
  await page
    .getByRole("button", { name: /^Sign in/u })
    .last()
    .click();
  await expect(page.getByText("The email or password is incorrect.")).toBeVisible();
  await expect(page.getByLabel(/^Email/u)).toHaveValue(owner.email);
  await expect(page.getByLabel(/^Password/u)).toHaveValue("");

  await page.getByLabel(/^Password/u).fill(PASSWORD);
  await page
    .getByRole("button", { name: /^Sign in/u })
    .last()
    .click();
  await page.waitForURL("**/dashboard/reports");
  await expectNoSecrets(page);

  // A live session never shows the form again; unsafe targets fall back to the dashboard.
  await page.goto("/login?returnTo=%2Fdashboard%2Fmedia");
  await page.waitForURL("**/dashboard/media");
  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2F");
  await page.waitForURL("**/dashboard/quizzes");

  const status = await page.evaluate(async (api) => {
    const response = await fetch(`${api}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Kabuki-Client": "web-v1" },
      body: "{}",
    });
    return response.status;
  }, API);
  expect(status).toBe(200);
  await page.goto("/login");
  await expect(page.getByLabel(/^Email/u)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/u);
});

test("registration follows the SINGLE_ADMIN, INVITE_ONLY and PUBLIC policies", async ({
  browser,
}) => {
  await setRegistrationMode("SINGLE_ADMIN");
  const closed = await (await newClient(browser)).newPage();
  await closed.goto("/register");
  await expect(closed).toHaveTitle("Create an account · Kabuki Neko");
  await expect(
    closed.getByText(
      "Registration is closed on this instance. Sign in if you already have an account.",
    ),
  ).toBeVisible();
  await expect(closed.getByLabel(/^Email/u)).toHaveCount(0);

  await setRegistrationMode("INVITE_ONLY");
  const code = await createInvite();
  const invited = await (await newClient(browser)).newPage();
  await invited.goto("/register");
  await expect(invited.getByLabel(/^Invite code/u)).toBeVisible();
  await fillRegister(invited, { name: "Citra Creator", email: "citra@example.com" }, code);
  await invited.getByRole("button", { name: /^Create account/u }).click();
  await invited.waitForURL("**/dashboard/quizzes");
  await expectNoSecrets(invited);

  const reused = await (await newClient(browser)).newPage();
  await reused.goto("/register");
  await fillRegister(reused, { name: "Dewi Late", email: "dewi@example.com" }, code);
  await reused.getByRole("button", { name: /^Create account/u }).click();
  await expect(
    reused.getByText("Check the invite code or email address and try again."),
  ).toBeVisible();
  await expect(reused.getByLabel(/^Invite code/u)).toHaveAttribute("aria-invalid", "true");
  await expect(reused.getByLabel(/^Name/u)).toHaveValue("Dewi Late");

  await setRegistrationMode("PUBLIC");
  const open = await (await newClient(browser)).newPage();
  await open.goto("/register");
  await expect(open.getByLabel(/^Name/u)).toBeVisible();
  await expect(open.getByLabel(/^Invite code/u)).toHaveCount(0);
  await fillRegister(open, { name: "Eka Public", email: "eka@example.com" });
  await open.getByRole("button", { name: /^Create account/u }).click();
  await open.waitForURL("**/dashboard/quizzes");

  expect((await users()).meta.total).toBe(3);
  expect((await users("&role=SUPERADMIN")).meta.total).toBe(1);
  expect((await users("&role=CREATOR")).meta.total).toBe(2);
});
