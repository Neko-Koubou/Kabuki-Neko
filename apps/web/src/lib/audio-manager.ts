/**
 * Audio manager singleton (Audio revision 2026-10-31; US-07/13/18/19; TASK-130).
 *
 * Owns every Howl outside React so re-renders, StrictMode double effects and route changes cannot
 * leave sounds playing or stop the wrong session:
 *
 * - Howler is imported lazily on first use (live routes only; nothing at module load).
 * - Gain = cue volume (manifest default or explicit override) × master × channel (BGM/SFX); mute
 *   sets the effective gain to 0 without touching the stored volumes.
 * - BGM: at most one steady loop. Switching tracks stops the previous one, or — when a crossfade is
 *   requested — fades it out over at most 500 ms as the single allowed overlap; the outgoing handle
 *   is always stopped and unloaded when the fade completes or when another switch interrupts it.
 *   Every operation bumps a generation, so late async work (Howler import, fades) for an older
 *   request does nothing. Playback rate resets to 1 for each new track.
 * - SFX: one cached Howl per cue; duplicate `eventId`s are ignored and a per-cue throttle (nekoPop
 *   150 ms) uses a monotonic clock.
 * - Sources are `[webm, mp3]`; a load/decode error retries with the MP3 alone once, then reports
 *   `error` while the game continues. A handle the manager already stopped and unloaded is
 *   ignored: Howler reports a decode that completes after `unload()` as a load error, which must
 *   neither start a replacement for a track that is gone nor show a false error. A blocked autoplay reports `blocked`; `unlock()` (after a
 *   user gesture) resumes the audio context and restarts the current BGM.
 * - Ownership: `acquire()` returns a lease; only the current lease's `release()` stops audio, so a
 *   stale cleanup from StrictMode or a previous route cannot silence the new owner.
 * - Preview (studio) is exclusive: a new preview stops the previous one and live BGM stops it.
 * - A one-shot cue requested before any screen set the manifest (the join page's dice and own-join
 *   pop) loads the generated manifest once; a manifest set by a screen meanwhile wins.
 */
import {
  AUDIO_MANIFEST_URL,
  SFX_DEFINITIONS,
  type SfxId,
} from "@kabuki-neko/shared/constants/audio";
import { audioManifestSchema, type AudioManifest } from "@kabuki-neko/shared/schemas/audio.schema";

/** Minimal Howl surface used by the manager. */
export interface HowlLike {
  play(): unknown;
  stop(): unknown;
  unload(): unknown;
  volume(value?: number): unknown;
  fade(from: number, to: number, durationMs: number): unknown;
  rate(value: number): unknown;
  playing(): boolean;
  on(event: string, callback: (...args: unknown[]) => void): unknown;
}

/** Howler adapter (real Howler or a test double). */
export interface HowlerLike {
  createHowl(options: { src: string[]; loop: boolean; volume: number; preload: boolean }): HowlLike;
  /** Resumes the audio context after a user gesture; resolves true when audio may play. */
  unlock(): Promise<boolean>;
}

/** Engine status for the UI (enable-audio / error notices). */
export type AudioStatus = "idle" | "ready" | "blocked" | "error";

/** Volume preferences applied to every handle. */
export interface AudioGainPreferences {
  isMuted: boolean;
  masterVolume: number;
  bgmVolume: number;
  sfxVolume: number;
}

/** Background music selector. */
export type BgmKey =
  | { kind: "lobby"; id: string }
  | { kind: "thinking"; variant: "sprint" | "standard" | "puzzle" }
  | { kind: "leaderboard" }
  | { kind: "podium"; variant: "buildup" | "victory" };

/** Options of {@link AudioManager.playBgm}. */
export interface PlayBgmOptions {
  fadeInMs?: number;
  /** Crossfade from the current track (capped at 500 ms). */
  crossfadeMs?: number;
  /** Cue volume override (e.g. victory 0.95). */
  volume?: number;
}

/** Maximum deliberate overlap between two BGM tracks. */
export const MAX_CROSSFADE_MS = 500;
/** Remembered SFX event IDs. */
const MAX_SFX_EVENTS = 500;

/** Real Howler, imported only when first needed. */
async function loadHowler(): Promise<HowlerLike> {
  const { Howl, Howler } = await import("howler");
  return {
    createHowl: (options) => new Howl(options) as unknown as HowlLike,
    unlock: async () => {
      const context = Howler.ctx as AudioContext | undefined;
      if (context && context.state === "suspended") {
        try {
          await context.resume();
        } catch {
          return false;
        }
      }
      return !context || context.state === "running";
    },
  };
}

