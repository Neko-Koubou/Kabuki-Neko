/**
 * TASK-172 locale package round trip (SA §8.1–8.2; US-21, AC-21-01..04).
 *
 * Every build here goes to temporary directories; the repository bundle is only read.
 *
 * 1. The six shipped built-ins (en, id, ja, zh-Hans, es, fr) validate complete with zero
 *    diagnostics.
 * 2. Pseudo-locales:
 *    - `en-XA` (accented, ≥ +40% longer) and `ar-XB` (right-to-left), generated from every English
 *      namespace, validate without a single diagnostic only with `allowPseudo`, with placeholders
 *      intact;
 *    - without it they are refused;
 *    - even with it the build refuses to publish them, because the production registry schema
 *      rejects reserved tags;
 *    - the repository's built registries contain none.
 * 3. Install → build both → serve → rollback:
 *    - genuine partial `de` and RTL `ar` packages are installed as external packages, with no code
 *      or enum changes;
 *    - one build publishes the identical bundle to the API and web directories;
 *    - the built API serves it from `/system/locales`;
 *    - removing the packages and rebuilding restores the original buildId (the test build stays as
 *      the previous one), and the API serves six locales again.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LOCALE_NAMESPACES,
  localeRegistrySchema,
} from "../../packages/shared/src/schemas/locale.schema";
import {
  ARABIC,
  GERMAN,
  PSEUDO_EXPANSION,
  englishMessages,
  pseudoPackage,
  writePackage,
} from "../e2e/fixtures/locale-packages";
import { createTestRuntime, httpClient, startApi } from "../helpers/runtime";

jest.setTimeout(300_000);

const ROOT = path.resolve(__dirname, "../..");
const BUILTIN_ROOT = path.join(ROOT, "packages/shared/locales");
const CONTRACTS = path.join(BUILTIN_ROOT, "message-contracts.json");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
/** The six packages every release ships complete. */
const SHIPPED_BUILTINS = ["en", "es", "fr", "id", "ja", "zh-Hans"];
const run = promisify(execFile);

