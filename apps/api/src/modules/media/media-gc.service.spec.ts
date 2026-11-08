/**
 * TASK-068 coverage on SQLite with a real local origin: owner deletion with reference/pin
 * protection and origin-failure restore, bounded singleton orphan cleanup (partial 200 vs total
 * 503, confirmed freedBytes, hasMore, completed-key replay) and the janitor for interrupted uploads
 * and crashed deletions.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  AuthRepository,
  MediaRepository,
  OperationsRepository,
  QuizzesRepository,
  SettingsRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type MediaRow,
} from "@kabuki-neko/database";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { IdempotencyService } from "../../common/idempotency.service";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { initializeStorage } from "../../providers/storage/storage.module";
import type { StorageRegistry } from "../../providers/storage/storage-registry";
import { RefreshService } from "../auth/refresh.service";
import { MediaGcService, STALE_DELETING_MS } from "./media-gc.service";
import { MediaReferenceService } from "./media-reference.service";
import { MediaService } from "./media.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const repo = new MediaRepository(db);
const quizzes = new QuizzesRepository(db);
let directory: string;
let config: ConfigService;
let registry: StorageRegistry;
let jwt: JwtGuard;
let refresh: RefreshService;
let uploads: MediaService;
let gc: MediaGcService;
let image: Buffer;

/** Creates a user row and returns its verified principal. */
async function identity(): Promise<VerifiedPrincipal> {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "Creator",
    email: `${id}@example.org`,
    password_hash: "fixture",
    created_at: 1,
    updated_at: 1,
  });
  return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
}
/** Uploads the PNG fixture as a READY cover and returns its row. */
async function ready(owner: VerifiedPrincipal): Promise<MediaRow> {
  const { response } = await uploads.upload(
    owner,
    {
      bytes: image,
      originalName: "cover.png",
      declaredMime: "image/png",
      folder: "covers",
      accessibility: emptyAccessibility(),
    },
    randomUUID(),
  );
  return db.getRepository<MediaRow>("media_assets").findOneByOrFail({ id: response.id });
}
/** Current row or null. */
function row(id: string) {
  return repo.find(id);
}
/** True when the blob exists under the local origin. */
async function stored(asset: MediaRow) {
  try {
    await access(join(config.values.LOCAL_STORAGE_PATH, asset.storage_key));
    return true;
  } catch {
    return false;
  }
}
/** Pins an asset to an active room (room_media) so cleanup and deletion must preserve it. */
async function pin(host: VerifiedPrincipal, mediaId: string) {
  const session = randomUUID();
  await db.manager.insert("room_allocations", {
    id: session,
    pin_code: String(100000 + Math.floor(Math.random() * 899999)),
    host_id: host.user.id,
    quiz_id: null,
    quiz_revision: 1,
    creation_snapshot: "{}",
    state_driver: "memory",
    state_namespace: "test",
    status: "ACTIVE",
    created_at: 1,
    expires_at: Date.now() + 3_600_000,
    last_heartbeat_at: 1,
  });
  await db.manager.insert("room_media", { session_id: session, media_id: mediaId, created_at: 1 });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kabuki-media-gc-"));
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
  refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
  jwt = new JwtGuard(refresh);
  const operations = new IdempotencyService(new OperationsRepository(db));
  const references = new MediaReferenceService(repo);
  uploads = new MediaService(
    repo,
    new SettingsRepository(db),
    registry,
    config,
    jwt,
    operations,
    references,
    null,
  );
  gc = new MediaGcService(repo, registry, operations, references);
  image = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#393" } })
    .png()
    .toBuffer();
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
  registry.close();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const table of [
    "request_dedup",
    "room_media",
    "room_allocations",
    "question_options",
    "questions",
    "quizzes",
    "media_assets",
    "users",
  ])
    await db.manager.clear(table);
});

