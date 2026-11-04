import type { DataSource, EntityManager } from "typeorm";
import { MEDIA_LIMITS, type Accessibility } from "@kabuki-neko/shared";
import { writeTransaction } from "../data-source.factory";
import { safeInteger } from "../schema/column-types";

export interface MediaReservation {
  id: string;
  uploader_id: string;
  storage_driver: "local" | "s3";
  storage_location_id: string;
  storage_key: string;
  public_url: string;
  original_name: string;
  mime_type: string;
  accessibility: Accessibility;
}
interface BlobInfo {
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
}
export interface MediaRow extends MediaReservation, BlobInfo {
  state: "UPLOADING" | "READY" | "FAILED" | "DELETING";
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface DeletionClaim {
  asset: MediaRow;
  previous: "READY" | "FAILED";
}
async function locked(manager: EntityManager, id: string) {
  const query = manager
    .getRepository<MediaRow>("media_assets")
    .createQueryBuilder("a")
    .where("a.id = :id", { id });
  if (manager.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
  return query.getOne();
}
async function inUse(manager: EntityManager, id: string) {
  return (
    (await manager.existsBy("quizzes", { cover_media_id: id })) ||
    (await manager.existsBy("questions", { media_id: id })) ||
    (await manager.existsBy("room_media", { media_id: id }))
  );
}
async function transition(
  manager: EntityManager,
  row: MediaRow,
  state: MediaRow["state"],
  now: number,
  info?: BlobInfo,
): Promise<MediaRow> {
  const change = { ...info, state, updated_at: now, revision: row.revision + 1 };
  const result = await manager.update(
    "media_assets",
    { id: row.id, revision: row.revision, state: row.state },
    change,
  );
  if (result.affected !== 1) throw new Error("REVISION_CONFLICT");
  return { ...row, ...change };
}
export class MediaRepository {
  constructor(private readonly db: DataSource) {}
  async reserve(input: MediaReservation, now: number) {
    const row: MediaRow = {
      ...input,
      size_bytes: 0,
      width: null,
      height: null,
      duration_ms: null,
      state: "UPLOADING",
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.manager.insert("media_assets", row);
    return row;
  }
  finishUpload(id: string, revision: number, info: BlobInfo | null, now: number) {
    return writeTransaction(this.db, async (m) => {
      const asset = await locked(m, id);
      if (!asset) throw new Error("NOT_FOUND");
      if (asset.revision !== revision) throw new Error("REVISION_CONFLICT");
      if (asset.state !== "UPLOADING") throw new Error("RESOURCE_BUSY");
      return transition(m, asset, info ? "READY" : "FAILED", now, info ?? undefined);
    });
  }
  claimDelete(id: string, owner: string, revision: number, now: number) {
    return writeTransaction(this.db, async (m) => {
      const row = await locked(m, id);
      if (!row || row.uploader_id !== owner) throw new Error("NOT_FOUND");
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      if (row.state !== "READY" && row.state !== "FAILED") throw new Error("RESOURCE_BUSY");
      if (await inUse(m, id)) throw new Error("MEDIA_IN_USE");
      return {
        asset: await transition(m, row, "DELETING", now),
        previous: row.state,
      } satisfies DeletionClaim;
    });
  }
  settleDelete(claim: DeletionClaim, deleted: boolean, now: number) {
    return writeTransaction(this.db, async (m) => {
      const row = await locked(m, claim.asset.id);
      if (!row && deleted) return;
      if (!row || row.state !== "DELETING" || row.revision !== claim.asset.revision)
        throw new Error("REVISION_CONFLICT");
      if (deleted) await m.delete("media_assets", row.id);
      else await transition(m, row, claim.previous, now);
    });
  }
  claimCleanup(now: number) {
    return writeTransaction(this.db, async (m) => {
      const candidates = await m
        .getRepository<MediaRow>("media_assets")
        .createQueryBuilder("a")
        .select("a.id", "id")
        .where("a.state IN ('READY','FAILED')")
        .andWhere("NOT EXISTS (SELECT 1 FROM quizzes q WHERE q.cover_media_id=a.id)")
        .andWhere("NOT EXISTS (SELECT 1 FROM questions q WHERE q.media_id=a.id)")
        .andWhere("NOT EXISTS (SELECT 1 FROM room_media r WHERE r.media_id=a.id)")
        .orderBy("a.created_at", "ASC")
        .addOrderBy("a.id", "ASC")
        .limit(MEDIA_LIMITS.cleanupBatch + 1)
        .getRawMany<{ id: string }>();
      const claims: DeletionClaim[] = [];
      let skippedInUseCount = 0;
      for (const candidate of candidates.slice(0, MEDIA_LIMITS.cleanupBatch)) {
        const row = await locked(m, candidate.id);
        if (!row || (row.state !== "READY" && row.state !== "FAILED")) continue;
        if (await inUse(m, row.id)) {
          skippedInUseCount++;
          continue;
        }
        claims.push({ asset: await transition(m, row, "DELETING", now), previous: row.state });
      }
      return {
        claims,
        scannedCount: Math.min(candidates.length, MEDIA_LIMITS.cleanupBatch),
        skippedInUseCount,
        hasMore: candidates.length > MEDIA_LIMITS.cleanupBatch,
      };
    });
  }
  async readyMetrics() {
    const result = await this.db
      .getRepository<MediaRow>("media_assets")
      .createQueryBuilder("a")
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(a.size_bytes),0)", "bytes")
      .where("a.state='READY'")
      .getRawOne<{ count: unknown; bytes: unknown }>();
    return { fileCount: safeInteger(result?.count), totalBytes: safeInteger(result?.bytes) };
  }
}
