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
  return defineConfig({
    testDir: "./tests/e2e",
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    forbidOnly: Boolean(process.env["CI"]),
    retries: process.env["CI"] ? 2 : 0,
    workers: 1,
    reporter: [["list"], ["html", { open: "never" }]],
    globalTeardown: "./tests/helpers/runtime.ts",
    use: { baseURL: webURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: [
      {
        command: "pnpm --filter @kabuki-neko/api build && pnpm --filter @kabuki-neko/api start",
        port: apiPort,
        env: {
          ...runtime.env,
          PORT: String(apiPort),
          API_PORT: String(apiPort),
          CORS_ORIGIN: webURL,
        },
        timeout: 120000,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      },
      {
        command: `pnpm --filter @kabuki-neko/web exec next dev --hostname 127.0.0.1 --port ${webPort}`,
        url: webURL,
        env: {
          NODE_ENV: "development",
          NEXT_PUBLIC_APP_URL: webURL,
          NEXT_PUBLIC_API_URL: apiURL,
          NEXT_PUBLIC_WS_URL: apiURL,
        },
        timeout: 120000,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      },
    ],
  });
})();
