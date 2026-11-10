/**
 * TASK-157 end-to-end guest game (S15) against the real API and the production web build.
 *
 * Setup: an administrator session, a quiz with one question per input type (single choice,
 * true/false, multiple select, typed answer, order puzzle, poll) plus a 5-second question, and a
 * host driving rooms over a real socket.
 *
 * Covered:
 * - Loading ("Connecting…" while the socket never answers), empty (no credentials → join link),
 *   ideal (all phases), partial (dropped connection → locked stale screen, then automatic
 *   recovery) and error (kicked → terminal fallback, credentials cleared).
 * - Streamer room: all six inputs through the UI.
 *   - An accepted answer survives a page refresh, locked.
 *   - The deadline shows "Time's up." with locked input, then "No answer" after grace.
 *   - Reveal, leaderboard, podium and the final screen.
 * - Projector room: shapes first, with the option text on request.
 * - No key before the reveal: the page HTML/RSC payload holds no quiz content, and during
 *   answering neither the DOM nor any socket frame holds an accepted text or `isCorrect`.
 *
 * A second player answers from a Node socket, so questions stay open after the browser player
 * answers. Per-IP socket limits stay within budget by giving each client its own address.
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
import { io, type Socket } from "socket.io-client";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may already have (player-only run, or created by earlier specs). */
const ADMINS = [
  "player-admin@example.com",
  "join-admin@example.com",
  "admin@example.com",
  "rival@example.com",
];

test.describe.configure({ mode: "serial" });

/** A room created by the host. */
interface Room {
  pinCode: string;
  sessionId: string;
}

/** Public question as players see it. */
interface PublicQuestion {
  id: string;
  questionIndex: number;
  options: { id: string; index: number; text: string }[];
}

/** Shared fixtures for the serial flows. */
const state: {
  api: APIRequestContext | null;
  host: Socket | null;
  hostPushes: Pushes | null;
  quiz: { id: string; revision: number } | null;
  sockets: Socket[];
} = { api: null, host: null, hostPushes: null, quiz: null, sockets: [] };

/** What a socket learned from server pushes (no polling: sync and commands are rate limited). */
interface Pushes {
  /** Latest phase version per session. */
  versions: Map<string, number>;
  /** Latest answering question per session. */
  questions: Map<string, PublicQuestion>;
}

/** Records phase versions and answering questions from every push a socket receives. */
function track(socket: Socket): Pushes {
  const pushes: Pushes = { versions: new Map(), questions: new Map() };
  socket.onAny(
    (
      event: string,
      envelope?: {
        sessionId?: string;
        phaseVersion?: number;
        data?: { question?: PublicQuestion };
      },
    ) => {
      const sessionId = envelope?.sessionId;
      const version = envelope?.phaseVersion;
      if (!sessionId || typeof version !== "number") return;
      pushes.versions.set(sessionId, Math.max(pushes.versions.get(sessionId) ?? 0, version));
      if (event === "game:question_answering" && envelope?.data?.question)
        pushes.questions.set(sessionId, envelope.data.question);
    },
  );
  return pushes;
}

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.60.0.1" },
  });
}

/** Signs in an administrator, running first-run setup when the instance is new. */
async function adminToken(api: APIRequestContext): Promise<string> {
  const status = (await (await api.get("/api/v1/auth/setup-status")).json()) as {
    isInitialized: boolean;
  };
  if (!status.isInitialized) {
    const setup = await api.post("/api/v1/auth/setup", {
      headers: { "Idempotency-Key": randomUUID() },
      data: {
        instanceName: "Kabuki E2E",
        name: "Player Admin",
        email: ADMINS[0],
        password: PASSWORD,
      },
    });
    if (setup.status() === 201)
      return ((await setup.json()) as { accessToken: string }).accessToken;
  }
  for (const email of ADMINS) {
    const login = await api.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
    if (login.status() === 200)
      return ((await login.json()) as { accessToken: string }).accessToken;
  }
  throw new Error("No administrator could sign in");
}

