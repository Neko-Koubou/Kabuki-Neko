import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { JobsRepository } from "../../packages/database/src/repositories/jobs.repository";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s fences expired workers and keeps a single immutable finalization payload",
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
        const session = randomUUID(),
          host = randomUUID(),
          jobs = new JobsRepository(db);
        await db.manager.insert("users", {
          id: host,
          email: "jobs@example.org",
          password_hash: "fixture",
          name: "Host",
          created_at: 0,
          updated_at: 0,
        });
        await db.manager.insert("room_allocations", {
          id: session,
          pin_code: "000001",
          host_id: host,
          quiz_revision: 1,
          creation_snapshot: {},
          state_driver: "memory",
          state_namespace: "test",
          status: "FINALIZING",
          created_at: 0,
          expires_at: 100000,
          last_heartbeat_at: 0,
        });
        const original = await jobs.enqueue(session, host, { b: 1, a: 2 }, 0);
        expect((await jobs.enqueue(session, host, { a: 2, b: 1 }, 1)).payload_hash).toBe(
          original.payload_hash,
        );
        await expect(jobs.enqueue(session, host, { a: 3 }, 1)).rejects.toThrow("hash mismatch");
        const claims = await Promise.all([jobs.claim(1), jobs.claim(1)]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const first = claims.find((x) => x !== null);
        if (!first?.lease_owner) throw new Error("Missing claim");
        expect(await jobs.renew(session, first.lease_owner, 10001)).toBe(true);
        expect(await jobs.claim(40000)).toBeNull();
        const replacement = await jobs.claim(40001);
        if (!replacement?.lease_owner) throw new Error("Missing replacement");
        expect(replacement.lease_owner).not.toBe(first.lease_owner);
        await expect(
          jobs.fail(session, first.lease_owner, "REPORT_SAVE_FAILED", 40002),
        ).rejects.toThrow("RESOURCE_BUSY");
        await jobs.fail(session, replacement.lease_owner, "REPORT_SAVE_FAILED", 40002);
        expect(await jobs.claim(41001)).toBeNull();
        expect(await jobs.manualRetry(session, randomUUID(), 40003)).toBe(false);
        expect(await jobs.manualRetry(session, host, 40003)).toBe(true);
        expect((await jobs.claim(40003))?.attempts).toBe(0);
        expect(await db.manager.existsBy("room_allocations", { id: session })).toBe(true);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
