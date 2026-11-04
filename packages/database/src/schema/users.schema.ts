import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function usersSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "users",
      columns: {
        id: { ...t.id, primary: true },
        email: { ...t.string(255) },
        password_hash: { ...t.string(255), select: false },
        name: { ...t.text },
        role: { ...t.string(20), default: "CREATOR" },
        avatar_style: { ...t.string(50), default: "bottts" },
        avatar_seed: { ...t.string(100), default: "kabuki" },
        is_active: { ...t.boolean, default: true },
        auth_version: { ...t.integer, default: 1 },
        revision: { ...t.integer, default: 1 },
        created_at: { ...t.long },
        updated_at: { ...t.long },
      },
      indices: [
        { columns: ["email"], unique: true },
        { columns: ["role", "is_active", "id"], unique: false },
        { columns: ["created_at", "id"], unique: false },
      ],
      foreignKeys: [],
      checks: [
        ...[{ expression: "role IN ('CREATOR','SUPERADMIN')" }],
        ...(driver === "sqlite" ? [{ expression: "is_active IN (0,1)" }] : []),
      ],
    }),
  ];
}
