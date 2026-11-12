/**
 * TASK-146 end-to-end quiz studio (S07) against the real API and the production web build.
 *
 * Covered:
 * - A signed-in creator builds all six question types, reorders, duplicates and deletes slides,
 *   saves with Ctrl+S and finds everything after a refresh. The saved, playable revision can be
 *   hosted.
 * - A language switch never makes the draft dirty.
 * - A save conflict from another tab keeps the local draft, and "Reload saved version" brings the
 *   server version back.
 * - A zero-slide draft saves and reloads as the empty canvas; hosting stays unavailable.
 * - Leaving with unsaved edits opens M10.
 * - Layouts:
 *   - 320 px: Slides/Editor/Properties tabs;
 *   - 768 px: slides drawer;
 *   - 1280 px: three columns.
 *   None has horizontal overflow.
 *
 * Each browser context signs in with its own client address (per-IP auth limits).
 */
import { randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may already have (studio-only run, or created by earlier specs). */
const ADMINS = [
  "studio-admin@example.com",
  "player-admin@example.com",
  "join-admin@example.com",
  "admin@example.com",
  "rival@example.com",
];

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: { api: APIRequestContext | null; token: string; email: string } = {
  api: null,
  token: "",
  email: "",
};

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.70.0.1" },
  });
}

/** Signs in an administrator (first-run setup when needed); returns token and email. */
async function admin(api: APIRequestContext): Promise<{ token: string; email: string }> {
  const status = (await (await api.get("/api/v1/auth/setup-status")).json()) as {
    isInitialized: boolean;
  };
  if (!status.isInitialized) {
    const email = ADMINS[0] ?? "";
    const setup = await api.post("/api/v1/auth/setup", {
      headers: { "Idempotency-Key": randomUUID() },
      data: { instanceName: "Kabuki E2E", name: "Studio Admin", email, password: PASSWORD },
    });
    if (setup.status() === 201)
      return { token: ((await setup.json()) as { accessToken: string }).accessToken, email };
  }
  for (const email of ADMINS) {
    const login = await api.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
    if (login.status() === 200)
      return { token: ((await login.json()) as { accessToken: string }).accessToken, email };
  }
  throw new Error("No administrator could sign in");
}

