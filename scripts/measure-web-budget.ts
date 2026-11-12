/**
 * `pnpm exec tsx scripts/measure-web-budget.ts --runs 5 [--skip-build] [--out file]` — player
 * bundle and cold-load budgets of the production web build (TASK-180; Design §9; SA §8.3; US-18,
 * US-20, US-21).
 *
 * Harness:
 * 1. Starts the built API (SQLite, memory state) on a free port, sets up an instance and opens a
 *    room, so the identity step (M01) can be measured with a real PIN.
 * 2. Builds the web app for production with that API's URL (`next build`; `--skip-build` reuses a
 *    build made with the same URL) and serves it with `next start`. A development server is never
 *    measured: the run refuses HTML carrying development markers.
 * 3. The web server reads a test locale bundle (KN_LOCALES_DIR): the shipped built-ins plus German
 *    (long text) and Arabic (right-to-left) test packages. Browsers fetch it routed from the same
 *    directory. Test packages never enter `apps/web/public/locales`.
 * 4. Each scenario runs `--runs` times in a fresh, cold browser context with:
 *    - a 390×844 viewport;
 *    - 1.6 Mbps down, 750 kbps up, 150 ms RTT (CDP network emulation);
 *    - 4× CPU slowdown;
 *    - the cache disabled.
 *    Scenarios: `/join` in en, ja, zh-Hans (CJK), de (+40%-class long text) and ar (RTL), plus the
 *    identity step `/join?pin=…` in en.
 *
 * Measures, per scenario:
 * - LCP and CLS, from PerformanceObserver;
 * - every response: JS gzip-9 and raw bytes, locale catalog JSON, fonts, media.
 * Budgets, from the first cold run of each scenario:
 * - initial JS (all scripts until network idle, framework included) ≤ 300 KiB gzip;
 * - initial locale payload ≤ 50 KiB gzip. That is the namespaces the route fetched plus the SSR
 *   shell namespaces (common, accessibility), for the locale and for its `en` fallback;
 * - median LCP ≤ 4 s and median CLS ≤ 0.1;
 * - lazy loading: the studio editor (dnd-kit), the QR decoder (ZXing) and confetti are absent from
 *   `/join`, and avatar style chunks load only at the identity step.
 * Media and font bytes are reported separately and are not counted against the JS budget.
 *
 * Output: raw runs, medians, a per-file gzip manifest and the verdict, as JSON (default
 * `test-results/benchmark/web-budget.json`) plus a Markdown summary. Exit code 1 when any budget
 * fails; nothing is reported as passing from a development build.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { gzipSync } from "node:zlib";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

/** Budgets of Design §9 (bytes, ms, unitless). */
export const BUDGETS = {
  initialJsGzipBytes: 300 * 1024,
  initialLocaleGzipBytes: 50 * 1024,
  lcpMs: 4_000,
  cls: 0.1,
} as const;

/** Markers of code that must stay out of the player's boot (minified strings that survive). */
export const LAZY_MARKERS = {
  "studio editor (dnd-kit)": "To pick up a draggable item",
  "QR decoder (ZXing)": "ChecksumException",
  "confetti (podium)": "confetti",
} as const;
/** Marker of DiceBear avatar style chunks (lazy until the identity step). */
export const AVATAR_MARKER = "createAvatar";

/** Kind of one loaded resource. */
export type ResourceKind =
  "js" | "locale" | "font" | "media" | "document" | "css" | "api" | "other";

/** Classifies a response by URL and Playwright resource type. */
export function classifyResource(url: string, resourceType: string): ResourceKind {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/api/") || pathname.startsWith("/socket.io/")) return "api";
  if (/^\/locales\/[a-f0-9]{64}\/[^/]+\/[a-z]+\.json$/u.test(pathname)) return "locale";
  if (resourceType === "script" || pathname.endsWith(".js")) return "js";
  if (resourceType === "font" || /\.(woff2?|ttf|otf)$/u.test(pathname)) return "font";
  if (
    resourceType === "image" ||
    resourceType === "media" ||
    /\.(png|jpe?g|webp|avif|svg|gif|mp3|webm|mp4)$/u.test(pathname)
  )
    return "media";
  if (resourceType === "stylesheet" || pathname.endsWith(".css")) return "css";
  if (resourceType === "document") return "document";
  return "other";
}

/** gzip size (level 9) of a body. */
export function gzipSize(body: Buffer | string): number {
  return gzipSync(body, { level: 9 }).length;
}

