import { randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { writeTransaction } from "../data-source.factory";

export const AUDIT_RETENTION_MS = 30 * 86400000;
export interface AuditEvent {
  actorType: "USER" | "GUEST" | "SYSTEM" | "ANONYMOUS";
  actorId: string | null;
  action: string;
  resourceId: string | null;
  outcome: "SUCCESS" | "DENIED" | "FAILURE";
  correlationId: string;
  errorCode?: string | null;
}
interface AuditRow {
  id: string;
  occurred_at: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_id: string | null;
  outcome: string;
  correlation_id: string;
  error_code: string | null;
}
export class AuditRepository {
  constructor(private readonly db: DataSource) {}
  /** Explicit field projection excludes free payloads, headers, names, IPs and credentials. */
  async append(event: AuditEvent, now: number, manager: EntityManager = this.db.manager) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !uuid.test(event.correlationId) ||
      (event.actorId !== null && !uuid.test(event.actorId)) ||
      (event.resourceId !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(event.resourceId)) ||
      !/^[a-z][a-z0-9_.-]{0,79}$/.test(event.action) ||
      (event.errorCode != null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.errorCode)) ||
      !["USER", "GUEST", "SYSTEM", "ANONYMOUS"].includes(event.actorType) ||
      !["SUCCESS", "DENIED", "FAILURE"].includes(event.outcome)
    )
      throw new Error("INVALID_FORMAT");
    const row: AuditRow = {
      id: randomUUID(),
      occurred_at: now,
      actor_type: event.actorType,
      actor_id: event.actorId,
      action: event.action,
      resource_id: event.resourceId,
      outcome: event.outcome,
      correlation_id: event.correlationId,
      error_code: event.errorCode ?? null,
    };
    await manager.insert("audit_events", row);
    return row;
  }
  loss(hostId: string, sessionId: string, now: number) {
    return this.db
      .getRepository<AuditRow>("audit_events")
      .createQueryBuilder("a")
      .where("a.actor_id=:hostId AND a.resource_id=:sessionId AND a.action=:action", {
        hostId,
        sessionId,
        action: "room.release.lost",
      })
      .andWhere("a.occurred_at>:cutoff AND a.occurred_at<=:now AND a.outcome='SUCCESS'", {
        cutoff: now - AUDIT_RETENTION_MS,
        now,
      })
      .orderBy("a.occurred_at", "DESC")
      .addOrderBy("a.id")
      .getOne();
  }
  purge(now: number) {
    return writeTransaction(this.db, async (m) => {
      const rows = await m
        .getRepository<AuditRow>("audit_events")
        .createQueryBuilder("a")
        .where("a.occurred_at<=:cutoff", { cutoff: now - AUDIT_RETENTION_MS })
        .orderBy("a.occurred_at")
        .addOrderBy("a.id")
        .take(1000)
        .getMany();
      let deleted = 0;
      for (const row of rows) deleted += (await m.delete("audit_events", row.id)).affected ?? 0;
      return deleted;
    });
  }
}