it("deletes only unreferenced owned media and restores it when the origin fails", async () => {
  const owner = await identity(),
    other = await identity();
  const free = await ready(owner);
  expect(await gc.deleteOwned(owner.user.id, free.id)).toEqual({ deleted: true });
  expect(await row(free.id)).toBeNull();
  expect(await stored(free)).toBe(false);

  const covered = await ready(owner);
  await quizzes.create(owner.user.id, { title: "Cover", coverMediaId: covered.id }, 1);
  await expect(gc.deleteOwned(owner.user.id, covered.id)).rejects.toMatchObject({
    errorCode: "MEDIA_IN_USE",
  });

  const shared = await ready(owner);
  const source = await quizzes.create(
    owner.user.id,
    { title: "Shared", coverMediaId: shared.id, visibility: "PUBLIC" },
    1,
  );
  await quizzes.duplicate(other.user.id, source, 2);
  await quizzes.delete(owner.user.id, source, 1);
  await expect(gc.deleteOwned(owner.user.id, shared.id)).rejects.toMatchObject({
    errorCode: "MEDIA_IN_USE",
  });

  const pinned = await ready(owner);
  await pin(owner, pinned.id);
  await expect(gc.deleteOwned(owner.user.id, pinned.id)).rejects.toMatchObject({
    errorCode: "MEDIA_IN_USE",
  });
  for (const kept of [covered, shared, pinned]) {
    expect((await row(kept.id))?.state).toBe("READY");
    expect(await stored(kept)).toBe(true);
  }

  const fragile = await ready(owner);
  await expect(gc.deleteOwned(other.user.id, fragile.id)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
  jest.spyOn(registry.active, "delete").mockRejectedValueOnce(new Error("origin down"));
  await expect(gc.deleteOwned(owner.user.id, fragile.id)).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  expect((await row(fragile.id))?.state).toBe("READY");
  expect(await stored(fragile)).toBe(true);
  expect(await gc.deleteOwned(owner.user.id, fragile.id)).toEqual({ deleted: true });

  const uploading = await repo.reserve(
    { ...fragile, id: randomUUID(), storage_key: `covers/${randomUUID()}.webp` },
    Date.now(),
  );
  await expect(gc.deleteOwned(owner.user.id, uploading.id)).rejects.toMatchObject({
    errorCode: "RESOURCE_BUSY",
  });
  await expect(gc.deleteOwned(owner.user.id, "not-a-uuid")).rejects.toMatchObject({
    errorCode: "VALIDATION_FAILED",
  });
});

it("cleans one bounded batch, preserving references and reporting confirmed bytes only", async () => {
  const owner = await identity(),
    other = await identity();
  const first = await ready(owner),
    stuck = await ready(owner),
    foreign = await ready(other);
  const covered = await ready(owner);
  await quizzes.create(owner.user.id, { title: "Keep", coverMediaId: covered.id }, 1);
  const pinned = await ready(other);
  await pin(other, pinned.id);
  const failed = await repo.finishUpload(
    (
      await repo.reserve(
        { ...first, id: randomUUID(), storage_key: `covers/${randomUUID()}.webp` },
        5,
      )
    ).id,
    1,
    null,
    6,
  );
  const original = registry.active.delete.bind(registry.active);
  jest
    .spyOn(registry.active, "delete")
    .mockImplementation((key: string) =>
      key === stuck.storage_key ? Promise.reject(new Error("io")) : original(key),
    );
  const key = randomUUID();
  const result = await gc.cleanup(owner.user.id, key);
  const deleted = [first, foreign];
  expect(result).toMatchObject({
    scannedCount: 4,
    deletedCount: 3,
    freedBytes: deleted.reduce((sum, asset) => sum + asset.size_bytes, 0) + failed.size_bytes,
    skippedInUseCount: 0,
    failedCount: 1,
    failures: [{ mediaId: stuck.id, errorCode: "DELETE_FAILED" }],
    hasMore: false,
  });
  for (const asset of deleted) expect(await row(asset.id)).toBeNull();
  expect(await row(failed.id)).toBeNull();
  expect((await row(stuck.id))?.state).toBe("READY");
  expect(await stored(stuck)).toBe(true);
  for (const kept of [covered, pinned]) {
    expect((await row(kept.id))?.state).toBe("READY");
    expect(await stored(kept)).toBe(true);
  }
  await expect(gc.cleanup(owner.user.id, key)).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
  });

  jest.spyOn(registry.active, "delete").mockRejectedValue(new Error("origin down"));
  await expect(gc.cleanup(owner.user.id, randomUUID())).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  expect((await row(stuck.id))?.state).toBe("READY");
  jest.restoreAllMocks();

  const retry = await gc.cleanup(owner.user.id, randomUUID());
  expect(retry).toMatchObject({ scannedCount: 1, deletedCount: 1, failedCount: 0 });
  expect(await stored(stuck)).toBe(false);
  await expect(gc.cleanup(owner.user.id, randomUUID())).resolves.toMatchObject({ scannedCount: 0 });
});

