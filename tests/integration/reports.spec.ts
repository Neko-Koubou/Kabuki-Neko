/**
 * TASK-086 integration test against the built API with real socket.io clients and SQLite:
 * - a completed game: the host receives `report:status_changed` ready + reportId only after the
 *   history is readable, players never receive it; all seven REST routes (ready-only list with
 *   limit 15, detail with 20 players, player and answer pages, streamed CSV, status, idempotent
 *   retry) and 404 for the source quiz owner who is also SUPERADMIN, 401 without a token;
 * - an early-ended game whose durable queue survives API restarts: a pending job answers 409
 *   everywhere (no partial data), an exhausted failed job answers 503 (JSON, never CSV), and a
 *   manual retry after the restart rewrites the same stable reportId.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import { quizDetailSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import {
  answerReportsPageSchema,
  fullReportSchema,
  playerReportsPageSchema,
  sessionsPageSchema,
} from "@kabuki-neko/shared/schemas/report.schema";
import { finalizeStatusSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import {
  clientContracts,
  type ClientAck,
  type ClientEventName,
} from "@kabuki-neko/shared/socket-events";
import { createDataSource, domainSchemas } from "../../packages/database/src";
import { createTestRuntime } from "../helpers/runtime";

const credentialsSchema = z.object({ user: userSchema, accessToken: z.string() });
const ORIGIN = "http://localhost:3000";
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let child: ChildProcess | undefined;
let origin: string;
let admin: z.infer<typeof credentialsSchema>;
let creator: z.infer<typeof credentialsSchema>;
let quizId: string;
let quizRevision: number;
const sockets: Socket[] = [];
const received = new WeakMap<Socket, { name: string; payload: unknown }[]>();

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
let port = 0;
/**
 * Starts the built API with the shared runtime directory (SQLite + secrets). Restarts reuse the
 * first port: the storage origin ledger pins the public uploads URL to the original address.
 */
