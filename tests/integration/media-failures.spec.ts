/**
 * TASK-166 failure injection for media and imports (SA §7.1, §4.3; US-03–06/15).
 *
 * Local storage on SQLite, PostgreSQL 16 and MySQL 8.4:
 * - Malformed imports and uploads are rejected with stable errors and leave no quiz, media or
 *   finished operation behind.
 * - An import interrupted mid-body creates nothing; the same file completes afterwards, exactly
 *   once.
 * - A missing S3 origin setting refuses startup without printing the configured secret.
 *
 * MinIO origin on PostgreSQL. The container is paused to freeze storage at a precise point, and
 * the API is killed with SIGKILL as a crash:
 * - A storage outage during an upload never answers 201 and never lists the upload; uploads work
 *   again once storage is back.
 * - A crash while the blob is being written leaves no listed upload after restart, and existing
 *   uploads keep their files.
 * - A crash after a delete was claimed is finished by the startup janitor: the row and the blob
 *   both disappear.
 * - Cleanup during an outage answers 503 STORAGE_UNAVAILABLE (never a successful zero), restores
 *   the rows and keeps the files; the next run deletes them with exact counters.
 * MinIO comes from pinned source, or `KABUKI_TEST_MINIO_IMAGE` (a prebuilt image of that source).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import {
  TEST_ORIGIN,
  createTestRuntime,
  databaseEnv,
  httpClient,
  startApi,
  type ApiProcess,
  type DbDriver,
  type TestRuntime,
} from "../helpers/runtime";

const PASSWORD = "Correct-password-123!";
const TRUST = { TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]' };

/** A small valid PNG of one random colour. */
function png(width = 4, height = 4): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const colour = [0, 1, 2].map(() => Math.floor(Math.random() * 256));
  const rows = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.from([0, ...Array.from({ length: width }, () => colour).flat()]),
    ),
  );
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** One upload as listed by the API. */
interface Media {
  id: string;
  publicUrl: string;
  sizeBytes: number;
  revision: number;
}

/** Retries a request answered 429, after the server's retry hint (rate-limited tiers). */
async function withRetry<T extends { status: number; json: unknown }>(send: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 429 || attempt >= 3) return response;
    const hint = (response.json as { params?: { retryAfterMs?: number } } | null)?.params
      ?.retryAfterMs;
    await new Promise((resolve) => setTimeout(resolve, (hint ?? 60_000) + 500));
  }
}

/** Signs up an administrator and a creator; returns their tokens. */
async function accounts(call: ReturnType<typeof httpClient>) {
  const setup = await call("/auth/setup", {
    method: "POST",
    ip: "10.4.0.1",
    headers: { "Idempotency-Key": randomUUID() },
    body: { instanceName: "Failures", name: "Super", email: "s@example.org", password: PASSWORD },
  });
  expect(setup.status).toBe(201);
  const creator = await call("/auth/register", {
    method: "POST",
    ip: "10.4.0.2",
    headers: { "Idempotency-Key": randomUUID() },
    body: { name: "Ani", email: "a@example.org", password: PASSWORD },
  });
  expect(creator.status).toBe(201);
  return {
    admin: (setup.json as { accessToken: string }).accessToken,
    creator: (creator.json as { accessToken: string }).accessToken,
  };
}

