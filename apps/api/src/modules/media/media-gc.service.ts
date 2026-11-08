/**
 * Safe media deletion, administrator orphan cleanup and the background janitor (SA §7.1).
 *
 * Every removal follows the same three steps so a crash at any point is recoverable:
 * 1. a DB transaction locks the row, checks state and quiz/question/room references and marks it
 *    DELETING (the same lock attach operations take, so attach and delete serialize);
 * 2. the blob is deleted through the asset's **origin** adapter (missing objects are success);
 * 3. a DB transaction removes the row, or restores the previous READY/FAILED state on failure.
 * A process that dies after step 1 leaves a DELETING row that the janitor re-deletes idempotently.
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  MediaRepository,
  type DeletionClaim,
  type MediaRow,
  type OperationRow,
} from "@kabuki-neko/database";
import type { EntityManager } from "typeorm";
import type { z } from "zod";
import { MEDIA_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { cleanupResultSchema } from "@kabuki-neko/shared/schemas/system.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ApiError } from "../../common/error.filter";
import { IdempotencyService } from "../../common/idempotency.service";
import { StorageRegistry } from "../../providers/storage/storage-registry";
import { MediaReferenceService } from "./media-reference.service";

/** A DELETING row untouched this long is treated as a crashed deletion and retried. */
export const STALE_DELETING_MS = 10 * 60_000;
/** Outcome of one janitor sweep, for metrics and tests. */
export interface JanitorResult {
  failedUploads: number;
  retriedDeletions: number;
  deletedRows: number;
}
/** Result of one cleanup batch (SA §7.1 CleanupResult). */
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
type FailureCode = CleanupResult["failures"][number]["errorCode"];

@Injectable()
export class MediaGcService {
  constructor(
    @Inject(MediaRepository) private readonly media: MediaRepository,
    @Inject(StorageRegistry) private readonly storage: StorageRegistry,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
    @Inject(MediaReferenceService) private readonly references: MediaReferenceService,
  ) {}

  /**
   * Deletes the blob through the asset's origin adapter. An unconfigured origin is reported as
   * STORAGE_UNAVAILABLE (never pretended deleted); any adapter failure is DELETE_FAILED.
   */
  private async deleteBlob(asset: MediaRow): Promise<FailureCode | null> {
    let adapter;
    try {
      adapter = this.storage.get(asset.storage_location_id);
    } catch {
      return "STORAGE_UNAVAILABLE";
    }
    try {
      await adapter.delete(asset.storage_key);
      return null;
    } catch {
      return "DELETE_FAILED";
    }
  }

  /** Steps 2–3 for one claim: origin delete, then remove the row or restore its prior state. */
  private async settle(claim: DeletionClaim): Promise<FailureCode | null> {
    const failure = await this.deleteBlob(claim.asset);
    await this.media.settleDelete(claim, failure === null, Date.now());
    return failure;
  }

  /**
   * DELETE /media/:id — owner-only. 409 MEDIA_IN_USE when referenced, 409 RESOURCE_BUSY while
   * uploading/deleting or after a concurrent change, 503 when the origin cannot delete the blob
   * (the asset is restored, never half-deleted).
   */
  async deleteOwned(actorId: string, id: unknown): Promise<{ deleted: true }> {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", 422);
    const row = await this.references.owned(actorId, parsed.data);
    let claim: DeletionClaim;
    try {
      claim = await this.media.claimDelete(row.id, actorId, row.revision, Date.now());
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MEDIA_IN_USE") throw new ApiError("MEDIA_IN_USE", 409);
      if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
      if (code === "RESOURCE_BUSY" || code === "REVISION_CONFLICT")
        throw new ApiError("RESOURCE_BUSY", 409);
      throw error;
    }
    if ((await this.settle(claim)) !== null) throw new ApiError("STORAGE_UNAVAILABLE", 503);
    return { deleted: true };
  }

