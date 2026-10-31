import { describe, expect, it } from "vitest";
import {
  accessibilityInputSchema,
  accessibilitySchema,
  emptyAccessibility,
  mediaAttachmentSchema,
  mediaSchema,
  validateAttachmentContext,
  youtubeUrlSchema,
} from "./media.schema";
const id = "8a16b9fb-64e1-4e98-9daf-4bfe691d518b";
const videoId = "dQw4w9WgXcQ";
const canonical = `https://www.youtube.com/watch?v=${videoId}`;

describe("accessible media contracts", () => {
  it("defaults optional inputs without making missing response properties valid", () => {
    expect(accessibilityInputSchema.parse(undefined)).toEqual(emptyAccessibility());
    expect(accessibilityInputSchema.parse({})).toEqual(emptyAccessibility());
    expect(accessibilitySchema.safeParse({}).success).toBe(false);
    expect(accessibilityInputSchema.safeParse(null).success).toBe(false);
    expect(accessibilityInputSchema.safeParse({ unknown: "x" }).success).toBe(false);
    const parsed = accessibilityInputSchema.parse({});
    parsed.captions.push({ startMs: 0, endMs: 1, text: "test" });
    expect(accessibilityInputSchema.parse({}).captions).toEqual([]);
  });
  it("requires positive ordered non-overlapping captions, but allows adjacent cues", () => {
    const cue = { startMs: 0, endMs: 1000, text: "中文\ncaption" };
    expect(
      accessibilityInputSchema.parse({ captions: [cue, { ...cue, startMs: 1000, endMs: 2000 }] })
        .captions,
    ).toHaveLength(2);
    for (const captions of [
      [{ ...cue, endMs: 0 }],
      [cue, { ...cue, startMs: 999 }],
      [{ ...cue, startMs: -1 }],
      [{ ...cue, endMs: 86_400_001 }],
      [{ ...cue, text: "" }],
      Array.from({ length: 2001 }, (_, i) => ({ ...cue, startMs: i, endMs: i + 1 })),
    ])
      expect(accessibilityInputSchema.safeParse({ captions }).success).toBe(false);
  });
  it("enforces serialized bytes even when each individual caption fits", () => {
    const captions = Array.from({ length: 100 }, (_, i) => ({
      startMs: i,
      endMs: i + 1,
      text: "界".repeat(1000),
    }));
    expect(accessibilityInputSchema.safeParse({ captions }).success).toBe(false);
    expect(accessibilityInputSchema.safeParse({ altText: "a".repeat(501) }).success).toBe(false);
    expect(accessibilityInputSchema.safeParse({ transcript: "a".repeat(50_001) }).success).toBe(
      false,
    );
  });
});
describe("YouTube URLs", () => {
  it.each([
    canonical,
    `https://youtube.com/watch?v=${videoId}&t=23`,
    `https://youtu.be/${videoId}?si=ignored`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube-nocookie.com/embed/${videoId}`,
  ])("canonicalizes %s without fetching", (url) => {
    expect(youtubeUrlSchema.parse(url)).toBe(canonical);
  });
  it.each([
    `http://youtube.com/watch?v=${videoId}`,
    `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://youtube.com:443/watch?v=${videoId}`,
    `https://youtube.com:8443/watch?v=${videoId}`,
    `https://user@youtube.com/watch?v=${videoId}`,
    `${canonical}#fragment`,
    `${canonical}&v=aaaaaaaaaaa`,
    `https://youtu.be/${videoId}/extra`,
    `https://www.youtube.com/watch/../watch?v=${videoId}`,
    `https://youtube.com\\evil.test/watch?v=${videoId}`,
    `https://www.youtube.com/embed/short`,
    `https://youtube.com/watch?v=<script>`,
    "javascript:alert(1)",
  ])("rejects unsafe/ambiguous %s", (url) => {
    expect(youtubeUrlSchema.safeParse(url).success).toBe(false);
  });
});
describe("attachment and response boundaries", () => {
  it("enforces exclusivity and clip bounds and resolves media type through authorized context", () => {
    const attachment = { mediaId: id, externalVideoUrl: null, videoStartSec: 2, videoEndSec: 5 };
    expect(mediaAttachmentSchema.parse(attachment)).toEqual(attachment);
    expect(
      mediaAttachmentSchema.safeParse({ ...attachment, externalVideoUrl: canonical }).success,
    ).toBe(false);
    expect(mediaAttachmentSchema.safeParse({ ...attachment, videoEndSec: 2 }).success).toBe(false);
    expect(mediaAttachmentSchema.safeParse({ ...attachment, mediaId: null }).success).toBe(false);
    expect(
      validateAttachmentContext(attachment, { id, mimeType: "video/mp4", status: "READY" }),
    ).toEqual([]);
    expect(
      validateAttachmentContext(attachment, { id, mimeType: "image/webp", status: "READY" })[0]
        ?.code,
    ).toBe("INVALID_VIDEO_RANGE");
    expect(validateAttachmentContext(attachment, null)[0]?.code).toBe("INVALID_REFERENCE");
    expect(
      validateAttachmentContext(attachment, { id, mimeType: "video/mp4", status: "FAILED" })[0]
        ?.code,
    ).toBe("INVALID_REFERENCE");
  });
  it("has strict media metadata and no private storage credentials", () => {
    const media = {
      id,
      uploaderId: id,
      storageDriver: "local",
      publicUrl: `/uploads/${id}.webp`,
      originalName: "猫.png",
      mimeType: "image/webp",
      sizeBytes: 100,
      width: 10,
      height: 10,
      durationMs: null,
      accessibility: emptyAccessibility(),
      revision: 1,
      createdAt: 0,
      inUse: false,
      canDelete: true,
    };
    expect(mediaSchema.parse(media)).toEqual(media);
    expect(mediaSchema.safeParse({ ...media, s3Secret: "secret" }).success).toBe(false);
    expect(
      mediaSchema.safeParse({ ...media, publicUrl: "https://user:password@example.com/media" })
        .success,
    ).toBe(false);
    expect(mediaSchema.safeParse({ ...media, mimeType: "image/svg+xml" }).success).toBe(false);
  });
});
