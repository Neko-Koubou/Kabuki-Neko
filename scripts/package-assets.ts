/**
 * `pnpm exec tsx scripts/package-assets.ts` — initial packaging of the web app's legal texts and
 * static assets (TASK-115; SA §8.3 and §12, US-18/US-19/US-21).
 *
 * Verification runs first and nothing is written unless every check passes:
 *   1. Static assets (brand SVGs, the Noto Sans WOFF2) exist as regular files (no symlinks), are
 *      non-empty and size-bounded, carry the expected format (SVG markup with no active content or
 *      external references; a WOFF2 that fully decodes, maps the Latin and diacritic characters the
 *      catalogs need and has a weight axis covering 400–800) and match the SHA-256 recorded for
 *      them in THIRD-PARTY-NOTICES.md.
 *   2. The OFL text reproduced in the notices still hashes to the recorded package LICENSE.
 *   3. Every avatar style the app offers (`AVATAR_STYLES`) is installed at the version and with the
 *      LICENSE SHA-256 recorded in the notices' DiceBear section.
 *   4. Every audio source listed in docs/audio-provenance.json exists with its recorded SHA-256 and
 *      no unlisted source exists. When the generated audio directory exists (`pnpm audio:optimize`)
 *      every listed output must exist with a WebM/MP3 signature and `/audio/CREDITS.md` must be
 *      byte-identical to the source. With `--require-audio` a missing generated directory fails.
 *
 *   5. Distribution checks (TASK-174), whenever the generated audio is present:
 *      - the generated `audio-manifest.json` parses with the shared strict schema, so a legacy or
 *        stale manifest (such as the old four-URL `phases` wrapper) fails;
 *      - every descriptor has its WebM first and its MP3 fallback;
 *      - its URL set equals the provenance outputs exactly (40 variants for the 20 sources);
 *      - every WebM is an EBML WebM file carrying the Opus codec.
 *   6. Attribution: the provenance must state that the code license does not apply to the audio
 *      and must name a different asset license, which the notices also name. No license
 *      equivalence is invented.
 *   7. Locale bundle, with `--require-locales` or when either copy exists:
 *      - the API bundle (`--locales`, default `<root>/locales-built`) and the web copy
 *        (`<public>/locales`) carry a byte-identical, schema-valid registry (same buildId);
 *      - every namespace asset is present in both with its registry SHA-256;
 *      - the translator template ZIP is identical in both.
 *
 * Then the outputs are published:
 * - LICENSE and THIRD-PARTY-NOTICES.md are copied byte-for-byte to `<public>/legal/LICENSE.txt` and
 *   `<public>/legal/THIRD-PARTY-NOTICES.txt` (served at `/legal/*.txt`, the URLs returned by
 *   GET /system/about);
 * - the same two files go to `<api>/legal/`, and the generated audio manifest to
 *   `<api>/audio/audio-manifest.json`, so the API artifact ships the root legal texts and
 *   metadata matching the web audio (`--api`, default `<root>/apps/api/assets`).
 * Every directory is staged in a sibling directory, compared with its sources and swapped in, so
 * a failed run keeps the previous copies.
 *
 * Options:
 * - `--root <repo>` (default: this repository);
 * - `--public <dir>` (default `<root>/apps/web/public`);
 * - `--api <dir>`;
 * - `--locales <dir>`;
 * - `--require-audio`;
 * - `--require-locales`;
 * - `--ensure-audio`: run `pnpm audio:optimize` first when the generated audio is missing.
 *
 * The root `pnpm build` runs `pnpm build:assets` (locales:build, then this script with
 * every requirement), so a release build cannot ship without them. Exit codes: 0 packaged,
 * 1 verification failed (problems listed on stderr), 2 unexpected error.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import { AVATAR_STYLES } from "../packages/shared/src/constants/game";
import { audioManifestSchema } from "../packages/shared/src/schemas/audio.schema";
import { localeRegistrySchema } from "../packages/shared/src/schemas/locale.schema";

const ROOT = path.resolve(__dirname, "..");
const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
const AUDIO_SOURCE_DIR = "audio-assets/kabuki-neko-audio";
const PROVENANCE_FILE = "docs/audio-provenance.json";

/** Legal texts copied verbatim into `<public>/legal`. */
export const LEGAL_FILES = [
  { source: "LICENSE", target: "LICENSE.txt" },
  { source: NOTICES_FILE, target: "THIRD-PARTY-NOTICES.txt" },
] as const;