async function startApi() {
  port ||= await freePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: {
      ...process.env,
      ...runtime.env,
      API_PORT: String(port),
      PORT: String(port),
      NEXT_PUBLIC_API_URL: origin,
    },
    stdio: ["ignore", "ignore", process.env.REPORTS_TEST_DEBUG ? "inherit" : "ignore"],
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error("API exited during startup");
    try {
      if ((await fetch(`${origin}/api/v1/auth/setup-status`)).status === 200) return;
    } catch {
      /* Wait for server startup. */
    }
    await delay(100);
  }
  throw new Error("API did not start");
}
/** Stops the API process (graceful SIGTERM) and closes every client socket. */
async function stopApi() {
  for (const socket of sockets.splice(0)) socket.disconnect();
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
}
/** REST call with browser headers. */
function rest(
  path: string,
  method = "GET",
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
/** JSON body of a response with the expected status (fails with the body otherwise). */
async function json(response: Response, status: number): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== status)
    throw new Error(`expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
/** Error code of an error envelope response. */
async function errorCode(response: Response) {
  return {
    status: response.status,
    code: ((await response.json()) as { errorCode: string }).errorCode,
  };
}
/** Opens a websocket client that records every server event. */
function connect(auth: Record<string, unknown> = { protocolVersion: 1 }): Socket {
  const socket = io(`${origin}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
    extraHeaders: { Origin: ORIGIN },
    reconnection: false,
    forceNew: true,
  });
  const log: { name: string; payload: unknown }[] = [];
  received.set(socket, log);
  socket.onAny((name: string, payload: unknown) => log.push({ name, payload }));
  sockets.push(socket);
  return socket;
}
/** Resolves once connected. */
function ready(socket: Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}
/** Emits a request and validates its ACK against the shared contract. */
async function call<E extends ClientEventName>(
  socket: Socket,
  event: E,
  fields: Record<string, unknown>,
) {
  const ack: unknown = await socket
    .timeout(10_000)
    .emitWithAck(event, { requestId: randomUUID(), ...fields });
  return clientContracts[event].ack.parse(ack) as ClientAck<E>;
}
/** Waits until `socket` received `name` matching `match`. */
async function waitFor(
  socket: Socket,
  name: string,
  match: (payload: { data: Record<string, unknown> }) => boolean = () => true,
  timeoutMs = 20_000,
) {
  const started = Date.now();
  for (;;) {
    const hit = received
      .get(socket)
      ?.find(
        (entry) => entry.name === name && match(entry.payload as { data: Record<string, unknown> }),
      );
    if (hit) return hit.payload as { data: Record<string, unknown>; phaseVersion: number };
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${name}`);
    await delay(25);
  }
}
/** Host command with the current phase version from a host sync. */
async function hostStep(
  host: Socket,
  member: { sessionId: string; pinCode: string },
  event: "host:start_game" | "host:next_step" | "host:end_game",
) {
  const sync = await call(host, "room:sync", member);
  if (!sync.ok) throw new Error("sync failed");
  const ack = await call(host, event, {
    ...member,
    expectedPhaseVersion: sync.data.snapshot.phaseVersion,
  });
  if (!ack.ok) throw new Error(`${event} failed: ${ack.error.errorCode}`);
  return ack;
}
/** Waits for the next answering phase on the player socket and submits option 0. */
async function answerNext(
  player: Socket,
  member: { sessionId: string; pinCode: string },
  questionIndex: number,
) {
  const answering = await waitFor(
    player,
    "game:question_answering",
    (p) => (p.data.question as { questionIndex: number }).questionIndex === questionIndex,
  );
  const question = answering.data.question as { id: string; questionIndex: number };
  const ack = await call(player, "player:submit_answer", {
    ...member,
    questionIndex: question.questionIndex,
    questionId: question.id,
    submissionId: randomUUID(),
    answer: 0,
  });
  expect(ack).toMatchObject({ ok: true });
}
/** Creator hosts the admin's PUBLIC quiz with one player; returns sockets and identifiers. */
async function hostRoom(nickname: string) {
  const host = connect({ protocolVersion: 1, accessToken: creator.accessToken });
  await ready(host);
  const created = await call(host, "host:create_room", {
    quizId,
    quizRevision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.errorCode}`);
  const member = { sessionId: created.data.sessionId, pinCode: created.data.pinCode };
  const player = connect();
  await ready(player);
  const joined = await call(player, "player:join_room", {
    pinCode: member.pinCode,
    nickname,
    avatar: { style: "bottts", seed: "p1" },
  });
  if (!joined.ok) throw new Error("join failed");
  return { host, player, member, playerId: joined.data.playerId };
}
/** Polls the status route until it reports `status`. */
async function statusUntil(sessionId: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = finalizeStatusSchema.parse(
      await json(await rest(`/reports/${sessionId}/status`, "GET", creator.accessToken), 200),
    );
    if (body.status === status) return body;
    await delay(100);
  }
  throw new Error(`status never became ${status}`);
}
/** Opens the API's SQLite database directly (only while the API is stopped). */
async function withDatabase(work: (db: ReturnType<typeof createDataSource>) => Promise<void>) {
  const db = createDataSource(
    { driver: "sqlite", sqlitePath: runtime.env.SQLITE_PATH ?? "" },
    domainSchemas("sqlite"),
  );
  await db.initialize();
  try {
    await work(db);
  } finally {
    await db.destroy();
  }
}

