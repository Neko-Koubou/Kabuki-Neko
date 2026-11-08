/**
 * TASK-072 coverage for HealthService and SystemService on SQLite with a real local storage
 * origin: partial dependency failures (down vs unknown on timeout), real check timestamps and the
 * 5 s cache, secret redaction, settings role/revision/locale/strictness rules, public display cache
 * invalidation, and fresh/stale/unavailable storage metrics that never block settings.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthRepository,
  MediaRepository,
  SettingsRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { StateConnections } from "../../providers/state/state.module";
import { initializeStorage } from "../../providers/storage/storage.module";
import type { StorageRegistry } from "../../providers/storage/storage-registry";
import { RefreshService } from "../auth/refresh.service";
import { HealthService, limitConcurrency } from "./health.service";
import { InstalledLocales, SystemService } from "./system.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
let directory: string;
let config: ConfigService;
let registry: StorageRegistry;
let memoryState: StateConnections;
let jwt: JwtGuard;
let refresh: RefreshService;
const media = new MediaRepository(db);

/** Locale registry stub: only `en` and `id` are installed. */
class TwoLocales extends InstalledLocales {
  isInstalled(tag: string): boolean {
    return tag === "en" || tag === "id";
  }
}
/** Creates a user row and returns its verified principal. */
async function identity(role: "SUPERADMIN" | "CREATOR"): Promise<VerifiedPrincipal> {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "User",
    email: `${id}@example.org`,
    password_hash: "fixture",
    role,
    created_at: 1,
    updated_at: 1,
  });
  return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
}
/** A Redis-like state connection whose PING never answers (simulated partition). */
function hangingState(): StateConnections {
  return {
    command: { ping: () => new Promise<never>(() => undefined) },
  } as unknown as StateConnections;
}
/** Config whose state driver is Redis (no live connection is opened by the health service). */
function redisConfig(): ConfigService {
  return new ConfigService(
    parseEnvironment({
      NODE_ENV: "test",
      STATE_DRIVER: "redis",
      REDIS_URL: "redis://user:redis-password-123@127.0.0.1:6390/0",
      LOCAL_STORAGE_PATH: join(directory, "uploads"),
      APP_SECRET_FILE: join(directory, "runtime-secrets.json"),
    }),
    {
      accessSecret: randomBytes(64).toString("hex"),
      refreshSecret: randomBytes(64).toString("hex"),
    },
  );
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kabuki-health-"));
  config = new ConfigService(
    parseEnvironment({
      NODE_ENV: "test",
      LOCAL_STORAGE_PATH: join(directory, "uploads"),
      APP_SECRET_FILE: join(directory, "runtime-secrets.json"),
    }),
    {
      accessSecret: randomBytes(64).toString("hex"),
      refreshSecret: randomBytes(64).toString("hex"),
    },
  );
  registry = await initializeStorage(config);
  memoryState = await StateConnections.open(config);
  refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
  jwt = new JwtGuard(refresh);
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
  registry.close();
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("HealthService", () => {
  it("reports ok with real timestamps and caches the snapshot for five seconds", async () => {
    const health = new HealthService(db, registry, memoryState, config);
    const first = await health.check();
    expect(first).toMatchObject({
      app: "Kabuki Neko",
      status: "ok",
      dbDriver: "sqlite",
      storageDriver: "local",
      stateDriver: "memory",
      storageHealth: "up",
      db: { status: "up", errorCode: null },
      storage: { status: "up", errorCode: null },
      state: { status: "up", errorCode: null },
    });
    expect(Math.abs(first.checkedAt - Date.now())).toBeLessThan(2_000);
    const query = jest.spyOn(db, "query");
    const [a, b] = await Promise.all([health.check(), health.check()]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(query).not.toHaveBeenCalled();
    const later = Date.now() + 5_001;
    jest.spyOn(Date, "now").mockReturnValue(later);
    const refreshed = await health.check();
    expect(query).toHaveBeenCalledTimes(1);
    expect(refreshed.checkedAt).toBe(later);
    health.invalidate();
    await health.check();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("separates down from unknown and never leaks failure details", async () => {
    jest.spyOn(db, "query").mockRejectedValueOnce(new Error("password=db-secret-123 at host"));
    jest
      .spyOn(registry.active, "checkHealth")
      .mockRejectedValueOnce(new Error("s3 secret-key-123 http://minio:9000"));
    const health = new HealthService(db, registry, hangingState(), redisConfig(), {
      probeTimeoutMs: 50,
    });
    const started = Date.now();
    const result = await health.check();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({
      status: "degraded",
      stateDriver: "redis",
      storageHealth: "down",
      db: { status: "down", errorCode: "DEPENDENCY_UNAVAILABLE" },
      storage: { status: "down", errorCode: "STORAGE_UNAVAILABLE" },
      state: { status: "unknown", errorCode: "STATE_UNAVAILABLE" },
    });
    const text = JSON.stringify(result);
    for (const secret of [
      "db-secret-123",
      "secret-key-123",
      "minio",
      "redis-password-123",
      "127.0.0.1",
    ])
      expect(text).not.toContain(secret);
    jest.spyOn(registry.active, "checkHealth").mockResolvedValueOnce({
      status: "unknown",
      checkedAt: 1,
      errorCode: "STORAGE_UNAVAILABLE",
    });
    const unknownStorage = await new HealthService(db, registry, memoryState, config).check();
    expect(unknownStorage).toMatchObject({ status: "degraded", storageHealth: "unknown" });
  });

  it("bounds probe parallelism", async () => {
    let active = 0,
      peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return peak;
    };
    await limitConcurrency(
      Array.from({ length: 7 }, () => task),
      3,
    );
    expect(peak).toBe(3);
  });
});

describe("SystemService", () => {
  beforeEach(async () => {
    await db.manager.clear("users");
    await db.manager.update(
      "system_settings",
      { id: "global" },
      { revision: 1, instance_name: "Kabuki Neko", default_locale: "id" },
    );
  });

  it("restricts settings to SUPERADMIN and enforces revision, strictness and installed locales", async () => {
    const admin = await identity("SUPERADMIN"),
      creator = await identity("CREATOR");
    const service = new SystemService(new SettingsRepository(db), media, jwt, new TwoLocales());
    await expect(service.read(creator)).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
    await expect(service.update(creator, 1, { instanceName: "X" })).rejects.toMatchObject({
      errorCode: "FORBIDDEN",
    });
    const current = await service.read(admin);
    expect(current.settings).toMatchObject({
      revision: 1,
      instanceName: "Kabuki Neko",
      defaultLocale: "id",
    });
    await expect(service.update(admin, 1, { dbDriver: "postgres" })).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
    await expect(service.update(admin, 1, {})).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
    });
    await expect(service.update(admin, 1, { defaultLocale: "de" })).rejects.toMatchObject({
      errorCode: "INVALID_LOCALE",
    });
    const updated = await service.update(admin, 1, {
      instanceName: "Quiz Night",
      registrationMode: "INVITE_ONLY",
    });
    expect(updated).toMatchObject({
      registrationChanged: true,
      settings: { revision: 2, instanceName: "Quiz Night" },
    });
    await expect(service.update(admin, 1, { instanceName: "Stale" })).rejects.toMatchObject({
      errorCode: "REVISION_CONFLICT",
      params: { expectedRevision: 1, currentRevision: 2 },
    });
    expect((await service.update(admin, 2, { defaultLocale: "en" })).registrationChanged).toBe(
      false,
    );
  });

  it("caches public display settings for five seconds and invalidates them on PATCH", async () => {
    const admin = await identity("SUPERADMIN");
    const repository = new SettingsRepository(db);
    const service = new SystemService(repository, media, jwt, new TwoLocales());
    expect((await service.publicSettings()).instanceName).toBe("Kabuki Neko");
    await db.manager.update("system_settings", { id: "global" }, { instance_name: "Direct write" });
    expect((await service.publicSettings()).instanceName).toBe("Kabuki Neko");
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
    expect((await service.publicSettings()).instanceName).toBe("Direct write");
    jest.restoreAllMocks();
    await service.update(admin, 1, { instanceName: "Patched", maxImageSizeMb: 7 });
    expect(await service.publicSettings()).toMatchObject({
      instanceName: "Patched",
      revision: 2,
      limits: { imageMb: 7 },
    });
  });

  it("serves fresh, stale and unavailable metrics without blocking settings", async () => {
    const admin = await identity("SUPERADMIN");
    const repository = new SettingsRepository(db);
    const service = new SystemService(repository, media, jwt, new TwoLocales());
    const fresh = await service.read(admin);
    expect(fresh.metrics).toMatchObject({ status: "fresh", fileCount: 0, totalBytes: 0 });
    const ready = jest.spyOn(media, "readyMetrics");
    await service.metrics();
    expect(ready).not.toHaveBeenCalled();
    ready.mockRejectedValue(new Error("db busy"));
    jest.spyOn(Date, "now").mockReturnValue(fresh.metrics.checkedAt + 30_001);
    const stale = await service.read(admin);
    expect(stale.metrics).toEqual({ ...fresh.metrics, status: "stale" });
    expect(stale.settings.revision).toBe(1);

    const cold = new SystemService(repository, media, jwt, new TwoLocales());
    const unavailable = await cold.read(admin);
    expect(unavailable.metrics).toMatchObject({
      status: "unavailable",
      fileCount: 0,
      totalBytes: 0,
    });
    expect(unavailable.settings.instanceName).toBe("Kabuki Neko");
  });
});
