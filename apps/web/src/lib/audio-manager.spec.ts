/**
 * TASK-130 coverage for the audio manager with a fake Howler and clock: lazy Howler loading, gain
 * composition and mute, one steady BGM with no orphan loops, a crossfade capped at 500 ms that is
 * cleaned up on completion and when interrupted, rate reset per track, throttled/deduplicated SFX
 * bursts, blocked autoplay with unlock/retry, MP3 fallback after a decode error then an error
 * status, stale async work after stop, exclusive previews, stop/unload of everything, and
 * StrictMode/route lease ownership.
 */
import { describe, expect, it, vi } from "vitest";
import { audioManifestSchema, type AudioManifest } from "@kabuki-neko/shared/schemas/audio.schema";
import { AudioManager, MAX_CROSSFADE_MS, type HowlLike, type HowlerLike } from "./audio-manager";

/** Builds a schema-valid manifest. */
function manifest(): AudioManifest {
  const pair = (folder: string, file: string) => [
    `/audio/${folder}/${file}.webm`,
    `/audio/${folder}/${file}.mp3`,
  ];
  const bgm = (folder: string, file: string, volume: number) => ({
    src: pair(folder, file),
    loop: true,
    volume,
  });
  const sfx = (file: string, volume: number) => ({ src: pair("05-sfx", file), volume });
  return audioManifestSchema.parse({
    lobby: [
      {
        id: "kabuki",
        label: "Kabuki Matsuri",
        src: pair("01-lobby", "bgm-lobby-kabuki"),
        loop: true,
        volume: 0.7,
      },
      {
        id: "matcha",
        label: "Matcha Chill Lo-Fi",
        src: pair("01-lobby", "bgm-lobby-matcha"),
        loop: true,
        volume: 0.65,
      },
    ],
    thinking: {
      sprint: bgm("02-thinking", "bgm-think-sprint", 0.8),
      standard: bgm("02-thinking", "bgm-think-standard", 0.75),
      puzzle: bgm("02-thinking", "bgm-think-puzzle", 0.7),
    },
    leaderboard: { groove: bgm("03-leaderboard", "bgm-leaderboard-groove", 0.75) },
    podium: {
      buildup: bgm("04-podium", "bgm-podium-buildup", 0.85),
      victory: bgm("04-podium", "bgm-podium-victory", 0.9),
    },
    sfx: {
      hyoshigiStart: sfx("sfx-hyoshigi-start", 1),
      nekoPop: { ...sfx("sfx-neko-pop", 0.8), throttleMs: 150 },
      questionWhoosh: sfx("sfx-question-whoosh", 0.9),
      tickLast5s: sfx("sfx-tick-last5s", 0.95),
      timeupGong: sfx("sfx-timeup-gong", 1),
      revealBar: sfx("sfx-reveal-bar", 0.85),
      answerCorrect: sfx("sfx-answer-correct", 0.9),
      answerWrong: sfx("sfx-answer-wrong", 0.85),
      streakFire: sfx("sfx-streak-fire", 0.95),
      podiumSpotlight: sfx("sfx-podium-spotlight", 1),
    },
  });
}

/** Howl double recording calls. */
class FakeHowl implements HowlLike {
  playingNow = false;
  unloaded = false;
  plays = 0;
  vol: number;
  rateValue = 1;
  fades: [number, number, number][] = [];
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor(
    public options: { src: string[]; loop: boolean; volume: number },
    private behaviour: { blocked: () => boolean },
  ) {
    this.vol = options.volume;
  }
  play() {
    if (this.unloaded) throw new Error("played after unload");
    this.plays += 1;
    if (this.behaviour.blocked()) {
      this.emit("playerror");
      return;
    }
    this.playingNow = true;
  }
  stop() {
    this.playingNow = false;
  }
  unload() {
    this.unloaded = true;
    this.playingNow = false;
  }
  volume(value?: number) {
    if (value !== undefined) this.vol = value;
    return this.vol;
  }
  fade(from: number, to: number, duration: number) {
    this.fades.push([from, to, duration]);
    this.vol = to;
  }
  rate(value: number) {
    this.rateValue = value;
  }
  playing() {
    return this.playingNow;
  }
  on(event: string, callback: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }
  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
}

