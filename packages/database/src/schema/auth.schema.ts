import { EntitySchema } from "typeorm";
import { columnTypes, type DatabaseDriver } from "./column-types";
export function authSchemas(driver: DatabaseDriver) {
  const t = columnTypes(driver);
  return [
    new EntitySchema({
      name: "refresh_tokens",
      columns: {
        id: { ...t.id, primary: true },
        user_id: { ...t.id },
        family_id: { ...t.id },
        token_hash: { ...t.string(64), select: false },
        issued_at: { ...t.long },
        expires_at: { ...t.long },
        consumed_at: { ...t.long, nullable: true },
        revoked_at: { ...t.long, nullable: true },
        replaced_by_id: { ...t.id, nullable: true },
      },
      indices: [
        { columns: ["token_hash"], unique: true },
        { columns: ["user_id", "family_id"], unique: false },
        { columns: ["expires_at"], unique: false },
        { columns: ["replaced_by_id"] },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["user_id"],
          referencedColumnNames: ["id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
        {
          target: "refresh_tokens",
          columnNames: ["replaced_by_id"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [...[], ...(driver === "sqlite" ? [] : [])],
    }),
    new EntitySchema({
      name: "invitations",
      columns: {
        id: { ...t.id, primary: true },
        created_by: { ...t.id },
        code_hash: { ...t.string(64), select: false },
        created_at: { ...t.long },
        expires_at: { ...t.long },
        used_at: { ...t.long, nullable: true },
        used_by: { ...t.id, nullable: true },
        revoked_at: { ...t.long, nullable: true },
      },
      indices: [
        { columns: ["code_hash"], unique: true },
        { columns: ["created_at", "id"], unique: false },
        { columns: ["expires_at"], unique: false },
        { columns: ["created_by"] },
        { columns: ["used_by"] },
      ],
      foreignKeys: [
        {
          target: "users",
          columnNames: ["created_by"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
        {
          target: "users",
          columnNames: ["used_by"],
          referencedColumnNames: ["id"],
          onDelete: "SET NULL",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [...[], ...(driver === "sqlite" ? [] : [])],
    }),
    new EntitySchema({
      name: "audit_events",
      columns: {
        id: { ...t.id, primary: true },
        settings_id: { ...t.string(36), default: "global" },
        occurred_at: { ...t.long },
        actor_type: { ...t.string(10) },
        actor_id: { ...t.string(36), nullable: true },
        action: { ...t.string(80) },
        resource_id: { ...t.string(100), nullable: true },
        outcome: { ...t.string(10) },
        correlation_id: { ...t.id },
        error_code: { ...t.string(64), nullable: true },
      },
      indices: [
        { columns: ["occurred_at", "id"], unique: false },
        { columns: ["actor_id", "occurred_at"], unique: false },
        { columns: ["settings_id"] },
      ],
      foreignKeys: [
        {
          target: "system_settings",
          columnNames: ["settings_id"],
          referencedColumnNames: ["id"],
          onDelete: "RESTRICT",
          onUpdate: "NO ACTION",
        },
      ],
      checks: [
        ...[
          { expression: "actor_type IN ('USER','GUEST','SYSTEM','ANONYMOUS')" },
          { expression: "outcome IN ('SUCCESS','DENIED','FAILURE')" },
        ],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
    new EntitySchema({
      name: "request_dedup",
      columns: {
        id: { ...t.id, primary: true },
        actor_scope: { ...t.string(80) },
        operation: { ...t.string(100) },
        key: { ...t.id },
        request_hash: { ...t.string(64) },
        state: { ...t.string(10), default: "PENDING" },
        http_status: { ...t.integer, nullable: true },
        response_json: { ...t.json, nullable: true },
        resource_id: { ...t.string(100), nullable: true },
        created_at: { ...t.long },
        expires_at: { ...t.long },
        lease_until: { ...t.long, nullable: true },
      },
      indices: [
        { columns: ["actor_scope", "operation", "key"], unique: true },
        { columns: ["expires_at"], unique: false },
      ],
      foreignKeys: [],
      checks: [
        ...[{ expression: "state IN ('PENDING','DONE')" }],
        ...(driver === "sqlite" ? [] : []),
      ],
    }),
  ];
}
