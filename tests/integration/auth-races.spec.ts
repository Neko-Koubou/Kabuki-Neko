/**
 * TASK-165 authentication and administration races over real HTTP, on SQLite, PostgreSQL 16 and
 * MySQL 8.4 (SA §4.2, §9.1, §11.2; AC-01/02).
 *
 * Each engine gets a fresh runtime, a real database (container for PostgreSQL/MySQL) and the built
 * API process. An engine that cannot start fails its tests; none is skipped or replaced silently.
 *
 * Covered per engine:
 * - Five concurrent first-run setups create exactly one SUPERADMIN; the losers get 409 and their
 *   accounts do not exist.
 * - Registration policy:
 *   - concurrent registrations race for one invitation, which is consumed exactly once;
 *   - reusing the invitation fails;
 *   - PUBLIC rejects invite codes with 422 and creates CREATOR accounts;
 *   - SINGLE_ADMIN closes registration.
 * - Last-admin protection under races: two SUPERADMINs demoting or deactivating each other
 *   concurrently always leave exactly one active SUPERADMIN.
 * - Refresh rotation:
 *   - a concurrent double refresh rotates once and revokes the family;
 *   - sequential reuse of a consumed token revokes the family;
 *   - a deactivated account loses access and gets the same uniform login failure as a wrong
 *     password.
 * - Host commands over the socket are denied immediately after the host's role or status changes,
 *   until the host authenticates again (role change) or for good (deactivation).
 * - The API output never contains passwords, access or refresh tokens, or invite codes.
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

/** Credentials returned by setup, register and login. */
interface Session {
  user: { id: string; role: string; revision: number; email: string };
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

describe.each(DB_DRIVERS)("authentication races on %s", (driver) => {
  let runtime: TestRuntime | undefined;
  let api: ApiProcess | undefined;
  let call: ReturnType<typeof httpClient>;
  const secrets: string[] = [PASSWORD];
  const sockets: Socket[] = [];
  const state: { admin: Session | null } = { admin: null };

  /** Registers (PUBLIC mode) or signs in a creator. */
  const register = async (name: string, email: string, ip: string): Promise<Session> => {
    const response = await call("/auth/register", {
      method: "POST",
      ip,
      headers: { "Idempotency-Key": randomUUID() },
      body: { name, email, password: PASSWORD },
    });
    expect(response.status).toBe(201);
    return session(response);
  };
  /** Signs in. */
  const login = async (email: string, ip: string): Promise<Session> => {
    const response = await call("/auth/login", {
      method: "POST",
      ip,
      body: { email, password: PASSWORD },
    });
    expect(response.status).toBe(200);
    return session(response);
  };
  /** Session from an auth response; remembers its secrets for the log check. */
  const session = (response: Awaited<ReturnType<typeof call>>): Session => {
    const body = response.json as { user: Session["user"]; accessToken: string };
    if (!response.cookie) throw new Error("missing refresh cookie");
    secrets.push(body.accessToken, response.cookie.split("=")[1] ?? "");
    return { user: body.user, accessToken: body.accessToken, cookie: response.cookie };
  };
  /** The current settings revision and registration mode. */
  const settings = async () => {
    const response = await call("/system/settings", { token: state.admin?.accessToken ?? "" });
    expect(response.status).toBe(200);
    return (response.json as { settings: { revision: number; registrationMode: string } }).settings;
  };
  /** Switches the registration policy. */
  const setMode = async (mode: string) => {
    const current = await settings();
    const patched = await call("/system/settings", {
      method: "PATCH",
      token: state.admin?.accessToken ?? "",
      headers: { "If-Match": `"${current.revision}"` },
      body: { registrationMode: mode },
    });
    expect(patched.status).toBe(200);
  };
  /** All users (as the given SUPERADMIN). */
  const users = async (token: string) => {
    const response = await call("/users?limit=100", { token });
    expect(response.status).toBe(200);
    return (response.json as { items: (Session["user"] & { isActive: boolean })[] }).items;
  };
  /** Changes a user's role or status as `actor` (If-Match from the given revision). */
  const patchUser = (actor: Session, target: Session["user"], body: Record<string, unknown>) =>
    call(`/users/${target.id}`, {
      method: "PATCH",
      token: actor.accessToken,
      headers: { "If-Match": `"${target.revision}"` },
      body,
    });

  beforeAll(async () => {
    runtime = await createTestRuntime();
    api = await startApi(runtime, { ...(await databaseEnv(runtime, driver)), ...TRUST });
    call = httpClient(api.base);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await api?.stop();
    await runtime?.cleanup();
  });

  it("creates exactly one SUPERADMIN when five setups race", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        call("/auth/setup", {
          method: "POST",
          ip: `10.1.0.${index + 1}`,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            instanceName: `Race ${driver}`,
            name: `Admin ${index}`,
            email: `admin${index}@example.org`,
            password: PASSWORD,
          },
        }),
      ),
    );
    const winners = attempts.filter((attempt) => attempt.status === 201);
    expect(winners).toHaveLength(1);
    for (const loser of attempts.filter((attempt) => attempt.status !== 201)) {
      expect(loser.status).toBe(409);
      expect((loser.json as { errorCode: string }).errorCode).toBe("SETUP_COMPLETE");
    }
    const [winner] = winners;
    if (!winner) throw new Error("no winner");
    state.admin = session(winner);
    expect(state.admin.user.role).toBe("SUPERADMIN");
    const all = await users(state.admin.accessToken);
    expect(all).toHaveLength(1);
    // A replayed setup never returns another account or token.
    const again = await call("/auth/setup", {
      method: "POST",
      ip: "10.1.0.9",
      headers: { "Idempotency-Key": randomUUID() },
      body: { instanceName: "Late", name: "Late", email: "late@example.org", password: PASSWORD },
    });
    expect(again.status).toBe(409);
    expect(again.text).not.toContain("accessToken");
  });

  it("consumes one invitation once under racing registrations and enforces every mode", async () => {
    const admin = state.admin;
    if (!admin) throw new Error("setup missing");
    // SINGLE_ADMIN closes registration (a new instance starts in PUBLIC mode).
    await setMode("SINGLE_ADMIN");
    const closed = await call("/auth/register", {
      method: "POST",
      ip: "10.1.1.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: { name: "Closed", email: "closed@example.org", password: PASSWORD },
    });
    expect(closed.status).toBe(403);

    await setMode("INVITE_ONLY");
    const invite = await call("/users/invitations", {
      method: "POST",
      token: admin.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(invite.status).toBe(201);
    const { inviteCode } = invite.json as { inviteCode: string };
    secrets.push(inviteCode);
    const racers = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        call("/auth/register", {
          method: "POST",
          ip: `10.1.2.${index + 1}`,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            name: `Racer ${index}`,
            email: `racer${index}@example.org`,
            password: PASSWORD,
            inviteCode,
          },
        }),
      ),
    );
    expect(racers.filter((racer) => racer.status === 201)).toHaveLength(1);
    for (const loser of racers.filter((racer) => racer.status !== 201)) {
      expect(loser.status).toBe(409);
      expect((loser.json as { errorCode: string }).errorCode).toBe("INVITE_UNAVAILABLE");
    }
    const winner = racers.find((racer) => racer.status === 201);
    if (winner) expect(session(winner).user.role).toBe("CREATOR");
    const reused = await call("/auth/register", {
      method: "POST",
      ip: "10.1.2.9",
      headers: { "Idempotency-Key": randomUUID() },
      body: { name: "Again", email: "again@example.org", password: PASSWORD, inviteCode },
    });
    expect(reused.status).toBe(409);

    await setMode("PUBLIC");
    const withCode = await call("/auth/register", {
      method: "POST",
      ip: "10.1.3.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: { name: "Coded", email: "coded@example.org", password: PASSWORD, inviteCode },
    });
    expect(withCode.status).toBe(422);
    const open = await register("Open", "open@example.org", "10.1.3.2");
    expect(open.user.role).toBe("CREATOR");
    // 4 racers (1 created) + open + admin.
    expect(await users(admin.accessToken)).toHaveLength(3);
  });

  it("always keeps one active SUPERADMIN when two admins demote or deactivate each other", async () => {
    const admin = state.admin;
    if (!admin) throw new Error("setup missing");
    for (const [round, change] of [
      [1, { role: "CREATOR" }],
      [2, { isActive: false }],
    ] as const) {
      // A second SUPERADMIN with a fresh session (role changes revoke old sessions).
      const second = await register(
        `Second ${round}`,
        `second${round}@example.org`,
        `10.1.4.${round}`,
      );
      const current = await users(state.admin?.accessToken ?? "");
      const target = current.find((user) => user.id === second.user.id);
      if (!target) throw new Error("second admin missing");
      expect((await patchUser(state.admin ?? admin, target, { role: "SUPERADMIN" })).status).toBe(
        200,
      );
      const first = await login(state.admin?.user.email ?? "", `10.1.5.${round}`);
      const promoted = await login(second.user.email, `10.1.6.${round}`);
      const everyone = await users(first.accessToken);
      const firstRow = everyone.find((user) => user.id === first.user.id);
      const secondRow = everyone.find((user) => user.id === promoted.user.id);
      if (!firstRow || !secondRow) throw new Error("admins missing");
      const [a, b] = await Promise.all([
        patchUser(first, secondRow, change),
        patchUser(promoted, firstRow, change),
      ]);
      const outcomes = [a.status, b.status].sort();
      // One change wins; the other is refused (last admin, conflict, or its actor lost the role).
      expect(outcomes.filter((status) => status === 200)).toHaveLength(1);
      for (const status of outcomes.filter((value) => value !== 200))
        expect([401, 403, 409]).toContain(status);
      const winner = a.status === 200 ? first : promoted;
      const survivor = await login(winner.user.email, `10.1.7.${round}`);
      const admins = (await users(survivor.accessToken)).filter(
        (user) => user.role === "SUPERADMIN" && user.isActive,
      );
      expect(admins).toHaveLength(1);
      state.admin = survivor;
      // The last active SUPERADMIN cannot remove itself.
      const self = (await users(survivor.accessToken)).find((user) => user.id === survivor.user.id);
      if (!self) throw new Error("self missing");
      const lonely = await patchUser(survivor, self, change);
      expect(lonely.status).toBe(409);
      expect((lonely.json as { errorCode: string }).errorCode).toBe("LAST_SUPERADMIN");
    }
  });

  it("rotates a refresh token once under a race and revokes the family on reuse or deactivation", async () => {
    const admin = state.admin;
    if (!admin) throw new Error("setup missing");
    const creator = await register("Rotator", "rotator@example.org", "10.1.8.1");
    // Concurrent double refresh with one cookie: one rotation, then the family is revoked.
    const racing = await Promise.all(
      [1, 2].map(() =>
        call("/auth/refresh", { method: "POST", body: {}, cookie: creator.cookie, ip: "10.1.8.2" }),
      ),
    );
    expect(racing.map((response) => response.status).sort()).toEqual([200, 401]);
    const rotated = racing.find((response) => response.status === 200);
    if (rotated?.cookie) secrets.push(rotated.cookie.split("=")[1] ?? "");
    expect(
      (
        await call("/auth/refresh", {
          method: "POST",
          body: {},
          cookie: rotated?.cookie ?? "",
          ip: "10.1.8.2",
        })
      ).status,
    ).toBe(401);

    // Sequential reuse of a consumed token revokes the newer one too.
    const fresh = await login(creator.user.email, "10.1.8.3");
    const next = await call("/auth/refresh", {
      method: "POST",
      body: {},
      cookie: fresh.cookie,
      ip: "10.1.8.3",
    });
    expect(next.status).toBe(200);
    if (next.cookie) secrets.push(next.cookie.split("=")[1] ?? "");
    expect(
      (
        await call("/auth/refresh", {
          method: "POST",
          body: {},
          cookie: fresh.cookie,
          ip: "10.1.8.3",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/auth/refresh", {
          method: "POST",
          body: {},
          cookie: next.cookie ?? "",
          ip: "10.1.8.3",
        })
      ).status,
    ).toBe(401);

    // Deactivation: access is gone at once, and login fails exactly like a wrong password.
    const live = await login(creator.user.email, "10.1.8.4");
    const row = (await users(admin.accessToken)).find((user) => user.id === creator.user.id);
    if (!row) throw new Error("creator missing");
    expect((await patchUser(admin, row, { isActive: false })).status).toBe(200);
    expect((await call("/auth/me", { token: live.accessToken })).status).toBe(401);
    expect(
      (
        await call("/auth/refresh", {
          method: "POST",
          body: {},
          cookie: live.cookie,
          ip: "10.1.8.4",
        })
      ).status,
    ).toBe(401);
    const inactive = await call("/auth/login", {
      method: "POST",
      ip: "10.1.8.5",
      body: { email: creator.user.email, password: PASSWORD },
    });
    const wrong = await call("/auth/login", {
      method: "POST",
      ip: "10.1.8.6",
      body: { email: "open@example.org", password: "Wrong-password-123!" },
    });
    expect(inactive.status).toBe(401);
    expect(wrong.status).toBe(401);
    const strip = (body: unknown) => ({ ...(body as object), correlationId: null });
    expect(strip(inactive.json)).toEqual(strip(wrong.json));
  });

  it("denies host commands at once after the host's role or status changes", async () => {
    const admin = state.admin;
    if (!admin || !api) throw new Error("setup missing");
    const host = await register("Host", "host@example.org", "10.1.9.1");
    // A playable one-question quiz.
    const created = await call("/quizzes", {
      method: "POST",
      token: host.accessToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { title: "Kuis Host" },
    });
    expect(created.status).toBe(201);
    const quiz = created.json as {
      id: string;
      revision: number;
      questions: Record<string, unknown>[];
    };
    const saved = await call(`/quizzes/${quiz.id}`, {
      method: "PUT",
      token: host.accessToken,
      headers: { "If-Match": `"${quiz.revision}"` },
      body: {
        title: "Kuis Host",
        description: null,
        coverMediaId: null,
        visibility: "PRIVATE",
        bgmTrack: "random",
        questions: [
          {
            ...quiz.questions[0],
            promptText: "Siap?",
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
    const playable = saved.json as { revision: number };
    const socket = await connect(api.url, host.accessToken);
    sockets.push(socket);
    const room = await emit(socket, "host:create_room", {
      quizId: quiz.id,
      quizRevision: playable.revision,
      displayMode: "PROJECTOR",
      friendlyNicknames: false,
    });
    expect(room.ok).toBe(true);
    const member = { sessionId: room.data?.["sessionId"], pinCode: room.data?.["pinCode"] };
    expect((await emit(socket, "host:lock_room", { ...member, isLocked: true })).ok).toBe(true);

    // Role change: the old access version is refused immediately.
    let row = (await users(admin.accessToken)).find((user) => user.id === host.user.id);
    if (!row) throw new Error("host missing");
    expect((await patchUser(admin, row, { role: "SUPERADMIN" })).status).toBe(200);
    const afterRole = await emit(socket, "host:lock_room", { ...member, isLocked: false });
    expect(afterRole.ok).toBe(false);
    expect(["TOKEN_REVOKED", "AUTH_REQUIRED", "FORBIDDEN"]).toContain(afterRole.error?.errorCode);
    // Signing in again and announcing the new token restores control.
    const renewed = await login(host.user.email, "10.1.9.2");
    expect((await emit(socket, "auth:update", { accessToken: renewed.accessToken })).ok).toBe(true);
    expect((await emit(socket, "host:lock_room", { ...member, isLocked: false })).ok).toBe(true);

    // Deactivation: refused for good, even with a token that was valid a moment ago.
    row = (await users(admin.accessToken)).find((user) => user.id === host.user.id);
    if (!row) throw new Error("host missing");
    expect((await patchUser(admin, row, { isActive: false })).status).toBe(200);
    const afterStatus = await emit(socket, "host:lock_room", { ...member, isLocked: true });
    expect(afterStatus.ok).toBe(false);
    expect(["TOKEN_REVOKED", "AUTH_REQUIRED", "FORBIDDEN"]).toContain(afterStatus.error?.errorCode);
  });

  it("never writes passwords, tokens, cookies or invite codes to the API output", () => {
    const output = api?.logs() ?? "";
    for (const secret of secrets.filter((value) => value.length >= 8))
      expect(output.includes(secret)).toBe(false);
  });
});
