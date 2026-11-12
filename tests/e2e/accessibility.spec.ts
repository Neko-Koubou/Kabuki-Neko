/**
 * TASK-173 accessibility verification against the production web build (Design §7; SA §8.3;
 * US-09, US-18, US-21).
 *
 * Automated, with axe-core (WCAG 2.0/2.1/2.2 A and AA rules, contrast included):
 * - every route group in the states people actually see:
 *   - public and auth pages, also with a sign-in error;
 *   - the dashboard pages, quiz detail and studio;
 *   - an open dialog;
 *   - the host lobby, question and reveal, and the player join, lobby, question and reveal;
 *   - the finished report;
 *   - fallbacks;
 *   - the dark theme;
 * - keyboard-only flows with no pointer events at all (`press`/`fill` only):
 *   - the guest join;
 *   - all six answer types, including the order puzzle's move buttons;
 *   - host moderation (Remove through M09) and every host phase control;
 *   - studio slide reordering with focus kept on the moved slide;
 * - dialogs: a destructive confirmation starts on Cancel, Tab stays inside, Escape closes and
 *   focus returns to the trigger.
 *
 * Automated checks are not WCAG certification. Screen-reader output, IME on real devices, the
 * virtual keyboard and safe areas need people with real assistive technology. They are listed in
 * docs/accessibility-verification.md and stay "not verified" until someone checks them.
 */
import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { io, type Socket } from "socket.io-client";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
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
/** axe rule tags: WCAG 2.0, 2.1 and 2.2 at levels A and AA. */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  admin: BrowserContext | null;
  quizId: string;
  sessionId: string;
  sockets: Socket[];
  contexts: BrowserContext[];
} = { api: null, token: "", admin: null, quizId: "", sessionId: "", sockets: [], contexts: [] };

/** Client address of the signed-in context; renewals are limited per address, so it rotates. */
let address = 1;

/** Runs axe on the current page and fails with every violation's rule, target and reason. */
async function expectAccessible(page: Page, where: string) {
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const violations = result.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id} ${node.target.join(" ")}: ${node.any[0]?.message ?? violation.help}`,
    ),
  );
  expect({ where, violations }).toEqual({ where, violations: [] });
}

/** Signs in an administrator (waiting out a per-email limit once). */
async function adminToken(api: APIRequestContext): Promise<string> {
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

/** The administrator's browser context (refresh cookie of the API sign-in, used once). */
async function adminContext(browser: Browser) {
  if (state.admin) return state.admin;
  if (!state.api) throw new Error("setup missing");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: await state.api.storageState(),
  });
  await context.route(`${API}/**`, (route) =>
    route
      .continue({
        headers: {
          ...route.request().headers(),
          "x-forwarded-for": `10.74.${Math.floor(address / 200) + 1}.${(address % 200) + 1}`,
        },
      })
      .catch(() => undefined),
  );
  state.admin = context;
  state.contexts.push(context);
  return context;
}

/** Moves the admin context to a fresh client address (each page load renews the session). */
const nextAddress = () => {
  address += 7;
};

/** Creates the six-type playable quiz (one question per answer type). */
async function sixTypeQuiz(api: APIRequestContext, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Aksesibilitas" },
  });
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  const question = (
    orderIndex: number,
    type: string,
    promptText: string,
    options: [string, boolean?][],
  ) => ({
    ...blank,
    id: randomUUID(),
    orderIndex,
    type,
    promptText,
    timeLimitSec: 30,
    pointsMultiplier: type === "POLL" ? 0 : 1,
    explanationText: orderIndex === 0 ? "Jakarta adalah ibu kota Indonesia." : null,
    options: options.map(([optionText, isCorrect = false], index) => ({
      id: randomUUID(),
      optionIndex: index,
      colorIndex: type === "TYPE_ANSWER" ? 0 : index,
      optionText,
      isCorrect,
      sortOrder: index,
    })),
  });
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Aksesibilitas",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        question(0, "SINGLE_CHOICE", "Ibu kota Indonesia?", [["Jakarta", true], ["Bandung"]]),
        question(1, "TRUE_FALSE", "Kucing adalah mamalia.", [["Benar", true], ["Salah"]]),
        question(2, "MULTIPLE_SELECT", "Pilih kota di Pulau Jawa.", [
          ["Bandung", true],
          ["Surabaya", true],
          ["Medan"],
        ]),
        question(3, "TYPE_ANSWER", "Apa bahasa Jepang untuk kucing?", [["Neko", true]]),
        question(4, "ORDER_PUZZLE", "Urutkan dari kecil ke besar.", [
          ["Satu"],
          ["Dua"],
          ["Tiga"],
          ["Empat"],
        ]),
        question(5, "POLL", "Warna favoritmu?", [["Merah"], ["Biru"]]),
      ],
    },
  });
  const detail = (await saved.json()) as { id: string; isPlayable: boolean };
  expect(detail.isPlayable, JSON.stringify(detail)).toBe(true);
  return detail.id;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  state.api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.74.0.1" },
  });
  state.token = await adminToken(state.api);
  state.quizId = await sixTypeQuiz(state.api, state.token);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
});

