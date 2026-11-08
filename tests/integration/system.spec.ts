/**
 * TASK-074 integration coverage for the seven /system routes against the built API: public health
 * (redacted), public-config (effective default locale + generated lobby tracks), locale registry
 * (no-cache, ETag/304), About, SUPERADMIN settings read/PATCH (role, Origin, If-Match, strictness,
 * installed locale) and storage cleanup with a partial failure and the CLEANUP rate tier.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { z } from "zod";
import {
  BGM_DEFAULT_VOLUMES,
  LOBBY_TRACK_METADATA,
  SFX_DEFINITIONS,
} from "@kabuki-neko/shared/constants/audio";
import { mediaSchema } from "@kabuki-neko/shared/schemas/media.schema";
import { localeRegistrySchema } from "@kabuki-neko/shared/schemas/locale.schema";
import {
  aboutSchema,
  cleanupResultSchema,
  healthSchema,
  publicConfigSchema,
  settingsResponseSchema,
  settingsSchema,
} from "@kabuki-neko/shared/schemas/system.schema";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { createSyntheticCatalog, createTestRuntime } from "../helpers/runtime";

const credentialsSchema = z.object({ user: userSchema, accessToken: z.string() });
const errorSchema = z.object({ errorCode: z.string() });
type Credentials = z.infer<typeof credentialsSchema>;
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let child: ChildProcess;
let base: string;
let admin: Credentials;
let creator: Credentials;
let buildId: string;

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
/** JSON request helper; `origin: false` omits the browser Origin/client headers. */
function call(
  pathname: string,
  method = "GET",
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
  origin = true,
) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(origin ? { "X-Kabuki-Client": "web-v1", Origin: "http://localhost:3000" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
/** Status and error code of a failed response. */
async function code(response: Response) {
  return [response.status, errorSchema.parse(await response.json()).errorCode];
}
/** One PNG chunk with its CRC. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** Minimal solid RGB PNG (root tests have no Sharp dependency). */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x33)]);
  const data = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", data),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
