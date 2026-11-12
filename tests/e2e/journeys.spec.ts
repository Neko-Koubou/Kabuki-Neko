/**
 * TASK-171 complete user journey against the real API and the production web build (US-01–US-21;
 * PRD §9; SA §11.2).
 *
 * One serial journey through the product, in the order a new instance is used:
 * 1. Account (AC-01/02):
 *    - an initialized instance sends /setup to sign in;
 *    - a creator registers through the form under PUBLIC registration.
 * 2. Content (AC-03/05/06; PRD §9 scenario 1):
 *    - the creator finds an administrator's PUBLIC quiz, reads it read-only and duplicates it into
 *      their own studio;
 *    - imports a JSON export through M04;
 *    - uploads a PNG through the media library, which the server stores as WebP.
 * 3. Game (AC-04, AC-07–13; scenarios 2 and 3):
 *    - a quiz with all six question types and the uploaded image opens in the studio;
 *    - it is hosted from the studio ("Host a game" → "Open lobby");
 *    - a browser player joins with the PIN and answers every type through the UI;
 *    - a second player answers from a socket;
 *    - the browser player reloads mid-question and gets the same locked answer back, without a
 *      second slot;
 *    - the game ends on the podium with a ready report.
 * 4. Report (AC-14): the report and its downloaded CSV, byte-identical to the API export, show
 *    exactly the two players.
 * 5. Administration (AC-15/19; scenarios 4 and 5):
 *    - the administrator cleans up storage from Settings: an unreferenced upload is deleted, the
 *      quiz's image stays and is still served;
 *    - the About page shows the official Apache 2.0 + Commons Clause text, which matches LICENSE.
 * 6. Trace: every acceptance criterion AC-01-01 … AC-21-04 and the five PRD §9 scenarios name
 *    the verifications that cover them. These are this journey's steps or named tests elsewhere,
 *    checked to exist. Verifications that belong to later tasks name that task.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
import { JOURNEY_TESTS, UI_STATE_TESTS, declaresTest } from "./fixtures/ui-state-cases";

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
/** A unique suffix so a re-run against the same instance never collides. */
const RUN = randomUUID().slice(0, 8);
const CREATOR = { name: "Sari Kreator", email: `journey-${RUN}@example.com` };
const PUBLIC_TITLE = `Kuis Publik Journey ${RUN}`;
const IMPORTED_TITLE = `Kuis Impor Journey ${RUN}`;
const GAME_TITLE = `Kuis Enam Tipe ${RUN}`;
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Public question as players see it. */
interface PublicQuestion {
  id: string;
  questionIndex: number;
  options: { id: string; index: number; text: string }[];
}

/** Media as listed by the API. */
interface MediaItem {
  id: string;
  originalName: string;
  mimeType: string;
  publicUrl: string;
}

/** Shared journey state. */
const state: {
  admin: APIRequestContext | null;
  adminToken: string;
  creator: APIRequestContext | null;
  creatorToken: string;
  creatorContext: BrowserContext | null;
  publicQuizId: string;
  media: MediaItem | null;
  gameQuizId: string;
  sessionId: string;
  contexts: BrowserContext[];
  sockets: Socket[];
} = {
  admin: null,
  adminToken: "",
  creator: null,
  creatorToken: "",
  creatorContext: null,
  publicQuizId: "",
  media: null,
  gameQuizId: "",
  sessionId: "",
  contexts: [],
  sockets: [],
};

/** API context presenting a fixed client address (per-IP auth limits). */
function apiContext(address: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": address },
  });
}

/** A browser context with its own client address (added after CORS, as a proxy would). */
async function client(browser: Browser, address: string, storage?: APIRequestContext) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(storage ? { storageState: await storage.storageState() } : {}),
  });
  state.contexts.push(context);
  await context.route(`${API}/**`, (route) =>
    // A request the app aborted meanwhile is already handled; nothing to continue then.
    route
      .continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } })
      .catch(() => undefined),
  );
  return context;
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

/** Bearer header of the creator. */
const creatorAuth = () => ({ Authorization: `Bearer ${state.creatorToken}` });

/** The creator's media library page. */
async function creatorMedia(): Promise<MediaItem[]> {
  if (!state.creator) throw new Error("creator missing");
  const response = await state.creator.get("/api/v1/media?page=1&limit=50", {
    headers: creatorAuth(),
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: MediaItem[] }).items;
}

/** True when `bytes` is a WebP file. */
const isWebp = (bytes: Buffer) =>
  bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
  bytes.subarray(8, 12).toString("latin1") === "WEBP";

