/**
 * TASK-160A audio choreography and fallback in a real browser (Audio revision 2026-10-31).
 *
 * The real Howler that the app loads is observed through `tests/helpers/audio-observer.ts`.
 * Decoding, codec choice and playback all come from the browser; nothing reports a fake success.
 *
 * Covered (Chromium, the only engine installed in this environment):
 * - Assets: every manifest source answers 200 with audio, and no played Howl reports a load or
 *   decode error. The WebM source is chosen by default.
 * - Gesture and preferences: audio starts after the first gesture. M mutes (stored in
 *   `kabuki-neko-audio-prefs`, gain 0 on the playing track) and unmutes.
 * - Lobby: random pick from the installed tracks; "Next track" shuffles with a crossfade of at
 *   most 500 ms. A burst of joins pops at most once per 150 ms.
 * - Role matrix for all ten SFX across a Streamer game:
 *   - host: hyoshigiStart, questionWhoosh, timeupGong, revealBar 450 ms later, tickLast5s
 *     5…1 once each with rate 1.22 once and reset to 1, podiumSpotlight, nekoPop for joins;
 *   - player: nekoPop (own join, dice), answerCorrect ×3, streakFire on the third correct
 *     answer, answerWrong, no feedback for the POLL, answerCorrect when its podium rank
 *     appears, and no BGM or ticks at all (Streamer music not opted in).
 * - Music: lobby → thinking sprint → leaderboard groove → podium buildup → victory. Steady
 *   loops never overlap beyond the bounded crossfade, and victory is not restarted in FINISHED.
 * - Teardown: leaving host and player screens stops everything, and no cue fires afterwards
 *   (no stale timers).
 * - Fallback: with WebM unavailable, the specific lobby track (`matcha`) and SFX load as MP3.
 *
 * Not run here (recorded as such in the QA evidence): Firefox and WebKit (not installed), and
 * manual iOS autoplay and gapless-loop observations.
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
import {
  SFX_FILES,
  anythingPlaying,
  forceMp3,
  installAudioObserver,
  loadErrors,
  loopIntervals,
  maxLoopOverlap,
  readAudioLog,
  sfxCalls,
  type AudioLogEntry,
} from "../helpers/audio-observer";

const API = process.env["KABUKI_E2E_API_URL"] ?? "http://127.0.0.1:43101";
const WEB = "http://127.0.0.1:43100";
const PASSWORD = "correct horse battery staple";
/** Administrators this run may already have (audio-only run, or created by earlier specs). */
const ADMINS = [
  "audio-admin@example.com",
  "host-admin@example.com",
  "studio-admin@example.com",
  "player-admin@example.com",
  "join-admin@example.com",
  "admin@example.com",
  "rival@example.com",
];
/** Allowed overlap of two steady loops: the 500 ms crossfade plus scheduling slack. */
const CROSSFADE_BUDGET_MS = 800;

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

/** Shared fixtures. */
const state: {
  api: APIRequestContext | null;
  token: string;
  gameQuiz: string;
  matchaQuiz: string;
  sockets: Socket[];
  contexts: BrowserContext[];
  host: BrowserContext | null;
} = {
  api: null,
  token: "",
  gameQuiz: "",
  matchaQuiz: "",
  sockets: [],
  contexts: [],
  host: null,
};

/** API context presenting a fixed client address (per-IP auth limits). */
async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API,
    extraHTTPHeaders: { Origin: WEB, "X-Kabuki-Client": "web-v1", "X-Forwarded-For": "10.90.0.1" },
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
        name: "Audio Admin",
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

