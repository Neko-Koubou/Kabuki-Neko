/**
 * TASK-173 responsive layouts against the production web build (Design §2.4, §4, §7.3; SA §8.3;
 * US-09, US-18, US-21).
 *
 * Covered:
 * - Public, auth, dashboard and studio routes at 320, 390, 768 and 1280 px wide: no horizontal
 *   scrolling, and the page's main heading stays on screen.
 * - 200% browser zoom: a 1280×900 window at 200% is a 640×450 CSS viewport at device scale 2;
 *   the same routes reflow without horizontal scrolling (WCAG 1.4.10).
 * - Japanese and Simplified Chinese at 320 px: CJK text wraps without horizontal scrolling.
 *   Right-to-left and long-text (German) layouts at 320 px are covered by localization.spec.
 * - Projector host stage (PROJECTOR is the default display mode) at 1280×720 and 1920×1080: the
 *   question text and every answer's text are on screen without scrolling, and the PIN is
 *   readable in the lobby.
 * - Reduced motion: with `prefers-reduced-motion: reduce` no CSS animation or transition keeps
 *   running on the landing, join or host pages.
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
/** Public and auth routes. */
const PUBLIC_ROUTES = [
  "/",
  "/join",
  "/login",
  "/register",
  "/about",
  "/help/languages",
  "/nowhere",
];
/** The phone, large phone, tablet and desktop widths of Design §2.4. */
const WIDTHS = [320, 390, 768, 1280];

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  quizId: string;
  sockets: Socket[];
  contexts: BrowserContext[];
} = { api: null, token: "", quizId: "", sockets: [], contexts: [] };

/** Client address counter (each signed-in page load renews the session, limited per address). */
let address = 1;

/** Asserts no horizontal scrolling and a visible level-1 heading. */
async function expectReflow(page: Page, where: string) {
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect({ where, overflow }).toEqual({ where, overflow: 0 });
  const heading = page.getByRole("heading", { level: 1 }).first();
  if ((await heading.count()) > 0) await expect(heading).toBeInViewport({ ratio: 0.5 });
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

/**
 * A browser context signed in with the API session's refresh cookie. It is created once per
 * test, from a fresh API sign-in, because a refresh cookie may only be rotated by one holder.
 */
async function adminContext(
  browser: Browser,
  options: { viewport: { width: number; height: number }; deviceScaleFactor?: number },
) {
  if (!state.api) throw new Error("setup missing");
  const api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: {
      Origin: WEB,
      "X-Kabuki-Client": "web-v1",
      "X-Forwarded-For": `10.75.0.${(address % 200) + 2}`,
    },
  });
  await adminToken(api);
  const context = await browser.newContext({ ...options, storageState: await api.storageState() });
  await api.dispose();
  await context.route(`${API}/**`, (route) =>
    route
      .continue({
        headers: {
          ...route.request().headers(),
          "x-forwarded-for": `10.75.${Math.floor(address / 200) + 1}.${(address % 200) + 1}`,
        },
      })
      .catch(() => undefined),
  );
  state.contexts.push(context);
  return context;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  state.api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.75.0.1" },
  });
  state.token = await adminToken(state.api);
  const auth = { Authorization: `Bearer ${state.token}` };
  const created = await state.api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Tata Letak dengan judul yang cukup panjang untuk dibungkus" },
  });
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  const saved = await state.api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Tata Letak dengan judul yang cukup panjang untuk dibungkus",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        {
          ...blank,
          id: randomUUID(),
          orderIndex: 0,
          type: "SINGLE_CHOICE",
          promptText:
            "Manakah dari kota-kota berikut yang merupakan ibu kota provinsi di Pulau Jawa bagian timur?",
          timeLimitSec: 30,
          pointsMultiplier: 1,
          explanationText: null,
          options: [
            ["Surabaya, ibu kota Jawa Timur", true],
            ["Semarang, ibu kota Jawa Tengah", false],
            ["Bandung, ibu kota Jawa Barat", false],
            ["Yogyakarta, Daerah Istimewa", false],
          ].map(([optionText, isCorrect], index) => ({
            id: randomUUID(),
            optionIndex: index,
            colorIndex: index,
            optionText,
            isCorrect,
            sortOrder: index,
          })),
        },
      ],
    },
  });
  const detail = (await saved.json()) as { id: string; isPlayable: boolean };
  expect(detail.isPlayable).toBe(true);
  state.quizId = detail.id;
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
});

