/**
 * TASK-164 browser security headers against the production web build and the real API.
 *
 * Covered:
 * - Pages:
 *   - a fresh nonce-based CSP per response, with every server-rendered script carrying that nonce;
 *   - no `unsafe-eval` and no inline script allowance;
 *   - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`, frames only from
 *     youtube-nocookie;
 *   - nosniff, a strict referrer policy, and a permissions policy with camera self and no
 *     microphone.
 * - Production still works under the policy: hydration (interactive forms), signed-in dashboard
 *   pages, the game socket (PIN check opens the join form) and uploaded media loaded from the API
 *   origin. None of these log a CSP violation.
 * - Hostile content is blocked: an injected inline script, a foreign script, a foreign iframe and
 *   an `<object>`. A foreign page cannot frame the app.
 * - Open redirects: `returnTo` pointing elsewhere falls back to the dashboard.
 * - API: JSON and uploads are not frameable and load nothing when opened (`sandbox`). Uploads are
 *   cross-origin loadable, with an allowlisted MIME type and nosniff.
 * - No secret names in the public client bundles.
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
/** Administrators this run may already have (created by earlier specs, or first-run here). */
const ADMINS = [
  "security-admin@example.com",
  "reports-admin@example.com",
  "audio-admin@example.com",
  "host-admin@example.com",
  "studio-admin@example.com",
  "player-admin@example.com",
  "join-admin@example.com",
  "admin@example.com",
  "rival@example.com",
];
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  context: BrowserContext | null;
  sockets: Socket[];
} = { api: null, token: "", context: null, sockets: [] };

/** Signs in an administrator once through the API (first-run setup when needed). */
async function adminToken(api: APIRequestContext): Promise<string> {
  const status = (await (await api.get("/api/v1/auth/setup-status")).json()) as {
    isInitialized: boolean;
  };
  if (!status.isInitialized) {
    const setup = await api.post("/api/v1/auth/setup", {
      headers: { "Idempotency-Key": randomUUID() },
      data: { instanceName: "Kabuki E2E", name: "Security", email: ADMINS[0], password: PASSWORD },
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

/** The single signed-in context (refresh cookie of the API sign-in; one page at a time). */
async function signedPage(browser: Browser): Promise<Page> {
  if (!state.api) throw new Error("api missing");
  if (!state.context) {
    state.context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: await state.api.storageState(),
    });
    await state.context.route(`${API}/**`, (route) =>
      route.continue({
        headers: { ...route.request().headers(), "x-forwarded-for": "10.96.1.1" },
      }),
    );
  }
  for (const open of state.context.pages()) await open.close();
  return state.context.newPage();
}

/** Collects CSP violation reports logged by the page. */
function violations(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (load|execute|frame)/u.test(message.text()))
      seen.push(message.text());
  });
  return seen;
}

/** Parses a CSP header into directive → value. */
function directives(policy: string): Map<string, string> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name = "", ...values] = part.split(/\s+/u);
        return [name, values.join(" ")] as const;
      }),
  );
}

test.beforeAll(async () => {
  state.api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.96.0.1" },
  });
  state.token = await adminToken(state.api);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  await state.context?.close();
  await state.api?.dispose();
});