/** Committed static assets: expected format and size ceiling (bytes). */
export const STATIC_ASSETS = [
  { file: "apps/web/public/brand/logo.svg", kind: "svg", maxBytes: 64 * 1024 },
  { file: "apps/web/public/brand/mascot.svg", kind: "svg", maxBytes: 64 * 1024 },
  { file: "apps/web/public/brand/favicon.svg", kind: "svg", maxBytes: 16 * 1024 },
  { file: "apps/web/public/fonts/noto-sans-latin.woff2", kind: "woff2", maxBytes: 128 * 1024 },
] as const;

/** Inclusive integer range helper. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * Code points the Latin font must map: printable ASCII, the Latin-1 letters and punctuation used by
 * the en/id/es/fr catalogs (including NBSP, « », accented vowels, ñ, ç), Œ/œ, typographic quotes,
 * dashes, ellipsis and €. (The catalogs use U+00A0 for French spacing; U+202F is not in the upstream
 * subset and would fall back to the system font.)
 */
export const REQUIRED_FONT_CODE_POINTS: readonly number[] = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  0x152,
  0x153,
  0x2013,
  0x2014,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2026,
  0x20ac,
];

/** One failed check: the file (repository-relative where possible) and what is wrong. */
export interface Problem {
  file: string;
  message: string;
}

/** Options shared by verification and packaging. */
export interface PackageOptions {
  root: string;
  /** The web app's public directory (deployed static files). */
  publicDir: string;
  requireAudio: boolean;
  /** The API's packaged asset directory (legal texts, audio metadata); null skips it. */
  apiDir?: string | null;
  /** The API's locale bundle directory (`LOCALE_BUNDLE_PATH`); defaults to `<root>/locales-built`. */
  localesDir?: string;
  /** Fail when either locale bundle is missing. */
  requireLocales?: boolean;
}

/** Hex SHA-256 of a buffer. */
function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Error message without leaking anything but the message text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** Reads a file only if it is a regular file (symlinks, directories and devices are refused). */
async function readRegularFile(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("not a regular file (symlinks are refused)");
  return readFile(file);
}

/** Lines of `text` containing `marker`, as an array (empty when absent). */
function linesWith(text: string, marker: string): string[] {
  return text.split("\n").filter((line) => line.includes(marker));
}

/** All distinct SHA-256 hex values on the notice lines that mention `marker`. */
export function recordedSha256(notices: string, marker: string): string[] {
  const found = linesWith(notices, marker).flatMap(
    (line) => line.match(/\b[0-9a-f]{64}\b/gu) ?? [],
  );
  return [...new Set(found)];
}

/** The body of a `## <heading>` section of the notices, up to the next level-2 heading. */
export function noticesSection(notices: string, heading: string): string | undefined {
  const start = notices.indexOf(`\n## ${heading}\n`);
  if (start < 0) return undefined;
  const end = notices.indexOf("\n## ", start + 4);
  return notices.slice(start, end < 0 ? undefined : end);
}

/** Problems with an SVG file: must be an `<svg>` document with no scripts, handlers or references. */
export function svgProblems(data: Buffer): string[] {
  const text = data.toString("utf8");
  const problems: string[] = [];
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/u.test(text))
    problems.push("not an SVG document (root element must be <svg>)");
  if (!/<\/svg>\s*$/u.test(text)) problems.push("SVG document is not closed by </svg>");
  const forbidden: readonly [RegExp, string][] = [
    [/<script\b/iu, "contains <script>"],
    [/<foreignObject\b/iu, "contains <foreignObject>"],
    [/<(image|use|a|iframe|link)\b/iu, "contains an embedding or link element"],
    [/\son[a-z]+\s*=/iu, "contains an event handler attribute"],
    [/\b(xlink:)?href\s*=|\bsrc\s*=/iu, "contains an href/src reference"],
    [
      /url\s*\(|@import\b|javascript:/iu,
      "contains an external url()/@import/javascript: reference",
    ],
    [/<!(DOCTYPE|ENTITY)\b/iu, "contains a DOCTYPE/ENTITY declaration"],
  ];
  for (const [pattern, message] of forbidden) if (pattern.test(text)) problems.push(message);
  return problems;
}

/** Known table tags of the WOFF2 table directory, indexed by the 6-bit tag index (WOFF2 §5.1). */
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca",
  "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
] as const; // prettier-ignore

