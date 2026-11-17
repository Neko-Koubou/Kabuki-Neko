/**
 * Shared fixtures for the multi-node realtime integration suites (TASK-168).
 *
 * - `startScaledApis(driver)` starts two API processes in the `multi` topology. They share one
 *   runtime (secrets, local storage marked shared), one real Redis 7 and one real PostgreSQL 16
 *   or MySQL 8.4, as two replicas behind a load balancer would. It then creates a SUPERADMIN
 *   and a host creator.
 * - `quizWith(...)` saves a playable quiz from simple question specs: type, prompt,
 *   `[text, correct]` options, time limit and points.
 * - `GameClient` is one Socket.IO connection to one node. It records every server event in
 *   arrival order for waits and privacy scans, and sends commands with a fresh or given
 *   requestId.
 * Nothing compensates with client timestamps: answers carry no client time, and the tests only
 * read the server's own timing fields.
 */
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import {
  TEST_ORIGIN,
  createTestRuntime,
  databaseEnv,
  httpClient,
  startApi,
  type ApiProcess,
  type TestRuntime,
} from "./runtime";

/** Password of every account the fixtures create. */
export const PASSWORD = "Correct-password-123!";

/** One recorded server event. */
export interface Recorded {
  name: string;
  payload: unknown;
  /** Local arrival time (ms). */
  at: number;
}

/** A command ACK as sent by the server. */
export interface Ack {
  ok: boolean;
  requestId?: string;
  serverTime?: number;
  data?: Record<string, unknown>;
  error?: { errorCode: string };
}

/** Distinct simulated client addresses (10.7.x.y). */
let addressCounter = 0;
function nextAddress(): string {
  addressCounter += 1;
  return `10.7.${(addressCounter >> 8) & 255}.${addressCounter & 255}`;
}

/** One recorded Socket.IO client on one API node. */
export class GameClient {
  readonly events: Recorded[] = [];
  private constructor(readonly socket: Socket) {
    socket.onAny((name: string, payload: unknown) =>
      this.events.push({ name, payload, at: Date.now() }),
    );
  }

  /** Connects to `url` (optionally as a signed-in host). */
  static async connect(url: string, accessToken?: string): Promise<GameClient> {
    const socket = io(`${url}/game`, {
      path: "/socket.io",
      transports: ["websocket"],
      auth: accessToken ? { protocolVersion: 1, accessToken } : { protocolVersion: 1 },
      // Each client is its own device: a distinct address for the per-IP join/command budgets
      // (the fixture trusts loopback as a proxy).
      extraHeaders: { origin: TEST_ORIGIN, "x-forwarded-for": nextAddress() },
      reconnection: false,
      forceNew: true,
    });
    const client = new GameClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return client;
  }

  /** Sends `event` with a fresh requestId (or the given one) and returns the raw ACK. */
  async emit(event: string, fields: Record<string, unknown>, requestId: string = randomUUID()) {
    return (await this.socket.timeout(10_000).emitWithAck(event, { requestId, ...fields })) as Ack;
  }