test("pages send a fresh nonce CSP and the browser security headers", async () => {
  const web = await request.newContext({ baseURL: WEB });
  const first = await web.get("/login");
  const second = await web.get("/login");
  expect(first.status()).toBe(200);
  const policy = first.headers()["content-security-policy"] ?? "";
  const parsed = directives(policy);
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/u.exec(policy)?.[1] ?? "";
  expect(nonce.length).toBeGreaterThan(16);
  expect(second.headers()["content-security-policy"]).not.toContain(nonce);
  expect(parsed.get("script-src")).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
  expect(policy).not.toContain("unsafe-eval");
  expect(parsed.get("script-src")).not.toContain("unsafe-inline");
  expect(parsed.get("object-src")).toBe("'none'");
  expect(parsed.get("base-uri")).toBe("'self'");
  expect(parsed.get("frame-ancestors")).toBe("'self'");
  expect(parsed.get("frame-src")).toBe("https://www.youtube-nocookie.com");
  expect(parsed.get("img-src")).toContain(API);
  expect(parsed.get("connect-src")).toContain(API);
  expect(parsed.get("connect-src")).toContain(API.replace(/^http/u, "ws"));
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(first.headers()["permissions-policy"]).toContain("camera=(self)");
  expect(first.headers()["permissions-policy"]).toContain("microphone=()");
  // Every server-rendered script carries this response's nonce.
  const html = await first.text();
  const scripts = html.match(/<script\b[^>]*>/gu) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  // Static files get the static headers too.
  const asset = await web.get("/brand/mascot.svg");
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
  await web.dispose();
});

