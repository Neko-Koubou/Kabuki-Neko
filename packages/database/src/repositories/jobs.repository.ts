import { createHash, randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { FINALIZATION_LIMITS, ROOM_LIMITS, type ErrorCode } from "@kabuki-neko/shared";
import { lockParent, writeTransaction } from "../data-source.factory";
export interface FinalizationJob {
  session_id: string;
  host_id: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  state: "PENDING" | "RUNNING" | "FAILED" | "READY";
  attempts: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_error_code: ErrorCode | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
function frozen(input: Record<string, unknown>) {
  const json = JSON.stringify(input, (_key, value: unknown) => {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("INVALID_FORMAT");
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return value;
  });
  if (Buffer.byteLength(json) > ROOM_LIMITS.frozenReportBytes) throw new Error("PAYLOAD_TOO_LARGE");
  return {
    payload: JSON.parse(json) as Record<string, unknown>,
    hash: createHash("sha256").update(json).digest("hex"),
  };
}
const due =
  "((state IN ('PENDING','FAILED') AND attempts <= :retries AND next_attempt_at <= :now) OR (state='RUNNING' AND lease_until <= :now))";
export class JobsRepository {
  constructor(private readonly db: DataSource) {}
  enqueue(sessionId: string, hostId: string, input: Record<string, unknown>, now: number) {
    const data = frozen(input);
    return writeTransaction(this.db, async (m) => {
      await lockParent(m, "room_allocations", sessionId);
      if (!(await m.existsBy("room_allocations", { id: sessionId, host_id: hostId })))
        throw new Error("NOT_FOUND");
      const repo = m.getRepository<FinalizationJob>("finalization_jobs"),
        existing = await repo.findOneBy({ session_id: sessionId });
      if (existing) {
        if (existing.payload_hash !== data.hash)
          throw new Error("Finalization payload hash mismatch");
        return existing;
      }
      const row: FinalizationJob = {
        session_id: sessionId,
        host_id: hostId,
        payload: data.payload,
        payload_hash: data.hash,
        state: "PENDING",
        attempts: 0,
        next_attempt_at: now,
        lease_owner: null,
        lease_until: null,
        last_error_code: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };
      await m.insert("finalization_jobs", row);
      return row;
    });
  }
  claim(now: number) {
    return writeTransaction(this.db, async (m) => {
      const repo = m.getRepository<FinalizationJob>("finalization_jobs");
      const parameters = { now, retries: FINALIZATION_LIMITS.automatedAttempts };
      const candidates = await repo
        .createQueryBuilder("j")
        .select("j.session_id", "id")
        .where(due, parameters)
        .orderBy("j.next_attempt_at", "ASC")
        .addOrderBy("j.session_id", "ASC")
        .take(16)
        .getRawMany<{ id: string }>();
      for (const { id } of candidates) {
        const owner = randomUUID();
        const result = await repo
          .createQueryBuilder()
          .update()
          .set({
            state: "RUNNING",
            lease_owner: owner,
            lease_until: now + FINALIZATION_LIMITS.leaseMs,
            updated_at: now,
          })
          .where("session_id=:id", { id })
          .andWhere(due, parameters)
          .execute();
        if (result.affected === 1) return repo.findOneByOrFail({ session_id: id });
      }
      return null;
    });
  }
  async renew(id: string, owner: string, now: number) {
    const result = await this.db
      .createQueryBuilder()
      .update("finalization_jobs")
      .set({ lease_until: now + FINALIZATION_LIMITS.leaseMs, updated_at: now })
      .where("session_id=:id AND state='RUNNING' AND lease_owner=:owner AND lease_until>:now", {
        id,
        owner,
        now,
      })
      .execute();
    return result.affected === 1;
  }
  async owned(manager: EntityManager, id: string, owner: string, now: number) {
    const q = manager
      .getRepository<FinalizationJob>("finalization_jobs")
      .createQueryBuilder("j")
      .where("j.session_id=:id", { id });
    if (manager.connection.options.type !== "better-sqlite3") q.setLock("pessimistic_write");
    const job = await q.getOne();
    if (
      !job ||
      job.state !== "RUNNING" ||
      job.lease_owner !== owner ||
      job.lease_until === null ||
      job.lease_until <= now
    )
      throw new Error("RESOURCE_BUSY");
    return job;
  }
  fail(id: string, owner: string, error: ErrorCode, now: number) {
    return writeTransaction(this.db, async (m) => {
      const job = await this.owned(m, id, owner, now);
      const delay = FINALIZATION_LIMITS.retryDelaysMs[job.attempts] ?? 0;
      await m.update("finalization_jobs", id, {
        state: "FAILED",
        attempts: job.attempts + 1,
        next_attempt_at: now + delay,
        lease_owner: null,
        lease_until: null,
        last_error_code: error,
        updated_at: now,
      });
    });
  }
  async manualRetry(id: string, hostId: string, now: number) {
    const updated = await this.db
      .createQueryBuilder()
      .update("finalization_jobs")
      .set({
        state: "PENDING",
        attempts: 0,
        next_attempt_at: now,
        last_error_code: null,
        updated_at: now,
      })
      .where("session_id=:id AND host_id=:hostId AND state='FAILED'", { id, hostId })
      .execute();
    return updated.affected === 1;
  }
}