/** Runs a locale CLI (`scripts/<script>`) the way operators do; returns its exit code and output. */
async function cli(script: string, args: string[]) {
  try {
    const { stdout, stderr } = await run(TSX, [path.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

/** One package in `locales:validate --json` output. */
interface ValidatedSummary {
  locale: string;
  kind: "builtin" | "external";
  direction: "ltr" | "rtl";
  coverage: number;
}
/** One diagnostic in `locales:validate --json` output. */
interface Diagnostic {
  file: string;
  severity: "error" | "warning";
  code: string;
}

/** `locales:validate --json` over the built-ins plus `external` (pseudo only when allowed). */
async function validate(external: string | null, allowPseudo = false) {
  const outcome = await cli("locales-validate.ts", [
    "--json",
    "--builtin-root",
    BUILTIN_ROOT,
    "--contracts",
    CONTRACTS,
    "--external-root",
    external ?? (await scratch("none")),
    ...(allowPseudo ? ["--allow-pseudo"] : []),
  ]);
  return {
    code: outcome.code,
    ...(JSON.parse(outcome.stdout) as {
      passed: boolean;
      packages: ValidatedSummary[];
      diagnostics: Diagnostic[];
    }),
  };
}

/** `locales:build` into `out` (and `web`), requiring the shipped built-ins; returns the buildId. */
async function build(external: string, out: string, web: string | null, allowPseudo = false) {
  const outcome = await cli("locales-build.ts", [
    "--builtin-root",
    BUILTIN_ROOT,
    "--contracts",
    CONTRACTS,
    "--external-root",
    external,
    "--out",
    out,
    "--web-public",
    web ?? "none",
    "--require-builtins",
    SHIPPED_BUILTINS.join(","),
    ...(allowPseudo ? ["--allow-pseudo"] : []),
  ]);
  return { ...outcome, buildId: /Built catalog ([a-f0-9]{64})/u.exec(outcome.stdout)?.[1] ?? null };
}

/** Fresh temporary directory removed by `afterAll`. */
const temporary: string[] = [];
async function scratch(name: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kabuki-l10n-${name}-`));
  temporary.push(directory);
  return directory;
}

/** Locale tags of a registry file. */
async function registryTags(file: string): Promise<{ buildId: string; tags: string[] }> {
  const registry = localeRegistrySchema.parse(JSON.parse(await readFile(file, "utf8")));
  return { buildId: registry.buildId, tags: registry.locales.map((locale) => locale.tag).sort() };
}

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

it("keeps the six shipped built-ins complete with zero diagnostics", async () => {
  const result = await validate(null);
  expect(result.code).toBe(0);
  expect(result.diagnostics).toEqual([]);
  expect(result.passed).toBe(true);
  const builtins = result.packages.filter((item) => item.kind === "builtin");
  expect(builtins.map((item) => [item.locale, item.coverage]).sort()).toEqual(
    SHIPPED_BUILTINS.map((tag) => [tag, 1]),
  );
});

it("validates en-XA and ar-XB only as test builds and never publishes them", async () => {
  const external = await scratch("pseudo");
  const english = await englishMessages(LOCALE_NAMESPACES);
  for (const tag of ["en-XA", "ar-XB"] as const) {
    const pseudo = await pseudoPackage(tag, LOCALE_NAMESPACES);
    await writePackage(external, pseudo);
    // At least +40% longer than English, for every message of every namespace.
    for (const [namespace, entries] of Object.entries(pseudo.messages))
      for (const [key, value] of Object.entries(entries)) {
        const source = english[namespace]?.[key] ?? "";
        expect({
          key: `${namespace}.${key}`,
          expanded: [...value].length >= [...source].length * (1 + PSEUDO_EXPANSION),
        }).toEqual({
          key: `${namespace}.${key}`,
          expanded: true,
        });
      }
  }

  // With the explicit test opt-in: complete, and no ICU, placeholder or markup diagnostic at all.
  const allowed = await validate(external, true);
  expect(allowed.diagnostics).toEqual([]);
  expect(allowed.passed).toBe(true);
  expect(
    allowed.packages
      .filter((item) => item.kind === "external")
      .map((item) => [item.locale, item.direction, item.coverage])
      .sort(),
  ).toEqual([
    ["ar-XB", "rtl", 1],
    ["en-XA", "ltr", 1],
  ]);

  // Without it: refused as invalid manifests, so a release validation never accepts them.
  const refused = await validate(external);
  expect(refused.packages.filter((item) => item.kind === "external")).toEqual([]);
  expect(
    refused.diagnostics
      .filter((item) => item.code === "INVALID_MANIFEST")
      .map((item) => path.basename(path.dirname(item.file)))
      .sort(),
  ).toEqual(["ar-XB", "en-XA"]);

  // Even a test build cannot publish them: the production registry schema rejects reserved tags,
  // so the build fails and nothing is written.
  const out = await scratch("pseudo-out");
  const attempt = await build(external, out, null, true);
  expect(attempt.code).not.toBe(0);
  expect(attempt.buildId).toBeNull();
  await expect(stat(path.join(out, "registry.json"))).rejects.toThrow();

  // The production registry schema and the repository's built registries agree.
  const base = await registryTags(path.join(ROOT, "apps/web/public/locales/registry.json")).catch(
    () => null,
  );
  for (const registry of [
    base,
    await registryTags(path.join(ROOT, "locales-built/registry.json")).catch(() => null),
  ])
    if (registry) expect(registry.tags.filter((tag) => /-X[AB]$/u.test(tag))).toEqual([]);
  const forged = {
    buildId: "a".repeat(64),
    catalogVersion: "1",
    locales: [
      {
        tag: "en-XA",
        nativeName: "x",
        direction: "ltr",
        packageVersion: "1.0.0",
        coverage: 1,
        catalogVersion: "1",
        namespaces: [],
      },
    ],
  };
  expect(localeRegistrySchema.safeParse(forged).success).toBe(false);
});

it("installs genuine extra languages, publishes one bundle to the API and web, and rolls back", async () => {
  const external = await scratch("external");
  const apiDir = await scratch("api");
  const webDir = await scratch("web");
  /** Builds into both targets; returns the buildId or fails with the CLI output. */
  const publish = async () => {
    const outcome = await build(external, apiDir, webDir);
    if (outcome.code !== 0 || !outcome.buildId)
      throw new Error(`locales:build failed: ${outcome.stderr}${outcome.stdout}`);
    return outcome.buildId;
  };

  // Baseline: the six built-ins only.
  const baseline = await publish();
  expect((await registryTags(path.join(apiDir, "registry.json"))).tags).toEqual(SHIPPED_BUILTINS);

  // Install: two genuine partial packages, data only; partial packages only warn.
  await writePackage(external, GERMAN);
  await writePackage(external, ARABIC);
  const check = await validate(external);
  expect(check.passed).toBe(true);
  expect(check.diagnostics.every((item) => item.severity === "warning")).toBe(true);
  const installed = await publish();
  expect(installed).not.toBe(baseline);
  const registry = localeRegistrySchema.parse(
    JSON.parse(await readFile(path.join(apiDir, "registry.json"), "utf8")),
  );
  const entries = new Map(registry.locales.map((locale) => [locale.tag, locale]));
  expect([...entries.keys()].sort()).toEqual([...SHIPPED_BUILTINS, "ar", "de"].sort());
  expect(entries.get("ar")?.direction).toBe("rtl");
  expect(entries.get("de")?.nativeName).toBe("Deutsch");
  for (const tag of ["ar", "de"]) {
    const coverage = entries.get(tag)?.coverage ?? 1;
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(1);
  }
  // Both targets publish the identical registry and assets.
  const apiRegistry = await readFile(path.join(apiDir, "registry.json"), "utf8");
  expect(await readFile(path.join(webDir, "registry.json"), "utf8")).toBe(apiRegistry);
  for (const namespace of ["common", "player"])
    expect(await readFile(path.join(webDir, installed, "de", `${namespace}.json`), "utf8")).toBe(
      await readFile(path.join(apiDir, installed, "de", `${namespace}.json`), "utf8"),
    );

  // The built API serves the installed bundle as-is.
  const runtime = await createTestRuntime();
  try {
    const served = async () => {
      const api = await startApi(runtime, {
        LOCALE_BUNDLE_PATH: apiDir,
        // The storage origin is pinned at first start; restarts get new ports, so keep one URL.
        NEXT_PUBLIC_API_URL: "http://localhost:3001",
      });
      try {
        const response = await httpClient(api.base)("/system/locales");
        expect(response.status).toBe(200);
        return response.json as { buildId: string; locales: { tag: string }[] };
      } finally {
        await api.stop();
      }
    };
    const live = await served();
    expect(live.buildId).toBe(installed);
    expect(live.locales.map((locale) => locale.tag).sort()).toEqual(
      [...SHIPPED_BUILTINS, "ar", "de"].sort(),
    );

    // Rollback: remove the packages and rebuild; the original bundle is active again and the test
    // build is kept as the previous one.
    await rm(path.join(external, "de"), { recursive: true });
    await rm(path.join(external, "ar"), { recursive: true });
    const rolledBack = await publish();
    expect(rolledBack).toBe(baseline);
    for (const dir of [apiDir, webDir]) {
      expect((await registryTags(path.join(dir, "registry.json"))).buildId).toBe(baseline);
      expect((await stat(path.join(dir, installed))).isDirectory()).toBe(true);
    }
    const restored = await served();
    expect(restored.buildId).toBe(baseline);
    expect(restored.locales.map((locale) => locale.tag).sort()).toEqual(
      [...SHIPPED_BUILTINS].sort(),
    );
  } finally {
    await runtime.cleanup();
  }
});
