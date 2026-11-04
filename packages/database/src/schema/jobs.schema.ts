import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function jobsSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "finalization_jobs",
      columns: {
        session_id: { ...t.id, primary: true },
        host_id: { ...t.id },
        payload: { ...t.json },
        payload_hash: { ...t.string(64) },
        state: { ...t.string(10), default: "PENDING" },
        attempts: { ...t.integer, default: 0 },
        next_attempt_at: { ...t.long },
        lease_owner: { ...t.id, nullable: true },
        lease_until: { ...t.long, nullable: true },
        last_error_code: { ...t.string(64), nullable: true },
        created_at: { ...t.long },
        updated_at: { ...t.long },
        completed_at: { ...t.long, nullable: true },
      },
      indices: [
        { columns: ["state", "next_attempt_at", "lease_until"], unique: false },
        { columns: ["session_id"] },
        { columns: ["host_id"] },
      ],
      foreignKeys: [
        {
          target: "room_allocations",
          columnNames: ["session_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
        {
          target: "users",
          columnNames: ["host_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[{ expression: "state IN ('PENDING','RUNNING','FAILED','READY')" }],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
  ];
}