/** A decoded WOFF2 font: its sfnt flavor and the (possibly transformed) bytes of each table. */
export interface DecodedWoff2 {
  flavor: number;
  tables: Map<string, { data: Buffer; transformed: boolean }>;
}

/** Reads a WOFF2 UIntBase128 at `offset`; returns the value and the next offset. */
function readUIntBase128(data: Buffer, offset: number): [number, number] {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = data.readUInt8(offset + index);
    if (index === 0 && byte === 0x80) throw new Error("WOFF2 UIntBase128 has a leading zero");
    if (value > 0x1ffffff) throw new Error("WOFF2 UIntBase128 overflows 32 bits");
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset + index + 1];
  }
  throw new Error("WOFF2 UIntBase128 is longer than 5 bytes");
}

/**
 * Fully decodes a WOFF2 container (header, table directory and Brotli stream) without third-party
 * code. Throws when the signature, declared length, directory or decompressed size is inconsistent.
 */
export function decodeWoff2(file: Buffer): DecodedWoff2 {
  if (file.length < 48 || file.toString("latin1", 0, 4) !== "wOF2")
    throw new Error("not a WOFF2 file (missing wOF2 signature)");
  const flavor = file.readUInt32BE(4);
  if (flavor === 0x74746366) throw new Error("WOFF2 font collections are not supported");
  if (file.readUInt32BE(8) !== file.length) throw new Error("WOFF2 header length mismatch");
  const numTables = file.readUInt16BE(12);
  const totalCompressedSize = file.readUInt32BE(20);
  let offset = 48;
  const directory: { tag: string; length: number; transformed: boolean }[] = [];
  for (let index = 0; index < numTables; index++) {
    const flags = file.readUInt8(offset++);
    const tagIndex = flags & 0x3f;
    const version = (flags >> 6) & 0x03;
    let tag: string | undefined;
    if (tagIndex === 63) {
      tag = file.toString("latin1", offset, offset + 4);
      offset += 4;
    } else tag = WOFF2_KNOWN_TAGS[tagIndex];
    if (tag === undefined) throw new Error(`WOFF2 unknown table tag index ${tagIndex}`);
    let origLength: number;
    [origLength, offset] = readUIntBase128(file, offset);
    // glyf/loca use version 0 for the WOFF2 transform; other tables use version 0 for "none".
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    let length = origLength;
    if (transformed) [length, offset] = readUIntBase128(file, offset);
    directory.push({ tag, length, transformed });
  }
  if (offset + totalCompressedSize > file.length)
    throw new Error("WOFF2 compressed stream exceeds the file");
  const expected = directory.reduce((sum, table) => sum + table.length, 0);
  const stream = brotliDecompressSync(file.subarray(offset, offset + totalCompressedSize), {
    maxOutputLength: expected,
  });
  if (stream.length !== expected)
    throw new Error(`WOFF2 stream decodes to ${stream.length} bytes, expected ${expected}`);
  const tables = new Map<string, { data: Buffer; transformed: boolean }>();
  let position = 0;
  for (const table of directory) {
    tables.set(table.tag, {
      data: stream.subarray(position, position + table.length),
      transformed: table.transformed,
    });
    position += table.length;
  }
  return { flavor, tables };
}

/** Code points mapped to a non-zero glyph by the Unicode subtables (formats 4 and 12) of a cmap. */
export function cmapCodePoints(cmap: Buffer): Set<number> {
  const mapped = new Set<number>();
  const count = cmap.readUInt16BE(2);
  for (let index = 0; index < count; index++) {
    const platform = cmap.readUInt16BE(4 + index * 8);
    const encoding = cmap.readUInt16BE(6 + index * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const at = cmap.readUInt32BE(8 + index * 8);
    const format = cmap.readUInt16BE(at);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(at + 6);
      const ends = at + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let segment = 0; segment < segX2 / 2; segment++) {
        const end = cmap.readUInt16BE(ends + segment * 2);
        const start = cmap.readUInt16BE(starts + segment * 2);
        const delta = cmap.readUInt16BE(deltas + segment * 2);
        const rangeOffset = cmap.readUInt16BE(ranges + segment * 2);
        for (let code = start; code <= end && code !== 0xffff; code++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const raw = cmap.readUInt16BE(ranges + segment * 2 + rangeOffset + (code - start) * 2);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0) mapped.add(code);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(at + 12);
      for (let group = 0; group < groups; group++) {
        const start = cmap.readUInt32BE(at + 16 + group * 12);
        const end = Math.min(cmap.readUInt32BE(at + 20 + group * 12), 0x10ffff);
        const startGlyph = cmap.readUInt32BE(at + 24 + group * 12);
        if (end - start > 0x10000) throw new Error("cmap format 12 group is implausibly large");
        for (let code = start; code <= end; code++)
          if (startGlyph + (code - start) !== 0) mapped.add(code);
      }
    }
  }
  return mapped;
}

