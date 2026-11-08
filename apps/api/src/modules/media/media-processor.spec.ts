/**
 * TASK-066 coverage for media byte validation/processing with generated fixtures: Sharp images
 * (resize without upscale, EXIF stripping, 40 MP boundary, animation/malformed rejection), ffmpeg
 * audio/video containers, exact per-type byte caps, folder compatibility, and ffprobe hardening
 * (fixed arguments, forced demuxer, file-only protocol, timeout, missing binary, no network).
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { ApiError } from "../../common/error.filter";
import {
  classifyMedia,
  isAnimatedPng,
  processMedia,
  sniffMime,
  uploadByteCap,
  type MediaInput,
  type MediaSizeLimits,
} from "./media-processor";

const run = promisify(execFile);
const generous: MediaSizeLimits = {
  imageBytes: 25 * 1024 * 1024,
  audioBytes: 100 * 1024 * 1024,
  videoBytes: 250 * 1024 * 1024,
};
const fixtures: Record<string, Buffer> = {};
let directory: string;

/** Generates a fixture with ffmpeg from a lavfi source and returns its bytes. */
async function ffmpeg(name: string, args: string[]): Promise<Buffer> {
  const path = join(directory, name);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, path]);
  return readFile(path);
}
/** Writes an executable shell script used as a fake ffprobe binary. */
async function script(name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}
/** Asserts that a promise rejects with the given API status and error code. */
async function rejects(work: Promise<unknown> | (() => unknown), status: number, code: string) {
  let caught: unknown;
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect({
    status: (caught as ApiError).getStatus(),
    code: (caught as ApiError).errorCode,
  }).toEqual({ status, code });
}
/** Builds an upload input with generous caps unless overridden. */
function input(
  bytes: Buffer,
  declaredMime: string,
  folder: MediaInput["folder"] = "questions",
  limits: MediaSizeLimits = generous,
): MediaInput {
  return { bytes, declaredMime, folder, limits };
}
/** Solid-colour PNG of the given size. */
function png(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "#3366cc" } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kabuki-media-spec-"));
  const sine = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
  const video = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10"];
  fixtures.mp3 = await ffmpeg("a.mp3", [...sine, "-c:a", "libmp3lame", "-b:a", "64k"]);
  fixtures.ogg = await ffmpeg("a.ogg", [...sine, "-c:a", "libopus"]);
  fixtures.wav = await ffmpeg("a.wav", [...sine, "-c:a", "pcm_s16le"]);
  fixtures.mp4 = await ffmpeg("v.mp4", [...video, "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  fixtures.webm = await ffmpeg("v.webm", [...video, "-c:v", "libvpx", "-b:v", "100k"]);
  fixtures.gif = await ffmpeg("a.gif", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=0.6:size=32x32:rate=5",
    "-f",
    "gif",
  ]);
  fixtures.apng = await ffmpeg("a.apng", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=0.6:size=32x32:rate=5",
    "-plays",
    "0",
    "-f",
    "apng",
  ]);
  // Patch the LAME Info/Xing frame count so the header claims ~56 million seconds.
  const long = Buffer.from(fixtures.mp3);
  const tag = Math.max(long.indexOf("Info"), long.indexOf("Xing"));
  if (tag < 0 || (long.readUInt32BE(tag + 4) & 1) === 0) throw new Error("No Xing frame count");
  long.writeUInt32BE(0x7fffffff, tag + 8);
  fixtures.longMp3 = long;
}, 120_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("signature and classification", () => {
  it("recognises exactly the eight allowlisted formats", async () => {
    expect(sniffMime(await png(4, 4))).toBe("image/png");
    expect(
      sniffMime(
        await sharp(await png(4, 4))
          .jpeg()
          .toBuffer(),
      ),
    ).toBe("image/jpeg");
    expect(
      sniffMime(
        await sharp(await png(4, 4))
          .webp()
          .toBuffer(),
      ),
    ).toBe("image/webp");
    expect(sniffMime(fixtures.mp3 ?? Buffer.alloc(0))).toBe("audio/mpeg");
    expect(sniffMime(fixtures.ogg ?? Buffer.alloc(0))).toBe("audio/ogg");
    expect(sniffMime(fixtures.wav ?? Buffer.alloc(0))).toBe("audio/wav");
    expect(sniffMime(fixtures.mp4 ?? Buffer.alloc(0))).toBe("video/mp4");
    expect(sniffMime(fixtures.webm ?? Buffer.alloc(0))).toBe("video/webm");
    for (const hostile of [
      Buffer.from("MZ\x90\x00\x03\x00\x00\x00"),
      Buffer.from("\x7fELF\x02\x01\x01\x00"),
      Buffer.from("#!/bin/sh\nrm -rf /\n"),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from('<?xml version="1.0"?><svg/>'),
      fixtures.gif ?? Buffer.alloc(0),
      Buffer.from("PK\x03\x04archive"),
      Buffer.from("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00"),
    ])
      expect(sniffMime(hostile)).toBeNull();
  });

  it("enforces declared type, folder compatibility and exact per-type byte caps", async () => {
    const image = await png(10, 10);
    const exact = { ...generous, imageBytes: image.length };
    expect(classifyMedia(input(image, "image/png", "covers", exact))).toBe("image/png");
    await rejects(
      () =>
        classifyMedia(
          input(image, "image/png", "covers", { ...exact, imageBytes: image.length - 1 }),
        ),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    await rejects(
      () => classifyMedia(input(image, "image/svg+xml")),
      415,
      "UNSUPPORTED_CONTENT_TYPE",
    );
    await rejects(() => classifyMedia(input(image, "image/jpeg")), 422, "UNSUPPORTED_MEDIA");
    await rejects(
      () => classifyMedia(input(image, "image/png", "audio")),
      422,
      "UNSUPPORTED_MEDIA",
    );
    await rejects(
      () => classifyMedia(input(fixtures.mp3 ?? Buffer.alloc(0), "audio/mpeg", "covers")),
      422,
      "UNSUPPORTED_MEDIA",
    );
    await rejects(
      () => classifyMedia(input(fixtures.mp4 ?? Buffer.alloc(0), "video/mp4", "audio")),
      422,
      "UNSUPPORTED_MEDIA",
    );
    expect(classifyMedia(input(fixtures.wav ?? Buffer.alloc(0), "audio/x-wav", "audio"))).toBe(
      "audio/wav",
    );
    const audio = fixtures.mp3 ?? Buffer.alloc(0);
    await rejects(
      () =>
        classifyMedia(
          input(audio, "audio/mpeg", "audio", { ...generous, audioBytes: audio.length - 1 }),
        ),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    expect(uploadByteCap("covers", generous)).toBe(generous.imageBytes);
    expect(uploadByteCap("questions", generous)).toBe(generous.videoBytes);
    expect(uploadByteCap("audio", generous)).toBe(generous.audioBytes);
  });
});

describe("image processing", () => {
  it("downscales to 1920 px WebP and never enlarges small images", async () => {
    const large = await processMedia(input(await png(2400, 1200), "image/png"));
    expect(large).toMatchObject({
      mimeType: "image/webp",
      width: 1920,
      height: 960,
      durationMs: null,
    });
    expect(sniffMime(large.buffer)).toBe("image/webp");
    expect(large.sizeBytes).toBe(large.buffer.length);
    const small = await processMedia(
      input(
        await sharp(await png(320, 200))
          .jpeg()
          .toBuffer(),
        "image/jpeg",
      ),
    );
    expect(small).toMatchObject({ width: 320, height: 200, mimeType: "image/webp" });
  });

  it("strips EXIF metadata including GPS-style tags", async () => {
    const tagged = await sharp(await png(64, 32))
      .withExif({ IFD0: { Copyright: "secret-owner", ImageDescription: "gps 1,2" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const processed = await processMedia(input(tagged, "image/jpeg"));
    expect((await sharp(processed.buffer).metadata()).exif).toBeUndefined();
    expect(processed.buffer.includes("secret-owner")).toBe(false);
  });

  it("accepts exactly 40 MP and rejects one row more", async () => {
    const exact = await processMedia(input(await png(8000, 5000), "image/png"));
    expect(exact).toMatchObject({ width: 1920, height: 1200 });
    await rejects(
      processMedia(input(await png(8000, 5001), "image/png")),
      422,
      "UNSUPPORTED_MEDIA",
    );
  }, 60_000);

  it("rejects animated, truncated and disguised images", async () => {
    const animated = await sharp(fixtures.gif, { animated: true }).webp().toBuffer();
    await rejects(processMedia(input(animated, "image/webp")), 422, "UNSUPPORTED_MEDIA");
    expect(isAnimatedPng(fixtures.apng ?? Buffer.alloc(0))).toBe(true);
    expect(isAnimatedPng(await png(4, 4))).toBe(false);
    await rejects(
      processMedia(input(fixtures.apng ?? Buffer.alloc(0), "image/png")),
      422,
      "UNSUPPORTED_MEDIA",
    );
    const truncated = (await png(64, 64)).subarray(0, 40);
    await rejects(processMedia(input(truncated, "image/png")), 422, "UNSUPPORTED_MEDIA");
    const disguised = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from("MZ not a jpeg"),
    ]);
    await rejects(processMedia(input(disguised, "image/jpeg")), 422, "UNSUPPORTED_MEDIA");
    await rejects(processMedia(input(Buffer.alloc(0), "image/png")), 422, "UNSUPPORTED_MEDIA");
  });
});

describe("audio and video probing", () => {
  it("passes probed audio/video bytes through with verified metadata", async () => {
    for (const [name, mime, folder] of [
      ["mp3", "audio/mpeg", "audio"],
      ["ogg", "audio/ogg", "audio"],
      ["wav", "audio/wav", "questions"],
    ] as const) {
      const bytes = fixtures[name] ?? Buffer.alloc(0);
      const result = await processMedia(input(bytes, mime, folder));
      expect(result).toMatchObject({
        mimeType: mime,
        width: null,
        height: null,
        sizeBytes: bytes.length,
      });
      expect(result.buffer.equals(bytes)).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(900);
      expect(result.durationMs).toBeLessThanOrEqual(1200);
    }
    for (const [name, mime] of [
      ["mp4", "video/mp4"],
      ["webm", "video/webm"],
    ] as const) {
      const result = await processMedia(input(fixtures[name] ?? Buffer.alloc(0), mime, "video"));
      expect(result).toMatchObject({ mimeType: mime, width: 64, height: 48 });
      expect(result.durationMs).toBeGreaterThanOrEqual(900);
    }
  });

  it("rejects durations above 86400 s and containers without the expected streams", async () => {
    await rejects(
      processMedia(input(fixtures.longMp3 ?? Buffer.alloc(0), "audio/mpeg", "audio")),
      422,
      "UNSUPPORTED_MEDIA",
    );
    const corrupt = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200, 7)]);
    await rejects(processMedia(input(corrupt, "audio/ogg", "audio")), 422, "UNSUPPORTED_MEDIA");
  });

  it("invokes ffprobe with fixed hardened arguments and no shell", async () => {
    const record = join(directory, "args.txt");
    const fake = await script(
      "ffprobe-record",
      `for a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\nprintf '%s' '{"format":{"duration":"1.0"},"streams":[{"codec_type":"audio","codec_name":"mp3"}]}'`,
    );
    await processMedia(input(fixtures.mp3 ?? Buffer.alloc(0), "audio/mpeg", "audio"), {
      ffprobePath: fake,
    });
    const args = (await readFile(record, "utf8")).trim().split("\n");
    expect(args.slice(0, 7)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "mp3",
    ]);
    expect(args.at(-1)).toMatch(/^file:\/.+kabuki-probe-.+\/upload\.bin$/u);
    expect(args.some((arg) => /https?:|tcp:|concat|\$\(/u.test(arg))).toBe(false);
  });

  it("times out a hanging probe and reports a missing ffprobe as unavailable", async () => {
    const hang = await script("ffprobe-hang", "sleep 5");
    const started = Date.now();
    await rejects(
      processMedia(input(fixtures.wav ?? Buffer.alloc(0), "audio/wav", "audio"), {
        ffprobePath: hang,
        probeTimeoutMs: 200,
      }),
      422,
      "UNSUPPORTED_MEDIA",
    );
    expect(Date.now() - started).toBeLessThan(3000);
    await rejects(
      processMedia(input(fixtures.wav ?? Buffer.alloc(0), "audio/wav", "audio"), {
        ffprobePath: join(directory, "missing-ffprobe"),
      }),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
  });

  it("never reaches the network for playlist-style protocol abuse", async () => {
    let hits = 0;
    const server: Server = createServer((_request, response) => {
      hits++;
      response.end("#EXTM3U\n");
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const playlist = Buffer.from(`#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:${port}/a.mp3\n`);
      await rejects(processMedia(input(playlist, "audio/mpeg", "audio")), 422, "UNSUPPORTED_MEDIA");
      // An ID3-prefixed playlist reaches ffprobe, but the forced mp3 demuxer and file-only
      // protocol whitelist keep it from following the embedded URL.
      const disguised = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"), playlist]);
      await rejects(
        processMedia(input(disguised, "audio/mpeg", "audio")),
        422,
        "UNSUPPORTED_MEDIA",
      );
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
