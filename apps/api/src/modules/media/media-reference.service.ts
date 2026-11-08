/**
 * Media reference protocol shared by upload, library, metadata, delete and cleanup (SA §7.1).
 *
 * Attaching media (quiz writes) and deleting it both lock the same `media_assets` row in the
 * database layer: attach requires READY under that lock, delete marks DELETING only when no quiz
 * cover, question or active room pin references it. This service is the API-side view of that
 * protocol: it answers "is it in use / may this actor delete it" and resolves library access.
 * Library access is strictly by uploader — a creator whose quiz retains another creator's media
 * (for example a duplicated PUBLIC quiz) may play/host it but never sees it in their library,
 * edits its metadata or deletes it.
 */
import { Inject, Injectable } from "@nestjs/common";
import { MediaRepository, type MediaRow } from "@kabuki-neko/database";
import { mediaSchema, type Media } from "@kabuki-neko/shared/schemas/media.schema";
import { ApiError } from "../../common/error.filter";

/** Reference state of one asset as seen by its owner. */
export interface MediaReferenceState {
  inUse: boolean;
  canDelete: boolean;
}

@Injectable()
export class MediaReferenceService {
  constructor(@Inject(MediaRepository) private readonly media: MediaRepository) {}

  /** Whether a row may be deleted by `actorId`: owner, deletable state and no references. */
  static deletable(row: MediaRow, actorId: string, inUse: boolean): boolean {
    return (
      row.uploader_id === actorId && (row.state === "READY" || row.state === "FAILED") && !inUse
    );
  }

  /** Reference state for many rows at once (one query per reference table). */
  async states(
    rows: readonly MediaRow[],
    actorId: string,
  ): Promise<Map<string, MediaReferenceState>> {
    const used = await this.media.referenced(rows.map((row) => row.id));
    return new Map(
      rows.map((row) => {
        const inUse = used.has(row.id);
        return [row.id, { inUse, canDelete: MediaReferenceService.deletable(row, actorId, inUse) }];
      }),
    );
  }

  /**
   * Loads an asset for library operations. Anything not uploaded by the actor is reported as
   * missing (404), so retained foreign references never disclose another creator's library.
   */
  async owned(actorId: string, id: string): Promise<MediaRow> {
    const row = await this.media.find(id);
    if (!row || row.uploader_id !== actorId) throw new ApiError("NOT_FOUND", 404);
    return row;
  }

  /** Allowlisted Media DTO with truthful `inUse`/`canDelete` for the owner. */
  toDto(row: MediaRow, state: MediaReferenceState): Media {
    return mediaSchema.parse({
      id: row.id,
      uploaderId: row.uploader_id,
      storageDriver: row.storage_driver,
      publicUrl: row.public_url,
      originalName: row.original_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
      accessibility: row.accessibility,
      revision: row.revision,
      createdAt: row.created_at,
      inUse: state.inUse,
      canDelete: state.canDelete,
    });
  }

  /** Convenience: DTO for a single row with its current reference state. */
  async dto(row: MediaRow, actorId: string): Promise<Media> {
    const state = (await this.states([row], actorId)).get(row.id) ?? {
      inUse: false,
      canDelete: false,
    };
    return this.toDto(row, state);
  }
}
