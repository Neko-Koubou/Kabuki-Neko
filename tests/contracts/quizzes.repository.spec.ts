import { randomUUID } from "node:crypto";
import {
  OperationsRepository,
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
        const operations = new OperationsRepository(db);
        const request = {
          actorScope: owner,
          operation: "quiz.create" as const,
          key: randomUUID(),
          request: {},
        };
        await expect(
          operations.run(request, 1, async (manager) => {
            const created = await repo.create(owner, { title: "Rollback" }, 1, manager);
            expect((await repo.read(owner, created, manager)).creatorName).toBe("Test");
            throw new Error("CREATE-ROLLBACK");
          }),
        ).rejects.toThrow("CREATE-ROLLBACK");
        expect(await db.manager.count("quizzes")).toBe(1);
        expect(await db.manager.count("request_dedup")).toBe(0);
        await expect(
          operations.run(
            { ...request, operation: "quiz.duplicate", key: randomUUID() },
            1,
            async (manager) => {
              await repo.duplicate(guest, id, 1, manager);
              throw new Error("DUPLICATE-ROLLBACK");
            },
          ),
        ).rejects.toThrow("DUPLICATE-ROLLBACK");
        expect(await db.manager.count("quizzes")).toBe(1);
        expect(await db.manager.count("request_dedup")).toBe(0);
        expect(() => repo.read(owner, id, db.manager)).toThrow("INVALID_REFERENCE");
        const source = await repo.read(guest, id);
        expect(source.creatorName).toBe("Test");
        expect(source.media.map((asset) => asset.id)).toEqual([media[0]]);
        expect(source.capabilities.canEdit).toBe(false);
        expect(source.content.questions[0]?.options).toHaveLength(2);
        expect((await repo.list(guest, { scope: "public", search: "%_" })).items).toHaveLength(1);
        await expect(repo.save(guest, id, 1, source.content, 1)).rejects.toThrow("FORBIDDEN");
        expect(() => repo.importDraft(owner, source.content, 1, db.manager)).toThrow(
          "INVALID_REFERENCE",
        );
        await expect(
          operations.run({ ...request, operation: "quiz.import" }, 1, async (manager) => {
            await repo.importDraft(guest, source.content, 1, manager);
            throw new Error("Unexpected import");
          }),
        ).rejects.toThrow("INVALID_REFERENCE");
        await expect(
          operations.run({ ...request, operation: "quiz.import" }, 1, async (manager) => {
            const importedId = await repo.importDraft(owner, source.content, 1, manager);
            const imported = await repo.read(owner, importedId, manager);
            expect(imported.content.visibility).toBe("PRIVATE");
            expect(imported.content.questions[0]?.id).not.toBe(source.content.questions[0]?.id);
            expect(imported.content.questions[0]?.options[0]?.id).not.toBe(
              source.content.questions[0]?.options[0]?.id,
            );
            throw new Error("IMPORT-ROLLBACK");
          }),
        ).rejects.toThrow("IMPORT-ROLLBACK");
        expect(await db.manager.count("quizzes")).toBe(1);
        expect(await db.manager.count("questions")).toBe(1);
        expect(await db.manager.count("question_options")).toBe(2);
        expect(await db.manager.count("request_dedup")).toBe(0);
        const receipt = await operations.run(
          { ...request, operation: "quiz.import" },
          1,
          async (manager) => ({
            resourceId: await repo.importDraft(owner, source.content, 1, manager),
            httpStatus: 201,
          }),
        );
        expect(receipt.resource_id).toBeTruthy();
        expect(await db.manager.count("quizzes")).toBe(2);
        expect(await db.manager.count("request_dedup")).toBe(1);
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

/**
 * Code review MJ-08: plain reads take no row lock, so a viewer never waits for (or blocks) the
 * owner's save, and list pages batch-read their quizzes, skipping rows that are gone or hidden.
 */
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s reads quizzes without row locks and batch-reads list pages",
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
        for (const [user, name] of [
          [owner, "Owner"],
          [guest, "Guest"],
        ] as const)
          await db.manager.insert("users", {
            id: user,
            email: user + "@test.com",
            password_hash: "test",
            name,
            created_at: 0,
            updated_at: 0,
          });
        const shared = await repo.create(owner, { title: "Shared", visibility: "PUBLIC" }, 0);
        const hidden = await repo.create(owner, { title: "Hidden", visibility: "PRIVATE" }, 0);
        const mine = await repo.create(guest, { title: "Mine", visibility: "PRIVATE" }, 0);

        const page = await repo.readMany(guest, [shared, hidden, randomUUID(), mine, shared]);
        expect([...page.keys()].sort()).toEqual([shared, mine].sort());
        expect(page.get(shared)).toMatchObject({
          creatorName: "Owner",
          content: { title: "Shared", questions: [expect.anything()] },
          capabilities: { canEdit: false },
        });
        expect(page.get(mine)?.capabilities.canEdit).toBe(true);
        expect((await repo.readMany(guest, [])).size).toBe(0);

        if (driver !== "sqlite") {
          // The owner's save holds the row's write lock; a viewer's read must not wait for it.
          const runner = db.createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          try {
            await runner.manager
              .getRepository("quizzes")
              .createQueryBuilder("q")
              .where("q.id=:id", { id: shared })
              .setLock("pessimistic_write")
              .getOne();
            const outcome = await Promise.race([
              repo.read(guest, shared).then((read) => read.row.title),
              new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
            ]);
            expect(outcome).toBe("Shared");
          } finally {
            await runner.rollbackTransaction();
            await runner.release();
          }
        }
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
