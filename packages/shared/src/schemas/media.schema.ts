import { z } from "zod";
import { ACCESSIBILITY_LIMITS, MEDIA_LIMITS, PAGING, QUIZ_LIMITS } from "../constants/limits";
import { type Issue } from "../errors";
import { textSchema, utf8ByteLength } from "../unicode";
import {
  pageSchema,
  pagingQueryShape,
  queryBooleanSchema,
  revisionSchema,
  searchSchema,
  timestampSchema,
  uuidSchema,
} from "./users.schema";

export const MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
] as const;
export const captionSchema = z
  .strictObject({
    startMs: z.number().int().min(0).max(ACCESSIBILITY_LIMITS.captionTimeMs),
    endMs: z.number().int().min(0).max(ACCESSIBILITY_LIMITS.captionTimeMs),
    text: textSchema({ min: 1, max: ACCESSIBILITY_LIMITS.captionText, multiline: true }),
  })
  .refine((cue) => cue.endMs > cue.startMs, { message: "INVALID_VIDEO_RANGE", path: ["endMs"] });
const accessibilityFields = {
  altText: textSchema({ max: ACCESSIBILITY_LIMITS.altText }).nullable(),
  transcript: textSchema({ max: ACCESSIBILITY_LIMITS.transcript, multiline: true }).nullable(),
  captions: z.array(captionSchema).max(ACCESSIBILITY_LIMITS.captionCount),
  visualDescription: textSchema({
    max: ACCESSIBILITY_LIMITS.visualDescription,
    multiline: true,
  }).nullable(),
};
const accessibilityObjectSchema = z.strictObject(accessibilityFields).superRefine((value, ctx) => {
  let previousEnd = 0;
  value.captions.forEach((cue, index) => {
    if (cue.startMs < previousEnd)
      ctx.addIssue({
        code: "custom",
        message: "INVALID_VIDEO_RANGE",
        path: ["captions", index, "startMs"],
      });
    previousEnd = cue.endMs;
  });
});
function jsonWithinBytes(maxBytes: number) {
  return z.unknown().superRefine((value, ctx) => {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && utf8ByteLength(serialized) > maxBytes)
        ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
    }
  });
}
/** Complete response; absent and null are deliberately different. */
export const accessibilitySchema = jsonWithinBytes(ACCESSIBILITY_LIMITS.serializedBytes).pipe(
  accessibilityObjectSchema,
);
export type Accessibility = z.infer<typeof accessibilitySchema>;
export function emptyAccessibility(): Accessibility {
  return { altText: null, transcript: null, captions: [], visualDescription: null };
}
/** Optional upload/import input has exactly the documented null/[] defaults. */
export const accessibilityInputSchema = jsonWithinBytes(ACCESSIBILITY_LIMITS.serializedBytes)
  .pipe(
    z.strictObject({
      altText: accessibilityFields.altText.default(null),
      transcript: accessibilityFields.transcript.default(null),
      captions: accessibilityFields.captions.default([]),
      visualDescription: accessibilityFields.visualDescription.default(null),
    }),
  )
  .pipe(accessibilityObjectSchema)
  .superRefine((value, ctx) => {
    if (utf8ByteLength(JSON.stringify(value)) > ACCESSIBILITY_LIMITS.serializedBytes) {
      ctx.addIssue({ code: "custom", message: "PAYLOAD_TOO_LARGE" });
    }
  })
  .default(emptyAccessibility);

