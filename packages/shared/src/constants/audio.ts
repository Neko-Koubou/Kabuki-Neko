/** User-approved audio revision (2026-10-31). Lobby entries come from disk/manifest. */
export const DEFAULT_AUDIO_TRACK = "random" as const;
export const AUDIO_MANIFEST_URL = "/audio/audio-manifest.json";
export const AUDIO_CREDITS_URL = "/audio/CREDITS.md";
export const AUDIO_PHASE_FOLDERS = [
  "01-lobby",
  "02-thinking",
  "03-leaderboard",
  "04-podium",
  "05-sfx",
] as const;
export const LOBBY_TRACK_METADATA: Readonly<
  Record<string, { readonly label: string; readonly volume: number }>
> = {
  kabuki: { label: "Kabuki Matsuri", volume: 0.7 },
  neko8bit: { label: "Neko 8-Bit Arcade", volume: 0.7 },
  showtime: { label: "Showtime Funk", volume: 0.7 },
  matcha: { label: "Matcha Chill Lo-Fi", volume: 0.65 },
};
export const BGM_DEFAULT_VOLUMES = {
  lobby: 0.7,
  thinking: { sprint: 0.8, standard: 0.75, puzzle: 0.7 },
  leaderboard: { groove: 0.75 },
  podium: { buildup: 0.85, victory: 0.9 },
} as const;
export const SFX_DEFINITIONS = {
  hyoshigiStart: { filename: "sfx-hyoshigi-start", volume: 1 },
  nekoPop: { filename: "sfx-neko-pop", volume: 0.8, throttleMs: 150 },
  questionWhoosh: { filename: "sfx-question-whoosh", volume: 0.9 },
  tickLast5s: { filename: "sfx-tick-last5s", volume: 0.95 },
  timeupGong: { filename: "sfx-timeup-gong", volume: 1 },
  revealBar: { filename: "sfx-reveal-bar", volume: 0.85 },
  answerCorrect: { filename: "sfx-answer-correct", volume: 0.9 },
  answerWrong: { filename: "sfx-answer-wrong", volume: 0.85 },
  streakFire: { filename: "sfx-streak-fire", volume: 0.95 },
  podiumSpotlight: { filename: "sfx-podium-spotlight", volume: 1 },
} as const;
export type SfxId = keyof typeof SFX_DEFINITIONS;
export const AUDIO_TIMING = {
  lobbyCrossfadeMs: 500,
  lobbyFadeOutMs: 400,
  leaderboardFadeInMs: 300,
  leaderboardFadeOutMs: 400,
  revealBarDelayMs: 450,
  streakFireDelayMs: 350,
  podiumThirdMs: 1_200,
  podiumSecondMs: 3_500,
  podiumFirstMs: 6_500,
  hurryUpSeconds: 5,
  hurryUpMinDurationSec: 10,
  hurryUpRate: 1.22,
  normalRate: 1,
  podiumVictoryVolume: 0.95,
} as const;
export const AUDIO_PREFERENCE_DEFAULTS = {
  isMuted: false,
  masterVolume: 0.8,
  bgmVolume: 0.7,
  sfxVolume: 0.9,
  currentLobbyTrackId: null,
} as const;
export const AUDIO_PREFERENCE_STORAGE_KEY = "kabuki-neko-audio-prefs";
