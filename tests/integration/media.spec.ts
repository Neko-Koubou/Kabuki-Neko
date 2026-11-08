/**
 * TASK-069 integration coverage for the media REST routes against the built API on isolated
 * runtimes: a local origin and a MinIO (S3) origin each accept a READY image upload (201), and the
 * local run covers MIME/signature/size rejection, idempotent replay, ownership, If-Match metadata,
 * truthful inUse/canDelete, and the attach-versus-delete race on the shared row lock.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { DeleteBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";
import { z } from "zod";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { mediaPageSchema, mediaSchema } from "@kabuki-neko/shared/schemas/media.schema";
import { createTestRuntime } from "../helpers/runtime";

const credentialsSchema = z.object({ user: userSchema, accessToken: z.string() });
const errorSchema = z.object({ errorCode: z.string() });
type Credentials = z.infer<typeof credentialsSchema>;

/** A running API process bound to an isolated runtime. */
interface Api {
  base: string;
  child: ChildProcess;
}
/** Reserves a free loopback port. */
async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
/** Starts `apps/api/dist/main.js` with the runtime env plus overrides and waits for readiness. */
async function startApi(
  runtime: Awaited<ReturnType<typeof createTestRuntime>>,
  env: Record<string, string> = {},
): Promise<Api> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: {
      ...process.env,
      ...runtime.env,
      API_PORT: String(port),
      PORT: String(port),
      NEXT_PUBLIC_API_URL: origin,
      ...env,
    },
    stdio: "ignore",
  });
  const base = `${origin}/api/v1`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error("API exited during startup");
    try {
      if ((await fetch(`${base}/auth/setup-status`)).status === 200) return { base, child };
    } catch {
      /* Wait for server startup. */
    }
    await delay(100);
  }
  throw new Error("API did not become ready");
}
/** Stops the API process and waits for it to exit. */
async function stopApi(api: Api | undefined) {
  if (!api || api.child.exitCode !== null) return;
  const exited = once(api.child, "exit");
  api.child.kill("SIGTERM");
  await exited;
}
/** JSON request helper with the web client and Origin headers. */
function call(
  api: Api,
  path: string,
  method = "GET",
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${api.base}${path}`, {
    method,
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
/** Multipart upload of one file with a folder and optional accessibility JSON. */
function upload(
  api: Api,
  token: string | undefined,
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
  name = "picture.png",
  folder = "covers",
  key: string = randomUUID(),
) {
  const form = new FormData();
  form.append("folder", folder);
  form.append("accessibility", JSON.stringify({ altText: "A test image" }));
  form.append("file", new Blob([bytes], { type }), name);
  return fetch(`${api.base}/media/upload`, {
    method: "POST",
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Idempotency-Key": key,
    },
    body: form,
  });
}
/** Completes first-run setup and returns the administrator credentials. */
async function setup(api: Api) {
  const response = await call(
    api,
    "/auth/setup",
    "POST",
    undefined,
    {
      instanceName: "Media integration",
      name: "Admin",
      email: "admin@example.org",
      password: "Correct-password-123!",
    },
    { "Idempotency-Key": randomUUID() },
  );
  expect(response.status).toBe(201);
  return credentialsSchema.parse(await response.json());
}
/** Registers a CREATOR through public registration. */
async function register(api: Api, email: string): Promise<Credentials> {
  const response = await call(
    api,
    "/auth/register",
    "POST",
    undefined,
    { name: "Creator", email, password: "Correct-password-123!" },
    { "Idempotency-Key": randomUUID() },
  );
  expect(response.status).toBe(201);
  return credentialsSchema.parse(await response.json());
}
/** One PNG chunk: length, type, data and CRC-32 over type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/**
 * Minimal RGB PNG encoder (root tests have no Sharp dependency). `noise` fills pixels with random
 * bytes and stores them uncompressed so the file size exceeds a configured MiB cap reliably.
 */
function png(width = 48, height = 24, noise = false): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const pixels = noise ? randomBytes(width * 3) : Buffer.alloc(width * 3, 0x5a);
    rows.push(Buffer.concat([Buffer.from([0]), pixels]));
  }
  const data = deflateSync(Buffer.concat(rows), { level: noise ? 0 : 9 });
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Uint8Array(file);
}
/** Error code of a failed response. */
async function code(response: Response) {
  return [response.status, errorSchema.parse(await response.json()).errorCode];
}

it("uploads, guards and deletes media on the local origin", async () => {
  const runtime = await createTestRuntime();
  let api: Api | undefined;
  try {
    api = await startApi(runtime);
    await setup(api);
    const owner = await register(api, "owner@example.org"),
      other = await register(api, "other@example.org"),
      errors = await register(api, "errors@example.org");
    const image = png();
    expect((await upload(api, undefined, image, "image/png")).status).toBe(401);

    const key = randomUUID();
    const created = await upload(
      api,
      owner.accessToken,
      image,
      "image/png",
      "cat.png",
      "covers",
      key,
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"2"');
    const media = mediaSchema.parse(await created.json());
    expect(media).toMatchObject({
      uploaderId: owner.user.id,
      mimeType: "image/webp",
      width: 48,
      height: 24,
      inUse: false,
      canDelete: true,
      accessibility: { altText: "A test image" },
    });
    const file = await fetch(media.publicUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/webp");
    expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const replay = await upload(
      api,
      owner.accessToken,
      image,
      "image/png",
      "cat.png",
      "covers",
      key,
    );
    expect(replay.status).toBe(201);
    expect(mediaSchema.parse(await replay.json()).id).toBe(media.id);

    // MIME, signature, folder and size rejection (separate account keeps rate limits independent).
    const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(await code(await upload(api, errors.accessToken, svg, "image/svg+xml"))).toEqual([
      415,
      "UNSUPPORTED_CONTENT_TYPE",
    ]);
    expect(await code(await upload(api, errors.accessToken, image, "image/jpeg"))).toEqual([
      422,
      "UNSUPPORTED_MEDIA",
    ]);
    const exe = new Uint8Array(Buffer.from("MZ\x90\x00not really an image"));
    expect(await code(await upload(api, errors.accessToken, exe, "image/png"))).toEqual([
      422,
      "UNSUPPORTED_MEDIA",
    ]);
    expect(
      await code(await upload(api, errors.accessToken, image, "image/png", "x.png", "audio")),
    ).toEqual([422, "UNSUPPORTED_MEDIA"]);
    expect(
      await code(await upload(api, errors.accessToken, image, "image/png", "x.png", "../covers")),
    ).toEqual([422, "VALIDATION_FAILED"]);
    const db = new Database(runtime.env.SQLITE_PATH ?? "");
    try {
      db.prepare("UPDATE system_settings SET max_image_size_mb = 1").run();
      const noisy = png(720, 720, true);
      expect(noisy.byteLength).toBeGreaterThan(1024 * 1024);
      expect(await code(await upload(api, errors.accessToken, noisy, "image/png"))).toEqual([
        413,
        "PAYLOAD_TOO_LARGE",
      ]);
      db.prepare("UPDATE system_settings SET max_audio_size_mb = 1, max_video_size_mb = 1").run();
      expect(await code(await upload(api, errors.accessToken, noisy, "image/png"))).toEqual([
        413,
        "PAYLOAD_TOO_LARGE",
      ]);
      db.prepare(
        "UPDATE system_settings SET max_image_size_mb = 5, max_audio_size_mb = 10, max_video_size_mb = 25",
      ).run();
    } finally {
      db.close();
    }
    const library = mediaPageSchema.parse(
      await (await call(api, "/media", "GET", errors.accessToken)).json(),
    );
    expect(library.items).toEqual([]);

    // Ownership and If-Match metadata.
    expect(
      mediaPageSchema.parse(await (await call(api, "/media", "GET", other.accessToken)).json())
        .items,
    ).toEqual([]);
    const accessibility = {
      altText: "Updated",
      transcript: null,
      captions: [],
      visualDescription: null,
    };
    expect(
      (
        await call(
          api,
          `/media/${media.id}`,
          "PATCH",
          other.accessToken,
          { accessibility },
          { "If-Match": '"2"' },
        )
      ).status,
    ).toBe(404);
    expect((await call(api, `/media/${media.id}`, "DELETE", other.accessToken)).status).toBe(404);
    expect(
      (await call(api, `/media/${media.id}`, "PATCH", owner.accessToken, { accessibility })).status,
    ).toBe(422);
    const patched = await call(
      api,
      `/media/${media.id}`,
      "PATCH",
      owner.accessToken,
      { accessibility },
      { "If-Match": '"2"' },
    );
    expect(patched.status).toBe(200);
    expect(patched.headers.get("etag")).toBe('"3"');
    expect(mediaSchema.parse(await patched.json()).accessibility.altText).toBe("Updated");
    expect(
      await code(
        await call(
          api,
          `/media/${media.id}`,
          "PATCH",
          owner.accessToken,
          { accessibility },
          { "If-Match": '"2"' },
        ),
      ),
    ).toEqual([409, "REVISION_CONFLICT"]);

    // Attach versus delete race: exactly one wins on the shared row lock.
    const raced = mediaSchema.parse(
      await (await upload(api, owner.accessToken, image, "image/png")).json(),
    );
    const [quiz, removal] = await Promise.all([
      call(
        api,
        "/quizzes",
        "POST",
        owner.accessToken,
        { title: "Race", coverMediaId: raced.id },
        { "Idempotency-Key": randomUUID() },
      ),
      call(api, `/media/${raced.id}`, "DELETE", owner.accessToken),
    ]);
    expect([quiz.status, removal.status].sort()).toEqual(
      quiz.status === 201 ? [201, 409] : [200, 422],
    );
    if (quiz.status === 201) {
      const listed = mediaPageSchema.parse(
        await (await call(api, "/media?inUse=true", "GET", owner.accessToken)).json(),
      );
      expect(listed.items).toEqual([
        expect.objectContaining({ id: raced.id, inUse: true, canDelete: false }),
      ]);
      expect(
        await code(await call(api, `/media/${raced.id}`, "DELETE", owner.accessToken)),
      ).toEqual([409, "MEDIA_IN_USE"]);
    } else expect((await fetch(raced.publicUrl)).status).toBe(404);

    const deleted = await call(api, `/media/${media.id}`, "DELETE", owner.accessToken);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await fetch(media.publicUrl)).status).toBe(404);
    expect((await call(api, `/media/${media.id}`, "DELETE", owner.accessToken)).status).toBe(404);
  } finally {
    await stopApi(api);
    await runtime.cleanup();
  }
});

it("stores and deletes an uploaded image through a MinIO origin", async () => {
  const runtime = await createTestRuntime();
  let api: Api | undefined;
  try {
    const minio = await runtime.minio();
    const s3 = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
    });
    try {
      api = await startApi(runtime, {
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: minio.endpoint,
        S3_REGION: "us-east-1",
        S3_BUCKET: minio.bucket,
        S3_ACCESS_KEY: minio.accessKeyId,
        S3_SECRET_KEY: minio.secretAccessKey,
        S3_FORCE_PATH_STYLE: "true",
        S3_PUBLIC_URL: `${minio.endpoint}/${minio.bucket}`,
        ALLOW_INSECURE_LOCAL_HTTP: "true",
      });
      await setup(api);
      const owner = await register(api, "s3owner@example.org");
      const created = await upload(api, owner.accessToken, png(2400, 1200), "image/png");
      expect(created.status).toBe(201);
      const media = mediaSchema.parse(await created.json());
      expect(media).toMatchObject({
        storageDriver: "s3",
        width: 1920,
        height: 960,
        mimeType: "image/webp",
      });
      expect(media.publicUrl.startsWith(`${minio.endpoint}/${minio.bucket}/covers/`)).toBe(true);
      const key = media.publicUrl.slice(`${minio.endpoint}/${minio.bucket}/`.length);
      const head = await s3.send(new HeadObjectCommand({ Bucket: minio.bucket, Key: key }));
      expect(head.ContentLength).toBe(media.sizeBytes);
      expect((await call(api, `/media/${media.id}`, "DELETE", owner.accessToken)).status).toBe(200);
      await expect(
        s3.send(new HeadObjectCommand({ Bucket: minio.bucket, Key: key })),
      ).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
      await s3.send(new DeleteBucketCommand({ Bucket: minio.bucket }));
    } finally {
      s3.destroy();
    }
  } finally {
    await stopApi(api);
    await runtime.cleanup();
  }
});
