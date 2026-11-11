/**
 * TASK-163 end-to-end reports (S09/S10/M12 and CSV) against the real API and the production web
 * build.
 *
 * Fixtures are real games driven over sockets:
 * - "complete" game: four questions:
 *   - single choice;
 *   - multiple select (Ani earns partial credit);
 *   - poll;
 *   - zero-point true/false.
 *   Players:
 *   - Ani answers everything;
 *   - Budi never answers;
 *   - Caca answers the first question wrongly and is removed (kicked).
 * - "early end" game: the host ends it during the first question and nobody answers (zero
 *   answers, three unplayed questions).
 *
 * Covered:
 * - Only ready reports are listed, newest first, with the early-end badge.
 * - Ready report:
 *   - KPIs and the accuracy definition;
 *   - players, with "—" as the rank of the removed player;
 *   - M12 shows Ani's partial answer readably;
 *   - questions, including the poll and the zero-point question without accuracy;
 *   - the hardest questions.
 * - Early end: the badge, the zero-answer notice and "Not played" questions.
 * - CSV: the browser download is byte-identical to the API's export.
 * - Gate: a report still being saved shows the pending message, never the data.
 * - Access: another host gets a 404 for the report and its CSV; a request without a host token
 *   gets a 401.
 */
import { randomUUID } from "node:crypto";
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

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may already have (reports-only run, or created by earlier specs). */
const ADMINS = [
  "reports-admin@example.com",
  "audio-admin@example.com",
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

/** A room driven from Node. */
interface Room {
  sessionId: string;
  pinCode: string;
}

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  quizId: string;
  quizRevision: number;
  host: Socket | null;
  versions: Map<string, number>;
  sockets: Socket[];
  contexts: BrowserContext[];
  hostContext: BrowserContext | null;
  complete: Room | null;
  early: Room | null;
} = {
  api: null,
  token: "",
  quizId: "",
  quizRevision: 0,
  host: null,
  versions: new Map(),
  sockets: [],
  contexts: [],
  hostContext: null,
  complete: null,
  early: null,
};

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(address = "10.95.0.1"): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": address },
  });
}

