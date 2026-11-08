/**
 * TASK-070 contract tests for `scripts/locales-validate.ts`. The ICU parser is ESM-only, so the CLI
 * is exercised as a child process (exactly how operators run it) against temporary built-in and
 * external package roots: complete, partial, RTL and many invalid packages, with exact diagnostic
 * file/namespace/key/line/column assertions. Package files are never evaluated.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const CONTRACTS = {
  "common.greeting": { description: "Greeting", placeholders: { name: "string" }, required: true },
  "common.items": { description: "Item count", placeholders: { count: "number" }, required: true },
  "common.save": { description: "Save button", placeholders: {}, required: true },
  "auth.lastSeen": {
    description: "Last seen date",
    placeholders: { when: "date" },
    required: true,
  },
  "auth.optionalHint": { description: "Optional hint", placeholders: {}, required: false },
};
interface Diagnostic {
  file: string;
  namespace: string | null;
  key: string | null;
  severity: "error" | "warning";
  code: string;
  line: number | null;
  column: number | null;
  message: string;
}
interface Report {
  passed: boolean;
  packages: { locale: string; kind: string; direction: string; coverage: number; valid: boolean }[];
  diagnostics: Diagnostic[];
}
let directory: string;
let builtin: string;
let external: string;
let contracts: string;
let marker: string;

/** Writes a manifest for `locale` with optional overrides. */
function manifest(locale: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    locale,
    nativeName: `Native ${locale}`,
    direction: "ltr",
    packageVersion: "1.0.0",
    catalogVersion: "1",
    credits: [{ name: "Kabuki Neko contributors", url: null }],
    ...overrides,
  });
}
/** Creates a package directory with the given raw file contents. */
async function pkg(root: string, locale: string, files: Record<string, string>) {
  const dir = path.join(root, locale);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(dir, name), content);
  return dir;
}
/** A complete, valid package body. */
function complete(locale: string, direction = "ltr") {
  return {
    "manifest.json": manifest(locale, { direction }),
    "common.json": JSON.stringify({
      greeting: "Hello {name}",
      items: "{count, plural, one {# item} other {# items}}",
      save: "Save",
    }),
    "auth.json": JSON.stringify({ lastSeen: "Last seen {when, date, medium}" }),
  };
}
/** Runs the validator CLI with JSON output and returns the parsed report plus exit code. */
async function validate(...flags: string[]): Promise<Report & { exitCode: number }> {
  const args = [
    path.join(ROOT, "scripts/locales-validate.ts"),
    "--builtin-root",
    builtin,
    "--external-root",
    external,
    "--contracts",
    contracts,
    "--json",
    ...flags,
  ];
  try {
    const { stdout } = await run(TSX, args, { cwd: directory });
    return { ...(JSON.parse(stdout) as Report), exitCode: 0 };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { ...(JSON.parse(failure.stdout) as Report), exitCode: failure.code };
  }
}
/** Finds diagnostics for one package-relative file name. */
function forFile(report: Report, suffix: string) {
  return report.diagnostics.filter((item) => item.file.endsWith(suffix));
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "kabuki-locales-"));
  builtin = path.join(directory, "builtin");
  external = path.join(directory, "extensions");
  contracts = path.join(directory, "message-contracts.json");
  marker = path.join(directory, "evaluated.marker");
  await writeFile(contracts, JSON.stringify(CONTRACTS));
  await pkg(builtin, "en", complete("en"));
  await pkg(builtin, "id", complete("id"));
  const partial = complete("ar", "rtl");
  partial["common.json"] = JSON.stringify({
    greeting: "مرحبا {name}",
    items: "{count, plural, other {# عناصر}}",
  });
  await pkg(external, "ar", partial);
  await pkg(external, "de", {
    "manifest.json": manifest("de"),
    "common.json": [
      "{",
      '  "greeting": "Hallo {nme}",',
      '  "items": "{count, plural, one {# Ding}}",',
      '  "save": "<b>Speichern</b>",',
      '  "unknownKey": "x"',
      "}",
    ].join("\n"),
    "auth.json": ["{", '  "lastSeen": "{when, date, short}",', '  "lastSeen": "again"', "}"].join(
      "\n",
    ),
    "evil.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pwned");`,
  });
  await pkg(external, "fr", {
    ...complete("fr"),
    "manifest.json": manifest("fr", { catalogVersion: "2" }),
  });
  await pkg(external, "en", complete("en"));
  const es = await pkg(external, "es", { "manifest.json": manifest("es") });
  await symlink(path.join(builtin, "en", "common.json"), path.join(es, "common.json"));
  const deep = "{count, plural, other {".repeat(6) + "#" + "}}".repeat(6);
  await pkg(external, "ja", {
    ...complete("ja"),
    "common.json": JSON.stringify({ greeting: "{name}", items: deep, save: "保存" }),
  });
  await pkg(external, "it", {
    ...complete("it"),
    "auth.json": JSON.stringify({ lastSeen: "{when, date} " + "x".repeat(300 * 1024) }),
  });
  await pkg(external, "pt", {
    ...complete("pt"),
    "manifest.json": manifest("pt", {
      packageVersion: "01.0.0",
      credits: [{ name: "x", url: "http://insecure.example" }],
    }),
  });
  await pkg(external, "nl", { ...complete("nl"), "manifest.json": manifest("de") });
  await pkg(external, "ko", {
    ...complete("ko"),
    "manifest.json": '{\n  "schemaVersion": 1,\n  "schemaVersion": 1\n}',
  });
}, 60_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("accepts complete built-ins and a partial RTL external package with en fallback warnings", async () => {
  const report = await validate();
  expect(report.exitCode).toBe(1);
  const byLocale = new Map(report.packages.map((item) => [`${item.kind}:${item.locale}`, item]));
  expect(byLocale.get("builtin:en")).toMatchObject({ coverage: 1, valid: true });
  expect(byLocale.get("builtin:id")).toMatchObject({ coverage: 1, valid: true });
  expect(byLocale.get("external:ar")).toMatchObject({
    direction: "rtl",
    coverage: 0.75,
    valid: true,
  });
  expect(forFile(report, path.join("builtin", "en", "common.json"))).toEqual([]);
  expect(forFile(report, path.join("ar", "common.json"))).toEqual([
    expect.objectContaining({
      namespace: "common",
      key: "save",
      severity: "warning",
      code: "MISSING_KEY",
    }),
  ]);
  const builtins = await validate(
    "--locale",
    "en,id",
    "--external-root",
    path.join(directory, "none"),
  );
  expect(builtins).toMatchObject({ passed: true, exitCode: 0, diagnostics: [] });
  const targeted = await validate("--locale", "ar", "--namespaces", "auth");
  expect(targeted).toMatchObject({ passed: true, exitCode: 0, diagnostics: [] });
  expect(targeted.packages).toEqual([expect.objectContaining({ locale: "ar", coverage: 1 })]);
});

it("reports exact positions for placeholder, ICU, markup, unknown and duplicate keys", async () => {
  const report = await validate("--locale", "de");
  const common = forFile(report, path.join("de", "common.json"));
  expect(common).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        namespace: "common",
        key: "greeting",
        code: "PLACEHOLDER_MISMATCH",
        severity: "error",
        line: 2,
        column: 3,
      }),
      expect.objectContaining({
        namespace: "common",
        key: "items",
        code: "INVALID_ICU",
        line: 3,
        column: 3,
      }),
      expect.objectContaining({
        namespace: "common",
        key: "save",
        code: "FORBIDDEN_MARKUP",
        line: 4,
        column: 3,
      }),
      expect.objectContaining({
        namespace: "common",
        key: "unknownKey",
        code: "UNKNOWN_KEY",
        line: 5,
        column: 3,
      }),
    ]),
  );
  expect(forFile(report, path.join("de", "auth.json"))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        namespace: "auth",
        key: null,
        code: "INVALID_MANIFEST",
        line: 3,
        column: 3,
      }),
    ]),
  );
  expect(forFile(report, path.join("de", "evil.js"))).toEqual([
    expect.objectContaining({ code: "INVALID_MANIFEST", severity: "error" }),
  ]);
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(report.packages).toEqual([expect.objectContaining({ locale: "de", valid: false })]);
  expect(report).toMatchObject({ passed: false, exitCode: 1 });
});

it("rejects incompatible, duplicate, linked, oversized, deep and malformed packages", async () => {
  const report = await validate();
  const codes = (locale: string) =>
    report.diagnostics
      .filter((item) => item.file.includes(`extensions${path.sep}${locale}`))
      .map((item) => item.code);
  expect(codes("fr")).toEqual(["INCOMPATIBLE_VERSION"]);
  expect(codes("en")).toEqual(["DUPLICATE_LOCALE"]);
  expect(codes("es")).toContain("INVALID_MANIFEST");
  expect(codes("ja")).toEqual(["INVALID_ICU"]);
  expect(codes("it")).toContain("PACKAGE_TOO_LARGE");
  expect(codes("pt")).toEqual(["INVALID_MANIFEST"]);
  expect(
    report.diagnostics.find((item) => item.file.includes(`pt${path.sep}manifest`))?.message,
  ).toContain("packageVersion");
  expect(codes("nl")).toEqual(["INVALID_MANIFEST"]);
  expect(report.diagnostics.filter((item) => item.file.includes(`ko${path.sep}manifest`))).toEqual([
    expect.objectContaining({ code: "INVALID_MANIFEST", line: 3, column: 3 }),
  ]);
  const registered = report.packages.map((item) => `${item.kind}:${item.locale}`).sort();
  expect(registered).toEqual([
    "builtin:en",
    "builtin:id",
    "external:ar",
    "external:de",
    "external:es",
    "external:it",
    "external:ja",
  ]);
});

it("treats any missing built-in message as an error and requires the en built-in", async () => {
  const strict = path.join(directory, "strict-builtin");
  const body = complete("en");
  body["common.json"] = JSON.stringify({
    greeting: "Hello {name}",
    items: "{count, plural, other {#}}",
  });
  await pkg(strict, "en", body);
  const missing = await validate(
    "--builtin-root",
    strict,
    "--external-root",
    path.join(directory, "none"),
    "--locale",
    "en",
  );
  expect(missing).toMatchObject({ passed: false, exitCode: 1 });
  expect(missing.diagnostics).toEqual([
    expect.objectContaining({
      namespace: "common",
      key: "save",
      code: "MISSING_KEY",
      severity: "error",
    }),
  ]);
  const empty = path.join(directory, "empty-builtin");
  await mkdir(empty, { recursive: true });
  const noEnglish = await validate(
    "--builtin-root",
    empty,
    "--external-root",
    path.join(directory, "none"),
  );
  expect(noEnglish.diagnostics).toEqual([
    expect.objectContaining({ code: "INVALID_MANIFEST", file: path.join("empty-builtin", "en") }),
  ]);
  await expect(
    run(TSX, [path.join(ROOT, "scripts/locales-validate.ts"), "--namespaces", "bogus"]),
  ).rejects.toMatchObject({ code: 2 });
});
