/**
 * Media asset persistence (SA §7.1). Rows move UPLOADING → READY/FAILED → DELETING → removed; every
 * state change is revision-checked under a row lock so attach (quiz writes) and delete/cleanup
 * serialize on the same `media_assets` row. Storage I/O never happens inside these transactions.
 */
import { In, type DataSource, type EntityManager } from "typeorm";
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
/** Owner library filters; `search` is matched literally against the original file name. */
export interface MediaListQuery {
  page: number;
  limit: number;
  type?: "image" | "audio" | "video" | undefined;
  search: string;
  inUse?: boolean | undefined;
}
/** A library row plus whether any quiz, question or active room currently references it. */
export interface MediaListItem extends MediaRow {
  in_use: boolean;
}
export interface DeletionClaim {
  asset: MediaRow;
  previous: "READY" | "FAILED";
}
/** Reads one asset with a write lock (SQLite already holds the single writer). */
async function locked(manager: EntityManager, id: string) {
  const query = manager
    .getRepository<MediaRow>("media_assets")
    .createQueryBuilder("a")
    .where("a.id = :id", { id });
  if (manager.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
  return query.getOne();
}
/** True when a quiz cover, question or room pin references the asset (checked under its lock). */
async function inUse(manager: EntityManager, id: string) {
  return (
    (await manager.existsBy("quizzes", { cover_media_id: id })) ||
    (await manager.existsBy("questions", { media_id: id })) ||
    (await manager.existsBy("room_media", { media_id: id }))
  );
}
/** Revision- and state-guarded update; a concurrent change makes it fail with REVISION_CONFLICT. */
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
  /**
   * Runs `work` in the caller's active transaction (same database only) or in a new write
   * transaction, so upload reservations commit atomically with their operation receipt.
   */
  private transaction<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (!manager) return writeTransaction(this.db, work);
    if (!manager.queryRunner?.isTransactionActive || manager.connection !== this.db)
      throw new Error("INVALID_REFERENCE");
    return work(manager);
  }
  /** Inserts the UPLOADING reservation (immutable key/origin) before any blob is written. */
  async reserve(input: MediaReservation, now: number, manager?: EntityManager) {
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
    await this.transaction(manager, (m) => m.insert("media_assets", row));
    return row;
  }
  /** UPLOADING → READY with verified blob info, or → FAILED when `info` is null. */
  finishUpload(
    id: string,
    revision: number,
    info: BlobInfo | null,
    now: number,
    manager?: EntityManager,
  ) {
    return this.transaction(manager, async (m) => {
      const asset = await locked(m, id);
      if (!asset) throw new Error("NOT_FOUND");
      if (asset.revision !== revision) throw new Error("REVISION_CONFLICT");
      if (asset.state !== "UPLOADING") throw new Error("RESOURCE_BUSY");
      return transition(m, asset, info ? "READY" : "FAILED", now, info ?? undefined);
    });
  }
  /** Owner delete: READY/FAILED and unreferenced → DELETING; returns the state to restore. */
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
  /** After origin I/O: remove the row when the blob is gone, otherwise restore the prior state. */
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
  /** Claims up to one cleanup batch of the oldest unreferenced READY/FAILED assets. */
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
  /** Count and tracked bytes of READY assets for storage metrics. */
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
  /**
   * Bytes held in storage for the upload quota (TASK-188): READY assets plus DELETING ones whose
   * blob may still exist. UPLOADING reservations carry 0 bytes until they finish.
   */
  async totalStoredBytes(manager: EntityManager = this.db.manager): Promise<number> {
    if (manager.connection !== this.db) throw new Error("INVALID_REFERENCE");
    const result = await manager
      .getRepository<MediaRow>("media_assets")
      .createQueryBuilder("a")
      .select("COALESCE(SUM(a.size_bytes),0)", "bytes")
      .where("a.state IN (:...states)", { states: ["READY", "DELETING"] })
      .getRawOne<{ bytes: unknown }>();
    return safeInteger(result?.bytes);
  }
  /** One asset by ID in any state, optionally inside the caller's transaction. */
  find(id: string, manager: EntityManager = this.db.manager): Promise<MediaRow | null> {
    if (manager.connection !== this.db) throw new Error("INVALID_REFERENCE");
    return manager.getRepository<MediaRow>("media_assets").findOneBy({ id });
  }
  /** Subset of `ids` referenced by a quiz cover, a question or an active room pin. */
  async referenced(
    ids: readonly string[],
    manager: EntityManager = this.db.manager,
  ): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Set();
    const [covers, questions, pins] = await Promise.all([
      manager
        .getRepository<{ cover_media_id: string }>("quizzes")
        .find({ select: { cover_media_id: true }, where: { cover_media_id: In(unique) } }),
      manager
        .getRepository<{ media_id: string }>("questions")
        .find({ select: { media_id: true }, where: { media_id: In(unique) } }),
      manager
        .getRepository<{ media_id: string }>("room_media")
        .find({ select: { media_id: true }, where: { media_id: In(unique) } }),
    ]);
    return new Set([
      ...covers.map((row) => row.cover_media_id),
      ...questions.map((row) => row.media_id),
      ...pins.map((row) => row.media_id),
    ]);
  }
  /** Owner-scoped READY library page, newest first, with literal name search and filters. */
  async listOwned(owner: string, query: MediaListQuery) {
    const q = this.db
      .getRepository<MediaRow>("media_assets")
      .createQueryBuilder("a")
      .where("a.uploader_id=:owner AND a.state='READY'", { owner });
    if (query.type) q.andWhere("a.mime_type LIKE :type", { type: `${query.type}/%` });
    if (query.search)
      q.andWhere("LOWER(a.original_name) LIKE LOWER(:search) ESCAPE '!'", {
        search: "%" + query.search.replace(/[!_%]/g, "!$&") + "%",
      });
    if (query.inUse !== undefined) {
      const used =
        "(EXISTS (SELECT 1 FROM quizzes q WHERE q.cover_media_id=a.id) OR " +
        "EXISTS (SELECT 1 FROM questions qq WHERE qq.media_id=a.id) OR " +
        "EXISTS (SELECT 1 FROM room_media r WHERE r.media_id=a.id))";
      q.andWhere(query.inUse ? used : `NOT ${used}`);
    }
    const [rows, total] = await q
      .orderBy("a.created_at", "DESC")
      .addOrderBy("a.id", "ASC")
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    const used = await this.referenced(rows.map((row) => row.id));
    const items: MediaListItem[] = rows.map((row) => ({ ...row, in_use: used.has(row.id) }));
    return {
      items,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }
  /** Owner-only, revision-checked accessibility update of a READY asset (revision + 1). */
  updateAccessibility(
    id: string,
    owner: string,
    revision: number,
    accessibility: Accessibility,
    now: number,
  ) {
    return writeTransaction(this.db, async (m) => {
      const row = await locked(m, id);
      if (!row || row.uploader_id !== owner || row.state === "UPLOADING")
        throw new Error("NOT_FOUND");
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      if (row.state !== "READY") throw new Error("RESOURCE_BUSY");
      const change = { accessibility, updated_at: now, revision: row.revision + 1 };
      const result = await m.update(
        "media_assets",
        { id: row.id, revision: row.revision, state: row.state },
        change,
      );
      if (result.affected !== 1) throw new Error("REVISION_CONFLICT");
      return { ...row, ...change };
    });
  }
  /** Marks an interrupted UPLOADING reservation FAILED so the janitor removes any written blob. */
  failUpload(id: string, now: number, manager?: EntityManager) {
    return this.transaction(manager, async (m) => {
      const row = await locked(m, id);
      if (!row) return null;
      return row.state === "UPLOADING" ? transition(m, row, "FAILED", now) : row;
    });
  }
  /** Janitor: UPLOADING rows created before `before` become FAILED (bounded batch); returns count. */
  failStaleUploads(before: number, now: number, limit: number = MEDIA_LIMITS.cleanupBatch) {
    return writeTransaction(this.db, async (m) => {
      const stale = await m
        .getRepository<MediaRow>("media_assets")
        .createQueryBuilder("a")
        .where("a.state='UPLOADING' AND a.created_at<:before", { before })
        .orderBy("a.created_at", "ASC")
        .addOrderBy("a.id", "ASC")
        .take(limit)
        .getMany();
      let failed = 0;
      for (const candidate of stale) {
        const row = await locked(m, candidate.id);
        if (row?.state !== "UPLOADING") continue;
        await transition(m, row, "FAILED", now);
        failed++;
      }
      return failed;
    });
  }
  /** Janitor: DELETING rows untouched since `before` (a crashed delete) to retry idempotently. */
  staleDeletions(before: number, limit: number = MEDIA_LIMITS.cleanupBatch): Promise<MediaRow[]> {
    return this.db
      .getRepository<MediaRow>("media_assets")
      .createQueryBuilder("a")
      .where("a.state='DELETING' AND a.updated_at<:before", { before })
      .orderBy("a.updated_at", "ASC")
      .addOrderBy("a.id", "ASC")
      .take(limit)
      .getMany();
  }
}
