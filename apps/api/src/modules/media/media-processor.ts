/**
 * Media byte validation and processing (SA §7.1, PRD BR media rules).
 *
 * Every upload is identified from its leading bytes against the exact PRD MIME allowlist, checked
 * for folder compatibility and per-type byte caps, then corroborated by a real decoder:
 * - images are decoded by Sharp (40 MP limit, 10 s timeout), auto-oriented, resized to at most
 *   1920 px on the longest edge without enlargement and re-encoded as WebP q82 with metadata
 *   (EXIF/GPS) stripped; animated or malformed images are rejected rather than transformed;
 * - audio/video bytes are passed through unchanged after ffprobe confirms the container, stream
 *   kinds and a duration of at most 86 400 s. ffprobe runs as a fixed-argument child process
 *   without a shell, with a forced demuxer, `file`-only protocol whitelist and a 5 s timeout.
 *
 * `file-type` is intentionally not used here: v22 is ESM-only and cannot be loaded by the
 * CommonJS API/Jest runtime, and an explicit signature table keeps the allowlist auditable.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { MEDIA_LIMITS, MIB } from "@kabuki-neko/shared/constants/limits";
import { ApiError } from "../../common/error.filter";
import type { StorageMime, UploadOptions } from "../../providers/storage/storage.interface";

export type MediaFolder = UploadOptions["folder"];
export type MediaKind = "image" | "audio" | "video";

/** Per-type upload caps in bytes, derived from the instance settings (MiB × 1024²). */
export interface MediaSizeLimits {
  imageBytes: number;
  audioBytes: number;
  videoBytes: number;
}
/** Runtime knobs; production uses the defaults, tests inject fakes and short timeouts. */
export interface MediaProcessorOptions {
  ffprobePath?: string;
  probeTimeoutMs?: number;
  imageTimeoutSec?: number;
}
/** One upload as received by the route parser. */
export interface MediaInput {
  bytes: Buffer;
  declaredMime: string;
  folder: MediaFolder;
  limits: MediaSizeLimits;
}
/** Bytes ready for `IStorageAdapter.upload()` plus the verified descriptive metadata. */
export interface ProcessedMedia {
  buffer: Buffer;
  mimeType: StorageMime;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** Which media kinds each storage folder accepts (covers image only; questions any kind). */
export const FOLDER_KINDS: Readonly<Record<MediaFolder, readonly MediaKind[]>> = {
  covers: ["image"],
  questions: ["image", "audio", "video"],
  audio: ["audio"],
  video: ["video"],
};
/** Client MIME aliases browsers commonly send for the allowlisted formats. */
const MIME_ALIASES: Readonly<Record<string, StorageMime>> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "video/mp4": "video/mp4",
  "video/webm": "video/webm",
};
/** ISO-BMFF major brands accepted as `video/mp4` (QuickTime, HEIF/AVIF and M4A are excluded). */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "mmp4",
  "M4V ",
  "MSNV",
]);
/** Forced ffprobe demuxer per audio/video type, so probing never falls back to other formats. */
const DEMUXERS: Readonly<Partial<Record<StorageMime, string>>> = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "video/mp4": "mov",
  "video/webm": "webm",
};
/** Image codecs ffprobe reports for cover art embedded in audio files (not real video). */
const ATTACHED_PICTURE_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "webp"]);

/** Raises the 422 used for every signature, decode or container failure. */
function unsupported(): never {
  throw new ApiError("UNSUPPORTED_MEDIA", 422);
}
/** True when `bytes` holds the ASCII `text` starting at `offset`. */
function ascii(bytes: Buffer, offset: number, text: string): boolean {
  return (
    bytes.length >= offset + text.length &&
    bytes.toString("latin1", offset, offset + text.length) === text
  );
}
/** Media family of an allowlisted MIME type. */
export function mediaKind(mime: StorageMime): MediaKind {
  return mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "video";
}
/** Converts instance settings (whole MiB) to byte caps. */
export function sizeLimitsFromSettings(settings: {
  maxImageSizeMb: number;
  maxAudioSizeMb: number;
  maxVideoSizeMb: number;
}): MediaSizeLimits {
  return {
    imageBytes: settings.maxImageSizeMb * MIB,
    audioBytes: settings.maxAudioSizeMb * MIB,
    videoBytes: settings.maxVideoSizeMb * MIB,
  };
}
/** Largest original byte count the folder may receive; the parser enforces it before buffering. */
export function uploadByteCap(folder: MediaFolder, limits: MediaSizeLimits): number {
  return Math.max(
    ...FOLDER_KINDS[folder].map((kind) =>
      kind === "image"
        ? limits.imageBytes
        : kind === "audio"
          ? limits.audioBytes
          : limits.videoBytes,
    ),
  );
}
/**
 * Identifies an allowlisted format from its leading bytes. Anything else — executables, scripts,
 * SVG/XML, GIF, archives, QuickTime, Matroska that is not WebM — yields `null`.
 */