/** Manager wired to fakes. */
function setup() {
  const howls: FakeHowl[] = [];
  const flags = { blocked: false, unlock: true };
  let now = 0;
  const engine: HowlerLike = {
    createHowl: (options) => {
      const howl = new FakeHowl(options, { blocked: () => flags.blocked });
      howls.push(howl);
      return howl;
    },
    unlock: vi.fn(async () => flags.unlock),
  };
  const load = vi.fn(async () => engine);
  const manager = new AudioManager({ loadHowler: load, now: () => now });
  manager.setManifest(manifest());
  manager.setPreferences({ isMuted: false, masterVolume: 0.8, bgmVolume: 0.7, sfxVolume: 0.9 });
  return {
    manager,
    howls,
    flags,
    load,
    engine,
    tick: (ms: number) => {
      now += ms;
    },
    playing: () => howls.filter((howl) => howl.playingNow && !howl.unloaded),
  };
}

describe("BGM", () => {
  it("loads Howler lazily and composes gain from cue × master × channel; mute keeps volumes", async () => {
    const { manager, howls, load } = setup();
    expect(load).not.toHaveBeenCalled();
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(howls[0]?.options).toMatchObject({
      src: ["/audio/01-lobby/bgm-lobby-kabuki.webm", "/audio/01-lobby/bgm-lobby-kabuki.mp3"],
      loop: true,
    });
    expect(howls[0]?.vol).toBeCloseTo(0.7 * 0.8 * 0.7);
    manager.setPreferences({ isMuted: true, masterVolume: 0.8, bgmVolume: 0.7, sfxVolume: 0.9 });
    expect(howls[0]?.vol).toBe(0);
    manager.setPreferences({ isMuted: false, masterVolume: 0.5, bgmVolume: 1, sfxVolume: 0.9 });
    expect(howls[0]?.vol).toBeCloseTo(0.35);
    await manager.playBgm({ kind: "podium", variant: "victory" }, { volume: 0.95 });
    expect(howls[1]?.vol).toBeCloseTo(0.95 * 0.5);
  });

  it("keeps a single steady loop: no restart of the same track and no orphans on switch", async () => {
    const { manager, howls, playing } = setup();
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    expect(howls).toHaveLength(1);
    manager.setBgmRate(1.22);
    await manager.playBgm({ kind: "thinking", variant: "sprint" });
    expect(howls[0]?.unloaded).toBe(true);
    expect(playing()).toEqual([howls[1]]);
    expect(howls[1]?.rateValue).toBe(1); // rate reset for the new track
    expect(manager.currentBgm).toBe("thinking:sprint");
  });

  it("caps crossfades at 500 ms, unloads the outgoing track, and survives interruption", async () => {
    vi.useFakeTimers();
    const { manager, howls, playing } = setup();
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    await manager.playBgm({ kind: "lobby", id: "matcha" }, { crossfadeMs: 2_000 });
    const [first, second] = howls;
    expect(first?.fades.at(-1)?.[2]).toBe(MAX_CROSSFADE_MS);
    expect(second?.fades.at(-1)).toEqual([0, expect.closeTo(0.65 * 0.8 * 0.7), MAX_CROSSFADE_MS]);
    expect(playing()).toHaveLength(2); // the one deliberate overlap
    // Interrupt the crossfade with a third track.
    await manager.playBgm({ kind: "thinking", variant: "standard" }, { crossfadeMs: 500 });
    expect(first?.unloaded).toBe(true);
    expect(playing()).toHaveLength(2);
    vi.advanceTimersByTime(MAX_CROSSFADE_MS + 50);
    expect(second?.unloaded).toBe(true);
    expect(playing()).toEqual([howls[2]]);
    manager.stopBgm(400);
    expect(howls[2]?.fades.at(-1)?.[2]).toBe(400);
    vi.advanceTimersByTime(450);
    expect(playing()).toEqual([]);
    expect(howls.every((howl) => howl.unloaded)).toBe(true);
  });

  it("drops stale work when stopped while Howler is still loading", async () => {
    const { manager, howls, load, engine } = setup();
    let release: (value: HowlerLike) => void = () => {};
    load.mockImplementationOnce(() => new Promise<HowlerLike>((resolve) => (release = resolve)));
    const pending = manager.playBgm({ kind: "leaderboard" });
    manager.stopBgm();
    release(engine);
    await expect(pending).resolves.toBe(false);
    expect(howls).toHaveLength(0);
  });
});

