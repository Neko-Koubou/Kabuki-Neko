import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { QuizzesRepository } from "../../packages/database/src/repositories/quizzes.repository";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s protects quiz ownership, revision, reorder and media references",
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
        const repo = new QuizzesRepository(db),
          owner = randomUUID(),
          guest = randomUUID();
        for (const user of [owner, guest])
          await db.manager.insert("users", {
            id: user,
            email: user + "@test.com",
            password_hash: "test",
            name: "Test",
            created_at: 0,
            updated_at: 0,
          });
        const media = [];
        for (let i = 0; i < 2; i++) {
          const id = randomUUID();
          media.push(id);
          await db.manager.insert("media_assets", {
            id,
            uploader_id: owner,
            storage_driver: "local",
            storage_location_id: "active",
            storage_key: id,
            public_url: "/uploads/" + id + ".webp",
            original_name: "quiz.webp",
            mime_type: "image/webp",
            size_bytes: 1,
            state: "READY",
            created_at: 0,
            updated_at: 0,
          });
        }
        const id = await repo.create(
          owner,
          { title: "quiz%_", visibility: "PUBLIC", coverMediaId: media[0] },
          0,
        );
        const source = await repo.read(guest, id);
        expect(source.capabilities.canEdit).toBe(false);
        expect(source.content.questions[0]?.options).toHaveLength(2);
        expect((await repo.list(guest, { scope: "public", search: "%_" })).items).toHaveLength(1);
        await expect(repo.save(guest, id, 1, source.content, 1)).rejects.toThrow("FORBIDDEN");
        const copy = await repo.duplicate(guest, id, 1),
          snapshot = await repo.read(guest, copy);
        expect(snapshot.content.visibility).toBe("PRIVATE");
        expect(snapshot.content.coverMediaId).toBe(media[0]);
        expect(snapshot.content.questions[0]?.id).not.toBe(source.content.questions[0]?.id);
        await expect(repo.read(owner, copy)).rejects.toThrow("NOT_FOUND");
        await expect(
          repo.save(guest, copy, 1, { ...snapshot.content, coverMediaId: media[1] }, 2),
        ).rejects.toThrow("INVALID_REFERENCE");
        await expect(repo.save(guest, copy, 1, source.content, 2)).rejects.toThrow(
          "INVALID_REFERENCE",
        );
        const edits = await Promise.allSettled([
          repo.save(guest, copy, 1, snapshot.content, 2),
          repo.save(guest, copy, 1, snapshot.content, 3),
        ]);
        expect(edits.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        expect(edits.find((x) => x.status === "rejected")?.reason.message).toBe(
          "REVISION_CONFLICT",
        );
        const observer = {
          beforeInsert(event: { metadata: { tableName: string } }) {
            if (event.metadata.tableName === "question_options")
              throw new Error("rollback fixture");
          },
        };
        db.subscribers.push(observer);
        try {
          await expect(
            repo.save(guest, copy, 2, { ...snapshot.content, title: "should roll back" }, 4),
          ).rejects.toThrow("rollback fixture");
        } finally {
          db.subscribers.splice(db.subscribers.indexOf(observer), 1);
        }
        const restored = await repo.read(guest, copy);
        expect(restored.content).toEqual(snapshot.content);
        expect(restored.row.revision).toBe(2);
        await repo.delete(owner, id, 1);
        expect((await repo.read(guest, copy)).content.coverMediaId).toBe(media[0]);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
