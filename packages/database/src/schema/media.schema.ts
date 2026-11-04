import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function mediaSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "media_assets",
      columns: {
        id: { ...t.id, primary: true },
        uploader_id: { ...t.id },
        storage_driver: { ...t.string(10) },
        storage_location_id: { ...t.string(64) },
        storage_key: { ...t.string(500) },
        public_url: { ...t.string(1000) },
        original_name: { ...t.text },
        mime_type: { ...t.string(100) },
        size_bytes: { ...t.long },
        width: { ...t.integer, nullable: true },
        height: { ...t.integer, nullable: true },
        duration_ms: { ...t.long, nullable: true },
        state: { ...t.string(12), default: "UPLOADING" },
        accessibility: {
          ...t.json,
          default: '{"altText":null,"transcript":null,"captions":[],"visualDescription":null}',
        },
        revision: { ...t.integer, default: 1 },
        created_at: { ...t.long },
        updated_at: { ...t.long },
      },
      indices: [
        { columns: ["storage_key"], unique: true },
        { columns: ["uploader_id", "created_at", "id"], unique: false },
        { columns: ["state", "created_at", "id"], unique: false },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["uploader_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          { expression: "state IN ('UPLOADING','READY','DELETING','FAILED')" },
          { expression: "width > 0" },
          { expression: "height > 0" },
          { expression: "duration_ms >= 0" },
          { expression: "size_bytes >= 0" },
        ],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
  ];
}
