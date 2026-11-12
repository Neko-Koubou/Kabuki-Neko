/**
 * Real-browser audio observer for the E2E audio suite (TASK-160A; Audio revision 2026-10-31).
 *
 * The observer watches the real Howler that the app lazily loads. Nothing is faked: decoding,
 * codec choice, playback and failures all come from the browser.
 *
 * - `installAudioObserver` adds an init script that traps the global `Howl` that howler.js
 *   assigns when it loads. It wraps the prototype once and records, with `performance.now()`
 *   timestamps:
 *   - each Howl's chosen source and loop flag after `init`;
 *   - `play`, `stop`, `unload`, `fade`, `rate` and explicit `volume` calls. A `play(id)` with
 *     a sound id is Howler replaying a queued play after loading, so it is kept apart
 *     (`play-internal`) from the app's own `play()` requests;
 *   - the `load`, `loaderror`, `play` and `playerror` events.
 * - `forceMp3` makes a page's `canPlayType` deny WebM before Howler probes its codecs. This forces
 *   the documented `[webm, mp3]` order onto the MP3 source, as on a browser without WebM.
 * - Node-side helpers read the log and derive what the specs assert: which cues played, the
 *   steady-loop intervals and their overlaps, rate changes, and whether anything still plays.
 */
import type { BrowserContext, Page } from "@playwright/test";

/** One recorded audio action. */
export interface AudioLogEntry {
  /** `performance.now()` in the page (ms). */
  t: number;
  /** Howl instance number (creation order). */
  howl: number;
  kind:
    | "create"
    | "play-call"
    | "play-internal"
    | "stop"
    | "unload"
    | "fade"
    | "rate"
    | "volume"
    | "load"
    | "loaderror"
    | "play"
    | "playerror";
  /** Chosen source URL (or the source list before loading). */
  src: string;
  loop: boolean;
  /** Call arguments (fade from/to/duration, rate, volume). */
  args?: number[];
}

/** SFX file stems by cue id (from the shared audio constants). */
export const SFX_FILES = {
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
} as const;
/** SFX cue id. */
export type SfxName = keyof typeof SFX_FILES;

/** Page-side script: traps `Howl` and wraps its prototype. */
function observerScript() {
  const log: unknown[] = [];
  (window as unknown as { __audioLog: unknown[] }).__audioLog = log;
  let counter = 0;
  /** Records one entry for a Howl instance. */
  const record = (howl: Record<string, unknown>, kind: string, args?: number[]) => {
    const src = howl["_src"];
    log.push({
      t: performance.now(),
      howl: howl["__observerId"],
      kind,
      src: Array.isArray(src) ? src.join(",") : String(src),
      loop: Boolean(howl["_loop"]),
      ...(args ? { args } : {}),
    });
  };
  /** Wraps the prototype of the real Howl class once. */
  const wrap = (Howl: { prototype: Record<string, unknown> }) => {
    const proto = Howl.prototype;
    if (proto["__observed"]) return;
    proto["__observed"] = true;
    const original = (name: string) =>
      proto[name] as (this: Record<string, unknown>, ...args: unknown[]) => unknown;
    const init = original("init");
    proto["init"] = function wrappedInit(this: Record<string, unknown>, ...args: unknown[]) {
      counter += 1;
      this["__observerId"] = counter;
      const result = init.apply(this, args);
      record(this, "create");
      const on = this["on"] as (event: string, handler: (...rest: unknown[]) => void) => void;
      for (const event of ["load", "loaderror", "play", "playerror"])
        on.call(this, event, () => record(this, event));
      return result;
    };
    for (const name of ["play", "stop", "unload"]) {
      const method = original(name);
      proto[name] = function wrapped(this: Record<string, unknown>, ...args: unknown[]) {
        // Howler replays a queued play with the sound id once loaded; the app calls play().
        const kind =
          name !== "play" ? name : typeof args[0] === "number" ? "play-internal" : "play-call";
        record(this, kind);
        return method.apply(this, args);
      };
    }
    const fade = original("fade");
    proto["fade"] = function wrappedFade(this: Record<string, unknown>, ...args: unknown[]) {
      record(this, "fade", args.slice(0, 3).map(Number));
      return fade.apply(this, args);
    };
    for (const name of ["rate", "volume"]) {
      const method = original(name);
      proto[name] = function wrapped(this: Record<string, unknown>, ...args: unknown[]) {
        // Getter calls (no argument) are not recorded.
        if (typeof args[0] === "number") record(this, name, [args[0]]);
        return method.apply(this, args);
      };
    }
  };
  let current: unknown;
  Object.defineProperty(window, "Howl", {
    configurable: true,
    get: () => current,
    set: (value: unknown) => {
      current = value;
      if (typeof value === "function") wrap(value as { prototype: Record<string, unknown> });
    },
  });
}

