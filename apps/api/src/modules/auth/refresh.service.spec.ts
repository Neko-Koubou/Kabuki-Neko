import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { JwtService } from "@nestjs/jwt";
import {
  AuthRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { AuthService, PasswordHasher, PasswordWorkQueue } from "./auth.service";
import { RefreshService, refreshCookieOptions, type IssuedSession } from "./refresh.service";

const password = "Correct-password-123!";
const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const repository = new AuthRepository(db),
  users = new UsersRepository(db);
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: randomBytes(64).toString("hex"),
  refreshSecret: randomBytes(64).toString("hex"),
});
const refresh = new RefreshService(config, repository, users),
  passwords = new PasswordHasher();
const auth = new AuthService(repository, passwords, refresh);
let passwordHash: string, userId: string, original: IssuedSession;
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
  const started = performance.now(),
    rssBefore = process.memoryUsage().rss;
  let peak = rssBefore;
  const sample = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    const hashes = await Promise.all([passwords.hash(password), passwords.hash(password)]);
    const firstHash = hashes[0];
    if (!firstHash) throw new Error("Missing password hash");
    passwordHash = firstHash;
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(passwordHash.split("$").slice(1, 3)).toEqual(["argon2id", "v=19"]);
    expect(passwordHash.split("$")[3]?.split(",").sort()).toEqual(["m=65536", "p=1", "t=3"]);
    expect(Buffer.from(passwordHash.split("$")[4] ?? "", "base64")).toHaveLength(16);
    console.info(
      JSON.stringify({
        measurement: "argon2id-two-concurrent-hashes",
        elapsedMs: Math.round(performance.now() - started),
        rssBeforeBytes: rssBefore,
        peakRssBytes: peak,
        peakRssDeltaBytes: peak - rssBefore,
      }),
    );
  } finally {
    clearInterval(sample);
  }
  await passwords.onModuleInit();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.manager.clear("refresh_tokens");
  await db.manager.clear("users");
  await db.manager.update("system_settings", "global", { initialized: false });
  userId = randomUUID();
  original = refresh.issue({ id: userId, auth_version: 1 });
  await repository.setup(
    { id: userId, email: "admin@example.org", name: "Admin", passwordHash },
    "Test",
    original.record,
    Date.now(),
  );
});

it("logs in with a safe DTO and stores only hashed refresh tokens", async () => {
  const result = await auth.login({ email: "ADMIN@example.org", password });
  expect(result.user.id).toBe(userId);
  expect(JSON.stringify(result.user)).not.toContain(passwordHash);
  expect((await refresh.authenticateAccess(result.session.accessToken)).user.id).toBe(userId);
  const row = await db.manager
    .createQueryBuilder()
    .select("token_hash")
    .from("refresh_tokens", "r")
    .where("id = :id", { id: result.session.record.id })
    .getRawOne<{ token_hash: string }>();
  expect(row?.token_hash).toBe(result.session.record.token_hash);
  expect(row?.token_hash).not.toBe(result.session.refreshToken);
  expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
});

it("returns identical errors for unknown, wrong-password and inactive accounts", async () => {
  for (const input of [
    { email: "missing@example.org", password },
    { email: "admin@example.org", password: "Wrong-password-123!" },
  ])
    await expect(auth.login(input)).rejects.toMatchObject({
      errorCode: "INVALID_CREDENTIALS",
      status: 401,
    });
  await db.manager.update("users", userId, { is_active: false });
  await expect(auth.login({ email: "admin@example.org", password })).rejects.toMatchObject({
    errorCode: "INVALID_CREDENTIALS",
    status: 401,
  });
  expect(await db.manager.count("refresh_tokens")).toBe(1);
});