/** Sends a multipart request with the web headers (and an optional abort signal). */
function multipart(
  api: ApiProcess,
  path: string,
  token: string,
  form: FormData,
  key: string = randomUUID(),
  signal?: AbortSignal,
) {
  return fetch(`${api.base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: TEST_ORIGIN,
      "X-Kabuki-Client": "web-v1",
      "Idempotency-Key": key,
      "X-Forwarded-For": "10.4.0.2",
    },
    body: form,
    ...(signal ? { signal } : {}),
  });
}

/** Upload form for one image (or arbitrary bytes with a declared type). */
function imageForm(bytes: Uint8Array = png(), type = "image/png", name = "gambar.png") {
  const form = new FormData();
  form.append("folder", "covers");
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name);
  return form;
}

/** The creator's library. */
async function library(call: ReturnType<typeof httpClient>, token: string): Promise<Media[]> {
  const response = await call("/media?limit=100", { token });
  expect(response.status).toBe(200);
  return (response.json as { items: Media[] }).items;
}

/** The creator's quiz count. */
async function quizCount(call: ReturnType<typeof httpClient>, token: string): Promise<number> {
  const response = await call("/quizzes?scope=own&limit=1", { token });
  expect(response.status).toBe(200);
  return (response.json as { meta: { total: number } }).meta.total;
}

describe.each(["sqlite", "postgres", "mysql"] as DbDriver[])(
  "content failures on %s with local storage",
  (driver) => {
    let runtime: TestRuntime | undefined;
    let api: ApiProcess | undefined;
    let call: ReturnType<typeof httpClient>;
    let token = "";
    let exportText = "";

    beforeAll(async () => {
      runtime = await createTestRuntime();
      api = await startApi(runtime, { ...(await databaseEnv(runtime, driver)), ...TRUST });
      call = httpClient(api.base);
      token = (await accounts(call)).creator;
      // A valid export file to import later.
      const created = await call("/quizzes", {
        method: "POST",
        token,
        headers: { "Idempotency-Key": randomUUID() },
        body: { title: "Sumber Impor" },
      });
      expect(created.status).toBe(201);
      const exported = await call(`/quizzes/${(created.json as { id: string }).id}/export`, {
        token,
      });
      expect(exported.status).toBe(200);
      exportText = exported.text;
    });

    afterAll(async () => {
      await api?.stop();
      await runtime?.cleanup();
    });

    it("rejects malformed imports and uploads without leaving rows or receipts", async () => {
      if (!api) throw new Error("api missing");
      const quizzes = await quizCount(call, token);
      const media = (await library(call, token)).length;
      const keys: string[] = [];
      const importForm = (name: string, content: string, type: string) => {
        const form = new FormData();
        form.append("file", new Blob([content], { type }), name);
        return form;
      };
      const attempts: [FormData, string, number, string][] = [
        [
          importForm("rusak.json", "{", "application/json"),
          "/quizzes/import",
          400,
          "MALFORMED_JSON",
        ],
        [
          importForm("rusak.csv", "a,b\r\n1,2\r\n", "text/csv"),
          "/quizzes/import",
          400,
          "MALFORMED_CSV",
        ],
        [
          importForm("kuis.txt", "{}", "text/plain"),
          "/quizzes/import",
          415,
          "UNSUPPORTED_CONTENT_TYPE",
        ],
        [imageForm(new TextEncoder().encode("bukan gambar")), "/media/upload", 422, ""],
        [
          imageForm(
            new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
            "image/svg+xml",
            "x.svg",
          ),
          "/media/upload",
          415,
          "",
        ],
      ];
      for (const [form, path, status, errorCode] of attempts) {
        const key = randomUUID();
        keys.push(key);
        const response = await multipart(api, path, token, form, key);
        const body = (await response.json()) as { errorCode: string };
        expect([status, ...(status === 415 ? [422] : [])]).toContain(response.status);
        if (errorCode) expect(body.errorCode).toBe(errorCode);
      }
      expect(await quizCount(call, token)).toBe(quizzes);
      expect((await library(call, token)).length).toBe(media);
      for (const key of keys) {
        for (const operation of ["quiz.import", "media.upload"]) {
          const lookup = await call(`/operations/${key}?operation=${operation}`, { token });
          if (lookup.status === 200)
            expect((lookup.json as { status: string }).status).not.toBe("done");
          else expect(lookup.status).toBe(404);
        }
      }
    });

    it("creates nothing from an import interrupted mid-body, then imports it once", async () => {
      if (!api) throw new Error("api missing");
      const before = await quizCount(call, token);
      const boundary = `----kabuki${randomUUID()}`;
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="kuis.json"\r\n` +
          `Content-Type: application/json\r\n\r\n${exportText}\r\n--${boundary}--\r\n`,
      );
      const controller = new AbortController();
      const key = randomUUID();
      const half = payload.subarray(0, Math.floor(payload.length / 2));
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array(half));
          // Abort after the first half reached the server, without ever closing the body.
          setTimeout(() => controller.abort(), 300);
        },
      });
      await expect(
        fetch(`${api.base}/quizzes/import`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: TEST_ORIGIN,
            "X-Kabuki-Client": "web-v1",
            "Idempotency-Key": key,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "X-Forwarded-For": "10.4.0.2",
          },
          body: stream,
          signal: controller.signal,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await quizCount(call, token)).toBe(before);
      // The whole file afterwards: exactly one new quiz, also for a replay of the same key.
      const form = new FormData();
      form.append("file", new Blob([exportText], { type: "application/json" }), "kuis.json");
      const complete = randomUUID();
      const first = await multipart(api, "/quizzes/import", token, form, complete);
      expect(first.status).toBe(201);
      const again = new FormData();
      again.append("file", new Blob([exportText], { type: "application/json" }), "kuis.json");
      const replay = await multipart(api, "/quizzes/import", token, again, complete);
      expect([200, 201]).toContain(replay.status);
      expect(await quizCount(call, token)).toBe(before + 1);
    });

    it("refuses to start with an incomplete S3 origin, without printing its secret", async () => {
      if (!runtime) throw new Error("runtime missing");
      const secret = `s3secret${randomUUID().replace(/-/gu, "")}`;
      const failure = await startApi(runtime, {
        DB_DRIVER: "sqlite", // configuration is validated before any database is opened
        STORAGE_DRIVER: "s3",
        S3_ENDPOINT: "http://127.0.0.1:9",
        S3_BUCKET: "missing",
        S3_ACCESS_KEY: "accesskeyvalue",
        S3_SECRET_KEY: secret,
      }).then(
        async (started) => {
          await started.stop();
          return null;
        },
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).not.toContain(secret);
    });
  },
);

