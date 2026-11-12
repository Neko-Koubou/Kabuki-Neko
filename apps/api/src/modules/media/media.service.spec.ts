/**
 * TASK-067 service coverage on a real SQLite database and local storage origin: idempotent upload
 * reservation → blob → READY, storage failure compensation, crash-after-put reconciliation, owner
 * library listing, and accessibility metadata guarded by owner and revision (no admin bypass and
 * no library access through retained foreign quiz references).
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
  type OperationRow,
} from "@kabuki-neko/database";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { IdempotencyService } from "../../common/idempotency.service";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { initializeStorage } from "../../providers/storage/storage.module";
import type { StorageRegistry } from "../../providers/storage/storage-registry";
import { RefreshService } from "../auth/refresh.service";
import { MediaReferenceService } from "./media-reference.service";
import { MediaService, safeOriginalName, type MediaUpload } from "./media.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
let directory: string;
let config: ConfigService;
let registry: StorageRegistry;
let jwt: JwtGuard;
let refresh: RefreshService;
let operations: IdempotencyService;
let service: MediaService;
let image: Buffer;
const repo = new MediaRepository(db);

/** Creates a user row and returns its verified principal. */
async function identity(role: "SUPERADMIN" | "CREATOR" = "CREATOR"): Promise<VerifiedPrincipal> {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "Creator",
    email: `${id}@example.org`,
    password_hash: "fixture",
    role,
    created_at: 1,
    updated_at: 1,
  });
  return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
}
/** A valid cover upload of the shared PNG fixture. */
function upload(bytes: Buffer = image, extra: Partial<MediaUpload> = {}): MediaUpload {
  return {
    bytes,
    originalName: "C:\\fakepath\\cat\u0007.png",
    declaredMime: "image/png",
    folder: "covers",
    accessibility: emptyAccessibility(),
    ...extra,
  };
}
/** All media rows, oldest first. */
function rows() {
  return db.getRepository<MediaRow>("media_assets").find({ order: { created_at: "ASC" } });
}
/** Receipt row for one upload key. */
function receipt(key: string) {
  return db.getRepository<OperationRow>("request_dedup").findOneByOrFail({ key });
}
/** True when a stored object exists under the local origin root. */
async function stored(key: string) {
  try {
    await access(join(config.values.LOCAL_STORAGE_PATH, key));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "kabuki-media-service-"));
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
  operations = new IdempotencyService(new OperationsRepository(db));
  service = new MediaService(
    repo,
    new SettingsRepository(db),
    registry,
    config,
    jwt,
    operations,
    new MediaReferenceService(repo),
    null,
  );
  image = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#c33" } })
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
    "question_options",
    "questions",
    "quizzes",
    "media_assets",
    "users",
  ])
    await db.manager.clear(table);
});

