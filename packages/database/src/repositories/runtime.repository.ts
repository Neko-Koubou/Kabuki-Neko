/**
 * Room allocation persistence (SA §6.2): PIN uniqueness, active-room capacity, media pins and the
 * `room.create` idempotency receipt live in SQL; game state lives in the state store.
 */
import { randomInt, randomUUID } from "node:crypto";
import { In, type EntityManager, type DataSource } from "typeorm";
import { ROOM_LIMITS, DEDUP_LIMITS, pinCodeSchema } from "@kabuki-neko/shared";
import { lockParent, writeTransaction } from "../data-source.factory";
type Status = "CREATING" | "ACTIVE" | "FINALIZING" | "CLOSED" | "LOST";
/** One `room_allocations` row. */
export interface Allocation {
  id: string;
  pin_code: string;
  host_id: string;
  quiz_id: string | null;
  quiz_revision: number;
  creation_snapshot: unknown;
  state_driver: "memory" | "redis";
  state_namespace: string;
  status: Status;
  created_at: number;
  expires_at: number;
  last_heartbeat_at: number;
}
interface Reservation {
  hostId: string;
  quizId: string;
  quizRevision: number;
  requestId: string;
  requestHash: string;
  driver: Allocation["state_driver"];
  namespace: string;
  capacity: number;
  now: number;
  expiresAt: number;
}
interface Dedup {
  actor_scope: string;
  operation: string;
  key: string;
  request_hash: string;
  resource_id: string | null;
  state: "PENDING" | "DONE";
}
export class RuntimeRepository {
  constructor(
    private readonly db: DataSource,
    private readonly nextPin = () => String(randomInt(1_000_000)).padStart(6, "0"),
  ) {}
  reserve(
    input: Reservation,
    snapshot: (
      manager: EntityManager,
    ) => Promise<{ snapshot: object; mediaIds: readonly string[] }>,
  ) {
    return writeTransaction(this.db, async (m) => {
      await lockParent(m, "system_settings", "global");
      const allocations = m.getRepository<Allocation>("room_allocations"),
        dedup = m.getRepository<Dedup>("request_dedup");
      const scope = { actor_scope: input.hostId, operation: "room.create", key: input.requestId };
      const receipt = await dedup.findOneBy(scope);
      if (receipt) {
        if (receipt.request_hash !== input.requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        const existing = receipt.resource_id
          ? await allocations.findOneBy({ id: receipt.resource_id })
          : null;
        if (!existing) throw new Error("ROOM_EXPIRED");
        return existing;
      }
      const quizQuery = m
        .createQueryBuilder()
        .select(["q.creator_id AS creator", "q.visibility AS visibility", "q.revision AS revision"])
        .from("quizzes", "q")
        .where("q.id=:id", { id: input.quizId });
      if (m.connection.options.type !== "better-sqlite3") quizQuery.setLock("pessimistic_write");
      const quiz = await quizQuery.getRawOne<{
        creator: string;
        visibility: string;
        revision: number;
      }>();
      if (!quiz || (quiz.creator !== input.hostId && quiz.visibility !== "PUBLIC"))
        throw new Error("NOT_FOUND");
      if (quiz.revision !== input.quizRevision) throw new Error("REVISION_CONFLICT");
      if (
        (await allocations.countBy({ status: In(["CREATING", "ACTIVE", "FINALIZING"]) })) >=
        input.capacity
      )
        throw new Error("CAPACITY_REACHED");
      const data = await snapshot(m);
      const mediaIds = [...new Set(data.mediaIds)].sort();
      for (const id of mediaIds) {
        await lockParent(m, "media_assets", id);
        if (!(await m.existsBy("media_assets", { id, state: "READY" })))
          throw new Error("INVALID_REFERENCE");
      }
      let pin: string | undefined;
      for (let n = 0; n < ROOM_LIMITS.pinAllocationAttempts; n++) {
        const candidate = pinCodeSchema.parse(this.nextPin());
        if (!(await allocations.existsBy({ pin_code: candidate }))) {
          pin = candidate;
          break;
        }
      }
      if (!pin) throw new Error("PIN_EXHAUSTED");
      const row: Allocation = {
        id: randomUUID(),
        host_id: input.hostId,
        quiz_id: input.quizId,
        quiz_revision: input.quizRevision,
        creation_snapshot: data.snapshot,
        pin_code: pin,
        state_driver: input.driver,
        state_namespace: input.namespace,
        status: "CREATING",
        created_at: input.now,
        expires_at: input.expiresAt,
        last_heartbeat_at: input.now,
      };
      await m.insert("room_allocations", row);
      if (mediaIds.length)
        await m.insert(
          "room_media",
          mediaIds.map((id) => ({ session_id: row.id, media_id: id, created_at: input.now })),
        );
      await m.insert("request_dedup", {
        id: randomUUID(),
        ...scope,
        request_hash: input.requestHash,
        resource_id: row.id,
        created_at: input.now,
        expires_at: input.now + DEDUP_LIMITS.retentionMs,
        lease_until: input.now + DEDUP_LIMITS.leaseMs,
      });
      return row;
    });
  }
  activate(sessionId: string, now: number) {
    return writeTransaction(this.db, async (m) => {
      await lockParent(m, "room_allocations", sessionId);
      const row = await m
        .getRepository<Allocation>("room_allocations")
        .findOneByOrFail({ id: sessionId });
      if (row.status === "ACTIVE") return row;
      if (row.status !== "CREATING") throw new Error("INVALID_PHASE");
      await m.update("room_allocations", sessionId, { status: "ACTIVE", last_heartbeat_at: now });
      const result = await m.update(
        "request_dedup",
        { resource_id: sessionId, operation: "room.create", state: "PENDING" },
        {
          state: "DONE",
          lease_until: null,
          response_json: { sessionId, pinCode: row.pin_code, phaseVersion: 1 },
        },
      );
      if (result.affected !== 1) throw new Error("INVALID_REFERENCE");
      return { ...row, status: "ACTIVE" as const, last_heartbeat_at: now };
    });
  }
  async transition(
    sessionId: string,
    expected: "ACTIVE" | "FINALIZING",
    status: "FINALIZING" | "CLOSED" | "LOST",
    now: number,
  ) {
    if (
      (expected === "ACTIVE" && status === "CLOSED") ||
      (expected === "FINALIZING" && status === "FINALIZING")
    )
      throw new Error("INVALID_PHASE");
    return (
      (
        await this.db.manager.update(
          "room_allocations",
          { id: sessionId, status: expected },
          { status, last_heartbeat_at: now },
        )
      ).affected === 1
    );
  }
  async heartbeat(sessionId: string, now: number) {
    return (
      (
        await this.db.manager
          .createQueryBuilder()
          .update("room_allocations")
          .set({ last_heartbeat_at: now })
          .where("id=:sessionId AND status='ACTIVE' AND last_heartbeat_at<=:now", {
            sessionId,
            now,
          })
          .execute()
      ).affected === 1
    );
  }
  /** One allocation by session ID (any status), or null. */
  find(sessionId: string): Promise<Allocation | null> {
    return this.db.getRepository<Allocation>("room_allocations").findOneBy({ id: sessionId });
  }
  /** The allocation currently holding `pin` (PIN uniqueness is a SQL constraint), or null. */
  findByPin(pin: string): Promise<Allocation | null> {
    const parsed = pinCodeSchema.safeParse(pin);
    if (!parsed.success) return Promise.resolve(null);
    return this.db
      .getRepository<Allocation>("room_allocations")
      .findOneBy({ pin_code: parsed.data });
  }
  /** ACTIVE/FINALIZING allocations after `afterId` in id order (keyset paging, ≤ 500 rows). */
  active(afterId: string | null = null, limit = 500): Promise<Allocation[]> {
    const query = this.db
      .getRepository<Allocation>("room_allocations")
      .createQueryBuilder("r")
      .where("r.status IN ('ACTIVE','FINALIZING')");
    if (afterId) query.andWhere("r.id>:afterId", { afterId });
    return query
      .orderBy("r.id", "ASC")
      .take(Math.max(1, Math.min(limit, 500)))
      .getMany();
  }
  /** CLOSED/LOST allocations idle since before `before`, oldest first (release retry scan). */
  retired(before: number, limit = 100): Promise<Allocation[]> {
    return this.db
      .getRepository<Allocation>("room_allocations")
      .createQueryBuilder("r")
      .where("r.status IN ('CLOSED','LOST') AND r.last_heartbeat_at<:before", { before })
      .orderBy("r.last_heartbeat_at", "ASC")
      .addOrderBy("r.id", "ASC")
      .take(Math.max(1, Math.min(limit, 100)))
      .getMany();
  }
  /** CREATING allocations created before `before` (crashed creates), oldest first, bounded. */
  staleCreating(before: number, limit = 100): Promise<Allocation[]> {
    return this.db
      .getRepository<Allocation>("room_allocations")
      .createQueryBuilder("r")
      .where("r.status='CREATING' AND r.created_at<:before", { before })
      .orderBy("r.created_at", "ASC")
      .addOrderBy("r.id", "ASC")
      .take(Math.max(1, Math.min(limit, 100)))
      .getMany();
  }
  expired(now: number) {
    return this.db
      .getRepository<Allocation>("room_allocations")
      .createQueryBuilder("r")
      .where("r.status IN ('ACTIVE','CREATING') AND r.expires_at<=:now", { now })
      .orderBy("r.expires_at", "ASC")
      .addOrderBy("r.id", "ASC")
      .take(100)
      .getMany();
  }
  release(sessionId: string, pin: string, now: number) {
    return writeTransaction(this.db, async (m) => {
      await lockParent(m, "system_settings", "global");
      const repo = m.getRepository<Allocation>("room_allocations");
      const query = repo
        .createQueryBuilder("r")
        .where("r.id=:sessionId AND r.pin_code=:pin", { sessionId, pin });
      if (m.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
      const row = await query.getOne();
      if (!row) return false;
      if (row.status === "CREATING") {
        await m.delete("request_dedup", {
          resource_id: sessionId,
          operation: "room.create",
          state: "PENDING",
        });
      } else {
        if (
          !["CLOSED", "LOST"].includes(row.status) ||
          now - row.last_heartbeat_at < ROOM_LIMITS.finishedRetentionMs
        )
          return false;
        const job = await m
          .getRepository<{ session_id: string; state: string }>("finalization_jobs")
          .findOneBy({ session_id: sessionId });
        if ((job && job.state !== "READY") || (row.status === "CLOSED" && !job)) return false;
        if (job) await m.delete("finalization_jobs", { session_id: sessionId });
      }
      await repo.delete(sessionId);
      await m.insert("audit_events", {
        id: randomUUID(),
        occurred_at: now,
        actor_type: "SYSTEM",
        actor_id: row.host_id,
        action: "room.release." + row.status.toLowerCase(),
        resource_id: sessionId,
        outcome: "SUCCESS",
        correlation_id: randomUUID(),
      });
      return true;
    });
  }
}
