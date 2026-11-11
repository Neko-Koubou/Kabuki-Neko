/**
 * TASK-160 end-to-end host stage (S16) against the real API and the production web build.
 *
 * Setup: an administrator and a three-question quiz. The host signs in through the UI, opens the
 * lobby from the studio ("Host a game" → "Open lobby") and runs the game in the browser. Players
 * join from Node sockets.
 *
 * Covered:
 * - Routing: an invalid id is a 404, anonymous visitors go to sign-in with returnTo, and an unknown
 *   session ends in the terminal fallback (error state).
 * - Full game: lobby (empty, then a player) → Start → countdown/preview/answering → Skip timer →
 *   reveal → leaderboard → … → podium → FINISHED, with the report ready and linked by its real id.
 * - Duplicate Next: double clicks on "Show leaderboard" and "Next question" send one command each,
 *   so no question is skipped (question 2 of 3 follows question 1).
 * - Reconnect:
 *   - a dropped socket locks the controls ("partial"), then recovers the same question;
 *   - a page reload recovers the room (`host:recover_room`) in the same phase.
 * - Early end from an empty lobby: End game → M09 → podium without winners.
 * - Finalization failure and retry: the status frames from the socket are rewritten to
 *   "failed, retryable", which simulates a failed report save at the network layer. "Try saving
 *   again" then calls the real retry endpoint, which answers with the ready report.
 *
 * The host context reuses the API sign-in's refresh cookie (one sign-in for the whole spec), and
 * each test opens a new page in that context.
 * REST calls carry the context's own client address (added after CORS, as a proxy would).
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
/** Administrators this run may already have (host-only run, or created by earlier specs). */
const ADMINS = [
  "host-admin@example.com",
  "studio-admin@example.com",
  "player-admin@example.com",
  "join-admin@example.com",
  "admin@example.com",
  "rival@example.com",
];

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Public question as players see it. */
interface PublicQuestion {
  id: string;
  questionIndex: number;
  options: { id: string; index: number; text: string }[];
}

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  email: string;
  quizId: string;
  sockets: Socket[];
  contexts: BrowserContext[];
  browser: Browser | null;
  /** The signed-in host context and its current page. */
  host: { context: BrowserContext; page: Page } | null;
} = {
  api: null,
  token: "",
  email: "",
  quizId: "",
  sockets: [],
  contexts: [],
  host: null,
  browser: null,
};

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.80.0.1" },
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
      data: { instanceName: "Kabuki E2E", name: "Host Admin", email, password: PASSWORD },
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

/** Creates the playable three-question quiz. */
async function hostQuiz(api: APIRequestContext, token: string): Promise<string> {
  const auth = { Authorization: `Bearer ${token}` };
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Host E2E" },
  });
  expect(created.status()).toBe(201);
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  /** One single-choice question from the blank template. */
  const question = (orderIndex: number, promptText: string, options: [string, boolean?][]) => ({
    ...blank,
    id: randomUUID(),
    orderIndex,
    type: "SINGLE_CHOICE",
    promptText,
    timeLimitSec: 20,
    pointsMultiplier: 1,
    explanationText: orderIndex === 0 ? "Jakarta adalah ibu kota sejak 1949." : null,
    options: options.map(([optionText, isCorrect = false], index) => ({
      id: randomUUID(),
      optionIndex: index,
      colorIndex: index,
      optionText,
      isCorrect,
      sortOrder: index,
    })),
  });
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Host E2E",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        question(0, "Ibu kota Indonesia?", [["Jakarta", true], ["Bandung"]]),
        question(1, "Gunung tertinggi di Jawa?", [["Semeru", true], ["Merapi"]]),
        question(2, "Pulau terbesar di Indonesia?", [["Kalimantan", true], ["Papua"]]),
      ],
    },
  });
  const detail = (await saved.json()) as { id: string; isPlayable: boolean };
  expect(saved.status(), JSON.stringify(detail)).toBe(200);
  expect(detail.isPlayable).toBe(true);
  return detail.id;
}

/**
 * A page of the one signed-in host context, opened on `returnTo`.
 *
 * The browser never signs in through the form: the per-email sign-in limit (5 per minute) is
 * shared with the other specs that use the same administrator. Instead the context starts with the
 * refresh cookie of the API sign-in from `beforeAll`, and the page renews its access token from it,
 * as after a reload. The previous page is closed first, so two pages never rotate the refresh
 * token at the same time.
 */
async function signedIn(returnTo: string) {
  if (!state.host) {
    if (!state.api || !state.browser) throw new Error("setup missing");
    const context = await state.browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: await state.api.storageState(),
    });
    state.contexts.push(context);
    // Added at the network layer (after CORS), as a reverse proxy would.
    await context.route(`${API}/**`, (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "10.80.1.1" } }),
    );
    state.host = { context, page: await context.newPage() };
  } else {
    await state.host.page.close();
    state.host = { context: state.host.context, page: await state.host.context.newPage() };
  }
  const { context, page } = state.host;
  await page.goto(returnTo);
  await expect(page).toHaveURL(new RegExp(`${returnTo}$`, "u"));
  return { context, page };
}