/** A playing (or loading) BGM track. */
interface BgmHandle {
  key: string;
  howl: HowlLike;
  base: number;
  src: readonly string[];
}

/** Manager options (tests inject Howler and a clock). */
export interface AudioManagerOptions {
  loadHowler?: () => Promise<HowlerLike>;
  /** Monotonic clock in ms. */
  now?: () => number;
  /**
   * Loads the manifest when a one-shot cue is requested before any screen set it (e.g. the join
   * page). Defaults to `GET /audio/audio-manifest.json`; resolves null when unavailable.
   */
  loadManifest?: () => Promise<AudioManifest | null>;
}

/** Fetches and validates the generated audio manifest; null when missing or invalid. */
async function fetchManifest(): Promise<AudioManifest | null> {
  try {
    const response = await fetch(AUDIO_MANIFEST_URL, { cache: "force-cache" });
    const parsed = audioManifestSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The audio manager (use {@link getAudioManager} for the app singleton). */
export class AudioManager {
  private engine: Promise<HowlerLike> | null = null;
  private readonly loadEngine: () => Promise<HowlerLike>;
  private readonly now: () => number;
  private readonly loadManifest: () => Promise<AudioManifest | null>;
  private manifestRequest: Promise<AudioManifest | null> | null = null;
  private manifest: AudioManifest | null = null;
  private prefs: AudioGainPreferences = {
    isMuted: false,
    masterVolume: 0.8,
    bgmVolume: 0.7,
    sfxVolume: 0.9,
  };
  private bgm: BgmHandle | null = null;
  private outgoing: { howl: HowlLike; timer: ReturnType<typeof setTimeout> } | null = null;
  private preview: { id: string; howl: HowlLike } | null = null;
  private readonly sfx = new Map<SfxId, HowlLike>();
  private readonly lastPlayed = new Map<SfxId, number>();
  private readonly seenEvents = new Set<string>();
  /** Handles this manager stopped and unloaded (their late load errors are not failures). */
  private readonly disposed = new WeakSet<HowlLike>();
  private generation = 0;
  private leaseCounter = 0;
  private currentLease: number | null = null;
  private status: AudioStatus = "idle";
  private readonly listeners = new Set<(status: AudioStatus) => void>();

  constructor(options: AudioManagerOptions = {}) {
    this.loadEngine = options.loadHowler ?? loadHowler;
    this.now = options.now ?? (() => performance.now());
    this.loadManifest = options.loadManifest ?? fetchManifest;
  }

  /** The manifest, loading it once when no screen has set it yet. */
  private async ensureManifest(): Promise<AudioManifest | null> {
    if (this.manifest) return this.manifest;
    this.manifestRequest ??= this.loadManifest().then((loaded) => {
      // A manifest set meanwhile by a screen wins.
      this.manifest ??= loaded;
      if (!loaded) this.manifestRequest = null; // allow a later retry
      return this.manifest;
    });
    return this.manifestRequest;
  }

  /** Lazily loads Howler once. */
  private ensureEngine(): Promise<HowlerLike> {
    this.engine ??= this.loadEngine();
    return this.engine;
  }

  /** Updates and broadcasts the status. */
  private setStatus(status: AudioStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /** Effective gain for a cue on a channel. */
  private gain(base: number, channel: "bgm" | "sfx"): number {
    if (this.prefs.isMuted) return 0;
    const channelVolume = channel === "bgm" ? this.prefs.bgmVolume : this.prefs.sfxVolume;
    return Math.min(1, Math.max(0, base * this.prefs.masterVolume * channelVolume));
  }

  /** Stops and unloads a handle, ignoring errors from an already-unloaded Howl. */
  private dispose(howl: HowlLike | null | undefined) {
    if (!howl) return;
    this.disposed.add(howl);
    try {
      howl.stop();
      howl.unload();
    } catch {
      // Already gone.
    }
  }

  /** Ends any outgoing crossfade immediately. */
  private finishOutgoing() {
    if (!this.outgoing) return;
    clearTimeout(this.outgoing.timer);
    this.dispose(this.outgoing.howl);
    this.outgoing = null;
  }

  /** Creates a Howl with MP3-only fallback after a load/decode error. */
  private createWithFallback(
    engine: HowlerLike,
    src: readonly string[],
    loop: boolean,
    volume: number,
    onReplace: (howl: HowlLike) => void,
  ): HowlLike {
    const howl = engine.createHowl({ src: [...src], loop, volume, preload: true });
    howl.on("playerror", () => this.setStatus("blocked"));
    howl.on("loaderror", () => {
      // Howler reports a decode that finishes after unload as a load error: not a failure.
      if (this.disposed.has(howl)) return;
      const mp3 = src.filter((url) => url.endsWith(".mp3"));
      if (src.length > 1 && mp3.length === 1) {
        const replacement = engine.createHowl({ src: mp3, loop, volume, preload: true });
        replacement.on("playerror", () => this.setStatus("blocked"));
        replacement.on("loaderror", () => {
          if (!this.disposed.has(replacement)) this.setStatus("error");
        });
        this.dispose(howl);
        onReplace(replacement);
      } else this.setStatus("error");
    });
    return howl;
  }

  /** Descriptor for a BGM key from the manifest. */
  private describe(key: BgmKey): { src: readonly string[]; volume: number; id: string } | null {
    const manifest = this.manifest;
    if (!manifest) return null;
    if (key.kind === "lobby") {
      const track = manifest.lobby.find((item) => item.id === key.id);
      return track ? { src: track.src, volume: track.volume, id: `lobby:${track.id}` } : null;
    }
    if (key.kind === "thinking")
      return { ...manifest.thinking[key.variant], id: `thinking:${key.variant}` };
    if (key.kind === "leaderboard")
      return { ...manifest.leaderboard.groove, id: "leaderboard:groove" };
    return { ...manifest.podium[key.variant], id: `podium:${key.variant}` };
  }

  /** Takes ownership of playback (one lease at a time). */
  acquire(): number {
    this.leaseCounter += 1;
    this.currentLease = this.leaseCounter;
    return this.leaseCounter;
  }

  /** Stops everything — but only for the current lease (stale cleanups are ignored). */
  release(lease: number): void {
    if (lease !== this.currentLease) return;
    this.currentLease = null;
    this.stopAll();
  }

  /** Installs the generated manifest (validated by the caller). */
  setManifest(manifest: AudioManifest | null): void {
    this.manifest = manifest;
  }

  /** Applies volume/mute preferences to playing handles without resetting anything. */
  setPreferences(prefs: AudioGainPreferences): void {
    this.prefs = { ...prefs };
    if (this.bgm) this.bgm.howl.volume(this.gain(this.bgm.base, "bgm"));
    if (this.preview)
      this.preview.howl.volume(
        this.gain(
          this.manifest?.lobby.find((item) => item.id === this.preview?.id)?.volume ?? 0.7,
          "bgm",
        ),
      );
  }

  /** Plays one steady BGM track (no restart when it is already playing). */
  async playBgm(key: BgmKey, options: PlayBgmOptions = {}): Promise<boolean> {
    const descriptor = this.describe(key);
    if (descriptor === null) return false;
    if (this.bgm?.key === descriptor.id) return true;
    this.stopPreview();
    const generation = ++this.generation;
    const engine = await this.ensureEngine();
    if (generation !== this.generation) return false; // superseded while Howler loaded

    const crossfade = Math.min(MAX_CROSSFADE_MS, Math.max(0, options.crossfadeMs ?? 0));
    const previous = this.bgm;
    this.bgm = null;
    this.finishOutgoing();
    if (previous && crossfade > 0) {
      const fromVolume = this.gain(previous.base, "bgm");
      previous.howl.fade(fromVolume, 0, crossfade);
      const timer = setTimeout(() => {
        if (this.outgoing?.howl === previous.howl) this.finishOutgoing();
      }, crossfade + 50);
      this.outgoing = { howl: previous.howl, timer };
    } else this.dispose(previous?.howl);

    const base = options.volume ?? descriptor.volume;
    const target = this.gain(base, "bgm");
    const fadeIn = Math.max(0, options.fadeInMs ?? (crossfade > 0 ? crossfade : 0));
    const handle: BgmHandle = {
      key: descriptor.id,
      base,
      src: descriptor.src,
      howl: null as unknown as HowlLike,
    };
    handle.howl = this.createWithFallback(
      engine,
      descriptor.src,
      true,
      fadeIn > 0 ? 0 : target,
      (replacement) => {
        if (this.bgm === handle) {
          handle.howl = replacement;
          replacement.rate(1);
          replacement.play();
          replacement.volume(this.gain(base, "bgm"));
        } else this.dispose(replacement);
      },
    );
    this.bgm = handle;
    handle.howl.rate(1);
    handle.howl.play();
    if (fadeIn > 0) handle.howl.fade(0, target, fadeIn);
    if (this.status === "idle") this.setStatus("ready");
    return true;
  }

  /** Stops the steady BGM, optionally fading it out (bounded, always unloaded afterwards). */
  stopBgm(fadeOutMs = 0): void {
    this.generation += 1;
    const current = this.bgm;
    this.bgm = null;
    this.finishOutgoing();
    if (!current) return;
    const fade = Math.min(MAX_CROSSFADE_MS, Math.max(0, fadeOutMs));
    if (fade === 0) {
      this.dispose(current.howl);
      return;
    }
    current.howl.fade(this.gain(current.base, "bgm"), 0, fade);
    const timer = setTimeout(() => {
      if (this.outgoing?.howl === current.howl) this.finishOutgoing();
    }, fade + 50);
    this.outgoing = { howl: current.howl, timer };
  }

  /** Sets the steady BGM playback rate (hurry-up) — reset by every new track. */
  setBgmRate(rate: number): void {
    this.bgm?.howl.rate(rate);
  }

  /** Key of the steady BGM, if any (diagnostics/tests). */
  get currentBgm(): string | null {
    return this.bgm?.key ?? null;
  }

  /** Plays a one-shot SFX; returns false when deduplicated, throttled or unavailable. */
  async playSfx(id: SfxId, options: { eventId?: string; volume?: number } = {}): Promise<boolean> {
    const descriptor = (this.manifest ?? (await this.ensureManifest()))?.sfx[id];
    if (!descriptor) return false;
    if (options.eventId !== undefined) {
      if (this.seenEvents.has(options.eventId)) return false;
      this.seenEvents.add(options.eventId);
      if (this.seenEvents.size > MAX_SFX_EVENTS)
        this.seenEvents.delete(this.seenEvents.values().next().value ?? "");
    }
    const throttle =
      "throttleMs" in descriptor
        ? descriptor.throttleMs
        : ((SFX_DEFINITIONS[id] as { throttleMs?: number }).throttleMs ?? 0);
    const at = this.now();
    const last = this.lastPlayed.get(id);
    if (throttle > 0 && last !== undefined && at - last < throttle) return false;
    this.lastPlayed.set(id, at);
    const engine = await this.ensureEngine();
    let howl = this.sfx.get(id);
    if (!howl) {
      howl = this.createWithFallback(engine, descriptor.src, false, 0, (replacement) => {
        this.sfx.set(id, replacement);
        replacement.volume(this.gain(options.volume ?? descriptor.volume, "sfx"));
        replacement.play();
      });
      this.sfx.set(id, howl);
    }
    howl.volume(this.gain(options.volume ?? descriptor.volume, "sfx"));
    howl.play();
    if (this.status === "idle") this.setStatus("ready");
    return true;
  }

  /** Plays an exclusive lobby-track preview (studio); stops any previous preview. */
  async previewLobby(id: string): Promise<boolean> {
    const track = this.manifest?.lobby.find((item) => item.id === id);
    if (!track) return false;
    this.stopPreview();
    const engine = await this.ensureEngine();
    const howl = this.createWithFallback(
      engine,
      track.src,
      false,
      this.gain(track.volume, "bgm"),
      (replacement) => {
        if (this.preview?.id === id) {
          this.preview = { id, howl: replacement };
          replacement.play();
        } else this.dispose(replacement);
      },
    );
    this.preview = { id, howl };
    howl.play();
    return true;
  }

  /** Stops the preview (dialog close, navigation, live playback). */
  stopPreview(): void {
    this.dispose(this.preview?.howl);
    this.preview = null;
  }

  /** Id of the previewed track, if any. */
  get previewing(): string | null {
    return this.preview?.id ?? null;
  }

  /** Resumes audio after a user gesture; restarts the current BGM if it was blocked. */
  async unlock(): Promise<boolean> {
    const engine = await this.ensureEngine();
    const unlocked = await engine.unlock();
    if (!unlocked) {
      this.setStatus("blocked");
      return false;
    }
    if (this.bgm && !this.bgm.howl.playing()) this.bgm.howl.play();
    this.setStatus("ready");
    return true;
  }

  /** Stops and unloads every handle and cancels pending fades. */
  stopAll(): void {
    this.generation += 1;
    this.dispose(this.bgm?.howl);
    this.bgm = null;
    this.finishOutgoing();
    this.stopPreview();
    for (const howl of this.sfx.values()) this.dispose(howl);
    this.sfx.clear();
  }

  /** Current status. */
  getStatus(): AudioStatus {
    return this.status;
  }

  /** Subscribes to status changes. */
  onStatus(listener: (status: AudioStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The app-wide singleton (created on first use in the browser). */
let singleton: AudioManager | null = null;

/** Returns the shared audio manager. */
export function getAudioManager(): AudioManager {
  singleton ??= new AudioManager();
  return singleton;
}
