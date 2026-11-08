/**
 * TASK-112 release gate for the six shipped catalogs (US-21, SA §8.1):
 * - en, id, ja, zh-Hans, es and fr pass the full validator with zero errors and warnings, each with
 *   all twelve namespaces whose keys equal the message contracts exactly (no missing, no unknown);
 * - no message is a raw key, and non-English catalogs are real translations (only a small share of
 *   short labels/cognates may equal English, never full sentences);
 * - every UI inventory item of Design §6 (screens, dialogs, base and feature components) has its
 *   title and five-state (L/E/I/P/X) messages in the contracts and in every catalog;
 * - `locales:build` publishes the API bundle and the web public mirror with the same buildId and
 *   byte-identical, hash-verified assets; the template ZIP extracts into a package that validates;
 *   the standard build refuses to publish when a shipped built-in is missing.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strFromU8, unzipSync } from "fflate";
import {
  LOCALE_NAMESPACES,
  localeRegistrySchema,
  type LocaleNamespace,
} from "../../packages/shared/src/schemas/locale.schema";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
/** The six shipped built-in packages (mirrors SHIPPED_BUILTINS in scripts/locales-build.ts). */
const SHIPPED_BUILTINS = ["en", "id", "ja", "zh-Hans", "es", "fr"] as const;
const BUILTIN = path.join(ROOT, "packages/shared/locales");
const CONTRACTS = path.join(BUILTIN, "message-contracts.json");
const STATES = ["title", "loading", "empty", "ideal", "partial", "error"] as const;
let scratch: string;
let emptyExternal: string;
let contracts: Record<string, unknown>;

