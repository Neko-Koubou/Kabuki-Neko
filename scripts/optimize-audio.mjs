#!/usr/bin/env node
/**
 * `pnpm audio:optimize` — converts the supplied audio pack into the dual-format web audio set
 * (Audio revision 2026-10-31 §Optimization and output contract; TASK-114).
 *
 * Input: `audio-assets/kabuki-neko-audio/` (override `--source`) with the five phase folders
 * `01-lobby` … `05-sfx` holding MP3 files plus `CREDITS.md`. Output: `apps/web/public/audio/`
 * (override `--out`), a generated, git-ignored directory mirroring the subfolders with, for every
 * input, an Opus `.webm` (96 kbps VBR, first source) and an MP3 (LAME 128 kbps, second source),
 * a byte-identical `CREDITS.md` and the generated `audio-manifest.json`.
 *
 * Rules:
 * - Lobby is dynamic (any number ≥ 1 of `bgm-lobby-<id>.mp3`); every thinking/leaderboard/podium
 *   cue and all ten SFX are required. Symlinks, unsafe or case-colliding names, unexpected files
 *   and missing cues stop the run with a clear error before anything is encoded.
 * - BGM is loudness-normalized (`loudnorm=I=-16:TP=-1.5:LRA=11`) identically in both encodings;
 *   SFX keep their transients (no normalization). Nothing is shortened.
 * - ffmpeg/ffprobe run with fixed argument arrays and no shell; there is no network access.
 * - Everything is written to a staging directory, every output is probed (codec, duration close
 *   to the source) and fully decoded, the manifest is validated with the shared schema, and only
 *   then is the staging directory swapped in for the old output. A failure leaves the previous
 *   output untouched and removes the staging directory; stale files never survive a re-run.
 * - Source files are only read, never modified. Real byte savings are measured and printed.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Phase folders, in manifest order (mirrors AUDIO_PHASE_FOLDERS in @kabuki-neko/shared). */
export const PHASE_FOLDERS = ["01-lobby", "02-thinking", "03-leaderboard", "04-podium", "05-sfx"];
/** Safe kebab-case MP3 source filename. */
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/u;
/** BGM loudness target applied to both encodings. */
export const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";
/** Allowed duration drift between a source and its encodings (seconds + relative). */
const DURATION_TOLERANCE = { absolute: 0.3, relative: 0.01 };

/** Required non-lobby cues: folder → manifest key → source basename (without .mp3). */
const REQUIRED = {
  "02-thinking": {
    sprint: "bgm-think-sprint",
    standard: "bgm-think-standard",
    puzzle: "bgm-think-puzzle",
  },
  "03-leaderboard": { groove: "bgm-leaderboard-groove" },
  "04-podium": { buildup: "bgm-podium-buildup", victory: "bgm-podium-victory" },
  "05-sfx": {
    hyoshigiStart: "sfx-hyoshigi-start",
    nekoPop: "sfx-neko-pop",
    questionWhoosh: "sfx-question-whoosh",
    tickLast5s: "sfx-tick-last5s",
    timeupGong: "sfx-timeup-gong",
    revealBar: "sfx-reveal-bar",
    answerCorrect: "sfx-answer-correct",
    answerWrong: "sfx-answer-wrong",
    streakFire: "sfx-streak-fire",
    podiumSpotlight: "sfx-podium-spotlight",
  },
};
/** Known lobby tracks (label, default volume); other IDs get a readable fallback label. */
const LOBBY_METADATA = {
  kabuki: { label: "Kabuki Matsuri", volume: 0.7 },
  neko8bit: { label: "Neko 8-Bit Arcade", volume: 0.7 },
  showtime: { label: "Showtime Funk", volume: 0.7 },
  matcha: { label: "Matcha Chill Lo-Fi", volume: 0.65 },
};
/** Manifest default volumes (Audio revision; victory playback override lives in the engine). */
const VOLUMES = {
  lobby: 0.7,
  thinking: { sprint: 0.8, standard: 0.75, puzzle: 0.7 },
  leaderboard: { groove: 0.75 },
  podium: { buildup: 0.85, victory: 0.9 },
  sfx: {
    hyoshigiStart: 1,
    nekoPop: 0.8,
    questionWhoosh: 0.9,
    tickLast5s: 0.95,
    timeupGong: 1,
    revealBar: 0.85,
    answerCorrect: 0.9,
    answerWrong: 0.85,
    streakFire: 0.95,
    podiumSpotlight: 1,
  },
};

/** Error with a user-facing message (printed without a stack). */
export class AudioPipelineError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AudioPipelineError";
  }
}