const youtubeIdPattern = /^[A-Za-z0-9_-]{11}$/u;
export function canonicalYouTubeUrl(value: string): string | null {
  // Inspect the raw authority: URL.port removes explicit default :443, which is forbidden too.
  const raw =
    /^https:\/\/(www\.youtube\.com|youtube\.com|youtu\.be|www\.youtube-nocookie\.com)(\/[^#\s\\]*)$/iu.exec(
      value,
    );
  if (!raw) return null;
  try {
    const url = new URL(value);
    const rawPath = raw[2]?.split("?")[0];
    if (url.username || url.password || url.port || url.hash || rawPath !== url.pathname)
      return null;
    let id: string | undefined;
    if (url.hostname === "youtu.be") {
      id = /^\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1];
    } else if (url.pathname === "/watch") {
      const ids = url.searchParams.getAll("v");
      if (ids.length !== 1) return null;
      id = ids[0];
    } else {
      id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname)?.[1];
    }
    if (!id || !youtubeIdPattern.test(id)) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    return null;
  }
}
export const youtubeUrlSchema = z.string().transform((value, ctx) => {
  const canonical = canonicalYouTubeUrl(value);
  if (canonical === null) {
    ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
    return z.NEVER;
  }
  return canonical;
});
export const mediaAttachmentFields = {
  mediaId: uuidSchema.nullable(),
  externalVideoUrl: youtubeUrlSchema.nullable(),
  videoStartSec: z.number().int().min(0).max(QUIZ_LIMITS.videoSec),
  videoEndSec: z.number().int().min(0).max(QUIZ_LIMITS.videoSec).nullable(),
};
export const mediaAttachmentSchema = z
  .strictObject(mediaAttachmentFields)
  .superRefine((value, ctx) => {
    if (value.mediaId !== null && value.externalVideoUrl !== null)
      ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE", path: ["externalVideoUrl"] });
    if (value.videoEndSec !== null && value.videoEndSec <= value.videoStartSec)
      ctx.addIssue({ code: "custom", message: "INVALID_VIDEO_RANGE", path: ["videoEndSec"] });
    if (
      value.mediaId === null &&
      value.externalVideoUrl === null &&
      (value.videoStartSec !== 0 || value.videoEndSec !== null)
    )
      ctx.addIssue({ code: "custom", message: "INVALID_VIDEO_RANGE" });
  });
export type MediaAttachment = z.infer<typeof mediaAttachmentSchema>;

/** Called after authorization resolves the referenced media; never fetches a URL. */
export function validateAttachmentContext(
  attachment: MediaAttachment,
  media: {
    id: string;
    mimeType: string;
    status: "READY" | "UPLOADING" | "FAILED" | "DELETING";
  } | null,
): Issue[] {
  const issues: Issue[] = [];
  if (attachment.mediaId !== null && (media?.id !== attachment.mediaId || media.status !== "READY"))
    issues.push({ path: "mediaId", code: "INVALID_REFERENCE", params: {}, severity: "error" });
  const isVideo =
    attachment.externalVideoUrl !== null ||
    (attachment.mediaId !== null && media?.mimeType.startsWith("video/"));
  if (!isVideo && (attachment.videoStartSec !== 0 || attachment.videoEndSec !== null))
    issues.push({
      path: "videoStartSec",
      code: "INVALID_VIDEO_RANGE",
      params: {},
      severity: "error",
    });
  return issues;
}
const publicMediaUrlSchema = z.string().refine(
  (value) => {
    if (/^\/uploads\/[A-Za-z0-9/_-]+\.[A-Za-z0-9]+$/u.test(value)) return !value.includes("..");
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  },
  { message: "INVALID_FORMAT" },
);
export const mediaSchema = z.strictObject({
  id: uuidSchema,
  uploaderId: uuidSchema,
  storageDriver: z.enum(["local", "s3"]),
  publicUrl: publicMediaUrlSchema,
  originalName: textSchema({ min: 1, max: 255 }),
  mimeType: z.enum(MEDIA_MIME_TYPES),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(MEDIA_LIMITS.durationSec * 1_000)
    .nullable(),
  accessibility: accessibilitySchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  inUse: z.boolean(),
  canDelete: z.boolean(),
});
export type Media = z.infer<typeof mediaSchema>;
export const mediaPatchSchema = z.strictObject({ accessibility: accessibilitySchema });
export const mediaQuerySchema = z.strictObject({
  ...pagingQueryShape(PAGING.defaults.media),
  type: z.enum(["image", "audio", "video"]).optional(),
  search: searchSchema.default(""),
  sort: z.literal("created_desc").default("created_desc"),
  inUse: queryBooleanSchema.optional(),
});
export const mediaPageSchema = pageSchema(mediaSchema);
export const mediaDeletedSchema = z.strictObject({ deleted: z.literal(true) });
export const mediaUploadMetadataSchema = z.strictObject({
  folder: z.enum(["covers", "questions", "audio", "video"]),
  accessibility: accessibilityInputSchema,
});
