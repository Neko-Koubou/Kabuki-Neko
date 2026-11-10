/**
 * Playwright E2E configuration (00-project-context §2; TASK-135 wiring).
 *
 * - Chromium, one worker, specs in `tests/e2e`.
 * - Two servers on fixed test ports, both bound to 127.0.0.1:
 *   - the API (dependencies + API build, then `start`) on 43101;
 *   - the web app (`next build`, then `next start`) on 43100. The production build is what
 *     ships and leaves no `.next/dev` types that would collide with `.next/types` afterwards.
 * - The API runs on an isolated runtime from `createTestRuntime` (temp directory with SQLite,
 *   memory state, local uploads, generated secrets and a synthetic locale bundle), so every run
 *   starts uninitialized (first-run setup). The directory is removed on exit and in the global
 *   teardown.
 * - The API trusts only loopback as a proxy (`TRUST_PROXY_CIDRS`), so specs can give each browser
 *   context its own client address with `X-Forwarded-For`, as a reverse proxy would. Per-IP auth
 *   rate limits then apply per simulated client instead of to the whole suite.
 * - The web server gets `API_INTERNAL_URL` for server-side setup-status and locale checks.
 * - `KABUKI_E2E_API_URL` exposes the API URL to specs. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point
 *   at a preinstalled Chromium binary.
 */
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { createTestRuntime, createSyntheticCatalog } from "./tests/helpers/runtime";

export default (async () => {
  const runtime = await createTestRuntime();
  process.once("exit", () => rmSync(runtime.directory, { recursive: true, force: true }));
  process.env["KABUKI_E2E_RUNTIME_DIR"] = runtime.directory;
  const contractsFile = path.resolve("packages/shared/locales/message-contracts.json");
  if (existsSync(contractsFile)) {
    await createSyntheticCatalog(path.join(runtime.directory, "locales-built"), contractsFile);
  }
  const apiPort = 43101;
  const webPort = 43100;
  const apiURL = `http://127.0.0.1:${apiPort}`;
  const webURL = `http://127.0.0.1:${webPort}`;
  process.env["KABUKI_E2E_API_URL"] = apiURL;
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  return defineConfig({
    testDir: "./tests/e2e",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    forbidOnly: Boolean(process.env["CI"]),
    retries: process.env["CI"] ? 2 : 0,
    workers: 1,
    reporter: [["list"], ["html", { open: "never" }]],
    globalTeardown: "./tests/helpers/runtime.ts",
    use: {
      baseURL: webURL,
      locale: "en-US",
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      ...(executablePath ? { launchOptions: { executablePath } } : {}),
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: [
      {
        command:
          'pnpm --filter "@kabuki-neko/api..." build && pnpm --filter @kabuki-neko/api start',
        port: apiPort,
        env: {
          ...runtime.env,
          PORT: String(apiPort),
          API_PORT: String(apiPort),
          CORS_ORIGIN: webURL,
          APP_URL: webURL,
          NEXT_PUBLIC_APP_URL: webURL,
          NEXT_PUBLIC_API_URL: apiURL,
          NEXT_PUBLIC_WS_URL: apiURL,
          API_INTERNAL_URL: apiURL,
          TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
        },
        timeout: 300000,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      },
      {
        // Production build: what ships, and no `.next/dev` types left behind to collide with
        // `.next/types` in later `next build`/`tsc` runs.
        command: `pnpm --filter @kabuki-neko/web build && pnpm --filter @kabuki-neko/web exec next start --hostname 127.0.0.1 --port ${webPort}`,
        url: webURL,
        env: {
          NEXT_PUBLIC_APP_URL: webURL,
          NEXT_PUBLIC_API_URL: apiURL,
          NEXT_PUBLIC_WS_URL: apiURL,
          API_INTERNAL_URL: apiURL,
          APP_URL: webURL,
        },
        timeout: 300000,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      },
    ],
  });
})();
