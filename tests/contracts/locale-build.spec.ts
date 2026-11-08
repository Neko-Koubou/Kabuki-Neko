/**
 * TASK-071 contract tests for `scripts/locales-build.ts` and `scripts/locales-template.ts`, run
 * through tsx as child processes against temporary package roots: registry schema and content
 * hashes, deterministic buildId, invalid input preserving the published bundle, atomic publish with
 * rollback retention/pruning, the reproducible template ZIP and the confined scaffold command.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";
import { localeRegistrySchema } from "@kabuki-neko/shared/schemas/locale.schema";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const NAMESPACES = [
  "common",
  "auth",
  "quizzes",
  "studio",
  "media",
  "host",
  "player",
  "reports",
  "admin",
  "validation",
  "accessibility",
  "about",
];
let directory: string;
let builtin: string;
let external: string;
let contracts: string;

/** Writes a package from a namespace → messages map plus manifest overrides. */
async function pkg(
  root: string,
  locale: string,
  messages: Record<string, Record<string, string>>,
  manifest: Record<string, unknown> = {},
) {
  const dir = path.join(root, locale);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      locale,
      nativeName: `Native ${locale}`,
      direction: "ltr",
      packageVersion: "1.0.0",
      catalogVersion: "1",
      credits: [],
      ...manifest,
    }),
  );
  for (const [namespace, values] of Object.entries(messages))
    await writeFile(path.join(dir, `${namespace}.json`), JSON.stringify(values));
}
/** Complete messages for the small test contract (every namespace file present). */
function messages(greeting = "Hello {name}") {
  const all: Record<string, Record<string, string>> = Object.fromEntries(
    NAMESPACES.map((name) => [name, {}]),
  );
  all.common = { greeting, items: "{count, plural, one {# item} other {# items}}" };
  all.about = { title: "About" };
  return all;
}
/** Runs a script through tsx with `cwd`, returning exit code and output. */
async function tsx(script: string, args: string[], cwd = directory) {
  try {
    const { stdout, stderr } = await run(TSX, [path.join(ROOT, "scripts", script), ...args], {
      cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}
/** Builds into `out` with the shared temporary roots. */
function build(out: string, extraExternal = external) {
  return tsx("locales-build.ts", [
    "--builtin-root",
    builtin,
    "--external-root",
    extraExternal,
    "--contracts",
    contracts,
    "--out",
    out,
  ]);
}
/** Parsed, schema-validated registry of a bundle directory. */
async function registry(out: string) {
  return localeRegistrySchema.parse(
    JSON.parse(await readFile(path.join(out, "registry.json"), "utf8")),
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "kabuki-locale-build-"));
  builtin = path.join(directory, "builtin");
  external = path.join(directory, "extensions");
  contracts = path.join(directory, "contracts.json");
  await writeFile(
    contracts,
    JSON.stringify({
      "common.greeting": {
        description: "Greeting",
        placeholders: { name: "string" },
        required: true,
      },
      "common.items": { description: "Items", placeholders: { count: "number" }, required: true },
      "about.title": { description: "Title", placeholders: {}, required: true },
    }),
  );
  await pkg(builtin, "en", messages());
  await pkg(builtin, "id", messages("Halo {name}"));
  const partial = messages("مرحبا {name}");
  delete partial.about;
  await pkg(external, "ar", partial, { direction: "rtl" });
}, 60_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("publishes a schema-valid registry whose assets match their content hashes", async () => {
  const out = path.join(directory, "bundle-a");
  const result = await build(out);
  expect(result.code).toBe(0);
  const current = await registry(out);
  expect(current.locales.map((entry) => [entry.tag, entry.direction, entry.coverage])).toEqual([
    ["ar", "rtl", 0.6667],
    ["en", "ltr", 1],
    ["id", "ltr", 1],
  ]);
  for (const entry of current.locales)
    for (const asset of entry.namespaces) {
      expect(asset.url).toBe(`/locales/${current.buildId}/${entry.tag}/${asset.name}.json`);
      const content = await readFile(
        path.join(out, current.buildId, entry.tag, `${asset.name}.json`),
        "utf8",
      );
      expect(createHash("sha256").update(content).digest("hex")).toBe(asset.sha256);
    }
  const common = JSON.parse(
    await readFile(path.join(out, current.buildId, "en", "common.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(common)).toEqual(["greeting", "items"]);
  expect(JSON.stringify(common.greeting)).toContain('"value":"name"');
  expect(
    JSON.parse(await readFile(path.join(out, current.buildId, "ar", "about.json"), "utf8")),
  ).toEqual({});

  const again = path.join(directory, "bundle-b");
  expect((await build(again)).code).toBe(0);
  const twin = await registry(again);
  expect(twin.buildId).toBe(current.buildId);
  expect(await readFile(path.join(again, "registry.json"), "utf8")).toBe(
    await readFile(path.join(out, "registry.json"), "utf8"),
  );
});

it("keeps the installed bundle when a package is invalid and publishes new builds atomically", async () => {
  const out = path.join(directory, "bundle-c");
  expect((await build(out)).code).toBe(0);
  const first = await readFile(path.join(out, "registry.json"), "utf8");
  const firstId = (await registry(out)).buildId;

  const broken = path.join(directory, "broken-extensions");
  await pkg(broken, "de", { common: { greeting: "Hallo {nme}" } });
  const failed = await build(out, broken);
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain("PLACEHOLDER_MISMATCH");
  expect(failed.stderr).toContain("installed bundle was not changed");
  expect(await readFile(path.join(out, "registry.json"), "utf8")).toBe(first);
  expect((await readdir(out)).filter((name) => /^[a-f0-9]{64}$/u.test(name))).toEqual([firstId]);

  await pkg(builtin, "id", messages("Selamat datang {name}"));
  expect((await build(out)).code).toBe(0);
  const secondId = (await registry(out)).buildId;
  expect(secondId).not.toBe(firstId);
  expect((await readdir(out)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort()).toEqual(
    [firstId, secondId].sort(),
  );
  expect(
    (await readdir(out)).some((name) => name.startsWith(".staging") || name.endsWith(".tmp")),
  ).toBe(false);

  await pkg(builtin, "id", messages("Hai {name}"));
  expect((await build(out)).code).toBe(0);
  const thirdId = (await registry(out)).buildId;
  expect((await readdir(out)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort()).toEqual(
    [secondId, thirdId].sort(),
  );
});

it("writes a reproducible translator template ZIP with en sources and contracts", async () => {
  const out = path.join(directory, "bundle-a");
  const bytes = await readFile(path.join(out, "template-v1.zip"));
  expect(bytes).toEqual(await readFile(path.join(directory, "bundle-b", "template-v1.zip")));
  const entries = unzipSync(new Uint8Array(bytes));
  const folder = "kabuki-neko-locale-template-v1";
  expect(Object.keys(entries).sort()).toEqual(
    [
      "README.md",
      "manifest.json",
      "message-contracts.json",
      ...NAMESPACES.map((name) => `${name}.json`),
    ]
      .map((name) => `${folder}/${name}`)
      .sort(),
  );
  const manifest = JSON.parse(
    strFromU8(entries[`${folder}/manifest.json`] ?? new Uint8Array()),
  ) as Record<string, unknown>;
  expect(manifest).toMatchObject({ locale: "und", catalogVersion: "1", schemaVersion: 1 });
  expect(strFromU8(entries[`${folder}/common.json`] ?? new Uint8Array())).toBe(
    await readFile(path.join(builtin, "en", "common.json"), "utf8"),
  );
  expect(strFromU8(entries[`${folder}/README.md`] ?? new Uint8Array())).toContain(
    "pnpm locales:validate",
  );
  const zipped = path.join(directory, "standalone.zip");
  const cli = await tsx("locales-template.ts", [
    "--builtin-root",
    builtin,
    "--contracts",
    contracts,
    "--zip",
    zipped,
  ]);
  expect(cli.code).toBe(0);
  expect(await readFile(zipped)).toEqual(bytes);
});

it("scaffolds new packages only inside the working directory and never overwrites", async () => {
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const scaffold = (locale: string, out: string) =>
    tsx(
      "locales-template.ts",
      ["--builtin-root", builtin, "--locale", locale, "--out", out],
      workspace,
    );
  expect((await scaffold("de", "extensions/locales/de")).code).toBe(0);
  const manifest = JSON.parse(
    await readFile(path.join(workspace, "extensions/locales/de/manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    locale: "de",
    nativeName: "Deutsch",
    direction: "ltr",
    catalogVersion: "1",
  });
  expect((await readdir(path.join(workspace, "extensions/locales/de"))).sort()).toEqual(
    ["manifest.json", ...NAMESPACES.map((name) => `${name}.json`)].sort(),
  );
  expect((await scaffold("ar", "extensions/locales/ar")).code).toBe(0);
  expect(
    JSON.parse(await readFile(path.join(workspace, "extensions/locales/ar/manifest.json"), "utf8")),
  ).toMatchObject({ direction: "rtl" });
  const again = await scaffold("de", "extensions/locales/de");
  expect(again.code).toBe(2);
  expect(again.stderr).toContain("already exists");
  const escape = await scaffold("fr", "../escaped-fr");
  expect(escape.code).toBe(2);
  expect(escape.stderr).toContain("inside the current working directory");
  const validated = await tsx("locales-validate.ts", [
    "--builtin-root",
    builtin,
    "--external-root",
    path.join(workspace, "extensions/locales"),
    "--contracts",
    contracts,
    "--locale",
    "de",
    "--json",
  ]);
  expect(validated.code).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({
    passed: true,
    packages: [{ locale: "de", coverage: 1 }],
  });
});