/** The [min, default, max] of a variation axis in an fvar table, or undefined when absent. */
export function fvarAxis(fvar: Buffer, axisTag: string): [number, number, number] | undefined {
  const axesOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  for (let index = 0; index < axisCount; index++) {
    const at = axesOffset + index * axisSize;
    if (fvar.toString("latin1", at, at + 4) !== axisTag) continue;
    const fixed = (offset: number) => fvar.readInt32BE(at + offset) / 65536;
    return [fixed(4), fixed(8), fixed(12)];
  }
  return undefined;
}

/** Problems with the Latin WOFF2: decode, required code points and a weight axis for 400–800. */
export function woff2Problems(data: Buffer): string[] {
  try {
    const font = decodeWoff2(data);
    const cmap = font.tables.get("cmap");
    if (cmap === undefined || cmap.transformed) return ["font has no plain cmap table"];
    const mapped = cmapCodePoints(cmap.data);
    const problems: string[] = [];
    const missing = REQUIRED_FONT_CODE_POINTS.filter((code) => !mapped.has(code));
    if (missing.length > 0)
      problems.push(
        `font does not map ${missing.map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}`,
      );
    const fvar = font.tables.get("fvar");
    const weight = fvar === undefined ? undefined : fvarAxis(fvar.data, "wght");
    if (weight === undefined || weight[0] > 400 || weight[2] < 800)
      problems.push("font has no wght axis covering 400–800");
    return problems;
  } catch (error) {
    return [`font does not decode: ${describe(error)}`];
  }
}

/** Verifies each static asset's type, size, content and the SHA-256 recorded in the notices. */
async function verifyStaticAssets(root: string, notices: string, problems: Problem[]) {
  for (const asset of STATIC_ASSETS) {
    let data: Buffer;
    try {
      data = await readRegularFile(path.join(root, asset.file));
    } catch (error) {
      problems.push({ file: asset.file, message: `missing or unreadable: ${describe(error)}` });
      continue;
    }
    if (data.length === 0 || data.length > asset.maxBytes)
      problems.push({
        file: asset.file,
        message: `size ${data.length} B outside 1…${asset.maxBytes} B`,
      });
    const contentProblems = asset.kind === "svg" ? svgProblems(data) : woff2Problems(data);
    for (const message of contentProblems) problems.push({ file: asset.file, message });
    const recorded = recordedSha256(notices, `\`${asset.file}\``);
    const actual = sha256(data);
    if (recorded.length !== 1 || recorded[0] !== actual)
      problems.push({
        file: asset.file,
        message: `SHA-256 ${actual} is not the single checksum recorded in ${NOTICES_FILE} (${recorded.join(", ") || "none"})`,
      });
  }
}

/** Verifies that the OFL text reproduced in the notices hashes to the recorded package LICENSE. */
function verifyFontLicense(notices: string, problems: Problem[]) {
  const section = noticesSection(notices, "Noto Sans font");
  const recorded = section
    ? /`LICENSE` file, SHA-256 `([0-9a-f]{64})`/u.exec(section)?.[1]
    : undefined;
  const text = section ? /\n```text\n([\s\S]*?)\n```\n/u.exec(section)?.[1] : undefined;
  if (recorded === undefined || text === undefined)
    problems.push({
      file: NOTICES_FILE,
      message: "Noto Sans section lacks the OFL text or its SHA-256",
    });
  else if (sha256(`${text}\n`) !== recorded)
    problems.push({
      file: NOTICES_FILE,
      message: "reproduced OFL text differs from the recorded LICENSE",
    });
}

/** Directory of the installed package `name` whose entry point is `entry`. */
async function packageRoot(entry: string, name: string): Promise<string> {
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === name) return dir;
    } catch {
      // Not a package root; keep walking up.
    }
  }
  throw new Error(`cannot locate the package root of ${name}`);
}

/** Installed version of the package at `dir`. */
async function packageVersion(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error(`${dir} has no version`);
  return manifest.version;
}

