import { z } from "zod";
import { DEFAULT_AUDIO_TRACK, SFX_DEFINITIONS } from "../constants/audio";
import { textSchema } from "../unicode";

/** Unknown/legacy IDs are safe data and resolve to random at playback, never URLs. */
export const bgmTrackSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const bgmTrackCreateSchema = bgmTrackSchema.default(DEFAULT_AUDIO_TRACK);
const volumeSchema = z.number().min(0).max(1);
const dualSourceSchema = z
  .tuple([
    z
      .string()
      .regex(
        /^\/audio\/(?:01-lobby|02-thinking|03-leaderboard|04-podium|05-sfx)\/[a-z0-9]+(?:-[a-z0-9]+)*\.webm$/u,
      ),
    z
      .string()
      .regex(
        /^\/audio\/(?:01-lobby|02-thinking|03-leaderboard|04-podium|05-sfx)\/[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/u,
      ),
  ])
  .refine(([webm, mp3]) => webm.slice(0, -5) === mp3.slice(0, -4), {
    message: "INVALID_REFERENCE",
  });
export const audioSourceSchema = dualSourceSchema;
export const lobbyTrackSchema = z
  .strictObject({
    id: bgmTrackSchema.refine((id) => id !== DEFAULT_AUDIO_TRACK, { message: "INVALID_FORMAT" }),
    label: textSchema({ min: 1, max: 150, trim: true }),
    src: dualSourceSchema,
    loop: z.literal(true),
    volume: volumeSchema,
  })
  .refine((track) => track.src[0] === `/audio/01-lobby/bgm-lobby-${track.id}.webm`, {
    message: "INVALID_REFERENCE",
    path: ["src"],
  });
export const lobbyTracksSchema = z
  .array(lobbyTrackSchema)
  .min(1)
  .refine((tracks) => new Set(tracks.map((track) => track.id)).size === tracks.length, {
    message: "DUPLICATE_ID",
  });
function bgmSchema(folder: string, filename: string) {
  return z.strictObject({
    src: z.tuple([
      z.literal(`/audio/${folder}/${filename}.webm`),
      z.literal(`/audio/${folder}/${filename}.mp3`),
    ]),
    loop: z.literal(true),
    volume: volumeSchema,
  });
}
function sfxSchema(filename: string) {
  return z.strictObject({
    src: z.tuple([
      z.literal(`/audio/05-sfx/${filename}.webm`),
      z.literal(`/audio/05-sfx/${filename}.mp3`),
    ]),
    volume: volumeSchema,
  });
}
export const audioManifestSchema = z.strictObject({
  lobby: lobbyTracksSchema,
  thinking: z.strictObject({
    sprint: bgmSchema("02-thinking", "bgm-think-sprint"),
    standard: bgmSchema("02-thinking", "bgm-think-standard"),
    puzzle: bgmSchema("02-thinking", "bgm-think-puzzle"),
  }),
  leaderboard: z.strictObject({ groove: bgmSchema("03-leaderboard", "bgm-leaderboard-groove") }),
  podium: z.strictObject({
    buildup: bgmSchema("04-podium", "bgm-podium-buildup"),
    victory: bgmSchema("04-podium", "bgm-podium-victory"),
  }),
  sfx: z.strictObject({
    hyoshigiStart: sfxSchema(SFX_DEFINITIONS.hyoshigiStart.filename),
    nekoPop: sfxSchema(SFX_DEFINITIONS.nekoPop.filename).extend({ throttleMs: z.literal(150) }),
    questionWhoosh: sfxSchema(SFX_DEFINITIONS.questionWhoosh.filename),
    tickLast5s: sfxSchema(SFX_DEFINITIONS.tickLast5s.filename),
    timeupGong: sfxSchema(SFX_DEFINITIONS.timeupGong.filename),
    revealBar: sfxSchema(SFX_DEFINITIONS.revealBar.filename),
    answerCorrect: sfxSchema(SFX_DEFINITIONS.answerCorrect.filename),
    answerWrong: sfxSchema(SFX_DEFINITIONS.answerWrong.filename),
    streakFire: sfxSchema(SFX_DEFINITIONS.streakFire.filename),
    podiumSpotlight: sfxSchema(SFX_DEFINITIONS.podiumSpotlight.filename),
  }),
});
export type LobbyTrack = z.infer<typeof lobbyTrackSchema>;
export type AudioManifest = z.infer<typeof audioManifestSchema>;
export type AudioSource = z.infer<typeof audioSourceSchema>;