  /** The first recorded `name` event matching `match`, waiting up to `timeoutMs`. */
  async waitFor(
    name: string,
    match: (data: Record<string, unknown>, envelope: Record<string, unknown>) => boolean = () =>
      true,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((event) => {
        if (event.name !== name) return false;
        const envelope = (event.payload ?? {}) as Record<string, unknown>;
        return match((envelope["data"] ?? {}) as Record<string, unknown>, envelope);
      });
      if (hit) return (hit.payload ?? {}) as Record<string, unknown>;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  close(): void {
    this.socket.disconnect();
  }
}

/** The answering question announced for `index` (waits for it). */
export async function answeringQuestion(client: GameClient, index: number) {
  const envelope = await client.waitFor(
    "game:question_answering",
    (data) => (data["question"] as { questionIndex?: number } | undefined)?.questionIndex === index,
  );
  const data = envelope["data"] as {
    question: {
      id: string;
      questionIndex: number;
      options: { id: string; index: number; text: string }[];
    };
    serverStartTime: number;
    inputClosesAt: number;
    acceptanceClosesAt: number;
  };
  return { ...data, phaseVersion: Number(envelope["phaseVersion"]) };
}

/** Server time offset estimate for `client` (server − local, ms), from one `room:time` sample. */
export async function serverOffset(
  client: GameClient,
  member: { sessionId: string; pinCode: string },
) {
  let best: { offset: number; rtt: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = Date.now();
    const ack = await client.emit("room:time", { ...member, clientSentAt: sent });
    const received = Date.now();
    const serverSentAt = Number(ack.data?.["serverSentAt"]);
    const rtt = received - sent;
    const offset = serverSentAt + rtt / 2 - received;
    if (!best || rtt < best.rtt) best = { offset, rtt };
  }
  return best?.offset ?? 0;
}

/** Waits until local time reaches server time `at` (given the measured offset). */
export async function untilServerTime(at: number, offset: number) {
  const wait = at - (Date.now() + offset);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/** One question of {@link quizWith}. */
export interface QuestionSpec {
  type:
    "SINGLE_CHOICE" | "TRUE_FALSE" | "MULTIPLE_SELECT" | "TYPE_ANSWER" | "ORDER_PUZZLE" | "POLL";
  prompt: string;
  options: [string, boolean?][];
  timeLimitSec?: 5 | 10 | 20 | 30;
  pointsMultiplier?: 0 | 1 | 2;
  /** Image attached to the question. */
  mediaId?: string;
}

/** Two API nodes and their accounts. */
export interface ScaledApis {
  runtime: TestRuntime;
  nodes: [ApiProcess, ApiProcess];
  env: Record<string, string>;
  call: ReturnType<typeof httpClient>;
  admin: string;
  host: string;
}

/** Starts two API nodes (multi topology) on one Redis and one PostgreSQL/MySQL database. */
export async function startScaledApis(driver: "postgres" | "mysql"): Promise<ScaledApis> {
  const runtime = await createTestRuntime();
  try {
    const redis = await runtime.redis();
    const env = {
      ...(await databaseEnv(runtime, driver)),
      DEPLOYMENT_TOPOLOGY: "multi",
      STATE_DRIVER: "redis",
      REDIS_URL: redis.getConnectionUrl(),
      LOCAL_STORAGE_SHARED: "true",
      // Replicas sit behind one public URL; the storage origin is pinned to it, so every node
      // must announce the same one.
      NEXT_PUBLIC_API_URL: "http://localhost:3001",
      TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
    };
    const first = await startApi(runtime, env);
    const second = await startApi(runtime, env);
    const call = httpClient(first.base);
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.6.0.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: { instanceName: "Realtime", name: "Super", email: "s@example.org", password: PASSWORD },
    });
    if (setup.status !== 201) throw new Error(`setup failed: ${setup.text}`);
    const host = await call("/auth/register", {
      method: "POST",
      ip: "10.6.0.2",
      headers: { "Idempotency-Key": randomUUID() },
      body: { name: "Host", email: "host@example.org", password: PASSWORD },
    });
    if (host.status !== 201) throw new Error(`register failed: ${host.text}`);
    return {
      runtime,
      nodes: [first, second],
      env,
      call,
      admin: (setup.json as { accessToken: string }).accessToken,
      host: (host.json as { accessToken: string }).accessToken,
    };
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
}

/** Saves a playable quiz built from `questions` for the token's user. */
export async function quizWith(
  call: ReturnType<typeof httpClient>,
  token: string,
  title: string,
  questions: QuestionSpec[],
): Promise<{ id: string; revision: number }> {
  const created = await call("/quizzes", {
    method: "POST",
    token,
    headers: { "Idempotency-Key": randomUUID() },
    body: { title },
  });
  if (created.status !== 201) throw new Error(`quiz create failed: ${created.text}`);
  const draft = created.json as {
    id: string;
    revision: number;
    questions: Record<string, unknown>[];
  };
  const template = draft.questions[0] ?? {};
  const saved = await call(`/quizzes/${draft.id}`, {
    method: "PUT",
    token,
    headers: { "If-Match": `"${draft.revision}"` },
    body: {
      title,
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "random",
      questions: questions.map((spec, orderIndex) => ({
        ...template,
        id: randomUUID(),
        orderIndex,
        type: spec.type,
        promptText: spec.prompt,
        mediaId: spec.mediaId ?? null,
        timeLimitSec: spec.timeLimitSec ?? 10,
        pointsMultiplier: spec.type === "POLL" ? 0 : (spec.pointsMultiplier ?? 1),
        explanationText: null,
        options: spec.options.map(([optionText, isCorrect = false], index) => ({
          id: randomUUID(),
          optionIndex: index,
          colorIndex: spec.type === "TYPE_ANSWER" ? 0 : index,
          optionText,
          isCorrect,
          sortOrder: index,
        })),
      })),
    },
  });
  if (saved.status !== 200) throw new Error(`quiz save failed: ${saved.text}`);
  return saved.json as { id: string; revision: number };
}

/** A created room. */
export type Room = { sessionId: string; pinCode: string };

/** Creates a room on `host`'s node; returns its identity. */
export async function createRoom(
  host: GameClient,
  quiz: { id: string; revision: number },
  displayMode: "PROJECTOR" | "STREAMER" = "STREAMER",
): Promise<Room> {
  const ack = await host.emit("host:create_room", {
    quizId: quiz.id,
    quizRevision: quiz.revision,
    displayMode,
    friendlyNicknames: false,
  });
  if (!ack.ok) throw new Error(`create_room failed: ${JSON.stringify(ack.error)}`);
  return { sessionId: String(ack.data?.["sessionId"]), pinCode: String(ack.data?.["pinCode"]) };
}

/** Joins `room` as a new player from `client`; returns the join data. */
export async function join(client: GameClient, room: Room, nickname: string, requestId?: string) {
  const ack = await client.emit(
    "player:join_room",
    { pinCode: room.pinCode, nickname, avatar: { style: "bottts", seed: nickname } },
    requestId,
  );
  if (!ack.ok) throw new Error(`join failed: ${JSON.stringify(ack.error)}`);
  return ack.data as { playerId: string; sessionToken: string; sessionId: string };
}

/** Current phase version of `room` from the host's sync. */
export async function phaseVersion(host: GameClient, room: Room): Promise<number> {
  const ack = await host.emit("room:sync", room);
  return Number((ack.data?.["snapshot"] as { phaseVersion?: number } | undefined)?.phaseVersion);
}

/** Opens the runtime's database (any engine) with the domain schemas; caller destroys it. */
export async function openDatabase(runtime: TestRuntime, env: Record<string, string>) {
  const { createDataSource, domainSchemas } = await import("../../packages/database/src");
  const driver = (env["DB_DRIVER"] ?? "sqlite") as "sqlite" | "postgres" | "mysql";
  const db = createDataSource(
    driver === "sqlite"
      ? { driver, sqlitePath: runtime.env["SQLITE_PATH"] ?? "" }
      : { driver, url: env["DATABASE_URL"] ?? "" },
    domainSchemas(driver),
  );
  await db.initialize();
  return db;
}

/** Status of a room's SQL allocation (null once the row is gone). */
export async function allocationStatus(
  runtime: TestRuntime,
  env: Record<string, string>,
  sessionId: string,
): Promise<string | null> {
  const db = await openDatabase(runtime, env);
  try {
    const row = await db.manager.findOneBy<{ id: string; status: string }>("room_allocations", {
      id: sessionId,
    });
    return row?.status ?? null;
  } finally {
    await db.destroy();
  }
}

/**
 * Ages a live room's Redis state as elapsed server time would: `mutate` edits the decoded private
 * state (e.g. moves `lobbyActiveAt` two hours back), and the pieces are written back in place.
 *
 * The Redis v2 layout (ADR-13, TASK-185Q) keeps the room's scalar fields in the `core` field of
 * `:meta` and the frozen report in `:report`; `mutate` sees both merged as one object
 * (`frozenReport` included) and may change either.
 */
export async function ageRoomState(
  redisUrl: string,
  room: Room,
  mutate: (state: Record<string, unknown>) => void,
  namespace = "default",
): Promise<void> {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(redisUrl);
  try {
    const prefix = `kabukineko:${namespace}:v2:room:{${room.pinCode}}`;
    const raw = await redis.hget(`${prefix}:meta`, "core");
    if (!raw) throw new Error("room state missing");
    const report = await redis.get(`${prefix}:report`);
    const state = JSON.parse(raw) as Record<string, unknown>;
    state["frozenReport"] = report === null ? null : (JSON.parse(report) as unknown);
    mutate(state);
    const { frozenReport, ...core } = state;
    await redis.hset(`${prefix}:meta`, "core", JSON.stringify(core));
    if (frozenReport !== null && frozenReport !== undefined)
      await redis.set(`${prefix}:report`, JSON.stringify(frozenReport), "KEEPTTL");
  } finally {
    redis.disconnect();
  }
}

/** Polls `read` until it returns `expected` (or fails after `timeoutMs`). */
export async function until<T>(
  read: () => Promise<T>,
  expected: T,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value === expected || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** One API node and its accounts. */
export interface SingleApi {
  runtime: TestRuntime;
  api: ApiProcess;
  env: Record<string, string>;
  /** Redis URL when the state driver is Redis. */
  redisUrl: string | null;
  call: ReturnType<typeof httpClient>;
  admin: string;
  host: string;
}

/** Starts one API node on `driver` with Redis or in-memory game state, plus an admin and a host. */
export async function startSingleApi(
  driver: "sqlite" | "postgres" | "mysql",
  state: "redis" | "memory" = "redis",
): Promise<SingleApi> {
  const runtime = await createTestRuntime();
  try {
    const redisUrl = state === "redis" ? (await runtime.redis()).getConnectionUrl() : null;
    const env: Record<string, string> = {
      ...(await databaseEnv(runtime, driver)),
      STATE_DRIVER: state,
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      // A restarted process gets a new port; the pinned storage origin needs one stable URL.
      NEXT_PUBLIC_API_URL: "http://localhost:3001",
      TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
    };
    const api = await startApi(runtime, env);
    const call = httpClient(api.base);
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.8.0.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        instanceName: "Durability",
        name: "Super",
        email: "s@example.org",
        password: PASSWORD,
      },
    });
    if (setup.status !== 201) throw new Error(`setup failed: ${setup.text}`);
    const host = await call("/auth/register", {
      method: "POST",
      ip: "10.8.0.2",
      headers: { "Idempotency-Key": randomUUID() },
      body: { name: "Host", email: "host@example.org", password: PASSWORD },
    });
    if (host.status !== 201) throw new Error(`register failed: ${host.text}`);
    return {
      runtime,
      api,
      env,
      redisUrl,
      call,
      admin: (setup.json as { accessToken: string }).accessToken,
      host: (host.json as { accessToken: string }).accessToken,
    };
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
}

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Uploads a small image as `token`'s user; returns the media id and revision. */
export async function uploadImage(api: ApiProcess, token: string) {
  const form = new FormData();
  form.append("folder", "questions");
  form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "gambar.png");
  const response = await fetch(`${api.base}/media/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: TEST_ORIGIN,
      "X-Kabuki-Client": "web-v1",
      "Idempotency-Key": randomUUID(),
      "X-Forwarded-For": "10.8.0.2",
    },
    body: form,
  });
  const text = await response.text();
  if (response.status !== 201) throw new Error(`upload failed: ${text}`);
  return JSON.parse(text) as { id: string; revision: number };
}
