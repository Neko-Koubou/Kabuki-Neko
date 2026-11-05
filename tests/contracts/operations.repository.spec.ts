import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import {
  OperationsRepository,
  canonicalRequestHash,
  OPERATION_TIMING,
  type OperationRequest,
} from "../../packages/database/src/repositories/operations.repository";
import {
  AuditRepository,
  AUDIT_RETENTION_MS,
} from "../../packages/database/src/repositories/audit.repository";
import { createTestRuntime } from "../helpers/runtime";

it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s deduplicates atomically, reconciles leases and retains safe audit records",
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
        const ops = new OperationsRepository(db),
          audit = new AuditRepository(db),
          host = randomUUID(),
          resource = randomUUID();
        const request: OperationRequest = {
          actorScope: host,
          operation: "quiz.create",
          key: randomUUID(),
          request: { method: "POST", path: "/quizzes", body: { b: 2, a: 1 } },
        };
        expect(canonicalRequestHash({ b: 2, a: 1 })).toBe(canonicalRequestHash({ a: 1, b: 2 }));
        expect(canonicalRequestHash([1, 2])).not.toBe(canonicalRequestHash([2, 1]));
        expect(() => canonicalRequestHash({ missing: undefined })).toThrow("INVALID_FORMAT");
        let mutations = 0;
        const mutate = async () => {
          mutations++;
          return { httpStatus: 201, resourceId: resource, accessToken: "secret-never-store" };
        };
        const both = await Promise.all([ops.run(request, 0, mutate), ops.run(request, 0, mutate)]);
        expect(mutations).toBe(1);
        expect(both[0]?.id).toBe(both[1]?.id);
        expect(JSON.stringify(both)).not.toContain("secret-never-store");
        await expect(
          ops.run({ ...request, request: { different: true } }, 1, mutate),
        ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
        expect(await ops.lookup(randomUUID(), request.operation, request.key, 1)).toBeNull();
        expect(await ops.lookup(host, request.operation, request.key, 1)).toMatchObject({
          status: "done",
          resourceId: resource,
        });
        await ops.run({ ...request, actorScope: randomUUID() }, 1, mutate);
        expect(mutations).toBe(2);
        const failing = { ...request, key: randomUUID() };
        await expect(
          ops.run(failing, 1, async (m) => {
            await m.update("system_settings", "global", { instance_name: "rolled back" });
            await audit.append(
              {
                actorType: "USER",
                actorId: host,
                action: "quiz.create",
                resourceId: resource,
                outcome: "SUCCESS",
                correlationId: randomUUID(),
              },
              1,
              m,
            );
            throw new Error("injected failure");
          }),
        ).rejects.toThrow("injected failure");
        expect(await ops.lookup(host, failing.operation, failing.key, 1)).toBeNull();
        expect(await db.manager.count("audit_events")).toBe(0);
        expect(
          (
            await db.manager
              .getRepository<{ id: string; instance_name: string }>("system_settings")
              .findOneByOrFail({ id: "global" })
          ).instance_name,
        ).not.toBe("rolled back");
        await ops.run(failing, 2, mutate);
        const pendingRequest = {
          ...request,
          key: randomUUID(),
          operation: "media.upload" as const,
        };
        const pending = await ops.run(pendingRequest, 0, async (m) => {
          await m.update("system_settings", "global", { instance_name: "reservation" });
          return { pendingResourceId: resource };
        });
        expect(pending.lease_until).toBe(120000);
        await expect(ops.run(pendingRequest, 1, mutate)).rejects.toThrow("OPERATION_PENDING");
        expect(await ops.renew(pending.id, OPERATION_TIMING.renewalMs)).toBe(true);
        expect(await ops.renew(pending.id, 150000)).toBe(false);
        await expect(ops.complete(pending.id, 150000, mutate)).rejects.toThrow("OPERATION_PENDING");
        await expect(ops.run(pendingRequest, 150000, mutate)).rejects.toThrow("OPERATION_PENDING");
        const before = mutations;
        await expect(ops.run(pendingRequest, 150000, mutate, async () => null)).rejects.toThrow(
          "OPERATION_PENDING",
        );
        const recovered = await ops.run(pendingRequest, 150000, mutate, async (_m, row) => ({
          httpStatus: 201,
          resourceId: row.resource_id,
        }));
        expect(recovered.state).toBe("DONE");
        expect(mutations).toBe(before);
        await expect(ops.complete(pending.id, 150001, mutate)).rejects.toThrow("OPERATION_PENDING");
        const active = await ops.run({ ...pendingRequest, key: randomUUID() }, 0, async () => ({
          pendingResourceId: resource,
        }));
        await expect(
          ops.complete(active.id, 1, async (m) => {
            await m.update("system_settings", "global", { instance_name: "should rollback" });
            throw new Error("complete failed");
          }),
        ).rejects.toThrow("complete failed");
        expect(
          (
            await db.manager
              .getRepository<{ id: string; instance_name: string }>("system_settings")
              .findOneByOrFail({ id: "global" })
          ).instance_name,
        ).toBe("reservation");
        expect((await ops.complete(active.id, 2, mutate)).state).toBe("DONE");
        const unresolved = await ops.run({ ...pendingRequest, key: randomUUID() }, 0, async () => ({
          pendingResourceId: resource,
        }));
        expect(await ops.purge(OPERATION_TIMING.retentionMs + 3)).toBe(5);
        expect(await db.manager.existsBy("request_dedup", { id: unresolved.id })).toBe(true);
        expect(
          await ops.lookup(host, request.operation, request.key, OPERATION_TIMING.retentionMs),
        ).toBeNull();
        const event = {
          actorType: "USER" as const,
          actorId: host,
          action: "room.release.lost",
          resourceId: resource,
          outcome: "SUCCESS" as const,
          correlationId: randomUUID(),
          payload: { password: "secret-never-store" },
          ip: "192.0.2.1",
        };
        await audit.append(event, 10);
        expect(await audit.loss(host, resource, 11)).toMatchObject({
          occurred_at: 10,
          correlation_id: event.correlationId,
        });
        expect(await audit.loss(randomUUID(), resource, 11)).toBeNull();
        expect(await audit.loss(host, randomUUID(), 11)).toBeNull();
        expect(await audit.loss(host, resource, AUDIT_RETENTION_MS + 10)).toBeNull();
        const persisted = JSON.stringify(await db.manager.find("audit_events"));
        expect(persisted).not.toContain("secret-never-store");
        expect(persisted).not.toContain("192.0.2.1");
        // Large fixture verifies a bounded purge, including stable ordering at equal timestamps.
        for (let offset = 0; offset < 1000; offset += 100) {
          await db.manager.insert(
            "audit_events",
            Array.from({ length: 100 }, () => ({
              id: randomUUID(),
              occurred_at: 10,
              actor_type: "SYSTEM",
              actor_id: null,
              action: "cleanup",
              resource_id: null,
              outcome: "SUCCESS",
              correlation_id: randomUUID(),
              error_code: null,
            })),
          );
        }
        await audit.append(event, AUDIT_RETENTION_MS + 10);
        expect(await audit.purge(AUDIT_RETENTION_MS + 10)).toBe(1000);
        expect(await audit.purge(AUDIT_RETENTION_MS + 10)).toBe(1);
        expect(await audit.purge(AUDIT_RETENTION_MS + 10)).toBe(0);
        expect(await db.manager.count("audit_events")).toBe(1);
      } finally {
        await db.destroy();
      }
    } finally {
      await rt.cleanup();
    }
  },
);
