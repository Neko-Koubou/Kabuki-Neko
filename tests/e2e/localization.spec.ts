/**
 * TASK-172 locale runtime end to end against the production web build (SA §8.2; US-21,
 * AC-21-01..04).
 *
 * Setup:
 * - `pnpm locales:build` installs two genuine extra languages as partial external packages:
 *   German (long text) and Arabic (right-to-left).
 * - The bundle goes into the web server's private copy of the locale bundle (`KN_LOCALES_DIR` from
 *   playwright.config); `afterAll` rebuilds without them, which restores the original bundle.
 * - No component or enum is changed. Browsers fetch the catalogs from the same directory (routed),
 *   exactly what a rebuilt `public/locales` would serve.
 * - The shipped `apps/web/public/locales` is never written. The pseudo-locales en-XA and ar-XB
 *   cannot be built into a bundle at all; that is proven in
 *   `tests/contracts/localization-roundtrip.spec.ts`.
 *
 * Covered:
 * - Picker: every installed language is listed (8), with no fixed list. German switches the UI,
 *   untranslated text falls back to English, the choice is saved as `kn_locale`, and SSR then
 *   renders German.
 * - Arabic sets `dir="rtl"`. German and Arabic both fit a 320 px screen without horizontal
 *   scrolling.
 * - SSR matching: cookie first; Accept-Language with region fallback (de-AT → de) and the Chinese
 *   script rules (zh-CN → zh-Hans, zh-TW → en because no zh-Hant is installed); a storage-only
 *   preference applies after hydration and writes the cookie.
 * - A failed catalog keeps the old language and the typed PIN, and offers a retry that then
 *   succeeds.
 * - Mid-game: switching with an accepted answer, also while offline, neither resends the answer
 *   nor changes the quiz content; switching with a dirty studio draft keeps the draft, stays
 *   dirty and saves nothing.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
import { ARABIC, GERMAN, writePackage } from "./fixtures/locale-packages";

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
/** The web server's locale bundle directory (a private copy, see playwright.config). */
const WEB_LOCALES = process.env["KABUKI_E2E_WEB_LOCALES"] ?? "";
const run = promisify(execFile);

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: {
  scratch: string;
  original: string;
  api: APIRequestContext | null;
  token: string;
  sockets: Socket[];
  contexts: BrowserContext[];
} = { scratch: "", original: "", api: null, token: "", sockets: [], contexts: [] };

/**
 * `pnpm locales:build` with the repository built-ins plus the packages in `external`, published
 * to a throwaway API directory and to the web server's bundle directory; returns the buildId.
 */
async function buildBundle(external: string): Promise<string> {
  const { stdout } = await run(
    path.resolve("node_modules/.bin/tsx"),
    [
      path.resolve("scripts/locales-build.ts"),
      "--builtin-root",
      path.resolve("packages/shared/locales"),
      "--external-root",
      external,
      "--out",
      path.join(state.scratch, "api-locales"),
      "--web-public",
      WEB_LOCALES,
      "--require-builtins",
      "en,id,ja,zh-Hans,es,fr",
    ],
    { cwd: process.cwd() },
  );
  const buildId = /Built catalog ([a-f0-9]{64})/u.exec(stdout)?.[1];
  if (!buildId) throw new Error(`locales:build printed no buildId: ${stdout}`);
  return buildId;
}

