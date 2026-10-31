import { expect, it } from "vitest";
import { AUDIO_TIMING } from "./audio";
import { GAME_PHASES, GAME_TIMING } from "./game";

it("keeps the eight authoritative phases and leaves time for the final podium cue", () => {
  expect(GAME_PHASES).toHaveLength(8);
  expect(GAME_TIMING.podiumMs).toBe(8_000);
  expect([
    AUDIO_TIMING.podiumThirdMs,
    AUDIO_TIMING.podiumSecondMs,
    AUDIO_TIMING.podiumFirstMs,
  ]).toEqual([1_200, 3_500, 6_500]);
  expect(AUDIO_TIMING.podiumFirstMs).toBeLessThan(GAME_TIMING.podiumMs);
  expect(GAME_TIMING.graceMs).toBe(1_500);
  expect(GAME_TIMING.countdownMs).toBe(3_000);
  expect(GAME_TIMING.previewMs).toBe(4_000);
});
