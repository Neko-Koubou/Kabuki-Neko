/** Wire values from SA §3.1 and §5.5; grace is part of ANSWERING. */
export const QUESTION_TYPES = [
  "SINGLE_CHOICE",
  "TRUE_FALSE",
  "MULTIPLE_SELECT",
  "TYPE_ANSWER",
  "ORDER_PUZZLE",
  "POLL",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const GAME_PHASES = [
  "LOBBY",
  "GAME_START_COUNTDOWN",
  "QUESTION_PREVIEW",
  "QUESTION_ANSWERING",
  "ANSWER_REVEAL",
  "LEADERBOARD",
  "PODIUM",
  "FINISHED",
] as const;
export type GamePhase = (typeof GAME_PHASES)[number];
export const DISPLAY_MODES = ["PROJECTOR", "STREAMER"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export const REVEAL_MODES = ["NONE", "GRID_3X3", "GRID_5X5", "BLUR"] as const;
export type RevealMode = (typeof REVEAL_MODES)[number];
export const TIME_LIMITS_SEC = [5, 10, 20, 30, 60, 90, 120, 240] as const;
export const POINTS_MULTIPLIERS = [0, 1, 2] as const;
export const AVATAR_STYLES = [
  "bottts",
  "adventurer",
  "fun-emoji",
  "pixel-art",
  "lorelei",
  "avataaars",
] as const;
export const USER_ROLES = ["CREATOR", "SUPERADMIN"] as const;
export const REGISTRATION_MODES = ["SINGLE_ADMIN", "INVITE_ONLY", "PUBLIC"] as const;
export const QUIZ_VISIBILITIES = ["PRIVATE", "PUBLIC"] as const;
export const GAME_TIMING = {
  countdownMs: 3_000,
  previewMs: 4_000,
  graceMs: 1_500,
  podiumMs: 8_000,
} as const;
export const SCORING = {
  basePoints: 1_000,
  instantThresholdMs: 500,
  minimumSpeedFactor: 0.5,
  streakBonusStep: 100,
  maximumStreakBonus: 500,
  fuzzyKeyMinCodePoints: 6,
  fuzzyMaxDistance: 1,
  leaderboardSize: 5,
  podiumSize: 3,
} as const;