/** Serves `/locales/**` from the web server's bundle directory (what a rebuilt app serves). */
async function serveBundle(context: BrowserContext) {
  await context.route(`${WEB}/locales/**`, async (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace(
      /^\/locales\//u,
      "",
    );
    const file = path.resolve(WEB_LOCALES, relative);
    if (!file.startsWith(`${WEB_LOCALES}${path.sep}`)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: await readFile(file),
      });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

/** A browser context with the test bundle, its own client address and optional cookie/viewport. */
async function client(
  browser: Browser,
  options: { locale?: string; cookie?: string; viewport?: { width: number; height: number } } = {},
) {
  const address = `10.73.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    locale: options.locale ?? "en-US",
    extraHTTPHeaders: { "X-Forwarded-For": address },
  });
  state.contexts.push(context);
  if (options.cookie)
    await context.addCookies([{ name: "kn_locale", value: options.cookie, url: WEB }]);
  await serveBundle(context);
  return context;
}

/** Opens the language picker and chooses the option whose native name starts with `name`. */
async function chooseLanguage(page: Page, name: string) {
  await page
    .getByRole("button", { name: /^(Language|Sprache|اللغة)/u })
    .first()
    .click();
  await page.getByRole("button", { name: new RegExp(`^${name}`, "u") }).click();
}

/** `<html lang>` of a server-rendered page for an Accept-Language header (no cookie). */
async function ssrLang(acceptLanguage: string): Promise<string> {
  const api = await request.newContext({ baseURL: WEB });
  try {
    const html = await (
      await api.get("/join", { headers: { "Accept-Language": acceptLanguage } })
    ).text();
    return /<html[^>]*\slang="([^"]+)"/u.exec(html)?.[1] ?? "";
  } finally {
    await api.dispose();
  }
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

/** Sends a socket command and returns its ACK data. */
async function command<T>(socket: Socket, event: string, payload: Record<string, unknown>) {
  const ack = (await socket
    .timeout(10_000)
    .emitWithAck(event, { requestId: randomUUID(), ...payload })) as {
    ok: boolean;
    data?: T;
    error?: unknown;
  };
  if (!ack.ok || ack.data === undefined) throw new Error(`${event}: ${JSON.stringify(ack.error)}`);
  return ack.data;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (!WEB_LOCALES) throw new Error("playwright.config did not provide KABUKI_E2E_WEB_LOCALES");
  state.scratch = await mkdtemp(path.join(tmpdir(), "kabuki-e2e-l10n-"));
  const empty = path.join(state.scratch, "none");
  const external = path.join(state.scratch, "external");
  await writePackage(external, GERMAN);
  await writePackage(external, ARABIC);
  // The original bundle (shipped built-ins only), then the install.
  state.original = await buildBundle(empty);
  const installed = await buildBundle(external);
  expect(installed).not.toBe(state.original);
  state.api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.73.0.1" },
  });
  state.token = await adminToken(state.api);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
  // Rollback: the original bundle is active again for every later spec.
  if (state.scratch) {
    expect(await buildBundle(path.join(state.scratch, "none"))).toBe(state.original);
    await rm(state.scratch, { recursive: true, force: true });
  }
});

test("AC-21-01/02: installed languages appear in the picker and switch with English fallback", async ({
  browser,
}) => {
  const page = await (await client(browser)).newPage();
  await page.goto("/join");
  await expect(page.getByRole("heading", { name: "Join a game" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Language/u })
    .first()
    .click();
  const options = page.getByRole("list", { name: "Language" }).getByRole("button");
  await expect(options).toHaveCount(8);
  for (const name of [
    "English",
    "Bahasa Indonesia",
    "日本語",
    "Español",
    "Français",
    "Deutsch",
    "العربية",
  ])
    await expect(page.getByRole("button", { name: new RegExp(`^${name}`, "u") })).toBeVisible();
  // Partial packages say the rest is shown in English.
  await expect(page.getByRole("button", { name: /^Deutsch/u })).toContainText("Shown in English");
  await page.getByRole("button", { name: /^Deutsch/u }).click();
  await expect(page.getByRole("heading", { name: "Einem Spiel beitreten" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  // Untranslated text falls back to English, never to a raw key.
  await expect(page.getByRole("button", { name: "Music and sound credits" })).toBeVisible();
  await expect(page.getByText(/^(common|player|about)\.[a-z]/u)).toHaveCount(0);
  const cookies = await page.context().cookies(WEB);
  expect(cookies.find((cookie) => cookie.name === "kn_locale")?.value).toBe("de");
  // The saved choice is rendered by the server on the next load.
  const html = await (await page.request.get("/join")).text();
  expect(html).toMatch(/<html[^>]*\slang="de"/u);
  expect(html).toContain("Einem Spiel beitreten");
});

test("AC-21-04: Arabic is right-to-left and German and Arabic fit a 320 px screen", async ({
  browser,
}) => {
  for (const [tag, heading, dir] of [
    ["ar", "الانضمام إلى لعبة", "rtl"],
    ["de", "Einem Spiel beitreten", "ltr"],
  ] as const) {
    const page = await (
      await client(browser, { cookie: tag, viewport: { width: 320, height: 700 } })
    ).newPage();
    await page.goto("/join");
    await expect(page.locator("html")).toHaveAttribute("lang", tag);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  }
});

test("SSR follows the cookie, Accept-Language and the Chinese script rules; storage applies after hydration", async ({
  browser,
}) => {
  expect(await ssrLang("de-AT,de;q=0.9")).toBe("de");
  expect(await ssrLang("zh-CN,zh;q=0.9")).toBe("zh-Hans");
  // Traditional Chinese never falls back to Simplified; no zh-Hant is installed.
  expect(await ssrLang("zh-TW")).toBe("en");
  expect(await ssrLang("ja-JP,ja;q=0.9,en;q=0.5")).toBe("ja");
  expect(await ssrLang("xx-YY")).toBe("en");

  // The cookie wins over Accept-Language.
  const cookieContext = await client(browser, { cookie: "fr", locale: "ja-JP" });
  const cookiePage = await cookieContext.newPage();
  await cookiePage.goto("/join");
  await expect(cookiePage.locator("html")).toHaveAttribute("lang", "fr");

  // A storage-only preference is applied after hydration and then written to the cookie.
  const storageContext = await client(browser);
  await storageContext.addInitScript(() => window.localStorage.setItem("kabuki:locale", "es"));
  const storagePage = await storageContext.newPage();
  const response = await storagePage.goto("/join");
  expect(await response?.text()).toMatch(/<html[^>]*\slang="en"/u);
  await expect(storagePage.locator("html")).toHaveAttribute("lang", "es");
  await expect
    .poll(
      async () => (await storageContext.cookies(WEB)).find((c) => c.name === "kn_locale")?.value,
    )
    .toBe("es");
});

test("AC-21-03: a failed catalog keeps the old language and the typed PIN, then retries", async ({
  browser,
}) => {
  const context = await client(browser);
  const page = await context.newPage();
  await page.goto("/join");
  const pin = page.getByLabel("Game PIN");
  await pin.fill("12");
  const broken = (route: import("@playwright/test").Route) => route.fulfill({ status: 503 });
  await page.route(/\/locales\/[a-f0-9]{64}\/de\//u, broken);
  await page
    .getByRole("button", { name: /^Language/u })
    .first()
    .click();
  await page.getByRole("button", { name: /^Deutsch/u }).click();
  const failure = page.getByRole("alert").filter({ hasText: "The language couldn't be changed." });
  await expect(failure).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Join a game" })).toBeVisible();
  await expect(pin).toHaveValue("12");
  await page.unroute(/\/locales\/[a-f0-9]{64}\/de\//u, broken);
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: "Einem Spiel beitreten" })).toBeVisible();
  // The field kept its value across both the failure and the switch.
  await expect(page.getByLabel("Spiel-PIN")).toHaveValue("12");
});

test("switching languages mid-game and in a dirty studio never resends, saves or changes content", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  if (!state.api) throw new Error("setup missing");
  const auth = { Authorization: `Bearer ${state.token}` };
  const created = await state.api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Bahasa E2E" },
  });
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  const saved = await state.api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Bahasa E2E",
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
          promptText: "Ibu kota Jepang?",
          timeLimitSec: 30,
          pointsMultiplier: 1,
          explanationText: null,
          options: [
            ["Tokyo", true],
            ["Osaka", false],
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
  const detail = (await saved.json()) as { id: string; revision: number; isPlayable: boolean };
  expect(detail.isPlayable).toBe(true);

  // Host from a socket; a second socket player keeps the question open.
  const connect = async (address: string, accessToken?: string) => {
    const socket = io(`${API}/game`, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: accessToken ? { protocolVersion: 1, accessToken } : { protocolVersion: 1 },
      extraHeaders: { origin: WEB, "x-forwarded-for": address },
      reconnection: false,
    });
    state.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return socket;
  };
  const host = await connect("10.73.0.2", state.token);
  const room = await command<{ sessionId: string; pinCode: string; phaseVersion: number }>(
    host,
    "host:create_room",
    {
      quizId: detail.id,
      quizRevision: detail.revision,
      displayMode: "STREAMER",
      friendlyNicknames: false,
    },
  );
  const other = await connect("10.73.0.3");
  await command(other, "player:join_room", {
    pinCode: room.pinCode,
    nickname: "Kitsune",
    avatar: { style: "bottts", seed: "kitsune" },
  });

  // The browser player, with its socket frames recorded.
  const context = await client(browser);
  const page = await context.newPage();
  const frames: string[] = [];
  let connections = 0;
  await page.routeWebSocket(/\/socket\.io\//u, (ws) => {
    connections += 1;
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") frames.push(message);
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await page.goto(`/join?pin=${room.pinCode}`);
  await page.getByLabel(/^Nickname/u).fill("Neko");
  await page.getByRole("button", { name: "Join game" }).click();
  await page.waitForURL(`**/play/${room.pinCode}`);
  await command(host, "host:start_game", {
    sessionId: room.sessionId,
    pinCode: room.pinCode,
    expectedPhaseVersion: room.phaseVersion,
  });
  const option = page.getByRole("button", { name: "Option A, ▲: Tokyo" });
  await expect(option).toBeVisible({ timeout: 25_000 });
  await option.click();
  await expect(page.getByText(/^Answer received/u).first()).toBeVisible();
  const submits = () => frames.filter((frame) => frame.includes("player:submit_answer")).length;
  expect(submits()).toBe(1);
  const connected = connections;

  // Online switch: German UI, same question, same locked answer, no new connection or submit.
  await chooseLanguage(page, "Deutsch");
  await expect(page.getByText(/^Antwort erhalten/u).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ibu kota Jepang?" })).toBeVisible();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  expect(connections).toBe(connected);
  expect(submits()).toBe(1);

  // Offline switch back to the already loaded English catalog: no network needed, nothing resent.
  await context.setOffline(true);
  await chooseLanguage(page, "English");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText(/^Answer received/u).first()).toBeVisible();
  await context.setOffline(false);
  await page.waitForTimeout(2_000);
  expect(submits()).toBe(1);
  await expect(page.getByRole("heading", { name: "Ibu kota Jepang?" })).toBeVisible();

  // Dirty studio draft: the switch keeps the edit, stays dirty and sends no save.
  // (the browser uses the refresh cookie of the beforeAll sign-in; no second sign-in).
  const studioContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: await state.api.storageState(),
  });
  state.contexts.push(studioContext);
  await serveBundle(studioContext);
  await studioContext.route(`${API}/**`, (route) =>
    route
      .continue({ headers: { ...route.request().headers(), "x-forwarded-for": "10.73.9.9" } })
      .catch(() => undefined),
  );
  const editor = await studioContext.newPage();
  const saves: string[] = [];
  editor.on("request", (sent) => {
    if (sent.method() === "PUT" && sent.url().includes(`/api/v1/quizzes/${detail.id}`))
      saves.push(sent.url());
  });
  await editor.goto(`/studio/${detail.id}`);
  const header = editor.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  const prompt = editor.getByRole("textbox", { name: /^Question/u });
  await prompt.fill("Ibu kota Jepang adalah?");
  await expect(header).toHaveAttribute("data-dirty", "true");
  await chooseLanguage(editor, "Deutsch");
  await expect(editor.locator("html")).toHaveAttribute("lang", "de");
  await expect(header).toHaveAttribute("data-dirty", "true");
  expect(await prompt.inputValue()).toBe("Ibu kota Jepang adalah?");
  expect(saves).toEqual([]);
});