it("reports an unconfigured origin as STORAGE_UNAVAILABLE and pages with hasMore", async () => {
  const owner = await identity();
  const lost = await ready(owner);
  await db.manager.update("media_assets", lost.id, { storage_location_id: "retired-origin" });
  await expect(gc.cleanup(owner.user.id, randomUUID())).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  expect((await row(lost.id))?.state).toBe("READY");
  await db.manager.delete("media_assets", lost.id);

  for (let i = 0; i < 101; i++) {
    const id = randomUUID();
    const reserved = await repo.reserve(
      {
        id,
        uploader_id: owner.user.id,
        storage_driver: "local",
        storage_location_id: registry.activeId,
        storage_key: `covers/${id}.webp`,
        public_url: `${config.values.NEXT_PUBLIC_API_URL}/uploads/covers/${id}.webp`,
        original_name: "bulk.webp",
        mime_type: "image/webp",
        accessibility: emptyAccessibility(),
      },
      i,
    );
    await repo.finishUpload(
      reserved.id,
      1,
      { size_bytes: 7, width: 1, height: 1, duration_ms: null },
      i,
    );
  }
  const first = await gc.cleanup(owner.user.id, randomUUID());
  expect(first).toMatchObject({
    scannedCount: 100,
    deletedCount: 100,
    freedBytes: 700,
    hasMore: true,
  });
  const second = await gc.cleanup(owner.user.id, randomUUID());
  expect(second).toMatchObject({ scannedCount: 1, deletedCount: 1, freedBytes: 7, hasMore: false });
});

it("runs cleanup as a singleton across administrators", async () => {
  const admin = await identity(),
    another = await identity();
  await db.manager.insert("request_dedup", {
    id: randomUUID(),
    actor_scope: another.user.id,
    operation: "cleanup",
    key: randomUUID(),
    request_hash: "0".repeat(64),
    state: "PENDING",
    created_at: Date.now(),
    expires_at: Date.now() + 86_400_000,
    lease_until: Date.now() + 60_000,
  });
  await expect(gc.cleanup(admin.user.id, randomUUID())).rejects.toMatchObject({
    errorCode: "RESOURCE_BUSY",
  });
  await db.manager.update(
    "request_dedup",
    { operation: "cleanup" },
    { lease_until: Date.now() - 1 },
  );
  await expect(gc.cleanup(admin.user.id, randomUUID())).resolves.toMatchObject({ scannedCount: 0 });
});

it("janitor fails stale uploads and finishes crashed deletions idempotently", async () => {
  const owner = await identity();
  const base = await ready(owner);
  const now = Date.now();
  const reservation = (created: number) =>
    repo.reserve(
      { ...base, id: randomUUID(), storage_key: `covers/${randomUUID()}.webp` },
      created,
    );
  const stale = await reservation(now - 2 * 3_600_000);
  const fresh = await reservation(now - 60_000);
  const crashed = await ready(owner);
  await repo.claimDelete(crashed.id, owner.user.id, crashed.revision, now - STALE_DELETING_MS - 1);
  const recent = await ready(owner);
  await repo.claimDelete(recent.id, owner.user.id, recent.revision, now);

  jest.spyOn(registry.active, "delete").mockRejectedValueOnce(new Error("origin down"));
  expect(await gc.sweep(now)).toEqual({ failedUploads: 1, retriedDeletions: 1, deletedRows: 0 });
  expect((await row(stale.id))?.state).toBe("FAILED");
  expect((await row(fresh.id))?.state).toBe("UPLOADING");
  expect((await row(crashed.id))?.state).toBe("DELETING");
  expect(await stored(crashed)).toBe(true);

  expect(await gc.sweep(now)).toEqual({ failedUploads: 0, retriedDeletions: 1, deletedRows: 1 });
  expect(await row(crashed.id)).toBeNull();
  expect(await stored(crashed)).toBe(false);
  expect((await row(recent.id))?.state).toBe("DELETING");
  expect(await gc.sweep(now)).toEqual({ failedUploads: 0, retriedDeletions: 0, deletedRows: 0 });
});
