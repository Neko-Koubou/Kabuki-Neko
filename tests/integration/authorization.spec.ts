/**
 * TASK-165 authorization matrix over real HTTP and sockets, on SQLite, PostgreSQL 16 and
 * MySQL 8.4 (SA §4, §10.1 "no implicit SUPERADMIN bypass", §11.2; AC-01/02/03/07/14).
 *
 * Actors:
 * - S: SUPERADMIN;
 * - A: creator, owns a PRIVATE quiz, a PUBLIC quiz, an image and a hosted game with a ready
 *   report;
 * - B: another creator;
 * - an anonymous client.
 *
 * Covered per engine:
 * - Quizzes:
 *   - A's private quiz is a 404 for B and S (guessed UUID), with no title leak;
 *   - the public quiz can be read, exported and duplicated (the copy belongs to B), but never
 *     changed or deleted by B or S;
 *   - listings never show another creator's private quiz;
 *   - anonymous requests get 401.
 * - Media: B and S cannot edit or delete A's upload (404 even with the right revision), and it is
 *   absent from their libraries.
 * - Reports: only the host (A) reads the report, its status and CSV; B and S get 404.
 * - Rooms: B cannot lock or end A's live room over the socket; A can.
 * - Boundary checks:
 *   - a mutation with a foreign or missing Origin, or without the client header, is refused
 *     (403) and changes nothing;
 *   - the refresh cookie is rejected cross-origin;
 *   - the per-IP sign-in limit answers 429;
 *   - replaying a register request does not return a credential;
 *   - logout revokes the refresh family (repeated logout 200, forged token 401).
 * - The API output never contains the passwords, tokens or cookies used.
 */
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import {
  DB_DRIVERS,
  TEST_ORIGIN,
  createTestRuntime,
  databaseEnv,
  httpClient,
  startApi,
  type ApiProcess,
  type TestRuntime,
} from "../helpers/runtime";

const PASSWORD = "Correct-password-123!";
/** Trust loopback as a proxy so each simulated client gets its own rate-limit address. */
const TRUST = { TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]' };
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Credentials of one account. */
interface Session {
  user: { id: string; email: string };
  accessToken: string;
  cookie: string;
}