test("production pages hydrate, use the socket and load uploaded media without violations", async ({
  browser,
}) => {
  if (!state.api) throw new Error("api missing");
  // A room to join, created by a Node host.
  const host = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1, accessToken: state.token },
    extraHeaders: { origin: WEB, "x-forwarded-for": "10.96.0.2" },
    reconnection: false,
  });
  state.sockets.push(host);
  await new Promise<void>((resolve, reject) => {
    host.once("connect", () => resolve());
    host.once("connect_error", reject);
  });
  const created = await state.api.post("/api/v1/quizzes", {
    headers: { Authorization: `Bearer ${state.token}`, "Idempotency-Key": randomUUID() },
    data: { title: "Kuis Keamanan" },
  });
  const quiz = (await created.json()) as { id: string; revision: number; isPlayable: boolean };
  // The fresh quiz has one blank slide, so it is not playable; the PIN check needs a real room.
  const detail = (await (
    await state.api.get(`/api/v1/quizzes/${quiz.id}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    })
  ).json()) as { questions: Record<string, unknown>[] };
  const blank = detail.questions[0] ?? {};
  const saved = await state.api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { Authorization: `Bearer ${state.token}`, "If-Match": `"${quiz.revision}"` },
    data: {
      title: "Kuis Keamanan",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: [
        {
          ...blank,
          promptText: "Aman?",
          options: [
            {
              id: randomUUID(),
              optionIndex: 0,
              colorIndex: 0,
              optionText: "Ya",
              isCorrect: true,
              sortOrder: 0,
            },
            {
              id: randomUUID(),
              optionIndex: 1,
              colorIndex: 1,
              optionText: "Tidak",
              isCorrect: false,
              sortOrder: 1,
            },
          ],
        },
      ],
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const playable = (await saved.json()) as { revision: number };
  const room = (await host.timeout(10_000).emitWithAck("host:create_room", {
    requestId: randomUUID(),
    quizId: quiz.id,
    quizRevision: playable.revision,
    displayMode: "STREAMER",
    friendlyNicknames: false,
  })) as { ok: boolean; data?: { pinCode: string } };
  expect(room.ok).toBe(true);

  // Guest join page: hydration + socket under the CSP.
  const guest = await browser.newPage();
  const guestViolations = violations(guest);
  await guest.goto(`/join?pin=${room.data?.pinCode ?? ""}`);
  await expect(guest.getByRole("heading", { name: "Choose your look" })).toBeVisible({
    timeout: 15_000,
  });
  await guest.getByLabel(/^Nickname/u).fill("Aman");
  await expect(guest.getByLabel(/^Nickname/u)).toHaveValue("Aman");
  await guest.close();

  // Upload an image, then load it from the signed-in page context (img-src).
  const upload = await state.api.post("/api/v1/media/upload", {
    headers: { Authorization: `Bearer ${state.token}`, "Idempotency-Key": randomUUID() },
    multipart: {
      file: { name: "titik.png", mimeType: "image/png", buffer: PNG },
      folder: "covers",
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const media = (await upload.json()) as { publicUrl: string; mimeType: string };
  const page = await signedPage(browser);
  const pageViolations = violations(page);
  for (const path of ["/dashboard/quizzes", "/dashboard/media", "/dashboard/reports"]) {
    await page.goto(path);
    await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 15_000 });
  }
  const loaded = await page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => resolve(0);
        image.src = url;
      }),
    media.publicUrl,
  );
  expect(loaded).toBe(1);
  expect(guestViolations).toEqual([]);
  expect(pageViolations).toEqual([]);

  // The upload itself: allowlisted MIME, nosniff, cross-origin loadable, inert when opened.
  const file = await request.newContext();
  const served = await file.get(media.publicUrl);
  // Images are re-encoded on upload; the served type is exactly the stored allowlisted type.
  expect(served.headers()["content-type"]).toBe(media.mimeType);
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
  expect(served.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(served.headers()["content-security-policy"]).toContain("sandbox");
  await file.dispose();
});

test("blocks injected scripts, foreign frames and objects, and framing by other sites", async ({
  browser,
}) => {
  const page = await browser.newPage();
  const seen = violations(page);
  // The real page and its real CSP, with hostile markup injected into the HTML.
  await page.route(`${WEB}/login`, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "</body>",
      '<script>window.__pwned = 1</script><script src="https://evil.example/x.js"></script>' +
        '<iframe src="https://example.com/"></iframe><object data="https://evil.example/x"></object></body>',
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /^Sign in/u }).last()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
  await expect.poll(() => seen.length).toBeGreaterThanOrEqual(3);
  expect(seen.some((text) => /script/iu.test(text))).toBe(true);
  expect(seen.some((text) => /frame/iu.test(text))).toBe(true);
  // Still interactive: the form hydrated despite the injection attempts.
  await page.getByLabel(/^Email/u).fill("x@example.com");
  await expect(page.getByLabel(/^Email/u)).toHaveValue("x@example.com");
  await page.close();

  // A foreign page cannot frame the app.
  const framer = await browser.newPage();
  const framed = violations(framer);
  await framer.setContent(`<iframe id="app" src="${WEB}/login"></iframe>`);
  await expect.poll(() => framed.some((text) => /frame-ancestors/u.test(text))).toBe(true);
  const inner = framer.frame({ url: /\/login/u });
  expect(
    (await inner
      ?.locator("text=Sign in")
      .count()
      .catch(() => 0)) ?? 0,
  ).toBe(0);
  await framer.close();
});

test("rejects open redirects and keeps the API inert and unframeable", async ({ browser }) => {
  const page = await signedPage(browser);
  for (const target of ["//evil.example/x", "https://evil.example/", "/\\evil.example"]) {
    await page.goto(`/login?returnTo=${encodeURIComponent(target)}`);
    await page.waitForURL(/\/dashboard\/quizzes$/u, { timeout: 15_000 });
    expect(new URL(page.url()).origin).toBe(WEB);
  }
  const api = await request.newContext({ baseURL: API });
  const health = await api.get("/api/v1/system/health");
  expect(health.headers()["content-security-policy"]).toBe(
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  );
  expect(health.headers()["x-frame-options"]).toBe("DENY");
  expect(health.headers()["x-content-type-options"]).toBe("nosniff");
  expect(health.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(health.headers()["cross-origin-resource-policy"]).toBe("same-site");
  await api.dispose();
});

test("public client bundles carry no secret names", async () => {
  const web = await request.newContext({ baseURL: WEB });
  const html = await (await web.get("/login")).text();
  const sources = [
    ...new Set([...html.matchAll(/\/_next\/static\/[^"'\s]+\.js/gu)].map((match) => match[0])),
  ];
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const code = await (await web.get(source)).text();
    for (const secret of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "APP_SECRET",
      "DATABASE_URL",
      "REDIS_URL",
      "S3_SECRET_ACCESS_KEY",
      "API_INTERNAL_URL",
      "SQLITE_PATH",
    ])
      expect(code, `${source} contains ${secret}`).not.toContain(secret);
  }
  await web.dispose();
});
