/**
 * TASK-166 content transactions and media references under concurrency, over real HTTP and
 * sockets (SA §4.3–4.4, §7.1, §11.2; US-03–06/15).
 *
 * Matrix: SQLite, PostgreSQL 16 and MySQL 8.4 on local storage, plus PostgreSQL on a MinIO (S3)
 * origin. MinIO is built from pinned source, or taken from `KABUKI_TEST_MINIO_IMAGE` when the
 * environment provides a prebuilt image of that source. A combination that cannot start fails; it
 * is never skipped.
 *
 * Covered per combination:
 * - Two saves racing on one revision: one wins (200), the other gets 409. The stored quiz is
 *   exactly the winner's, never a mix.
 * - Duplicates racing: distinct keys give complete independent copies; one key gives one copy.
 * - Hosting racing a save: a room is only created from the revision it names, and its first
 *   question is that revision's text.
 * - References pin media across owners and rooms:
 *   - a copy in another creator's quiz keeps the original upload in use;
 *   - an active room's snapshot keeps its media in use after the quiz drops it.
 * - Attach racing delete: exactly one wins. A quiz never points at a deleted upload, and every
 *   kept upload still serves its file.
 * - Cleanup:
 *   - it removes only unreferenced uploads;
 *   - its counters equal what was removed (count and bytes), and removed files stop being
 *     served;
 *   - a concurrent second cleanup is refused.
 */
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { io, type Socket } from "socket.io-client";
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
/** Storage/database combinations under test. */
const COMBINATIONS: [DbDriver, "local" | "minio"][] = [
  ["sqlite", "local"],
  ["postgres", "local"],
  ["mysql", "local"],
  ["postgres", "minio"],
];