/** One measured response. */
export interface Resource {
  url: string;
  kind: ResourceKind;
  rawBytes: number;
  gzipBytes: number;
}

/** Totals per kind plus the JS manifest (sorted by gzip size). */
export function accountResources(resources: readonly Resource[]) {
  const unique = new Map<string, Resource>();
  for (const resource of resources) unique.set(resource.url, resource);
  const totals = (kind: ResourceKind) => {
    const items = [...unique.values()].filter((resource) => resource.kind === kind);
    return {
      count: items.length,
      rawBytes: items.reduce((sum, item) => sum + item.rawBytes, 0),
      gzipBytes: items.reduce((sum, item) => sum + item.gzipBytes, 0),
    };
  };
  return {
    js: totals("js"),
    css: totals("css"),
    locale: totals("locale"),
    font: totals("font"),
    media: totals("media"),
    manifest: [...unique.values()]
      .filter((resource) => resource.kind === "js")
      .sort((a, b) => b.gzipBytes - a.gzipBytes)
      .map((resource) => ({
        file: new URL(resource.url).pathname,
        rawBytes: resource.rawBytes,
        gzipBytes: resource.gzipBytes,
      })),
  };
}

/** Median of a non-empty sample (mean of the two middle values for even sizes). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("no values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** True when HTML comes from a development server (HMR/refresh runtime or dev chunk paths). */
export function isDevelopmentBuild(html: string): boolean {
  return /webpack-hmr|react-refresh|__nextjs_original-stack-frame|\/_next\/static\/development\/|turbopack-hmr/u.test(
    html,
  );
}

/** Inputs of the verdict. */
export interface BudgetInput {
  initialJsGzipBytes: number;
  localeGzipBytes: Record<string, number>;
  lcpMedianMs: Record<string, number>;
  clsMedian: Record<string, number>;
  lazyViolations: string[];
}

/** Every budget failure, explicitly; pass only when there are none. */
export function budgetVerdict(input: BudgetInput) {
  const failures: string[] = [];
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
  if (input.initialJsGzipBytes > BUDGETS.initialJsGzipBytes)
    failures.push(
      `initial JS ${kib(input.initialJsGzipBytes)} gzip > ${kib(BUDGETS.initialJsGzipBytes)}`,
    );
  for (const [locale, bytes] of Object.entries(input.localeGzipBytes))
    if (bytes > BUDGETS.initialLocaleGzipBytes)
      failures.push(`locale ${locale} ${kib(bytes)} gzip > ${kib(BUDGETS.initialLocaleGzipBytes)}`);
  for (const [scenario, lcp] of Object.entries(input.lcpMedianMs))
    if (lcp > BUDGETS.lcpMs)
      failures.push(`${scenario} median LCP ${Math.round(lcp)} ms > ${BUDGETS.lcpMs} ms`);
  for (const [scenario, cls] of Object.entries(input.clsMedian))
    if (cls > BUDGETS.cls)
      failures.push(`${scenario} median CLS ${cls.toFixed(3)} > ${BUDGETS.cls}`);
  for (const violation of input.lazyViolations) failures.push(`not lazy: ${violation}`);
  return { pass: failures.length === 0, failures };
}