/** Connects a socket to `/game` (optionally authenticated). */
async function connect(url: string, accessToken?: string): Promise<Socket> {
  const socket = io(`${url}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: accessToken ? { protocolVersion: 1, accessToken } : { protocolVersion: 1 },
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

describe.each(DB_DRIVERS)("authorization matrix on %s", (driver) => {
  let runtime: TestRuntime | undefined;
  let api: ApiProcess | undefined;
  let call: ReturnType<typeof httpClient>;
  const secrets: string[] = [PASSWORD];
  const sockets: Socket[] = [];
  const fixture: {
    s: Session | null;
    a: Session | null;
    b: Session | null;
    privateQuiz: string;
    publicQuiz: string;
    publicRevision: number;
    mediaId: string;
    reportId: string;
    room: { sessionId: string; pinCode: string } | null;
    hostSocket: Socket | null;
  } = {
    s: null,
    a: null,
    b: null,
    privateQuiz: "",
    publicQuiz: "",
    publicRevision: 0,
    mediaId: "",
    reportId: "",
    room: null,
    hostSocket: null,
  };

  /** Session from an auth response; remembers its secrets for the log check. */
  const session = (response: Awaited<ReturnType<typeof call>>): Session => {
    const body = response.json as { user: Session["user"]; accessToken: string };
    if (!response.cookie) throw new Error("missing refresh cookie");
    secrets.push(body.accessToken, response.cookie.split("=")[1] ?? "");
    return { user: body.user, accessToken: body.accessToken, cookie: response.cookie };
  };
  /** Registers a creator (the instance starts in PUBLIC mode). */
  const register = async (name: string, email: string, ip: string) => {
    const response = await call("/auth/register", {
      method: "POST",
      ip,
      headers: { "Idempotency-Key": randomUUID() },
      body: { name, email, password: PASSWORD },
    });
    expect(response.status).toBe(201);
    return session(response);
  };
  /** Creates a playable one-question quiz with the given visibility for `owner`. */
  const quiz = async (owner: Session, title: string, visibility: "PRIVATE" | "PUBLIC") => {
    const created = await call("/quizzes", {
      method: "POST",
      token: owner.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { title },
    });
    expect(created.status).toBe(201);
    const draft = created.json as {
      id: string;
      revision: number;
      questions: Record<string, unknown>[];
    };
    const saved = await call(`/quizzes/${draft.id}`, {
      method: "PUT",
      token: owner.accessToken,
      headers: { "If-Match": `"${draft.revision}"` },
      body: {
        title,
        description: null,
        coverMediaId: null,
        visibility,
        bgmTrack: "random",
        questions: [
          {
            ...draft.questions[0],
            promptText: `${title}?`,
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
          },
        ],
      },
    });
    expect(saved.status).toBe(200);
    return saved.json as { id: string; revision: number };
  };
  /** Hosts a game of `quizId` as A with one player until the report is ready. */
  const playReport = async (quizId: string, revision: number) => {
    if (!api || !fixture.a) throw new Error("setup missing");
    const host = await connect(api.url, fixture.a.accessToken);
    sockets.push(host);
    const room = await emit(host, "host:create_room", {
      quizId,
      quizRevision: revision,
      displayMode: "PROJECTOR",
      friendlyNicknames: false,
    });
    expect(room.ok).toBe(true);
    const member = {
      sessionId: String(room.data?.["sessionId"]),
      pinCode: String(room.data?.["pinCode"]),
    };
    const player = await connect(api.url);
    sockets.push(player);
    expect(
      (
        await emit(player, "player:join_room", {
          pinCode: member.pinCode,
          nickname: "Pemain",
          avatar: { style: "bottts", seed: "p" },
        })
      ).ok,
    ).toBe(true);
    const started = await emit(host, "host:start_game", { ...member, expectedPhaseVersion: 1 });
    expect(started.ok).toBe(true);
    const sync = await emit(host, "room:sync", member);
    const version = Number(
      (sync.data?.["snapshot"] as { phaseVersion?: number } | undefined)?.phaseVersion,
    );
    const ended = await emit(host, "host:end_game", { ...member, expectedPhaseVersion: version });
    expect(ended.ok).toBe(true);
    for (let attempt = 0; attempt < 300; attempt++) {
      const status = await call(`/reports/${member.sessionId}/status`, {
        token: fixture.a.accessToken,
      });
      if ((status.json as { status?: string } | null)?.status === "ready") return member.sessionId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("report never became ready");
  };

  beforeAll(async () => {
    runtime = await createTestRuntime();
    api = await startApi(runtime, { ...(await databaseEnv(runtime, driver)), ...TRUST });
    call = httpClient(api.base);
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.2.0.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        instanceName: `Matrix ${driver}`,
        name: "Super",
        email: "s@example.org",
        password: PASSWORD,
      },
    });
    expect(setup.status).toBe(201);
    fixture.s = session(setup);
    fixture.a = await register("Ani", "a@example.org", "10.2.0.2");
    fixture.b = await register("Budi", "b@example.org", "10.2.0.3");
    const privateQuiz = await quiz(fixture.a, "Rahasia Ani", "PRIVATE");
    const publicQuiz = await quiz(fixture.a, "Publik Ani", "PUBLIC");
    fixture.privateQuiz = privateQuiz.id;
    fixture.publicQuiz = publicQuiz.id;
    fixture.publicRevision = publicQuiz.revision;
    // A's image upload.
    const form = new FormData();
    form.append("folder", "covers");
    form.append("file", new Blob([PNG], { type: "image/png" }), "ani.png");
    const upload = await fetch(`${api.base}/media/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.a.accessToken}`,
        Origin: TEST_ORIGIN,
        "X-Kabuki-Client": "web-v1",
        "Idempotency-Key": randomUUID(),
        "X-Forwarded-For": "10.2.0.2",
      },
      body: form,
    });
    expect(upload.status).toBe(201);
    fixture.mediaId = ((await upload.json()) as { id: string }).id;
    // A finished game with a ready report, and a live room for the socket checks.
    fixture.reportId = await playReport(privateQuiz.id, privateQuiz.revision);
    const live = await connect(api.url, fixture.a.accessToken);
    sockets.push(live);
    const room = await emit(live, "host:create_room", {
      quizId: publicQuiz.id,
      quizRevision: publicQuiz.revision,
      displayMode: "STREAMER",
      friendlyNicknames: false,
    });
    expect(room.ok).toBe(true);
    fixture.room = {
      sessionId: String(room.data?.["sessionId"]),
      pinCode: String(room.data?.["pinCode"]),
    };
    fixture.hostSocket = live;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await api?.stop();
    await runtime?.cleanup();
  });

  it("hides private quizzes, protects public ones and never bypasses for SUPERADMIN", async () => {
    const { a, b, s, privateQuiz, publicQuiz, publicRevision } = fixture;
    if (!a || !b || !s) throw new Error("fixture missing");
    for (const outsider of [b, s]) {
      for (const path of [`/quizzes/${privateQuiz}`, `/quizzes/${privateQuiz}/export`]) {
        const hidden = await call(path, { token: outsider.accessToken });
        expect(hidden.status).toBe(404);
        expect(hidden.text).not.toContain("Rahasia Ani");
      }
      expect((await call(`/quizzes/${publicQuiz}`, { token: outsider.accessToken })).status).toBe(
        200,
      );
      expect(
        (await call(`/quizzes/${publicQuiz}/export`, { token: outsider.accessToken })).status,
      ).toBe(200);
      // A complete, valid body, so only authorization can refuse the change.
      const detail = (await call(`/quizzes/${publicQuiz}`, { token: a.accessToken })).json as {
        description: string | null;
        visibility: string;
        bgmTrack: string;
        questions: unknown[];
      };
      const valid = {
        title: "Dibajak",
        description: detail.description,
        coverMediaId: null,
        visibility: detail.visibility,
        bgmTrack: detail.bgmTrack,
        questions: detail.questions,
      };
      for (const [method, body] of [
        ["PUT", valid],
        ["DELETE", undefined],
      ] as const) {
        const changed = await call(`/quizzes/${publicQuiz}`, {
          method,
          token: outsider.accessToken,
          headers: { "If-Match": `"${publicRevision}"` },
          ...(body ? { body } : {}),
        });
        expect([403, 404]).toContain(changed.status);
      }
      const ownList = await call("/quizzes?scope=own&limit=100", { token: outsider.accessToken });
      expect(ownList.text).not.toContain(privateQuiz);
      expect(ownList.text).not.toContain(publicQuiz);
      const publicList = await call("/quizzes?scope=public&limit=100", {
        token: outsider.accessToken,
      });
      expect(publicList.text).toContain(publicQuiz);
      expect(publicList.text).not.toContain(privateQuiz);
    }
    // Unchanged for its owner after every attempt.
    const owned = await call(`/quizzes/${publicQuiz}`, { token: a.accessToken });
    expect((owned.json as { title: string; revision: number }).title).toBe("Publik Ani");
    expect((owned.json as { revision: number }).revision).toBe(publicRevision);
    // Duplicating a public quiz makes an independent copy owned by B.
    const copy = await call(`/quizzes/${publicQuiz}/duplicate`, {
      method: "POST",
      token: b.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(copy.status).toBe(201);
    const duplicated = copy.json as { id: string; creatorId: string };
    expect(duplicated.id).not.toBe(publicQuiz);
    expect(duplicated.creatorId).toBe(b.user.id);
    // Anonymous: no access at all.
    expect((await call(`/quizzes/${publicQuiz}`)).status).toBe(401);
  });

  it("keeps media private to its uploader, including from SUPERADMIN", async () => {
    const { a, b, s, mediaId } = fixture;
    if (!a || !b || !s) throw new Error("fixture missing");
    // The owner's current revision, so only authorization can refuse the outsiders' changes.
    const listed = (await call("/media?limit=100", { token: a.accessToken })).json as {
      items: { id: string; revision: number }[];
    };
    const revision = listed.items.find((item) => item.id === mediaId)?.revision ?? 0;
    for (const outsider of [b, s]) {
      const edited = await call(`/media/${mediaId}`, {
        method: "PATCH",
        token: outsider.accessToken,
        headers: { "If-Match": `"${revision}"` },
        body: {
          accessibility: {
            altText: "Diubah",
            transcript: null,
            captions: [],
            visualDescription: null,
          },
        },
      });
      expect(edited.status).toBe(404);
      const removed = await call(`/media/${mediaId}`, {
        method: "DELETE",
        token: outsider.accessToken,
        headers: { "If-Match": `"${revision}"` },
      });
      expect(removed.status).toBe(404);
      const library = await call("/media?limit=100", { token: outsider.accessToken });
      expect(library.status).toBe(200);
      expect(library.text).not.toContain(mediaId);
    }
    const own = await call("/media?limit=100", { token: a.accessToken });
    expect(own.text).toContain(mediaId);
  });

  it("serves reports only to their host", async () => {
    const { a, b, s, reportId } = fixture;
    if (!a || !b || !s) throw new Error("fixture missing");
    for (const path of [
      `/reports/${reportId}`,
      `/reports/${reportId}/status`,
      `/reports/${reportId}/players`,
      `/reports/${reportId}/export-csv`,
    ]) {
      expect((await call(path, { token: a.accessToken })).status).toBe(200);
      for (const outsider of [b, s]) {
        const hidden = await call(path, { token: outsider.accessToken });
        expect(hidden.status).toBe(404);
        expect(hidden.text).not.toContain("Pemain");
      }
      expect((await call(path)).status).toBe(401);
    }
    const listed = await call("/reports?limit=15", { token: b.accessToken });
    expect(listed.text).not.toContain(reportId);
  });

  it("refuses host commands from anyone but the room's host", async () => {
    const { b, s, room, hostSocket } = fixture;
    if (!api || !b || !s || !room || !hostSocket) throw new Error("fixture missing");
    for (const outsider of [b, s]) {
      const socket = await connect(api.url, outsider.accessToken);
      sockets.push(socket);
      const lock = await emit(socket, "host:lock_room", { ...room, isLocked: true });
      expect(lock.ok).toBe(false);
      expect(["FORBIDDEN", "NOT_FOUND", "ROOM_NOT_FOUND"]).toContain(lock.error?.errorCode);
      const end = await emit(socket, "host:end_game", { ...room, expectedPhaseVersion: 1 });
      expect(end.ok).toBe(false);
      expect((await emit(socket, "host:recover_room", { sessionId: room.sessionId })).ok).toBe(
        false,
      );
    }
    const anonymous = await connect(api.url);
    sockets.push(anonymous);
    expect((await emit(anonymous, "host:lock_room", { ...room, isLocked: true })).ok).toBe(false);
    // The real host still controls the room.
    expect((await emit(hostSocket, "host:lock_room", { ...room, isLocked: true })).ok).toBe(true);
  });

  it("guards Origin, cookies, rate limits, credential replay and logout", async () => {
    const { a } = fixture;
    if (!a || !api) throw new Error("fixture missing");
    // Mutations from a foreign origin, without Origin or without the client header: 403, no change.
    const before = await call("/quizzes?scope=own&limit=100", { token: a.accessToken });
    const count = (before.json as { meta: { total: number } }).meta.total;
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "" },
      { "X-Kabuki-Client": "" },
    ]) {
      const forged = await call("/quizzes", {
        method: "POST",
        token: a.accessToken,
        headers: { "Idempotency-Key": randomUUID(), ...headers },
        body: { title: "Palsu" },
      });
      expect(forged.status).toBe(403);
    }
    const after = await call("/quizzes?scope=own&limit=100", { token: a.accessToken });
    expect((after.json as { meta: { total: number } }).meta.total).toBe(count);
    // The refresh cookie does not work cross-origin.
    const crossRefresh = await call("/auth/refresh", {
      method: "POST",
      body: {},
      cookie: a.cookie,
      headers: { Origin: "https://evil.example" },
    });
    expect(crossRefresh.status).toBe(403);
    // Per-IP sign-in limit: the 11th attempt within a minute is refused.
    const attempts = [];
    for (let index = 0; index < 11; index++)
      attempts.push(
        await call("/auth/login", {
          method: "POST",
          ip: "10.2.9.9",
          body: { email: `nobody${index}@example.org`, password: "Wrong-password-123!" },
        }),
      );
    expect(attempts.slice(0, 10).every((attempt) => attempt.status === 401)).toBe(true);
    expect(attempts[10]?.status).toBe(429);
    // Replaying a register request never hands out another credential.
    const key = randomUUID();
    const first = await call("/auth/register", {
      method: "POST",
      ip: "10.2.9.10",
      headers: { "Idempotency-Key": key },
      body: { name: "Cici", email: "c@example.org", password: PASSWORD },
    });
    expect(first.status).toBe(201);
    session(first);
    const replay = await call("/auth/register", {
      method: "POST",
      ip: "10.2.9.10",
      headers: { "Idempotency-Key": key },
      body: { name: "Cici", email: "c@example.org", password: PASSWORD },
    });
    expect(replay.status).toBe(409);
    expect((replay.json as { errorCode: string }).errorCode).toBe(
      "OPERATION_COMPLETED_REAUTH_REQUIRED",
    );
    expect(replay.text).not.toContain("accessToken");
    expect(replay.cookie).toBeNull();
    // Logout revokes the session's refresh family (access tokens are short-lived and stateless).
    const leaving = session(
      await call("/auth/login", {
        method: "POST",
        ip: "10.2.9.11",
        body: { email: "c@example.org", password: PASSWORD },
      }),
    );
    expect(
      (await call("/auth/logout", { method: "POST", cookie: leaving.cookie, body: {} })).status,
    ).toBe(200);
    expect(
      (await call("/auth/refresh", { method: "POST", cookie: leaving.cookie, body: {} })).status,
    ).toBe(401);
    // Repeated logout stays 200; a forged token is refused.
    expect(
      (await call("/auth/logout", { method: "POST", cookie: leaving.cookie, body: {} })).status,
    ).toBe(200);
    expect(
      (await call("/auth/logout", { method: "POST", token: "forged.token.value", body: {} }))
        .status,
    ).toBe(401);
  });

  it("never writes passwords, tokens or cookies to the API output", () => {
    const output = api?.logs() ?? "";
    for (const secret of secrets.filter((value) => value.length >= 8))
      expect(output.includes(secret)).toBe(false);
  });
});