/** Saves `questions` into a new quiz of the API user behind `headers`; returns its id. */
async function saveQuiz(
  api: APIRequestContext,
  headers: Record<string, string>,
  title: string,
  visibility: "PRIVATE" | "PUBLIC",
  build: (blank: Record<string, unknown>) => Record<string, unknown>[],
) {
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: { title },
  });
  expect(created.status()).toBe(201);
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...headers, "If-Match": `"${quiz.revision}"` },
    data: {
      title,
      description: null,
      coverMediaId: null,
      visibility,
      bgmTrack: "random",
      questions: build(quiz.questions[0] as Record<string, unknown>),
    },
  });
  const detail = (await saved.json()) as { id: string; isPlayable: boolean };
  expect(saved.status(), JSON.stringify(detail)).toBe(200);
  expect(detail.isPlayable, JSON.stringify(detail)).toBe(true);
  return detail.id;
}

/** One question from the blank template. */
function question(
  blank: Record<string, unknown>,
  orderIndex: number,
  type: string,
  promptText: string,
  options: [string, boolean?][],
  extra: Record<string, unknown> = {},
) {
  return {
    ...blank,
    id: randomUUID(),
    orderIndex,
    type,
    promptText,
    timeLimitSec: 30,
    pointsMultiplier: type === "POLL" ? 0 : 1,
    explanationText: null,
    options: options.map(([optionText, isCorrect = false], index) => ({
      id: randomUUID(),
      optionIndex: index,
      colorIndex: type === "TYPE_ANSWER" ? 0 : index,
      optionText,
      isCorrect,
      sortOrder: index,
    })),
    ...extra,
  };
}

/** A Node player that answers each announced question once. */
async function nodePlayer(pinCode: string, nickname: string, address: string) {
  const socket = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1 },
    extraHeaders: { origin: WEB, "x-forwarded-for": address },
    reconnection: false,
  });
  state.sockets.push(socket);
  const questions = new Map<number, PublicQuestion>();
  socket.on(
    "game:question_answering",
    (envelope: { data?: { question?: PublicQuestion } } | undefined) => {
      const announced = envelope?.data?.question;
      if (announced) questions.set(announced.questionIndex, announced);
    },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const joined = (await socket.timeout(10_000).emitWithAck("player:join_room", {
    requestId: randomUUID(),
    pinCode,
    nickname,
    avatar: { style: "bottts", seed: nickname },
  })) as { ok: boolean; data?: { sessionId: string } };
  expect(joined.ok).toBe(true);
  const sessionId = joined.data?.sessionId ?? "";
  return {
    /** Answers question `index` with `pick(question)`. */
    async answer(index: number, pick: (announced: PublicQuestion) => unknown) {
      await expect.poll(() => questions.has(index), { timeout: 25_000 }).toBe(true);
      const announced = questions.get(index);
      if (!announced) throw new Error("question missing");
      const ack = (await socket.timeout(10_000).emitWithAck("player:submit_answer", {
        requestId: randomUUID(),
        sessionId,
        pinCode,
        questionIndex: index,
        questionId: announced.id,
        submissionId: randomUUID(),
        answer: pick(announced),
      })) as { ok: boolean; error?: unknown };
      expect(ack.ok, JSON.stringify(ack.error)).toBe(true);
    },
  };
}

/** The host stage root carrying the server phase. */
const stage = (page: Page) => page.locator("main [data-phase]").first();

/** Host: waits for the reveal of the current question, then moves on (or to the podium). */
async function hostAdvance(host: Page, last: boolean) {
  await expect(stage(host)).toHaveAttribute("data-phase", "ANSWER_REVEAL", { timeout: 25_000 });
  if (last) {
    await host.getByRole("button", { name: "Show podium" }).click();
    return;
  }
  await host.getByRole("button", { name: "Show leaderboard" }).click();
  await expect(stage(host)).toHaveAttribute("data-phase", "LEADERBOARD");
  await host.getByRole("button", { name: "Next question" }).click();
}

/** Player: waits for an option button of the next question. */
async function option(page: Page, name: string) {
  const button = page.getByRole("button", { name });
  await expect(button).toBeVisible({ timeout: 25_000 });
  return button;
}

/**
 * Opens the join page for `pinCode` until the identity step shows. The PIN check runs over the
 * browser's WebSocket, which carries no forwarded client address, so every browser player of the
 * suite shares one per-address check budget; a "Too many attempts" answer is waited out with the
 * time the page states, as a person would.
 */
async function openJoin(page: Page, pinCode: string) {
  const identity = page.getByRole("heading", { name: "Choose your look" });
  const limited = page.getByText(/^Too many attempts\. Try again in (\d+) seconds?\.$/u).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`/join?pin=${pinCode}`);
    await expect(identity.or(limited)).toBeVisible({ timeout: 15_000 });
    if (await identity.isVisible()) return;
    const seconds = Number(/(\d+)/u.exec((await limited.textContent()) ?? "")?.[1] ?? "60");
    await page.waitForTimeout((Math.min(seconds, 65) + 1) * 1_000);
  }
  await expect(identity).toBeVisible();
}

