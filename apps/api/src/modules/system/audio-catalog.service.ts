/**
 * Audio catalogue served to clients (audio-engine revision 2026-10-31, SA §4.4 public-config).
 *
 * The API reads the same **generated** manifest the web app ships (`AUDIO_MANIFEST_PATH`, produced
 * by the audio optimizer): root keys `lobby/thinking/leaderboard/podium/sfx`, dual WebM+MP3 sources
 * and volumes. The legacy source manifest (`phases` wrapper, scalar MP3 URLs) is rejected by the
 * strict shared schema. Every referenced file must exist as a regular file under the manifest's
 * audio root, so a descriptor never points at a missing pair. Lobby descriptors become
 * `/system/public-config.audioTracks`; nothing is synthesized from quiz data or user input.
 *
 * A missing manifest is fatal in production and reported as unavailable (503 at the route) in
 * development/test, where the optimizer may not have run yet.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  audioManifestSchema,
  type AudioManifest,
  type LobbyTrack,
} from "@kabuki-neko/shared/schemas/audio.schema";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";

/** Why a manifest was rejected; messages contain no file contents. */
export class AudioCatalogError extends Error {}

/** Every source path (`/audio/...`) referenced by a validated manifest. */
export function manifestSources(manifest: AudioManifest): string[] {
  const sources: string[] = [];
  for (const track of manifest.lobby) sources.push(...track.src);
  for (const group of [manifest.thinking, manifest.leaderboard, manifest.podium, manifest.sfx])
    for (const descriptor of Object.values(group)) sources.push(...descriptor.src);
  return sources;
}

/**
 * Parses and validates a generated manifest file and checks that each referenced source exists
 * as a regular (non-symlink) file inside the manifest's directory.
 */
export async function loadAudioManifest(file: string): Promise<AudioManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new AudioCatalogError("Audio manifest is not valid JSON");
  }
  const parsed = audioManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new AudioCatalogError(
      `Audio manifest rejected: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`,
    );
  const root = path.dirname(path.resolve(file));
  const sources = manifestSources(parsed.data);
  if (new Set(sources).size !== sources.length)
    throw new AudioCatalogError("Audio manifest reuses a source file for two cues");
  for (const source of sources) {
    const relative = source.replace(/^\/audio\//u, "");
    const target = path.resolve(root, relative);
    if (path.relative(root, target).startsWith("..")) throw new AudioCatalogError("Unsafe source");
    let info;
    try {
      info = await lstat(target);
    } catch {
      throw new AudioCatalogError(`Audio source missing: ${source}`);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0)
      throw new AudioCatalogError(`Audio source is not a regular file: ${source}`);
  }
  return parsed.data;
}

@Injectable()
export class AudioCatalogService implements OnModuleInit {
  private manifest: AudioManifest | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** Loads the manifest at startup; invalid content always fails, absence only in production. */
  async onModuleInit(): Promise<void> {
    try {
      this.manifest = await loadAudioManifest(this.config.values.AUDIO_MANIFEST_PATH);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing || this.config.values.NODE_ENV === "production") throw error;
      this.manifest = null;
    }
  }

  /** True when a validated manifest is loaded. */
  get available(): boolean {
    return this.manifest !== null;
  }

  /** The validated manifest, or 503 when the generated catalogue is not installed. */
  current(): AudioManifest {
    if (!this.manifest) throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    return this.manifest;
  }

  /** Lobby descriptors in stable manifest order (public-config `audioTracks`). */
  lobbyTracks(): LobbyTrack[] {
    return this.current().lobby;
  }

  /** True for installed lobby IDs; unknown/legacy IDs resolve to random at playback. */
  isLobbyTrack(id: string): boolean {
    return this.manifest?.lobby.some((track) => track.id === id) ?? false;
  }
}