/** Creates a playable quiz from `(type, prompt, options)` rows, all 10-second questions. */
async function createQuiz(
  title: string,
  bgmTrack: string,
  rows: [string, string, [string, boolean?][]][],
): Promise<string> {
  const api = state.api;
  if (!api) throw new Error("api missing");
  const auth = { Authorization: `Bearer ${state.token}` };
  const created = await api.post("/api/v1/quizzes", {
    headers: { ...auth, "Idempotency-Key": randomUUID() },
    data: { title },
  });
  expect(created.status()).toBe(201);
  const quiz = (await created.json()) as { id: string; revision: number; questions: object[] };
  const blank = quiz.questions[0] as Record<string, unknown>;
  const saved = await api.put(`/api/v1/quizzes/${quiz.id}`, {
    headers: { ...auth, "If-Match": `"${quiz.revision}"` },
    data: {
      title,
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack,
      questions: rows.map(([type, promptText, options], orderIndex) => ({
        ...blank,
        id: randomUUID(),
        orderIndex,
        type,
        promptText,
        timeLimitSec: 10,
        pointsMultiplier: type === "POLL" ? 0 : 1,
        explanationText: null,
        options: options.map(([optionText, isCorrect = false], index) => ({
          id: randomUUID(),
          optionIndex: index,
          colorIndex: index,
          optionText,
          isCorrect,
          sortOrder: index,
        })),
      })),
    },
  });
  const detail = (await saved.json()) as { id: string; isPlayable: boolean };
  expect(saved.status(), JSON.stringify(detail)).toBe(200);
  expect(detail.isPlayable).toBe(true);
  return detail.id;
}

/**
 * The one signed-in, observed host context. It starts with the refresh cookie of the API sign-in
 * (no form sign-in: the per-email limit is shared with other specs). One context is reused because
 * every refresh rotates that cookie.
 */
async function hostContext(browser: Browser): Promise<BrowserContext> {
  if (state.host) return state.host;
  if (!state.api) throw new Error("api missing");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: await state.api.storageState(),
  });
  state.contexts.push(context);
  await context.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "10.90.1.1" } }),
  );
  await installAudioObserver(context);
  state.host = context;
  return context;
}

/** Opens a Streamer lobby for `quizId` from the studio; returns the page and PIN. */
async function openLobby(context: BrowserContext, quizId: string, mp3Only = false) {
  // One page at a time, so two pages never rotate the refresh token together.
  for (const open of context.pages()) await open.close();
  const page = await context.newPage();
  if (mp3Only) await forceMp3(page);
  await page.goto(`/studio/${quizId}`);
  const header = page.locator("header[data-dirty]");
  await expect(header).toBeVisible({ timeout: 15_000 });
  await header.getByRole("button", { name: "Host a game" }).click();
  await page.getByRole("radio", { name: /^Streamer/u }).check();
  await page.getByRole("button", { name: "Open lobby" }).click();
  await page.waitForURL(/\/host\/[0-9a-f-]{36}$/u, { timeout: 20_000 });
  await expect(stage(page)).toHaveAttribute("data-phase", "LOBBY", { timeout: 20_000 });
  const label = (await page.getByLabel(/^PIN \d{6}$/u).getAttribute("aria-label")) ?? "";
  return { page, pinCode: label.slice(4) };
}

/** The host stage root carrying the server phase. */
const stage = (page: Page) => page.locator("main [data-phase]").first();

/** Waits for a server phase on the host stage. */
async function phase(page: Page, name: string | RegExp, timeout = 25_000) {
  await expect(stage(page)).toHaveAttribute("data-phase", name, { timeout });
}