/** Contract keys of one namespace, relative to it. */
function contractKeys(namespace: LocaleNamespace): string[] {
  return Object.keys(contracts)
    .filter((key) => key.startsWith(`${namespace}.`))
    .map((key) => key.slice(namespace.length + 1))
    .sort();
}
/** Raw messages of one catalog file. */
async function catalog(locale: string, namespace: string): Promise<Record<string, string>> {
  return JSON.parse(
    await readFile(path.join(BUILTIN, locale, `${namespace}.json`), "utf8"),
  ) as Record<string, string>;
}
/** JSON report of `pnpm locales:validate --json` (the tools are ESM-backed, so run through tsx). */
interface ValidationReport {
  passed: boolean;
  packages: { locale: string; kind: string; coverage: number; valid: boolean }[];
  diagnostics: { file: string; code: string; severity: string; message: string }[];
}
/** Runs the validator CLI with extra flags and parses its JSON report. */
async function validate(...flags: string[]): Promise<ValidationReport> {
  const result = await run(TSX, ["scripts/locales-validate.ts", "--json", ...flags], {
    cwd: ROOT,
  }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));
  return JSON.parse(result.stdout) as ValidationReport;
}
/** Runs the build CLI; resolves with exit status and output. */
async function build(...flags: string[]) {
  try {
    const result = await run(TSX, ["scripts/locales-build.ts", ...flags], { cwd: ROOT });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
/** Hex SHA-256 of a buffer. */
function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
/** Inventory IDs (S/M/B/F + two digits) listed in the Design §6 five-state matrix tables. */
async function designInventory(): Promise<string[]> {
  const design = await readFile(path.join(ROOT, "docs/vibe/02-design-spec.md"), "utf8");
  const start = design.indexOf("## 6. Mandatory five-state UI matrix");
  const end = design.indexOf("## 7. Micro-interactions");
  const section = design.slice(start, end);
  return [...new Set([...section.matchAll(/^\| ([SMBF]\d{2})\b/gmu)].map((m) => m[1] ?? ""))]
    .filter(Boolean)
    .sort();
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kabuki-locale-coverage-"));
  emptyExternal = path.join(scratch, "external");
  await mkdir(emptyExternal);
  contracts = JSON.parse(await readFile(CONTRACTS, "utf8")) as Record<string, unknown>;
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

it("passes the full gate for all six built-ins with exact keys in all twelve namespaces", async () => {
  const report = await validate("--external-root", emptyExternal);
  expect(report.diagnostics).toEqual([]);
  expect(report.passed).toBe(true);
  expect(report.packages.map((item) => item.locale).sort()).toEqual([...SHIPPED_BUILTINS].sort());
  for (const tag of SHIPPED_BUILTINS) {
    expect(report.packages.find((item) => item.locale === tag)).toMatchObject({
      kind: "builtin",
      valid: true,
      coverage: 1,
    });
    // Every namespace file holds exactly the contract keys: none missing, none unknown.
    for (const namespace of LOCALE_NAMESPACES)
      expect(Object.keys(await catalog(tag, namespace)).sort()).toEqual(contractKeys(namespace));
  }
  expect(LOCALE_NAMESPACES).toHaveLength(12);
});

it("contains no raw keys and only real translations outside English", async () => {
  const english: Record<string, Record<string, string>> = {};
  for (const namespace of LOCALE_NAMESPACES) english[namespace] = await catalog("en", namespace);
  for (const tag of SHIPPED_BUILTINS) {
    let identical = 0;
    let total = 0;
    for (const namespace of LOCALE_NAMESPACES) {
      for (const [key, value] of Object.entries(await catalog(tag, namespace))) {
        total++;
        expect(value).not.toBe(key);
        expect(value).not.toBe(`${namespace}.${key}`);
        expect(value).not.toMatch(/^[a-z]+(?:\.[a-zA-Z0-9]+)+$/u);
        if (tag === "en" || value !== english[namespace]?.[key]) continue;
        identical++;
        // Shared labels/cognates are fine; a copied English sentence is not a translation.
        expect({ tag, namespace, key, sentence: /[.!?]$/u.test(value) }).toEqual({
          tag,
          namespace,
          key,
          sentence: false,
        });
      }
    }
    expect(total).toBe(Object.keys(contracts).length);
    if (tag !== "en") expect(identical / total).toBeLessThanOrEqual(0.05);
  }
});

it("covers the title and five states of every Design §6 inventory item in every catalog", async () => {
  const ids = await designInventory();
  expect(ids).toHaveLength(61);
  const contractIds = new Set(
    Object.keys(contracts)
      .map((key) => /^[a-z]+\.inventory\.([a-z]\d{2})\./u.exec(key)?.[1])
      .filter((id): id is string => id !== undefined),
  );
  expect([...contractIds].sort()).toEqual(ids.map((id) => id.toLowerCase()));
  for (const id of ids.map((value) => value.toLowerCase())) {
    const owners = LOCALE_NAMESPACES.filter((namespace) =>
      Object.hasOwn(contracts, `${namespace}.inventory.${id}.loading`),
    );
    expect({ id, owners: owners.length }).toEqual({ id, owners: 1 });
    const namespace = owners[0] as LocaleNamespace;
    for (const state of STATES)
      expect(Object.hasOwn(contracts, `${namespace}.inventory.${id}.${state}`)).toBe(true);
    for (const tag of SHIPPED_BUILTINS) {
      const messages = await catalog(tag, namespace);
      for (const state of STATES)
        expect(messages[`inventory.${id}.${state}`]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  }
});

it("publishes the same hash-verified bundle to the API and the web app and a valid template", async () => {
  const out = path.join(scratch, "locales-built");
  const web = path.join(scratch, "web-public-locales");
  const flags = ["--external-root", emptyExternal, "--out", out, "--web-public", web];
  const outcome = await build(...flags);
  if (outcome.code !== 0) throw new Error(outcome.stderr);
  const buildId = /Built catalog ([a-f0-9]{64})/u.exec(outcome.stdout)?.[1];
  const apiRegistry = localeRegistrySchema.parse(
    JSON.parse(await readFile(path.join(out, "registry.json"), "utf8")),
  );
  const webRegistry = localeRegistrySchema.parse(
    JSON.parse(await readFile(path.join(web, "registry.json"), "utf8")),
  );
  expect(webRegistry).toEqual(apiRegistry);
  expect(apiRegistry.buildId).toBe(buildId);
  expect(apiRegistry.locales.map((entry) => [entry.tag, entry.coverage])).toEqual(
    [...SHIPPED_BUILTINS].sort().map((tag) => [tag, 1]),
  );
  for (const entry of apiRegistry.locales) {
    expect(entry.namespaces.map((asset) => asset.name)).toEqual([...LOCALE_NAMESPACES]);
    for (const asset of entry.namespaces) {
      const relative = path.join(apiRegistry.buildId, entry.tag, `${asset.name}.json`);
      const [apiFile, webFile] = await Promise.all([
        readFile(path.join(out, relative)),
        readFile(path.join(web, relative)),
      ]);
      expect(sha256(apiFile)).toBe(asset.sha256);
      expect(sha256(webFile)).toBe(asset.sha256);
      expect(asset.url).toBe(`/locales/${apiRegistry.buildId}/${entry.tag}/${asset.name}.json`);
    }
  }
  // The template is identical in both outputs, extracts, and becomes a valid package.
  const [apiZip, webZip] = await Promise.all([
    readFile(path.join(out, "template-v1.zip")),
    readFile(path.join(web, "template-v1.zip")),
  ]);
  expect(sha256(webZip)).toBe(sha256(apiZip));
  const entries = unzipSync(new Uint8Array(apiZip));
  const folder = "kabuki-neko-locale-template-v1";
  expect(Object.keys(entries).sort()).toEqual(
    [
      "README.md",
      "manifest.json",
      "message-contracts.json",
      ...LOCALE_NAMESPACES.map((namespace) => `${namespace}.json`),
    ]
      .map((name) => `${folder}/${name}`)
      .sort(),
  );
  const external = path.join(scratch, "template-external");
  const target = path.join(external, "de");
  await mkdir(target, { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    const file = name.slice(folder.length + 1);
    if (file === "README.md" || file === "message-contracts.json") continue;
    let content = strFromU8(data);
    if (file === "manifest.json")
      content = JSON.stringify({ ...JSON.parse(content), locale: "de", nativeName: "Deutsch" });
    await writeFile(path.join(target, file), content);
  }
  const extracted = await validate("--external-root", external, "--locale", "de");
  expect(extracted.diagnostics).toEqual([]);
  expect(extracted.packages).toEqual([
    expect.objectContaining({ locale: "de", kind: "external", valid: true, coverage: 1 }),
  ]);
  // Rebuilding identical sources yields the identical buildId.
  const again = await build(...flags);
  expect(/Built catalog ([a-f0-9]{64})/u.exec(again.stdout)?.[1]).toBe(buildId);
});

it("refuses to publish a standard build when a shipped built-in is missing", async () => {
  const partial = path.join(scratch, "partial-builtins");
  await mkdir(partial);
  await cp(path.join(BUILTIN, "en"), path.join(partial, "en"), { recursive: true });
  const out = path.join(scratch, "partial-out");
  const flags = ["--builtin-root", partial, "--external-root", emptyExternal, "--out", out];
  const refused = await build(...flags, "--require-builtins", SHIPPED_BUILTINS.join(","));
  expect(refused.code).toBe(1);
  expect(
    [...refused.stderr.matchAll(/partial-builtins\/([A-Za-z-]+) error INVALID_MANIFEST/gu)]
      .map((match) => match[1])
      .sort(),
  ).toEqual(["es", "fr", "id", "ja", "zh-Hans"]);
  expect(refused.stderr).toContain("the installed bundle was not changed");
  await expect(readdir(out)).rejects.toMatchObject({ code: "ENOENT" });
  // A custom builtin root only needs the complete en fallback unless required explicitly.
  expect((await build(...flags)).code).toBe(0);
});
