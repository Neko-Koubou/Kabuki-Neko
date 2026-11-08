/**
 * TASK-130A coverage for the audio orchestration with a recording fake manager and fake timers:
 * every phase for host and player (all ten SFX across both roles), 5 s vs 10 s sprint questions,
 * puzzle priority, hurry-up rate and ticks with a rate reset, hidden-tab tick skipping without
 * replay, recovery into reveal/podium/FINISHED (8000 ms podium) without replaying past cues, player
 * results incl. POLL/NOT_ELIGIBLE and streaks, Streamer opt-in vs Projector silence, vibration with
 * and without the API, gesture unlock with retry, lobby pick/cycle stability and no duplicates.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioManifestSchema, type AudioManifest } from "@kabuki-neko/shared/schemas/audio.schema";
import type { AudioManager, BgmKey } from "@/lib/audio-manager";
import type { RoomSnapshot } from "@/stores/game.store";
import { useAudioStore } from "@/stores/useAudioStore";
import { thinkingVariant, useAudioEngine, type AudioSignal } from "./useAudioEngine";

const T0 = 1_700_000_000_000;
const SESSION = "1d0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const ME = "2d0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";

/** Schema-valid manifest with two lobby tracks. */
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

/** One stable manifest object (as in production, where it is loaded once). */
const MANIFEST = manifest();

/** Key → readable id. */
function bgmId(key: BgmKey) {
  return key.kind === "lobby"
    ? `lobby:${key.id}`
    : key.kind === "leaderboard"
      ? "leaderboard"
      : `${key.kind}:${key.variant}`;
}

/** Recording manager double. */
function fakeManager() {
  const calls: string[] = [];
  let current: string | null = null;
  let unlockResult = true;
  const manager = {
    acquire: vi.fn(() => 7),
    release: vi.fn(() => calls.push("release")),
    setPreferences: vi.fn(),
    setManifest: vi.fn(),
    playBgm: vi.fn(
      async (
        key: BgmKey,
        options?: { volume?: number; fadeInMs?: number; crossfadeMs?: number },
      ) => {
        const id = bgmId(key);
        if (current === id) return true;
        current = id;
        const suffix = `${options?.volume ? `@${options.volume}` : ""}${options?.fadeInMs ? `+${options.fadeInMs}` : ""}${options?.crossfadeMs ? `~${options.crossfadeMs}` : ""}`;
        calls.push(`bgm:${id}${suffix}`);
        return true;
      },
    ),
    stopBgm: vi.fn((fade = 0) => {
      if (current) calls.push(`stop:${current}${fade ? `/${fade}` : ""}`);
      current = null;
    }),
    setBgmRate: vi.fn((rate: number) => calls.push(`rate:${rate}`)),
    playSfx: vi.fn(async (id: string) => {
      calls.push(`sfx:${id}`);
      return true;
    }),
    unlock: vi.fn(async () => unlockResult),
    stopAll: vi.fn(() => {
      current = null;
    }),
    getStatus: () => "idle" as const,
    onStatus: () => () => {},
    get currentBgm() {
      return current;
    },
  };
  return {
    manager: manager as unknown as AudioManager,
    raw: manager,
    calls,
    setUnlock: (value: boolean) => (unlockResult = value),
  };
}

