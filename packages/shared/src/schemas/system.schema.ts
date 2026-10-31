import { z } from "zod";
import { AUDIO_TRACKS } from "../constants/audio";
import { REGISTRATION_MODES } from "../constants/game";
import { LOCALE_LIMITS, SETTINGS_LIMITS, TEXT_LIMITS } from "../constants/limits";
import { errorCodeSchema } from "../errors";
import { nicknameKey, textSchema } from "../unicode";
import { revisionSchema, timestampSchema } from "./users.schema";

export const instanceNameSchema = textSchema({ min: 1, max: TEXT_LIMITS.instanceName, trim: true });
export const registrationModeSchema = z.enum(REGISTRATION_MODES);
/** Syntax only; service must additionally require membership in the installed registry. */
export const localeTagSchema = z
  .string()
  .min(1)
  .max(LOCALE_LIMITS.tagChars)
  .regex(/^[A-Za-z0-9-]+$/u)
  .transform((value, ctx) => {
    try {
      const canonical = Intl.getCanonicalLocales(value)[0];
      if (!canonical) throw new Error("Empty locale");
      return canonical;
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_LOCALE" });
      return z.NEVER;
    }
  });
const imageMb = z.number().int().min(SETTINGS_LIMITS.uploadMinMiB).max(SETTINGS_LIMITS.imageMaxMiB);
const audioMb = z.number().int().min(SETTINGS_LIMITS.uploadMinMiB).max(SETTINGS_LIMITS.audioMaxMiB);
const videoMb = z.number().int().min(SETTINGS_LIMITS.uploadMinMiB).max(SETTINGS_LIMITS.videoMaxMiB);
const profanityWords = z
  .array(textSchema({ min: 1, max: TEXT_LIMITS.profanityWord, trim: true, identifier: true }))
  .max(SETTINGS_LIMITS.profanityWords)
  .refine((words) => new Set(words.map(nicknameKey)).size === words.length, {
    message: "DUPLICATE_OPTION",
  });
const editableSettings = {
  instanceName: instanceNameSchema,
  registrationMode: registrationModeSchema,
  maxImageSizeMb: imageMb,
  maxAudioSizeMb: audioMb,
  maxVideoSizeMb: videoMb,
  maxPlayersPerRoom: z
    .number()
    .int()
    .min(SETTINGS_LIMITS.minPlayers)
    .max(SETTINGS_LIMITS.maxPlayers),
  profanityWords,
  defaultLocale: localeTagSchema,
};
export const settingsSchema = z.strictObject({
  ...editableSettings,
  revision: revisionSchema,
  updatedAt: timestampSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = z
  .strictObject(editableSettings)
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "REQUIRED",
  });
export const storageMetricsSchema = z.strictObject({
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  checkedAt: timestampSchema,
  status: z.enum(["fresh", "stale", "unavailable"]),
});
export const settingsResponseSchema = z.strictObject({
  settings: settingsSchema,
  metrics: storageMetricsSchema,
});
export const healthPartSchema = z.strictObject({
  status: z.enum(["up", "down", "unknown"]),
  checkedAt: timestampSchema,
  errorCode: errorCodeSchema.nullable(),
});
export const healthSchema = z.strictObject({
  app: z.literal("Kabuki Neko"),
  status: z.enum(["ok", "degraded"]),
  dbDriver: z.enum(["sqlite", "postgres", "mysql"]),
  storageDriver: z.enum(["local", "s3"]),
  stateDriver: z.enum(["memory", "redis"]),
  storageHealth: z.enum(["up", "down", "unknown"]),
  checkedAt: timestampSchema,
  db: healthPartSchema,
  storage: healthPartSchema,
  state: healthPartSchema,
});
export type Health = z.infer<typeof healthSchema>;
const track = AUDIO_TRACKS[0];
export const audioTrackSchema = z.strictObject({
  id: z.literal(track.id),
  labelKey: z.literal(track.labelKey),
  lobbyUrl: z.literal(track.lobbyUrl),
  tickUrl: z.literal(track.tickUrl),
  revealUrl: z.literal(track.revealUrl),
  podiumUrl: z.literal(track.podiumUrl),
});
export const publicConfigSchema = z.strictObject({
  instanceName: instanceNameSchema,
  defaultLocale: localeTagSchema,
  registrationMode: registrationModeSchema,
  limits: z.strictObject({ imageMb, audioMb, videoMb }),
  catalogVersion: z.literal("1"),
  audioTracks: z.array(audioTrackSchema).length(1),
});
export const aboutSchema = z.strictObject({
  name: z.literal("Kabuki Neko"),
  version: z.string().min(1),
  license: z.literal("Apache-2.0-with-Commons-Clause"),
  licenseUrl: z.literal("/legal/LICENSE.txt"),
  noticesUrl: z.literal("/legal/THIRD-PARTY-NOTICES.txt"),
  languageGuideUrl: z.literal("/help/languages"),
});
export const emptyRequestSchema = z.strictObject({});
export const cleanupResultSchema = z.strictObject({
  scannedCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
  skippedInUseCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  failures: z.array(
    z.strictObject({
      mediaId: z.uuidv4().regex(/^[0-9a-f-]+$/u),
      errorCode: z.enum(["STORAGE_UNAVAILABLE", "DELETE_FAILED"]),
    }),
  ),
  hasMore: z.boolean(),
  checkedAt: timestampSchema,
});