/** Creates the playable quiz with every input type and a 5-second question. */
async function gameQuiz(api: APIRequestContext, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Pemain E2E" },
  });
  expect(created.status()).toBe(201);
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  /** One question from the blank template. */
  const question = (
    orderIndex: number,
    type: string,
    promptText: string,
    options: [string, boolean?][],
    extra: Record<string, unknown> = {},
  ) => ({
    ...blank,
    id: randomUUID(),
    orderIndex,
    type,
    promptText,
    timeLimitSec: 20,
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
  });
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Pemain E2E",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        question(0, "SINGLE_CHOICE", "Ibu kota Indonesia?", [
          ["Jakarta", true],
          ["Bandung"],
          ["Surabaya"],
          ["Medan"],
        ]),
        question(1, "TRUE_FALSE", "Kucing adalah mamalia.", [["Benar", true], ["Salah"]]),
        question(2, "MULTIPLE_SELECT", "Pilih kota di Pulau Jawa.", [
          ["Bandung", true],
          ["Surabaya", true],
          ["Medan"],
          ["Makassar"],
        ]),
        question(3, "TYPE_ANSWER", "Apa bahasa Jepang untuk kucing?", [
          ["Neko", true],
          ["ねこ", true],
        ]),
        question(4, "ORDER_PUZZLE", "Urutkan dari kecil ke besar.", [
          ["Satu"],
          ["Dua"],
          ["Tiga"],
          ["Empat"],
        ]),
        question(5, "POLL", "Warna favoritmu?", [["Merah"], ["Biru"], ["Hijau"]]),
        question(6, "SINGLE_CHOICE", "Jawab sebelum waktu habis!", [["Ya", true], ["Tidak"]], {
          timeLimitSec: 5,
        }),
      ],
    },
  });
  const detail = (await saved.json()) as { id: string; revision: number; isPlayable: boolean };
  expect(saved.status(), JSON.stringify(detail)).toBe(200);
  expect(detail.isPlayable, JSON.stringify(detail)).toBe(true);
  return detail;
}

/** Connects a socket to /game with its own client address. */
async function connect(address: string, accessToken?: string): Promise<Socket> {
  const socket = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: accessToken ? { protocolVersion: 1, accessToken } : { protocolVersion: 1 },
    extraHeaders: { origin: WEB, "x-forwarded-for": address },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  state.sockets.push(socket);
  return socket;
}

/** Sends a command and returns its ACK data. */
async function command<T>(
  socket: Socket,
  event: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const ack = (await socket
    .timeout(10_000)
    .emitWithAck(event, { requestId: randomUUID(), ...payload })) as {
    ok: boolean;
    data?: T;
    error?: unknown;
  };
  if (!ack.ok || ack.data === undefined)
    throw new Error(`${event} failed: ${JSON.stringify(ack.error)}`);
  return ack.data;
}

/** The host's current snapshot. */
async function hostSnapshot(room: Room) {
  if (!state.host) throw new Error("host missing");
  const data = await command<{
    snapshot: { phase: string; phaseVersion: number; players: { id: string; nickname: string }[] };
  }>(state.host, "room:sync", { sessionId: room.sessionId, pinCode: room.pinCode });
  return data.snapshot;
}

/**
 * Sends a phase command with the phase version known from pushes. On a stale version (a timer
 * transition still in flight) it syncs once and retries.
 */
async function hostStep(room: Room, event: string) {
  const host = state.host;
  const pushes = state.hostPushes;
  if (!host || !pushes) throw new Error("host missing");
  /** One attempt with the given version; records the new version from the ACK. */
  const attempt = async (expectedPhaseVersion: number) => {
    const data = await command<{ phaseVersion: number }>(host, event, {
      sessionId: room.sessionId,
      pinCode: room.pinCode,
      expectedPhaseVersion,
    });
    pushes.versions.set(
      room.sessionId,
      Math.max(pushes.versions.get(room.sessionId) ?? 0, data.phaseVersion),
    );
    return data;
  };
  const known = pushes.versions.get(room.sessionId);
  if (known !== undefined) {
    try {
      return await attempt(known);
    } catch {
      // Fall through to a fresh snapshot.
    }
  }
  return attempt((await hostSnapshot(room)).phaseVersion);
}

