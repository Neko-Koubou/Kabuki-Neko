import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AuthRepository,
  SettingsRepository,
  UsersRepository,
  OperationsRepository,
  canonicalRequestHash,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { IdempotencyService } from "../../common/idempotency.service";
import { PasswordHasher } from "./auth.service";
import { RefreshService } from "./refresh.service";
import { SetupService } from "./setup.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const accounts = new AuthRepository(db),
  settings = new SettingsRepository(db),
  passwords = new PasswordHasher();
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: randomBytes(64).toString("hex"),
  refreshSecret: randomBytes(64).toString("hex"),
});
const refresh = new RefreshService(config, accounts, new UsersRepository(db));
const setup = new SetupService(
  accounts,
  settings,
  new IdempotencyService(new OperationsRepository(db)),
  passwords,
  refresh,
);
const admin = {
  instanceName: "Test",
  name: "Admin",
  email: "admin@example.org",
  password: "Correct-password-123!",
};
const entrant = {
  name: "Creator",
  email: "creator@example.org",
  password: "Correct-password-123!",
};
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
  await passwords.onModuleInit();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of ["request_dedup", "invitations", "refresh_tokens", "users"])
    await db.manager.clear(table);
  await db.manager.update("system_settings", "global", {
    initialized: false,
    registration_mode: "PUBLIC",
    revision: 1,
  });
});

it("creates exactly one administrator in a setup race and publishes initialized status", async () => {
  expect((await setup.status()).isInitialized).toBe(false);
  const result = await Promise.allSettled([
    setup.setup(admin, randomUUID()),
    setup.setup({ ...admin, email: "other@example.org" }, randomUUID()),
  ]);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const rejected = result.find((item) => item.status === "rejected");
  expect(rejected).toMatchObject({ reason: { errorCode: "SETUP_COMPLETE", status: 409 } });
  expect(await db.manager.count("users")).toBe(1);
  expect(await db.manager.count("refresh_tokens")).toBe(1);
  expect(await db.manager.count("request_dedup")).toBe(1);
  expect(await setup.status()).toMatchObject({
    isInitialized: true,
    instanceName: "Test",
    defaultLocale: "id",
  });
});

it("reconciles lost setup and registration responses without creating or replaying credentials", async () => {
  const key = randomUUID();
  const first = await setup.setup(admin, key);
  expect(first.response.user.role).toBe("SUPERADMIN");
  await expect(setup.setup(admin, key)).rejects.toMatchObject({
    errorCode: "OPERATION_COMPLETED_REAUTH_REQUIRED",
    status: 409,
  });
  const registrationKey = randomUUID();
  const registered = await setup.register(entrant, registrationKey);
  expect(registered.response.user.role).toBe("CREATOR");
  await expect(setup.register(entrant, registrationKey)).rejects.toMatchObject({
    errorCode: "OPERATION_COMPLETED_REAUTH_REQUIRED",
  });
  expect(await db.manager.count("users")).toBe(2);
  expect(await db.manager.count("refresh_tokens")).toBe(2);
  const receipts = JSON.stringify(await db.manager.find("request_dedup"));
  for (const secret of [
    admin.password,
    admin.email,
    first.response.session.refreshToken,
    registered.response.session.accessToken,
  ])
    expect(receipts).not.toContain(secret);
});

