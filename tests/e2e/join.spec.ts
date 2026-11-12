/**
 * TASK-151 end-to-end guest join (players need no account) against the real API and web build.
 *
 * Setup (once): an administrator session (first-run setup, or the administrator created by
 * `auth.spec.ts` in the same run), one playable quiz, and two rooms created over a real host
 * socket (normal and friendly nicknames).
 *
 * Covered:
 * - Five states: empty hint, loading ("Checking…"), ideal (identity step), partial (unknown PIN,
 *   locked room) and error (unanswered check → "offline or failed" + Try again).
 * - A leading-zero PIN (000123) is kept and an unknown PIN is never polled again.
 * - A `?pin=` deep link is checked exactly once.
 * - Duplicate nicknames are rejected with the fields kept.
 * - Friendly-nickname rooms join with a server-picked name.
 * - Camera denied falls back to manual entry; a foreign QR code is refused without navigation.
 *
 * Socket check/join events share a per-IP limit of 10 per minute, so the flows stay within it.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  request,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { io, type Socket } from "socket.io-client";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may already have (join-only run, or created by auth.spec.ts). */
const ADMINS = ["join-admin@example.com", "admin@example.com", "rival@example.com"];

test.describe.configure({ mode: "serial" });

/** Shared fixtures for the serial flows. */
const state: {
  api: APIRequestContext | null;
  token: string;
  host: Socket | null;
  rooms: {
    normal: { pinCode: string; sessionId: string };
    friendly: { pinCode: string; sessionId: string };
  } | null;
} = { api: null, token: "", host: null, rooms: null };

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.40.0.1" },
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
        name: "Join Admin",
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

/** Creates a quiz with one complete single-choice question (playable). */
async function playableQuiz(api: APIRequestContext, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Tamu E2E" },
  });
  expect(created.status()).toBe(201);
  const quiz = (await created.json()) as {
    id: string;
    revision: number;
    questions: { options: { text?: string }[] }[];
  } & Record<string, unknown>;
  const blank = quiz.questions[0] as Record<string, unknown> & {
    options: Record<string, unknown>[];
  };
  const question = {
    ...blank,
    promptText: "Ibu kota Indonesia?",
    options: blank.options.map((option, index) => ({
      ...option,
      optionText: ["Jakarta", "Bandung", "Surabaya", "Medan"][index] ?? `Pilihan ${index + 1}`,
      isCorrect: index === 0,
    })),
  };
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Tamu E2E",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [question],
    },
  });
  expect(saved.status()).toBe(200);
  const detail = (await saved.json()) as { id: string; revision: number; isPlayable: boolean };
  expect(detail.isPlayable).toBe(true);
  return detail;
}

/** Connects the host socket (authenticated, allowed origin). */
async function hostSocket(token: string): Promise<Socket> {
  const socket = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1, accessToken: token },
    extraHeaders: { origin: WEB, "x-forwarded-for": "10.40.0.2" },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

/** Sends a host command and returns its ACK data. */
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

/** Counts `player:check_pin` frames a page sends. */
function countChecks(page: Page): () => number {
  let count = 0;
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"player:check_pin"')) count += 1;
    }),
  );
  return () => count;
}

