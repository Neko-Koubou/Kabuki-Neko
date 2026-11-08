/**
 * TASK-073 coverage for the locale registry, audio catalogue and About metadata: verified bundles
 * with a seventh external locale (no enum edits), hash/version/file failures, production versus
 * development policy for missing artifacts, default-locale fallback, a generated audio manifest
 * derived from the actual 20 source cues, and rejection of legacy/missing/colliding/injected
 * descriptors.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BGM_DEFAULT_VOLUMES,
  LOBBY_TRACK_METADATA,
  SFX_DEFINITIONS,
} from "@kabuki-neko/shared/constants/audio";
import { LOCALE_NAMESPACES } from "@kabuki-neko/shared/schemas/locale.schema";
import type { ConfigService } from "../../config/config.service";
import { AudioCatalogError, AudioCatalogService, loadAudioManifest } from "./audio-catalog.service";
import {
  LocaleBundleError,
  LocaleRegistryService,
  loadLocaleRegistry,
  readAbout,
} from "./locale-registry.service";
import { InstalledLocales } from "./system.service";

const REPO = path.resolve(__dirname, "../../../../..");
const SOURCE_AUDIO = path.join(REPO, "audio-assets/kabuki-neko-audio");
let directory: string;

/** Minimal ConfigService stand-in exposing only the values these services read. */
function config(values: Record<string, string>): ConfigService {
  return { values: { NODE_ENV: "test", ...values } } as unknown as ConfigService;
}
/** Writes a verified bundle for `tags` and returns its directory and buildId. */
async function bundle(
  name: string,
  tags: string[],
  mutate?: (registry: Record<string, unknown>) => void,
) {
  const dir = path.join(directory, name);
  const buildId = createHash("sha256").update(name).digest("hex");
  const locales = [];
  for (const tag of tags) {
    const namespaces = [];
    for (const ns of LOCALE_NAMESPACES) {
      const content = JSON.stringify({ title: [{ type: 0, value: `${tag} ${ns}` }] });
      await mkdir(path.join(dir, buildId, tag), { recursive: true });
      await writeFile(path.join(dir, buildId, tag, `${ns}.json`), content);
      namespaces.push({
        name: ns,
        url: `/locales/${buildId}/${tag}/${ns}.json`,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    locales.push({
      tag,
      nativeName: `Native ${tag}`,
      direction: tag === "ar" ? "rtl" : "ltr",
      packageVersion: "1.0.0",
      coverage: tag === "de" ? 0.5 : 1,
      catalogVersion: "1",
      namespaces,
    });
  }
  const registry: Record<string, unknown> = { buildId, catalogVersion: "1", locales };
  mutate?.(registry);
  await writeFile(path.join(dir, "registry.json"), JSON.stringify(registry));
  return { dir, buildId };
}
/** Source cue files grouped by phase folder, read from the real audio input directory. */
async function sourceCues() {
  const cues: Record<string, string[]> = {};
  for (const folder of ["01-lobby", "02-thinking", "03-leaderboard", "04-podium", "05-sfx"])
    cues[folder] = (await readdir(path.join(SOURCE_AUDIO, folder)))
      .filter((file) => file.endsWith(".mp3"))
      .map((file) => file.slice(0, -4))
      .sort();
  return cues;
}
/** Generated-style manifest (dual sources) for the actual cues plus placeholder output files. */
async function audioFixture(name: string) {
  const root = path.join(directory, name);
  const cues = await sourceCues();
  for (const [folder, files] of Object.entries(cues)) {
    await mkdir(path.join(root, folder), { recursive: true });
    for (const file of files)
      for (const ext of ["webm", "mp3"])
        await writeFile(path.join(root, folder, `${file}.${ext}`), "x");
  }
  const src = (folder: string, file: string) => [
    `/audio/${folder}/${file}.webm`,
    `/audio/${folder}/${file}.mp3`,
  ];
  const lobby = (cues["01-lobby"] ?? []).map((file) => {
    const id = file.replace(/^bgm-lobby-/u, "");
    const meta = LOBBY_TRACK_METADATA[id];
    return {
      id,
      label: meta?.label ?? id,
      src: src("01-lobby", file),
      loop: true,
      volume: meta?.volume ?? 0.7,
    };
  });
  const bgm = (folder: string, file: string, volume: number) => ({
    src: src(folder, file),
    loop: true,
    volume,
  });
  const manifest = {
    lobby,
    thinking: {
      sprint: bgm("02-thinking", "bgm-think-sprint", BGM_DEFAULT_VOLUMES.thinking.sprint),
      standard: bgm("02-thinking", "bgm-think-standard", BGM_DEFAULT_VOLUMES.thinking.standard),
      puzzle: bgm("02-thinking", "bgm-think-puzzle", BGM_DEFAULT_VOLUMES.thinking.puzzle),
    },
    leaderboard: {
      groove: bgm(
        "03-leaderboard",
        "bgm-leaderboard-groove",
        BGM_DEFAULT_VOLUMES.leaderboard.groove,
      ),
    },
    podium: {
      buildup: bgm("04-podium", "bgm-podium-buildup", BGM_DEFAULT_VOLUMES.podium.buildup),
      victory: bgm("04-podium", "bgm-podium-victory", BGM_DEFAULT_VOLUMES.podium.victory),
    },
    sfx: Object.fromEntries(
      Object.entries(SFX_DEFINITIONS).map(([id, definition]) => [
        id,
        {
          src: src("05-sfx", definition.filename),
          volume: definition.volume,
          ...("throttleMs" in definition ? { throttleMs: definition.throttleMs } : {}),
        },
      ]),
    ),
  };
  const file = path.join(root, "audio-manifest.json");
  await writeFile(file, JSON.stringify(manifest));
  return { root, file, manifest, cues };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "kabuki-registries-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("LocaleRegistryService", () => {
  it("registers a seventh external locale from data alone and serves ETag/default fallback", async () => {
    const tags = ["en", "es", "fr", "id", "ja", "zh-Hans", "de"];
    const { dir, buildId } = await bundle("seven", tags);
    const service = new LocaleRegistryService(config({ LOCALE_BUNDLE_PATH: dir }));
    await service.onModuleInit();
    expect(service).toBeInstanceOf(InstalledLocales);
    expect(service.current().locales.map((locale) => locale.tag)).toEqual(tags);
    expect(service.isInstalled("de")).toBe(true);
    expect(service.isInstalled("pt")).toBe(false);
    expect(service.etag()).toBe(`"${buildId}"`);
    expect(service.effectiveDefault("id")).toBe("id");
    expect(service.effectiveDefault("pt")).toBe("en");
  });

  it("rejects bad hashes, versions, missing files and registries without complete en", async () => {
    const hashed = await bundle("bad-hash", ["en"]);
    await writeFile(path.join(hashed.dir, hashed.buildId, "en", "common.json"), '{"tampered":[]}');
    await expect(loadLocaleRegistry(hashed.dir)).rejects.toThrow("hash mismatch");
    const strict = new LocaleRegistryService(config({ LOCALE_BUNDLE_PATH: hashed.dir }));
    await expect(strict.onModuleInit()).rejects.toBeInstanceOf(LocaleBundleError);

    const version = await bundle("bad-version", ["en"], (registry) => {
      registry.catalogVersion = "2";
    });
    await expect(loadLocaleRegistry(version.dir)).rejects.toThrow("incompatible");
    const missing = await bundle("missing-file", ["en"]);
    await unlink(path.join(missing.dir, missing.buildId, "en", "about.json"));
    await expect(loadLocaleRegistry(missing.dir)).rejects.toThrow("Missing catalog en/about");
    const linked = await bundle("linked-file", ["en"]);
    const target = path.join(linked.dir, linked.buildId, "en", "admin.json");
    const copy = `${target}.real`;
    await writeFile(copy, await readFile(target));
    await unlink(target);
    await symlink(copy, target);
    await expect(loadLocaleRegistry(linked.dir)).rejects.toThrow("not a regular file");
    const noEnglish = await bundle("no-en", ["id"]);
    await expect(loadLocaleRegistry(noEnglish.dir)).rejects.toBeInstanceOf(LocaleBundleError);
  });

  it("fails startup on a missing bundle only in production", async () => {
    const absent = path.join(directory, "absent-bundle");
    const development = new LocaleRegistryService(config({ LOCALE_BUNDLE_PATH: absent }));
    await development.onModuleInit();
    expect(() => development.current()).toThrow(
      expect.objectContaining({ errorCode: "DEPENDENCY_UNAVAILABLE" }),
    );
    expect(development.isInstalled("en")).toBe(false);
    const production = new LocaleRegistryService(
      config({ NODE_ENV: "production", LOCALE_BUNDLE_PATH: absent }),
    );
    await expect(production.onModuleInit()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("AudioCatalogService", () => {
  it("loads a generated manifest built from the actual 20 source cues", async () => {
    const { file, cues } = await audioFixture("actual");
    expect(Object.values(cues).flat()).toHaveLength(20);
    const service = new AudioCatalogService(config({ AUDIO_MANIFEST_PATH: file }));
    await service.onModuleInit();
    const tracks = service.lobbyTracks();
    expect(tracks.map((track) => [track.id, track.label, track.volume])).toEqual([
      ["kabuki", "Kabuki Matsuri", 0.7],
      ["matcha", "Matcha Chill Lo-Fi", 0.65],
      ["neko8bit", "Neko 8-Bit Arcade", 0.7],
      ["showtime", "Showtime Funk", 0.7],
    ]);
    expect(tracks[0]?.src).toEqual([
      "/audio/01-lobby/bgm-lobby-kabuki.webm",
      "/audio/01-lobby/bgm-lobby-kabuki.mp3",
    ]);
    expect(service.isLobbyTrack("matcha")).toBe(true);
    expect(service.isLobbyTrack("random")).toBe(false);
    expect(service.current().sfx.nekoPop.throttleMs).toBe(150);
  });

  it("rejects the legacy source manifest and missing, colliding or injected descriptors", async () => {
    await expect(
      loadAudioManifest(path.join(SOURCE_AUDIO, "audio-manifest.json")),
    ).rejects.toBeInstanceOf(AudioCatalogError);
    const variants: [string, (manifest: Record<string, unknown>) => void][] = [
      ["missing-cue", (m) => delete (m.sfx as Record<string, unknown>).nekoPop],
      ["collision", (m) => (m.lobby as unknown[]).push((m.lobby as unknown[])[0])],
      [
        "traversal",
        (m) => {
          (m.lobby as { src: string[] }[])[0] = {
            ...(m.lobby as { src: string[] }[])[0],
            src: ["/audio/01-lobby/../../secret.webm", "/audio/01-lobby/../../secret.mp3"],
          };
        },
      ],
      [
        "external-url",
        (m) =>
          ((m.leaderboard as { groove: { src: string[] } }).groove.src = [
            "https://evil.example/a.webm",
            "https://evil.example/a.mp3",
          ]),
      ],
      ["empty-lobby", (m) => (m.lobby = [])],
    ];
    for (const [name, mutate] of variants) {
      const { file, manifest } = await audioFixture(name);
      const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
      mutate(copy);
      await writeFile(file, JSON.stringify(copy));
      await expect(loadAudioManifest(file)).rejects.toBeInstanceOf(AudioCatalogError);
    }
    const missingPair = await audioFixture("missing-pair");
    await unlink(path.join(missingPair.root, "05-sfx", "sfx-tick-last5s.webm"));
    await expect(loadAudioManifest(missingPair.file)).rejects.toThrow("sfx-tick-last5s.webm");
    const linked = await audioFixture("linked");
    const file = path.join(linked.root, "04-podium", "bgm-podium-victory.mp3");
    await unlink(file);
    await symlink("/etc/hosts", file);
    await expect(loadAudioManifest(linked.file)).rejects.toThrow("not a regular file");
  });

  it("treats a missing manifest as unavailable outside production", async () => {
    const absent = path.join(directory, "no-audio", "audio-manifest.json");
    const development = new AudioCatalogService(config({ AUDIO_MANIFEST_PATH: absent }));
    await development.onModuleInit();
    expect(development.available).toBe(false);
    expect(() => development.lobbyTracks()).toThrow(
      expect.objectContaining({ errorCode: "DEPENDENCY_UNAVAILABLE" }),
    );
    const production = new AudioCatalogService(
      config({ NODE_ENV: "production", AUDIO_MANIFEST_PATH: absent }),
    );
    await expect(production.onModuleInit()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("About", () => {
  it("reports the build version and fixed legal URLs without fabricating values", async () => {
    const version = (
      JSON.parse(await readFile(path.join(REPO, "apps/api/package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(await readAbout()).toEqual({
      name: "Kabuki Neko",
      version,
      license: "Apache-2.0-with-Commons-Clause",
      licenseUrl: "/legal/LICENSE.txt",
      noticesUrl: "/legal/THIRD-PARTY-NOTICES.txt",
      languageGuideUrl: "/help/languages",
    });
    const broken = path.join(directory, "package.json");
    await writeFile(broken, JSON.stringify({ name: "x" }));
    await expect(readAbout(broken)).rejects.toThrow("Build version unavailable");
  });
});