/** The locked-in confirmation every accepted answer shows. */
const accepted = (page: Page) => page.getByText("Answer received Your answer is locked in.");

test.beforeAll(async () => {
  // Waiting out a per-email sign-in limit can take a minute.
  test.setTimeout(150_000);
  state.admin = await apiContext("10.72.0.1");
  state.adminToken = await signInAdmin(state.admin);
  const headers = { Authorization: `Bearer ${state.adminToken}` };
  // PUBLIC registration for the creator.
  const current = await state.admin.get("/api/v1/system/settings", { headers });
  const { settings } = (await current.json()) as {
    settings: { revision: number; registrationMode: string };
  };
  if (settings.registrationMode !== "PUBLIC") {
    const patched = await state.admin.patch("/api/v1/system/settings", {
      headers: { ...headers, "If-Match": `"${settings.revision}"` },
      data: { registrationMode: "PUBLIC" },
    });
    expect(patched.status()).toBe(200);
  }
  // The administrator's PUBLIC quiz the creator will reuse.
  state.publicQuizId = await saveQuiz(state.admin, headers, PUBLIC_TITLE, "PUBLIC", (blank) => [
    question(blank, 0, "SINGLE_CHOICE", "Gunung tertinggi di Jawa?", [
      ["Semeru", true],
      ["Merapi"],
    ]),
  ]);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.admin?.dispose();
  await state.creator?.dispose();
});

test(JOURNEY_TESTS.account, async ({ browser }) => {
  const context = await client(browser, "10.72.1.1");
  const page = await context.newPage();
  // AC-01-02: setup runs once; an initialized instance sends /setup to sign in.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/u);
  // AC-02-01: PUBLIC registration creates a CREATOR through the form.
  await page.goto("/register");
  await page.getByLabel(/^Name/u).fill(CREATOR.name);
  await page.getByLabel(/^Email/u).fill(CREATOR.email);
  await page.getByLabel(/^Password/u).fill(PASSWORD);
  await expect(page.getByLabel(/^Invite code/u)).toHaveCount(0);
  await page.getByRole("button", { name: /^Create account/u }).click();
  await page.waitForURL("**/dashboard/quizzes");
  await expect(
    page.getByText("You don't have any quizzes yet. Create or import one to get started."),
  ).toBeVisible();
  // No password or bearer token is kept in browser storage.
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]),
  );
  expect(stored).not.toContain(PASSWORD);
  expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/u);
  await page.close();
  state.creatorContext = context;
  // The creator's own API session for checks (one sign-in).
  state.creator = await apiContext("10.72.0.2");
  const login = await state.creator.post("/api/v1/auth/login", {
    data: { email: CREATOR.email, password: PASSWORD },
  });
  expect(login.status()).toBe(200);
  const body = (await login.json()) as { accessToken: string; user: { role: string } };
  expect(body.user.role).toBe("CREATOR");
  state.creatorToken = body.accessToken;
});

