import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import {
  AuthRepository,
  UsersRepository,
  OperationsRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { IdempotencyService } from "../../common/idempotency.service";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { RefreshService } from "../auth/refresh.service";
import { UsersService } from "./users.service";
import { InvitationsService } from "./invitations.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const accounts = new AuthRepository(db),
  repository = new UsersRepository(db);
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: randomBytes(64).toString("hex"),
  refreshSecret: randomBytes(64).toString("hex"),
});
const refresh = new RefreshService(config, accounts, repository);
const jwt = new JwtGuard(refresh),
  roles = new RolesGuard(jwt, new Reflector());
const users = new UsersService(repository, roles);
const invites = new InvitationsService(
  accounts,
  roles,
  new IdempotencyService(new OperationsRepository(db)),
);
async function identity(role: "SUPERADMIN" | "CREATOR", name = "Test") {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    email: `${id}@example.org`,
    name,
    password_hash: "fixture",
    role,
    created_at: 1,
    updated_at: 1,
  });
  const session = refresh.issue({ id, auth_version: 1 });
  await db.manager.insert("refresh_tokens", session.record);
  return { id, session, principal: await jwt.authenticate(session.accessToken) };
}
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of ["request_dedup", "invitations", "refresh_tokens", "users"])
    await db.manager.clear(table);
});

it("serializes concurrent removal of the last active administrators and revokes all sessions", async () => {
  const a = await identity("SUPERADMIN"),
    b = await identity("SUPERADMIN");
  const results = await Promise.allSettled([
    users.patch(a.principal, a.id, 1, { role: "CREATOR" }),
    users.patch(b.principal, b.id, 1, { isActive: false }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { errorCode: "LAST_SUPERADMIN", status: 409 },
  });
  expect(await db.manager.count("users", { where: { role: "SUPERADMIN", is_active: true } })).toBe(
    1,
  );
  const changed = (await repository.current(a.id))?.auth_version === 2 ? a : b;
  await expect(jwt.authenticate(changed.session.accessToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  const tokens = await db.manager.find<{ user_id: string; revoked_at: number | null }>(
    "refresh_tokens",
    {
      where: { user_id: changed.id },
    },
  );
  expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
});

it("enforces role, current identity, revision and strict filters without exposing credentials", async () => {
  const a = await identity("SUPERADMIN"),
    c = await identity("CREATOR", "Literal_%!");
  await expect(users.list(c.principal, {})).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
  await expect(users.list(a.principal, { unknown: true })).rejects.toMatchObject({ status: 422 });
  const page = await users.list(a.principal, { search: "_%!", limit: "1", isActive: "true" });
  expect(page.items.map((u) => u.id)).toEqual([c.id]);
  expect(JSON.stringify(page)).not.toMatch(/password|auth_version/);
  await expect(users.patch(a.principal, c.id, 2, { isActive: false })).rejects.toMatchObject({
    errorCode: "REVISION_CONFLICT",
  });
  await expect(
    users.patch(a.principal, randomUUID(), 1, { isActive: false }),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  const changed = await users.patch(a.principal, c.id, 1, { role: "SUPERADMIN" });
  expect(changed.revision).toBe(2);
  await expect(users.list(c.principal, {})).rejects.toMatchObject({ errorCode: "TOKEN_REVOKED" });
  expect((await users.patch(a.principal, c.id, 2, { role: "SUPERADMIN" })).revision).toBe(2);
});

it("issues a random code once, persists only its hash and rejects changed/repeated requests", async () => {
  const a = await identity("SUPERADMIN"),
    key = randomUUID();
  const first = await invites.create(a.principal, {}, key);
  expect(first.response.inviteCode).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.response.invitation.expiresAt - first.response.invitation.createdAt).toBe(
    168 * 3_600_000,
  );
  const stored = await db
    .getRepository<{ id: string; code_hash: string }>("invitations")
    .createQueryBuilder("i")
    .addSelect("i.code_hash")
    .where("i.id = :id", { id: first.response.invitation.id })
    .getOneOrFail();
  expect(stored.code_hash).toBe(
    createHash("sha256").update(first.response.inviteCode).digest("hex"),
  );
  expect(JSON.stringify(await db.manager.find("request_dedup"))).not.toContain(
    first.response.inviteCode,
  );
  await expect(invites.create(a.principal, {}, key)).rejects.toMatchObject({
    errorCode: "INVITE_CODE_ALREADY_ISSUED",
  });
  await expect(invites.create(a.principal, { expiresInHours: 1 }, key)).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
  });
  expect(await db.manager.count("invitations")).toBe(1);
  await expect(
    invites.create(a.principal, { expiresInHours: 721 }, randomUUID()),
  ).rejects.toMatchObject({ status: 422 });
  const sharedKey = randomUUID();
  const race = await Promise.allSettled([
    invites.create(a.principal, {}, sharedKey),
    invites.create(a.principal, {}, sharedKey),
  ]);
  expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await db.manager.count("invitations")).toBe(2);
});

it("derives invitation status with USED precedence and protects revoked/used records", async () => {
  const a = await identity("SUPERADMIN"),
    c = await identity("CREATOR");
  const first = await invites.create(a.principal, { expiresInHours: 1 }, randomUUID());
  const id = first.response.invitation.id;
  await expect(invites.revoke(c.principal, id)).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
  await invites.revoke(a.principal, id);
  await invites.revoke(a.principal, id);
  await db.manager.update("invitations", id, { expires_at: 1 });
  expect((await invites.list(a.principal, { status: "REVOKED" })).items[0]?.status).toBe("REVOKED");
  await db.manager.update("invitations", id, { used_at: 2, used_by: c.id });
  expect((await invites.list(a.principal, { status: "USED" })).items[0]?.status).toBe("USED");
  await expect(invites.revoke(a.principal, id)).rejects.toMatchObject({
    errorCode: "INVITE_UNAVAILABLE",
  });
  await expect(invites.revoke(a.principal, randomUUID())).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
  await db.manager.update("invitations", id, { used_at: null, revoked_at: null });
  expect((await invites.list(a.principal, { status: "EXPIRED" })).items[0]?.status).toBe("EXPIRED");
  expect((await invites.list(a.principal, { status: "ACTIVE" })).items).toEqual([]);
});
