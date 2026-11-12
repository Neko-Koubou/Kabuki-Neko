/**
 * TASK-174 distribution checks (SA §10.2; US-17, US-18, US-19, US-21).
 *
 * `scripts/package-assets.ts` runs as the release build does (`--require-audio
 * --require-locales`) against a private copy of the release inputs. The copy holds:
 * - the root LICENSE and notices;
 * - the audio provenance and sources;
 * - the web public assets (brand, font, generated audio and locale bundle);
 * - the API locale bundle;
 * - the installed DiceBear packages (linked).
 *
 * 1. A complete tree packages the legal texts byte-for-byte into the web's `/legal/*.txt` and the
 *    API's `assets/legal`, and the generated audio manifest into the API's `assets/audio`.
 * 2. Each required input is then removed or corrupted in turn. The run must fail with a message
 *    naming it, and the previously packaged copies must stay untouched. The inputs:
 *    - legal texts;
 *    - brand/font assets;
 *    - an audio WebM or its MP3 fallback, or a WebM without the Opus codec;
 *    - a missing, legacy (old four-URL) or stale manifest;
 *    - the public credits;
 *    - an unattributed source, or a provenance claiming the code license covers the audio;
 *    - a missing web locale registry, asset or template;
 *    - an API/web buildId mismatch.
 * 3. The root `pnpm build` declares the hook: locales are built and assets packaged with every
 *    requirement before turbo builds the apps.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

jest.setTimeout(300_000);

const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const run = promisify(execFile);

/** The release-input fixture (a private copy) and its packaged outputs. */
let fixture = "";
const web = () => path.join(fixture, "apps/web/public");
const api = () => path.join(fixture, "apps/api/assets");

/** Runs the packager like the release build; returns its exit code and output. */
async function packageAssets() {
  try {
    const { stdout, stderr } = await run(
      TSX,
      [
        path.join(ROOT, "scripts/package-assets.ts"),
        "--root",
        fixture,
        "--require-audio",
        "--require-locales",
      ],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

/** The packaged outputs' bytes, to prove a failed run leaves them unchanged. */
async function packaged() {
  const files = [
    path.join(web(), "legal/LICENSE.txt"),
    path.join(web(), "legal/THIRD-PARTY-NOTICES.txt"),
    path.join(api(), "legal/LICENSE.txt"),
    path.join(api(), "legal/THIRD-PARTY-NOTICES.txt"),
    path.join(api(), "audio/audio-manifest.json"),
  ];
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

/** Moves a fixture file away; returns the restore step. */
async function remove(relative: string) {
  const file = path.join(fixture, relative);
  await rename(file, `${file}.removed`);
  return () => rename(`${file}.removed`, file);
}

/** Replaces a fixture file's content; returns the restore step. */
async function replace(relative: string, content: (original: Buffer) => Buffer | string) {
  const file = path.join(fixture, relative);
  const original = await readFile(file);
  await writeFile(file, content(original));
  return () => writeFile(file, original);
}

/** Adds a fixture file; returns the restore step. */
async function add(relative: string, content: Buffer | string) {
  const file = path.join(fixture, relative);
  await writeFile(file, content);
  return () => rm(file);
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "kabuki-distribution-"));
  for (const item of [
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "docs/audio-provenance.json",
    "audio-assets",
    "locales-built",
    "apps/web/package.json",
  ])
    await cp(path.join(ROOT, item), path.join(fixture, item), { recursive: true });
  for (const folder of ["brand", "fonts", "audio", "locales"])
    await cp(path.join(ROOT, "apps/web/public", folder), path.join(web(), folder), {
      recursive: true,
    });
  // Installed packages (DiceBear) are resolved through links, never copied.
  await symlink(path.join(ROOT, "node_modules"), path.join(fixture, "node_modules"), "dir");
  await symlink(
    path.join(ROOT, "apps/web/node_modules"),
    path.join(fixture, "apps/web/node_modules"),
    "dir",
  );
  await mkdir(path.join(fixture, "apps/api"), { recursive: true });
});

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

it("packages the legal texts into both artifacts and the audio metadata into the API", async () => {
  const outcome = await packageAssets();
  expect(outcome.stderr).toBe("");
  expect(outcome.code).toBe(0);
  expect(outcome.stdout).toContain("20 audio sources and 40 generated outputs verified");
  expect(outcome.stdout).toMatch(
    /locale bundle [0-9a-f]{12}: 6 locales, \d+ assets in both API and web/u,
  );
  const [license, notices] = await Promise.all(
    ["LICENSE", "THIRD-PARTY-NOTICES.md"].map((file) => readFile(path.join(fixture, file), "utf8")),
  );
  const [webLicense, webNotices, apiLicense, apiNotices, apiManifest] = await packaged();
  expect(webLicense).toBe(license);
  expect(apiLicense).toBe(license);
  expect(webNotices).toBe(notices);
  expect(apiNotices).toBe(notices);
  expect(apiManifest).toBe(await readFile(path.join(web(), "audio/audio-manifest.json"), "utf8"));
  // The packaged notices keep the audio separate from the code license; nothing is equated.
  expect(webNotices).toContain("are **not** covered by the project LICENSE");
});

/** One required input, how it is broken, and the message the run must report. */
const BROKEN: [string, () => Promise<() => Promise<unknown>>, RegExp][] = [
  ["missing LICENSE", () => remove("LICENSE"), /^LICENSE: missing/mu],
  [
    "missing notices",
    () => remove("THIRD-PARTY-NOTICES.md"),
    /^THIRD-PARTY-NOTICES\.md: missing/mu,
  ],
  ["missing logo", () => remove("apps/web/public/brand/logo.svg"), /brand\/logo\.svg/u],
  [
    "missing font",
    () => remove("apps/web/public/fonts/noto-sans-latin.woff2"),
    /noto-sans-latin\.woff2/u,
  ],
  [
    "missing MP3 fallback",
    () => remove("apps/web/public/audio/01-lobby/bgm-lobby-kabuki.mp3"),
    /bgm-lobby-kabuki\.mp3: missing/u,
  ],
  [
    "missing WebM",
    () => remove("apps/web/public/audio/05-sfx/sfx-answer-correct.webm"),
    /sfx-answer-correct\.webm: missing/u,
  ],
  [
    "WebM without the Opus codec",
    () =>
      replace("apps/web/public/audio/02-thinking/bgm-think-sprint.webm", () =>
        Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 0x41)]),
      ),
    /bgm-think-sprint\.webm: not a WebM file with the Opus codec/u,
  ],
  [
    "missing manifest",
    () => remove("apps/web/public/audio/audio-manifest.json"),
    /audio-manifest\.json: missing/u,
  ],
  [
    "legacy four-URL manifest",
    () =>
      replace("apps/web/public/audio/audio-manifest.json", () =>
        JSON.stringify({
          phases: {
            lobby: { src: ["/audio/lobby.mp3"] },
            question: { src: ["/audio/question.mp3"] },
            leaderboard: { src: ["/audio/leaderboard.mp3"] },
            podium: { src: ["/audio/podium.mp3"] },
          },
        }),
      ),
    /stale or legacy manifest/u,
  ],
  [
    "stale manifest (an output dropped)",
    () =>
      replace("apps/web/public/audio/audio-manifest.json", (original) => {
        const manifest = JSON.parse(original.toString("utf8")) as { lobby: unknown[] };
        manifest.lobby = manifest.lobby.slice(1);
        return JSON.stringify(manifest);
      }),
    /is missing from the manifest/u,
  ],
  [
    "missing public credits",
    () => remove("apps/web/public/audio/CREDITS.md"),
    /audio\/CREDITS\.md: missing/u,
  ],
  [
    "unattributed audio source",
    () => add("audio-assets/kabuki-neko-audio/01-lobby/bgm-lobby-unknown.mp3", "ID3"),
    /bgm-lobby-unknown\.mp3: source has no provenance entry/u,
  ],
  [
    "code license claimed for the audio",
    () =>
      replace("docs/audio-provenance.json", (original) => {
        const provenance = JSON.parse(original.toString("utf8")) as {
          codeLicense: { appliesToAudio: boolean };
        };
        provenance.codeLicense.appliesToAudio = true;
        return JSON.stringify(provenance);
      }),
    /appliesToAudio must be false/u,
  ],
  [
    "missing web locale registry",
    () => remove("apps/web/public/locales/registry.json"),
    /locale bundle missing or invalid/u,
  ],
  [
    "web and API buildIds differ",
    () => replace("locales-built/registry.json", (original) => `${original.toString("utf8")}\n`),
    /web and API locale registries differ/u,
  ],
  [
    "missing web template",
    () => remove("apps/web/public/locales/template-v1.zip"),
    /template-v1\.zip: missing/u,
  ],
];