/** Installs the observer on every page of a context (before any app script runs). */
export async function installAudioObserver(context: BrowserContext): Promise<void> {
  await context.addInitScript(observerScript);
}

/** Pretends this page's browser cannot play WebM (call before navigating). */
export async function forceMp3(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function canPlayType(type: string) {
      return /webm/iu.test(type) ? "" : original.call(this, type);
    };
  });
}

/** The page's audio log so far. */
export async function readAudioLog(page: Page): Promise<AudioLogEntry[]> {
  return page.evaluate(
    () => (window as unknown as { __audioLog?: AudioLogEntry[] }).__audioLog ?? [],
  );
}

/** True while any Howl in the page is playing. */
export async function anythingPlaying(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const howler = (window as unknown as { Howler?: { _howls?: { playing: () => boolean }[] } })
      .Howler;
    return (howler?._howls ?? []).some((howl) => howl.playing());
  });
}

/** The SFX cue a source belongs to, if any. */
export function sfxOf(src: string): SfxName | null {
  for (const [name, stem] of Object.entries(SFX_FILES))
    if (src.includes(`/05-sfx/${stem}.`)) return name as SfxName;
  return null;
}

/** Play calls per SFX cue (calls that reached the real Howl). */
export function sfxCalls(log: readonly AudioLogEntry[]): Map<SfxName, AudioLogEntry[]> {
  const calls = new Map<SfxName, AudioLogEntry[]>();
  for (const entry of log) {
    if (entry.kind !== "play-call") continue;
    const name = sfxOf(entry.src);
    if (name) calls.set(name, [...(calls.get(name) ?? []), entry]);
  }
  return calls;
}

/** One steady (looping) BGM interval: from the real `play` event to its stop/unload. */
export interface LoopInterval {
  howl: number;
  src: string;
  start: number;
  end: number;
}

/**
 * Steady-loop intervals; a loop still playing ends at `until`. Events of a Howl after its unload
 * are ignored (Howler may still emit a queued `play` event then).
 */
export function loopIntervals(log: readonly AudioLogEntry[], until: number): LoopInterval[] {
  const intervals = new Map<number, LoopInterval>();
  const unloaded = new Set<number>();
  for (const entry of log) {
    // Howler can emit a queued `play` event after unload; an unloaded Howl makes no sound.
    if (!entry.loop || unloaded.has(entry.howl)) continue;
    if (entry.kind === "unload") unloaded.add(entry.howl);
    const open = intervals.get(entry.howl);
    if (entry.kind === "play" && (!open || open.end !== Number.POSITIVE_INFINITY))
      intervals.set(entry.howl, {
        howl: entry.howl,
        src: entry.src,
        start: entry.t,
        end: Number.POSITIVE_INFINITY,
      });
    if ((entry.kind === "stop" || entry.kind === "unload") && open && open.end === Infinity)
      open.end = entry.t;
  }
  return [...intervals.values()].map((interval) => ({
    ...interval,
    end: Math.min(interval.end, until),
  }));
}

/** Longest time two steady loops played together (ms). */
export function maxLoopOverlap(intervals: readonly LoopInterval[]): number {
  let worst = 0;
  for (const [index, a] of intervals.entries())
    for (const b of intervals.slice(index + 1))
      worst = Math.max(worst, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return worst;
}

/**
 * Sources that reported a real load or decode error. Howler also reports a decode that finishes
 * after `unload()` as a load error; such entries (after the same Howl's unload) are not failures.
 */
export function loadErrors(log: readonly AudioLogEntry[]): string[] {
  const unloaded = new Set<number>();
  const errors: string[] = [];
  for (const entry of log) {
    if (entry.kind === "unload") unloaded.add(entry.howl);
    if (entry.kind === "loaderror" && !unloaded.has(entry.howl)) errors.push(entry.src);
  }
  return errors;
}
