import { describe, expect, it } from "vitest";
import {
  audioManifestSchema,
  bgmTrackCreateSchema,
  bgmTrackSchema,
  lobbyTracksSchema,
} from "./audio.schema";
import { publicConfigSchema } from "./system.schema";

function cue(folder: string, name: string, loop = false) {
  return {
    src: [`/audio/${folder}/${name}.webm`, `/audio/${folder}/${name}.mp3`],
    volume: 0.7,
    ...(loop ? { loop: true } : {}),
  };
}
function fixture(count = 4) {
  const ids = ["kabuki", "neko8bit", "showtime", "matcha", "new-track"].slice(0, count);
  return {
    lobby: ids.map((id) => ({ id, label: id, ...cue("01-lobby", `bgm-lobby-${id}`, true) })),
    thinking: {
      sprint: cue("02-thinking", "bgm-think-sprint", true),
      standard: cue("02-thinking", "bgm-think-standard", true),
      puzzle: cue("02-thinking", "bgm-think-puzzle", true),
    },
    leaderboard: { groove: cue("03-leaderboard", "bgm-leaderboard-groove", true) },
    podium: {
      buildup: cue("04-podium", "bgm-podium-buildup", true),
      victory: cue("04-podium", "bgm-podium-victory", true),
    },
    sfx: {
      hyoshigiStart: cue("05-sfx", "sfx-hyoshigi-start"),
      nekoPop: { ...cue("05-sfx", "sfx-neko-pop"), throttleMs: 150 },
      questionWhoosh: cue("05-sfx", "sfx-question-whoosh"),
      tickLast5s: cue("05-sfx", "sfx-tick-last5s"),
      timeupGong: cue("05-sfx", "sfx-timeup-gong"),
      revealBar: cue("05-sfx", "sfx-reveal-bar"),
      answerCorrect: cue("05-sfx", "sfx-answer-correct"),
      answerWrong: cue("05-sfx", "sfx-answer-wrong"),
      streakFire: cue("05-sfx", "sfx-streak-fire"),
      podiumSpotlight: cue("05-sfx", "sfx-podium-spotlight"),
    },
  };
}
describe("manifest-backed audio contract", () => {
  it.each([3, 4, 5])("accepts %i actual lobby entries without a fixed track enum", (count) => {
    const result = audioManifestSchema.parse(fixture(count));
    expect(result.lobby).toHaveLength(count);
    expect(Object.keys(result.sfx)).toHaveLength(10);
    expect(
      publicConfigSchema.parse({
        instanceName: "Kabuki Neko",
        defaultLocale: "id",
        registrationMode: "PUBLIC",
        limits: { imageMb: 5, audioMb: 10, videoMb: 25 },
        catalogVersion: "1",
        audioTracks: result.lobby,
      }).audioTracks,
    ).toHaveLength(count);
  });
  it("defaults create to random and retains safe legacy/unknown IDs for playback fallback", () => {
    expect(bgmTrackCreateSchema.parse(undefined)).toBe("random");
    for (const id of ["random", "kabuki", "kabuki-matsuri", "custom-track"])
      expect(bgmTrackSchema.parse(id)).toBe(id);
    for (const id of ["../track", "/audio/x", "https://evil.test/x", "x?url=x", ""])
      expect(bgmTrackSchema.safeParse(id).success).toBe(false);
  });
  it("rejects duplicate/missing lobby, reserved IDs and mismatched source pairs", () => {
    const manifest = fixture();
    const first = manifest.lobby[0];
    expect(lobbyTracksSchema.safeParse([first, first]).success).toBe(false);
    expect(lobbyTracksSchema.safeParse([]).success).toBe(false);
    expect(lobbyTracksSchema.safeParse([{ ...first, id: "random" }]).success).toBe(false);
    for (const src of [
      ["/audio/01-lobby/bgm-lobby-kabuki.mp3", "/audio/01-lobby/bgm-lobby-kabuki.webm"],
      ["/audio/01-lobby/bgm-lobby-kabuki.webm", "/audio/01-lobby/bgm-lobby-other.mp3"],
      ["/audio/01-lobby/../secret.webm", "/audio/secret.mp3"],
      ["https://evil.test/x.webm", "https://evil.test/x.mp3"],
      ["/audio/01-lobby/bgm-lobby-kabuki.webm?token=x", "/audio/01-lobby/bgm-lobby-kabuki.mp3"],
      ["/audio/01-lobby/bgm-lobby-kabuki.webm"],
    ])
      expect(lobbyTracksSchema.safeParse([{ ...first, src }]).success).toBe(false);
  });
  it("requires all cues, exact safe paths, bounded volume and one-shot SFX", () => {
    const manifest = fixture();
    expect(
      audioManifestSchema.safeParse({
        ...manifest,
        sfx: { ...manifest.sfx, timeupGong: undefined },
      }).success,
    ).toBe(false);
    expect(
      audioManifestSchema.safeParse({
        ...manifest,
        sfx: { ...manifest.sfx, nekoPop: { ...manifest.sfx.nekoPop, throttleMs: 0 } },
      }).success,
    ).toBe(false);
    expect(
      audioManifestSchema.safeParse({
        ...manifest,
        sfx: { ...manifest.sfx, answerWrong: { ...manifest.sfx.answerWrong, loop: true } },
      }).success,
    ).toBe(false);
    for (const volume of [-0.1, 1.1, Infinity, NaN])
      expect(lobbyTracksSchema.safeParse([{ ...manifest.lobby[0], volume }]).success).toBe(false);
    expect(
      audioManifestSchema.safeParse({
        ...manifest,
        thinking: { ...manifest.thinking, puzzle: cue("02-thinking", "unknown", true) },
      }).success,
    ).toBe(false);
    expect(audioManifestSchema.safeParse({ phases: manifest }).success).toBe(false);
  });
});