/** Writes a Y4M fake-camera video showing a QR code for `text`. */
function qrVideo(text: string): string {
  const requireFromWeb = createRequire(path.resolve("apps/web/package.json"));
  const qrcode = requireFromWeb("qrcode") as {
    create: (value: string) => { modules: { size: number; data: Uint8Array } };
  };
  const { size, data } = qrcode.create(text).modules;
  const width = 640;
  const height = 480;
  const scale = 8;
  const offsetX = Math.floor((width - size * scale) / 2);
  const offsetY = Math.floor((height - size * scale) / 2);
  const luma = Buffer.alloc(width * height, 255);
  for (let row = 0; row < size; row += 1)
    for (let col = 0; col < size; col += 1)
      if (data[row * size + col] === 1)
        for (let y = 0; y < scale; y += 1)
          luma.fill(
            0,
            (offsetY + row * scale + y) * width + offsetX + col * scale,
            (offsetY + row * scale + y) * width + offsetX + (col + 1) * scale,
          );
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`)];
  for (let frame = 0; frame < 15; frame += 1) parts.push(Buffer.from("FRAME\n"), luma, chroma);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "kabuki-qr-")), "qr.y4m");
  writeFileSync(file, Buffer.concat(parts));
  return file;
}

test.beforeAll(async () => {
  const api = await apiContext();
  const token = await adminToken(api);
  const quiz = await playableQuiz(api, token);
  const host = await hostSocket(token);
  const create = (friendlyNicknames: boolean) =>
    command<{ pinCode: string; sessionId: string }>(host, "host:create_room", {
      quizId: quiz.id,
      quizRevision: quiz.revision,
      displayMode: "PROJECTOR",
      friendlyNicknames,
    });
  state.api = api;
  state.token = token;
  state.host = host;
  state.rooms = { normal: await create(false), friendly: await create(true) };
});

test.afterAll(async () => {
  state.host?.disconnect();
  await state.api?.dispose();
});

test("keeps a leading-zero PIN, shows the empty hint and never polls an unknown PIN", async ({
  page,
}) => {
  const checks = countChecks(page);
  await page.goto("/join");
  await expect(page).toHaveTitle("Join a game · Kabuki Neko");
  await expect(page.getByText("Enter the 6-digit game PIN.")).toBeVisible();
  const field = page.getByLabel("Game PIN");
  await expect(field).toHaveAttribute("inputmode", "numeric");
  await field.fill("000123");
  await expect(field).toHaveValue("000123");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "No game found with that PIN.",
  );
  await page.waitForTimeout(2_000);
  expect(checks()).toBe(1);
  await expect(field).toHaveValue("000123");
});

test("checks a deep-linked PIN once, joins as a guest and rejects a duplicate nickname", async ({
  browser,
}) => {
  const rooms = state.rooms;
  if (!rooms) throw new Error("rooms missing");
  const first = await (await browser.newContext()).newPage();
  const checks = countChecks(first);
  await first.goto(`/join?pin=${rooms.normal.pinCode}`);
  await expect(first.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await first.waitForTimeout(1_000);
  expect(checks()).toBe(1);
  await first.getByLabel(/^Nickname/u).fill("Neko");
  await first.getByRole("button", { name: "Join game" }).click();
  await first.waitForURL(`**/play/${rooms.normal.pinCode}`);
  const stored = await first.evaluate(() => JSON.stringify({ ...window.localStorage }));
  expect(stored).toContain(rooms.normal.sessionId);
  expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/u);

  const second = await (await browser.newContext()).newPage();
  await second.goto(`/join?pin=${rooms.normal.pinCode}`);
  await expect(second.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await second.getByLabel(/^Nickname/u).fill("Neko");
  await second.getByRole("button", { name: "Join game" }).click();
  await expect(second.getByText("Someone in this room already uses that nickname.")).toBeVisible();
  await expect(second.getByLabel(/^Nickname/u)).toHaveValue("Neko");
  expect(second.url()).toContain("/join");
});

test("joins a friendly-nickname room with a server-picked name", async ({ page }) => {
  const rooms = state.rooms;
  if (!rooms) throw new Error("rooms missing");
  await page.goto(`/join?pin=${rooms.friendly.pinCode}`);
  await expect(page.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await expect(page.getByLabel(/^Nickname/u)).toHaveCount(0);
  await page.getByRole("button", { name: "Give me a random nickname" }).click();
  await expect(page.getByText("Enter a nickname or get a random one.")).toHaveCount(0);
  await page.getByRole("button", { name: "Join game" }).click();
  await page.waitForURL(`**/play/${rooms.friendly.pinCode}`);
});

test("explains a locked room (partial)", async ({ page }) => {
  const rooms = state.rooms;
  if (!rooms?.normal || !state.host) throw new Error("rooms missing");
  await command(state.host, "host:lock_room", {
    sessionId: rooms.normal.sessionId,
    pinCode: rooms.normal.pinCode,
    isLocked: true,
  });
  await page.goto("/join");
  await page.getByLabel("Game PIN").fill(rooms.normal.pinCode);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "The host has locked this game.",
  );
});

test("shows loading, then the error state with Try again when the check gets no answer", async ({
  page,
}) => {
  // Swallow check frames so the 5 s ACK deadline passes (no server-side event is spent).
  await page.routeWebSocket(/\/socket\.io\//u, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && message.includes('"player:check_pin"')) return;
      server.send(message);
    });
  });
  await page.goto("/join?pin=111111");
  await expect(page.getByText("Checking…")).toBeVisible();
  await expect(page.getByLabel("Game PIN")).toBeDisabled();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("You're offline or the check failed. Try again.", {
    timeout: 10_000,
  });
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("falls back to manual entry when the camera is denied and refuses foreign QR codes", async () => {
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  const denied = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--use-fake-device-for-media-stream", "--deny-permission-prompts"],
  });
  const page = await denied.newPage({ baseURL: WEB, locale: "en-US" });
  await page.goto("/join");
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await page.getByRole("button", { name: "Allow camera access" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    /Camera access was denied|No camera found/u,
  );
  await page.getByRole("button", { name: "Enter the PIN instead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Game PIN")).toBeFocused();
  await denied.close();

  const camera = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${qrVideo("https://evil.example/join?pin=123456")}`,
    ],
  });
  const scanPage = await camera.newPage({ baseURL: WEB, locale: "en-US" });
  await scanPage.goto("/join");
  await scanPage.getByRole("button", { name: "Scan QR code" }).click();
  await scanPage.getByRole("button", { name: "Allow camera access" }).click();
  await expect(
    scanPage.getByText("This QR code is for a different site and won't be opened."),
  ).toBeVisible({
    timeout: 15_000,
  });
  expect(new URL(scanPage.url()).pathname).toBe("/join");
  await camera.close();
});
