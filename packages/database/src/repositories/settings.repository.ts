import type { DataSource, EntityManager } from "typeorm";
import { lockParent, writeTransaction } from "../data-source.factory";
import { settingsPatchSchema, type Settings } from "@kabuki-neko/shared";
export interface SettingsRow {
  id: string;
  initialized: boolean;
  instance_name: string;
  registration_mode: Settings["registrationMode"];
  max_image_size_mb: number;
  max_audio_size_mb: number;
  max_video_size_mb: number;
  max_players_per_room: number;
  profanity_words: string[];
  default_locale: string;
  revision: number;
  updated_at: number;
}
export async function lockSettings(manager: EntityManager) {
  await lockParent(manager, "system_settings", "global");
  return manager.getRepository<SettingsRow>("system_settings").findOneByOrFail({ id: "global" });
}
export class SettingsRepository {
  constructor(private readonly db: DataSource) {}
  current() {
    return this.db.getRepository<SettingsRow>("system_settings").findOneByOrFail({ id: "global" });
  }
  async patch(revision: number, input: unknown, now: number) {
    const fields = settingsPatchSchema.parse(input);
    return writeTransaction(this.db, async (manager) => {
      const row = await lockSettings(manager);
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      const updated: SettingsRow = {
        ...row,
        instance_name: fields.instanceName ?? row.instance_name,
        registration_mode: fields.registrationMode ?? row.registration_mode,
        max_image_size_mb: fields.maxImageSizeMb ?? row.max_image_size_mb,
        max_audio_size_mb: fields.maxAudioSizeMb ?? row.max_audio_size_mb,
        max_video_size_mb: fields.maxVideoSizeMb ?? row.max_video_size_mb,
        max_players_per_room: fields.maxPlayersPerRoom ?? row.max_players_per_room,
        profanity_words: fields.profanityWords ?? row.profanity_words,
        default_locale: fields.defaultLocale ?? row.default_locale,
        revision: row.revision + 1,
        updated_at: now,
      };
      return manager.getRepository<SettingsRow>("system_settings").save(updated);
    });
  }
}
