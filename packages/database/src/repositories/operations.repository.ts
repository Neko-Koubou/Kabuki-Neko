import { createHash, randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { writeTransaction } from "../data-source.factory";
import { lockSettings } from "./settings.repository";

export const OPERATION_TIMING = { leaseMs: 120000, renewalMs: 30000, retentionMs: 86400000 };
const operations = [
  "auth.setup",
  "auth.register",
  "invitation.create",
  "quiz.create",
  "quiz.duplicate",
  "quiz.import",
  "media.upload",
  "cleanup",
  "report.retry",
  "room.create",
] as const;
export interface OperationRequest {
  actorScope: string;
  operation: (typeof operations)[number];
  key: string;
  /** Canonical method/path/query/body, including file SHA256 for multipart. */
  request: unknown;
}
export interface OperationResult {
  httpStatus: number;
  resourceId: string | null;
}
export interface OperationRow {
  id: string;
  actor_scope: string;
  operation: string;
  key: string;
  request_hash: string;
  state: "PENDING" | "DONE";
  http_status: number | null;
  response_json: { resourceId: string | null } | null;
  resource_id: string | null;
  created_at: number;
  expires_at: number;
  lease_until: number | null;
}
export function canonicalRequestHash(input: unknown): string {
  function canonical(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${Array.from(value, canonical).join(",")}]`;
    if (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    )
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    throw new Error("INVALID_FORMAT");
  }
  return createHash("sha256").update(canonical(input)).digest("hex");
}
function receipt(result: OperationResult) {
  if (
    !Number.isInteger(result.httpStatus) ||
    result.httpStatus < 200 ||
    result.httpStatus > 599 ||
    (result.resourceId !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(result.resourceId))
  )
    throw new Error("INVALID_FORMAT");
  // Persist only a resource receipt. Services reconstruct and authorize response DTOs on replay.
  return {
    state: "DONE" as const,
    http_status: result.httpStatus,
    resource_id: result.resourceId,
    response_json: { resourceId: result.resourceId },
    lease_until: null,
  };
}
export class OperationsRepository {
  constructor(private readonly db: DataSource) {}
  private async existing(m: EntityManager, input: OperationRequest, now: number) {
    if (
      !operations.includes(input.operation) ||
      !/^[a-zA-Z0-9:_-]{1,80}$/.test(input.actorScope) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.key)
    )
      throw new Error("INVALID_FORMAT");
    await lockSettings(m);
    const repo = m.getRepository<OperationRow>("request_dedup");
    const row = await repo.findOneBy({
      actor_scope: input.actorScope,
      operation: input.operation,
      key: input.key,
    });
    // Unresolved pending work survives retention until its resource is reconciled.
    if (row?.state === "DONE" && row.expires_at <= now) {
      await repo.delete(row.id);
      return null;
    }
    if (row && row.request_hash !== canonicalRequestHash(input.request))
      throw new Error("IDEMPOTENCY_CONFLICT");
    return row;
  }
  /** Callback is SQL-only and uses this manager, so reservation/mutation and dedup commit together. */
  run(
    input: OperationRequest,
    now: number,
    mutate: (m: EntityManager) => Promise<OperationResult | { pendingResourceId: string }>,
    reconcile?: (m: EntityManager, row: Readonly<OperationRow>) => Promise<OperationResult | null>,
  ) {
    return writeTransaction(this.db, async (m) => {
      const old = await this.existing(m, input, now);
      if (old?.state === "DONE") return old;
      if (old) {
        if ((old.lease_until ?? 0) > now || !reconcile) throw new Error("OPERATION_PENDING");
        const result = await reconcile(m, old);
        if (!result) throw new Error("OPERATION_PENDING");
        const done = { ...old, ...receipt(result) };
        await m.update("request_dedup", old.id, receipt(result));
        return done;
      }
      const row: OperationRow = {
        id: randomUUID(),
        actor_scope: input.actorScope,
        operation: input.operation,
        key: input.key,
        request_hash: canonicalRequestHash(input.request),
        state: "PENDING",
        http_status: null,
        response_json: null,
        resource_id: null,
        created_at: now,
        expires_at: now + OPERATION_TIMING.retentionMs,
        lease_until: now + OPERATION_TIMING.leaseMs,
      };
      await m.insert("request_dedup", row);
      const result = await mutate(m);
      if ("pendingResourceId" in result) {
        receipt({ httpStatus: 200, resourceId: result.pendingResourceId });
        row.resource_id = result.pendingResourceId;
      } else Object.assign(row, receipt(result));
      await m.getRepository<OperationRow>("request_dedup").save(row);
      return row;
    });
  }
  complete(id: string, now: number, mutate: (m: EntityManager) => Promise<OperationResult>) {
    return writeTransaction(this.db, async (m) => {
      await lockSettings(m);
      const row = await m.getRepository<OperationRow>("request_dedup").findOneBy({ id });
      if (!row || row.state !== "PENDING" || (row.lease_until ?? 0) <= now)
        throw new Error("OPERATION_PENDING");
      const fields = receipt(await mutate(m));
      await m.update("request_dedup", id, fields);
      return { ...row, ...fields };
    });
  }
  renew(id: string, now: number) {
    return writeTransaction(this.db, async (m) => {
      await lockSettings(m);
      const result = await m
        .createQueryBuilder()
        .update("request_dedup")
        .set({ lease_until: now + OPERATION_TIMING.leaseMs })
        .where("id=:id AND state='PENDING' AND lease_until>:now", { id, now })
        .execute();
      return result.affected === 1;
    });
  }
  async lookup(
    actorScope: string,
    operation: OperationRequest["operation"],
    key: string,
    now: number,
  ) {
    const row = await this.db
      .getRepository<OperationRow>("request_dedup")
      .findOneBy({ actor_scope: actorScope, operation, key });
    if (!row || (row.state === "DONE" && row.expires_at <= now)) return null;
    return {
      key: row.key,
      operation: row.operation,
      status: row.state === "DONE" ? "done" : "pending",
      resourceId: row.resource_id,
    };
  }
  purge(now: number) {
    return writeTransaction(this.db, async (m) => {
      await lockSettings(m);
      const rows = await m
        .getRepository<OperationRow>("request_dedup")
        .createQueryBuilder("d")
        .where("d.state='DONE' AND d.expires_at<=:now", { now })
        .orderBy("d.expires_at")
        .addOrderBy("d.id")
        .take(1000)
        .getMany();
      for (const row of rows) await m.delete("request_dedup", row.id);
      return rows.length;
    });
  }
}
