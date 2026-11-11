/**
 * TASK-170 adapter parity matrix (SA §11.2; US-06, US-16, US-17).
 *
 * Every valid single-node combination of the three adapters runs the built API against real
 * engines: database (SQLite, PostgreSQL 16, MySQL 8.4) × game state (memory, Redis 7) × media
 * storage (local disk, S3 API on MinIO). That is 12 combinations, each in its own fresh runtime.
 * Each combination:
 * - starts the process and checks that health reports exactly the configured drivers, all up;
 * - completes first-run setup and registers a host;
 * - uploads an image and reads its bytes back from the configured storage;
 * - saves a quiz that uses the image;
 * - plays a game over Socket.IO with a correct answer and ends it;
 * - waits for the durable report and checks the player's score and answer statuses.
 *
 * The multi-node topology is only valid with an external database, Redis and storage both nodes
 * reach. PostgreSQL and MySQL each run with Redis and MinIO across two API processes, with the
 * host on one node and the player on the other. SQLite, memory state and unshared local storage
 * are refused at startup in that topology.
 *
 * MinIO verifies the S3 adapter's protocol only. It does not certify AWS S3, Cloudflare R2 or
 * DigitalOcean Spaces; `cloud-storage.spec.ts` covers those.
 *
 * Evidence: the engine/image versions and the pass/fail of each combination are written to
 * `test-results/driver-verification/driver-matrix.json` (summarised in docs/driver-verification.md).
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Redis from "ioredis";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GameClient,
  PASSWORD,
  answeringQuestion,
  createRoom,
  join,
  openDatabase,
  quizWith,
  until,
  uploadImage,
} from "../helpers/game";
import {
  DB_DRIVERS,
  createTestRuntime,
  databaseEnv,
  httpClient,
  startApi,
  type ApiProcess,
  type DbDriver,
  type TestRuntime,
} from "../helpers/runtime";

jest.setTimeout(600_000);

/** Game state adapters. */
const STATE_DRIVERS = ["memory", "redis"] as const;
/** Media storage adapters. */
const STORAGE_DRIVERS = ["local", "s3"] as const;
/** One adapter combination. */
interface Combination {
  db: DbDriver;
  state: (typeof STATE_DRIVERS)[number];
  storage: (typeof STORAGE_DRIVERS)[number];
}
/** The 12 single-node combinations. */
const SINGLE: Combination[] = DB_DRIVERS.flatMap((db) =>
  STATE_DRIVERS.flatMap((state) => STORAGE_DRIVERS.map((storage) => ({ db, state, storage }))),
);
/** True for a WebP file (uploads are re-encoded to WebP by the media pipeline). */
const isWebp = (bytes: Buffer) =>
  bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
  bytes.subarray(8, 12).toString("latin1") === "WEBP";
/** One evidence row. */
interface Evidence {
  topology: "single" | "multi" | "multi-refused";
  combination: string;
  versions: Record<string, string>;
  result: "pass" | "fail";
  durationMs: number;
  error?: string;
}
const evidence: Evidence[] = [];

/** Pinned MinIO build (see tests/helpers/runtime.ts) or the operator-supplied prebuilt image. */
const minioImage = () =>
  process.env["KABUKI_TEST_MINIO_IMAGE"] ??
  "kabuki-neko/minio-test:9e49d5e7a648-go1.27.3 (minio@9e49d5e7a648)";

/** Environment for one combination; records the image/engine version of each started service. */
async function combinationEnv(
  runtime: TestRuntime,
  combination: Combination,
  versions: Record<string, string>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ...(await databaseEnv(runtime, combination.db)),
    STATE_DRIVER: combination.state,
    STORAGE_DRIVER: combination.storage,
    TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
  };
  versions["db"] = await databaseVersion(runtime, env);
  if (combination.state === "redis") {
    const redis = await runtime.redis();
    env["REDIS_URL"] = redis.getConnectionUrl();
    versions["redis"] = `redis:7-alpine (${await redisVersion(env["REDIS_URL"])})`;
  }
  if (combination.storage === "s3") {
    const minio = await runtime.minio();
    Object.assign(env, {
      S3_ENDPOINT: minio.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: minio.bucket,
      S3_ACCESS_KEY: minio.accessKeyId,
      S3_SECRET_KEY: minio.secretAccessKey,
      S3_FORCE_PATH_STYLE: "true",
      S3_PUBLIC_URL: `${minio.endpoint}/${minio.bucket}`,
      // The test MinIO listens on plain HTTP on loopback.
      ALLOW_INSECURE_LOCAL_HTTP: "true",
    });
    versions["storage"] = `S3 API on ${minioImage()}`;
  } else versions["storage"] = "local disk";
  return env;
}

/** Server version reported by the database engine itself. */
async function databaseVersion(runtime: TestRuntime, env: Record<string, string>) {
  const db = await openDatabase(runtime, env);
  try {
    const driver = env["DB_DRIVER"];
    const sql =
      driver === "sqlite"
        ? "SELECT sqlite_version() AS v"
        : driver === "postgres"
          ? "SELECT version() AS v"
          : "SELECT VERSION() AS v";
    const rows = (await db.query(sql)) as { v: string }[];
    const image =
      driver === "postgres"
        ? "postgres:16-alpine"
        : driver === "mysql"
          ? "mysql:8.4"
          : "better-sqlite3";
    return `${image} (${rows[0]?.v ?? "unknown"})`;
  } finally {
    await db.destroy();
  }
}