/**
 * Lists and classifies the MP3 sources. Rejects symlinked folders/files, unsafe names, names
 * colliding case-insensitively, unexpected files and missing required cues.
 * @param {string} sourceDir
 * @returns {Promise<{ folder: string; base: string; file: string; kind: "bgm" | "sfx"; key: string }[]>}
 */
export async function scanSources(sourceDir) {
  const problems = [];
  const entries = [];
  const root = await lstat(sourceDir).catch(() => null);
  if (!root?.isDirectory())
    throw new AudioPipelineError(`Audio source directory not found: ${sourceDir}`);
  for (const folder of PHASE_FOLDERS) {
    const dir = path.join(sourceDir, folder);
    const info = await lstat(dir).catch(() => null);
    if (!info) {
      problems.push(`missing folder ${folder}/`);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      problems.push(`${folder}/ must be a real directory (symlinks are rejected)`);
      continue;
    }
    const seen = new Map();
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const item = await lstat(file);
      if (item.isSymbolicLink()) {
        problems.push(`${folder}/${name} is a symlink`);
        continue;
      }
      if (!name.toLowerCase().endsWith(".mp3")) {
        problems.push(`${folder}/${name} is not an MP3 source`);
        continue;
      }
      if (!item.isFile()) {
        problems.push(`${folder}/${name} is not a regular file`);
        continue;
      }
      if (!SAFE_NAME.test(name)) {
        problems.push(`${folder}/${name} has an unsafe name (use lowercase kebab-case .mp3)`);
        continue;
      }
      const folded = name.toLowerCase();
      if (seen.has(folded)) problems.push(`${folder}/${name} collides with ${seen.get(folded)}`);
      seen.set(folded, name);
      const base = name.slice(0, -4);
      if (folder === "01-lobby") {
        const id = /^bgm-lobby-([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(base)?.[1];
        if (!id || id === "random")
          problems.push(`${folder}/${name} must be named bgm-lobby-<id>.mp3`);
        else entries.push({ folder, base, file, kind: "bgm", key: id });
        continue;
      }
      const key = Object.entries(REQUIRED[folder]).find(([, value]) => value === base)?.[0];
      if (!key) problems.push(`${folder}/${name} is not a known cue for this folder`);
      else entries.push({ folder, base, file, kind: folder === "05-sfx" ? "sfx" : "bgm", key });
    }
  }
  if (!entries.some((entry) => entry.folder === "01-lobby"))
    problems.push("01-lobby/ needs at least one bgm-lobby-<id>.mp3 track");
  for (const [folder, cues] of Object.entries(REQUIRED))
    for (const [key, base] of Object.entries(cues))
      if (!entries.some((entry) => entry.folder === folder && entry.key === key))
        problems.push(`missing required cue ${folder}/${base}.mp3`);
  if (problems.length)
    throw new AudioPipelineError(`Invalid audio source:\n- ${problems.join("\n- ")}`);
  return entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Readable fallback label for an unknown lobby ID (`neo-tokyo` → `Neo Tokyo`). */
export function lobbyLabel(id) {
  return (
    LOBBY_METADATA[id]?.label ??
    id
      .split("-")
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/**
 * Builds the output manifest (no `phases` wrapper): root keys lobby/thinking/leaderboard/podium/
 * sfx; every descriptor has `src: [webm, mp3]` and a volume; all BGM loop. Lobby keeps the stable
 * source order (sorted filenames) and carries id + label; nekoPop has its 150 ms throttle.
 * @param {{ folder: string; base: string; kind: string; key: string }[]} entries
 */
export function buildManifest(entries) {
  const src = (entry) => [
    `/audio/${entry.folder}/${entry.base}.webm`,
    `/audio/${entry.folder}/${entry.base}.mp3`,
  ];
  const find = (folder, key) =>
    entries.find((entry) => entry.folder === folder && entry.key === key);
  const bgm = (folder, key, volume) => ({ src: src(find(folder, key)), loop: true, volume });
  const manifest = {
    lobby: entries
      .filter((entry) => entry.folder === "01-lobby")
      .map((entry) => ({
        id: entry.key,
        label: lobbyLabel(entry.key),
        src: src(entry),
        loop: true,
        volume: LOBBY_METADATA[entry.key]?.volume ?? VOLUMES.lobby,
      })),
    thinking: Object.fromEntries(
      Object.entries(VOLUMES.thinking).map(([key, volume]) => [
        key,
        bgm("02-thinking", key, volume),
      ]),
    ),
    leaderboard: { groove: bgm("03-leaderboard", "groove", VOLUMES.leaderboard.groove) },
    podium: Object.fromEntries(
      Object.entries(VOLUMES.podium).map(([key, volume]) => [key, bgm("04-podium", key, volume)]),
    ),
    sfx: Object.fromEntries(
      Object.entries(VOLUMES.sfx).map(([key, volume]) => [
        key,
        {
          src: src(find("05-sfx", key)),
          volume,
          ...(key === "nekoPop" ? { throttleMs: 150 } : {}),
        },
      ]),
    ),
  };
  return manifest;
}

/**
 * Fixed ffmpeg argument arrays for one input: Opus 96 kbps VBR in WebM (48 kHz) and LAME
 * 128 kbps MP3. BGM gets the same loudnorm filter in both; metadata and cover art are dropped.
 */
export function encoderArgs(input, output, format, kind) {
  const common = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-map_metadata",
    "-1",
    "-vn",
  ];
  const filter = kind === "bgm" ? ["-af", LOUDNORM] : [];
  const codec =
    format === "webm"
      ? ["-c:a", "libopus", "-b:a", "96k", "-vbr", "on", "-ar", "48000", "-f", "webm"]
      : ["-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-f", "mp3"];
  return [...common, ...filter, ...codec, output];
}

/** Checks that ffmpeg (with libopus and libmp3lame) and ffprobe are available. */
async function checkPrerequisites(ffmpeg, ffprobe) {
  let encoders;
  try {
    encoders = (await run(ffmpeg, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 })).stdout;
    await run(ffprobe, ["-version"]);
  } catch {
    throw new AudioPipelineError(
      `ffmpeg and ffprobe are required (looked for "${ffmpeg}" and "${ffprobe}"); install FFmpeg with libopus and libmp3lame`,
    );
  }
  for (const encoder of ["libopus", "libmp3lame"])
    if (!new RegExp(`\\b${encoder}\\b`, "u").test(encoders))
      throw new AudioPipelineError(
        `ffmpeg was built without ${encoder}; install a build that includes it`,
      );
}

/** Probes codec and duration of an audio file. */
async function probe(ffprobe, file) {
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name:format=duration",
    "-of",
    "json",
    file,
  ]);
  const data = JSON.parse(stdout);
  return { codec: data.streams?.[0]?.codec_name ?? null, duration: Number(data.format?.duration) };
}