beforeAll(async () => {
  runtime = await createTestRuntime();
  await startApi();
  admin = credentialsSchema.parse(
    await json(
      await rest(
        "/auth/setup",
        "POST",
        undefined,
        {
          instanceName: "Reports test",
          name: "Admin",
          email: "admin@example.org",
          password: "Correct-password-123!",
        },
        { "Idempotency-Key": randomUUID() },
      ),
      201,
    ),
  );
  creator = credentialsSchema.parse(
    await json(
      await rest(
        "/auth/register",
        "POST",
        undefined,
        { name: "Creator", email: "creator@example.org", password: "Correct-password-123!" },
        { "Idempotency-Key": randomUUID() },
      ),
      201,
    ),
  );
  // The SUPERADMIN owns a PUBLIC two-question quiz that the creator hosts.
  const created = quizDetailSchema.parse(
    await json(
      await rest(
        "/quizzes",
        "POST",
        admin.accessToken,
        { title: "=Report quiz" },
        { "Idempotency-Key": randomUUID() },
      ),
      201,
    ),
  );
  const base = created.questions[0];
  if (!base) throw new Error("draft question missing");
  const saved = quizDetailSchema.parse(
    await json(
      await rest(
        `/quizzes/${created.id}`,
        "PUT",
        admin.accessToken,
        {
          title: created.title,
          description: null,
          visibility: "PUBLIC",
          coverMediaId: null,
          bgmTrack: created.bgmTrack,
          questions: [0, 1].map((orderIndex) => ({
            ...base,
            id: orderIndex === 0 ? base.id : randomUUID(),
            orderIndex,
            promptText: `Question ${orderIndex}`,
            timeLimitSec: 5,
            options: base.options.map((o, i) => ({
              ...o,
              id: orderIndex === 0 ? o.id : randomUUID(),
              optionText: `Choice ${i}`,
            })),
          })),
        },
        { "If-Match": `"${created.revision}"` },
      ),
      200,
    ),
  );
  quizId = saved.id;
  quizRevision = saved.revision;
}, 120_000);

afterAll(async () => {
  await stopApi();
  await runtime.cleanup();
});