/** Waits until `url` answers (any status) or the deadline passes. */
async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${url} did not answer`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** One scenario: a route in a locale. */
interface Scenario {
  name: string;
  locale: string;
  route: string;
}

/** Full measurement; returns the record. */
export async function measure(options: { runs: number; skipBuild: boolean }) {
  const { chromium } = await import("@playwright/test");
  const { io } = await import("socket.io-client");
  const { createTestRuntime, freePort, httpClient, startApi } =
    await import("../tests/helpers/runtime");
  const { PASSWORD, quizWith } = await import("../tests/helpers/game");
  const { ARABIC, GERMAN, writePackage } = await import("../tests/e2e/fixtures/locale-packages");

  const runtime = await createTestRuntime();
  const scratch = await mkdtemp(path.join(tmpdir(), "kabuki-web-budget-"));
  let web: ChildProcess | null = null;
  try {
    const webPort = await freePort();
    const webOrigin = `http://127.0.0.1:${webPort}`;
    const api = await startApi(runtime, {
      CORS_ORIGIN: webOrigin,
      APP_URL: webOrigin,
      NEXT_PUBLIC_APP_URL: webOrigin,
      TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
    });
    const call = httpClient(api.base);
    const headers = { Origin: webOrigin, "Idempotency-Key": randomUUID() };
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.250.0.1",
      headers,
      body: { instanceName: "Budget", name: "Host", email: "host@example.org", password: PASSWORD },
    });
    if (setup.status !== 201) throw new Error(`setup failed: ${setup.text}`);
    const token = (setup.json as { accessToken: string }).accessToken;
    const quiz = await quizWith(
      (p, o = {}) => call(p, { ...o, headers: { Origin: webOrigin, ...o.headers } }),
      token,
      "Anggaran",
      [{ type: "SINGLE_CHOICE", prompt: "Siap?", options: [["Ya", true], ["Tidak"]] }],
    );
    const socket = io(`${api.url}/game`, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { protocolVersion: 1, accessToken: token },
      extraHeaders: { origin: webOrigin },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    const created = (await socket
      .timeout(10_000)
      .emitWithAck("host:create_room", {
        requestId: randomUUID(),
        quizId: quiz.id,
        quizRevision: quiz.revision,
        displayMode: "PROJECTOR",
        friendlyNicknames: false,
      })) as { ok: boolean; data?: { pinCode: string } };
    if (!created.ok || !created.data) throw new Error("create_room failed");
    const pin = created.data.pinCode;

    // Test locale bundle (built-ins + de + ar) for the web server and the browser.
    const external = path.join(scratch, "external");
    await writePackage(external, GERMAN);
    await writePackage(external, ARABIC);
    const locales = path.join(scratch, "locales");
    await run(
      path.join(ROOT, "node_modules/.bin/tsx"),
      [
        path.join(ROOT, "scripts/locales-build.ts"),
        "--builtin-root",
        path.join(ROOT, "packages/shared/locales"),
        "--external-root",
        external,
        "--out",
        path.join(scratch, "api-locales"),
        "--web-public",
        locales,
        "--require-builtins",
        "en,id,ja,zh-Hans,es,fr",
      ],
      { cwd: ROOT },
    );

    const publicEnv = {
      NEXT_PUBLIC_APP_URL: webOrigin,
      NEXT_PUBLIC_API_URL: api.url,
      NEXT_PUBLIC_WS_URL: api.url,
    };
    if (!options.skipBuild)
      await run("pnpm", ["--filter", "@kabuki-neko/web...", "build"], {
        cwd: ROOT,
        env: { ...process.env, ...publicEnv },
        maxBuffer: 64 * 1024 * 1024,
      });
    web = spawn(
      "pnpm",
      [
        "--filter",
        "@kabuki-neko/web",
        "exec",
        "next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          ...publicEnv,
          NODE_ENV: "production",
          API_INTERNAL_URL: api.url,
          APP_URL: webOrigin,
          KN_LOCALES_DIR: locales,
        },
        stdio: "ignore",
      },
    );
    await waitForHttp(`${webOrigin}/join`, 120_000);
    const firstHtml = await (await fetch(`${webOrigin}/join`)).text();
    if (isDevelopmentBuild(firstHtml)) throw new Error("refusing to measure a development build");

    const scenarios: Scenario[] = [
      { name: "join en", locale: "en", route: "/join" },
      { name: "identity (M01) en", locale: "en", route: `/join?pin=${pin}` },
      { name: "join ja (CJK)", locale: "ja", route: "/join" },
      { name: "join zh-Hans (CJK)", locale: "zh-Hans", route: "/join" },
      { name: "join de (long text)", locale: "de", route: "/join" },
      { name: "join ar (RTL)", locale: "ar", route: "/join" },
    ];
    const browser = await chromium.launch(
      process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
        ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
        : {},
    );
    const results: {
      scenario: string;
      runs: { lcpMs: number; cls: number; resources: Resource[]; bodies: Map<string, string> }[];
    }[] = [];
    try {
      for (const scenario of scenarios) {
        const runsOut: (typeof results)[number]["runs"] = [];
        for (let index = 0; index < options.runs; index++) {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 1,
            isMobile: true,
            hasTouch: true,
          });
          await context.addCookies([{ name: "kn_locale", value: scenario.locale, url: webOrigin }]);
          await context.route(`${webOrigin}/locales/**`, async (route) => {
            const relative = decodeURIComponent(new URL(route.request().url()).pathname).replace(
              /^\/locales\//u,
              "",
            );
            const file = path.resolve(locales, relative);
            if (!file.startsWith(`${locales}${path.sep}`)) return route.fulfill({ status: 404 });
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
          await context.addInitScript(() => {
            const store = { lcp: 0, cls: 0 };
            (window as unknown as { __knVitals: typeof store }).__knVitals = store;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries())
                store.lcp = Math.max(store.lcp, entry.startTime);
            }).observe({ type: "largest-contentful-paint", buffered: true });
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as (PerformanceEntry & {
                value: number;
                hadRecentInput: boolean;
              })[])
                if (!entry.hadRecentInput) store.cls += entry.value;
            }).observe({ type: "layout-shift", buffered: true });
          });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 150,
            downloadThroughput: (1.6 * 1024 * 1024) / 8,
            uploadThroughput: (750 * 1024) / 8,
          });
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          const resources: Resource[] = [];
          const bodies = new Map<string, string>();
          const pending: Promise<void>[] = [];
          page.on("response", (response) => {
            const kind = classifyResource(response.url(), response.request().resourceType());
            if (kind === "api" || kind === "document" || kind === "other") return;
            pending.push(
              response
                .body()
                .then((body) => {
                  resources.push({
                    url: response.url(),
                    kind,
                    rawBytes: body.length,
                    gzipBytes:
                      kind === "js" || kind === "locale" || kind === "css"
                        ? gzipSize(body)
                        : body.length,
                  });
                  if (kind === "js") bodies.set(response.url(), body.toString("latin1"));
                })
                .catch(() => undefined),
            );
          });
          await page.goto(`${webOrigin}${scenario.route}`, { waitUntil: "load", timeout: 120_000 });
          await page.waitForLoadState("networkidle", { timeout: 120_000 });
          await page.waitForTimeout(2_000);
          await Promise.all(pending);
          const vitals = await page.evaluate(
            () => (window as unknown as { __knVitals: { lcp: number; cls: number } }).__knVitals,
          );
          runsOut.push({ lcpMs: vitals.lcp, cls: vitals.cls, resources, bodies });
          await context.close();
        }
        results.push({ scenario: scenario.name, runs: runsOut });
      }
    } finally {
      await browser.close();
    }

    // Budget accounting from the first cold run of each scenario.
    const registry = JSON.parse(await readFile(path.join(locales, "registry.json"), "utf8")) as {
      buildId: string;
      locales: { tag: string; namespaces: { name: string; url: string }[] }[];
    };
    const localeBytes = async (tag: string, fetched: Resource[]) => {
      const names = new Set(["common", "accessibility"]);
      for (const resource of fetched.filter((item) => item.kind === "locale"))
        names.add(path.basename(new URL(resource.url).pathname, ".json"));
      let total = 0;
      for (const target of new Set([tag, "en"]))
        for (const name of names) {
          const entry = registry.locales
            .find((locale) => locale.tag === target)
            ?.namespaces.find((namespace) => namespace.name === name);
          if (entry)
            total += gzipSize(
              await readFile(path.join(locales, entry.url.replace(/^\/locales\//u, ""))),
            );
        }
      return total;
    };
    const scenarioReports = [];
    const localeGzipBytes: Record<string, number> = {};
    const lcpMedianMs: Record<string, number> = {};
    const clsMedian: Record<string, number> = {};
    for (const [index, result] of results.entries()) {
      const scenario = scenarios[index] as Scenario;
      const first = result.runs[0];
      if (!first) continue;
      const account = accountResources(first.resources);
      lcpMedianMs[result.scenario] = median(result.runs.map((item) => item.lcpMs));
      clsMedian[result.scenario] =
        Math.round(median(result.runs.map((item) => item.cls)) * 1000) / 1000;
      if (scenario.route === "/join")
        localeGzipBytes[scenario.locale] = await localeBytes(scenario.locale, first.resources);
      scenarioReports.push({
        scenario: result.scenario,
        lcpMs: result.runs.map((item) => Math.round(item.lcpMs)),
        cls: result.runs.map((item) => Math.round(item.cls * 1000) / 1000),
        lcpMedianMs: Math.round(lcpMedianMs[result.scenario] ?? 0),
        clsMedian: clsMedian[result.scenario],
        account,
      });
    }
    const joinRun = results[0]?.runs[0];
    const identityRun = results[1]?.runs[0];
    const joinBodies = [...(joinRun?.bodies.values() ?? [])];
    const lazyViolations = Object.entries(LAZY_MARKERS)
      .filter(([, marker]) => joinBodies.some((body) => body.includes(marker)))
      .map(([label]) => `${label} is in the /join boot`);
    const avatarChunks = (bodies: string[]) =>
      bodies.filter((body) => body.includes(AVATAR_MARKER)).length;
    const avatarInJoin = avatarChunks(joinBodies);
    const avatarInIdentity = avatarChunks([...(identityRun?.bodies.values() ?? [])]);
    if (avatarInIdentity <= avatarInJoin)
      lazyViolations.push(
        `avatar style chunks do not load lazily (join ${avatarInJoin}, identity ${avatarInIdentity})`,
      );
    const initial = accountResources(joinRun?.resources ?? []);
    const result = budgetVerdict({
      initialJsGzipBytes: initial.js.gzipBytes,
      localeGzipBytes,
      lcpMedianMs,
      clsMedian,
      lazyViolations,
    });
    return {
      recordedAt: new Date().toISOString(),
      runsPerScenario: options.runs,
      conditions: {
        viewport: "390×844 mobile",
        download: "1.6 Mbps",
        upload: "750 kbps",
        rttMs: 150,
        cpuSlowdown: 4,
        cache: "disabled (cold)",
        browser: `Chromium ${browser.version()}`,
        build: "next build (production) + next start",
      },
      budgets: BUDGETS,
      initialJs: {
        gzipBytes: initial.js.gzipBytes,
        rawBytes: initial.js.rawBytes,
        files: initial.js.count,
        manifest: initial.manifest,
      },
      initialLocaleGzipBytes: localeGzipBytes,
      lazy: {
        markersAbsentFromJoin: Object.keys(LAZY_MARKERS).filter(
          (label) => !lazyViolations.some((item) => item.startsWith(label)),
        ),
        avatarChunks: { join: avatarInJoin, identity: avatarInIdentity },
      },
      scenarios: scenarioReports,
      verdict: result,
    };
  } finally {
    web?.kill("SIGTERM");
    await runtime.cleanup().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Markdown summary of a record. */
export function markdown(record: Awaited<ReturnType<typeof measure>>): string {
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
  return [
    `Conditions: ${Object.values(record.conditions).join(", ")}; ${record.runsPerScenario} cold runs per scenario.`,
    "",
    `- Initial JS (/join, framework included): **${kib(record.initialJs.gzipBytes)} gzip** (${kib(record.initialJs.rawBytes)} raw, ${record.initialJs.files} files); budget ${kib(record.budgets.initialJsGzipBytes)}`,
    `- Initial locale payload (route namespaces + shell + en fallback): ${Object.entries(
      record.initialLocaleGzipBytes,
    )
      .map(([tag, bytes]) => `${tag} ${kib(bytes)}`)
      .join(", ")}; budget ${kib(record.budgets.initialLocaleGzipBytes)}`,
    `- Lazy: ${record.lazy.markersAbsentFromJoin.join(", ") || "none"} absent from /join; avatar style chunks ${record.lazy.avatarChunks.join} at /join → ${record.lazy.avatarChunks.identity} at the identity step`,
    `- Verdict: **${record.verdict.pass ? "PASS" : `FAIL (${record.verdict.failures.join("; ")})`}**`,
    "",
    "| Scenario | LCP runs (ms) | median LCP | CLS runs | median CLS | JS gzip | fonts | media |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...record.scenarios.map(
      (item) =>
        `| ${item.scenario} | ${item.lcpMs.join(", ")} | ${item.lcpMedianMs} | ${item.cls.join(", ")} | ${item.clsMedian} | ${kib(item.account.js.gzipBytes)} | ${kib(item.account.font.rawBytes)} | ${kib(item.account.media.rawBytes)} |`,
    ),
    "",
    "Largest initial chunks (gzip):",
    "",
    ...record.initialJs.manifest
      .slice(0, 8)
      .map((item) => `- \`${item.file}\` ${kib(item.gzipBytes)} (${kib(item.rawBytes)} raw)`),
    "",
  ].join("\n");
}

/** CLI entry. */
async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "5" },
      "skip-build": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs must be 1..20");
  const record = await measure({ runs, skipBuild: values["skip-build"] });
  const out = path.resolve(
    values.out ?? path.join(ROOT, "test-results", "benchmark", "web-budget.json"),
  );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${markdown(record)}\nRecord: ${out}\n`);
  if (!record.verdict.pass) process.exitCode = 1;
}

if (typeof require !== "undefined" && require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `measure-web-budget failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