/** Encodes and validates one source into both formats inside the staging directory. */
async function convert(entry, staging, tools) {
  const source = await probe(tools.ffprobe, entry.file).catch(() => ({
    codec: null,
    duration: Number.NaN,
  }));
  if (!Number.isFinite(source.duration) || source.duration <= 0)
    throw new AudioPipelineError(`${entry.folder}/${entry.base}.mp3 is not a readable audio file`);
  const results = [];
  for (const [format, codec] of [
    ["webm", "opus"],
    ["mp3", "mp3"],
  ]) {
    const output = path.join(staging, entry.folder, `${entry.base}.${format}`);
    try {
      await run(tools.ffmpeg, encoderArgs(entry.file, output, format, entry.kind), {
        maxBuffer: 8 << 20,
      });
      const encoded = await probe(tools.ffprobe, output);
      const drift = Math.abs(encoded.duration - source.duration);
      if (encoded.codec !== codec) throw new Error(`codec ${encoded.codec}, expected ${codec}`);
      if (!(drift <= DURATION_TOLERANCE.absolute + DURATION_TOLERANCE.relative * source.duration))
        throw new Error(`duration ${encoded.duration}s differs from source ${source.duration}s`);
      const decoded = await run(tools.ffmpeg, [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        output,
        "-f",
        "null",
        "-",
      ]);
      if (decoded.stderr.trim()) throw new Error("decode reported errors");
      results.push({ format, bytes: (await stat(output)).size, duration: encoded.duration });
    } catch (error) {
      throw new AudioPipelineError(
        `Conversion failed for ${entry.folder}/${entry.base}.mp3 → ${format}: ${error instanceof AudioPipelineError ? error.message : error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`,
      );
    }
  }
  return {
    entry,
    sourceBytes: (await stat(entry.file)).size,
    sourceDuration: source.duration,
    results,
  };
}

