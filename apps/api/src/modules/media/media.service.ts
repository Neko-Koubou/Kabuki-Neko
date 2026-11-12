/**
 * Media upload, owner library and accessibility metadata (SA §4.4, §7.1).
 *
 * Upload protocol (no DB transaction is held during processing or storage I/O):
 * 1. bytes are classified/processed by the media processor (413/415/422 before any state);
 * 2. one `media.upload` operation transaction reserves the receipt and an UPLOADING row with an
 *    immutable key and origin location;
 * 3. under the operation lease the processed blob is stored and verified with `readHead`;
 * 4. one transaction marks the row READY and completes the receipt with 201.
 * Storage failures delete the blob when possible and leave a FAILED row (janitor-visible) with a
 * 503 receipt. A same-key retry replays READY as 201, a live lease as 409 OPERATION_PENDING, and an
 * interrupted reservation is reconciled to FAILED/503 so the client retries with a new key.
 */
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  MediaRepository,
  SettingsRepository,
  type MediaReservation,
  type MediaRow,
  type OperationResult,
  type OperationRow,
} from "@kabuki-neko/database";
import type { EntityManager } from "typeorm";
import {
  mediaPatchSchema,
  mediaQuerySchema,
  mediaSchema,
  mediaUploadMetadataSchema,
  type Media,
} from "@kabuki-neko/shared/schemas/media.schema";
import { revisionSchema, uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { IdempotencyService, type HttpOperation } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { StorageRegistry } from "../../providers/storage/storage-registry";
import { STORAGE_EXTENSIONS } from "../../providers/storage/storage.interface";
import {
  processMedia,
  sizeLimitsFromSettings,
  uploadByteCap,
  type MediaFolder,
  type MediaProcessorOptions,
  type MediaSizeLimits,
  type ProcessedMedia,
} from "./media-processor";
import { MediaReferenceService } from "./media-reference.service";

/** One multipart upload after the controller has parsed and bounded the form parts. */
export interface MediaUpload {
  bytes: Buffer;
  originalName: string;
  declaredMime: string;
  folder: unknown;
  accessibility: unknown;
}
/** Injection token for processor options (ffprobe path/timeouts); optional in production. */
export const MEDIA_PROCESSOR_OPTIONS = Symbol("MEDIA_PROCESSOR_OPTIONS");

/** Maps repository error messages to the stable API envelope. */
function domainError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) {
    if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
    if (error.message === "REVISION_CONFLICT") throw new ApiError("REVISION_CONFLICT", 409);
    if (error.message === "RESOURCE_BUSY") throw new ApiError("RESOURCE_BUSY", 409);
    if (error.message === "MEDIA_IN_USE") throw new ApiError("MEDIA_IN_USE", 409);
    if (error.message === "STORAGE_UNAVAILABLE") throw new ApiError("STORAGE_UNAVAILABLE", 503);
  }
  throw error;
}
/** Safe display name: basename, NFC, no control characters, 1–255 code points. */
export function safeOriginalName(name: string): string {
  const cleaned = Array.from(
    basename(name.replace(/\\/gu, "/"))
      .normalize("NFC")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim(),
  )
    .slice(0, 255)
    .join("");
  const parsed = mediaSchema.shape.originalName.safeParse(cleaned);
  return parsed.success ? parsed.data : "upload";
}

@Injectable()
export class MediaService {
  private readonly processorOptions: MediaProcessorOptions;
  constructor(
    @Inject(MediaRepository) private readonly media: MediaRepository,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(StorageRegistry) private readonly storage: StorageRegistry,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
    @Inject(MediaReferenceService) private readonly references: MediaReferenceService,
    @Optional()
    @Inject(MEDIA_PROCESSOR_OPTIONS)
    processorOptions: MediaProcessorOptions | null = null,
  ) {
    this.processorOptions = processorOptions ?? {};
  }

  /** Current per-type byte caps from instance settings. */
  async limits(): Promise<MediaSizeLimits> {
    const row = await this.settings.current();
    return sizeLimitsFromSettings({
      maxImageSizeMb: row.max_image_size_mb,
      maxAudioSizeMb: row.max_audio_size_mb,
      maxVideoSizeMb: row.max_video_size_mb,
    });
  }
  /** Largest original byte count the route parser may buffer for any upload folder. */
  async parserByteCap(): Promise<number> {
    return uploadByteCap("questions", await this.limits());
  }

