import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function settingsSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "system_settings",
      columns: {
        id: { ...t.string(36), primary: true, default: "global" },
        initialized: { ...t.boolean, default: false },
        instance_name: { ...t.text, default: "Kabuki Neko" },
        registration_mode: { ...t.string(20), default: "PUBLIC" },
        max_image_size_mb: { ...t.integer, default: 5 },
        max_audio_size_mb: { ...t.integer, default: 10 },
        max_video_size_mb: { ...t.integer, default: 25 },
        max_players_per_room: { ...t.integer, default: 200 },
        profanity_words: { ...t.json, default: "[]" },
        default_locale: { ...t.string(63), default: "id" },
        revision: { ...t.integer, default: 1 },
        updated_at: { ...t.long },
      },
      indices: [],
      foreignKeys: [],
      checks: [
        ...[
          { expression: "id = 'global'" },
          { expression: "registration_mode IN ('SINGLE_ADMIN','INVITE_ONLY','PUBLIC')" },
          { expression: "max_players_per_room BETWEEN 1 AND 5000" },
          { expression: "max_image_size_mb BETWEEN 1 AND 25" },
          { expression: "max_audio_size_mb BETWEEN 1 AND 100" },
          { expression: "max_video_size_mb BETWEEN 1 AND 250" },
        ],
        ...(driver === "sqlite" ? [{ expression: "initialized IN (0,1)" }] : []),
      ],
    }),
  ];
}