/** Verifies the DiceBear packages and the six offered styles against the notices' DiceBear table. */
async function verifyDiceBear(root: string, notices: string, problems: Problem[]) {
  const section = noticesSection(notices, "DiceBear avatar artwork");
  if (section === undefined) {
    problems.push({ file: NOTICES_FILE, message: "missing the “DiceBear avatar artwork” section" });
    return;
  }
  try {
    const webRequire = createRequire(path.join(root, "apps/web/package.json"));
    const collectionEntry = webRequire.resolve("@dicebear/collection");
    const collectionDir = await packageRoot(collectionEntry, "@dicebear/collection");
    const coreDir = await packageRoot(webRequire.resolve("@dicebear/core"), "@dicebear/core");
    for (const [name, dir] of [
      ["@dicebear/collection", collectionDir],
      ["@dicebear/core", coreDir],
    ] as const) {
      const version = await packageVersion(dir);
      if (!section.includes(`\`${name}@${version}\``))
        problems.push({
          file: NOTICES_FILE,
          message: `DiceBear section does not name ${name}@${version}`,
        });
    }
    const styleRequire = createRequire(collectionEntry);
    for (const style of AVATAR_STYLES) {
      const name = `@dicebear/${style}`;
      const dir = await packageRoot(styleRequire.resolve(name), name);
      const version = await packageVersion(dir);
      const license = sha256(await readRegularFile(path.join(dir, "LICENSE")));
      const rows = linesWith(section, `\`${name}@${version}\``);
      if (rows.length !== 1 || !rows[0]?.includes(license))
        problems.push({
          file: NOTICES_FILE,
          message: `DiceBear row for ${name}@${version} with LICENSE SHA-256 ${license} not found`,
        });
    }
  } catch (error) {
    problems.push({
      file: "apps/web",
      message: `DiceBear packages unavailable: ${describe(error)}`,
    });
  }
}

/** Minimal shape of docs/audio-provenance.json used here. */
interface ProvenanceEntry {
  path: string;
  sha256: string;
  outputs: string[];
}

/** Validates the provenance JSON shape; returns its entries or throws. */
function provenanceEntries(json: unknown): ProvenanceEntry[] {
  const files = (json as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new Error("provenance has no files array");
  return files.map((entry: unknown, index) => {
    const { path: file, sha256: hash, outputs } = entry as Record<string, unknown>;
    const validPath = typeof file === "string" && /^0[1-5]-[a-z]+\/[a-z0-9-]+\.mp3$/u.test(file);
    const validOutputs =
      Array.isArray(outputs) &&
      outputs.length > 0 &&
      outputs.every(
        (o) => typeof o === "string" && /^\/audio\/0[1-5]-[a-z]+\/[a-z0-9-]+\.(webm|mp3)$/u.test(o),
      );
    if (!validPath || typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash) || !validOutputs)
      throw new Error(`provenance entry ${index} is malformed`);
    return { path: file, sha256: hash, outputs: outputs as string[] };
  });
}

/** True when the first bytes carry the container signature expected for the extension. */
function audioSignatureMatches(file: string, head: Buffer): boolean {
  if (file.endsWith(".webm")) return head.readUInt32BE(0) === 0x1a45dfa3;
  return (
    head.toString("latin1", 0, 3) === "ID3" ||
    (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)
  );
}

/** Reads the first `bytes` bytes of a regular file. */
async function readHead(file: string, bytes: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("not a regular file (symlinks are refused)");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every `src` URL of a parsed manifest, with the descriptor path it came from. */
function manifestSources(manifest: unknown): { at: string; src: string[] }[] {
  const found: { at: string; src: string[] }[] = [];
  const walk = (value: unknown, at: string) => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record["src"])) found.push({ at, src: record["src"] as string[] });
      else
        for (const [key, inner] of Object.entries(record)) walk(inner, at ? `${at}.${key}` : key);
    }
  };
  walk(manifest, "");
  return found;
}

/**
 * The generated manifest must be the current one: schema-valid (legacy or stale shapes fail),
 * WebM first with an MP3 fallback for every cue, exactly the provenance outputs, and every WebM
 * an EBML file declaring the Opus codec.
 */