it("pushes ready only after commit and serves every report route to the host only", async () => {
  const { host, player, member, playerId } = await hostRoom("@Alice");
  const id = member.sessionId;
  await hostStep(host, member, "host:start_game");
  await answerNext(player, member, 0);
  await waitFor(host, "game:answer_reveal");
  await hostStep(host, member, "host:next_step");
  await hostStep(host, member, "host:next_step");
  await answerNext(player, member, 1);
  await waitFor(
    host,
    "game:answer_reveal",
    (p) => (p.data.reveal as { questionIndex: number }).questionIndex === 1,
  );
  // The last reveal leads straight to the podium (COMPLETED).
  const podium = await hostStep(host, member, "host:next_step");
  expect(podium.data).toMatchObject({ phase: "PODIUM" });

  const pushed = await waitFor(host, "report:status_changed", (p) => p.data.status === "ready");
  // The push is sent after the commit: the report is readable as soon as the event arrives.
  const detail = fullReportSchema.parse(
    await json(await rest(`/reports/${id}`, "GET", creator.accessToken), 200),
  );
  expect(pushed.data).toMatchObject({ sessionId: id, reportId: id, retryable: false });
  for (const entry of received.get(host) ?? [])
    if (entry.name === "report:status_changed") {
      const data = (entry.payload as { data: { status: string; reportId: string | null } }).data;
      expect(data.reportId === null || data.status === "ready").toBe(true);
    }
  expect((received.get(player) ?? []).map((e) => e.name)).not.toContain("report:status_changed");
  expect(detail.session).toMatchObject({ id, endReason: "COMPLETED", quizId, totalPlayers: 1 });
  expect(detail.players.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
  expect(detail.playedQuestions).toBe(2);
  expect(detail.accuracy).toEqual({ numerator: 2, denominator: 2, value: 1 });

  const list = sessionsPageSchema.parse(
    await json(await rest("/reports", "GET", creator.accessToken), 200),
  );
  expect(list.meta).toMatchObject({ page: 1, limit: 15 });
  expect(list.items.map((s) => s.id)).toContain(id);
  const filtered = sessionsPageSchema.parse(
    await json(await rest(`/reports?quizId=${randomUUID()}`, "GET", creator.accessToken), 200),
  );
  expect(filtered.items).toEqual([]);
  const players = playerReportsPageSchema.parse(
    await json(await rest(`/reports/${id}/players?search=alice`, "GET", creator.accessToken), 200),
  );
  expect(players.items.map((p) => p.id)).toEqual([playerId]);
  const answers = answerReportsPageSchema.parse(
    await json(
      await rest(
        `/reports/${id}/players/${playerId}/answers?limit=1&page=2`,
        "GET",
        creator.accessToken,
      ),
      200,
    ),
  );
  expect(answers.items).toHaveLength(1);
  expect(answers.items[0]).toMatchObject({
    questionIndex: 1,
    status: "ANSWERED",
    result: "CORRECT",
  });
  expect(answers.meta).toMatchObject({ total: 2, totalPages: 2 });
  expect(
    await errorCode(
      await rest(`/reports/${id}/players/${randomUUID()}/answers`, "GET", creator.accessToken),
    ),
  ).toEqual({ status: 404, code: "NOT_FOUND" });

  const csv = await rest(`/reports/${id}/export-csv`, "GET", creator.accessToken);
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(csv.headers.get("content-disposition")).toBe(
    `attachment; filename="kabuki-neko-report-${id}.csv"`,
  );
  const bytes = new Uint8Array(await csv.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(bytes.slice(3)).split("\r\n");
  expect(lines[0]?.split(",")).toHaveLength(18);
  expect(lines[1]).toContain(`"'=Report quiz"`);
  expect(lines[1]).toContain(`"'@Alice"`);
  expect(lines.slice(2)).toEqual([""]);

  expect(
    finalizeStatusSchema.parse(
      await json(await rest(`/reports/${id}/status`, "GET", creator.accessToken), 200),
    ),
  ).toMatchObject({
    status: "ready",
    reportId: id,
  });
  const key = randomUUID();
  const retry = () =>
    rest(
      `/reports/${id}/retry-finalize`,
      "POST",
      creator.accessToken,
      {},
      { "Idempotency-Key": key },
    );
  expect(await json(await retry(), 200)).toMatchObject({ status: "ready", reportId: id });
  expect(await json(await retry(), 200)).toMatchObject({ status: "ready", reportId: id });
  expect(
    await errorCode(
      await rest(
        `/reports/${randomUUID()}/retry-finalize`,
        "POST",
        creator.accessToken,
        {},
        {
          "Idempotency-Key": key,
        },
      ),
    ),
  ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  expect(
    (await rest(`/reports/${id}/retry-finalize`, "POST", creator.accessToken, {})).status,
  ).toBe(422);
  expect(
    (
      await rest(
        `/reports/${id}/retry-finalize`,
        "POST",
        creator.accessToken,
        { force: true },
        {
          "Idempotency-Key": randomUUID(),
        },
      )
    ).status,
  ).toBe(422);

  // The SUPERADMIN who also owns the source quiz is not the host: every route is hidden.
  const routes: Array<[string, string]> = [
    ["GET", `/reports/${id}`],
    ["GET", `/reports/${id}/status`],
    ["GET", `/reports/${id}/players`],
    ["GET", `/reports/${id}/players/${playerId}/answers`],
    ["GET", `/reports/${id}/export-csv`],
    ["POST", `/reports/${id}/retry-finalize`],
  ];
  for (const [method, path] of routes) {
    const response = await rest(
      path,
      method,
      admin.accessToken,
      method === "POST" ? {} : undefined,
      {
        "Idempotency-Key": randomUUID(),
      },
    );
    expect(await errorCode(response)).toEqual({ status: 404, code: "NOT_FOUND" });
    expect((await rest(path, method, undefined, method === "POST" ? {} : undefined)).status).toBe(
      401,
    );
  }
  expect(
    sessionsPageSchema.parse(await json(await rest("/reports", "GET", admin.accessToken), 200))
      .items,
  ).toEqual([]);
  expect(await errorCode(await rest("/reports/not-a-uuid", "GET", creator.accessToken))).toEqual({
    status: 404,
    code: "NOT_FOUND",
  });
}, 120_000);

it("keeps an early-ended report durable across restarts: 409 pending, 503 failed, manual retry", async () => {
  const { host, player, member } = await hostRoom("Bob");
  const id = member.sessionId;
  await hostStep(host, member, "host:start_game");
  await waitFor(player, "game:question_answering");
  expect((await hostStep(host, member, "host:end_game")).data).toMatchObject({ phase: "PODIUM" });
  await waitFor(host, "report:status_changed", (p) => p.data.status === "ready");
  const original = fullReportSchema.parse(
    await json(await rest(`/reports/${id}`, "GET", creator.accessToken), 200),
  );
  expect(original.session.endReason).toBe("HOST_ENDED");
  expect(original.questions.map((q) => q.status)).toEqual(["PLAYED", "UNPLAYED"]);

  // Simulate a write that never completed: history gone, durable job queued but not yet due.
  await stopApi();
  await withDatabase(async (db) => {
    await db.manager.delete("game_sessions", { id });
    await db.manager.update("finalization_jobs", id, {
      state: "PENDING",
      attempts: 0,
      next_attempt_at: Date.now() + 86_400_000,
      completed_at: null,
    });
  });
  await startApi();
  for (const path of [`/reports/${id}`, `/reports/${id}/players`, `/reports/${id}/export-csv`]) {
    const response = await rest(path, "GET", creator.accessToken);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await errorCode(response)).toEqual({ status: 409, code: "FINALIZATION_PENDING" });
  }
  expect(await statusUntil(id, "pending")).toMatchObject({ reportId: null, retryable: true });
  expect(
    await errorCode(
      await rest(
        `/reports/${id}/retry-finalize`,
        "POST",
        creator.accessToken,
        {},
        {
          "Idempotency-Key": randomUUID(),
        },
      ),
    ),
  ).toEqual({ status: 409, code: "FINALIZATION_PENDING" });
  expect(
    sessionsPageSchema
      .parse(await json(await rest("/reports", "GET", creator.accessToken), 200))
      .items.map((s) => s.id),
  ).not.toContain(id);

  // Exhausted automated retries after another restart: 503 everywhere until a manual retry.
  await stopApi();
  await withDatabase(async (db) => {
    await db.manager.update("finalization_jobs", id, {
      state: "FAILED",
      attempts: 6,
      next_attempt_at: Date.now(),
      last_error_code: "REPORT_SAVE_FAILED",
    });
  });
  await startApi();
  await delay(1_500);
  const csv = await rest(`/reports/${id}/export-csv`, "GET", creator.accessToken);
  expect(csv.headers.get("content-type")).toContain("application/json");
  expect(await errorCode(csv)).toEqual({ status: 503, code: "REPORT_SAVE_FAILED" });
  expect(await statusUntil(id, "failed")).toMatchObject({
    retryable: true,
    errorCode: "REPORT_SAVE_FAILED",
    reportId: null,
  });
  const key = randomUUID();
  const retried = finalizeStatusSchema.parse(
    await json(
      await rest(
        `/reports/${id}/retry-finalize`,
        "POST",
        creator.accessToken,
        {},
        {
          "Idempotency-Key": key,
        },
      ),
      200,
    ),
  );
  expect(retried).toMatchObject({ status: "pending", reportId: null });
  expect(await statusUntil(id, "ready")).toMatchObject({ reportId: id });
  const rewritten = fullReportSchema.parse(
    await json(await rest(`/reports/${id}`, "GET", creator.accessToken), 200),
  );
  expect(rewritten).toEqual(original);
  // Replaying the retry key does not execute again and reports the current status.
  expect(
    await json(
      await rest(
        `/reports/${id}/retry-finalize`,
        "POST",
        creator.accessToken,
        {},
        {
          "Idempotency-Key": key,
        },
      ),
      200,
    ),
  ).toMatchObject({ status: "ready", reportId: id });
}, 180_000);