/** Uploads an image into `folder` as the given user. */
async function upload(token: string, folder: string) {
  const form = new FormData();
  form.append("folder", folder);
  form.append("file", new Blob([png(16, 8)], { type: "image/png" }), "orphan.png");
  const response = await fetch(`${base}/media/upload`, {
    method: "POST",
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": randomUUID(),
    },
    body: form,
  });
  expect(response.status).toBe(201);
  return mediaSchema.parse(await response.json());
}
/** Writes a generated-style audio manifest with placeholder WebM/MP3 outputs for every cue. */
async function audioCatalog(root: string) {
  const src = (folder: string, file: string) => [
    `/audio/${folder}/${file}.webm`,
    `/audio/${folder}/${file}.mp3`,
  ];
  const files: [string, string][] = [];
  const bgm = (folder: string, file: string, volume: number) => {
    files.push([folder, file]);
    return { src: src(folder, file), loop: true, volume };
  };
  const lobby = Object.entries(LOBBY_TRACK_METADATA).map(([id, meta]) => {
    files.push(["01-lobby", `bgm-lobby-${id}`]);
    return {
      id,
      label: meta.label,
      src: src("01-lobby", `bgm-lobby-${id}`),
      loop: true,
      volume: meta.volume,
    };
  });
  const manifest = {
    lobby,
    thinking: {
      sprint: bgm("02-thinking", "bgm-think-sprint", BGM_DEFAULT_VOLUMES.thinking.sprint),
      standard: bgm("02-thinking", "bgm-think-standard", BGM_DEFAULT_VOLUMES.thinking.standard),
      puzzle: bgm("02-thinking", "bgm-think-puzzle", BGM_DEFAULT_VOLUMES.thinking.puzzle),
    },
    leaderboard: {
      groove: bgm(
        "03-leaderboard",
        "bgm-leaderboard-groove",
        BGM_DEFAULT_VOLUMES.leaderboard.groove,
      ),
    },
    podium: {
      buildup: bgm("04-podium", "bgm-podium-buildup", BGM_DEFAULT_VOLUMES.podium.buildup),
      victory: bgm("04-podium", "bgm-podium-victory", BGM_DEFAULT_VOLUMES.podium.victory),
    },
    sfx: Object.fromEntries(
      Object.entries(SFX_DEFINITIONS).map(([id, definition]) => {
        files.push(["05-sfx", definition.filename]);
        return [
          id,
          {
            src: src("05-sfx", definition.filename),
            volume: definition.volume,
            ...("throttleMs" in definition ? { throttleMs: definition.throttleMs } : {}),
          },
        ];
      }),
    ),
  };
  for (const [folder, file] of files) {
    await mkdir(path.join(root, folder), { recursive: true });
    for (const ext of ["webm", "mp3"])
      await writeFile(path.join(root, folder, `${file}.${ext}`), "x");
  }
  const manifestFile = path.join(root, "audio-manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest));
  return manifestFile;
}
/** Registers a CREATOR through public registration. */
async function register(email: string) {
  const response = await call(
    "/auth/register",
    "POST",
    undefined,
    { name: "Creator", email, password: "Correct-password-123!" },
    { "Idempotency-Key": randomUUID() },
  );
  expect(response.status).toBe(201);
  return credentialsSchema.parse(await response.json());
}

beforeAll(async () => {
  runtime = await createTestRuntime();
  buildId = await createSyntheticCatalog(
    runtime.env.LOCALE_BUNDLE_PATH ?? "",
    path.join(process.cwd(), "packages/shared/locales/message-contracts.json"),
  );
  const manifest = await audioCatalog(path.join(runtime.directory, "audio"));
  const port = await freePort();
  child = spawn(process.execPath, [path.join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: {
      ...process.env,
      ...runtime.env,
      AUDIO_MANIFEST_PATH: manifest,
      API_PORT: String(port),
      PORT: String(port),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
    },
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}/api/v1`;
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error("API exited during startup");
    try {
      ready = (await fetch(`${base}/auth/setup-status`)).status === 200;
    } catch {
      /* Wait for server startup. */
    }
    if (!ready) await delay(100);
  }
  expect(ready).toBe(true);
  const setup = await call(
    "/auth/setup",
    "POST",
    undefined,
    {
      instanceName: "System integration",
      name: "Admin",
      email: "admin@example.org",
      password: "Correct-password-123!",
    },
    { "Idempotency-Key": randomUUID() },
  );
  expect(setup.status).toBe(201);
  admin = credentialsSchema.parse(await setup.json());
  creator = await register("creator@example.org");
}, 120_000);

afterAll(async () => {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await runtime.cleanup();
});

it("serves redacted public health, public config, locales and About", async () => {
  const health = await call("/system/health", "GET", undefined, undefined, {}, false);
  expect(health.status).toBe(200);
  const body = await health.text();
  const parsed = healthSchema.parse(JSON.parse(body));
  expect(parsed).toMatchObject({
    status: "ok",
    dbDriver: "sqlite",
    storageDriver: "local",
    stateDriver: "memory",
  });
  for (const secret of [
    runtime.env.JWT_ACCESS_SECRET,
    runtime.env.JWT_REFRESH_SECRET,
    runtime.env.SQLITE_PATH,
    runtime.directory,
  ])
    expect(body).not.toContain(secret ?? "never");
  expect((await call("/system/health?verbose=1")).status).toBe(422);

  const config = publicConfigSchema.parse(await (await call("/system/public-config")).json());
  expect(config).toMatchObject({
    instanceName: "System integration",
    defaultLocale: "en",
    catalogVersion: "1",
    limits: { imageMb: 5, audioMb: 10, videoMb: 25 },
  });
  expect(config.audioTracks.map((track) => track.id)).toEqual(Object.keys(LOBBY_TRACK_METADATA));

  const locales = await call("/system/locales");
  expect(locales.status).toBe(200);
  expect(locales.headers.get("cache-control")).toBe("no-cache");
  expect(locales.headers.get("etag")).toBe(`"${buildId}"`);
  const registry = localeRegistrySchema.parse(await locales.json());
  expect(registry.locales.map((locale) => locale.tag)).toEqual(["en"]);
  const cached = await call("/system/locales", "GET", undefined, undefined, {
    "If-None-Match": `"${buildId}"`,
  });
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe("");

  const version = (
    JSON.parse(await readFile(path.join(process.cwd(), "apps/api/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  expect(aboutSchema.parse(await (await call("/system/about")).json()).version).toBe(version);
});

it("restricts settings to SUPERADMIN with Origin, If-Match, strict fields and installed locales", async () => {
  expect((await call("/system/settings")).status).toBe(401);
  expect(await code(await call("/system/settings", "GET", creator.accessToken))).toEqual([
    403,
    "FORBIDDEN",
  ]);
  const current = settingsResponseSchema.parse(
    await (await call("/system/settings", "GET", admin.accessToken)).json(),
  );
  expect(current.settings).toMatchObject({
    instanceName: "System integration",
    revision: expect.any(Number),
  });
  expect(current.metrics.status).toBe("fresh");
  const revision = current.settings.revision;
  const patch = { instanceName: "Renamed", registrationMode: "INVITE_ONLY" };
  expect(
    await code(
      await call(
        "/system/settings",
        "PATCH",
        admin.accessToken,
        patch,
        { "If-Match": `"${revision}"` },
        false,
      ),
    ),
  ).toEqual([403, "ORIGIN_DENIED"]);
  expect(await code(await call("/system/settings", "PATCH", admin.accessToken, patch))).toEqual([
    422,
    "VALIDATION_FAILED",
  ]);
  expect(
    await code(
      await call("/system/settings", "PATCH", creator.accessToken, patch, {
        "If-Match": `"${revision}"`,
      }),
    ),
  ).toEqual([403, "FORBIDDEN"]);
  expect(
    await code(
      await call(
        "/system/settings",
        "PATCH",
        admin.accessToken,
        { dbDriver: "mysql" },
        { "If-Match": `"${revision}"` },
      ),
    ),
  ).toEqual([422, "VALIDATION_FAILED"]);
  expect(
    await code(
      await call(
        "/system/settings",
        "PATCH",
        admin.accessToken,
        { defaultLocale: "de" },
        { "If-Match": `"${revision}"` },
      ),
    ),
  ).toEqual([422, "INVALID_LOCALE"]);
  const saved = await call("/system/settings", "PATCH", admin.accessToken, patch, {
    "If-Match": `"${revision}"`,
  });
  expect(saved.status).toBe(200);
  expect(saved.headers.get("etag")).toBe(`"${revision + 1}"`);
  expect(settingsSchema.parse(await saved.json())).toMatchObject({
    instanceName: "Renamed",
    registrationMode: "INVITE_ONLY",
  });
  expect(
    await code(
      await call(
        "/system/settings",
        "PATCH",
        admin.accessToken,
        { instanceName: "Stale" },
        { "If-Match": `"${revision}"` },
      ),
    ),
  ).toEqual([409, "REVISION_CONFLICT"]);
  const english = await call(
    "/system/settings",
    "PATCH",
    admin.accessToken,
    { defaultLocale: "en" },
    { "If-Match": `"${revision + 1}"` },
  );
  expect(english.status).toBe(200);
  expect(
    publicConfigSchema.parse(await (await call("/system/public-config")).json()),
  ).toMatchObject({
    instanceName: "Renamed",
    defaultLocale: "en",
    registrationMode: "INVITE_ONLY",
  });
});

it("cleans orphans with partial failures, reports metrics and enforces the cleanup tier", async () => {
  const cover = await upload(admin.accessToken, "covers");
  const question = await upload(admin.accessToken, "questions");
  const before = settingsResponseSchema.parse(
    await (await call("/system/settings", "GET", admin.accessToken)).json(),
  );
  expect(before.metrics).toMatchObject({ status: "fresh" });
  expect(
    await code(
      await call(
        "/system/storage/cleanup-orphans",
        "POST",
        creator.accessToken,
        {},
        { "Idempotency-Key": randomUUID() },
      ),
    ),
  ).toEqual([403, "FORBIDDEN"]);
  const covers = path.join(runtime.env.LOCAL_STORAGE_PATH ?? "", "covers");
  await chmod(covers, 0o555);
  let result;
  try {
    const response = await call(
      "/system/storage/cleanup-orphans",
      "POST",
      admin.accessToken,
      {},
      { "Idempotency-Key": randomUUID() },
    );
    expect(response.status).toBe(200);
    result = cleanupResultSchema.parse(await response.json());
  } finally {
    await chmod(covers, 0o755);
  }
  expect(result).toMatchObject({
    scannedCount: 2,
    deletedCount: 1,
    freedBytes: question.sizeBytes,
    failedCount: 1,
    failures: [{ mediaId: cover.id, errorCode: "DELETE_FAILED" }],
    hasMore: false,
  });
  const listed = z
    .object({ items: z.array(mediaSchema) })
    .parse(await (await call("/media", "GET", admin.accessToken)).json());
  expect(listed.items.map((item) => item.id)).toEqual([cover.id]);
  expect(
    await code(
      await call(
        "/system/storage/cleanup-orphans",
        "POST",
        admin.accessToken,
        {},
        { "Idempotency-Key": randomUUID() },
      ),
    ),
  ).toEqual([429, "RATE_LIMITED"]);
});