/** Runs `worker` over `items` with at most `limit` in flight; rejects on the first failure. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Validates the manifest with the shared schema (requires the built @kabuki-neko/shared). */
async function validateManifest(manifest) {
  const schemaFile = path.join(ROOT, "packages/shared/dist/schemas/audio.schema.js");
  let schema;
  try {
    ({ audioManifestSchema: schema } = await import(schemaFile));
  } catch {
    throw new AudioPipelineError(
      "Build @kabuki-neko/shared first (pnpm --filter @kabuki-neko/shared build)",
    );
  }
  const parsed = schema.safeParse(manifest);
  if (!parsed.success)
    throw new AudioPipelineError(
      `Generated manifest failed shared validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
}

/**
 * Full pipeline. Returns a summary with per-format byte totals and savings; throws
 * AudioPipelineError on any problem, leaving the previous output untouched.
 * @param {{ source: string; out: string; ffmpeg?: string; ffprobe?: string; concurrency?: number; log?: (line: string) => void }} options
 */
export async function optimizeAudio(options) {
  const tools = { ffmpeg: options.ffmpeg ?? "ffmpeg", ffprobe: options.ffprobe ?? "ffprobe" };
  const log = options.log ?? (() => {});
  await checkPrerequisites(tools.ffmpeg, tools.ffprobe);
  const entries = await scanSources(options.source);
  const credits = path.join(options.source, "CREDITS.md");
  const creditsInfo = await lstat(credits).catch(() => null);
  if (!creditsInfo?.isFile() || creditsInfo.isSymbolicLink())
    throw new AudioPipelineError(
      "CREDITS.md is missing from the audio source (or is not a regular file)",
    );
  const out = path.resolve(options.out);
  const parent = path.dirname(out);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(out)}.staging-${randomUUID()}`);
  try {
    for (const folder of PHASE_FOLDERS)
      await mkdir(path.join(staging, folder), { recursive: true });
    const converted = await pool(
      entries,
      options.concurrency ?? Math.max(1, Math.min(4, availableParallelism())),
      async (entry) => {
        const result = await convert(entry, staging, tools);
        log(`converted ${entry.folder}/${entry.base}`);
        return result;
      },
    );
    await copyFile(credits, path.join(staging, "CREDITS.md"));
    const [original, copied] = await Promise.all([
      readFile(credits),
      readFile(path.join(staging, "CREDITS.md")),
    ]);
    if (
      createHash("sha256").update(original).digest("hex") !==
      createHash("sha256").update(copied).digest("hex")
    )
      throw new AudioPipelineError("CREDITS.md copy is not byte-identical");
    const manifest = buildManifest(entries);
    await validateManifest(manifest);
    await writeFile(
      path.join(staging, "audio-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // Publish: swap the complete staging directory in, then drop the previous output.
    const previous = path.join(parent, `.${path.basename(out)}.previous-${randomUUID()}`);
    const hadOutput = await lstat(out).then(
      () => true,
      () => false,
    );
    if (hadOutput) await rename(out, previous);
    try {
      await rename(staging, out);
    } catch (error) {
      if (hadOutput) await rename(previous, out);
      throw error;
    }
    if (hadOutput) await rm(previous, { recursive: true, force: true });
    const totals = { sourceBytes: 0, webmBytes: 0, mp3Bytes: 0 };
    for (const item of converted) {
      totals.sourceBytes += item.sourceBytes;
      for (const result of item.results) totals[`${result.format}Bytes`] += result.bytes;
    }
    return {
      files: converted.length,
      outputs: converted.length * 2,
      lobby: manifest.lobby.map((track) => track.id),
      ...totals,
      webmSaving: 1 - totals.webmBytes / totals.sourceBytes,
      mp3Saving: 1 - totals.mp3Bytes / totals.sourceBytes,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** CLI entry: `node scripts/optimize-audio.mjs [--source dir] [--out dir] [--ffmpeg bin] [--ffprobe bin]`. */
async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      out: { type: "string" },
      ffmpeg: { type: "string" },
      ffprobe: { type: "string" },
      concurrency: { type: "string" },
    },
    strict: true,
  });
  const summary = await optimizeAudio({
    source: path.resolve(values.source ?? path.join(ROOT, "audio-assets/kabuki-neko-audio")),
    out: path.resolve(values.out ?? path.join(ROOT, "apps/web/public/audio")),
    ffmpeg: values.ffmpeg,
    ffprobe: values.ffprobe,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  process.stdout.write(
    `Published ${summary.outputs} files from ${summary.files} sources (lobby: ${summary.lobby.join(", ")}).\n` +
      `Sources ${mib(summary.sourceBytes)}; Opus/WebM ${mib(summary.webmBytes)} (${pct(summary.webmSaving)} smaller); MP3 ${mib(summary.mp3Bytes)} (${pct(summary.mp3Saving)} smaller).\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(
      `audio:optimize failed: ${error instanceof AudioPipelineError ? error.message : error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