  /** Public URL the active origin will serve `key` from (same base the adapters use). */
  private publicUrl(key: string): string {
    const env = this.config.values;
    const base =
      env.STORAGE_DRIVER === "local"
        ? `${env.NEXT_PUBLIC_API_URL}/uploads`
        : (env.S3_PUBLIC_URL ?? "");
    return `${base.replace(/\/$/u, "")}/${key}`;
  }

  /** Replays a completed receipt: READY → 201 Media for the owner; anything else is not success. */
  private async replay(actorId: string, row: Readonly<OperationRow>) {
    if (row.http_status !== 201) throw new ApiError("STORAGE_UNAVAILABLE", 503);
    const asset = row.resource_id ? await this.media.find(row.resource_id) : null;
    if (!asset || asset.uploader_id !== actorId || asset.state !== "READY")
      throw new ApiError("NOT_FOUND", 404);
    return { httpStatus: 201, response: await this.references.dto(asset, actorId) };
  }

  /**
   * Reconciles an expired pending reservation inside the receipt transaction. READY becomes a 201
   * receipt; an interrupted UPLOADING row (crash before or after the blob write) becomes FAILED so
   * the janitor removes any written blob, and the receipt records 503.
   */
  private async reconcile(manager: EntityManager, row: Readonly<OperationRow>) {
    if (!row.resource_id) return { httpStatus: 503, resourceId: null } satisfies OperationResult;
    const asset = await this.media.failUpload(row.resource_id, Date.now(), manager);
    return {
      httpStatus: asset?.state === "READY" ? 201 : 503,
      resourceId: row.resource_id,
    } satisfies OperationResult;
  }

  /** Stores the processed blob at the reserved key and verifies it via the origin adapter. */
  private async store(
    reservation: MediaReservation,
    folder: MediaFolder,
    processed: ProcessedMedia,
  ) {
    const adapter = this.storage.get(reservation.storage_location_id);
    const result = await adapter.upload({
      buffer: processed.buffer,
      originalName: reservation.original_name,
      mimeType: processed.mimeType,
      folder,
      key: reservation.storage_key,
    });
    const head = await adapter.readHead(reservation.storage_key);
    if (
      result.key !== reservation.storage_key ||
      result.publicUrl !== reservation.public_url ||
      !head.exists ||
      head.sizeBytes !== processed.sizeBytes
    )
      throw new Error("STORAGE_UNAVAILABLE");
  }

  /** Best-effort blob removal, then FAILED row + 503 receipt; failures stay for the janitor. */
  private async compensate(reservation: MediaReservation, receiptId: string) {
    try {
      await this.storage.get(reservation.storage_location_id).delete(reservation.storage_key);
    } catch {
      /* The FAILED row keeps the key tracked; the janitor/cleanup retries the delete. */
    }
    try {
      await this.operations.complete(receiptId, async (manager) => {
        await this.media.failUpload(reservation.id, Date.now(), manager);
        return { httpStatus: 503, resourceId: reservation.id };
      });
    } catch {
      /* Lease lost: a later same-key retry or the stale-upload janitor reconciles the row. */
    }
  }

  /**
   * Total media storage quota (`MEDIA_STORAGE_QUOTA_MIB`, 0 = unlimited; TASK-188). Refuses an
   * upload that would take the stored bytes past the budget with CAPACITY_REACHED (507), before
   * any row, receipt or blob exists. The check is not serialized with concurrent uploads, so the
   * stored total can exceed the budget by at most (parallel uploads × the per-file limit).
   */
  private async checkQuota(incomingBytes: number, manager: EntityManager): Promise<void> {
    const quotaMib = this.config.values.MEDIA_STORAGE_QUOTA_MIB;
    if (quotaMib === 0) return;
    const stored = await this.media.totalStoredBytes(manager);
    if (stored + incomingBytes > quotaMib * 1024 * 1024)
      throw new ApiError("CAPACITY_REACHED", 507);
  }

