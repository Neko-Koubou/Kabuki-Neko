import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function runtimeSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "room_allocations",
      columns: {
        id: { ...t.id, primary: true },
        pin_code: { ...t.string(6) },
        host_id: { ...t.id },
        quiz_id: { ...t.id, nullable: true },
        quiz_revision: { ...t.integer },
        creation_snapshot: { ...t.json },
        state_driver: { ...t.string(10) },
        state_namespace: { ...t.string(64) },
        status: { ...t.string(12), default: "CREATING" },
        created_at: { ...t.long },
        expires_at: { ...t.long },
        last_heartbeat_at: { ...t.long },
      },
      indices: [
        { columns: ["pin_code"], unique: true },
        { columns: ["host_id", "status"], unique: false },
        { columns: ["expires_at"], unique: false },
        { columns: ["quiz_id"] },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["host_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
        {
          target: "quizzes",
          columnNames: ["quiz_id"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[{ expression: "status IN ('CREATING','ACTIVE','FINALIZING','CLOSED','LOST')" }],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "room_media",
      columns: {
        session_id: { ...t.id, primary: true },
        media_id: { ...t.id, primary: true },
        created_at: { ...t.long },
      },
      indices: [{ columns: ["session_id"] }, { columns: ["media_id"] }],
      foreignKeys: [
        {
          target: "room_allocations",
          columnNames: ["session_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "media_assets",
          columnNames: ["media_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [...[], ...(driver === "sqlite" ? [] : [])],
    }),
  ];
}