it("enforces initialized, PUBLIC and SINGLE_ADMIN registration policies", async () => {
  await expect(setup.register(entrant, randomUUID())).rejects.toMatchObject({
    errorCode: "SETUP_REQUIRED",
    status: 403,
  });
  await setup.setup(admin, randomUUID());
  await expect(
    setup.register({ ...entrant, inviteCode: randomBytes(32).toString("base64url") }, randomUUID()),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED", status: 422 });
  await setup.register(entrant, randomUUID());
  await expect(setup.register(entrant, randomUUID())).rejects.toMatchObject({
    errorCode: "EMAIL_EXISTS",
    status: 409,
  });
  await settings.patch(
    (await settings.current()).revision,
    { registrationMode: "SINGLE_ADMIN" },
    Date.now(),
  );
  await expect(
    setup.register({ ...entrant, email: "closed@example.org" }, randomUUID()),
  ).rejects.toMatchObject({ errorCode: "REGISTRATION_CLOSED", status: 403 });
});

it("consumes INVITE_ONLY invitations once under concurrent registration", async () => {
  const created = await setup.setup(admin, randomUUID());
  await settings.patch(
    (await settings.current()).revision,
    { registrationMode: "INVITE_ONLY" },
    Date.now(),
  );
  await expect(setup.register(entrant, randomUUID())).rejects.toMatchObject({
    errorCode: "INVITE_UNAVAILABLE",
  });
  const inviteCode = randomBytes(32).toString("base64url");
  await db.manager.insert("invitations", {
    id: randomUUID(),
    created_by: created.response.user.id,
    code_hash: createHash("sha256").update(inviteCode).digest("hex"),
    created_at: Date.now(),
    expires_at: Date.now() + 60000,
  });
  const results = await Promise.allSettled([
    setup.register({ ...entrant, inviteCode }, randomUUID()),
    setup.register({ ...entrant, email: "other@example.org", inviteCode }, randomUUID()),
  ]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(results.find((item) => item.status === "rejected")).toMatchObject({
    reason: { errorCode: "INVITE_UNAVAILABLE" },
  });
  expect((await accounts.invitations({ status: "USED" }, Date.now())).meta.total).toBe(1);
  expect(await db.manager.count("users")).toBe(2);
});

it("rolls back account, token, setup flag and receipt after a failure and permits retry", async () => {
  const key = randomUUID(),
    original = accounts.setup.bind(accounts);
  jest.spyOn(accounts, "setup").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("FAIL-AFTER-ACCOUNT");
  });
  await expect(setup.setup(admin, key)).rejects.toThrow("FAIL-AFTER-ACCOUNT");
  expect((await setup.status()).isInitialized).toBe(false);
  expect(await db.manager.count("users")).toBe(0);
  expect(await db.manager.count("refresh_tokens")).toBe(0);
  expect(await db.manager.count("request_dedup")).toBe(0);
  expect((await setup.setup(admin, key)).httpStatus).toBe(201);
});

it("stores no fast verifier of the password or invite code in request_dedup (CR-01)", async () => {
  const key = randomUUID();
  await setup.setup(admin, key);
  const [row] = await db.manager.find<{ request_hash: string; operation: string }>(
    "request_dedup",
    {
      where: { operation: "auth.setup" },
    },
  );
  // The plaintext body is fully reconstructible from DB rows; its hash must not match.
  const plain = canonicalRequestHash({
    method: "POST",
    path: "/api/v1/auth/setup",
    query: {},
    body: admin,
    fileSha256: null,
  });
  expect(row?.request_hash).toMatch(/^[0-9a-f]{64}$/u);
  expect(row?.request_hash).not.toBe(plain);
  // A guess using an unkeyed SHA-256 of the password inside the body does not match either.
  expect(row?.request_hash).not.toBe(
    canonicalRequestHash({
      method: "POST",
      path: "/api/v1/auth/setup",
      query: {},
      body: {
        instanceName: admin.instanceName,
        name: admin.name,
        email: admin.email,
        passwordFingerprint: createHash("sha256").update(admin.password).digest("hex"),
      },
      fileSha256: null,
    }),
  );
  // Same key, different password: still an idempotency conflict, not a replay.
  await expect(
    setup.setup({ ...admin, password: "Other-password-456!" }, key),
  ).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
    status: 409,
  });
  const registrationKey = randomUUID();
  await setup.register(entrant, registrationKey);
  const [registration] = await db.manager.find<{ request_hash: string; operation: string }>(
    "request_dedup",
    {
      where: { operation: "auth.register" },
    },
  );
  expect(registration?.request_hash).not.toBe(
    canonicalRequestHash({
      method: "POST",
      path: "/api/v1/auth/register",
      query: {},
      body: entrant,
      fileSha256: null,
    }),
  );
});