it.each(BROKEN)("fails on %s and keeps the packaged copies", async (_name, breakIt, message) => {
  const before = await packaged();
  const restore = await breakIt();
  try {
    const outcome = await packageAssets();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(message);
    expect(outcome.stderr).toContain("packaged copies were not changed");
    expect(await packaged()).toEqual(before);
  } finally {
    await restore();
  }
});

it("fails on a missing locale asset in the web copy", async () => {
  const registry = JSON.parse(
    await readFile(path.join(web(), "locales/registry.json"), "utf8"),
  ) as { locales: { namespaces: { url: string }[] }[] };
  const url = registry.locales[0]?.namespaces[0]?.url ?? "";
  const restore = await remove(`apps/web/public${url}`);
  try {
    const outcome = await packageAssets();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(`${url.replace(/^\//u, "")}: missing`);
  } finally {
    await restore();
  }
});

it("fails without the generated audio when the release requires it", async () => {
  const restore = await remove("apps/web/public/audio");
  try {
    const outcome = await packageAssets();
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("generated audio missing; run pnpm audio:optimize");
  } finally {
    await restore();
  }
  // Restored: the complete tree packages again.
  expect((await packageAssets()).code).toBe(0);
});

it("declares the build hook: locales and assets are packaged before turbo builds the apps", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(manifest.scripts["build"]).toBe("pnpm build:assets && turbo run build");
  expect(manifest.scripts["build:assets"]).toBe(
    "pnpm --filter @kabuki-neko/shared build && pnpm locales:build && pnpm assets:package --require-audio --require-locales --ensure-audio",
  );
  expect(manifest.scripts["assets:package"]).toBe("tsx scripts/package-assets.ts");
});
