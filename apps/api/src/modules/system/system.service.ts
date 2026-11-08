/**
 * Instance settings and storage metrics (SA §4.4 /system/settings, §6.4 cache rules).
 *
 * - Settings reads/writes are SUPERADMIN-only and always use the current database row; a PATCH is
 *   revision-checked (If-Match), strictly validated (no driver or unknown fields) and its
 *   `defaultLocale` must be an installed locale.
 * - Non-security display settings used by public config are cached for at most 5 s and the cache
 *   is invalidated in-process on every successful PATCH (other instances converge within 5 s).
 *   Authentication and registration policy never read this cache.
 * - Storage metrics (READY count/bytes) are cached for 30 s: `fresh` within 30 s, `stale` (last
 *   successful values and their timestamp) when a refresh fails, `unavailable` if never computed.
 *   Metrics failures never prevent settings from being returned.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { MediaRepository, SettingsRepository, type SettingsRow } from "@kabuki-neko/database";
import { CACHE_LIMITS } from "@kabuki-neko/shared/constants/limits";
import {
  settingsPatchSchema,
  settingsResponseSchema,
  settingsSchema,
  storageMetricsSchema,
  type Settings,
} from "@kabuki-neko/shared/schemas/system.schema";
import { revisionSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ApiError } from "../../common/error.filter";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";

/** Installed-locale lookup implemented by the locale registry (TASK-073). */
export abstract class InstalledLocales {
  /** True when `tag` is a registered, servable locale. */
  abstract isInstalled(tag: string): boolean;
}
/** Public, non-security display subset of the settings. */
export interface PublicSettings {
  instanceName: string;
  defaultLocale: string;
  registrationMode: Settings["registrationMode"];
  limits: { imageMb: number; audioMb: number; videoMb: number };
  revision: number;
}
type StorageMetrics = ReturnType<typeof storageMetricsSchema.parse>;

/** Maps a settings row to the API DTO. */
export function settingsDto(row: SettingsRow): Settings {
  return settingsSchema.parse({
    instanceName: row.instance_name,
    registrationMode: row.registration_mode,
    maxImageSizeMb: row.max_image_size_mb,
    maxAudioSizeMb: row.max_audio_size_mb,
    maxVideoSizeMb: row.max_video_size_mb,
    maxPlayersPerRoom: row.max_players_per_room,
    profanityWords: row.profanity_words,
    defaultLocale: row.default_locale,
    revision: row.revision,
    updatedAt: row.updated_at,
  });
}

@Injectable()
export class SystemService {
  private publicCache: { value: PublicSettings; at: number } | undefined;
  private metricsCache: { fileCount: number; totalBytes: number; at: number } | undefined;

  constructor(
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(MediaRepository) private readonly media: MediaRepository,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Optional() @Inject(InstalledLocales) private readonly locales: InstalledLocales | null = null,
  ) {}

  /** Current SUPERADMIN (from the database, never from token claims alone). */
  private async admin(principal: VerifiedPrincipal) {
    const actor = await this.jwt.current(principal);
    if (actor.role !== "SUPERADMIN") throw new ApiError("FORBIDDEN", 403);
    return actor;
  }

  /** READY count/bytes with 30 s freshness; stale/unavailable instead of failing. */
  async metrics(): Promise<StorageMetrics> {
    const now = Date.now();
    if (this.metricsCache && now - this.metricsCache.at <= CACHE_LIMITS.metricsMs)
      return storageMetricsSchema.parse({
        fileCount: this.metricsCache.fileCount,
        totalBytes: this.metricsCache.totalBytes,
        checkedAt: this.metricsCache.at,
        status: "fresh",
      });
    try {
      const value = await this.media.readyMetrics();
      this.metricsCache = { ...value, at: Date.now() };
      return storageMetricsSchema.parse({
        ...value,
        checkedAt: this.metricsCache.at,
        status: "fresh",
      });
    } catch {
      if (this.metricsCache)
        return storageMetricsSchema.parse({
          fileCount: this.metricsCache.fileCount,
          totalBytes: this.metricsCache.totalBytes,
          checkedAt: this.metricsCache.at,
          status: "stale",
        });
      return storageMetricsSchema.parse({
        fileCount: 0,
        totalBytes: 0,
        checkedAt: now,
        status: "unavailable",
      });
    }
  }

  /** GET /system/settings — current settings plus storage metrics (SUPERADMIN). */
  async read(principal: VerifiedPrincipal) {
    await this.admin(principal);
    const row = await this.settings.current();
    return settingsResponseSchema.parse({
      settings: settingsDto(row),
      metrics: await this.metrics(),
    });
  }

  /**
   * PATCH /system/settings — strict partial update guarded by revision. Returns the new settings
   * and whether the registration policy changed (for the audit trail).
   */
  async update(principal: VerifiedPrincipal, revision: unknown, input: unknown) {
    const actor = await this.admin(principal);
    const version = new ZodValidationPipe(revisionSchema).transform(revision);
    const patch = new ZodValidationPipe(settingsPatchSchema).transform(input);
    if (patch.defaultLocale !== undefined && !this.locales?.isInstalled(patch.defaultLocale))
      throw new ApiError("INVALID_LOCALE", 422, {}, [
        { path: "defaultLocale", code: "INVALID_LOCALE", params: {}, severity: "error" },
      ]);
    const before = await this.settings.current();
    let row: SettingsRow;
    try {
      row = await this.settings.patch(version, patch, Date.now());
    } catch (error) {
      if (error instanceof Error && error.message === "REVISION_CONFLICT")
        throw new ApiError("REVISION_CONFLICT", 409, {
          expectedRevision: version,
          currentRevision: (await this.settings.current()).revision,
        });
      throw error;
    }
    this.invalidate();
    return {
      actorId: actor.id,
      settings: settingsDto(row),
      registrationChanged: before.registration_mode !== row.registration_mode,
    };
  }

  /** Non-security display settings, cached for at most 5 s. */
  async publicSettings(): Promise<PublicSettings> {
    const now = Date.now();
    if (this.publicCache && now - this.publicCache.at < CACHE_LIMITS.publicConfigMs)
      return this.publicCache.value;
    const row = await this.settings.current();
    const value: PublicSettings = {
      instanceName: row.instance_name,
      defaultLocale: row.default_locale,
      registrationMode: row.registration_mode,
      limits: {
        imageMb: row.max_image_size_mb,
        audioMb: row.max_audio_size_mb,
        videoMb: row.max_video_size_mb,
      },
      revision: row.revision,
    };
    this.publicCache = { value, at: Date.now() };
    return value;
  }

  /** Drops the public display cache (called after every successful settings mutation). */
  invalidate(): void {
    this.publicCache = undefined;
  }
}