test(JOURNEY_TESTS.content, async () => {
  const context = state.creatorContext;
  if (!context || !state.creator) throw new Error("account step missing");
  const page = await context.newPage();

  // AC-03: the PUBLIC quiz is read-only for the creator and can be duplicated into their studio.
  await page.goto("/dashboard/quizzes");
  await page.getByRole("tab", { name: "Public quizzes" }).click();
  await page
    .getByLabel(/^Search/u)
    .first()
    .fill(PUBLIC_TITLE);
  await page
    .getByLabel(/^Search/u)
    .first()
    .press("Enter");
  await page.getByRole("link", { name: PUBLIC_TITLE }).first().click();
  await page.waitForURL(`**/dashboard/quizzes/${state.publicQuizId}`);
  await expect(
    page.getByText(
      "This public quiz belongs to another creator. You can view, duplicate or host it, but not edit it.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Duplicate quiz" }).click();
  await page.waitForURL(/\/studio\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  const copyId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect(copyId).not.toBe(state.publicQuizId);
  const copy = await state.creator.get(`/api/v1/quizzes/${copyId}`, { headers: creatorAuth() });
  expect(copy.status()).toBe(200);
  expect(((await copy.json()) as { visibility: string }).visibility).toBe("PRIVATE");

  // AC-05: a JSON export imported through M04 opens the new quiz in the studio.
  const exported = await state.creator.get(
    `/api/v1/quizzes/${state.publicQuizId}/export?format=json`,
    { headers: creatorAuth() },
  );
  expect(exported.status()).toBe(200);
  const document = (await exported.json()) as { quiz: { title: string } };
  document.quiz.title = IMPORTED_TITLE;
  await page.goto("/dashboard/quizzes");
  await page.getByRole("button", { name: "Import quiz" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Import a quiz" });
  const picked = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a file" }).click();
  await (
    await picked
  ).setFiles({
    name: "journey.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await dialog.getByRole("button", { name: "Import quiz" }).click();
  await page.waitForURL(/\/studio\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  const importedId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const imported = await state.creator.get(`/api/v1/quizzes/${importedId}`, {
    headers: creatorAuth(),
  });
  expect(((await imported.json()) as { title: string }).title).toBe(IMPORTED_TITLE);

  // AC-06 / PRD §9 scenario 1: a PNG uploaded in the library is stored and served as WebP.
  await page.goto("/dashboard/media");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload" }).first().click();
  await (
    await chooser
  ).setFiles({ name: "kucing-journey.png", mimeType: "image/png", buffer: PNG });
  await expect
    .poll(
      async () =>
        (await creatorMedia()).some((item) => item.originalName.startsWith("kucing-journey")),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  const media = (await creatorMedia()).find((item) =>
    item.originalName.startsWith("kucing-journey"),
  );
  if (!media) throw new Error("upload missing");
  expect(media.mimeType).toBe("image/webp");
  const served = await state.creator.get(media.publicUrl);
  expect(served.status()).toBe(200);
  expect(isWebp(Buffer.from(await served.body()))).toBe(true);
  state.media = media;
  await page.close();
});

test(JOURNEY_TESTS.game, async ({ browser }) => {
  test.setTimeout(300_000);
  const context = state.creatorContext;
  if (!context || !state.creator || !state.media) throw new Error("content step missing");
  const mediaId = state.media.id;
  state.gameQuizId = await saveQuiz(
    state.creator,
    creatorAuth(),
    GAME_TITLE,
    "PRIVATE",
    (blank) => [
      question(blank, 0, "SINGLE_CHOICE", "Ibu kota Indonesia?", [["Jakarta", true], ["Bandung"]], {
        mediaId,
      }),
      question(blank, 1, "TRUE_FALSE", "Kucing adalah mamalia.", [["Benar", true], ["Salah"]]),
      question(blank, 2, "MULTIPLE_SELECT", "Pilih kota di Pulau Jawa.", [
        ["Bandung", true],
        ["Surabaya", true],
        ["Medan"],
      ]),
      question(blank, 3, "TYPE_ANSWER", "Apa bahasa Jepang untuk kucing?", [["Neko", true]]),
      question(blank, 4, "ORDER_PUZZLE", "Urutkan dari kecil ke besar.", [
        ["Satu"],
        ["Dua"],
        ["Tiga"],
        ["Empat"],
      ]),
      question(blank, 5, "POLL", "Warna favoritmu?", [["Merah"], ["Biru"]]),
    ],
  );

  // AC-04/07: the saved six-type quiz opens in the studio and is hosted from there.
  const host = await context.newPage();
  await host.goto(`/studio/${state.gameQuizId}`);
  const header = host.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  await expect(host.getByText(/Slide 6 of 6/u).first()).toBeAttached();
  await header.getByRole("button", { name: "Host a game" }).click();
  await host.getByRole("button", { name: "Open lobby" }).click();
  await host.waitForURL(/\/host\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  state.sessionId = new URL(host.url()).pathname.split("/").at(-1) ?? "";
  await expect(stage(host)).toHaveAttribute("data-phase", "LOBBY", { timeout: 20_000 });
  await expect(host.getByText("No players yet. Share the PIN so players can join.")).toBeVisible();
  const pinLabel = (await host.getByLabel(/^PIN \d{6}$/u).getAttribute("aria-label")) ?? "";
  const pinCode = pinLabel.slice(4);

  // AC-08: a browser player joins with the PIN; a second player joins from a socket.
  // The player's own address also reaches its WebSocket (PIN check and join are per address).
  const playerContext = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": `10.72.2.${1 + Math.floor(Math.random() * 200)}` },
  });
  state.contexts.push(playerContext);
  const player = await playerContext.newPage();
  await openJoin(player, pinCode);
  await player.getByLabel(/^Nickname/u).fill("Budi");
  await player.getByRole("button", { name: "Join game" }).click();
  await player.waitForURL(`**/play/${pinCode}`);
  await expect(player.getByText("Waiting for the host to start…")).toBeVisible();
  const rival = await nodePlayer(pinCode, "Tora", "10.72.2.2");
  await expect(host.getByText("Tora", { exact: true })).toBeVisible();
  await expect(host.getByText("Budi", { exact: true })).toBeVisible();
  await host.getByRole("button", { name: "Start game" }).click();

  // 1. Single choice with the uploaded image; AC-12 / scenario 3: a reload mid-question restores
  //    the same locked answer.
  await (await option(player, "Option A, ▲: Jakarta")).click();
  await expect(accepted(player)).toBeVisible();
  await player.reload();
  await expect(accepted(player)).toBeVisible({ timeout: 20_000 });
  await expect(player.getByRole("button", { name: "Option A, ▲: Jakarta" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rival.answer(0, (announced) => announced.options.find((o) => o.text === "Bandung")?.index);
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await hostAdvance(host, false);

  // 2. True/false.
  await (await option(player, "Option A, ▲: Benar")).click();
  await expect(accepted(player)).toBeVisible();
  await rival.answer(1, () => 1);
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await hostAdvance(host, false);

  // 3. Multiple select.
  await option(player, "Option A, ▲: Bandung");
  await player.getByRole("button", { name: "Option A, ▲: Bandung" }).click();
  await player.getByRole("button", { name: "Option B, ◆: Surabaya" }).click();
  await player.getByRole("button", { name: "Submit answer (2)" }).click();
  await expect(accepted(player)).toBeVisible();
  await rival.answer(2, () => [2]);
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await hostAdvance(host, false);

  // 4. Typed answer.
  const typed = player.getByLabel("Type your answer");
  await expect(typed).toBeVisible({ timeout: 25_000 });
  await typed.fill("neko");
  await typed.press("Enter");
  await expect(accepted(player)).toBeVisible();
  await rival.answer(3, () => "salah");
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await hostAdvance(host, false);

  // 5. Order puzzle with the keyboard-accessible move buttons (AC-18).
  await expect(player.getByText("Put the items in the right order.")).toBeVisible({
    timeout: 25_000,
  });
  for (const [position, word] of ["Satu", "Dua", "Tiga", "Empat"].entries())
    for (let guard = 0; guard < 4; guard += 1) {
      const order = await player.locator("ol > li").allInnerTexts();
      if (order.findIndex((text) => text.includes(word)) <= position) break;
      await player
        .getByRole("button", { name: new RegExp(`^Move item up Option .+: ${word}$`, "u") })
        .click();
    }
  await player.getByRole("button", { name: "Submit answer" }).click();
  await expect(accepted(player)).toBeVisible();
  await rival.answer(4, (announced) => announced.options.map((o) => o.index).reverse());
  await expect(player.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 20_000 });
  await hostAdvance(host, false);

  // 6. Poll: no correctness.
  await (await option(player, "Option B, ◆: Biru")).click();
  await expect(accepted(player)).toBeVisible();
  await rival.answer(5, () => 0);
  await expect(player.getByRole("heading", { name: "Thanks for voting!" })).toBeVisible({
    timeout: 20_000,
  });
  await hostAdvance(host, true);

  // AC-13: podium, then the final screens; the host's report becomes ready.
  await expect(host.getByText("1st place: Budi")).toBeVisible({ timeout: 20_000 });
  await expect(host.getByRole("heading", { name: "Game over" })).toBeVisible({ timeout: 20_000 });
  await expect(player.getByRole("heading", { name: "Game over" })).toBeVisible({ timeout: 20_000 });
  await expect(host.getByText("The report is ready.")).toBeVisible({ timeout: 30_000 });
  await expect(host.getByRole("link", { name: "View report" })).toHaveAttribute(
    "href",
    `/dashboard/reports/${state.sessionId}`,
  );
  await host.close();
});

test(JOURNEY_TESTS.report, async () => {
  const context = state.creatorContext;
  if (!context || !state.creator || !state.sessionId) throw new Error("game step missing");
  const page = await context.newPage();
  await page.goto("/dashboard/reports");
  await expect(page.getByRole("link", { name: GAME_TITLE }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`/dashboard/reports/${state.sessionId}`);
  await expect(page.getByRole("heading", { name: GAME_TITLE })).toBeVisible({ timeout: 15_000 });
  // Exactly the two players: the reload in the game created no second slot.
  const players = await state.creator.get(`/api/v1/reports/${state.sessionId}/players`, {
    headers: creatorAuth(),
  });
  expect(players.status()).toBe(200);
  const items = ((await players.json()) as { items: { nickname: string }[] }).items;
  expect(items.map((item) => item.nickname).sort()).toEqual(["Budi", "Tora"]);
  // The CSV download is the server's export, byte for byte.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const downloaded = await readFile(await download.path());
  const exported = await state.creator.get(`/api/v1/reports/${state.sessionId}/export-csv`, {
    headers: creatorAuth(),
  });
  expect(exported.status()).toBe(200);
  expect(Buffer.compare(downloaded, Buffer.from(await exported.body()))).toBe(0);
  const csv = downloaded.toString("utf8");
  expect(csv).toContain("Budi");
  expect(csv).toContain("Tora");
  await page.close();
});

test(JOURNEY_TESTS.admin, async ({ browser }) => {
  if (!state.admin || !state.creator || !state.media) throw new Error("earlier steps missing");
  // PRD §9 scenario 4: an upload nobody references is an orphan; the game quiz's image is not.
  const form = new FormData();
  form.append("folder", "questions");
  form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "yatim-journey.png");
  const orphanUpload = await fetch(`${API}/api/v1/media/upload`, {
    method: "POST",
    headers: {
      ...creatorAuth(),
      Origin: WEB,
      "X-Kabuki-Client": "web-v1",
      "X-Forwarded-For": "10.72.0.2",
      "Idempotency-Key": randomUUID(),
    },
    body: form,
  });
  expect(orphanUpload.status).toBe(201);
  const orphanId = ((await orphanUpload.json()) as { id: string }).id;

  const context = await client(browser, "10.72.3.1", state.admin);
  const page = await context.newPage();
  await page.goto("/dashboard/settings");
  await page.getByRole("button", { name: "Clean up unused files" }).click();
  const confirm = page.getByRole("dialog");
  await expect(
    confirm.getByText(
      "Delete media files that aren't used by any quiz or game? This can't be undone.",
    ),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Clean up unused files" }).click();
  await expect(page.getByRole("status").filter({ hasText: /deleted|removed|freed/iu })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  const remaining = await creatorMedia();
  expect(remaining.some((item) => item.id === orphanId)).toBe(false);
  expect(remaining.some((item) => item.id === state.media?.id)).toBe(true);
  expect((await state.creator.get(state.media.publicUrl)).status()).toBe(200);

  // PRD §9 scenario 5 / AC-19: the About page shows the official license, which is LICENSE.
  const license = readFileSync("LICENSE", "utf8");
  expect(license).toContain("Commons Clause");
  expect(license).toContain("Apache License, Version 2.0");
  expect(license).toContain("the right to Sell the Software");
  await page.goto("/about");
  const original = page.getByLabel("Original license text");
  await expect(original).toContainText("Commons Clause", { timeout: 15_000 });
  await expect(original).toContainText("the right to Sell the Software");
  await page.close();
});

/** One verification of an acceptance criterion: a test (file + title) or a later task. */
type Trace = { file: string; title: string } | { task: string };
const t = (file: string, title: string): Trace => ({ file, title });
const journey = (title: string): Trace => ({ file: "tests/e2e/journeys.spec.ts", title });
const states = (title: string): Trace => ({ file: "tests/e2e/ui-states.spec.ts", title });
const later = (task: string): Trace => ({ task });

/** Acceptance criteria (PRD §14) and PRD §9 scenarios → verifications. */
const TRACE: Record<string, Trace[]> = {
  "AC-01-01": [
    journey(JOURNEY_TESTS.account),
    t(
      "tests/e2e/auth.spec.ts",
      "first run: two tabs race the setup and exactly one SUPERADMIN exists",
    ),
  ],
  "AC-01-02": [
    journey(JOURNEY_TESTS.account),
    t(
      "tests/integration/auth-races.spec.ts",
      "creates exactly one SUPERADMIN when five setups race",
    ),
  ],
  "AC-02-01": [
    journey(JOURNEY_TESTS.account),
    t(
      "tests/e2e/auth.spec.ts",
      "registration follows the SINGLE_ADMIN, INVITE_ONLY and PUBLIC policies",
    ),
  ],
  "AC-02-02": [
    t(
      "tests/integration/auth-races.spec.ts",
      "consumes one invitation once under racing registrations and enforces every mode",
    ),
  ],
  "AC-03-01": [
    journey(JOURNEY_TESTS.content),
    t(
      "tests/integration/content-races.spec.ts",
      "duplicates concurrently into complete, independent copies",
    ),
  ],
  "AC-03-02": [
    t(
      "tests/integration/authorization.spec.ts",
      "hides private quizzes, protects public ones and never bypasses for SUPERADMIN",
    ),
    states(UI_STATE_TESTS.fallback),
  ],
  "AC-04-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/e2e/studio.spec.ts",
      "builds all six types, reorders, duplicates, deletes, saves and keeps them after a refresh",
    ),
  ],
  "AC-04-02": [
    t(
      "tests/e2e/studio.spec.ts",
      "keeps the draft on a conflict from another tab and reloads the saved version on request",
    ),
  ],
  "AC-05-01": [
    journey(JOURNEY_TESTS.content),
    t(
      "tests/integration/quiz-transfer.spec.ts",
      "imports both templates and roundtrips all six types through export",
    ),
  ],
  "AC-05-02": [
    t(
      "tests/integration/quiz-transfer.spec.ts",
      "rejects missing media without creating partial rows or receipts",
    ),
  ],
  "AC-06-01": [
    journey(JOURNEY_TESTS.content),
    t("tests/integration/media.spec.ts", "uploads, guards and deletes media on the local origin"),
  ],
  "AC-06-02": [
    t(
      "tests/integration/media-failures.spec.ts",
      "rejects malformed imports and uploads without leaving rows or receipts",
    ),
  ],
  "AC-07-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/e2e/host.spec.ts",
      "runs a full game with duplicate-safe Next, reconnect and the ready report",
    ),
  ],
  "AC-07-02": [
    t(
      "tests/integration/authorization.spec.ts",
      "refuses host commands from anyone but the room's host",
    ),
  ],
  "AC-08-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/e2e/join.spec.ts",
      "checks a deep-linked PIN once, joins as a guest and rejects a duplicate nickname",
    ),
  ],
  "AC-08-02": [
    t("tests/e2e/join.spec.ts", "explains a locked room (partial)"),
    t(
      "tests/e2e/join.spec.ts",
      "falls back to manual entry when the camera is denied and refuses foreign QR codes",
    ),
  ],
  "AC-09-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/e2e/player.spec.ts",
      "shows shapes first in a Projector room, text on request, and ends cleanly when kicked",
    ),
  ],
  "AC-09-02": [
    t(
      "tests/integration/payload-privacy.spec.ts",
      "never sends keys before the reveal, secrets ever, or other players' results",
    ),
  ],
  "AC-10-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/integration/recovery.spec.ts",
      "scores by server receive time and honours the 1500 ms grace exactly",
    ),
  ],
  "AC-10-02": [
    t(
      "tests/integration/realtime-races.spec.ts",
      "counts an answer racing Skip exactly when its ACK was accepted",
    ),
  ],
  "AC-11-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "apps/api/src/modules/game-engine/scoring.spec.ts",
      "scores partial multiple-select with a streak bonus (375 + 100 = 475)",
    ),
  ],
  "AC-11-02": [
    t(
      "apps/api/src/modules/game-engine/scoring.spec.ts",
      "applies POLL, multiplier-0, wrong, unanswered and not-eligible streak rules",
    ),
  ],
  "AC-12-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "tests/e2e/player.spec.ts",
      "plays all six input types in a Streamer room with refresh, reconnect, grace and podium",
    ),
  ],
  "AC-12-02": [
    t(
      "tests/integration/realtime-races.spec.ts",
      "refuses the old socket after a player reconnects on the other node",
    ),
  ],
  "AC-13-01": [
    journey(JOURNEY_TESTS.game),
    t(
      "apps/api/src/modules/game-engine/scoring.spec.ts",
      "builds top five, biggest climber and empty/one/two winner podia",
    ),
  ],
  "AC-13-02": [
    t(
      "tests/integration/recovery.spec.ts",
      "never invents podium winners: one silent player is the only entry, an emptied room has none",
    ),
  ],
  "AC-14-01": [
    journey(JOURNEY_TESTS.report),
    t(
      "tests/e2e/reports.spec.ts",
      "shows the complete report, M12 answers, questions, hardest and an identical CSV",
    ),
  ],
  "AC-14-02": [
    t(
      "tests/integration/finalization-failures.spec.ts",
      "backs off failed attempts behind 503 gates and retries manually or when due",
    ),
    t("tests/integration/authorization.spec.ts", "serves reports only to their host"),
  ],
  "AC-15-01": [
    journey(JOURNEY_TESTS.admin),
    t(
      "tests/integration/system.spec.ts",
      "cleans orphans with partial failures, reports metrics and enforces the cleanup tier",
    ),
  ],
  "AC-15-02": [
    t(
      "tests/integration/content-races.spec.ts",
      "cleans only unreferenced uploads with truthful counters, one run at a time",
    ),
    t(
      "tests/integration/media-failures.spec.ts",
      "reports a cleanup outage as a failure, keeps rows and files, then deletes exactly",
    ),
  ],
  "AC-16-01": [
    t("tests/contracts/driver-matrix.spec.ts", "covers exactly 12 combinations"),
    t(
      "tests/integration/realtime-races.spec.ts",
      "plays one authoritative game with the host and players on different nodes",
    ),
  ],
  "AC-16-02": [
    t(
      "tests/contracts/state-parity.spec.ts",
      "reloads scripts after SCRIPT FLUSH, reconnects and never falls back on outages",
    ),
    t(
      "tests/integration/media-failures.spec.ts",
      "refuses to start with an incomplete S3 origin, without printing its secret",
    ),
  ],
  "AC-17-01": [
    t(
      "tests/contracts/driver-matrix.spec.ts",
      "%s + Redis + shared S3 storage across two API nodes",
    ),
    later("TASK-176"),
    later("TASK-182"),
  ],
  "AC-17-02": [
    t("tests/integration/room-retention.spec.ts", "treats in-memory rooms as LOST after a restart"),
    later("TASK-177"),
  ],
  "AC-18-01": [journey(JOURNEY_TESTS.game), later("TASK-173")],
  "AC-18-02": [
    t(
      "apps/web/src/components/host/AudioController.spec.tsx",
      "covers loading, empty, blocked and failed states",
    ),
    later("TASK-173"),
  ],
  "AC-19-01": [journey(JOURNEY_TESTS.admin), later("TASK-174")],
  "AC-19-02": [journey(JOURNEY_TESTS.admin), later("TASK-174"), later("TASK-181")],
  "AC-20-01": [
    t(
      "tests/integration/auth-races.spec.ts",
      "never writes passwords, tokens, cookies or invite codes to the API output",
    ),
    later("TASK-179"),
  ],
  "AC-20-02": [
    t(
      "tests/integration/room-retention.spec.ts",
      "never evicts a report that is not durable and raises one 24 h alarm",
    ),
    later("TASK-179"),
  ],
  "AC-21-01": [
    t(
      "tests/contracts/locale-coverage.spec.ts",
      "passes the full gate for all six built-ins with exact keys in all twelve namespaces",
    ),
    later("TASK-172"),
  ],
  "AC-21-02": [
    t(
      "tests/contracts/locale-build.spec.ts",
      "writes a reproducible translator template ZIP with en sources and contracts",
    ),
    later("TASK-172"),
  ],
  "AC-21-03": [
    t(
      "tests/contracts/locale-packages.spec.ts",
      "accepts complete built-ins and a partial RTL external package with en fallback warnings",
    ),
    later("TASK-172"),
  ],
  "AC-21-04": [
    t(
      "tests/contracts/locale-packages.spec.ts",
      "accepts complete built-ins and a partial RTL external package with en fallback warnings",
    ),
    later("TASK-173"),
  ],
  "PRD-9-1 WebP storage": [
    journey(JOURNEY_TESTS.content),
    t("tests/contracts/driver-matrix.spec.ts", "covers exactly 12 combinations"),
  ],
  "PRD-9-2 speed scoring": [
    t(
      "apps/api/src/modules/game-engine/scoring.spec.ts",
      "awards full points below 500 ms and the documented curve from 500 ms",
    ),
    t(
      "tests/integration/payload-privacy.spec.ts",
      "never sends keys before the reveal, secrets ever, or other players' results",
    ),
  ],
  "PRD-9-3 reconnection": [journey(JOURNEY_TESTS.game), journey(JOURNEY_TESTS.report)],
  "PRD-9-4 orphan cleanup": [
    journey(JOURNEY_TESTS.admin),
    t(
      "tests/integration/content-races.spec.ts",
      "cleans only unreferenced uploads with truthful counters, one run at a time",
    ),
  ],
  "PRD-9-5 license": [journey(JOURNEY_TESTS.admin), later("TASK-174")],
};

