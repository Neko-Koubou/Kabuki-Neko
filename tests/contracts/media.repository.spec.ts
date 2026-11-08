import { randomUUID } from "node:crypto";
import { emptyAccessibility } from "../../packages/shared/src/schemas/media.schema";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  writeTransaction,
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

/**
 * TASK-067A: operation-transaction composition, owner library paging/filters, accessibility
 * revisions and janitor selection behave identically on all three dialects.
 */
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s composes uploads with operation transactions and serves the owner library",
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
        const repo = new MediaRepository(db),
          quizzes = new QuizzesRepository(db);
        const owner = randomUUID(),
          other = randomUUID();
        for (const [id, email] of [
          [owner, "owner@example.org"],
          [other, "other@example.org"],
        ] as const)
          await db.manager.insert("users", {
            id,
            email,
            password_hash: "fixture",
            name: "Test",
            created_at: 0,
            updated_at: 0,
          });
        const reservation = (uploader: string, name: string, mime: string) => {
          const id = randomUUID();
          return {
            id,
            uploader_id: uploader,
            storage_driver: "local" as const,
            storage_location_id: "default",
            storage_key: `questions/${id}.bin`,
            public_url: `/uploads/questions/${id}.bin`,
            original_name: name,
            mime_type: mime,
            accessibility: emptyAccessibility(),
          };
        };
        const info = { size_bytes: 10, width: null, height: null, duration_ms: null };
        const ready = async (uploader: string, name: string, mime: string, at: number) => {
          const row = await repo.reserve(reservation(uploader, name, mime), at);
          return repo.finishUpload(row.id, row.revision, info, at);
        };

        // Composition: reserve inside a caller transaction that rolls back leaves nothing behind.
        const rolled = reservation(owner, "rolled.png", "image/webp");
        await expect(
          writeTransaction(db, async (m) => {
            await repo.reserve(rolled, 1, m);
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(await repo.find(rolled.id)).toBeNull();
        await expect(
          repo.reserve(reservation(owner, "x", "image/webp"), 1, db.manager),
        ).rejects.toThrow("INVALID_REFERENCE");
        const composed = await writeTransaction(db, async (m) => {
          const row = await repo.reserve(reservation(owner, "composed.webp", "image/webp"), 2, m);
          return repo.finishUpload(row.id, row.revision, info, 3, m);
        });
        expect(composed).toMatchObject({ state: "READY", revision: 2 });

        // Library: literal search, type, inUse filters and paging over the owner's READY rows.
        const percent = await ready(owner, "100%_off!.webp", "image/webp", 10);
        const plain = await ready(owner, "cat.webp", "image/webp", 11);
        const song = await ready(owner, "song.mp3", "audio/mpeg", 12);
        await ready(other, "100% foreign.webp", "image/webp", 13);
        const pending = await repo.reserve(reservation(owner, "pending.webp", "image/webp"), 14);
        const page = (query: Partial<Parameters<MediaRepository["listOwned"]>[1]>) =>
          repo.listOwned(owner, { page: 1, limit: 24, search: "", ...query });
        expect((await page({})).meta.total).toBe(4);
        expect((await page({ search: "%" })).items.map((m) => m.id)).toEqual([percent.id]);
        expect((await page({ search: "_off!" })).items.map((m) => m.id)).toEqual([percent.id]);
        expect((await page({ search: "a_" })).items).toHaveLength(0);
        expect((await page({ type: "audio" })).items.map((m) => m.id)).toEqual([song.id]);
        const second = await page({ limit: 1, page: 2 });
        expect(second.items.map((m) => m.id)).toEqual([plain.id]);
        expect(second.meta).toEqual({ page: 2, limit: 1, total: 4, totalPages: 4 });
        await quizzes.create(owner, { title: "Uses cat", coverMediaId: plain.id }, 20);
        expect((await page({ inUse: true })).items.map((m) => [m.id, m.in_use])).toEqual([
          [plain.id, true],
        ]);
        expect((await page({ inUse: false })).items.every((m) => !m.in_use)).toBe(true);
        expect(await repo.referenced([plain.id, song.id, randomUUID()])).toEqual(
          new Set([plain.id]),
        );

        // Accessibility: owner + revision + READY only.
        const alt = { ...emptyAccessibility(), altText: "A cat" };
        await expect(repo.updateAccessibility(song.id, owner, 99, alt, 30)).rejects.toThrow(
          "REVISION_CONFLICT",
        );
        await expect(
          repo.updateAccessibility(song.id, other, song.revision, alt, 30),
        ).rejects.toThrow("NOT_FOUND");
        await expect(
          repo.updateAccessibility(pending.id, owner, pending.revision, alt, 30),
        ).rejects.toThrow("NOT_FOUND");
        const updated = await repo.updateAccessibility(song.id, owner, song.revision, alt, 30);
        expect(updated.revision).toBe(song.revision + 1);
        expect((await repo.find(song.id))?.accessibility).toEqual(alt);

        // Janitor selection: interrupted uploads fail, crashed deletions are listed.
        const stale = await repo.reserve(reservation(owner, "stale.webp", "image/webp"), 15);
        expect(await repo.failStaleUploads(15, 40)).toBe(1);
        expect((await repo.find(pending.id))?.state).toBe("FAILED");
        expect((await repo.find(stale.id))?.state).toBe("UPLOADING");
        expect((await repo.failUpload(stale.id, 41))?.state).toBe("FAILED");
        expect((await repo.failUpload(song.id, 41))?.state).toBe("READY");
        const claim = await repo.claimDelete(percent.id, owner, percent.revision, 50);
        expect((await repo.staleDeletions(50)).map((m) => m.id)).toEqual([]);
        expect((await repo.staleDeletions(51)).map((m) => m.id)).toEqual([claim.asset.id]);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