/** Loose snapshot builder (the engine reads only audio-relevant fields). */
function room(
  role: "host" | "player",
  phase: string,
  extra: Record<string, unknown> = {},
): RoomSnapshot {
  return {
    sessionId: SESSION,
    pinCode: "112233",
    role,
    phase,
    phaseVersion: 1,
    displayMode: "PROJECTOR",
    bgmTrack: "random",
    players: [],
    question: null,
    timing: {
      phaseStartedAt: T0,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    podium: [],
    self: { playerId: ME, score: 0, streak: 0, rank: null, acceptedAnswer: null, result: null },
    ...extra,
  } as unknown as RoomSnapshot;
}

/** Answering snapshot for a question of `seconds` starting at `start`. */
function answering(
  role: "host" | "player",
  seconds: number,
  start: number,
  type = "SINGLE_CHOICE",
  phaseVersion = 4,
) {
  return room(role, "QUESTION_ANSWERING", {
    phaseVersion,
    question: { id: `q-${phaseVersion}`, type, timeLimitSec: seconds },
    timing: {
      phaseStartedAt: start,
      phaseEndsAt: null,
      questionStartedAt: start,
      inputClosesAt: start + seconds * 1000,
      acceptanceClosesAt: start + seconds * 1000 + 1500,
    },
  });
}

/** Mounts the engine and gives control over time and snapshots. */
function mountEngine(
  role: "host" | "player",
  initial: RoomSnapshot | null,
  extra: { vibrate?: ((p: number | number[]) => void) | null; hidden?: () => boolean } = {},
) {
  const fake = fakeManager();
  const api: {
    signal: ((event: AudioSignal, id?: string) => void) | null;
    cycle: (() => void) | null;
  } = { signal: null, cycle: null };
  function Engine({ snapshot }: { snapshot: RoomSnapshot | null }) {
    const engine = useAudioEngine({
      role,
      snapshot,
      serverNow: () => Date.now(), // fake clock: moves together with the timers
      manifest: MANIFEST,
      manager: fake.manager,
      vibrate: extra.vibrate === undefined ? null : extra.vibrate,
      isHidden: extra.hidden ?? (() => false),
      random: () => 0.6,
    });
    api.signal = engine.signal;
    api.cycle = engine.cycleNextLobbyTrack;
    return null;
  }
  const view = render(<Engine snapshot={initial} />);
  return {
    ...fake,
    view,
    show: (snapshot: RoomSnapshot | null) =>
      act(() => view.rerender(<Engine snapshot={snapshot} />)),
    advance: (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      }),
    setNow: (value: number) => {
      vi.setSystemTime(value);
    },
    signal: (event: AudioSignal, id?: string) => act(() => api.signal?.(event, id)),
    cycle: () => act(() => api.cycle?.()),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useAudioStore.setState({
    isMuted: false,
    masterVolume: 0.8,
    bgmVolume: 0.7,
    sfxVolume: 0.9,
    currentLobbyTrackId: null,
    streamerBgmOptIn: false,
  });
});