/** A small valid PNG of one random colour (distinct bytes per call). */
function png(width = 4, height = 4): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Connects an authenticated host socket. */
async function connect(url: string, accessToken: string): Promise<Socket> {
  const socket = io(`${url}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { protocolVersion: 1, accessToken },
    extraHeaders: { origin: TEST_ORIGIN },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

/** Emits a command and returns its raw ACK. */
async function emit(socket: Socket, event: string, payload: Record<string, unknown>) {
  return (await socket
    .timeout(10_000)
    .emitWithAck(event, { requestId: randomUUID(), ...payload })) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { errorCode: string };
  };
}

/** One upload as the API returns it. */
interface Media {
  id: string;
  publicUrl: string;
  sizeBytes: number;
  revision: number;
  inUse: boolean;
}

describe.each(COMBINATIONS)("content races on %s with %s storage", (driver, storage) => {
  let runtime: TestRuntime | undefined;
  let api: ApiProcess | undefined;
  let call: ReturnType<typeof httpClient>;
  const sockets: Socket[] = [];
  const users: Record<"s" | "a" | "b", { accessToken: string; id: string }> = {
    s: { accessToken: "", id: "" },
    a: { accessToken: "", id: "" },
    b: { accessToken: "", id: "" },
  };
  /** Every upload made by A (for cleanup bookkeeping). */
  const uploads: Media[] = [];
  let template: Record<string, unknown> = {};
  /** MinIO access for blob checks (the test bucket is not public). */
  let s3: { client: S3Client; bucket: string; prefix: string } | null = null;

  /** True when the upload's file is stored: public fetch (local) or authenticated HEAD (S3). */
  const blobExists = async (media: Media): Promise<boolean> => {
    if (!s3) return (await fetch(media.publicUrl)).status === 200;
    try {
      await s3.client.send(
        new HeadObjectCommand({ Bucket: s3.bucket, Key: media.publicUrl.slice(s3.prefix.length) }),
      );
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return false;
      throw error;
    }
  };

  /** Valid question list built from the blank template. */
  const questions = (prompts: string[], mediaId: string | null = null) =>
    prompts.map((promptText, orderIndex) => ({
      ...template,
      id: randomUUID(),
      orderIndex,
      promptText,
      mediaId: orderIndex === 0 ? mediaId : null,
      options: [
        {
          id: randomUUID(),
          optionIndex: 0,
          colorIndex: 0,
          optionText: "Ya",
          isCorrect: true,
          sortOrder: 0,
        },
        {
          id: randomUUID(),
          optionIndex: 1,
          colorIndex: 1,
          optionText: "Tidak",
          isCorrect: false,
          sortOrder: 1,
        },
      ],
    }));
  /** Full quiz body. */
  const body = (
    title: string,
    prompts: string[],
    options: {
      visibility?: "PRIVATE" | "PUBLIC";
      cover?: string | null;
      mediaId?: string | null;
    } = {},
  ) => ({
    title,
    description: null,
    coverMediaId: options.cover ?? null,
    visibility: options.visibility ?? "PRIVATE",
    bgmTrack: "random",
    questions: questions(prompts, options.mediaId ?? null),
  });
  /** Creates and saves a quiz for A; returns id and revision. */
  const quiz = async (
    title: string,
    prompts: string[],
    options: Parameters<typeof body>[2] = {},
  ) => {
    const created = await call("/quizzes", {
      method: "POST",
      token: users.a.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { title },
    });
    expect(created.status).toBe(201);
    const draft = created.json as { id: string; revision: number };
    const saved = await call(`/quizzes/${draft.id}`, {
      method: "PUT",
      token: users.a.accessToken,
      headers: { "If-Match": `"${draft.revision}"` },
      body: body(title, prompts, options),
    });
    expect(saved.status).toBe(200);
    return saved.json as { id: string; revision: number };
  };
  /** Uploads an image as A. */
  const upload = async (): Promise<Media> => {
    if (!api) throw new Error("api missing");
    const form = new FormData();
    form.append("folder", "covers");
    form.append(
      "file",
      new Blob([new Uint8Array(png())], { type: "image/png" }),
      `${randomUUID()}.png`,
    );
    const response = await fetch(`${api.base}/media/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${users.a.accessToken}`,
        Origin: TEST_ORIGIN,
        "X-Kabuki-Client": "web-v1",
        "Idempotency-Key": randomUUID(),
        "X-Forwarded-For": "10.3.0.2",
      },
      body: form,
    });
    const text = await response.text();
    expect(response.status).toBe(201);
    const media = JSON.parse(text) as Media;
    uploads.push(media);
    return media;
  };
  /** A's current view of an upload from the library (null when gone). */
  const mediaOf = async (id: string): Promise<Media | null> => {
    const response = await call("/media?limit=100", { token: users.a.accessToken });
    expect(response.status).toBe(200);
    return (response.json as { items: Media[] }).items.find((media) => media.id === id) ?? null;
  };
  /** Deletes an upload as A with its current revision. */
  const remove = async (media: Media) =>
    call(`/media/${media.id}`, {
      method: "DELETE",
      token: users.a.accessToken,
      headers: { "If-Match": `"${media.revision}"` },
    });

  beforeAll(async () => {
    runtime = await createTestRuntime();
    const env: Record<string, string> = { ...(await databaseEnv(runtime, driver)), ...TRUST };
    if (storage === "minio") {
      const minio = await runtime.minio();
      s3 = {
        client: new S3Client({
          endpoint: minio.endpoint,
          region: "us-east-1",
          forcePathStyle: true,
          credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
        }),
        bucket: minio.bucket,
        prefix: `${minio.endpoint}/${minio.bucket}/`,
      };
      Object.assign(env, {
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
    }
    api = await startApi(runtime, env);
    call = httpClient(api.base);
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.3.0.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: { instanceName: "Content", name: "Super", email: "s@example.org", password: PASSWORD },
    });
    expect(setup.status).toBe(201);
    const account = (response: Awaited<ReturnType<typeof call>>) => {
      const value = response.json as { accessToken: string; user: { id: string } };
      return { accessToken: value.accessToken, id: value.user.id };
    };
    users.s = account(setup);
    for (const [key, ip] of [
      ["a", "10.3.0.2"],
      ["b", "10.3.0.3"],
    ] as const) {
      const registered = await call("/auth/register", {
        method: "POST",
        ip,
        headers: { "Idempotency-Key": randomUUID() },
        body: { name: key, email: `${key}@example.org`, password: PASSWORD },
      });
      expect(registered.status).toBe(201);
      users[key] = account(registered);
    }
    const blank = await call("/quizzes", {
      method: "POST",
      token: users.a.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { title: "Template" },
    });
    template = (blank.json as { questions: Record<string, unknown>[] }).questions[0] ?? {};
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    s3?.client.destroy();
    await api?.stop();
    await runtime?.cleanup();
  });

  it("keeps a quiz whole when two saves race on one revision", async () => {
    const created = await quiz("Balapan", ["Awal"]);
    const [first, second] = await Promise.all([
      call(`/quizzes/${created.id}`, {
        method: "PUT",
        token: users.a.accessToken,
        headers: { "If-Match": `"${created.revision}"` },
        body: body("Versi X", ["X1"]),
      }),
      call(`/quizzes/${created.id}`, {
        method: "PUT",
        token: users.a.accessToken,
        headers: { "If-Match": `"${created.revision}"` },
        body: body("Versi Y", ["Y1", "Y2", "Y3"]),
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect((loser.json as { errorCode: string }).errorCode).toBe("REVISION_CONFLICT");
    const winner = first.status === 200 ? "X" : "Y";
    const stored = (await call(`/quizzes/${created.id}`, { token: users.a.accessToken })).json as {
      title: string;
      questions: { promptText: string }[];
    };
    expect(stored.title).toBe(`Versi ${winner}`);
    expect(stored.questions.map((question) => question.promptText)).toEqual(
      winner === "X" ? ["X1"] : ["Y1", "Y2", "Y3"],
    );
  });

  it("duplicates concurrently into complete, independent copies", async () => {
    const source = await quiz("Sumber Publik", ["S1", "S2"], { visibility: "PUBLIC" });
    const duplicate = (key: string) =>
      call(`/quizzes/${source.id}/duplicate`, {
        method: "POST",
        token: users.b.accessToken,
        headers: { "Idempotency-Key": key },
        body: {},
      });
    const shared = randomUUID();
    const results = await Promise.all([
      duplicate(randomUUID()),
      duplicate(randomUUID()),
      duplicate(randomUUID()),
      duplicate(shared),
      duplicate(shared),
    ]);
    const distinct = results.slice(0, 3);
    expect(distinct.every((result) => result.status === 201)).toBe(true);
    const ids = new Set(distinct.map((result) => (result.json as { id: string }).id));
    expect(ids.size).toBe(3);
    const sameKey = results.slice(3);
    // One key: one copy (the second is either a replay of it or still pending).
    const sameIds = new Set(
      sameKey
        .filter((result) => result.status === 201)
        .map((result) => (result.json as { id: string }).id),
    );
    expect(sameIds.size).toBe(1);
    for (const result of sameKey.filter((value) => value.status !== 201))
      expect(result.status).toBe(409);
    for (const id of [...ids, ...sameIds]) {
      const copy = (await call(`/quizzes/${id}`, { token: users.b.accessToken })).json as {
        creatorId: string;
        questions: { promptText: string }[];
      };
      expect(copy.creatorId).toBe(users.b.id);
      expect(copy.questions.map((question) => question.promptText)).toEqual(["S1", "S2"]);
    }
    const own = (await call("/quizzes?scope=own&limit=100", { token: users.b.accessToken }))
      .json as {
      meta: { total: number };
    };
    expect(own.meta.total).toBe(4);
  });

  it("creates a room only from the named revision when hosting races a save", async () => {
    if (!api) throw new Error("api missing");
    const host = await connect(api.url, users.a.accessToken);
    sockets.push(host);
    const target = await quiz("Snapshot", ["Lama"]);
    const previews: string[] = [];
    host.on(
      "game:question_preview",
      (envelope: { data?: { question?: { promptText?: string } } }) => {
        const text = envelope?.data?.question?.promptText;
        if (text) previews.push(text);
      },
    );
    const [room, saved] = await Promise.all([
      emit(host, "host:create_room", {
        quizId: target.id,
        quizRevision: target.revision,
        displayMode: "PROJECTOR",
        friendlyNicknames: false,
      }),
      call(`/quizzes/${target.id}`, {
        method: "PUT",
        token: users.a.accessToken,
        headers: { "If-Match": `"${target.revision}"` },
        body: body("Snapshot", ["Baru"]),
      }),
    ]);
    expect(saved.status).toBe(200);
    if (!room.ok) {
      // The save won: the stale revision is refused, nothing half-created.
      expect(room.error?.errorCode).toBeDefined();
      return;
    }
    const member = { sessionId: room.data?.["sessionId"], pinCode: room.data?.["pinCode"] };
    const player = io(`${api.url}/game`, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: { protocolVersion: 1 },
      extraHeaders: { origin: TEST_ORIGIN },
      reconnection: false,
    });
    sockets.push(player);
    await new Promise<void>((resolve) => player.once("connect", () => resolve()));
    expect(
      (
        await emit(player, "player:join_room", {
          pinCode: member.pinCode,
          nickname: "Pemain",
          avatar: { style: "bottts", seed: "p" },
        })
      ).ok,
    ).toBe(true);
    expect((await emit(host, "host:start_game", { ...member, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );
    for (let attempt = 0; attempt < 100 && previews.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(previews[0]).toBe("Lama");
  });

  it("pins uploads referenced by another creator's copy or an active room", async () => {
    if (!api) throw new Error("api missing");
    // A copy in B's quiz keeps A's cover in use after A drops it.
    const cover = await upload();
    const shared = await quiz("Bersampul", ["Q"], { visibility: "PUBLIC", cover: cover.id });
    const copy = await call(`/quizzes/${shared.id}/duplicate`, {
      method: "POST",
      token: users.b.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(copy.status).toBe(201);
    expect(
      (
        await call(`/quizzes/${shared.id}`, {
          method: "PUT",
          token: users.a.accessToken,
          headers: { "If-Match": `"${shared.revision}"` },
          body: body("Bersampul", ["Q"], { visibility: "PUBLIC" }),
        })
      ).status,
    ).toBe(200);
    const coverNow = await mediaOf(cover.id);
    if (!coverNow) throw new Error("cover missing");
    expect(coverNow.inUse).toBe(true);
    const refused = await remove(coverNow);
    expect(refused.status).toBe(409);
    expect((refused.json as { errorCode: string }).errorCode).toBe("MEDIA_IN_USE");

    // An active room's snapshot keeps question media in use after the quiz drops it.
    const image = await upload();
    const hosted = await quiz("Bergambar", ["Lihat"], { mediaId: image.id });
    const host = await connect(api.url, users.a.accessToken);
    sockets.push(host);
    const room = await emit(host, "host:create_room", {
      quizId: hosted.id,
      quizRevision: hosted.revision,
      displayMode: "PROJECTOR",
      friendlyNicknames: false,
    });
    expect(room.ok).toBe(true);
    expect(
      (
        await call(`/quizzes/${hosted.id}`, {
          method: "PUT",
          token: users.a.accessToken,
          headers: { "If-Match": `"${hosted.revision}"` },
          body: body("Bergambar", ["Lihat"]),
        })
      ).status,
    ).toBe(200);
    const pinned = await mediaOf(image.id);
    if (!pinned) throw new Error("image missing");
    expect(pinned.inUse).toBe(true);
    expect((await remove(pinned)).status).toBe(409);
    expect(await blobExists(pinned)).toBe(true);
  });

  it("serializes attach against delete so no quiz points at a deleted upload", async () => {
    for (let round = 0; round < 3; round++) {
      const media = await upload();
      const target = await quiz(`Lampiran ${round}`, ["Q"]);
      const [attach, deletion] = await Promise.all([
        call(`/quizzes/${target.id}`, {
          method: "PUT",
          token: users.a.accessToken,
          headers: { "If-Match": `"${target.revision}"` },
          body: body(`Lampiran ${round}`, ["Q"], { cover: media.id }),
        }),
        remove(media),
      ]);
      const attached = attach.status === 200;
      const deleted = deletion.status === 200;
      expect(attached !== deleted).toBe(true);
      const stored = (await call(`/quizzes/${target.id}`, { token: users.a.accessToken })).json as {
        coverMedia: { id: string } | null;
      };
      const remaining = await mediaOf(media.id);
      if (attached) {
        expect(stored.coverMedia?.id).toBe(media.id);
        expect(remaining).not.toBeNull();
        expect(await blobExists(media)).toBe(true);
      } else {
        expect(stored.coverMedia).toBeNull();
        expect(remaining).toBeNull();
      }
    }
  });

  it("cleans only unreferenced uploads with truthful counters, one run at a time", async () => {
    await upload();
    await upload();
    // What A's uploads look like right before cleanup.
    const current = (await Promise.all(uploads.map((media) => mediaOf(media.id)))).filter(
      (media): media is Media => media !== null,
    );
    const orphans = current.filter((media) => !media.inUse);
    const kept = current.filter((media) => media.inUse);
    expect(orphans.length).toBeGreaterThanOrEqual(2);
    const cleanup = () =>
      call("/system/storage/cleanup-orphans", {
        method: "POST",
        token: users.s.accessToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
    const [one, two] = await Promise.all([cleanup(), cleanup()]);
    const statuses = [one.status, two.status].sort();
    // A concurrent second run is refused (busy lease 429 or 409), or ran after the first.
    expect(statuses[0]).toBe(200);
    expect([200, 409, 429]).toContain(statuses[1]);
    const runs = [one, two]
      .filter((run) => run.status === 200)
      .map(
        (run) =>
          run.json as {
            deletedCount: number;
            freedBytes: number;
            failedCount: number;
            scannedCount: number;
            skippedInUseCount: number;
          },
      );
    const deletedCount = runs.reduce((sum, run) => sum + run.deletedCount, 0);
    const freedBytes = runs.reduce((sum, run) => sum + run.freedBytes, 0);
    expect(runs.every((run) => run.failedCount === 0)).toBe(true);
    expect(deletedCount).toBe(orphans.length);
    expect(freedBytes).toBe(orphans.reduce((sum, media) => sum + media.sizeBytes, 0));
    for (const media of orphans) {
      expect(await mediaOf(media.id)).toBeNull();
      expect(await blobExists(media)).toBe(false);
    }
    for (const media of kept) {
      expect(await mediaOf(media.id)).not.toBeNull();
      expect(await blobExists(media)).toBe(true);
    }
  });
});