/** Creates a quiz (one empty slide) through the API. */
async function createQuiz(title: string): Promise<string> {
  if (!state.api) throw new Error("api missing");
  const created = await state.api.post("/api/v1/quizzes", {
    headers: { Authorization: `Bearer ${state.token}`, "Idempotency-Key": randomUUID() },
    data: { title },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Opens the studio for `quizId` in a signed-in context with its own address. */
async function openStudio(
  browser: Browser,
  quizId: string,
  address: string,
  viewport = { width: 1280, height: 900 },
) {
  const context = await browser.newContext({ viewport });
  // Added at the network layer (after CORS), as a reverse proxy would.
  await context.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
  );
  const page = await context.newPage();
  await page.goto(`/login?returnTo=${encodeURIComponent(`/studio/${quizId}`)}`);
  await page.getByLabel(/^Email/u).fill(state.email);
  await page.getByLabel(/^Password/u).fill(PASSWORD);
  // The per-email sign-in limit (5/min) is shared with other specs using this administrator:
  // a "Too many attempts" answer waits for the server's retry time and signs in again.
  const limited = page.getByText(/Too many attempts/u);
  const signedIn = () => new URL(page.url()).pathname === `/studio/${quizId}`;
  for (let attempt = 0; ; attempt += 1) {
    await page
      .getByRole("button", { name: /^Sign in/u })
      .last()
      .click();
    await expect
      .poll(async () => signedIn() || (await limited.isVisible()), { timeout: 30_000 })
      .toBe(true);
    if (signedIn()) break;
    if (attempt >= 3) throw new Error("sign-in stayed rate limited");
    const waitMs = Number(
      /about ([\d,]+) ms/u.exec((await limited.textContent()) ?? "")?.[1]?.replace(/,/gu, "") ??
        "15000",
    );
    await page.waitForTimeout(Math.min(waitMs, 60_000) + 1_000);
  }
  await expect(page.locator("header[data-dirty]")).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

/** The studio header (status, save, host). */
const header = (page: Page) => page.locator("header[data-dirty]");
/** The prompt field of the selected question. */
const prompt = (page: Page) => page.getByRole("textbox", { name: /^Question/u });

/** Fills option texts A–D (or fewer). */
async function fillOptions(page: Page, texts: string[]) {
  for (const [index, text] of texts.entries())
    await page.getByLabel(new RegExp(`^Answer option ${"ABCD"[index]}`, "u")).fill(text);
}

/** Adds a slide and turns it into `type`. */
async function addSlide(page: Page, type: string) {
  await page.getByRole("button", { name: "Add slide" }).click();
  await page.getByLabel(/^Question type/u).selectOption(type);
}

/** No horizontal page overflow. */
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(
    0,
  );
}

test.beforeAll(async () => {
  const api = await apiContext();
  const { token, email } = await admin(api);
  state.api = api;
  state.token = token;
  state.email = email;
});

test.afterAll(async () => {
  await state.api?.dispose();
});

test("builds all six types, reorders, duplicates, deletes, saves and keeps them after a refresh", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const quizId = await createQuiz("Kuis Studio E2E");
  const { page, context } = await openStudio(browser, quizId, "10.70.1.1");
  await expect(page.getByRole("heading", { level: 1, name: "Kuis Studio E2E" })).toBeVisible();
  await expect(header(page)).toHaveAttribute("data-dirty", "false");

  await prompt(page).fill("Ibu kota Indonesia?");
  // The API's first slide is a two-option single choice.
  await fillOptions(page, ["Jakarta", "Bandung"]);
  await page.getByRole("radio", { name: "Correct answer: A" }).check();
  await expect(header(page)).toHaveAttribute("data-dirty", "true");
  await expect(header(page).getByText("Unsaved changes")).toBeVisible();

  await addSlide(page, "TRUE_FALSE");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await prompt(page).fill("Kucing adalah mamalia.");
  await page.getByRole("radio", { name: "Correct answer: A" }).check();

  await addSlide(page, "MULTIPLE_SELECT");
  await prompt(page).fill("Kota di Pulau Jawa?");
  await fillOptions(page, ["Bandung", "Surabaya", "Medan", "Makassar"]);
  await page.getByRole("checkbox", { name: "Correct answer: A" }).check();
  await page.getByRole("checkbox", { name: "Correct answer: B" }).check();

  await addSlide(page, "TYPE_ANSWER");
  await prompt(page).fill("Bahasa Jepang untuk kucing?");
  await page.getByLabel(/^Accepted answers 1/u).fill("Neko");

  await addSlide(page, "ORDER_PUZZLE");
  await prompt(page).fill("Urutkan dari kecil ke besar.");
  await fillOptions(page, ["Satu", "Dua", "Tiga", "Empat"]);

  await addSlide(page, "POLL");
  await prompt(page).fill("Warna favoritmu?");
  await fillOptions(page, ["Merah", "Biru", "Hijau", "Kuning"]);
  await expect(page.getByText("Some questions are incomplete.", { exact: false })).toHaveCount(0);

  // Reorder, duplicate and delete by stable slide identity.
  await page.getByRole("button", { name: "Move up: Slide 2 of 6" }).click();
  await expect(page.locator("ol > li").first()).toContainText("Kucing adalah mamalia.");
  await page.getByRole("button", { name: "Duplicate slide: Slide 1 of 6" }).click();
  await expect(page.locator("ol > li")).toHaveCount(7);
  await page.getByRole("button", { name: "Delete slide: Slide 2 of 7" }).click();
  await expect(page.locator("ol > li")).toHaveCount(6);

  await page.keyboard.press("Control+s");
  await expect(header(page)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await expect(header(page).getByText(/^Saved at /u)).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Host a game" })).toBeEnabled();

  await page.reload();
  await expect(header(page)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await expect(page.locator("ol > li")).toHaveCount(6);
  const prompts = await page.locator("ol > li").allInnerTexts();
  expect(prompts.map((text) => text.split("\n").find((line) => !line.startsWith("Slide")))).toEqual(
    [
      "Kucing adalah mamalia.",
      "Ibu kota Indonesia?",
      "Kota di Pulau Jawa?",
      "Bahasa Jepang untuk kucing?",
      "Urutkan dari kecil ke besar.",
      "Warna favoritmu?",
    ],
  );
  await expect(header(page).getByText("All changes saved")).toBeVisible();

  // A language switch keeps the saved draft clean.
  await page.getByRole("button", { name: /^Language/u }).click();
  await page.getByRole("button", { name: "Bahasa Indonesia" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
  await expect(header(page)).toHaveAttribute("data-dirty", "false");
  await expect(page.locator("ol > li")).toHaveCount(6);
  await page
    .getByRole("button", { name: /^Bahasa/u })
    .first()
    .click();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectNoOverflow(page);
  await context.close();
});

test("keeps the draft on a conflict from another tab and reloads the saved version on request", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const quizId = await createQuiz("Kuis Konflik E2E");
  const { page, context } = await openStudio(browser, quizId, "10.70.1.2");
  const other = await context.newPage();
  await other.goto(`/studio/${quizId}`);
  await expect(header(other)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });

  await prompt(other).fill("Diubah di tab lain");
  await other.getByRole("button", { name: "Save draft" }).click();
  await expect(header(other)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });

  await prompt(page).fill("Draf lokal");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByText(
      "This quiz was changed elsewhere since you opened it. Keep your draft or reload the saved version.",
    ),
  ).toBeVisible();
  await expect(prompt(page)).toHaveValue("Draf lokal");
  await expect(header(page)).toHaveAttribute("data-dirty", "true");
  await page.getByRole("button", { name: "Reload saved version" }).click();
  await expect(prompt(page)).toHaveValue("Diubah di tab lain");
  await expect(header(page)).toHaveAttribute("data-dirty", "false");
  await context.close();
});

test("saves a zero-slide draft, guards unsaved navigation and adapts to 320, 768 and 1280 px", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const quizId = await createQuiz("Kuis Kosong E2E");
  const { page, context } = await openStudio(browser, quizId, "10.70.1.3", {
    width: 320,
    height: 800,
  });
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(["Slides", "Editor", "Properties"]);
  await expectNoOverflow(page);
  await page.getByRole("tab", { name: "Slides" }).click();
  await page.getByRole("button", { name: "Delete slide: Slide 1 of 1" }).click();
  await expect(page.getByText("No slides yet. Add a question to create one.")).toBeVisible();
  await page.getByRole("tab", { name: "Editor" }).click();
  await expect(page.getByText("No questions yet. Add one to get started.")).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(header(page)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await page.reload();
  await expect(header(page)).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await expect(page.getByText("No questions yet. Add one to get started.")).toBeVisible();
  await expect(header(page).getByRole("button", { name: /^Host a game/u })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Unsaved edits: leaving asks first (M10).
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(header(page)).toHaveAttribute("data-dirty", "true");
  await header(page).getByRole("button", { name: "Back" }).click();
  const guard = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Stay on this page" }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/${quizId}$`, "u"));

  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole("button", { name: "Slides" }).click();
  const drawer = page.getByRole("dialog", { name: "Slides" });
  await expect(drawer.getByRole("button", { name: "Add slide" })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expectNoOverflow(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("heading", { name: "Slides" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Question editor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Properties" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expectNoOverflow(page);
  await context.close();
});
