/**
 * Audio preferences (Audio revision 2026-10-31; US-07/13/18/19; TASK-130).
 *
 * - Persisted with Zustand `persist` under `kabuki-neko-audio-prefs` (version 1):
 *   `isMuted` false, `masterVolume` 0.8, `bgmVolume` 0.7, `sfxVolume` 0.9,
 *   `currentLobbyTrackId` null. Only these preferences are written; the Streamer thinking-music
 *   opt-in (default off) is session-local and never persisted. There is no global room mute: these
 *   preferences only affect this device.
 * - Every write and every hydrated value is validated: volumes are clamped to 0–1 and non-finite
 *   numbers fall back to the default; a lobby track id must be a safe track id. Corrupt or
 *   foreign stored data never breaks the store.
 * - SSR-safe: hydration is skipped at creation (`skipHydration`) and done once in the browser via
 *   `hydrateAudioPreferences()`, so the server render and the first client render match. If
 *   storage is denied, an in-memory fallback keeps the choices for the page session.
 * - Muting never resets the volumes.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  AUDIO_PREFERENCE_DEFAULTS,
  AUDIO_PREFERENCE_STORAGE_KEY,
} from "@kabuki-neko/shared/constants/audio";
import { bgmTrackSchema } from "@kabuki-neko/shared/schemas/audio.schema";

/** Persisted audio preferences. */
export interface AudioPreferences {
  isMuted: boolean;
  masterVolume: number;
  bgmVolume: number;
  sfxVolume: number;
  currentLobbyTrackId: string | null;
}

/** Store state and actions. */
export interface AudioStore extends AudioPreferences {
  /** Streamer thinking-music opt-in on this device (session only; default off). */
  streamerBgmOptIn: boolean;
  toggleMute(): void;
  setMuted(muted: boolean): void;
  setMasterVolume(volume: number): void;
  setBgmVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  setCurrentLobbyTrackId(id: string | null): void;
  setStreamerBgmOptIn(enabled: boolean): void;
  resetPreferences(): void;
}

/** Clamps a volume to 0–1; non-finite values use `fallback`. */
export function clampVolume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

/** Validated preferences from untrusted stored data. */
export function sanitizePreferences(value: unknown): AudioPreferences {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const lobby = raw.currentLobbyTrackId;
  return {
    isMuted: typeof raw.isMuted === "boolean" ? raw.isMuted : AUDIO_PREFERENCE_DEFAULTS.isMuted,
    masterVolume: clampVolume(raw.masterVolume, AUDIO_PREFERENCE_DEFAULTS.masterVolume),
    bgmVolume: clampVolume(raw.bgmVolume, AUDIO_PREFERENCE_DEFAULTS.bgmVolume),
    sfxVolume: clampVolume(raw.sfxVolume, AUDIO_PREFERENCE_DEFAULTS.sfxVolume),
    currentLobbyTrackId:
      typeof lobby === "string" && bgmTrackSchema.safeParse(lobby).success ? lobby : null,
  };
}

/** localStorage that degrades to memory when access is denied or throws. */
function resilientStorage(): StateStorage {
  const memory = new Map<string, string>();
  const local = (): Storage | null => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    getItem(name) {
      try {
        const value = local()?.getItem(name);
        if (value !== null && value !== undefined) return value;
      } catch {
        // Denied: use the memory copy.
      }
      return memory.get(name) ?? null;
    },
    setItem(name, value) {
      memory.set(name, value);
      try {
        local()?.setItem(name, value);
      } catch {
        // Denied or full: the memory copy still applies.
      }
    },
    removeItem(name) {
      memory.delete(name);
      try {
        local()?.removeItem(name);
      } catch {
        // Ignore.
      }
    },
  };
}

/** The audio preference store (React hook + vanilla API). */
export const useAudioStore = create<AudioStore>()(
  persist(
    (set) => ({
      ...AUDIO_PREFERENCE_DEFAULTS,
      streamerBgmOptIn: false,
      toggleMute: () => set((state) => ({ isMuted: !state.isMuted })),
      setMuted: (muted) => set({ isMuted: muted === true }),
      setMasterVolume: (volume) =>
        set((state) => ({ masterVolume: clampVolume(volume, state.masterVolume) })),
      setBgmVolume: (volume) =>
        set((state) => ({ bgmVolume: clampVolume(volume, state.bgmVolume) })),
      setSfxVolume: (volume) =>
        set((state) => ({ sfxVolume: clampVolume(volume, state.sfxVolume) })),
      setCurrentLobbyTrackId: (id) =>
        set({
          currentLobbyTrackId: id !== null && bgmTrackSchema.safeParse(id).success ? id : null,
        }),
      setStreamerBgmOptIn: (enabled) => set({ streamerBgmOptIn: enabled === true }),
      resetPreferences: () => set({ ...AUDIO_PREFERENCE_DEFAULTS }),
    }),
    {
      name: AUDIO_PREFERENCE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(resilientStorage),
      skipHydration: true,
      partialize: (state): AudioPreferences => ({
        isMuted: state.isMuted,
        masterVolume: state.masterVolume,
        bgmVolume: state.bgmVolume,
        sfxVolume: state.sfxVolume,
        currentLobbyTrackId: state.currentLobbyTrackId,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizePreferences(persisted) }),
    },
  ),
);

/** Hydrates the preferences from storage once in the browser (call from an effect). */
export async function hydrateAudioPreferences(): Promise<void> {
  if (typeof window === "undefined" || useAudioStore.persist.hasHydrated()) return;
  await useAudioStore.persist.rehydrate();
}