it("rotates once, preserves absolute expiry and revokes the family on consumed-token reuse", async () => {
  const next = await refresh.rotate(original.refreshToken);
  expect(next.refreshToken).not.toBe(original.refreshToken);
  expect(next.refreshExpiresAt).toBe(original.refreshExpiresAt);
  expect(next.record.family_id).toBe(original.record.family_id);
  await expect(refresh.rotate(original.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(refresh.rotate(next.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});

it("serializes simultaneous refresh and commits family revocation on reuse", async () => {
  const result = await Promise.allSettled([
    refresh.rotate(original.refreshToken),
    refresh.rotate(original.refreshToken),
  ]);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const winner = result.find((item) => item.status === "fulfilled");
  if (winner?.status !== "fulfilled") throw new Error("No successful rotation");
  await expect(refresh.rotate(winner.value.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});

it("rejects expired tokens, cross-purpose tokens, forged signatures and changed user versions", async () => {
  await expect(refresh.rotate(original.accessToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(refresh.authenticateAccess(original.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(refresh.rotate(original.refreshToken + "forged")).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  const jwt = new JwtService();
  const expired = jwt.sign(
    { sub: userId, jti: randomUUID(), familyId: randomUUID(), ver: 1, iat: 1, exp: 2 },
    {
      algorithm: "HS256",
      secret: config.secrets.refreshSecret,
      issuer: "kabuki-neko",
      audience: "kabuki-neko-refresh",
    },
  );
  await expect(refresh.rotate(expired)).rejects.toMatchObject({ errorCode: "TOKEN_EXPIRED" });
  await db.manager.update("users", userId, { auth_version: 2 });
  await expect(refresh.rotate(original.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(refresh.authenticateAccess(original.accessToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});

it("logs out only the current family using access or refresh credentials and supports repetition", async () => {
  const other = (await auth.login({ email: "admin@example.org", password })).session;
  await refresh.logout({ accessToken: original.accessToken });
  await expect(refresh.logout({ accessToken: original.accessToken })).resolves.toEqual({
    success: true,
  });
  await expect(refresh.rotate(original.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  const active = await refresh.rotate(other.refreshToken);
  await refresh.logout({ refreshToken: active.refreshToken });
  await expect(refresh.logout({ refreshToken: active.refreshToken })).resolves.toEqual({
    success: true,
  });
  await expect(refresh.rotate(active.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(refresh.logout({ refreshToken: "forged" })).rejects.toMatchObject({ status: 401 });
  await expect(refresh.logout({})).rejects.toMatchObject({ errorCode: "AUTH_REQUIRED" });
});

it("bounds hashing to two active jobs and twenty queued jobs and releases failed slots", async () => {
  const queue = new PasswordWorkQueue();
  let active = 0,
    maximum = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = Array.from({ length: 22 }, () =>
    queue.run(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
    }),
  );
  await expect(queue.run(async () => {})).rejects.toMatchObject({
    errorCode: "DEPENDENCY_UNAVAILABLE",
    status: 503,
  });
  expect(active).toBe(2);
  release?.();
  await Promise.all(work);
  expect(maximum).toBe(2);
  await expect(
    queue.run(async () => {
      throw new Error("Failure");
    }),
  ).rejects.toThrow("Failure");
  await expect(queue.run(async () => "ok")).resolves.toBe("ok");
});

it("sets the narrow refresh cookie path and remaining absolute family lifetime", () => {
  expect(refreshCookieOptions(true, 5000, 2000)).toEqual({
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/api/v1/auth",
    maxAge: 3000,
  });
  expect(refreshCookieOptions(false, 1000, 2000).maxAge).toBe(0);
  expect(refreshCookieOptions(true, 5000)).not.toHaveProperty("domain");
});

it("enforces database expiry and active status even when the JWT remains valid", async () => {
  await db.manager.update("refresh_tokens", original.record.id, { expires_at: Date.now() - 1 });
  await expect(refresh.rotate(original.refreshToken)).rejects.toMatchObject({
    errorCode: "TOKEN_EXPIRED",
  });
  await db.manager.update("users", userId, { is_active: false });
  await expect(refresh.authenticateAccess(original.accessToken)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});

it("pins HS256 and the access and refresh lifetimes", async () => {
  const jwt = new JwtService();
  const access = jwt.verify<{ iat: number; exp: number }>(original.accessToken, {
    secret: config.secrets.accessSecret,
  });
  const token = jwt.verify<{ iat: number; exp: number }>(original.refreshToken, {
    secret: config.secrets.refreshSecret,
  });
  expect(access.exp - access.iat).toBe(900);
  expect(token.exp - token.iat).toBe(7 * 86400);
  const wrongAlgorithm = jwt.sign(
    { sub: userId, jti: randomUUID(), ver: 1 },
    {
      algorithm: "HS384",
      secret: config.secrets.accessSecret,
      issuer: "kabuki-neko",
      audience: "kabuki-neko-web",
      expiresIn: 900,
    },
  );
  await expect(refresh.authenticateAccess(wrongAlgorithm)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});
