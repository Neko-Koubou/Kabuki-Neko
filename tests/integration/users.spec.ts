import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SettingsRepository, createDataSource, domainSchemas } from "../../packages/database/src";
import {
  invitationCreatedSchema,
  invitationsPageSchema,
  usersPageSchema,
  userSchema,
} from "@kabuki-neko/shared/schemas/users.schema";
import { createTestRuntime } from "../helpers/runtime";

it("enforces all user/invitation HTTP contracts and revokes access and refresh credentials", async () => {
  const runtime = await createTestRuntime();
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: { ...process.env, ...runtime.env, API_PORT: String(port), PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("API exited during startup");
      try {
        if ((await fetch(`${base}/auth/setup-status`)).status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for server startup. */
      }
      await delay(100);
    }
    expect(ready).toBe(true);
    const request = (
      path: string,
      method = "GET",
      token?: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
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
    const credentials = z.object({ user: userSchema, accessToken: z.string() });
    const setup = await request(
      "/auth/setup",
      "POST",
      undefined,
      {
        instanceName: "Users integration",
        name: "Admin",
        email: "admin@example.org",
        password: "Correct-password-123!",
      },
      { "Idempotency-Key": randomUUID() },
    );
    expect(setup.status).toBe(201);
    const admin = credentials.parse(await setup.json());
    const register = await request(
      "/auth/register",
      "POST",
      undefined,
      {
        name: "Creator",
        email: "creator@example.org",
        password: "Correct-password-123!",
      },
      { "Idempotency-Key": randomUUID() },
    );
    expect(register.status).toBe(201);
    const creator = credentials.parse(await register.json());
    const cookie = register.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing refresh cookie");
    expect((await request("/users")).status).toBe(401);
    for (const [path, method, body] of [
      ["/users", "GET", undefined],
      ["/users/invitations", "GET", undefined],
      ["/users/invitations", "POST", {}],
      [`/users/invitations/${randomUUID()}`, "DELETE", undefined],
      [`/users/${admin.user.id}`, "PATCH", { isActive: false }],
    ] as const) {
      const denied = await request(path, method, creator.accessToken, body);
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain(admin.user.email);
    }
    const listed = await request(
      "/users?limit=1&search=creator&role=CREATOR&isActive=true",
      "GET",
      admin.accessToken,
    );
    expect(listed.status).toBe(200);
    expect(usersPageSchema.parse(await listed.json()).items.map((u) => u.id)).toEqual([
      creator.user.id,
    ]);
    expect((await request("/users?sort=email", "GET", admin.accessToken)).status).toBe(422);
    expect(
      (await request(`/users/${creator.user.id}`, "PATCH", admin.accessToken, { isActive: false }))
        .status,
    ).toBe(422);
    expect(
      (
        await request(
          `/users/${creator.user.id}`,
          "PATCH",
          admin.accessToken,
          { isActive: false },
          { "If-Match": '"2"' },
        )
      ).status,
    ).toBe(409);
    const patch = await request(
      `/users/${creator.user.id}`,
      "PATCH",
      admin.accessToken,
      { isActive: false },
      { "If-Match": '"1"' },
    );
    expect(patch.status).toBe(200);
    expect(patch.headers.get("etag")).toBe('"2"');
    expect(userSchema.parse(await patch.json()).isActive).toBe(false);
    expect((await request("/auth/me", "GET", creator.accessToken)).status).toBe(401);
    expect((await request("/auth/refresh", "POST", undefined, {}, { Cookie: cookie })).status).toBe(
      401,
    );
    expect(
      (
        await request(
          `/users/${admin.user.id}`,
          "PATCH",
          admin.accessToken,
          { isActive: false },
          { "If-Match": '"1"' },
        )
      ).status,
    ).toBe(409);
    const key = randomUUID();
    const created = await request(
      "/users/invitations",
      "POST",
      admin.accessToken,
      {},
      { "Idempotency-Key": key },
    );
    expect(created.status).toBe(201);
    const invite = invitationCreatedSchema.parse(await created.json());
    const replay = await request(
      "/users/invitations",
      "POST",
      admin.accessToken,
      {},
      { "Idempotency-Key": key },
    );
    expect(replay.status).toBe(409);
    const replayText = await replay.text();
    expect(replayText).toContain("INVITE_CODE_ALREADY_ISSUED");
    expect(replayText).not.toContain(invite.inviteCode);
    const listInvites = await request("/users/invitations?status=ACTIVE", "GET", admin.accessToken);
    expect(listInvites.status).toBe(200);
    expect(invitationsPageSchema.parse(await listInvites.json()).items.map((i) => i.id)).toEqual([
      invite.invitation.id,
    ]);
    expect(
      (await request("/users/invitations?search=secret", "GET", admin.accessToken)).status,
    ).toBe(422);
    const db = createDataSource(
      { driver: "sqlite", sqlitePath: runtime.env.SQLITE_PATH! },
      domainSchemas("sqlite"),
    );
    await db.initialize();
    try {
      const settings = new SettingsRepository(db);
      await settings.patch(
        (await settings.current()).revision,
        { registrationMode: "INVITE_ONLY" },
        Date.now(),
      );
    } finally {
      await db.destroy();
    }
    const used = await request(
      "/auth/register",
      "POST",
      undefined,
      {
        name: "Invitee",
        email: "invitee@example.org",
        password: "Correct-password-123!",
        inviteCode: invite.inviteCode,
      },
      { "Idempotency-Key": randomUUID() },
    );
    expect(used.status).toBe(201);
    expect(
      (await request(`/users/invitations/${invite.invitation.id}`, "DELETE", admin.accessToken))
        .status,
    ).toBe(409);
    const unused = await request(
      "/users/invitations",
      "POST",
      admin.accessToken,
      { expiresInHours: 1 },
      { "Idempotency-Key": randomUUID() },
    );
    const unusedInvite = invitationCreatedSchema.parse(await unused.json());
    for (let i = 0; i < 2; i++) {
      const revoked = await request(
        `/users/invitations/${unusedInvite.invitation.id}`,
        "DELETE",
        admin.accessToken,
      );
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ revoked: true });
    }
    expect(
      (await request(`/users/invitations/${randomUUID()}`, "DELETE", admin.accessToken)).status,
    ).toBe(404);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await runtime.cleanup();
  }
});