/** Opens the lobby from the studio and returns the new session id and PIN. */
async function openLobby(page: Page) {
  await page.goto(`/studio/${state.quizId}`);
  const header = page.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  await header.getByRole("button", { name: "Host a game" }).click();
  await page.getByRole("button", { name: "Open lobby" }).click();
  await page.waitForURL(/\/host\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  const sessionId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(stage(page)).toHaveAttribute("data-phase", "LOBBY", { timeout: 20_000 });
  const label = (await page.getByLabel(/^PIN \d{6}$/u).getAttribute("aria-label")) ?? "";
  return { sessionId, pinCode: label.slice(4) };
}

/** The stage root carrying the server phase. */
const stage = (page: Page) => page.locator("main [data-phase]").first();

/** Connects a Node player and joins the room. */
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
      const question = envelope?.data?.question;
      if (question) questions.set(question.questionIndex, question);
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
    /** Answers question `index` with the option whose text is `text`. */
    async answer(index: number, text: string) {
      await expect.poll(() => questions.has(index), { timeout: 20_000 }).toBe(true);
      const question = questions.get(index);
      if (!question) throw new Error("question missing");
      const ack = (await socket.timeout(10_000).emitWithAck("player:submit_answer", {
        requestId: randomUUID(),
        sessionId,
        pinCode,
        questionIndex: index,
        questionId: question.id,
        submissionId: randomUUID(),
        answer: question.options.find((option) => option.text === text)?.index,
      })) as { ok: boolean; error?: unknown };
      expect(ack.ok, JSON.stringify(ack.error)).toBe(true);
    },
  };
}

/** Waits until the stage shows answering for question `index` (1-based). */
async function waitForAnswering(page: Page, index: number) {
  await expect(stage(page)).toHaveAttribute("data-phase", "QUESTION_ANSWERING", {
    timeout: 25_000,
  });
  await expect(page.getByText(new RegExp(`^Question ${index} of 3`, "u"))).toBeVisible();
}

/** Walks every object in a parsed frame and replaces report statuses with "failed". */
function failStatuses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(failStatuses);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isStatus =
    typeof record["sessionId"] === "string" &&
    typeof record["status"] === "string" &&
    "retryable" in record &&
    "updatedAt" in record;
  if (isStatus)
    return {
      ...record,
      status: "failed",
      reportId: null,
      retryable: true,
      errorCode: "REPORT_SAVE_FAILED",
      // Older than the real status, so the real retry answer is newer.
      updatedAt: Number(record["updatedAt"]) - 1,
    };
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record))
    copy[key] = key === "reportId" ? null : failStatuses(inner);
  return copy;
}

/** Rewrites Socket.IO event/ACK frames so every report status reads "failed". */
async function failFinalizationFrames(page: Page) {
  await page.routeWebSocket(/\/socket\.io\//u, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") return ws.send(message);
      const match = /^(4[23](?:\/game,)?\d*)(\[.*\])$/su.exec(message);
      if (!match?.[1] || !match[2] || !message.includes("updatedAt")) return ws.send(message);
      ws.send(`${match[1]}${JSON.stringify(failStatuses(JSON.parse(match[2])))}`);
    });
  });
}

test.beforeAll(async ({ browser }) => {
  state.browser = browser;
  const api = await apiContext();
  const signed = await admin(api);
  state.api = api;
  state.token = signed.token;
  state.email = signed.email;
  state.quizId = await hostQuiz(api, signed.token);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
});

test("routes: invalid id 404, anonymous sign-in redirect, unknown session fallback", async ({
  browser,
}) => {
  const anonymous = await browser.newPage();
  const missing = await anonymous.goto("/host/not-a-session");
  expect(missing?.status()).toBe(404);
  const unknown = randomUUID();
  await anonymous.goto(`/host/${unknown}`);
  await anonymous.waitForURL(`**/login?returnTo=${encodeURIComponent(`/host/${unknown}`)}`);
  await anonymous.close();

  const { page } = await signedIn(`/host/${unknown}`);
  await expect(page).toHaveTitle("Host · Kabuki Neko");
  await expect(page.getByText("This game has ended or expired.")).toBeVisible({
    timeout: 20_000,
  });
});

