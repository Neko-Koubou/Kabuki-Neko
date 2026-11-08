import { randomUUID } from "node:crypto";
import { emptyAccessibility } from "../../packages/shared/src/schemas/media.schema";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { RuntimeRepository } from "../../packages/database/src/repositories/runtime.repository";
import { MediaRepository } from "../../packages/database/src/repositories/media.repository";
import { QuizzesRepository } from "../../packages/database/src/repositories/quizzes.repository";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s serializes PIN/capacity, pins media and compares generations before release",
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
        const hostId = randomUUID(),
          assetId = randomUUID();
        await db.manager.insert("users", {
          id: hostId,
          email: "host@example.org",
          password_hash: "fixture",
          name: "Host",
          created_at: 0,
          updated_at: 0,
        });
        const media = new MediaRepository(db);
        await media.reserve(
          {
            id: assetId,
            uploader_id: hostId,
            original_name: "猫.webp",
            public_url: "/uploads/test.webp",
            storage_driver: "local",
            storage_location_id: "active",
            storage_key: assetId,
            mime_type: "image/webp",
            accessibility: emptyAccessibility(),
          },
          0,
        );
        await media.finishUpload(
          assetId,
          1,
          { size_bytes: 10, width: 2, height: 2, duration_ms: null },
          1,
        );
        const quizId = await new QuizzesRepository(db).create(hostId, { title: "Quiz" }, 1);
        const input = {
          hostId,
          quizId,
          quizRevision: 1,
          requestId: randomUUID(),
          requestHash: "a".repeat(64),
          driver: "memory" as const,
          namespace: "default",
          capacity: 1,
          now: 2,
          expiresAt: 9000,
        };
        const snapshot = async () => ({ snapshot: { version: 1 }, mediaIds: [assetId, assetId] });
        const repo = new RuntimeRepository(db, () => "000001");
        const requests = [input, { ...input, requestId: randomUUID() }];
        const results = await Promise.allSettled(requests.map((x) => repo.reserve(x, snapshot)));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const winning = results.findIndex((r) => r.status === "fulfilled");
        const winner = requests[winning];
        if (!winner) throw new Error("Expected one successful reservation");
        const first = await repo.reserve(winner, snapshot);
        expect(results.find((r) => r.status === "rejected")?.reason.message).toBe(
          "CAPACITY_REACHED",
        );
        await expect(
          repo.reserve({ ...input, requestId: randomUUID(), capacity: 2 }, snapshot),
        ).rejects.toThrow("PIN_EXHAUSTED");
        await expect(media.claimDelete(assetId, hostId, 2, 3)).rejects.toThrow("MEDIA_IN_USE");
        expect(await repo.release(first.id, first.pin_code, 3)).toBe(true);
        const replacement = await repo.reserve({ ...input, requestId: randomUUID() }, snapshot);
        expect(replacement.id).not.toBe(first.id);
        // TASK-078A: crashed CREATING rows are discoverable by age and readable by session ID.
        expect((await repo.find(replacement.id))?.status).toBe("CREATING");
        expect(await repo.find(randomUUID())).toBeNull();
        expect(await repo.staleCreating(2)).toEqual([]);
        expect((await repo.staleCreating(3)).map((row) => row.id)).toEqual([replacement.id]);
        expect((await repo.staleCreating(3)).map((row) => row.creation_snapshot)).toEqual([
          { version: 1 },
        ]);
        expect(await repo.release(first.id, first.pin_code, 4)).toBe(false);
        await repo.activate(replacement.id, 5);
        expect(await repo.staleCreating(1_000_000)).toEqual([]);
        // TASK-079A: live PIN lookup and keyset-paged active scan.
        expect((await repo.findByPin(replacement.pin_code))?.id).toBe(replacement.id);
        expect(await repo.findByPin("999999")).toBeNull();
        expect(await repo.findByPin("not-a-pin")).toBeNull();
        expect((await repo.active()).map((row) => row.id)).toEqual([replacement.id]);
        expect(await repo.active(replacement.id)).toEqual([]);
        expect(await repo.heartbeat(replacement.id, 6)).toBe(true);
        expect(await repo.transition(replacement.id, "ACTIVE", "LOST", 7)).toBe(true);
        expect(await repo.active()).toEqual([]);
        expect(await repo.release(replacement.id, replacement.pin_code, 8)).toBe(false);
        expect(await repo.release(replacement.id, replacement.pin_code, 3600007)).toBe(true);
        expect((await media.claimDelete(assetId, hostId, 2, 3600008)).asset.state).toBe("DELETING");
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