/** Signs in an administrator once (first-run setup when needed). */
async function adminToken(api: APIRequestContext): Promise<string> {
  const status = (await (await api.get("/api/v1/auth/setup-status")).json()) as {
    isInitialized: boolean;
  };
  if (!status.isInitialized) {
    const setup = await api.post("/api/v1/auth/setup", {
      headers: { "Idempotency-Key": randomUUID() },
      data: {
        instanceName: "Kabuki E2E",
        name: "Reports Admin",
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

/** Authorization header of the administrator. */
const auth = () => ({ Authorization: `Bearer ${state.token}` });

/** Creates the four-question quiz. */
async function reportQuiz(api: APIRequestContext) {
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth(), "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Laporan E2E" },
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
    pointsMultiplier = 1,
  ) => ({
    ...blank,
    id: randomUUID(),
    orderIndex,
    type,
    promptText,
    timeLimitSec: 30,
    pointsMultiplier,
    explanationText: null,
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
    headers: { ...auth(), "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Laporan E2E",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        question(0, "SINGLE_CHOICE", "Ibu kota Indonesia?", [["Jakarta", true], ["Bandung"]]),
        question(1, "MULTIPLE_SELECT", "Kota di Pulau Jawa?", [
          ["Bandung", true],
          ["Surabaya", true],
          ["Medan"],
        ]),
        question(2, "POLL", "Musim favoritmu?", [["Hujan"], ["Kemarau"]], 0),
        question(3, "TRUE_FALSE", "Pertanyaan latihan tanpa poin", [["Benar", true], ["Salah"]], 0),
      ],
    },
  });
  const detail = (await saved.json()) as { id: string; revision: number; isPlayable: boolean };
  expect(saved.status(), JSON.stringify(detail)).toBe(200);
  expect(detail.isPlayable).toBe(true);
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

/** Sends a command and returns its ACK data (throws on a refusal). */
async function command<T>(socket: Socket, event: string, payload: Record<string, unknown>) {
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

/** Sends a phase command with the latest known phase version (syncing once if stale). */
async function hostStep(room: Room, event: string, extra: Record<string, unknown> = {}) {
  const host = state.host;
  if (!host) throw new Error("host missing");
  const send = async (expectedPhaseVersion: number) => {
    const data = await command<{ phaseVersion: number }>(host, event, {
      sessionId: room.sessionId,
      pinCode: room.pinCode,
      expectedPhaseVersion,
      ...extra,
    });
    state.versions.set(room.sessionId, data.phaseVersion);
    return data;
  };
  try {
    return await send(state.versions.get(room.sessionId) ?? 1);
  } catch {
    const { snapshot } = await command<{ snapshot: { phaseVersion: number } }>(host, "room:sync", {
      sessionId: room.sessionId,
      pinCode: room.pinCode,
    });
    return send(snapshot.phaseVersion);
  }
}

/** A Node player that records announced questions. */
async function player(room: Room, nickname: string, address: string) {
  const socket = await connect(address);
  const questions = new Map<number, PublicQuestion>();
  socket.on(
    "game:question_answering",
    (envelope: { data?: { question?: PublicQuestion } } | undefined) => {
      const question = envelope?.data?.question;
      if (question) questions.set(question.questionIndex, question);
    },
  );
  const joined = await command<{ playerId: string }>(socket, "player:join_room", {
    pinCode: room.pinCode,
    nickname,
    avatar: { style: "bottts", seed: nickname },
  });
  return {
    id: joined.playerId,
    /** Waits until question `index` is open for answers. */
    async open(index: number) {
      await expect.poll(() => questions.has(index), { timeout: 30_000 }).toBe(true);
      const question = questions.get(index);
      if (!question) throw new Error("question missing");
      return question;
    },
    /** Answers question `index` with `answer`. */
    async answer(index: number, answer: unknown) {
      const question = await this.open(index);
      await command(socket, "player:submit_answer", {
        sessionId: room.sessionId,
        pinCode: room.pinCode,
        questionIndex: index,
        questionId: question.id,
        submissionId: randomUUID(),
        answer,
      });
    },
  };
}

/** Creates a room for the quiz from the Node host. */
async function createRoom(): Promise<Room> {
  if (!state.host) throw new Error("host missing");
  const room = await command<Room & { phaseVersion: number }>(state.host, "host:create_room", {
    quizId: state.quizId,
    quizRevision: state.quizRevision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  state.versions.set(room.sessionId, room.phaseVersion);
  return { sessionId: room.sessionId, pinCode: room.pinCode };
}

/** Waits until the report of `room` is ready. */
async function reportReady(room: Room) {
  await expect
    .poll(
      async () => {
        const response = await state.api?.get(`/api/v1/reports/${room.sessionId}/status`, {
          headers: auth(),
        });
        return ((await response?.json()) as { status?: string } | undefined)?.status;
      },
      { timeout: 45_000 },
    )
    .toBe("ready");
}

/** Plays the complete game. */
async function playComplete(): Promise<Room> {
  const room = await createRoom();
  const ani = await player(room, "Ani", "10.95.1.1");
  await player(room, "Budi", "10.95.1.2");
  const caca = await player(room, "Caca", "10.95.1.3");
  await hostStep(room, "host:start_game");
  // Q1: Ani right, Caca wrong; then Caca is removed on the leaderboard.
  await ani.answer(0, 0);
  await caca.answer(0, 1);
  await hostStep(room, "host:skip_timer");
  await hostStep(room, "host:next_step");
  if (!state.host) throw new Error("host missing");
  await command(state.host, "host:kick_player", {
    sessionId: room.sessionId,
    pinCode: room.pinCode,
    playerId: caca.id,
  });
  await hostStep(room, "host:next_step");
  // Q2: Ani picks one of the two right cities and no wrong one (partial credit).
  await ani.answer(1, [0]);
  await hostStep(room, "host:skip_timer");
  await hostStep(room, "host:next_step");
  await hostStep(room, "host:next_step");
  // Q3: poll.
  await ani.answer(2, 1);
  await hostStep(room, "host:skip_timer");
  await hostStep(room, "host:next_step");
  await hostStep(room, "host:next_step");
  // Q4: zero points.
  await ani.answer(3, 0);
  await hostStep(room, "host:skip_timer");
  await hostStep(room, "host:next_step");
  await reportReady(room);
  return room;
}

/** Plays the early-ended game with no answers. */
async function playEarlyEnd(): Promise<Room> {
  const room = await createRoom();
  const dodi = await player(room, "Dodi", "10.95.2.1");
  await hostStep(room, "host:start_game");
  await dodi.open(0);
  await hostStep(room, "host:end_game");
  await reportReady(room);
  return room;
}

/**
 * A fresh page of the one signed-in administrator context (no form sign-in). The context starts
 * with the API sign-in's refresh cookie; it is reused because every refresh rotates that cookie,
 * and earlier pages are closed so two pages never rotate it at the same time.
 */
async function hostPage(browser: Browser): Promise<Page> {
  if (!state.api) throw new Error("api missing");
  if (!state.hostContext) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: await state.api.storageState(),
      acceptDownloads: true,
    });
    state.contexts.push(context);
    await context.route(`${API}/**`, (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "10.95.3.1" } }),
    );
    state.hostContext = context;
  }
  for (const open of state.hostContext.pages()) await open.close();
  return state.hostContext.newPage();
}

/** Creates (or signs in) a second host account; returns its access token. */
async function otherHostToken(): Promise<string> {
  const api = await apiContext("10.95.4.1");
  const email = "reports-other@example.com";
  const login = await api.post("/api/v1/auth/login", { data: { email, password: PASSWORD } });
  if (login.status() === 200) {
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    await api.dispose();
    return token;
  }
  const admin = state.api;
  if (!admin) throw new Error("api missing");
  const current = (await (
    await admin.get("/api/v1/system/settings", { headers: auth() })
  ).json()) as {
    settings: { revision: number; registrationMode: string };
  };
  /** Sets the registration mode (optimistic concurrency); returns the new revision. */
  const setMode = async (mode: string, revision: number) => {
    const patched = await admin.patch("/api/v1/system/settings", {
      headers: { ...auth(), "If-Match": `"${revision}"` },
      data: { registrationMode: mode },
    });
    expect(patched.status()).toBe(200);
    return ((await patched.json()) as { revision: number }).revision;
  };
  let revision = current.settings.revision;
  const original = current.settings.registrationMode;
  if (original === "SINGLE_ADMIN") revision = await setMode("INVITE_ONLY", revision);
  // PUBLIC registration takes no invite code; the other modes need one.
  let inviteCode: string | undefined;
  if (original !== "PUBLIC") {
    const invite = await admin.post("/api/v1/users/invitations", {
      headers: { ...auth(), "Idempotency-Key": randomUUID() },
      data: {},
    });
    expect(invite.status()).toBe(201);
    inviteCode = ((await invite.json()) as { inviteCode: string }).inviteCode;
  }
  const registered = await api.post("/api/v1/auth/register", {
    headers: { "Idempotency-Key": randomUUID() },
    data: { name: "Host Lain", email, password: PASSWORD, ...(inviteCode ? { inviteCode } : {}) },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  if (original === "SINGLE_ADMIN") await setMode(original, revision);
  const token = ((await registered.json()) as { accessToken: string }).accessToken;
  await api.dispose();
  return token;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const api = await apiContext();
  state.api = api;
  state.token = await adminToken(api);
  const quiz = await reportQuiz(api);
  state.quizId = quiz.id;
  state.quizRevision = quiz.revision;
  state.host = await connect("10.95.0.2", state.token);
  state.complete = await playComplete();
  state.early = await playEarlyEnd();
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
});

test("lists only ready reports, newest first, with the early-end badge", async ({ browser }) => {
  const { complete, early } = state;
  if (!complete || !early || !state.api) throw new Error("fixtures missing");
  const listed = (await (
    await state.api.get("/api/v1/reports?page=1&limit=15", { headers: auth() })
  ).json()) as { items: { id: string; status: string }[] };
  expect(listed.items.every((item) => item.status === "ready")).toBe(true);
  const ids = listed.items.map((item) => item.id);
  expect(ids.indexOf(early.sessionId)).toBeLessThan(ids.indexOf(complete.sessionId));

  const page = await hostPage(browser);
  await page.goto("/dashboard/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const table = page.locator("table");
  for (const room of [complete, early])
    await expect(table.locator(`a[href="/dashboard/reports/${room.sessionId}"]`)).toHaveText(
      "Kuis Laporan E2E",
    );
  const earlyRow = table.locator("tr", {
    has: page.locator(`a[href="/dashboard/reports/${early.sessionId}"]`),
  });
  await expect(earlyRow.getByText("Ended early by the host")).toBeVisible();
  const completeRow = table.locator("tr", {
    has: page.locator(`a[href="/dashboard/reports/${complete.sessionId}"]`),
  });
  await expect(completeRow.getByText("Completed")).toBeVisible();
  await expect(completeRow.getByText(/\(UTC\)|\(GMT/u)).toBeVisible();
});

test("shows the complete report, M12 answers, questions, hardest and an identical CSV", async ({
  browser,
}) => {
  const { complete } = state;
  if (!complete || !state.api) throw new Error("fixtures missing");
  const page = await hostPage(browser);
  await page.goto(`/dashboard/reports/${complete.sessionId}`);
  await expect(page.getByRole("heading", { name: "Kuis Laporan E2E" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Completed")).toBeVisible();
  const kpis = page.locator("dl").first();
  await expect(kpis.getByText("3", { exact: true })).toBeVisible(); // players
  await expect(kpis.getByText("4 / 4")).toBeVisible();
  await expect(
    page.getByText(
      "Missing values are shown as “—”. Polls and no-point questions don't count toward accuracy.",
    ),
  ).toBeVisible();

  // Players: Ani first, the removed player has no rank.
  const table = page.locator("table");
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toContainText("Ani");
  const caca = table.locator("tr", { hasText: "Caca" });
  await expect(caca.locator("td").first()).toHaveText("—");

  // M12: Ani's partial multiple-select answer, readable.
  await table.getByRole("button", { name: "Answers: Ani" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Kota di Pulau Jawa?")).toBeVisible();
  const partial = dialog.locator("li[data-status]", { hasText: "Kota di Pulau Jawa?" });
  await expect(partial.getByText("Partly correct")).toBeVisible();
  await expect(partial.getByText("Bandung")).toHaveCount(2); // submitted + correct
  await expect(partial.getByText("Surabaya")).toBeVisible(); // the missed correct city
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Questions: poll and zero-point question without accuracy; all four played.
  await page.getByRole("tab", { name: "Questions" }).click();
  const questions = page.locator("li[data-question-status]");
  await expect(questions).toHaveCount(4);
  await expect(page.locator('li[data-question-status="PLAYED"]')).toHaveCount(4);
  const poll = questions.filter({ hasText: "Musim favoritmu?" });
  await expect(poll.getByText("—")).toBeVisible();
  const zero = questions.filter({ hasText: "Pertanyaan latihan tanpa poin" });
  await expect(zero.getByText("No points")).toBeVisible();
  await expect(zero.getByText("—")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hardest questions" })).toBeVisible();

  // CSV: the download is the server's file, byte for byte.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const path = await download.path();
  const downloaded = await readFile(path);
  const exported = await state.api.get(`/api/v1/reports/${complete.sessionId}/export-csv`, {
    headers: auth(),
  });
  expect(exported.status()).toBe(200);
  expect(Buffer.compare(downloaded, Buffer.from(await exported.body()))).toBe(0);
  expect(download.suggestedFilename()).toMatch(/\.csv$/u);
  expect(downloaded.toString("utf8")).toContain("Ani");
});

test("shows the early-ended report with zero answers and unplayed questions", async ({
  browser,
}) => {
  const { early } = state;
  if (!early) throw new Error("fixtures missing");
  const page = await hostPage(browser);
  await page.goto(`/dashboard/reports/${early.sessionId}`);
  await expect(page.getByText("Ended early by the host")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No answers were given in this game.")).toBeVisible();
  await page.getByRole("tab", { name: "Questions" }).click();
  await expect(page.locator('li[data-question-status="UNPLAYED"]')).toHaveCount(3);
  await expect(page.getByText("Not played")).toHaveCount(3);
});

test("gates a report still being saved and keeps other hosts and players out", async ({
  browser,
}) => {
  const { complete } = state;
  if (!complete) throw new Error("fixtures missing");
  // A report still being saved: the gate, never the data.
  const pending = randomUUID();
  const page = await hostPage(browser);
  const envelope = (status: number, errorCode: string) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      statusCode: status,
      errorCode,
      message: "x",
      params: {},
      details: [],
      correlationId: randomUUID(),
    }),
  });
  await page.route(`${API}/api/v1/reports/${pending}`, (route) =>
    route.fulfill(envelope(409, "FINALIZATION_PENDING")),
  );
  await page.route(`${API}/api/v1/reports/${pending}/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: pending,
        status: "pending",
        reportId: null,
        retryable: true,
        errorCode: null,
        updatedAt: Date.now(),
      }),
    }),
  );
  await page.goto(`/dashboard/reports/${pending}`);
  await expect(page.getByText("This report is still being saved. Check back shortly.")).toBeVisible(
    { timeout: 15_000 },
  );
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);

  // Another host: 404 for the report and its CSV, and the page says not found.
  const other = await apiContext("10.95.5.1");
  const otherToken = await otherHostToken();
  const otherHeaders = { Authorization: `Bearer ${otherToken}` };
  expect(
    (await other.get(`/api/v1/reports/${complete.sessionId}`, { headers: otherHeaders })).status(),
  ).toBe(404);
  expect(
    (
      await other.get(`/api/v1/reports/${complete.sessionId}/export-csv`, {
        headers: otherHeaders,
      })
    ).status(),
  ).toBe(404);
  // No host token (e.g. a player): 401.
  expect((await other.get(`/api/v1/reports/${complete.sessionId}`)).status()).toBe(401);
  await other.dispose();
});