/** Creates a room for the quiz. */
async function createRoom(displayMode: "PROJECTOR" | "STREAMER"): Promise<Room> {
  if (!state.host || !state.quiz) throw new Error("setup missing");
  const room = await command<Room & { phaseVersion: number }>(state.host, "host:create_room", {
    quizId: state.quiz.id,
    quizRevision: state.quiz.revision,
    displayMode,
    friendlyNicknames: false,
  });
  state.hostPushes?.versions.set(room.sessionId, room.phaseVersion);
  return { pinCode: room.pinCode, sessionId: room.sessionId };
}

/** A second player answering from Node (keeps questions open until it answers). */
async function nodePlayer(room: Room, nickname: string, address: string) {
  const socket = await connect(address);
  const pushes = track(socket);
  let answered = -1;
  await command(socket, "player:join_room", {
    pinCode: room.pinCode,
    nickname,
    avatar: { style: "bottts", seed: "rival" },
  });
  /** The next question announced by the server, once it is open. */
  const nextQuestion = () => {
    const question = pushes.questions.get(room.sessionId);
    return question && question.questionIndex > answered ? question : null;
  };
  return {
    /** Answers the next question once the server announces it. */
    async answer(pick: (question: PublicQuestion) => unknown) {
      await expect.poll(() => nextQuestion() !== null, { timeout: 20_000 }).toBe(true);
      const open = nextQuestion();
      if (!open) throw new Error("question missing");
      answered = open.questionIndex;
      await command(socket, "player:submit_answer", {
        sessionId: room.sessionId,
        pinCode: room.pinCode,
        questionIndex: open.questionIndex,
        questionId: open.id,
        submissionId: randomUUID(),
        answer: pick(open),
      });
    },
  };
}

/** Routes the page's game socket through a recorder that can also drop the connection. */
async function recordSocket(page: Page) {
  const frames: string[] = [];
  const open = new Set<{ close: () => Promise<void> }>();
  await page.routeWebSocket(/\/socket\.io\//u, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message === "string") frames.push(message);
      ws.send(message);
    });
    const handle = { close: () => ws.close({ code: 1006, reason: "dropped" }) };
    open.add(handle);
    ws.onClose(() => open.delete(handle));
  });
  return {
    frames,
    /** Frames received from index `from` on. */
    since: (from: number) => frames.slice(from).join("\n"),
    /** Drops every open game connection (the client reconnects with backoff). */
    async drop() {
      for (const handle of [...open]) await handle.close();
    },
  };
}

