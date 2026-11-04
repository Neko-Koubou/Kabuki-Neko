import { setTimeout as delay } from "node:timers/promises";
import type { DataSource, QueryRunner } from "typeorm";
import { initialMigration as sqlite } from "./sqlite/0001-initial";
import { initialMigration as postgres } from "./postgres/0001-initial";
import { initialMigration as mysql } from "./mysql/0001-initial";

const migrationTable = "kabuki_schema_versions";
async function claim(r: QueryRunner, kind: "sqlite" | "postgres" | "mysql") {
  const deadline = Date.now() + 60_000;
  do {
    if (kind === "postgres") {
      const rows: { locked: boolean }[] = await r.query(
        "SELECT pg_try_advisory_lock(1262636619) AS locked",
      );
      if (rows[0]?.locked) return;
    } else if (kind === "mysql") {
      const rows: { locked: number | string | null }[] = await r.query(
        "SELECT GET_LOCK(CONCAT('kabuki:',SHA2(DATABASE(),224)),60) AS locked",
      );
      if (Number(rows[0]?.locked) === 1) return;
      break;
    } else {
      try {
        await r.query("BEGIN EXCLUSIVE");
        return;
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "SQLITE_BUSY"
        ))
          throw error;
      }
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Migration lock timed out");
}
async function runLocked(r: QueryRunner, kind: "sqlite" | "postgres" | "mysql", auto: boolean) {
  const migration = { sqlite, postgres, mysql }[kind];
  if (!(await r.hasTable(migrationTable))) {
    if (!auto) throw new Error("Database schema migration required");
    await r.query(
      "CREATE TABLE kabuki_schema_versions (version INTEGER PRIMARY KEY, checksum VARCHAR(64) NOT NULL)",
    );
  }
  const rows: { version: number; checksum: string }[] = await r.query(
    "SELECT version,checksum FROM kabuki_schema_versions ORDER BY version",
  );
  if (rows.length) {
    if (
      rows.length !== 1 ||
      rows[0]?.version !== migration.version ||
      rows[0].checksum !== migration.checksum
    )
      throw new Error("Database schema version or checksum mismatch");
    return;
  }
  if (!auto) throw new Error("Database schema migration required");
  await migration.up(r);
  const args = kind === "postgres" ? "$1,$2" : "?,?";
  await r.query("INSERT INTO kabuki_schema_versions (version,checksum) VALUES (" + args + ")", [
    migration.version,
    migration.checksum,
  ]);
}
export async function migrateDatabase(source: DataSource, auto: boolean): Promise<void> {
  const type = source.options.type;
  if (type !== "better-sqlite3" && type !== "mysql" && type !== "postgres")
    throw new Error("Unsupported migration driver");
  const kind = type === "better-sqlite3" ? "sqlite" : type;
  const r = source.createQueryRunner();
  try {
    await r.connect();
    await claim(r, kind);
    try {
      if (kind === "postgres") await r.startTransaction();
      await runLocked(r, kind, auto);
      if (kind === "sqlite") await r.query("COMMIT");
      if (kind === "postgres") await r.commitTransaction();
    } catch (error) {
      if (kind === "sqlite") await r.query("ROLLBACK");
      if (r.isTransactionActive) await r.rollbackTransaction();
      throw error;
    } finally {
      if (kind === "postgres") await r.query("SELECT pg_advisory_unlock(1262636619)");
      if (kind === "mysql")
        await r.query("SELECT RELEASE_LOCK(CONCAT('kabuki:',SHA2(DATABASE(),224)))");
    }
  } finally {
    await r.release();
  }
}