describe("host choreography", () => {
  it("runs every phase from lobby to FINISHED with the host cues in order", async () => {
    const engine = mountEngine("host", room("host", "LOBBY"));
    await act(async () => {});
    expect(engine.calls).toEqual(["bgm:lobby:matcha"]); // random 0.6 × 2 tracks → index 1, once
    expect(useAudioStore.getState().currentLobbyTrackId).toBe("matcha");
    engine.signal("playerJoined", "p1");
    engine.show(room("host", "LOBBY", { players: [{ id: "p1" }] })); // re-render: no re-roll, no restart

    engine.calls.length = 0;
    engine.show(
      room("host", "GAME_START_COUNTDOWN", {
        phaseVersion: 2,
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 3000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    expect(engine.calls).toEqual(["stop:lobby:matcha/400"]);
    engine.advance(400);
    expect(engine.calls).toEqual(["stop:lobby:matcha/400", "sfx:hyoshigiStart"]);

    engine.calls.length = 0;
    const previewAt = T0 + 3000;
    engine.setNow(previewAt);
    engine.show(
      room("host", "QUESTION_PREVIEW", {
        phaseVersion: 3,
        timing: {
          phaseStartedAt: previewAt,
          phaseEndsAt: previewAt + 4000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    expect(engine.calls).toEqual(["sfx:questionWhoosh"]);

    engine.calls.length = 0;
    const start = previewAt + 4000;
    engine.setNow(start);
    engine.show(answering("host", 20, start));
    expect(engine.calls).toEqual(["bgm:thinking:standard"]);
    engine.advance(14_000); // 6 s left: nothing yet
    expect(engine.calls).toEqual(["bgm:thinking:standard"]);
    engine.advance(6_000); // through the last five seconds to the deadline
    expect(engine.calls).toEqual([
      "bgm:thinking:standard",
      "rate:1.22",
      "sfx:tickLast5s",
      "sfx:tickLast5s",
      "sfx:tickLast5s",
      "sfx:tickLast5s",
      "sfx:tickLast5s",
      "rate:1",
      "stop:thinking:standard",
    ]);

    engine.calls.length = 0;
    const revealAt = start + 21_500;
    engine.setNow(revealAt);
    engine.show(
      room("host", "ANSWER_REVEAL", {
        phaseVersion: 5,
        question: { id: "q-4", type: "SINGLE_CHOICE", timeLimitSec: 20 },
        timing: {
          phaseStartedAt: revealAt,
          phaseEndsAt: null,
          questionStartedAt: start,
          inputClosesAt: start + 20_000,
          acceptanceClosesAt: start + 21_500,
        },
      }),
    );
    expect(engine.calls).toEqual(["rate:1", "sfx:timeupGong"]);
    engine.advance(450);
    expect(engine.calls).toEqual(["rate:1", "sfx:timeupGong", "sfx:revealBar"]);

    engine.calls.length = 0;
    engine.show(
      room("host", "LEADERBOARD", {
        phaseVersion: 6,
        timing: {
          phaseStartedAt: revealAt + 5000,
          phaseEndsAt: null,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    expect(engine.calls).toEqual(["bgm:leaderboard+300"]);

    engine.calls.length = 0;
    const podiumAt = revealAt + 10_000;
    engine.setNow(podiumAt);
    const podium = [1, 2, 3].map((rank) => ({ playerId: `p${rank}`, rank }));
    const podiumRoom = room("host", "PODIUM", {
      phaseVersion: 7,
      podium,
      timing: {
        phaseStartedAt: podiumAt,
        phaseEndsAt: podiumAt + 8000,
        questionStartedAt: null,
        inputClosesAt: null,
        acceptanceClosesAt: null,
      },
    });
    engine.show(podiumRoom);
    expect(engine.calls).toEqual(["bgm:podium:buildup"]);
    engine.advance(1_200);
    engine.advance(2_300);
    engine.advance(3_000);
    expect(engine.calls).toEqual([
      "bgm:podium:buildup",
      "sfx:podiumSpotlight",
      "sfx:podiumSpotlight",
      "sfx:podiumSpotlight",
      "bgm:podium:victory@0.95",
    ]);
    engine.show(podiumRoom); // re-render after victory never regresses to buildup
    engine.advance(1_500); // 8000 ms → FINISHED keeps the victory loop without restarting
    engine.show(
      room("host", "FINISHED", {
        phaseVersion: 8,
        podium,
        timing: {
          phaseStartedAt: podiumAt + 8000,
          phaseEndsAt: null,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    expect(engine.calls).toEqual([
      "bgm:podium:buildup",
      "sfx:podiumSpotlight",
      "sfx:podiumSpotlight",
      "sfx:podiumSpotlight",
      "bgm:podium:victory@0.95",
    ]);
    expect(engine.raw.playSfx).toHaveBeenCalledWith("nekoPop", { eventId: "join:p1" });
  });

  it("chooses sprint/standard/puzzle with puzzle priority and limits hurry-up to ≥10 s questions", async () => {
    expect([
      thinkingVariant({ type: "SINGLE_CHOICE", timeLimitSec: 5 }),
      thinkingVariant({ type: "SINGLE_CHOICE", timeLimitSec: 15 }),
      thinkingVariant({ type: "SINGLE_CHOICE", timeLimitSec: 30 }),
      thinkingVariant({ type: "ORDER_PUZZLE", timeLimitSec: 10 }),
      thinkingVariant({ type: "POLL", timeLimitSec: 60 }),
    ]).toEqual(["sprint", "sprint", "standard", "puzzle", "puzzle"]);

    const short = mountEngine("host", answering("host", 5, T0));
    short.advance(5_000);
    expect(short.calls).toEqual(["bgm:thinking:sprint", "rate:1", "stop:thinking:sprint"]); // no hurry-up or ticks
    short.view.unmount();

    const ten = mountEngine("host", answering("host", 10, T0));
    ten.advance(10_000);
    expect(ten.calls.filter((call) => call === "sfx:tickLast5s")).toHaveLength(5);
    expect(ten.calls).toContain("rate:1.22");
    expect(ten.calls.at(-2)).toBe("rate:1");
  });

  it("skips ticks while the tab is hidden and never replays them", () => {
    let hidden = false;
    const engine = mountEngine("host", answering("host", 20, T0), { hidden: () => hidden });
    engine.advance(15_100); // 4.9 s left → rate + tick 5
    hidden = true;
    engine.advance(2_000); // seconds 4 and 3 pass while hidden
    hidden = false;
    engine.advance(2_900);
    const ticks = engine.calls.filter((call) => call === "sfx:tickLast5s");
    expect(ticks).toHaveLength(3); // 5, then 2 and 1 — 4 and 3 skipped for good
    expect(engine.calls.filter((call) => call === "rate:1.22")).toHaveLength(1);
  });

  it("recovers into reveal, podium and FINISHED without replaying past cues", () => {
    const reveal = mountEngine("host", null);
    reveal.setNow(T0 + 1_000);
    reveal.show(
      room("host", "ANSWER_REVEAL", {
        phaseVersion: 9,
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: null,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    reveal.advance(2_000);
    expect(reveal.calls.filter((call) => call.startsWith("sfx"))).toEqual([]);
    reveal.view.unmount();

    const podium = [1, 2, 3].map((rank) => ({ playerId: `p${rank}`, rank }));
    const before = mountEngine("host", null);
    before.setNow(T0 + 4_000); // after 3rd and 2nd, before 1st
    before.show(
      room("host", "PODIUM", {
        phaseVersion: 10,
        podium,
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 8000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    before.advance(2_500);
    expect(before.calls).toEqual([
      "bgm:podium:buildup",
      "sfx:podiumSpotlight",
      "bgm:podium:victory@0.95",
    ]);
    before.view.unmount();

    const after = mountEngine("host", null);
    after.setNow(T0 + 7_000); // after the first-place cue
    after.show(
      room("host", "PODIUM", {
        phaseVersion: 10,
        podium,
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 8000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    after.advance(2_000);
    expect(after.calls).toEqual(["bgm:podium:victory@0.95"]);
    after.view.unmount();

    const finished = mountEngine("host", null);
    finished.setNow(T0 + 9_000);
    finished.show(
      room("host", "FINISHED", {
        phaseVersion: 11,
        podium,
        timing: {
          phaseStartedAt: T0 + 8000,
          phaseEndsAt: null,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    expect(finished.calls).toEqual(["bgm:podium:victory@0.95"]);

    const empty = mountEngine(
      "host",
      room("host", "PODIUM", {
        phaseVersion: 12,
        podium: [],
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 8000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    empty.advance(8_000);
    expect(empty.calls).toEqual([]); // no winners → no winner effects or victory
  });

  it("keeps the lobby choice, cycles with a crossfade, and stops scheduled cues on exit", async () => {
    const engine = mountEngine("host", room("host", "LOBBY", { bgmTrack: "kabuki" }));
    await act(async () => {});
    expect(engine.calls).toEqual(["bgm:lobby:kabuki"]);
    engine.cycle();
    engine.show(room("host", "LOBBY", { bgmTrack: "kabuki", players: [{ id: "x" }] }));
    expect(engine.calls).toEqual(["bgm:lobby:kabuki", "bgm:lobby:matcha~500"]);
    engine.show(room("host", "ANSWER_REVEAL", { phaseVersion: 3 }));
    engine.view.unmount(); // revealBar (450 ms) must not fire after exit
    engine.advance(1_000);
    expect(engine.calls).not.toContain("sfx:revealBar");
    expect(engine.raw.release).toHaveBeenCalledWith(7);
  });
});

describe("player choreography", () => {
  it("plays results and streaks, ignores POLL/NOT_ELIGIBLE, and vibrates only where supported", () => {
    const vibrate = vi.fn();
    const engine = mountEngine(
      "player",
      room("player", "QUESTION_ANSWERING", {
        question: { id: "q", type: "SINGLE_CHOICE", timeLimitSec: 20 },
      }),
      { vibrate },
    );
    expect(engine.calls).toEqual([]); // Projector: no player music
    const result = (kind: string, streak = 1) => ({
      result: kind,
      currentStreak: streak,
      isCorrect: kind === "CORRECT" ? true : null,
    });
    // Each reveal phase starts now (late cues from an older start would be skipped).
    const startingNow = () => ({
      phaseStartedAt: Date.now(),
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    });
    engine.show(
      room("player", "ANSWER_REVEAL", {
        phaseVersion: 2,
        timing: startingNow(),
        self: { playerId: ME, result: result("CORRECT", 3) },
      }),
    );
    engine.advance(350);
    expect(engine.calls).toEqual(["sfx:answerCorrect", "sfx:streakFire"]);
    expect(vibrate).toHaveBeenCalledWith([80, 50, 80]);
    engine.calls.length = 0;
    engine.show(
      room("player", "ANSWER_REVEAL", {
        phaseVersion: 3,
        timing: startingNow(),
        self: { playerId: ME, result: result("UNANSWERED") },
      }),
    );
    expect(engine.calls).toEqual(["sfx:answerWrong"]);
    expect(vibrate).toHaveBeenLastCalledWith(250);
    engine.calls.length = 0;
    engine.show(
      room("player", "ANSWER_REVEAL", {
        phaseVersion: 4,
        timing: startingNow(),
        self: { playerId: ME, result: result("POLL") },
      }),
    );
    engine.show(
      room("player", "ANSWER_REVEAL", {
        phaseVersion: 5,
        timing: startingNow(),
        self: { playerId: ME, result: result("NOT_ELIGIBLE") },
      }),
    );
    engine.advance(1_000);
    expect(engine.calls).toEqual([]);
    engine.view.unmount();

    const noVibration = mountEngine("player", null, { vibrate: null });
    noVibration.show(
      room("player", "ANSWER_REVEAL", {
        phaseVersion: 6,
        timing: startingNow(),
        self: { playerId: ME, result: result("PARTIAL") },
      }),
    );
    expect(noVibration.calls).toEqual(["sfx:answerCorrect"]); // absent API: sound only, no crash
  });

  it("hears its own podium rank, signals, and Streamer thinking music only after opting in", () => {
    const engine = mountEngine(
      "player",
      room("player", "PODIUM", {
        podium: [
          { playerId: "x", rank: 1 },
          { playerId: ME, rank: 2 },
        ],
        timing: {
          phaseStartedAt: T0,
          phaseEndsAt: T0 + 8000,
          questionStartedAt: null,
          inputClosesAt: null,
          acceptanceClosesAt: null,
        },
      }),
    );
    engine.advance(3_499);
    expect(engine.calls).toEqual([]);
    engine.advance(1);
    expect(engine.calls).toEqual(["sfx:answerCorrect"]);
    engine.signal("ownJoin", "j1");
    engine.signal("avatarRandomized", "a1");
    engine.signal("answerAccepted", "s1");
    engine.signal("playerJoined", "other"); // host-only signal
    expect(engine.raw.playSfx.mock.calls.filter(([id]) => id === "nekoPop")).toHaveLength(3);

    engine.calls.length = 0;
    const streamer = (start: number, version: number) =>
      ({
        ...answering("player", 20, start, "SINGLE_CHOICE", version),
        displayMode: "STREAMER",
      }) as RoomSnapshot;
    engine.setNow(T0 + 10_000);
    engine.show(streamer(T0 + 10_000, 8));
    expect(engine.calls).toEqual([]); // not opted in
    act(() => useAudioStore.getState().setStreamerBgmOptIn(true));
    expect(engine.calls).toEqual(["bgm:thinking:standard"]);
    engine.advance(20_000); // stops at the input deadline
    expect(engine.calls).toEqual(["bgm:thinking:standard", "stop:thinking:standard"]);
    expect(engine.calls).not.toContain("sfx:tickLast5s"); // players never tick
  });
});

describe("unlock", () => {
  it("unlocks on the first gesture and keeps retrying while blocked", async () => {
    const engine = mountEngine("host", null);
    engine.setUnlock(false);
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(engine.raw.unlock).toHaveBeenCalledTimes(1);
    engine.setUnlock(true);
    await act(async () => {
      window.dispatchEvent(new Event("keydown"));
    });
    expect(engine.raw.unlock).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event("touchstart"));
    });
    expect(engine.raw.unlock).toHaveBeenCalledTimes(2); // listeners removed once unlocked
  });
});