describe("media failures on postgres with a MinIO origin", () => {
  let runtime: TestRuntime | undefined;
  let api: ApiProcess | undefined;
  let call: ReturnType<typeof httpClient>;
  let env: Record<string, string> = {};
  let token = "";
  let admin = "";
  let containerId = "";
  let s3: S3Client | undefined;
  let bucket = "";
  let prefix = "";

  /** Freezes or resumes the MinIO container. */
  const storage = (action: "pause" | "unpause") =>
    execFileSync("docker", [action, containerId], { stdio: "ignore" });
  /** True when the upload's object exists in the bucket. */
  const stored = async (media: Media) => {
    try {
      await s3?.send(
        new HeadObjectCommand({ Bucket: bucket, Key: media.publicUrl.slice(prefix.length) }),
      );
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return false;
      throw error;
    }
  };
  /** Uploads one image and returns it. */
  const upload = async (): Promise<Media> => {
    const response = await withRetry(async () => {
      if (!api) throw new Error("api missing");
      const answer = await multipart(api, "/media/upload", token, imageForm());
      return { status: answer.status, json: (await answer.json()) as unknown };
    });
    expect(response.status).toBe(201);
    return response.json as Media;
  };
  /** Kills the API (crash) and starts a new process on the same database and storage. */
  const crashAndRestart = async () => {
    if (!runtime || !api) throw new Error("setup missing");
    await api.kill();
    api = await startApi(runtime, env);
    call = httpClient(api.base);
  };

  beforeAll(async () => {
    runtime = await createTestRuntime();
    const minio = await runtime.minio();
    containerId = minio.container.getId();
    bucket = minio.bucket;
    prefix = `${minio.endpoint}/${minio.bucket}/`;
    s3 = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
    });
    env = {
      ...(await databaseEnv(runtime, "postgres")),
      ...TRUST,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: minio.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: minio.bucket,
      S3_ACCESS_KEY: minio.accessKeyId,
      S3_SECRET_KEY: minio.secretAccessKey,
      S3_FORCE_PATH_STYLE: "true",
      S3_PUBLIC_URL: `${minio.endpoint}/${minio.bucket}`,
      ALLOW_INSECURE_LOCAL_HTTP: "true",
    };
    api = await startApi(runtime, env);
    call = httpClient(api.base);
    const tokens = await accounts(call);
    token = tokens.creator;
    admin = tokens.admin;
  });

  afterAll(async () => {
    try {
      storage("unpause");
    } catch {
      // Not paused.
    }
    s3?.destroy();
    await api?.stop();
    await runtime?.cleanup();
  });

  it("never answers 201 or lists an upload during a storage outage", async () => {
    if (!api) throw new Error("api missing");
    const before = (await library(call, token)).length;
    storage("pause");
    // No answer at all (-1) is also not a success.
    const status = await multipart(
      api,
      "/media/upload",
      token,
      imageForm(),
      randomUUID(),
      AbortSignal.timeout(60_000),
    )
      .then(
        (response) => response.status,
        () => -1,
      )
      .finally(() => storage("unpause"));
    expect(status).not.toBe(201);
    expect((await library(call, token)).length).toBe(before);
    const recovered = await upload();
    expect(await stored(recovered)).toBe(true);
  });

  it("keeps no half-written upload after a crash during the blob write", async () => {
    if (!api) throw new Error("api missing");
    const existing = await upload();
    const before = (await library(call, token)).map((media) => media.id);
    storage("pause");
    const pending = multipart(api, "/media/upload", token, imageForm()).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await crashAndRestart();
    await pending;
    storage("unpause");
    const after = await library(call, token);
    expect(after.map((media) => media.id).sort()).toEqual([...before].sort());
    expect(await stored(existing)).toBe(true);
    expect(await stored(await upload())).toBe(true);
  });

  it("finishes a delete interrupted by a crash once the API restarts", async () => {
    if (!api || !runtime) throw new Error("api missing");
    const doomed = await upload();
    storage("pause");
    const pending = call(`/media/${doomed.id}`, {
      method: "DELETE",
      token,
      headers: { "If-Match": `"${doomed.revision}"` },
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await api.kill();
    await pending;
    storage("unpause");
    // The crash left the claimed DELETING row. The janitor treats claims older than ten minutes as
    // abandoned, so the claim is aged instead of waiting (it simulates elapsed time only).
    const database = new Client({ connectionString: env["DATABASE_URL"] });
    await database.connect();
    try {
      const aged = await database.query(
        "UPDATE media_assets SET updated_at = updated_at - 660000 WHERE id = $1 AND state = 'DELETING'",
        [doomed.id],
      );
      expect(aged.rowCount).toBe(1);
    } finally {
      await database.end();
    }
    expect(await stored(doomed)).toBe(true);
    api = await startApi(runtime, env);
    call = httpClient(api.base);
    // The startup sweep finishes the deletion: row and blob, idempotently.
    for (let attempt = 0; attempt < 60; attempt++) {
      const listed = (await library(call, token)).some((media) => media.id === doomed.id);
      if (!listed && !(await stored(doomed))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await library(call, token)).some((media) => media.id === doomed.id)).toBe(false);
    expect(await stored(doomed)).toBe(false);
  });

  it("reports a cleanup outage as a failure, keeps rows and files, then deletes exactly", async () => {
    const orphans = [await upload(), await upload()];
    // Everything unreferenced is an orphan here (no quiz uses any upload).
    const everyone = await library(call, token);
    const cleanup = () =>
      withRetry(() =>
        call("/system/storage/cleanup-orphans", {
          method: "POST",
          token: admin,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        }),
      );
    storage("pause");
    let outage: Awaited<ReturnType<typeof cleanup>>;
    try {
      outage = await cleanup();
    } finally {
      storage("unpause");
    }
    // Nothing could be deleted: the run reports the outage (503), never a successful zero.
    expect(outage.status).toBe(503);
    expect((outage.json as { errorCode: string }).errorCode).toBe("STORAGE_UNAVAILABLE");
    // Rows restored and files kept.
    expect((await library(call, token)).length).toBe(everyone.length);
    for (const media of orphans) expect(await stored(media)).toBe(true);
    // Cleanup candidates are every unreferenced READY or FAILED row (the outage upload left a
    // FAILED reservation that the library does not list), read straight from the database.
    const database = new Client({ connectionString: env["DATABASE_URL"] });
    await database.connect();
    let candidates: { size_bytes: string | number | null }[];
    try {
      candidates = (
        await database.query<{ size_bytes: string | number | null }>(
          "SELECT size_bytes FROM media_assets WHERE state IN ('READY','FAILED')",
        )
      ).rows;
    } finally {
      await database.end();
    }
    const done = await cleanup();
    expect(done.status).toBe(200);
    const result = done.json as { deletedCount: number; failedCount: number; freedBytes: number };
    expect(result.failedCount).toBe(0);
    expect(result.deletedCount).toBe(candidates.length);
    expect(result.freedBytes).toBe(
      candidates.reduce((sum, row) => sum + Number(row.size_bytes ?? 0), 0),
    );
    expect(result.freedBytes).toBeGreaterThanOrEqual(
      everyone.reduce((sum, media) => sum + media.sizeBytes, 0),
    );
    expect(await library(call, token)).toEqual([]);
    for (const media of orphans) expect(await stored(media)).toBe(false);
  });
});