async function verifyManifest(file: string, entries: ProvenanceEntry[], problems: Problem[]) {
  let manifest: unknown;
  try {
    manifest = JSON.parse((await readRegularFile(file)).toString("utf8"));
  } catch (error) {
    problems.push({ file, message: `missing or unreadable: ${describe(error)}` });
    return;
  }
  const parsed = audioManifestSchema.safeParse(manifest);
  if (!parsed.success)
    problems.push({
      file,
      message: `stale or legacy manifest (schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.path.join(".") || issue.message)
        .join(", ")}); run pnpm audio:optimize`,
    });
  const listed = new Set<string>();
  for (const { at, src } of manifestSources(manifest)) {
    if (src.length !== 2 || !src[0]?.endsWith(".webm") || !src[1]?.endsWith(".mp3"))
      problems.push({ file, message: `${at} needs a WebM source and an MP3 fallback` });
    for (const url of src) listed.add(url);
  }
  const expected = new Set(entries.flatMap((entry) => entry.outputs));
  for (const url of listed)
    if (!expected.has(url))
      problems.push({ file, message: `${url} is not an output of docs/audio-provenance.json` });
  for (const url of expected)
    if (!listed.has(url)) problems.push({ file, message: `${url} is missing from the manifest` });
  const root = path.dirname(path.dirname(file));
  for (const url of expected) {
    if (!url.endsWith(".webm")) continue;
    try {
      const head = await readHead(path.join(root, url), 4096);
      if (!head.includes(Buffer.from("webm")) || !head.includes(Buffer.from("A_OPUS")))
        problems.push({ file: url, message: "not a WebM file with the Opus codec" });
    } catch {
      // Missing outputs are reported by the output check.
    }
  }
}

/**
 * Attribution: the code license must not be presented as covering the audio, and the separate
 * asset license must be named both in the provenance and in the notices.
 */
async function verifyAttribution(root: string, notices: string, problems: Problem[]) {
  try {
    const provenance = JSON.parse(await readFile(path.join(root, PROVENANCE_FILE), "utf8")) as {
      codeLicense?: { appliesToAudio?: unknown; name?: unknown };
      assetLicense?: { name?: unknown };
    };
    const asset = provenance.assetLicense?.name;
    if (provenance.codeLicense?.appliesToAudio !== false)
      problems.push({
        file: PROVENANCE_FILE,
        message:
          "codeLicense.appliesToAudio must be false: the code license does not cover the audio",
      });
    if (typeof asset !== "string" || asset.length === 0 || asset === provenance.codeLicense?.name)
      problems.push({
        file: PROVENANCE_FILE,
        message: "assetLicense must name the audio's own license",
      });
    else if (!notices.includes(asset))
      problems.push({ file: NOTICES_FILE, message: `does not name the audio license “${asset}”` });
  } catch (error) {
    problems.push({ file: PROVENANCE_FILE, message: `unreadable: ${describe(error)}` });
  }
}

/**
 * The API bundle and the web copy must be the same build: identical registry (schema-valid),
 * every namespace asset present in both with its SHA-256, and the same translator template.
 */
