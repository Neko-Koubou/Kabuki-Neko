import { randomUUID } from "node:crypto";
import { emptyAccessibility } from "../../packages/shared/src/schemas/media.schema";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { MediaRepository } from "../../packages/database/src/repositories/media.repository";
import { QuizzesRepository } from "../../packages/database/src/repositories/quizzes.repository";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s serializes attachment/delete and preserves original storage location on compensation",
  async (driver) => {
    const rt = await createTestRuntime();
    try {
      const url =
        driver === "sqlite"
          ? undefined
          : (await (driver === "mysql" ? rt.mysql() : rt.postgres())).getConnectionUri();
      const db = createDataSource(
        { driver, sqlitePath: rt.env.SQLITE_PATH ?? ":memory:", ...(url ? { url } : {}) },
        domainSchemas(driver),
      );
      await db.initialize();
      try {
        await migrateDatabase(db, true);
        const owner = randomUUID(),
          repo = new MediaRepository(db),
          quizzes = new QuizzesRepository(db);
        await db.manager.insert("users", {
          id: owner,
          email: "media@example.org",
          password_hash: "fixture",
          name: "Test",
          created_at: 0,
          updated_at: 0,
        });
        const reserve = () => {
          const id = randomUUID();
          return repo.reserve(
            {
              id,
              uploader_id: owner,
              storage_driver: "s3",
              storage_location_id: "old-origin",
              storage_key: id,
              public_url: "/uploads/" + id + ".webp",
              original_name: "猫.webp",
              mime_type: "image/webp",
              accessibility: emptyAccessibility(),
            },
            0,
          );
        };
        const a = await reserve(),
          info = { size_bytes: 123, width: 10, height: 10, duration_ms: null };
        await expect(repo.claimDelete(a.id, owner, 1, 1)).rejects.toThrow("RESOURCE_BUSY");
        await expect(repo.finishUpload(a.id, 99, info, 1)).rejects.toThrow("REVISION_CONFLICT");
        await expect(repo.finishUpload(a.id, 1, { ...info, width: -1 }, 1)).rejects.toThrow();
        const ready = await repo.finishUpload(a.id, 1, info, 2);
        expect(ready.revision).toBe(2);
        expect(await repo.readyMetrics()).toEqual({ fileCount: 1, totalBytes: 123 });
        const settled = await Promise.allSettled([
          quizzes.create(owner, { title: "Covered", coverMediaId: a.id }, 3),
          repo.claimDelete(a.id, owner, 2, 3),
        ]);
        expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        const [attach, del] = settled;
        if (attach.status === "fulfilled") {
          await expect(repo.claimDelete(a.id, owner, 2, 4)).rejects.toThrow("MEDIA_IN_USE");
          await quizzes.delete(owner, attach.value, 1);
        } else if (del.status === "fulfilled") {
          expect(del.value.asset.storage_location_id).toBe("old-origin");
          await repo.settleDelete(del.value, false, 4);
        }
        const staged = await reserve();
        const { claims } = await repo.claimCleanup(5);
        expect(claims).toHaveLength(1);
        const claim = claims[0];
        if (!claim) throw new Error("Expected orphan");
        expect(claim.asset.id).toBe(a.id);
        expect(claim.asset.storage_key).toBe(a.storage_key);
        await repo.settleDelete(claim, false, 6);
        expect(await repo.readyMetrics()).toEqual({ fileCount: 1, totalBytes: 123 });
        await expect(repo.settleDelete(claim, true, 7)).rejects.toThrow("REVISION_CONFLICT");
        const failed = await repo.finishUpload(staged.id, 1, null, 7);
        const final = await repo.claimDelete(staged.id, owner, failed.revision, 8);
        await repo.settleDelete(final, true, 9);
        expect(await db.manager.existsBy("media_assets", { id: staged.id })).toBe(false);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