describe("SFX", () => {
  it("throttles nekoPop bursts on a monotonic clock and deduplicates event IDs", async () => {
    const { manager, howls, tick } = setup();
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await manager.playSfx("nekoPop"));
      tick(10);
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    tick(60); // 160 ms since the first pop
    expect(await manager.playSfx("nekoPop")).toBe(true);
    expect(howls).toHaveLength(1); // one cached Howl per cue
    expect(howls[0]?.plays).toBe(2);
    expect(howls[0]?.vol).toBeCloseTo(0.8 * 0.8 * 0.9);
    expect(await manager.playSfx("timeupGong", { eventId: "reveal-q1" })).toBe(true);
    expect(await manager.playSfx("timeupGong", { eventId: "reveal-q1" })).toBe(false);
  });
});

describe("errors and lifecycle", () => {
  it("reports blocked autoplay and replays after a successful unlock", async () => {
    const { manager, howls, flags } = setup();
    const statuses: string[] = [];
    manager.onStatus((status) => statuses.push(status));
    flags.blocked = true;
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    expect(manager.getStatus()).toBe("blocked");
    flags.unlock = false;
    await expect(manager.unlock()).resolves.toBe(false);
    flags.blocked = false;
    flags.unlock = true;
    await expect(manager.unlock()).resolves.toBe(true);
    expect(howls[0]?.playingNow).toBe(true);
    expect(manager.getStatus()).toBe("ready");
    expect(statuses).toEqual(["blocked", "ready"]);
  });

  it("falls back to MP3 after a decode error, then reports an error", async () => {
    const { manager, howls, playing } = setup();
    await manager.playBgm({ kind: "thinking", variant: "puzzle" });
    howls[0]?.emit("loaderror");
    expect(howls[1]?.options.src).toEqual(["/audio/02-thinking/bgm-think-puzzle.mp3"]);
    expect(howls[0]?.unloaded).toBe(true);
    expect(playing()).toEqual([howls[1]]);
    howls[1]?.emit("loaderror");
    expect(manager.getStatus()).toBe("error");
  });

  it("previews exclusively and stops previews for live music", async () => {
    const { manager, howls } = setup();
    await manager.previewLobby("kabuki");
    await manager.previewLobby("matcha");
    expect(howls[0]?.unloaded).toBe(true);
    expect(manager.previewing).toBe("matcha");
    await manager.playBgm({ kind: "leaderboard" });
    expect(howls[1]?.unloaded).toBe(true);
    expect(manager.previewing).toBeNull();
  });

  it("only the current lease stops audio (StrictMode double effects, route changes)", async () => {
    const { manager, howls, playing } = setup();
    const first = manager.acquire();
    await manager.playBgm({ kind: "lobby", id: "kabuki" });
    const second = manager.acquire(); // StrictMode remount / new route took ownership
    manager.release(first); // stale cleanup
    expect(playing()).toHaveLength(1);
    await manager.playSfx("hyoshigiStart");
    manager.release(second);
    expect(playing()).toHaveLength(0);
    expect(howls.every((howl) => howl.unloaded)).toBe(true);
  });
});