export function sniffMime(bytes: Buffer): StorageMime | null {
  const b = (index: number) => bytes[index] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
  // Bare MPEG-1/2/2.5 Layer III frame: 11 sync bits, non-reserved version, layer bits 01.
  if (b(0) === 0xff && (b(1) & 0xe0) === 0xe0 && (b(1) & 0x18) !== 0x08 && (b(1) & 0x06) === 0x02)
    return "audio/mpeg";
  if (ascii(bytes, 4, "ftyp") && MP4_BRANDS.has(bytes.toString("latin1", 8, 12)))
    return "video/mp4";
  if (b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3) {
    const header = bytes.toString("latin1", 4, Math.min(bytes.length, 64));
    if (header.includes("webm")) return "video/webm";
  }
  return null;
}
/** Validates signature, declared type, folder and per-type byte cap; returns the verified MIME. */
export function classifyMedia(input: MediaInput): StorageMime {
  const declared = MIME_ALIASES[input.declaredMime.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (!declared) throw new ApiError("UNSUPPORTED_CONTENT_TYPE", 415);
  const mime = sniffMime(input.bytes);
  if (!mime || mime !== declared) unsupported();
  const kind = mediaKind(mime);
  if (!FOLDER_KINDS[input.folder].includes(kind)) unsupported();
  const cap =
    kind === "image"
      ? input.limits.imageBytes
      : kind === "audio"
        ? input.limits.audioBytes
        : input.limits.videoBytes;
  if (input.bytes.length > cap) throw new ApiError("PAYLOAD_TOO_LARGE", 413);
  return mime;
}
/**
 * Detects APNG: an `acTL` chunk before the first `IDAT`. libvips would silently keep only the
 * first frame, so animation is rejected explicitly instead of being transformed.
 */
export function isAnimatedPng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}
/** Decodes, bounds and re-encodes an image to stripped WebP without enlarging it. */
async function processImage(
  bytes: Buffer,
  mime: StorageMime,
  timeoutSec: number,
): Promise<ProcessedMedia> {
  const decoderOptions = { limitInputPixels: MEDIA_LIMITS.imagePixels, failOn: "error" as const };
  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    const metadata = await sharp(bytes, { ...decoderOptions, animated: true }).metadata();
    const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[
      mime as "image/jpeg" | "image/png" | "image/webp"
    ];
    if (metadata.format !== expected || (metadata.pages ?? 1) > 1) unsupported();
    if (mime === "image/png" && isAnimatedPng(bytes)) unsupported();
    output = await sharp(bytes, decoderOptions)
      .timeout({ seconds: timeoutSec })
      .autoOrient()
      .resize({
        width: MEDIA_LIMITS.imageLongestEdge,
        height: MEDIA_LIMITS.imageLongestEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: MEDIA_LIMITS.webpQuality })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unsupported();
  }
  return {
    buffer: output.data,
    mimeType: "image/webp",
    sizeBytes: output.data.length,
    width: output.info.width,
    height: output.info.height,
    durationMs: null,
  };
}
/** ffprobe JSON subset requested through `-show_entries`. */
interface ProbeResult {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}
/** Runs ffprobe with fixed arguments and returns its parsed JSON, mapping failures to 422/503. */
function runProbe(path: string, file: string, demuxer: string, timeoutMs: number) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file",
    "-f",
    demuxer,
    "-print_format",
    "json",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,width,height",
    `file:${file}`,
  ];
  return new Promise<ProbeResult>((resolve, reject) => {
    execFile(
      path,
      args,
      {
        shell: false,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MIB,
        windowsHide: true,
        env: { PATH: process.env.PATH ?? "" },
      },
      (error, stdout) => {
        if (error) {
          reject(
            "code" in error && error.code === "ENOENT"
              ? new ApiError("DEPENDENCY_UNAVAILABLE", 503)
              : new ApiError("UNSUPPORTED_MEDIA", 422),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ProbeResult);
        } catch {
          reject(new ApiError("UNSUPPORTED_MEDIA", 422));
        }
      },
    );
  });
}
/** Confirms audio/video container, stream kinds and duration with ffprobe on a private temp file. */
async function probeMedia(
  bytes: Buffer,
  mime: StorageMime,
  options: Required<MediaProcessorOptions>,
): Promise<ProcessedMedia> {
  const demuxer = DEMUXERS[mime];
  if (!demuxer) unsupported();
  const directory = await mkdtemp(join(tmpdir(), "kabuki-probe-"));
  try {
    const file = join(directory, "upload.bin");
    await writeFile(file, bytes, { mode: 0o600 });
    const probe = await runProbe(options.ffprobePath, file, demuxer, options.probeTimeoutMs);
    const streams = probe.streams ?? [];
    const audio = streams.filter((s) => s.codec_type === "audio");
    const video = streams.filter(
      (s) => s.codec_type === "video" && !ATTACHED_PICTURE_CODECS.has(s.codec_name ?? ""),
    );
    const kind = mediaKind(mime);
    if (kind === "audio" && (audio.length === 0 || video.length > 0)) unsupported();
    if (kind === "video" && video.length === 0) unsupported();
    const seconds = Number(probe.format?.duration);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MEDIA_LIMITS.durationSec)
      unsupported();
    const first = video[0];
    return {
      buffer: bytes,
      mimeType: mime,
      sizeBytes: bytes.length,
      width: kind === "video" && first?.width ? first.width : null,
      height: kind === "video" && first?.height ? first.height : null,
      durationMs: Math.round(seconds * 1000),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/**
 * Full upload pipeline: classify (415/422/413), then decode/process images or probe audio/video.
 * The returned buffer is what storage receives; the original bytes are never stored for images.
 */
export async function processMedia(
  input: MediaInput,
  options: MediaProcessorOptions = {},
): Promise<ProcessedMedia> {
  const resolved: Required<MediaProcessorOptions> = {
    ffprobePath: options.ffprobePath ?? "ffprobe",
    probeTimeoutMs: options.probeTimeoutMs ?? MEDIA_LIMITS.probeTimeoutMs,
    imageTimeoutSec: options.imageTimeoutSec ?? MEDIA_LIMITS.imageTimeoutMs / 1000,
  };
  if (input.bytes.length === 0) unsupported();
  const mime = classifyMedia(input);
  return mediaKind(mime) === "image"
    ? processImage(input.bytes, mime, resolved.imageTimeoutSec)
    : probeMedia(input.bytes, mime, resolved);
}