  /**
   * Fails the reservation when another cleanup run still holds a live lease. Receipts are
   * serialized by the operations repository (settings row lock), so this check is race-free.
   */
  private async assertSingleton(manager: EntityManager, key: string, now: number) {
    const running = await manager
      .getRepository<OperationRow>("request_dedup")
      .createQueryBuilder("d")
      .where("d.operation='cleanup' AND d.state='PENDING' AND d.lease_until>:now AND d.key<>:key", {
        now,
        key,
      })
      .getCount();
    if (running > 0) throw new ApiError("RESOURCE_BUSY", 409);
  }

  /**
   * POST /system/storage/cleanup-orphans — one bounded batch (≤100 oldest unreferenced READY or
   * FAILED assets, no minimum age) under a singleton DB lease. Claims happen in one transaction;
   * blob I/O runs outside it. Partial progress is 200 with failures; a batch where every attempted
   * delete failed is 503. `freedBytes` counts confirmed deletions only and `hasMore` asks for
   * another batch with a new key. A completed key is never re-executed (409 IDEMPOTENCY_CONFLICT;
   * reconcile through GET /operations/:key); an expired run is recorded as 503 and its claimed
   * DELETING rows are finished by the janitor.
   */
  async cleanup(actorId: string, key: string): Promise<CleanupResult> {
    const runId = randomUUID();
    const receipt = await this.operations.reserve(
      {
        actorScope: actorId,
        operation: "cleanup",
        key,
        method: "POST",
        path: "/api/v1/system/storage/cleanup-orphans",
        query: {},
        body: {},
      },
      async (manager) => {
        await this.assertSingleton(manager, key, Date.now());
        return { pendingResourceId: runId };
      },
      async (_manager, row) => ({ httpStatus: 503, resourceId: row.resource_id }),
      async () => undefined,
    );
    if (receipt.state === "DONE") throw new ApiError("IDEMPOTENCY_CONFLICT", 409);
    if (receipt.resource_id !== runId) throw new ApiError("OPERATION_PENDING", 409);
    const result = await this.operations.withLease(receipt.id, () => this.batch());
    const total = result.deletedCount === 0 && result.failedCount > 0;
    await this.operations.complete(receipt.id, async () => ({
      httpStatus: total ? 503 : 200,
      resourceId: runId,
    }));
    if (total) throw new ApiError("STORAGE_UNAVAILABLE", 503);
    return result;
  }

  /** Claims one cleanup batch and settles each claim outside the claiming transaction. */
  private async batch(): Promise<CleanupResult> {
    const claimed = await this.media.claimCleanup(Date.now());
    let deletedCount = 0,
      freedBytes = 0;
    const failures: CleanupResult["failures"] = [];
    for (const claim of claimed.claims) {
      const failure = await this.settle(claim);
      if (failure === null) {
        deletedCount++;
        freedBytes += claim.asset.size_bytes;
      } else failures.push({ mediaId: claim.asset.id, errorCode: failure });
    }
    return cleanupResultSchema.parse({
      scannedCount: claimed.scannedCount,
      deletedCount,
      freedBytes,
      skippedInUseCount: claimed.skippedInUseCount,
      failedCount: failures.length,
      failures,
      hasMore: claimed.hasMore,
      checkedAt: Date.now(),
    });
  }

  /**
   * Background janitor: interrupted UPLOADING reservations older than one hour become FAILED (so
   * orphan cleanup removes them and any written blob), and DELETING rows left by a crashed delete
   * are re-deleted idempotently; a still-failing origin leaves the row DELETING for the next sweep.
   */
  async sweep(now: number = Date.now()): Promise<JanitorResult> {
    const failedUploads = await this.media.failStaleUploads(now - MEDIA_LIMITS.staleUploadMs, now);
    const stale = await this.media.staleDeletions(now - STALE_DELETING_MS);
    let deletedRows = 0;
    for (const asset of stale) {
      if ((await this.deleteBlob(asset)) !== null) continue;
      try {
        await this.media.settleDelete({ asset, previous: "FAILED" }, true, now);
        deletedRows++;
      } catch {
        /* A concurrent sweep already settled it; the next sweep re-reads the row. */
      }
    }
    return { failedUploads, retriedDeletions: stale.length, deletedRows };
  }
}
