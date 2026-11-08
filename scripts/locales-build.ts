/**
 * `pnpm locales:build` — compiles validated locale packages into the shared API/web catalog bundle
 * (SA §8.1–8.2).
 *
 * Output layout (default `<repo>/locales-built`, override with `--out`):
 *   <out>/<buildId>/<tag>/<namespace>.json   compiled ICU ASTs, content-addressed and immutable
 *   <out>/registry.json                       { buildId, catalogVersion, locales: LocaleEntry[] }
 *   <out>/template-v1.zip                     translator template served at /locales/template-v1.zip
 *
 * Validation runs first; any error aborts before a single byte is written, so an invalid package
 * never replaces the installed bundle. A new build is staged in a temporary sibling directory,
 * renamed into place, and only then is `registry.json` atomically replaced (write + rename), so
 * readers always see a complete old or new bundle. The current and previous builds are kept for
 * rollback; older build directories are pruned. Hashes and buildId are deterministic.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  CATALOG_VERSION,
  LOCALE_NAMESPACES,
  localeRegistrySchema,
  type LocaleEntry,
} from "../packages/shared/src/schemas/locale.schema";
import { validateLocalePackages, validationPassed } from "./lib/locale-packages";
import { createTemplateZip, defaultSources } from "./locales-template";

const ROOT = path.resolve(__dirname, "..");

/** JSON with recursively sorted object keys, so equal content always hashes identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Hex SHA-256 of a UTF-8 string. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Canonical absolute path; a missing path is resolved but left as-is. */
async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}
/** Writes a file then renames it over the destination (atomic replace on one filesystem). */
async function atomicWrite(file: string, content: string | Uint8Array) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, file);
}

/** Validates, compiles and publishes the bundle; returns the buildId or throws on failure. */
export async function buildLocales(options: {
  builtinRoot: string;
  externalRoot: string;
  contractsFile: string;
  out: string;
  allowPseudo?: boolean;
}) {
  const result = await validateLocalePackages({
    builtinRoot: options.builtinRoot,
    externalRoot: options.externalRoot,
    contractsFile: options.contractsFile,
    allowPseudo: options.allowPseudo,
  });
  if (!validationPassed(result)) return { ok: false as const, diagnostics: result.diagnostics };

  // Compile every namespace (empty objects for namespaces a partial package does not provide).
  const sorted = [...result.packages].sort((a, b) =>
    a.manifest.locale < b.manifest.locale ? -1 : a.manifest.locale > b.manifest.locale ? 1 : 0,
  );
  const files: { tag: string; namespace: string; content: string }[] = [];
  const drafts = sorted.map((item) => ({
    item,
    namespaces: LOCALE_NAMESPACES.map((namespace) => {
      const messages = item.messages[namespace] ?? {};
      const content = canonicalJson(
        Object.fromEntries(Object.entries(messages).map(([key, message]) => [key, message.ast])),
      );
      files.push({ tag: item.manifest.locale, namespace, content });
      return { name: namespace, sha256: sha256(content) };
    }),
  }));
  const buildId = sha256(
    canonicalJson({
      catalogVersion: CATALOG_VERSION,
      locales: drafts.map(({ item, namespaces }) => ({
        manifest: item.manifest,
        coverage: item.coverage,
        namespaces,
      })),
    }),
  );
  const locales: LocaleEntry[] = drafts.map(({ item, namespaces }) => ({
    tag: item.manifest.locale,
    nativeName: item.manifest.nativeName,
    direction: item.manifest.direction,
    packageVersion: item.manifest.packageVersion,
    coverage: Math.round(item.coverage * 10_000) / 10_000,
    catalogVersion: CATALOG_VERSION,
    namespaces: namespaces.map((asset) => ({
      name: asset.name,
      url: `/locales/${buildId}/${item.manifest.locale}/${asset.name}.json`,
      sha256: asset.sha256,
    })),
  }));
  const registry = localeRegistrySchema.parse({
    buildId,
    catalogVersion: CATALOG_VERSION,
    locales,
  });

  // Stage the immutable build directory, then publish it and the registry atomically.
  await mkdir(options.out, { recursive: true });
  const finalDir = path.join(options.out, buildId);
  const exists = await readdir(finalDir).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const staging = path.join(options.out, `.staging-${randomUUID()}`);
    try {
      for (const file of files) {
        await mkdir(path.join(staging, file.tag), { recursive: true });
        await writeFile(path.join(staging, file.tag, `${file.namespace}.json`), file.content, {
          flag: "wx",
          mode: 0o644,
        });
      }
      await rename(staging, finalDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await atomicWrite(
    path.join(options.out, "template-v1.zip"),
    await createTemplateZip({
      builtinRoot: options.builtinRoot,
      contractsFile: options.contractsFile,
    }),
  );
  const registryFile = path.join(options.out, "registry.json");
  const previousId = await readFile(registryFile, "utf8").then(
    (text) => {
      const previous = JSON.parse(text) as { buildId?: unknown };
      return typeof previous.buildId === "string" ? previous.buildId : null;
    },
    () => null,
  );
  await atomicWrite(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  // Keep the active and the previous build for rollback; prune anything older.
  for (const entry of await readdir(options.out)) {
    if (!/^[a-f0-9]{64}$/u.test(entry) || entry === buildId || entry === previousId) continue;
    await rm(path.join(options.out, entry), { recursive: true, force: true });
  }
  return { ok: true as const, buildId, registry, diagnostics: result.diagnostics };
}

/** CLI entry: parse flags, build, print the buildId or the blocking diagnostics. */
async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "builtin-root": { type: "string" },
      "external-root": { type: "string" },
      contracts: { type: "string" },
      "allow-pseudo": { type: "boolean", default: false },
    },
    strict: true,
  });
  const defaults = defaultSources();
  const outcome = await buildLocales({
    builtinRoot: await canonical(values["builtin-root"] ?? defaults.builtinRoot),
    externalRoot: await canonical(values["external-root"] ?? path.join(ROOT, "extensions/locales")),
    contractsFile: await canonical(values.contracts ?? defaults.contractsFile),
    out: path.resolve(values.out ?? path.join(ROOT, "locales-built")),
    allowPseudo: values["allow-pseudo"],
  });
  if (!outcome.ok) {
    for (const item of outcome.diagnostics.filter((d) => d.severity === "error")) {
      const where = item.line ? `${item.file}:${item.line}:${item.column}` : item.file;
      process.stderr.write(`${where} error ${item.code}: ${item.message}\n`);
    }
    process.stderr.write("locales:build aborted; the installed bundle was not changed\n");
    process.exitCode = 1;
    return;
  }
  const warnings = outcome.diagnostics.length;
  process.stdout.write(
    `Built catalog ${outcome.buildId} (${outcome.registry.locales.length} locales, ${warnings} warning(s))\n`,
  );
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `locales:build failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 2;
  });