test("public and auth pages reflow at 320, 390, 768 and 1280 px and at 200% zoom", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    state.contexts.push(context);
    const page = await context.newPage();
    for (const route of PUBLIC_ROUTES) {
      await page.goto(route);
      await expectReflow(page, `${width}px ${route}`);
    }
    await context.close();
  }
  const zoomed = await browser.newContext({
    viewport: { width: 640, height: 450 },
    deviceScaleFactor: 2,
  });
  state.contexts.push(zoomed);
  const page = await zoomed.newPage();
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route);
    await expectReflow(page, `200% ${route}`);
  }
});

test("dashboard and studio pages reflow at every width and at 200% zoom", async ({ browser }) => {
  test.setTimeout(300_000);
  const routes = [
    "/dashboard/quizzes",
    `/dashboard/quizzes/${state.quizId}`,
    `/studio/${state.quizId}`,
    "/dashboard/media",
    "/dashboard/reports",
    "/dashboard/settings",
    "/dashboard/users",
  ];
  for (const [viewport, deviceScaleFactor, label] of [
    ...WIDTHS.map((width) => [{ width, height: 800 }, 1, `${width}px`] as const),
    [{ width: 640, height: 450 }, 2, "200%"] as const,
  ]) {
    address += 11;
    const context = await adminContext(browser, { viewport, deviceScaleFactor });
    const page = await context.newPage();
    for (const route of routes) {
      address += 1;
      await page.goto(route);
      await expectReflow(page, `${label} ${route}`);
    }
    await context.close();
  }
});

test("Japanese and Simplified Chinese wrap at 320 px", async ({ browser }) => {
  for (const tag of ["ja", "zh-Hans"]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
    state.contexts.push(context);
    await context.addCookies([{ name: "kn_locale", value: tag, url: WEB }]);
    const page = await context.newPage();
    for (const route of ["/", "/join", "/login", "/about"]) {
      await page.goto(route);
      await expect(page.locator("html")).toHaveAttribute("lang", tag);
      await expectReflow(page, `${tag} ${route}`);
    }
    await context.close();
  }
});

test("the projector stage shows the question and every answer without scrolling", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  address += 23;
  const context = await adminContext(browser, { viewport: { width: 1280, height: 720 } });
  const host = await context.newPage();
  await host.goto(`/studio/${state.quizId}`);
  const header = host.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  await header.getByRole("button", { name: "Host a game" }).click();
  // PROJECTOR is the default display mode.
  await host.getByRole("button", { name: "Open lobby" }).click();
  await host.waitForURL(/\/host\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  const stage = host.locator("main [data-phase]").first();
  await expect(stage).toHaveAttribute("data-phase", "LOBBY", { timeout: 20_000 });
  const pinLabel = host.getByLabel(/^PIN \d{6}$/u);
  await expect(pinLabel).toBeInViewport();
  const pin = ((await pinLabel.getAttribute("aria-label")) ?? "").slice(4);

  // One socket player keeps the question open.
  const player = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1 },
    extraHeaders: { origin: WEB, "x-forwarded-for": "10.75.9.9" },
    reconnection: false,
  });
  state.sockets.push(player);
  await new Promise<void>((resolve, reject) => {
    player.once("connect", () => resolve());
    player.once("connect_error", reject);
  });
  await player.timeout(10_000).emitWithAck("player:join_room", {
    requestId: randomUUID(),
    pinCode: pin,
    nickname: "Layar",
    avatar: { style: "bottts", seed: "layar" },
  });
  await expect(host.getByText("Layar", { exact: true })).toBeVisible();
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(stage).toHaveAttribute("data-phase", "QUESTION_ANSWERING", { timeout: 25_000 });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await host.setViewportSize(viewport);
    const where = `${viewport.width}×${viewport.height}`;
    await expect(host.getByText(/^Manakah dari kota-kota berikut/u).first()).toBeInViewport();
    for (const text of [
      "Surabaya, ibu kota Jawa Timur",
      "Semarang, ibu kota Jawa Tengah",
      "Bandung, ibu kota Jawa Barat",
      "Yogyakarta, Daerah Istimewa",
    ])
      await expect(host.getByText(text, { exact: true }).first()).toBeInViewport();
    expect(
      await host.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      where,
    ).toBe(0);
  }
  await host.close();
});

test("reduced motion leaves no animation or transition running", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  state.contexts.push(context);
  const page = await context.newPage();
  for (const route of ["/", "/join", "/about"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => {
          if (animation.playState !== "running") return false;
          const timing = animation.effect?.getComputedTiming();
          return Number(timing?.duration ?? 0) > 10;
        })
        .map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
    );
    expect({ route, running }).toEqual({ route, running: [] });
  }
});