async function verifyLocales(options: PackageOptions, problems: Problem[]): Promise<string> {
  const api = options.localesDir ?? path.join(options.root, "locales-built");
  const web = path.join(options.publicDir, "locales");
  const present = await Promise.all(
    [api, web].map((dir) =>
      lstat(path.join(dir, "registry.json")).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (!options.requireLocales && !present.some(Boolean)) return "locale bundle not present";
  let registry: { buildId: string; locales: { namespaces: { url: string; sha256: string }[] }[] };
  try {
    const [apiText, webText] = await Promise.all(
      [api, web].map(async (dir) => readRegularFile(path.join(dir, "registry.json"))),
    );
    if (!apiText?.equals(webText ?? Buffer.alloc(0)))
      problems.push({
        file: path.join(web, "registry.json"),
        message: "web and API locale registries differ (unmatched buildId); run pnpm locales:build",
      });
    registry = localeRegistrySchema.parse(JSON.parse(apiText?.toString("utf8") ?? "null"));
  } catch (error) {
    problems.push({ file: api, message: `locale bundle missing or invalid: ${describe(error)}` });
    return "locale bundle invalid";
  }
  let assets = 0;
  for (const locale of registry.locales)
    for (const asset of locale.namespaces) {
      const relative = asset.url.replace(/^\/locales\//u, "");
      for (const dir of [api, web]) {
        const file = path.join(dir, relative);
        try {
          if (sha256(await readRegularFile(file)) !== asset.sha256)
            problems.push({ file, message: "SHA-256 differs from the locale registry" });
        } catch (error) {
          problems.push({ file, message: `missing or unreadable: ${describe(error)}` });
        }
      }
      assets++;
    }
  try {
    const [apiZip, webZip] = await Promise.all(
      [api, web].map((dir) => readRegularFile(path.join(dir, "template-v1.zip"))),
    );
    if (!apiZip?.equals(webZip ?? Buffer.alloc(0)))
      problems.push({
        file: path.join(web, "template-v1.zip"),
        message: "differs from the API copy",
      });
  } catch (error) {
    problems.push({
      file: "template-v1.zip",
      message: `missing or unreadable: ${describe(error)}`,
    });
  }
  return `locale bundle ${registry.buildId.slice(0, 12)}: ${registry.locales.length} locales, ${assets} assets in both API and web`;
}

/** Verifies audio sources against provenance and, when generated, the published outputs. */
async function verifyAudio(options: PackageOptions, problems: Problem[]): Promise<string> {
  let entries: ProvenanceEntry[];
  try {
    entries = provenanceEntries(
      JSON.parse(await readFile(path.join(options.root, PROVENANCE_FILE), "utf8")),
    );
  } catch (error) {
    problems.push({ file: PROVENANCE_FILE, message: describe(error) });
    return "audio provenance unreadable";
  }
  const sourceRoot = path.join(options.root, AUDIO_SOURCE_DIR);
  const listed = new Set(entries.map((entry) => entry.path));
  try {
    for (const folder of await readdir(sourceRoot, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const item of await readdir(path.join(sourceRoot, folder.name)))
        if (item.endsWith(".mp3") && !listed.has(`${folder.name}/${item}`))
          problems.push({
            file: `${AUDIO_SOURCE_DIR}/${folder.name}/${item}`,
            message: "source has no provenance entry",
          });
    }
  } catch (error) {
    problems.push({ file: AUDIO_SOURCE_DIR, message: `cannot list sources: ${describe(error)}` });
  }
  for (const entry of entries) {
    const file = `${AUDIO_SOURCE_DIR}/${entry.path}`;
    try {
      if (sha256(await readRegularFile(path.join(options.root, file))) !== entry.sha256)
        problems.push({ file, message: "SHA-256 differs from docs/audio-provenance.json" });
    } catch (error) {
      problems.push({ file, message: `missing or unreadable: ${describe(error)}` });
    }
  }
  const generated = path.join(options.publicDir, "audio");
  const exists = await lstat(generated).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists) {
    if (options.requireAudio)
      problems.push({
        file: generated,
        message: "generated audio missing; run pnpm audio:optimize",
      });
    return `${entries.length} audio sources verified; generated audio not present`;
  }
  let outputs = 0;
  for (const entry of entries)
    for (const output of entry.outputs) {
      const file = path.join(options.publicDir, output);
      try {
        if (!audioSignatureMatches(output, await readHead(file, 4)))
          problems.push({ file, message: "audio signature does not match its extension" });
        outputs++;
      } catch (error) {
        problems.push({ file, message: `missing or unreadable: ${describe(error)}` });
      }
    }
  await verifyManifest(path.join(generated, "audio-manifest.json"), entries, problems);
  for (const [file, check] of [
    [path.join(generated, "audio-manifest.json"), null],
    [path.join(generated, "CREDITS.md"), path.join(sourceRoot, "CREDITS.md")],
  ] as const) {
    try {
      const data = await readRegularFile(file);
      if (check !== null && !data.equals(await readRegularFile(check)))
        problems.push({ file, message: "differs from the source CREDITS.md" });
    } catch (error) {
      problems.push({ file, message: `missing or unreadable: ${describe(error)}` });
    }
  }
  return `${entries.length} audio sources and ${outputs} generated outputs verified`;
}

/** Runs every verification; returns the problems and a human-readable summary. */
export async function verifyAssets(
  options: PackageOptions,
): Promise<{ problems: Problem[]; summary: string[] }> {
  const problems: Problem[] = [];
  const summary: string[] = [];
  let notices = "";
  // The legal sources must exist and be non-empty before anything is packaged.
  for (const legal of LEGAL_FILES) {
    try {
      const data = await readRegularFile(path.join(options.root, legal.source));
      if (data.length === 0) problems.push({ file: legal.source, message: "legal text is empty" });
      if (legal.source === NOTICES_FILE) notices = data.toString("utf8");
    } catch (error) {
      problems.push({ file: legal.source, message: `missing or unreadable: ${describe(error)}` });
    }
  }
  await verifyStaticAssets(options.root, notices, problems);
  summary.push(`${STATIC_ASSETS.length} static assets checked against ${NOTICES_FILE}`);
  verifyFontLicense(notices, problems);
  await verifyDiceBear(options.root, notices, problems);
  summary.push(`${AVATAR_STYLES.length} DiceBear styles checked`);
  summary.push(await verifyAudio(options, problems));
  await verifyAttribution(options.root, notices, problems);
  summary.push(await verifyLocales(options, problems));
  return { problems, summary };
}

/**
 * Publishes `files` (name → source) as the directory `target` through a staging directory: each
 * copy is compared with its source, then the directory is swapped in. The previous directory
 * survives any failure.
 */
async function publishDirectory(target: string, files: { name: string; source: string }[]) {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(target)}.staging-${randomUUID()}`);
  const previous = path.join(parent, `.${path.basename(target)}.previous-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const source = await readRegularFile(file.source);
      if (source.length === 0) throw new Error(`${file.source} is empty`);
      const copy = path.join(staging, file.name);
      await writeFile(copy, source, { flag: "wx" });
      if (!(await readFile(copy)).equals(source))
        throw new Error(`${file.name} copy differs from its source`);
    }
    const hadPrevious = await lstat(target).then(
      () => true,
      () => false,
    );
    if (hadPrevious) await rename(target, previous);
    try {
      await rename(staging, target);
    } catch (error) {
      if (hadPrevious) await rename(previous, target);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
    return files.map((file) => path.join(target, file.name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Copies the legal texts into `<public>/legal` (and `<api>/legal` when packaging the API). */
export async function packageLegal(options: PackageOptions): Promise<string[]> {
  const legal = LEGAL_FILES.map((item) => ({
    name: item.target,
    source: path.join(options.root, item.source),
  }));
  const written = await publishDirectory(path.join(options.publicDir, "legal"), legal);
  if (options.apiDir)
    written.push(...(await publishDirectory(path.join(options.apiDir, "legal"), legal)));
  return written;
}

/** Copies the generated audio manifest into `<api>/audio` so the API metadata matches the web. */
export async function packageApiAudio(options: PackageOptions): Promise<string[]> {
  const manifest = path.join(options.publicDir, "audio", "audio-manifest.json");
  const present = await lstat(manifest).then(
    () => true,
    () => false,
  );
  if (!options.apiDir || !present) return [];
  return publishDirectory(path.join(options.apiDir, "audio"), [
    { name: "audio-manifest.json", source: manifest },
  ]);
}

/** Runs `pnpm audio:optimize` (scripts/optimize-audio.mjs) for `root` into `<public>/audio`. */
function optimizeAudio(options: PackageOptions) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts/optimize-audio.mjs"),
      "--source",
      path.join(options.root, AUDIO_SOURCE_DIR),
      "--out",
      path.join(options.publicDir, "audio"),
    ],
    { stdio: "inherit" },
  );
}

/** CLI entry: verify, then package the legal texts and API metadata; exit 1 on any problem. */
async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      public: { type: "string" },
      api: { type: "string" },
      locales: { type: "string" },
      "require-audio": { type: "boolean", default: false },
      "require-locales": { type: "boolean", default: false },
      "ensure-audio": { type: "boolean", default: false },
    },
  });
  const root = path.resolve(values.root ?? ROOT);
  const options: PackageOptions = {
    root,
    publicDir: path.resolve(values.public ?? path.join(root, "apps/web/public")),
    requireAudio: values["require-audio"],
    apiDir: path.resolve(values.api ?? path.join(root, "apps/api/assets")),
    localesDir: path.resolve(values.locales ?? path.join(root, "locales-built")),
    requireLocales: values["require-locales"],
  };
  if (values["ensure-audio"]) {
    const generated = await lstat(
      path.join(options.publicDir, "audio", "audio-manifest.json"),
    ).then(
      () => true,
      () => false,
    );
    if (!generated) optimizeAudio(options);
  }
  const { problems, summary } = await verifyAssets(options);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem.file}: ${problem.message}\n`);
    process.stderr.write(
      `package-assets: ${problems.length} problem(s); packaged copies were not changed\n`,
    );
    process.exitCode = 1;
    return;
  }
  const written = [...(await packageLegal(options)), ...(await packageApiAudio(options))];
  for (const line of summary) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `Packaged: ${written.map((file) => path.relative(root, file)).join(", ")}\n`,
  );
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(`package-assets failed: ${describe(error)}\n`);
    process.exitCode = 2;
  });