test("runs a full game with duplicate-safe Next, reconnect and the ready report", async () => {
  test.setTimeout(240_000);
  const { page } = await signedIn(`/studio/${state.quizId}`);
  // Recording proxy for the stage socket, so the connection can be dropped.
  const open = new Set<{ close: () => Promise<void> }>();
  await page.routeWebSocket(/\/socket\.io\//u, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    const handle = { close: () => ws.close({ code: 1006, reason: "dropped" }) };
    open.add(handle);
    ws.onClose(() => open.delete(handle));
  });
  const room = await openLobby(page);

  // Empty lobby, then one player.
  await expect(page.getByText("No players yet. Share the PIN so players can join.")).toBeVisible();
  const rival = await nodePlayer(room.pinCode, "Rival", "10.80.2.2");
  await expect(page.getByText("Rival", { exact: true })).toBeVisible();

  // Start → countdown/preview → answering of question 1.
  await page.getByRole("button", { name: "Start game" }).click();
  await waitForAnswering(page, 1);
  await expect(page.getByText("0 of 1 answered")).toBeVisible();
  // Once every player answered, the server reveals at once.
  await rival.answer(0, "Jakarta");
  await expect(stage(page)).toHaveAttribute("data-phase", "ANSWER_REVEAL", { timeout: 25_000 });

  // Explanation (M08) for the revealed question.
  await page.getByRole("button", { name: "Explanation" }).click();
  await expect(page.getByText("Jakarta adalah ibu kota sejak 1949.")).toBeVisible();
  await page.keyboard.press("Escape");

  // Duplicate Next: one command per double click, no skipped question.
  await page.getByRole("button", { name: "Show leaderboard" }).dblclick();
  await expect(stage(page)).toHaveAttribute("data-phase", "LEADERBOARD");
  await page.getByRole("button", { name: "Next question" }).dblclick();
  await waitForAnswering(page, 2);

  // Dropped socket: controls pause, then the same question comes back.
  for (const handle of [...open]) await handle.close();
  await expect(
    page.getByText("Controls are paused until the connection is restored."),
  ).toBeVisible();
  await expect(page.getByText("Controls are paused until the connection is restored.")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.getByText(/^Question 2 of 3/u)).toBeVisible();

  // Reload: host:recover_room restores the same phase.
  await page.reload();
  await waitForAnswering(page, 2);

  // Skip timer → reveal → leaderboard → question 3 → reveal → podium.
  await page.getByRole("button", { name: "Skip timer" }).click();
  await expect(stage(page)).toHaveAttribute("data-phase", "ANSWER_REVEAL");
  await page.getByRole("button", { name: "Show leaderboard" }).click();
  await page.getByRole("button", { name: "Next question" }).click();
  await waitForAnswering(page, 3);
  await page.getByRole("button", { name: "Skip timer" }).click();
  await expect(stage(page)).toHaveAttribute("data-phase", "ANSWER_REVEAL");
  await page.getByRole("button", { name: "Show podium" }).dblclick();
  await expect(stage(page)).toHaveAttribute("data-phase", /PODIUM|FINISHED/u);
  await expect(page.getByText("1st place: Rival")).toBeVisible({ timeout: 15_000 });
  await expect(stage(page)).toHaveAttribute("data-phase", "FINISHED", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Game over" })).toBeVisible();

  // The report: ready, linked by the real id (the session id).
  await expect(page.getByText("The report is ready.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "View report" })).toHaveAttribute(
    "href",
    `/dashboard/reports/${room.sessionId}`,
  );
  // A reload after FINISHED shows the final state without replaying the podium.
  await page.reload();
  await expect(stage(page)).toHaveAttribute("data-phase", "FINISHED", { timeout: 20_000 });
  await expect(page.getByText("1st place: Rival")).toBeVisible();
});

test("ends early from an empty lobby and retries a failed report save", async () => {
  test.setTimeout(120_000);
  const { page } = await signedIn(`/studio/${state.quizId}`);
  await failFinalizationFrames(page);
  const room = await openLobby(page);
  await expect(page.getByText("No players yet. Share the PIN so players can join.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start game" })).toBeDisabled();

  // End from the lobby through M09.
  await page.getByRole("button", { name: "End game" }).click();
  await page.getByRole("button", { name: "End the game" }).click();
  await expect(stage(page)).toHaveAttribute("data-phase", /PODIUM|FINISHED/u, {
    timeout: 20_000,
  });
  await expect(page.getByText("No winners this time.")).toBeVisible();

  // The simulated failure: no report link, a retry instead.
  await expect(page.getByText("The report couldn't be saved.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "View report" })).toHaveCount(0);

  // Wait until the real save finished, then retry through the real endpoint.
  await expect
    .poll(
      async () => {
        const response = await state.api?.get(`/api/v1/reports/${room.sessionId}/status`, {
          headers: { Authorization: `Bearer ${state.token}` },
        });
        return ((await response?.json()) as { status?: string } | undefined)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe("ready");
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByText("The report is ready.")).toBeVisible();
  await expect(page.getByRole("link", { name: "View report" })).toHaveAttribute(
    "href",
    `/dashboard/reports/${room.sessionId}`,
  );
});