test("public, auth, dashboard and studio pages pass axe in light and dark themes", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const colorScheme of ["light", "dark"] as const) {
    const anonymous = await browser.newContext({ colorScheme });
    state.contexts.push(anonymous);
    const page = await anonymous.newPage();
    for (const url of [
      "/",
      "/join",
      "/login",
      "/register",
      "/about",
      "/help/languages",
      "/play/123456",
      "/nowhere",
    ]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await expectAccessible(page, `${colorScheme} ${url}`);
    }
    // A real error state: a rejected sign-in.
    await page.goto("/login");
    await page.getByLabel(/^Email/u).fill("nobody@example.com");
    await page.getByLabel(/^Password/u).fill("not the right password");
    await page
      .getByRole("button", { name: /^Sign in/u })
      .last()
      .press("Enter");
    await expect(page.getByText("The email or password is incorrect.")).toBeVisible();
    await expectAccessible(page, `${colorScheme} login error`);
  }

  const context = await adminContext(browser);
  const page = await context.newPage();
  for (const url of [
    "/dashboard/quizzes",
    `/dashboard/quizzes/${state.quizId}`,
    `/studio/${state.quizId}`,
    "/dashboard/media",
    "/dashboard/reports",
    "/dashboard/settings",
    "/dashboard/users",
    "/dashboard/about",
  ]) {
    nextAddress();
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    await expectAccessible(page, url);
  }
  // Dark theme on a dense dashboard page.
  await page.emulateMedia({ colorScheme: "dark" });
  nextAddress();
  await page.goto("/dashboard/settings");
  await page.waitForLoadState("networkidle");
  await expectAccessible(page, "dark /dashboard/settings");
  await page.emulateMedia({ colorScheme: "light" });
  await page.close();
});

