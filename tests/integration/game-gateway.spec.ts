/**
 * TASK-082 integration test with real socket.io clients against the built API: every client event
 * returns its contract ACK, handshake/Origin/token failures, host-only and binding errors (401/403),
 * oversize events, rate limits, session replacement, kicking, a full game through reveal,
 * leaderboard and podium, and a recursive scan proving players never receive host-only or private
 * fields (report/finalization, answer counts, token hashes, other players' results).
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { quizDetailSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import {
  clientContracts,
  type ClientAck,
  type ClientEventName,
} from "@kabuki-neko/shared/socket-events";
import { createTestRuntime } from "../helpers/runtime";

const credentialsSchema = z.object({ user: userSchema, accessToken: z.string() });
const ORIGIN = "http://localhost:3000";
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let child: ChildProcess;
let origin: string;
let admin: z.infer<typeof credentialsSchema>;
let outsider: z.infer<typeof credentialsSchema>;
const sockets: Socket[] = [];
/** Events received per socket, for leak scanning and waits. */
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
/** REST JSON call with browser headers. */
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
/** Opens a websocket-only client and records every server event. */
function connect(
  auth: Record<string, unknown> = { protocolVersion: 1 },
  headerOrigin = ORIGIN,
): Socket {
  const socket = io(`${origin}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
    extraHeaders: { Origin: headerOrigin },
    reconnection: false,
    forceNew: true,
  });
  const log: { name: string; payload: unknown }[] = [];
  received.set(socket, log);
  socket.onAny((name: string, payload: unknown) => log.push({ name, payload }));
  sockets.push(socket);
  return socket;
}
/** Rejects after `ms` with a labelled error so a hang points at its step. */
function within<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`Timed out: ${label}`);
    }),
  ]);
}
/** Resolves once connected or rejects with the server's connect_error. */
function ready(socket: Socket): Promise<void> {
  return within(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (error: Error & { data?: unknown }) =>
        reject(Object.assign(error, { data: error.data })),
      );
    }),
    "socket connect",
  );
}
/** Emits a request and returns its ACK after validating it against the shared contract. */
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
/** Waits until `socket` has received `name` (optionally matching a predicate). */
async function waitFor(
  socket: Socket,
  name: string,
  match: (payload: { data: Record<string, unknown> }) => boolean = () => true,
  timeoutMs = 15_000,
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
    await delay(50);
  }
}
/** Error code of a failed ACK. */
function code(ack: { ok: boolean; error?: { errorCode: string } }) {
  return ack.ok ? "OK" : ack.error?.errorCode;
}
/** Registers a creator through public registration. */
async function register(email: string) {
  const response = await rest(
    "/auth/register",
    "POST",
    undefined,
    { name: "Creator", email, password: "Correct-password-123!" },
    { "Idempotency-Key": randomUUID() },
  );
  expect(response.status).toBe(201);
  return credentialsSchema.parse(await response.json());
}
/** Creates a playable quiz (5 s SINGLE_CHOICE + 5 s TYPE_ANSWER) owned by `token`'s user. */
async function playableQuiz(token: string) {
  const created = quizDetailSchema.parse(
    await (
      await rest(
        "/quizzes",
        "POST",
        token,
        { title: "Socket quiz" },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  );
  const base = created.questions[0];
  if (!base) throw new Error("draft question missing");
  const write = {
    title: created.title,
    description: null,
    visibility: "PRIVATE",
    coverMediaId: null,
    bgmTrack: created.bgmTrack,
    questions: [
      {
        ...base,
        promptText: "Pick the first",
        timeLimitSec: 5,
        explanationText: "SECRET-EXPLANATION",
        options: base.options.map((o, i) => ({ ...o, optionText: `Choice ${i}` })),
      },
      {
        ...base,
        id: randomUUID(),
        orderIndex: 1,
        type: "TYPE_ANSWER",
        promptText: "Type it",
        timeLimitSec: 5,
        explanationText: null,
        options: [
          {
            id: randomUUID(),
            optionIndex: 0,
            colorIndex: 0,
            optionText: "SecretKeyword",
            isCorrect: true,
            sortOrder: 0,
          },
        ],
      },
    ],
  };
  const saved = await rest(`/quizzes/${created.id}`, "PUT", token, write, {
    "If-Match": `"${created.revision}"`,
  });
  expect(saved.status).toBe(200);
  return quizDetailSchema.parse(await saved.json());
}

beforeAll(async () => {
  runtime = await createTestRuntime();
  const port = await freePort();
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
    stdio: "ignore",
  });
  let up = false;
  for (let attempt = 0; attempt < 150 && !up; attempt++) {
    if (child.exitCode !== null) throw new Error("API exited during startup");
    try {
      up = (await fetch(`${origin}/api/v1/auth/setup-status`)).status === 200;
    } catch {
      /* Wait for server startup. */
    }
    if (!up) await delay(100);
  }
  const setup = await rest(
    "/auth/setup",
    "POST",
    undefined,
    {
      instanceName: "Socket test",
      name: "Admin",
      email: "admin@example.org",
      password: "Correct-password-123!",
    },
    { "Idempotency-Key": randomUUID() },
  );
  admin = credentialsSchema.parse(await setup.json());
  outsider = await register("outsider@example.org");
}, 120_000);

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await runtime.cleanup();
});

it("rejects bad origins, malformed handshakes and invalid tokens before connecting", async () => {
  await expect(
    ready(connect({ protocolVersion: 1 }, "https://evil.example")),
  ).rejects.toMatchObject({ message: "ORIGIN_DENIED" });
  await expect(ready(connect({ protocolVersion: 2 }))).rejects.toMatchObject({
    message: "VALIDATION_FAILED",
  });
  await expect(
    ready(connect({ protocolVersion: 1, padding: "x".repeat(9_000) })),
  ).rejects.toMatchObject({ message: "VALIDATION_FAILED" });
  await expect(
    ready(connect({ protocolVersion: 1, accessToken: "not-a-token" })),
  ).rejects.toMatchObject({ message: "AUTH_REQUIRED" });
});

it("serves every client event with contract ACKs through a complete game", async () => {
  const quiz = await playableQuiz(admin.accessToken);
  const host = connect({ protocolVersion: 1, accessToken: admin.accessToken });
  await ready(host);
  const created = await call(host, "host:create_room", {
    quizId: quiz.id,
    quizRevision: quiz.revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.errorCode}`);
  const { pinCode, sessionId } = created.data;
  const member = { sessionId, pinCode };

  const anonymous = connect();
  await ready(anonymous);
  expect(code(await call(anonymous, "host:lock_room", { ...member, isLocked: true }))).toBe(
    "AUTH_REQUIRED",
  );
  const intruder = connect({ protocolVersion: 1, accessToken: outsider.accessToken });
  await ready(intruder);
  expect(code(await call(intruder, "host:lock_room", { ...member, isLocked: true }))).toBe(
    "FORBIDDEN",
  );
  expect(code(await call(intruder, "host:recover_room", { sessionId }))).toBe("FORBIDDEN");
  expect(
    code(
      await call(anonymous, "player:submit_answer", {
        ...member,
        questionIndex: 0,
        questionId: randomUUID(),
        submissionId: randomUUID(),
        answer: 0,
      }),
    ),
  ).toBe("INVALID_SESSION_TOKEN");
  expect(code(await call(anonymous, "player:check_pin", { pinCode }))).toBe("OK");
  expect(
    code(
      await call(anonymous, "player:check_pin", {
        pinCode: "000000" === pinCode ? "000001" : "000000",
      }),
    ),
  ).toBe("ROOM_NOT_FOUND");
  expect(code(await call(anonymous, "player:request_friendly_name", { pinCode }))).toBe(
    "INVALID_PHASE",
  );

  const players = [connect(), connect(), connect()];
  for (const socket of players) await ready(socket);
  const [alice, bob, carol] = players as [Socket, Socket, Socket];
  const joinAck = await call(alice, "player:join_room", {
    pinCode,
    nickname: "Alice",
    avatar: { style: "bottts", seed: "a" },
  });
  if (!joinAck.ok) throw new Error("join failed");
  expect(joinAck.data).toMatchObject({ recovered: false, sessionId });
  const bobJoin = await call(bob, "player:join_room", {
    pinCode,
    nickname: "Bob",
    avatar: { style: "bottts", seed: "b" },
  });
  if (!bobJoin.ok) throw new Error("bob join failed");
  const carolAck = await call(carol, "player:join_room", {
    pinCode,
    nickname: "Carol",
    avatar: { style: "bottts", seed: "c" },
  });
  await waitFor(
    host,
    "room:player_joined",
    (p) => (p.data.player as { nickname: string }).nickname === "Carol",
  );
  expect(
    await call(alice, "player:update_avatar", {
      ...member,
      avatar: { style: "adventurer", seed: "a2" },
    }),
  ).toMatchObject({ ok: true });
  await waitFor(host, "room:player_updated");
  expect(await call(alice, "room:time", { ...member, clientSentAt: Date.now() })).toMatchObject({
    ok: true,
  });
  const synced = await call(alice, "room:sync", member);
  expect(synced.ok && synced.data.snapshot.role).toBe("player");
  expect(await call(host, "host:lock_room", { ...member, isLocked: true })).toMatchObject({
    ok: true,
    data: { isLocked: true },
  });
  await waitFor(alice, "room:lock_changed");
  await call(host, "host:lock_room", { ...member, isLocked: false });
  if (!carolAck.ok) throw new Error("carol join failed");
  expect(
    await call(host, "host:kick_player", { ...member, playerId: carolAck.data.playerId }),
  ).toMatchObject({ ok: true, data: { kicked: true } });
  await waitFor(carol, "player:kicked");
  await waitFor(alice, "room:player_left");

  // Session replacement: Bob recovers on a new socket; the old one is told and disconnected.
  const bobNew = connect();
  await ready(bobNew);
  const bobOldClosed = new Promise((resolve) => bob.once("disconnect", resolve));
  const recoveredBob = await call(bobNew, "player:join_room", {
    pinCode,
    sessionId,
    sessionToken: bobJoin.data.sessionToken,
  });
  expect(recoveredBob).toMatchObject({
    ok: true,
    data: { recovered: true, playerId: bobJoin.data.playerId },
  });
  await waitFor(bob, "player:session_replaced");
  await within(bobOldClosed, "old bob disconnect");

  const fresh = connect({ protocolVersion: 1, accessToken: admin.accessToken });
  await ready(fresh);
  const recovered = await call(fresh, "host:recover_room", { sessionId });
  expect(recovered.ok && recovered.data.snapshot.role).toBe("host");
  expect(await call(fresh, "auth:update", { accessToken: admin.accessToken })).toMatchObject({
    ok: true,
    data: { authenticated: true },
  });

  const lobby = await call(host, "room:sync", member);
  if (!lobby.ok) throw new Error("host sync failed");
  const started = await call(host, "host:start_game", {
    ...member,
    expectedPhaseVersion: lobby.data.snapshot.phaseVersion,
  });
  expect(started).toMatchObject({ ok: true, data: { phase: "GAME_START_COUNTDOWN" } });
  await waitFor(alice, "game:countdown");
  const answering = await waitFor(alice, "game:question_answering");
  const question = answering.data.question as {
    id: string;
    questionIndex: number;
    options: { index: number }[];
  };
  expect(
    await call(alice, "player:submit_answer", {
      ...member,
      questionIndex: question.questionIndex,
      questionId: question.id,
      submissionId: randomUUID(),
      answer: 0,
    }),
  ).toMatchObject({ ok: true, data: { accepted: true } });
  await waitFor(host, "game:answer_count_updated");
  const skip = await call(host, "host:skip_timer", {
    ...member,
    expectedPhaseVersion: answering.phaseVersion,
  });
  expect(skip.ok ? skip.data.phase : code(skip)).toMatch(/ANSWER_REVEAL|STALE_PHASE/u);
  await waitFor(alice, "game:answer_reveal");
  await waitFor(host, "game:answer_reveal");
  const reveal = await call(host, "room:sync", member);
  if (!reveal.ok) throw new Error("sync failed");
  expect(
    await call(host, "host:next_step", {
      ...member,
      expectedPhaseVersion: reveal.data.snapshot.phaseVersion,
    }),
  ).toMatchObject({ ok: true, data: { phase: "LEADERBOARD" } });
  await waitFor(alice, "game:leaderboard");
  const board = await call(host, "room:sync", member);
  if (!board.ok) throw new Error("sync failed");
  expect(
    await call(host, "host:next_step", {
      ...member,
      expectedPhaseVersion: board.data.snapshot.phaseVersion,
    }),
  ).toMatchObject({ ok: true, data: { phase: "QUESTION_PREVIEW" } });
  const typed = await waitFor(
    bobNew,
    "game:question_answering",
    (p) => (p.data.question as { type: string }).type === "TYPE_ANSWER",
  );
  const typedQuestion = typed.data.question as {
    id: string;
    questionIndex: number;
    options: unknown[];
  };
  expect(typedQuestion.options).toEqual([]);
  expect(
    await call(bobNew, "player:submit_answer", {
      ...member,
      questionIndex: typedQuestion.questionIndex,
      questionId: typedQuestion.id,
      submissionId: randomUUID(),
      answer: "secretkeyword",
    }),
  ).toMatchObject({ ok: true });
  const ending = await call(host, "room:sync", member);
  if (!ending.ok) throw new Error("sync failed");
  const ended = await call(host, "host:end_game", {
    ...member,
    expectedPhaseVersion: ending.data.snapshot.phaseVersion,
  });
  expect(ended).toMatchObject({ ok: true, data: { phase: "PODIUM" } });
  await waitFor(host, "game:podium");
  await waitFor(alice, "game:podium");

  // Players never receive host-only events, finalization/report data or credentials.
  for (const socket of [alice, bobNew]) {
    const log = received.get(socket) ?? [];
    expect(log.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining(["game:answer_count_updated", "report:status_changed"]),
    );
    const text = JSON.stringify(log);
    for (const marker of [
      "finalization",
      "reportId",
      "tokenHash",
      "sessionToken",
      '"answeredCount"',
      "publicToPrivateOptionIds",
      'isCorrect":true,"optionText',
    ])
      expect(text).not.toContain(marker);
    const beforeReveal = log.slice(
      0,
      log.findIndex((entry) => entry.name === "game:answer_reveal"),
    );
    expect(JSON.stringify(beforeReveal)).not.toContain("SECRET-EXPLANATION");
    expect(JSON.stringify(beforeReveal)).not.toContain("SecretKeyword");
  }
  // Each player's podium result is their own (score matches their own podium entry).
  for (const [socket, id] of [
    [alice, joinAck.data.playerId],
    [bobNew, bobJoin.data.playerId],
  ] as const) {
    const podium = await waitFor(socket, "game:podium");
    const entries = podium.data.podium as { playerId: string; score: number }[];
    const result = podium.data.result as { totalScore: number };
    expect(result.totalScore).toBe(entries.find((entry) => entry.playerId === id)?.score);
  }
}, 120_000);

it("disconnects oversize events and enforces per-socket rate limits", async () => {
  const flood = connect();
  await ready(flood);
  const responses = [];
  for (let i = 0; i < 13; i++)
    responses.push(
      code(
        await call(flood, "room:time", {
          sessionId: randomUUID(),
          pinCode: "123456",
          clientSentAt: Date.now(),
        }),
      ),
    );
  expect(responses.slice(0, 12).every((value) => value === "AUTH_REQUIRED")).toBe(true);
  expect(responses[12]).toBe("RATE_LIMITED");
  const big = connect();
  await ready(big);
  const closed = new Promise((resolve) => big.once("disconnect", resolve));
  big.emit("room:time", { requestId: randomUUID(), padding: "x".repeat(20_000) });
  expect(await closed).toBe("transport close");
});