/** A Node player that joins and never answers (keeps questions open). */
async function silentPlayer(pinCode: string, nickname: string, address: string) {
  const socket = io(`${API}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1 },
    extraHeaders: { origin: WEB, "x-forwarded-for": address },
    reconnection: false,
  });
  state.sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  const ack = (await socket.timeout(10_000).emitWithAck("player:join_room", {
    requestId: randomUUID(),
    pinCode,
    nickname,
    avatar: { style: "bottts", seed: nickname },
  })) as { ok: boolean };
  expect(ack.ok).toBe(true);
}

/** A browser player joined through the real join flow (dice pressed once). */
async function browserPlayer(browser: Browser, pinCode: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  state.contexts.push(context);
  await installAudioObserver(context);
  const page = await context.newPage();
  await page.goto(`/join?pin=${pinCode}`);
  await expect(page.getByRole("heading", { name: "Choose your look" })).toBeVisible();
  await page.getByRole("button", { name: "Randomize avatar" }).click();
  await page.getByLabel(/^Nickname/u).fill("Mimi");
  await page.getByRole("button", { name: "Join game" }).click();
  await page.waitForURL(`**/play/${pinCode}`);
  await expect(page.getByText("Waiting for the host to start…")).toBeVisible();
  return page;
}

/** Player answers the open question with the option whose text is `text`. */
async function answer(page: Page, text: string) {
  const option = page.getByRole("button", { name: new RegExp(`: ${text}$`, "u") });
  await expect(option).toBeVisible({ timeout: 25_000 });
  await option.click();
  await expect(page.getByText("Answer received Your answer is locked in.")).toBeVisible();
}

/** Entries of `log` from time `from` on. */
const since = (log: readonly AudioLogEntry[], from: number) =>
  log.filter((entry) => entry.t >= from);

/** The page's current `performance.now()`. */
const pageNow = (page: Page) => page.evaluate(() => performance.now());

test.beforeAll(async () => {
  const api = await apiContext();
  state.api = api;
  state.token = await adminToken(api);
  state.gameQuiz = await createQuiz("Kuis Audio E2E", "random", [
    ["SINGLE_CHOICE", "Satu tambah satu?", [["Dua", true], ["Tiga"]]],
    ["SINGLE_CHOICE", "Warna langit cerah?", [["Biru", true], ["Merah"]]],
    ["SINGLE_CHOICE", "Hewan yang mengeong?", [["Kucing", true], ["Sapi"]]],
    ["SINGLE_CHOICE", "Ibu kota Jepang?", [["Tokyo", true], ["Osaka"]]],
    ["POLL", "Musim favoritmu?", [["Hujan"], ["Kemarau"]]],
  ]);
  state.matchaQuiz = await createQuiz("Kuis Matcha E2E", "matcha", [
    ["SINGLE_CHOICE", "Teh hijau dari Jepang?", [["Matcha", true], ["Kopi"]]],
  ]);
});

test.afterAll(async () => {
  for (const socket of state.sockets) socket.disconnect();
  for (const context of state.contexts) await context.close();
  await state.api?.dispose();
});

test("every manifest source is served as audio", async () => {
  const api = state.api;
  if (!api) throw new Error("api missing");
  const web = await request.newContext({ baseURL: WEB });
  const manifest = (await (await web.get("/audio/audio-manifest.json")).json()) as Record<
    string,
    unknown
  >;
  const sources = JSON.stringify(manifest).match(/\/audio\/[^"]+\.(?:webm|mp3)/gu) ?? [];
  // 4 lobby + 3 thinking + 1 leaderboard + 2 podium + 10 SFX, each as WebM and MP3.
  expect(new Set(sources).size).toBe(40);
  for (const stem of Object.values(SFX_FILES))
    expect(sources).toContain(`/audio/05-sfx/${stem}.webm`);
  for (const source of new Set(sources)) {
    const response = await web.get(source);
    expect(response.status(), source).toBe(200);
    // WebM is a shared container: servers may label audio-only WebM as video/webm.
    expect(response.headers()["content-type"], source).toMatch(
      source.endsWith(".mp3") ? /^audio\/(mpeg|mp3)/u : /^(audio|video)\/webm/u,
    );
  }
  await web.dispose();
});

test("plays the full role matrix, bounded loops and a silent teardown", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await hostContext(browser);
  const { page: host, pinCode } = await openLobby(context, state.gameQuiz);

  // Gesture unlock → the randomly picked lobby track loops.
  await host.locator("main").click({ position: { x: 5, y: 5 } });
  await expect
    .poll(async () => loopIntervals(await readAudioLog(host), Infinity).length, {
      timeout: 15_000,
    })
    .toBe(1);
  const lobbyLoop = loopIntervals(await readAudioLog(host), Infinity)[0];
  expect(lobbyLoop?.src).toMatch(/\/01-lobby\/bgm-lobby-(kabuki|matcha|neko8bit|showtime)\.webm$/u);

  // M mutes (stored preference, gain 0 on the playing track) and unmutes.
  const beforeMute = await pageNow(host);
  await host.keyboard.press("m");
  await expect
    .poll(() => host.evaluate(() => window.localStorage.getItem("kabuki-neko-audio-prefs") ?? ""))
    .toContain('"isMuted":true');
  const muted = since(await readAudioLog(host), beforeMute).filter(
    (entry) => entry.kind === "volume" && entry.howl === lobbyLoop?.howl,
  );
  expect(muted.at(-1)?.args?.[0]).toBe(0);
  await host.keyboard.press("m");
  await expect
    .poll(() => host.evaluate(() => window.localStorage.getItem("kabuki-neko-audio-prefs") ?? ""))
    .toContain('"isMuted":false');

  // Next track: a different lobby track with a crossfade of at most 500 ms.
  await host.getByRole("button", { name: "Next track" }).click();
  await expect
    .poll(async () => loopIntervals(await readAudioLog(host), Infinity).length, {
      timeout: 15_000,
    })
    .toBe(2);
  const shuffled = loopIntervals(await readAudioLog(host), await pageNow(host));
  expect(shuffled[1]?.src).not.toBe(shuffled[0]?.src);
  expect(shuffled[0]?.end).toBeLessThan(Infinity);

  // Burst of joins: the host pops at most once per 150 ms.
  const burstFrom = await pageNow(host);
  await Promise.all(
    ["Tora", "Kumo", "Sora", "Hana"].map((name, index) =>
      silentPlayer(pinCode, name, `10.90.2.${index + 1}`),
    ),
  );
  await expect(host.getByText("Hana", { exact: true })).toBeVisible();
  const pops = sfxCalls(since(await readAudioLog(host), burstFrom)).get("nekoPop") ?? [];
  expect(pops.length).toBeGreaterThanOrEqual(1);
  for (const [index, pop] of pops.entries())
    if (index > 0) expect(pop.t - (pops[index - 1]?.t ?? 0)).toBeGreaterThanOrEqual(140);

  // The browser player: own join and dice pops; no music in the lobby.
  const player = await browserPlayer(browser, pinCode);
  await expect(host.getByText("Mimi", { exact: true })).toBeVisible();

  // Start: lobby fades, hyoshigi, whoosh, then the sprint thinking loop (10 s ≤ 15 s).
  await host.getByRole("button", { name: "Start game" }).click();
  // revealBar plays 450 ms into ANSWER_REVEAL and is cancelled when the host moves on earlier, as
  // every pending cue is on a phase change. The host controls follow the reveal push at once, so
  // the host waits for the cue before advancing (as a person reading the reveal would).
  let reveals = 0;
  const revealBarPlayed = async () => {
    reveals += 1;
    await expect
      .poll(async () => sfxCalls(await readAudioLog(host)).get("revealBar")?.length ?? 0, {
        timeout: 5_000,
      })
      .toBe(reveals);
  };
  // Questions 1–3 correct (streak 3), then skipped before the last five seconds.
  for (const text of ["Dua", "Biru", "Kucing"]) {
    await answer(player, text);
    await host.getByRole("button", { name: "Skip timer" }).click();
    await phase(host, "ANSWER_REVEAL");
    await revealBarPlayed();
    await host.getByRole("button", { name: "Show leaderboard" }).click();
    await phase(host, "LEADERBOARD");
    await host.getByRole("button", { name: "Next question" }).click();
  }
  // Question 4 wrong, and the timer runs out: ticks 5…1 and the hurry-up rate.
  const q4From = await pageNow(host);
  await answer(player, "Osaka");
  await phase(host, "ANSWER_REVEAL", 30_000);
  await expect(player.getByRole("heading", { name: "Incorrect" })).toBeVisible();
  await revealBarPlayed();
  const q4 = since(await readAudioLog(host), q4From);
  expect(sfxCalls(q4).get("tickLast5s")).toHaveLength(5);
  const rates = q4.filter((entry) => entry.kind === "rate").map((entry) => entry.args?.[0]);
  expect(rates.filter((rate) => rate === 1.22)).toHaveLength(1);
  expect(rates.at(-1)).toBe(1);
  // Stay on this leaderboard until the groove really plays (earlier ones were left at once).
  await host.getByRole("button", { name: "Show leaderboard" }).click();
  await phase(host, "LEADERBOARD");
  await expect
    .poll(
      async () =>
        loopIntervals(await readAudioLog(host), Infinity).some((loop) =>
          loop.src.includes("bgm-leaderboard-groove"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await host.getByRole("button", { name: "Next question" }).click();

  // Question 5 (POLL): answered, no right/wrong feedback for the player.
  const pollFrom = await pageNow(player);
  await answer(player, "Hujan");
  await host.getByRole("button", { name: "Skip timer" }).click();
  await phase(host, "ANSWER_REVEAL");
  await revealBarPlayed();
  await player.waitForTimeout(1_500);
  const pollFeedback = sfxCalls(since(await readAudioLog(player), pollFrom));
  expect(pollFeedback.get("answerCorrect")).toBeUndefined();
  expect(pollFeedback.get("answerWrong")).toBeUndefined();

  // Podium → FINISHED (8 s): spotlights, buildup then victory, never restarted.
  await host.getByRole("button", { name: "Show podium" }).click();
  await phase(host, "FINISHED", 30_000);
  await expect(player.getByRole("link", { name: "Join a game" })).toBeVisible();
  // Victory starts at the first-place cue; under load its decode can finish a little later.
  await expect
    .poll(
      async () =>
        loopIntervals(await readAudioLog(host), Infinity).some((loop) =>
          loop.src.includes("bgm-podium-victory"),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await host.waitForTimeout(1_000);

  const hostLog = await readAudioLog(host);
  const playerLog = await readAudioLog(player);
  const hostSfx = sfxCalls(hostLog);
  const playerSfx = sfxCalls(playerLog);
  for (const cue of [
    "hyoshigiStart",
    "questionWhoosh",
    "timeupGong",
    "revealBar",
    "tickLast5s",
    "podiumSpotlight",
    "nekoPop",
  ] as const)
    expect(hostSfx.get(cue)?.length ?? 0, `host ${cue}`).toBeGreaterThan(0);
  expect(hostSfx.get("hyoshigiStart")).toHaveLength(1);
  expect(hostSfx.get("timeupGong")).toHaveLength(5);
  // revealBar follows each gong by about 450 ms.
  for (const [index, gong] of (hostSfx.get("timeupGong") ?? []).entries()) {
    const bar = hostSfx.get("revealBar")?.[index];
    expect((bar?.t ?? 0) - gong.t).toBeGreaterThanOrEqual(400);
    expect((bar?.t ?? 0) - gong.t).toBeLessThan(1_200);
  }
  for (const cue of ["answerCorrect", "answerWrong", "streakFire"] as const)
    expect(hostSfx.get(cue), `host ${cue}`).toBeUndefined();
  // Player: own join + dice pops, three correct, one streak, one wrong, podium rank cue.
  expect(playerSfx.get("nekoPop")?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(playerSfx.get("answerCorrect")).toHaveLength(4);
  expect(playerSfx.get("streakFire")).toHaveLength(1);
  expect(playerSfx.get("answerWrong")).toHaveLength(1);
  for (const cue of ["tickLast5s", "timeupGong", "hyoshigiStart", "podiumSpotlight"] as const)
    expect(playerSfx.get(cue), `player ${cue}`).toBeUndefined();
  expect(playerLog.filter((entry) => entry.loop)).toHaveLength(0);
  // All ten cues across both roles.
  const covered = new Set([...hostSfx.keys(), ...playerSfx.keys()]);
  expect([...covered].sort()).toEqual(Object.keys(SFX_FILES).sort());

  // Music sequence and bounded overlaps.
  const loops = loopIntervals(hostLog, hostLog.at(-1)?.t ?? 0);
  const names = loops.map((loop) => /\/(bgm-[a-z0-9-]+)\./u.exec(loop.src)?.[1]);
  expect(names).toContain("bgm-think-sprint");
  expect(names).toContain("bgm-leaderboard-groove");
  expect(names.slice(-2)).toEqual(["bgm-podium-buildup", "bgm-podium-victory"]);
  expect(names.filter((name) => name === "bgm-podium-victory")).toHaveLength(1);
  expect(
    maxLoopOverlap(loops),
    JSON.stringify(loops.map((loop) => [loop.src, Math.round(loop.start), Math.round(loop.end)])),
  ).toBeLessThanOrEqual(CROSSFADE_BUDGET_MS);
  const spotlights = hostSfx.get("podiumSpotlight") ?? [];
  const victory = loops.at(-1);
  expect(victory?.start ?? 0).toBeGreaterThanOrEqual((spotlights.at(-1)?.t ?? 0) - 100);
  expect(loadErrors(hostLog)).toEqual([]);
  expect(loadErrors(playerLog)).toEqual([]);
  expect(
    hostLog.filter((entry) => entry.kind === "create").every((e) => e.src.endsWith(".webm")),
  ).toBe(true);

  // Teardown: leaving stops everything and nothing fires afterwards.
  await host.getByRole("link", { name: "Quizzes" }).click();
  await host.waitForURL("**/dashboard/quizzes");
  await player.getByRole("link", { name: "Join a game" }).click();
  await player.waitForURL("**/join");
  await expect.poll(() => anythingPlaying(host), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => anythingPlaying(player), { timeout: 5_000 }).toBe(false);
  const hostAfter = (await readAudioLog(host)).length;
  const playerAfter = (await readAudioLog(player)).length;
  await host.waitForTimeout(3_000);
  const lateHost = (await readAudioLog(host)).slice(hostAfter);
  expect(lateHost.filter((entry) => entry.kind === "play-call")).toEqual([]);
  expect((await readAudioLog(player)).slice(playerAfter)).toEqual([]);
});

test("falls back to MP3 when WebM is unavailable and plays a specific lobby track", async ({
  browser,
}) => {
  const context = await hostContext(browser);
  const { page: host, pinCode } = await openLobby(context, state.matchaQuiz, true);
  await host.locator("main").click({ position: { x: 5, y: 5 } });
  await expect
    .poll(async () => loopIntervals(await readAudioLog(host), Infinity)[0]?.src ?? "", {
      timeout: 15_000,
    })
    .toBe("/audio/01-lobby/bgm-lobby-matcha.mp3");
  await silentPlayer(pinCode, "Kopi", "10.90.3.1");
  await expect
    .poll(async () => sfxCalls(await readAudioLog(host)).get("nekoPop")?.[0]?.src ?? "", {
      timeout: 15_000,
    })
    .toBe("/audio/05-sfx/sfx-neko-pop.mp3");
  // Both MP3 sources really decode.
  await expect
    .poll(
      async () =>
        (await readAudioLog(host))
          .filter((entry) => entry.kind === "load")
          .map((entry) => entry.src)
          .sort(),
      { timeout: 15_000 },
    )
    .toEqual(["/audio/01-lobby/bgm-lobby-matcha.mp3", "/audio/05-sfx/sfx-neko-pop.mp3"]);
  const log = await readAudioLog(host);
  expect(loadErrors(log)).toEqual([]);
  expect(log.some((entry) => entry.src.endsWith(".webm"))).toBe(false);
});