/** A browser player joined through the real join flow. */
async function browserPlayer(browser: Browser, room: Room, nickname: string, address: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": address } });
  const page = await context.newPage();
  const socket = await recordSocket(page);
  await page.goto(`/join?pin=${room.pinCode}`);
  await expect(page.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await page.getByLabel(/^Nickname/u).fill(nickname);
  await page.getByRole("button", { name: "Join game" }).click();
  await page.waitForURL(`**/play/${room.pinCode}`);
  await expect(page.getByText("Waiting for the host to start…")).toBeVisible();
  return { context, page, socket };
}

/** Waits for the answering screen of a choice question (an option button). */
async function waitForOption(page: Page, name: string) {
  await expect(page.getByRole("button", { name })).toBeVisible({ timeout: 20_000 });
}

/** Next: reveal → leaderboard → next question (or podium). */
async function nextFromReveal(room: Room, page: Page) {
  await hostStep(room, "host:next_step");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await hostStep(room, "host:next_step");
}

test.beforeAll(async () => {
  const api = await apiContext();
  const token = await adminToken(api);
  state.api = api;
  state.quiz = await gameQuiz(api, token);
  state.host = await connect("10.60.0.2", token);
  state.hostPushes = track(state.host);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  await state.api?.dispose();
});

test("shows the empty state without credentials and loading while the socket never answers", async ({
  browser,
}) => {
  const page = await browser.newPage();
  const missing = await page.goto("/play/12ab56");
  expect(missing?.status()).toBe(404);
  await page.goto("/play/123456");
  await expect(page).toHaveTitle("Game · Kabuki Neko");
  await expect(page.getByText("Join a game to connect.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Join a game" })).toHaveAttribute("href", "/join");
  await page.close();

  const context = await browser.newContext();
  await context.addInitScript(
    ({ sessionId, playerId }) => {
      window.localStorage.setItem(
        `kabuki:player:${sessionId}`,
        JSON.stringify({ sessionId, playerId, sessionToken: "A".repeat(43), pinCode: "654321" }),
      );
      window.localStorage.setItem("kabuki:player-pin:654321", sessionId);
    },
    { sessionId: randomUUID(), playerId: randomUUID() },
  );
  const loading = await context.newPage();
  // A mocked socket that never completes the handshake.
  await loading.routeWebSocket(/\/socket\.io\//u, () => {});
  await loading.goto("/play/654321");
  await expect(loading.getByText("Connecting…")).toBeVisible();
  await context.close();
});

test("plays all six input types in a Streamer room with refresh, reconnect, grace and podium", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const room = await createRoom("STREAMER");
  const { page, socket, context } = await browserPlayer(browser, room, "Neko", "10.60.1.1");
  // The page HTML/RSC payload never carries quiz content.
  const html = await (await page.request.get(`/play/${room.pinCode}`)).text();
  for (const secret of ["Ibu kota", "Jakarta", "ねこ", "isCorrect"])
    expect(html).not.toContain(secret);
  const rival = await nodePlayer(room, "Tora", "10.60.0.3");
  await expect(page.getByText("Score")).toBeVisible();

  await hostStep(room, "host:start_game");
  await expect(page.getByText("Get ready…").first()).toBeVisible();

  // 1. Single choice: accepted answer survives a refresh, locked.
  await expect(page.getByRole("heading", { name: "Ibu kota Indonesia?" })).toBeVisible({
    timeout: 15_000,
  });
  await waitForOption(page, "Option A, ▲: Jakarta");
  await page.getByRole("button", { name: "Option A, ▲: Jakarta" }).click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Option A, ▲: Jakarta" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rival.answer(() => 1);
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^\+\d[\d,]* points$/u)).toBeVisible();
  await nextFromReveal(room, page);

  // 2. True/false, then a dropped connection on the leaderboard (partial) that recovers.
  await waitForOption(page, "Option A, ▲: Benar");
  await page.getByRole("button", { name: "Option A, ▲: Benar" }).click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  await rival.answer(() => 1);
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });
  await hostStep(room, "host:next_step");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(page.getByText("You're in 1st place")).toBeVisible();
  await socket.drop();
  await expect(page.locator("[data-recovery]")).toBeVisible();
  await expect(page.locator("[inert]")).toHaveCount(1);
  await expect(page.locator("[data-recovery]")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Connected")).toBeAttached();
  await hostStep(room, "host:next_step");

  // 3. Multiple select needs a choice and sends the chosen set.
  await waitForOption(page, "Option A, ▲: Bandung");
  await page.getByRole("button", { name: "Submit answer (0)" }).click();
  await expect(page.getByText("Choose an answer first.")).toBeVisible();
  await page.getByRole("button", { name: "Option A, ▲: Bandung" }).click();
  await page.getByRole("button", { name: "Option B, ◆: Surabaya" }).click();
  await page.getByRole("button", { name: "Submit answer (2)" }).click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  await rival.answer(() => [2]);
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });
  await nextFromReveal(room, page);

  // 4. Typed answer: no accepted text in the DOM or any frame before the reveal.
  const field = page.getByLabel("Type your answer");
  await expect(field).toBeVisible({ timeout: 20_000 });
  const typedFrom = socket.frames.length;
  expect(await page.content()).not.toContain("ねこ");
  await field.fill("  neko ");
  await field.press("Enter");
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  await expect(field).toHaveAttribute("readonly", "");
  expect(socket.since(typedFrom)).not.toContain("ねこ");
  expect(socket.since(typedFrom)).not.toContain("isCorrect");
  await rival.answer(() => "salah");
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("ねこ", { exact: true })).toBeVisible();
  await nextFromReveal(room, page);

  // 5. Order puzzle: reorder with the move buttons into the right order.
  await expect(page.getByText("Put the items in the right order.")).toBeVisible({
    timeout: 20_000,
  });
  const puzzleFrom = socket.frames.length;
  const target = ["Satu", "Dua", "Tiga", "Empat"];
  for (const [position, word] of target.entries()) {
    for (let guard = 0; guard < 4; guard += 1) {
      const order = await page.locator("ol > li").allInnerTexts();
      const current = order.findIndex((text) => text.includes(word));
      if (current <= position) break;
      await page
        .getByRole("button", { name: new RegExp(`^Move item up Option .+: ${word}$`, "u") })
        .click();
    }
  }
  const finalOrder = await page.locator("ol > li").allInnerTexts();
  expect(target.map((word) => finalOrder.findIndex((text) => text.includes(word)))).toEqual([
    0, 1, 2, 3,
  ]);
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  expect(socket.since(puzzleFrom)).not.toContain('correctOrderIds":["');
  await rival.answer((question) => question.options.map((option) => option.index).reverse());
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });
  await nextFromReveal(room, page);

  // 6. Poll: neutral, no correctness.
  await waitForOption(page, "Option B, ◆: Biru");
  await expect(
    page.getByText("This is a poll. There are no points and no wrong answers."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Option B, ◆: Biru" }).click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
  await rival.answer(() => 0);
  await expect(page.getByRole("heading", { name: "Thanks for voting!" })).toBeVisible({
    timeout: 15_000,
  });
  await nextFromReveal(room, page);

  // 7. Five seconds without an answer: locked at the deadline, then "No answer".
  await waitForOption(page, "Option A, ▲: Ya");
  // The pad's visible status (the timer also announces it to screen readers).
  await expect(page.locator("p:not(.sr-only)", { hasText: "Time's up." })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Option A, ▲: Ya" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByRole("heading", { name: "No answer" })).toBeVisible({ timeout: 15_000 });

  // After the last reveal the host goes straight to the podium, then the final screen.
  await hostStep(room, "host:next_step");
  await expect(page.getByRole("heading", { name: "Podium" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Game over" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("1st place: Neko")).toBeAttached();
  await expect(page.getByRole("link", { name: "Join a game" })).toHaveAttribute("href", "/join");
  await expect(page.getByRole("link", { name: "View report" })).toHaveCount(0);
  await context.close();
});

test("shows shapes first in a Projector room, text on request, and ends cleanly when kicked", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const room = await createRoom("PROJECTOR");
  const { page, context } = await browserPlayer(browser, room, "Kitsune", "10.60.1.2");
  await hostStep(room, "host:start_game");
  await waitForOption(page, "Option A, ▲: Jakarta");
  await expect(
    page.getByText(
      "Questions and answers appear on the shared screen; players see only the answer buttons.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Jakarta", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show question text on this device" }).click();
  await expect(page.getByText("Jakarta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Option A, ▲: Jakarta" }).click();
  await expect(page.getByRole("heading", { name: "Correct!" })).toBeVisible({ timeout: 15_000 });

  const snapshot = await hostSnapshot(room);
  const player = snapshot.players.find((entry) => entry.nickname === "Kitsune");
  if (!player || !state.host) throw new Error("player missing");
  await command(state.host, "host:kick_player", {
    sessionId: room.sessionId,
    pinCode: room.pinCode,
    playerId: player.id,
  });
  await expect(page.getByText("The host removed you from this game.")).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage }));
  expect(stored).not.toContain(room.sessionId);
  await context.close();
});
