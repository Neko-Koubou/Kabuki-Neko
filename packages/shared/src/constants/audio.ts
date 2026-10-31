/** SA §4.4 baseline catalogue. Asset packaging/rights verification is TASK-114. */
export const AUDIO_TRACKS = [
  {
    id: "kabuki-matsuri",
    labelKey: "common.audio.kabukiMatsuri",
    lobbyUrl: "/audio/lobby.mp3",
    tickUrl: "/audio/tick.mp3",
    revealUrl: "/audio/reveal.mp3",
    podiumUrl: "/audio/podium.mp3",
  },
] as const;
export type AudioTrack = (typeof AUDIO_TRACKS)[number];
export const DEFAULT_AUDIO_TRACK = AUDIO_TRACKS[0].id;
