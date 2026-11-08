/**
 * TASK-130 coverage for the audio preference store: defaults, clamping of every volume (including
 * non-finite input), mute that keeps volumes, persistence of exactly the preference fields under
 * `kabuki-neko-audio-prefs` (the Streamer opt-in is never persisted), validated hydration from
 * stored data (corrupt values fall back), SSR-safe skipped hydration, and an in-memory fallback
 * when storage access is denied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_PREFERENCE_DEFAULTS,
  AUDIO_PREFERENCE_STORAGE_KEY,
} from "@kabuki-neko/shared/constants/audio";
import {
  clampVolume,
  hydrateAudioPreferences,
  sanitizePreferences,
  useAudioStore,
} from "./useAudioStore";

/** Stored preference JSON (zustand persist envelope). */
function stored() {
  const raw = localStorage.getItem(AUDIO_PREFERENCE_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown>; version: number }) : null;
}

beforeEach(() => {
  localStorage.clear();
  useAudioStore.setState({ ...AUDIO_PREFERENCE_DEFAULTS, streamerBgmOptIn: false });
});

describe("audio preferences", () => {
  it("starts from the revision defaults and clamps every volume", () => {
    const state = useAudioStore.getState();
    expect([
      state.isMuted,
      state.masterVolume,
      state.bgmVolume,
      state.sfxVolume,
      state.currentLobbyTrackId,
    ]).toEqual([false, 0.8, 0.7, 0.9, null]);
    state.setMasterVolume(1.7);
    state.setBgmVolume(-0.2);
    state.setSfxVolume(Number.NaN);
    expect(useAudioStore.getState().masterVolume).toBe(1);
    expect(useAudioStore.getState().bgmVolume).toBe(0);
    expect(useAudioStore.getState().sfxVolume).toBe(0.9); // NaN keeps the previous value
    expect(clampVolume(Infinity, 0.5)).toBe(0.5);
    expect(clampVolume("0.4", 0.5)).toBe(0.5);
  });

  it("mutes without resetting volumes and persists only the preference fields", () => {
    const state = useAudioStore.getState();
    state.setBgmVolume(0.35);
    state.toggleMute();
    state.setStreamerBgmOptIn(true);
    state.setCurrentLobbyTrackId("neko8bit");
    expect(useAudioStore.getState()).toMatchObject({
      isMuted: true,
      bgmVolume: 0.35,
      streamerBgmOptIn: true,
    });
    const saved = stored();
    expect(saved?.version).toBe(1);
    expect(saved?.state).toEqual({
      isMuted: true,
      masterVolume: 0.8,
      bgmVolume: 0.35,
      sfxVolume: 0.9,
      currentLobbyTrackId: "neko8bit",
    });
    expect(saved?.state).not.toHaveProperty("streamerBgmOptIn");
    useAudioStore.getState().toggleMute();
    expect(useAudioStore.getState()).toMatchObject({ isMuted: false, bgmVolume: 0.35 });
    useAudioStore.getState().setCurrentLobbyTrackId("../../evil");
    expect(useAudioStore.getState().currentLobbyTrackId).toBeNull();
  });

  it("hydrates validated values from storage in the browser only", async () => {
    localStorage.setItem(
      AUDIO_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        state: {
          isMuted: "yes",
          masterVolume: 0.5,
          bgmVolume: 7,
          sfxVolume: null,
          currentLobbyTrackId: "matcha",
          extra: 1,
        },
        version: 1,
      }),
    );
    // Creation skipped hydration, so the first render matches the server defaults.
    expect(useAudioStore.getState().masterVolume).toBe(0.8);
    await hydrateAudioPreferences();
    expect(useAudioStore.getState()).toMatchObject({
      isMuted: false,
      masterVolume: 0.5,
      bgmVolume: 1,
      sfxVolume: 0.9,
      currentLobbyTrackId: "matcha",
    });
    expect(sanitizePreferences("garbage")).toEqual({ ...AUDIO_PREFERENCE_DEFAULTS });
  });

  it("keeps working in memory when storage is denied", () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
    expect(() => useAudioStore.getState().setSfxVolume(0.25)).not.toThrow();
    expect(useAudioStore.getState().sfxVolume).toBe(0.25);
    expect(() => useAudioStore.getState().toggleMute()).not.toThrow();
    expect(useAudioStore.getState().isMuted).toBe(true);
  });
});