/** `redis_version` from INFO server. */
async function redisVersion(url: string) {
  const redis = new Redis(url);
  try {
    const info = await redis.info("server");
    return /redis_version:(\S+)/u.exec(info)?.[1] ?? "unknown";
  } finally {
    redis.disconnect();
  }
}

/** First-run setup plus one registered host; returns the host's access token. */
async function accounts(call: ReturnType<typeof httpClient>) {
  const setup = await call("/auth/setup", {
    method: "POST",
    ip: "10.9.0.1",
    headers: { "Idempotency-Key": randomUUID() },
    body: { instanceName: "Matrix", name: "Super", email: "s@example.org", password: PASSWORD },
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.text}`);
  const host = await call("/auth/register", {
    method: "POST",
    ip: "10.9.0.2",
    headers: { "Idempotency-Key": randomUUID() },
    body: { name: "Host", email: "host@example.org", password: PASSWORD },
  });
  if (host.status !== 201) throw new Error(`register failed: ${host.text}`);
  return (host.json as { accessToken: string }).accessToken;
}

/** Reads an uploaded object back from the configured storage and checks it is the WebP. */
async function readBack(env: Record<string, string>, media: { publicUrl: string }) {
  if (env["STORAGE_DRIVER"] === "local") {
    const response = await fetch(media.publicUrl);
    expect(response.status).toBe(200);
    expect(isWebp(Buffer.from(await response.arrayBuffer()))).toBe(true);
    return;
  }
  // The bucket is private; read with the credentials the API was given.
  const prefix = `${env["S3_PUBLIC_URL"]}/`;
  expect(media.publicUrl.startsWith(prefix)).toBe(true);
  const client = new S3Client({
    endpoint: env["S3_ENDPOINT"] ?? "",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env["S3_ACCESS_KEY"] ?? "",
      secretAccessKey: env["S3_SECRET_KEY"] ?? "",
    },
  });
  try {
    const object = await client.send(
      new GetObjectCommand({
        Bucket: env["S3_BUCKET"] ?? "",
        Key: media.publicUrl.slice(prefix.length),
      }),
    );
    const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    expect(isWebp(bytes)).toBe(true);
  } finally {
    client.destroy();
  }
}

/**
 * Uploads an image on `uploadNode`, saves a quiz with it, plays one correct answer with the host
 * on `hostNode` and the player on `playerNode`, ends the game and checks the durable report.
 */
async function playAndReport(
  env: Record<string, string>,
  nodes: { upload: ApiProcess; host: ApiProcess; player: ApiProcess },
  call: ReturnType<typeof httpClient>,
  token: string,
) {
  const uploaded = await uploadImage(nodes.upload, token);
  await readBack(env, { publicUrl: await mediaUrl(call, token, uploaded.id) });
  const quiz = await quizWith(call, token, "Matriks", [
    {
      type: "SINGLE_CHOICE",
      prompt: "Kucing?",
      options: [["Ya", true], ["Tidak"]],
      timeLimitSec: 30,
      mediaId: uploaded.id,
    },
  ]);
  const host = await GameClient.connect(nodes.host.url, token);
  const player = await GameClient.connect(nodes.player.url);
  try {
    const room = await createRoom(host, quiz);
    const joined = await join(player, room, "Pemain");
    expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );
    const open = await answeringQuestion(player, 0);
    const answered = await player.emit("player:submit_answer", {
      ...room,
      questionIndex: 0,
      questionId: open.question.id,
      submissionId: randomUUID(),
      answer: open.question.options.find((option) => option.text === "Ya")?.index,
    });
    expect(answered.ok).toBe(true);
    await host.waitFor("game:answer_reveal");
    const synced = await host.emit("room:sync", room);
    const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
    expect((await host.emit("host:end_game", { ...room, expectedPhaseVersion: version })).ok).toBe(
      true,
    );
    const status = async () =>
      (
        (await call(`/reports/${room.sessionId}/status`, { token })).json as {
          status?: string;
        } | null
      )?.status ?? null;
    expect(await until(status, "ready", 60_000)).toBe("ready");
    const players = await call(`/reports/${room.sessionId}/players`, { token });
    expect(players.status).toBe(200);
    expect(players.text).toContain(joined.playerId);
    const answers = await call(`/reports/${room.sessionId}/players/${joined.playerId}/answers`, {
      token,
    });
    const items = (answers.json as { items: { status: string; result: string | null }[] }).items;
    expect(items.map((item) => [item.status, item.result])).toEqual([["ANSWERED", "CORRECT"]]);
  } finally {
    host.close();
    player.close();
  }
}

/** The uploaded asset's public URL from the media library list. */
async function mediaUrl(
  call: ReturnType<typeof httpClient>,
  token: string,
  id: string,
): Promise<string> {
  const list = await call("/media?limit=50", { token });
  const items = (list.json as { items?: { id: string; publicUrl: string }[] } | null)?.items ?? [];
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`media ${id} not listed: ${list.text}`);
  return found.publicUrl;
}

/** Runs `body`, recording its versions, duration and pass/fail as evidence. */
async function recorded(
  topology: Evidence["topology"],
  combination: string,
  body: (versions: Record<string, string>) => Promise<void>,
) {
  const versions: Record<string, string> = {};
  const started = Date.now();
  try {
    await body(versions);
    evidence.push({
      topology,
      combination,
      versions,
      result: "pass",
      durationMs: Date.now() - started,
    });
  } catch (error) {
    evidence.push({
      topology,
      combination,
      versions,
      result: "fail",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error),
    });
    throw error;
  }
}

afterAll(async () => {
  const directory = path.join(process.cwd(), "test-results", "driver-verification");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "driver-matrix.json"),
    `${JSON.stringify({ node: process.version, generatedAt: new Date().toISOString(), evidence }, null, 2)}\n`,
  );
});

describe("single-node adapter combinations", () => {
  it("covers exactly 12 combinations", () => {
    expect(SINGLE).toHaveLength(12);
    expect(new Set(SINGLE.map((c) => `${c.db}/${c.state}/${c.storage}`)).size).toBe(12);
  });

  it.each(SINGLE)("$db + $state state + $storage storage", async (combination) => {
    await recorded(
      "single",
      `${combination.db}/${combination.state}/${combination.storage}`,
      async (versions) => {
        const runtime = await createTestRuntime();
        let api: ApiProcess | undefined;
        try {
          const env = await combinationEnv(runtime, combination, versions);
          api = await startApi(runtime, env);
          const call = httpClient(api.base);
          const health = await call("/system/health");
          expect(health.status).toBe(200);
          expect(health.json).toMatchObject({
            status: "ok",
            dbDriver: combination.db,
            stateDriver: combination.state,
            storageDriver: combination.storage,
            db: { status: "up" },
            state: { status: "up" },
            storage: { status: "up" },
          });
          const token = await accounts(call);
          await playAndReport(env, { upload: api, host: api, player: api }, call, token);
        } finally {
          await api?.stop();
          await runtime.cleanup();
        }
      },
    );
  });
});

describe("multi-node topology", () => {
  it.each(["postgres", "mysql"] as const)(
    "%s + Redis + shared S3 storage across two API nodes",
    async (db) => {
      await recorded("multi", `${db}/redis/s3 ×2 nodes`, async (versions) => {
        const runtime = await createTestRuntime();
        const nodes: ApiProcess[] = [];
        try {
          const env = {
            ...(await combinationEnv(runtime, { db, state: "redis", storage: "s3" }, versions)),
            DEPLOYMENT_TOPOLOGY: "multi",
            // Both nodes sit behind one public URL.
            NEXT_PUBLIC_API_URL: "http://localhost:3001",
          };
          nodes.push(await startApi(runtime, env), await startApi(runtime, env));
          const [first, second] = nodes as [ApiProcess, ApiProcess];
          for (const node of nodes) {
            const health = await httpClient(node.base)("/system/health");
            expect(health.json).toMatchObject({ status: "ok", dbDriver: db, stateDriver: "redis" });
          }
          const call = httpClient(first.base);
          const token = await accounts(call);
          await playAndReport(env, { upload: second, host: first, player: second }, call, token);
        } finally {
          for (const node of nodes) await node.stop();
          await runtime.cleanup();
        }
      });
    },
  );

  it.each([
    ["SQLite", { DB_DRIVER: "sqlite" }, "DB_DRIVER"],
    ["memory state", { STATE_DRIVER: "memory" }, "STATE_DRIVER"],
    ["unshared local storage", { STORAGE_DRIVER: "local" }, "LOCAL_STORAGE_SHARED"],
  ] as const)("refuses %s at startup", async (label, override, field) => {
    await recorded("multi-refused", label, async () => {
      const runtime = await createTestRuntime();
      try {
        // Configuration is validated before any connection, so unreachable URLs are fine here.
        const env: Record<string, string> = {
          DEPLOYMENT_TOPOLOGY: "multi",
          DB_DRIVER: "postgres",
          DATABASE_URL: "postgres://kabuki:unused@127.0.0.1:9/kabuki",
          STATE_DRIVER: "redis",
          REDIS_URL: "redis://127.0.0.1:9",
          STORAGE_DRIVER: "s3",
          S3_ENDPOINT: "http://127.0.0.1:9",
          S3_REGION: "us-east-1",
          S3_BUCKET: "unused",
          S3_ACCESS_KEY: "unusedaccess",
          S3_SECRET_KEY: "unused-secret-value",
          S3_PUBLIC_URL: "http://127.0.0.1:9/unused",
          ALLOW_INSECURE_LOCAL_HTTP: "true",
          ...override,
        };
        await expect(startApi(runtime, env)).rejects.toThrow(field);
      } finally {
        await runtime.cleanup();
      }
    });
  });
});
