/**
 * `pnpm locales:template` — scaffolds a new source locale package and builds the downloadable
 * translator template (SA §8.2).
 *
 * Usage:
 *   pnpm locales:template --locale <tag> --out <dir>      # e.g. --locale de --out extensions/locales/de
 *   pnpm locales:template --zip <file>                    # writes template-v1.zip
 *   (optional) --builtin-root <dir> --contracts <file>
 *
 * The scaffold copies the complete built-in `en` source as the starting point and writes a manifest
 * for the requested tag (native name/direction from Intl). `--out` must stay inside the current
 * working directory and must not exist yet, so the tool never overwrites or escapes the workspace.
 * This is a source workflow: packages are validated and compiled at build time, never uploaded at
 * runtime.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  CATALOG_VERSION,
  LOCALE_NAMESPACES,
  localeManifestSchema,
} from "../packages/shared/src/schemas/locale.schema";

const ROOT = path.resolve(__dirname, "..");
const ZIP_FOLDER = "kabuki-neko-locale-template-v1";
/** Fixed timestamp so the template ZIP is byte-for-byte reproducible. */
const ZIP_MTIME = new Date("2026-01-01T00:00:00Z");

/** Default source locations inside the repository. */
export function defaultSources() {
  return {
    builtinRoot: path.join(ROOT, "packages/shared/locales"),
    contractsFile: path.join(ROOT, "packages/shared/locales/message-contracts.json"),
  };
}
/** Reads the twelve `en` namespace sources verbatim (they are validated by the build first). */
async function englishSources(builtinRoot: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const namespace of LOCALE_NAMESPACES) {
    const file = path.join(builtinRoot, "en", `${namespace}.json`);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`en/${namespace}.json must be a regular file`);
    files[`${namespace}.json`] = await readFile(file, "utf8");
  }
  return files;
}
/** Manifest for a new package: canonical tag, Intl native name and script direction. */
export function scaffoldManifest(tag: string) {
  const [canonical] = Intl.getCanonicalLocales(tag);
  if (!canonical) throw new Error("Invalid locale tag");
  const locale = new Intl.Locale(canonical);
  const info = (
    locale as Intl.Locale & { getTextInfo?: () => { direction?: string } }
  ).getTextInfo?.();
  const nativeName =
    new Intl.DisplayNames([canonical], { type: "language" }).of(canonical) ?? canonical;
  return localeManifestSchema.parse({
    schemaVersion: 1,
    locale: canonical,
    nativeName,
    direction: info?.direction === "rtl" ? "rtl" : "ltr",
    packageVersion: "0.1.0",
    catalogVersion: CATALOG_VERSION,
    credits: [],
  });
}
/** Resolves `--out` and refuses paths outside `cwd`, existing targets and symlinked parents. */
async function confinedOutput(out: string, cwd: string): Promise<string> {
  const base = await realpath(cwd);
  const target = path.resolve(base, out);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("--out must be a new directory inside the current working directory");
  let parent = path.dirname(target);
  while (parent !== base) {
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("--out must not traverse links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    parent = path.dirname(parent);
  }
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
  throw new Error("--out already exists; refusing to overwrite");
}
/** Creates `<out>/manifest.json` plus the twelve en namespace files for translation. */
export async function scaffoldPackage(options: {
  locale: string;
  out: string;
  builtinRoot: string;
  cwd?: string;
}): Promise<string> {
  const manifest = scaffoldManifest(options.locale);
  const target = await confinedOutput(options.out, options.cwd ?? process.cwd());
  const sources = await englishSources(options.builtinRoot);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  for (const [name, content] of Object.entries(sources))
    await writeFile(path.join(target, name), content, { flag: "wx" });
  return target;
}
/** Translator guide placed in the ZIP root. */
function readme(): string {
  return [
    "# Kabuki Neko locale template (catalog version 1)",
    "",
    "1. Copy this folder to `extensions/locales/<tag>/` (for example `extensions/locales/de/`).",
    '2. Edit `manifest.json`: set `locale` to the BCP 47 tag, `nativeName`, `direction` ("ltr" or "rtl"), `packageVersion` and optional `credits`.',
    "3. Translate the values in every `<namespace>.json`. Keep keys unchanged and keep every `{placeholder}` from `message-contracts.json`; plural/select need an `other` branch. Markup/HTML is not allowed.",
    "4. Run `pnpm locales:validate --locale <tag>`, then `pnpm locales:build` and `pnpm build`, and restart both containers.",
    "",
    "Missing keys fall back to English. See docs/localization.md for install, rollback and removal.",
    "",
  ].join("\n");
}
/**
 * Builds the translator ZIP: placeholder manifest (`und` must be replaced), the en sources, the
 * message contracts (descriptions and placeholders) and a README. Deterministic byte output.
 */
export async function createTemplateZip(options: {
  builtinRoot: string;
  contractsFile: string;
}): Promise<Uint8Array> {
  const manifest = {
    schemaVersion: 1,
    locale: "und",
    nativeName: "Native language name",
    direction: "ltr",
    packageVersion: "0.1.0",
    catalogVersion: CATALOG_VERSION,
    credits: [],
  };
  const files: Zippable = {
    [`${ZIP_FOLDER}/README.md`]: [strToU8(readme()), { mtime: ZIP_MTIME }],
    [`${ZIP_FOLDER}/manifest.json`]: [
      strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      { mtime: ZIP_MTIME },
    ],
    [`${ZIP_FOLDER}/message-contracts.json`]: [
      strToU8(await readFile(options.contractsFile, "utf8")),
      { mtime: ZIP_MTIME },
    ],
  };
  for (const [name, content] of Object.entries(await englishSources(options.builtinRoot)))
    files[`${ZIP_FOLDER}/${name}`] = [strToU8(content), { mtime: ZIP_MTIME }];
  return zipSync(files, { level: 9, mtime: ZIP_MTIME });
}

/** CLI entry: either scaffold a package (`--locale` + `--out`) or write the ZIP (`--zip`). */
async function main() {
  const { values } = parseArgs({
    options: {
      locale: { type: "string" },
      out: { type: "string" },
      zip: { type: "string" },
      "builtin-root": { type: "string" },
      contracts: { type: "string" },
    },
    strict: true,
  });
  const defaults = defaultSources();
  const builtinRoot = path.resolve(values["builtin-root"] ?? defaults.builtinRoot);
  if (values.zip) {
    const bytes = await createTemplateZip({
      builtinRoot,
      contractsFile: path.resolve(values.contracts ?? defaults.contractsFile),
    });
    await writeFile(path.resolve(values.zip), bytes);
    process.stdout.write(`Wrote ${path.resolve(values.zip)} (${bytes.byteLength} bytes)\n`);
    return;
  }
  if (!values.locale || !values.out)
    throw new Error("Use --locale <tag> --out <dir> or --zip <file>");
  const target = await scaffoldPackage({ locale: values.locale, out: values.out, builtinRoot });
  process.stdout.write(`Created ${target}\n`);
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `locales:template failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 2;
  });