test(JOURNEY_TESTS.trace, () => {
  const prd = readFileSync("docs/vibe/01-prd.md", "utf8");
  const criteria = [...prd.matchAll(/Scenario: (AC-\d{2}-\d{2})/gu)].map((match) => match[1] ?? "");
  expect(criteria.length).toBeGreaterThanOrEqual(42);
  const traced = Object.keys(TRACE).filter((key) => key.startsWith("AC-"));
  expect(traced.sort()).toEqual([...new Set(criteria)].sort());
  expect(Object.keys(TRACE).filter((key) => key.startsWith("PRD-9-"))).toHaveLength(5);
  const tasks = readFileSync("docs/vibe/04-tasks.md", "utf8");
  for (const [criterion, entries] of Object.entries(TRACE)) {
    expect({ criterion, entries: entries.length > 0 }).toEqual({ criterion, entries: true });
    // Every criterion has at least one verification that runs today.
    expect({ criterion, runnable: entries.some((entry) => "file" in entry) }).toEqual({
      criterion,
      runnable: true,
    });
    for (const entry of entries) {
      if ("task" in entry) {
        expect({ criterion, task: entry.task, listed: tasks.includes(`${entry.task}:`) }).toEqual({
          criterion,
          task: entry.task,
          listed: true,
        });
        continue;
      }
      const exists = existsSync(entry.file);
      const source = exists ? readFileSync(entry.file, "utf8") : "";
      expect({ criterion, ...entry, declared: declaresTest(source, entry.title) }).toEqual({
        criterion,
        ...entry,
        declared: true,
      });
    }
  }
});