  /** POST /media/upload — see the module comment for the full reservation protocol. */
  async upload(
    principal: VerifiedPrincipal,
    upload: MediaUpload,
    key: string,
  ): Promise<{ httpStatus: number; response: Media }> {
    const actor = await this.jwt.current(principal);
    const metadata = new ZodValidationPipe(mediaUploadMetadataSchema).transform({
      folder: upload.folder,
      accessibility: upload.accessibility,
    });
    const processed = await processMedia(
      {
        bytes: upload.bytes,
        declaredMime: upload.declaredMime,
        folder: metadata.folder,
        limits: await this.limits(),
      },
      this.processorOptions,
    );
    const id = randomUUID();
    const storageKey = `${metadata.folder}/${id}.${STORAGE_EXTENSIONS[processed.mimeType]}`;
    const reservation: MediaReservation = {
      id,
      uploader_id: actor.id,
      storage_driver: this.config.values.STORAGE_DRIVER,
      storage_location_id: this.storage.activeId,
      storage_key: storageKey,
      public_url: this.publicUrl(storageKey),
      original_name: safeOriginalName(upload.originalName),
      mime_type: processed.mimeType,
      accessibility: metadata.accessibility,
    };
    const operation: HttpOperation = {
      actorScope: actor.id,
      operation: "media.upload",
      key,
      method: "POST",
      path: "/api/v1/media/upload",
      query: {},
      body: { folder: metadata.folder, accessibility: metadata.accessibility },
      fileSha256: createHash("sha256").update(upload.bytes).digest("hex"),
    };
    const receipt = await this.operations.reserve(
      operation,
      async (manager) => {
        // Only a new upload is checked: a retry of a finished one replays its receipt.
        await this.checkQuota(processed.sizeBytes, manager);
        await this.media.reserve(reservation, Date.now(), manager);
        return { pendingResourceId: id };
      },
      (manager, row) => this.reconcile(manager, row),
      async (resourceId) => {
        if (!resourceId) return;
        const asset = await this.media.find(resourceId);
        if (asset && asset.uploader_id !== actor.id) throw new ApiError("NOT_FOUND", 404);
      },
    );
    if (receipt.state === "DONE") return this.replay(actor.id, receipt);
    if (receipt.resource_id !== id) throw new ApiError("OPERATION_PENDING", 409);
    try {
      await this.operations.withLease(receipt.id, () =>
        this.store(reservation, metadata.folder, processed),
      );
    } catch (error) {
      await this.compensate(reservation, receipt.id);
      if (error instanceof ApiError && error.errorCode === "OPERATION_PENDING") throw error;
      throw new ApiError("STORAGE_UNAVAILABLE", 503);
    }
    try {
      await this.operations.complete(receipt.id, async (manager) => {
        await this.media.finishUpload(
          id,
          1,
          {
            size_bytes: processed.sizeBytes,
            width: processed.width,
            height: processed.height,
            duration_ms: processed.durationMs,
          },
          Date.now(),
          manager,
        );
        return { httpStatus: 201, resourceId: id };
      });
    } catch (error) {
      // The stored blob stays tracked by its UPLOADING/FAILED row; never report success here.
      domainError(error);
    }
    const ready = await this.media.find(id);
    if (!ready) throw new ApiError("NOT_FOUND", 404);
    return { httpStatus: 201, response: await this.references.dto(ready, actor.id) };
  }

  /** GET /media — the actor's own READY assets with truthful inUse/canDelete. */
  async list(principal: VerifiedPrincipal, input: unknown) {
    const actor = await this.jwt.current(principal);
    const query = new ZodValidationPipe(mediaQuerySchema).transform(input);
    const page = await this.media.listOwned(actor.id, query);
    return {
      items: page.items.map((row) =>
        this.references.toDto(row, {
          inUse: row.in_use,
          canDelete: MediaReferenceService.deletable(row, actor.id, row.in_use),
        }),
      ),
      meta: page.meta,
    };
  }

  /** Owner READY asset by ID (used by the controller for ETags and by tests). */
  async read(principal: VerifiedPrincipal, id: unknown): Promise<Media> {
    const actor = await this.jwt.current(principal);
    const mediaId = new ZodValidationPipe(uuidSchema).transform(id);
    const row = await this.references.owned(actor.id, mediaId);
    if (row.state !== "READY") throw new ApiError("NOT_FOUND", 404);
    return this.references.dto(row, actor.id);
  }

  /** PATCH /media/:id — owner-only accessibility update guarded by If-Match revision. */
  async updateAccessibility(
    principal: VerifiedPrincipal,
    id: unknown,
    revision: unknown,
    input: unknown,
  ): Promise<Media> {
    const actor = await this.jwt.current(principal);
    const mediaId = new ZodValidationPipe(uuidSchema).transform(id);
    const version = new ZodValidationPipe(revisionSchema).transform(revision);
    const body = new ZodValidationPipe(mediaPatchSchema).transform(input);
    await this.references.owned(actor.id, mediaId);
    let row: MediaRow;
    try {
      row = await this.media.updateAccessibility(
        mediaId,
        actor.id,
        version,
        body.accessibility,
        Date.now(),
      );
    } catch (error) {
      domainError(error);
    }
    return this.references.dto(row, actor.id);
  }
}