it("stores READY media once per key and lists only the owner's library", async () => {
  const owner = await identity(),
    other = await identity();
  const key = randomUUID();
  const created = await service.upload(owner, upload(), key);
  expect(created.httpStatus).toBe(201);
  expect(created.response).toMatchObject({
    uploaderId: owner.user.id,
    mimeType: "image/webp",
    width: 64,
    height: 32,
    revision: 2,
    inUse: false,
    canDelete: true,
    originalName: "cat.png",
  });
  expect(created.response.publicUrl).toBe(
    `${config.values.NEXT_PUBLIC_API_URL}/uploads/covers/${created.response.id}.webp`,
  );
  expect(await stored(`covers/${created.response.id}.webp`)).toBe(true);
  const replay = await service.upload(owner, upload(), key);
  expect(replay.response.id).toBe(created.response.id);
  expect(await rows()).toHaveLength(1);
  await expect(
    service.upload(owner, upload(Buffer.concat([image, Buffer.from([0])])), key),
  ).rejects.toMatchObject({ errorCode: "IDEMPOTENCY_CONFLICT" });
  expect((await service.list(owner, {})).items.map((m) => m.id)).toEqual([created.response.id]);
  expect((await service.list(other, {})).items).toEqual([]);
  await expect(service.read(other, created.response.id)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
  await expect(
    service.upload(owner, upload(image, { folder: "audio" }), randomUUID()),
  ).rejects.toMatchObject({ errorCode: "UNSUPPORTED_MEDIA" });
  await expect(
    service.upload(owner, upload(image, { folder: "nested/../x" }), randomUUID()),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  await expect(
    service.upload(owner, upload(image, { declaredMime: "image/svg+xml" }), randomUUID()),
  ).rejects.toMatchObject({ errorCode: "UNSUPPORTED_CONTENT_TYPE" });
  expect(await rows()).toHaveLength(1);
  expect(safeOriginalName("../../\u202Eevil\n.png")).toBe("evil.png");
  expect(safeOriginalName("\u0000")).toBe("upload");
});

it("compensates storage failures with a FAILED row and a 503 receipt", async () => {
  const owner = await identity();
  const adapter = registry.active;
  const key = randomUUID();
  const remove = jest.spyOn(adapter, "delete");
  jest.spyOn(adapter, "upload").mockRejectedValueOnce(new Error("disk full"));
  await expect(service.upload(owner, upload(), key)).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  const [failed] = await rows();
  expect(failed?.state).toBe("FAILED");
  expect(remove).toHaveBeenCalledWith(failed?.storage_key);
  expect(await receipt(key)).toMatchObject({ state: "DONE", http_status: 503 });
  await expect(service.upload(owner, upload(), key)).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  expect(await rows()).toHaveLength(1);

  jest.spyOn(adapter, "readHead").mockResolvedValueOnce({ exists: true, sizeBytes: 1 });
  await expect(service.upload(owner, upload(), randomUUID())).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  const mismatched = (await rows())[1];
  expect(mismatched?.state).toBe("FAILED");
  expect(await stored(mismatched?.storage_key ?? "")).toBe(false);

  jest.spyOn(adapter, "upload").mockRejectedValueOnce(new Error("offline"));
  remove.mockRejectedValueOnce(new Error("still offline"));
  await expect(service.upload(owner, upload(), randomUUID())).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  expect((await rows())[2]?.state).toBe("FAILED");

  const recovered = await service.upload(owner, upload(), randomUUID());
  expect(recovered.httpStatus).toBe(201);
  expect((await service.list(owner, {})).items.map((m) => m.id)).toEqual([recovered.response.id]);
});

it("reconciles a crash after the blob was stored without reporting success", async () => {
  const owner = await identity();
  const key = randomUUID();
  let release: (reason: Error) => void = () => undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    release = reject;
  });
  const complete = jest.spyOn(operations, "complete").mockImplementationOnce(() => hung);
  const first = service.upload(owner, upload(), key).then(
    () => "resolved",
    (error: unknown) => error,
  );
  for (let attempt = 0; attempt < 200 && complete.mock.calls.length === 0; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(complete).toHaveBeenCalledTimes(1);
  const [pending] = await rows();
  expect(pending?.state).toBe("UPLOADING");
  expect(await stored(pending?.storage_key ?? "")).toBe(true);
  expect(await receipt(key)).toMatchObject({ state: "PENDING" });
  await expect(service.upload(owner, upload(), key)).rejects.toMatchObject({
    errorCode: "OPERATION_PENDING",
  });

  const later = Date.now() + 121_000;
  const clock = jest.spyOn(Date, "now").mockReturnValue(later);
  await expect(service.upload(owner, upload(), key)).rejects.toMatchObject({
    errorCode: "STORAGE_UNAVAILABLE",
  });
  clock.mockRestore();
  const [reconciled] = await rows();
  expect(reconciled?.state).toBe("FAILED");
  expect(await stored(reconciled?.storage_key ?? "")).toBe(true);
  expect(await receipt(key)).toMatchObject({ state: "DONE", http_status: 503 });

  release(new Error("process died"));
  expect(await first).toBeInstanceOf(Error);
  const fresh = await service.upload(owner, upload(), randomUUID());
  expect(fresh.httpStatus).toBe(201);
});

it("guards accessibility metadata by owner and revision without foreign library access", async () => {
  const owner = await identity(),
    other = await identity(),
    admin = await identity("SUPERADMIN");
  const media = (await service.upload(owner, upload(), randomUUID())).response;
  const accessibility = { ...emptyAccessibility(), altText: "A red cat" };
  await expect(
    service.updateAccessibility(owner, media.id, 1, { accessibility }),
  ).rejects.toMatchObject({ errorCode: "REVISION_CONFLICT" });
  for (const outsider of [other, admin])
    await expect(
      service.updateAccessibility(outsider, media.id, media.revision, { accessibility }),
    ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  await expect(
    service.updateAccessibility(owner, media.id, media.revision, { accessibility: {} }),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  const updated = await service.updateAccessibility(owner, media.id, media.revision, {
    accessibility,
  });
  expect(updated).toMatchObject({ revision: media.revision + 1, accessibility });

  const quizzes = new QuizzesRepository(db);
  const quiz = await quizzes.create(
    owner.user.id,
    { title: "Public", coverMediaId: media.id, visibility: "PUBLIC" },
    Date.now(),
  );
  await quizzes.duplicate(other.user.id, quiz, Date.now());
  expect((await service.list(other, {})).items).toEqual([]);
  await expect(
    service.updateAccessibility(other, media.id, updated.revision, { accessibility }),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  const [own] = (await service.list(owner, { inUse: "true" })).items;
  expect(own).toMatchObject({ id: media.id, inUse: true, canDelete: false });
  expect((await service.list(owner, { inUse: "false" })).items).toEqual([]);
});

it("enforces the total media storage quota before any row, receipt or blob exists (TASK-188)", async () => {
  /** A service whose instance allows `quotaMib` MiB of stored media. */
  const withQuota = (quotaMib: string) =>
    new MediaService(
      repo,
      new SettingsRepository(db),
      registry,
      new ConfigService(
        parseEnvironment({
          NODE_ENV: "test",
          LOCAL_STORAGE_PATH: config.values.LOCAL_STORAGE_PATH,
          APP_SECRET_FILE: join(directory, "runtime-secrets.json"),
          MEDIA_STORAGE_QUOTA_MIB: quotaMib,
        }),
        {
          accessSecret: randomBytes(64).toString("hex"),
          refreshSecret: randomBytes(64).toString("hex"),
        },
      ),
      jwt,
      operations,
      new MediaReferenceService(repo),
      null,
    );
  const MIB = 1024 * 1024;
  const owner = await identity();
  const limited = withQuota("1");
  // Under the quota: accepted.
  const firstKey = randomUUID();
  const first = await limited.upload(owner, upload(), firstKey);
  expect(first.httpStatus).toBe(201);
  const size = first.response.sizeBytes;
  // Fill the budget to just under 1 MiB, so one more upload of the same size crosses it.
  await db.manager.update(
    "media_assets",
    { id: first.response.id },
    { size_bytes: MIB - size + 1 },
  );
  const key = randomUUID();
  const refused: unknown = await limited
    .upload(owner, upload(), key)
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ errorCode: "CAPACITY_REACHED" });
  expect((refused as { getStatus: () => number }).getStatus()).toBe(507);
  // Nothing was created for the refused upload: no row, no receipt, no blob.
  expect((await rows()).map((row) => row.id)).toEqual([first.response.id]);
  expect(await db.getRepository<OperationRow>("request_dedup").findOneBy({ key })).toBeNull();
  // A retry of the finished upload still replays, even with the quota full.
  expect((await limited.upload(owner, upload(), firstKey)).response.id).toBe(first.response.id);
  // Unlimited (0) accepts it; the default is the recommended 10 GiB.
  expect((await withQuota("0").upload(owner, upload(), randomUUID())).httpStatus).toBe(201);
  expect(config.values.MEDIA_STORAGE_QUOTA_MIB).toBe(10240);
  // Deleted and failed media free the space.
  await db.manager.delete("media_assets", { id: first.response.id });
  await db.manager.update("media_assets", { state: "READY" }, { state: "FAILED" });
  expect((await limited.upload(owner, upload(), key)).httpStatus).toBe(201);
  // The setting accepts only whole, non-negative MiB.
  for (const value of ["-1", "1.5", "lots"])
    expect(() => parseEnvironment({ NODE_ENV: "test", MEDIA_STORAGE_QUOTA_MIB: value })).toThrow();
});