test("dialogs start on Cancel for destructive actions, trap Tab and return focus", async ({
  browser,
}) => {
  const page = await (await adminContext(browser)).newPage();
  nextAddress();
  await page.goto(`/dashboard/quizzes/${state.quizId}`);
  const trigger = page.getByRole("button", { name: "Delete quiz" });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAccessible(page, "M09 open");
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  nextAddress();
  await page.goto(`/studio/${state.quizId}`);
  await expect(page.locator("header[data-dirty]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("ol > li")).toHaveCount(6);
  // Slides reorder by keyboard; focus stays on the moved slide's control.
  const move = page.getByRole("button", { name: "Move up: Slide 2 of 6" });
  await move.press("Enter");
  const prompts = await page.locator("ol > li").allInnerTexts();
  expect(prompts[0]).toContain("Kucing adalah mamalia.");
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
  ).toMatch(/Slide 1 of 6/u);
  await page.close();
});

test("a whole game by keyboard only, with every phase passing axe", async ({ browser }) => {
  test.setTimeout(300_000);
  // Host: open the lobby from the studio with the keyboard.
  const host = await (await adminContext(browser)).newPage();
  nextAddress();
  await host.goto(`/studio/${state.quizId}`);
  const header = host.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  await header.getByRole("button", { name: "Host a game" }).press("Enter");
  await host.getByRole("button", { name: "Open lobby" }).press("Enter");
  await host.waitForURL(/\/host\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  state.sessionId = new URL(host.url()).pathname.split("/").at(-1) ?? "";
  const stage = host.locator("main [data-phase]").first();
  await expect(stage).toHaveAttribute("data-phase", "LOBBY", { timeout: 20_000 });
  const pin = ((await host.getByLabel(/^PIN \d{6}$/u).getAttribute("aria-label")) ?? "").slice(4);
  await expectAccessible(host, "host lobby (empty)");

  // A disruptive socket player the host removes by keyboard through M09.
  const usil = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1 },
    extraHeaders: { origin: WEB, "x-forwarded-for": "10.74.9.9" },
    reconnection: false,
  });
  state.sockets.push(usil);
  await new Promise<void>((resolve, reject) => {
    usil.once("connect", () => resolve());
    usil.once("connect_error", reject);
  });
  await usil.timeout(10_000).emitWithAck("player:join_room", {
    requestId: randomUUID(),
    pinCode: pin,
    nickname: "Usil",
    avatar: { style: "bottts", seed: "usil" },
  });
  await host.getByRole("button", { name: "Remove: Usil" }).press("Enter");
  const confirm = host.getByRole("dialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAccessible(host, "host M09 remove");
  await confirm.getByRole("button", { name: "Remove player" }).press("Enter");
  await expect(host.getByText("Usil", { exact: true })).toHaveCount(0);

  // Player: join with the keyboard only.
  const playerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "X-Forwarded-For": "10.74.8.8" },
  });
  state.contexts.push(playerContext);
  const player = await playerContext.newPage();
  await player.goto(`/join?pin=${pin}`);
  await expect(player.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await expectAccessible(player, "player M01 identity");
  await player.getByLabel(/^Nickname/u).fill("Neko");
  await player.getByRole("button", { name: "Join game" }).press("Enter");
  await player.waitForURL(`**/play/${pin}`);
  await expect(player.getByText("Waiting for the host to start…")).toBeVisible();
  await expectAccessible(player, "player lobby");
  await expect(host.getByText("Neko", { exact: true })).toBeVisible();
  await expectAccessible(host, "host lobby (one player)");
  // Start by keyboard once the button is enabled; if the roster update raced the key press, the
  // phase is still LOBBY and the key press is repeated (the server starts a room only once).
  const start = host.getByRole("button", { name: "Start game" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await stage.getAttribute("data-phase")) !== "LOBBY") break;
    await expect(start).toBeEnabled();
    await start.press("Enter");
    await expect
      .poll(() => stage.getAttribute("data-phase"), { timeout: 8_000 })
      .not.toBe("LOBBY")
      .catch(() => undefined);
  }
  await expect(stage).not.toHaveAttribute("data-phase", "LOBBY");

  const accepted = player.getByText("Answer received Your answer is locked in.");
  /** Host: reveal → leaderboard → next question (or podium after the last one). */
  const advance = async (last: boolean) => {
    await expect(stage).toHaveAttribute("data-phase", "ANSWER_REVEAL", { timeout: 25_000 });
    if (last) return host.getByRole("button", { name: "Show podium" }).press("Enter");
    await host.getByRole("button", { name: "Show leaderboard" }).press("Enter");
    await expect(stage).toHaveAttribute("data-phase", "LEADERBOARD");
    await host.getByRole("button", { name: "Next question" }).press("Enter");
  };

  // 1. Single choice (axe on the question and the reveal for both roles).
  const jakarta = player.getByRole("button", { name: "Option A, ▲: Jakarta" });
  await expect(jakarta).toBeVisible({ timeout: 25_000 });
  await expectAccessible(player, "player single choice");
  await expectAccessible(host, "host answering");
  await jakarta.press("Enter");
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await expectAccessible(player, "player reveal");
  await expect(stage).toHaveAttribute("data-phase", "ANSWER_REVEAL", { timeout: 25_000 });
  await expectAccessible(host, "host reveal");
  await advance(false);

  // 2. True/false with Space.
  const benar = player.getByRole("button", { name: "Option A, ▲: Benar" });
  await expect(benar).toBeVisible({ timeout: 25_000 });
  await benar.press("Space");
  await expect(accepted.or(player.getByRole("heading", { name: "Correct!" }))).toBeVisible();
  await advance(false);

  // 3. Multiple select: toggles with Space, then submit with Enter.
  const bandung = player.getByRole("button", { name: "Option A, ▲: Bandung" });
  await expect(bandung).toBeVisible({ timeout: 25_000 });
  await bandung.press("Space");
  await player.getByRole("button", { name: "Option B, ◆: Surabaya" }).press("Space");
  await expectAccessible(player, "player multiple select (selected state)");
  await player.getByRole("button", { name: "Submit answer (2)" }).press("Enter");
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await advance(false);

  // 4. Typed answer: Enter submits.
  const typed = player.getByLabel("Type your answer");
  await expect(typed).toBeVisible({ timeout: 25_000 });
  await expectAccessible(player, "player typed answer");
  await typed.fill("neko");
  await typed.press("Enter");
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await advance(false);

  // 5. Order puzzle with the keyboard move buttons.
  await expect(player.getByText("Put the items in the right order.")).toBeVisible({
    timeout: 25_000,
  });
  await expectAccessible(player, "player order puzzle");
  for (const [position, word] of ["Satu", "Dua", "Tiga", "Empat"].entries())
    for (let guard = 0; guard < 4; guard += 1) {
      const order = await player.locator("ol > li").allInnerTexts();
      if (order.findIndex((text) => text.includes(word)) <= position) break;
      await player
        .getByRole("button", { name: new RegExp(`^Move item up Option .+: ${word}$`, "u") })
        .press("Enter");
    }
  await player.getByRole("button", { name: "Submit answer" }).press("Enter");
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await advance(false);

  // 6. Poll.
  const biru = player.getByRole("button", { name: "Option B, ◆: Biru" });
  await expect(biru).toBeVisible({ timeout: 25_000 });
  await biru.press("Enter");
  await expect(player.getByRole("heading", { name: "Thanks for voting!" })).toBeVisible({
    timeout: 20_000,
  });
  await advance(true);

  await expect(host.getByRole("heading", { name: "Game over" })).toBeVisible({ timeout: 25_000 });
  await expect(player.getByRole("heading", { name: "Game over" })).toBeVisible({ timeout: 25_000 });
  await expectAccessible(host, "host finished");
  await expectAccessible(player, "player finished");
  await expect(host.getByText("The report is ready.")).toBeVisible({ timeout: 30_000 });
  nextAddress();
  await host.goto(`/dashboard/reports/${state.sessionId}`);
  await expect(host.getByRole("heading", { name: "Kuis Aksesibilitas" })).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(host, "report detail");
  await host.close();
});
