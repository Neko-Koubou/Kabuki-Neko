import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import { createTestRuntime } from "../helpers/runtime";
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s serializes startup, resumes missing version, rejects checksum drift",
  async (driver) => {
    const runtime = await createTestRuntime();
    try {
      const url =
        driver === "postgres"
          ? (await runtime.postgres()).getConnectionUri()
          : driver === "mysql"
            ? (await runtime.mysql()).getConnectionUri()
            : undefined;
      const make = () =>
        createDataSource(
          { driver, sqlitePath: runtime.env.SQLITE_PATH ?? ":memory:", ...(url ? { url } : {}) },
          domainSchemas(driver),
        );
      const first = make(),
        second = make();
      try {
        await first.initialize();
        await second.initialize();
        await expect(migrateDatabase(first, false)).rejects.toThrow("migration required");
        if (driver === "mysql") {
          await first.query("CREATE TABLE users (wrong_id INTEGER PRIMARY KEY)");
          await expect(migrateDatabase(first, true)).rejects.toThrow();
          expect(await first.query("SELECT version FROM kabuki_schema_versions")).toEqual([]);
          expect(await first.query("SELECT id FROM system_settings")).toEqual([]);
          await first.query("DROP TABLE users");
        }
        await Promise.all([migrateDatabase(first, true), migrateDatabase(second, true)]);
        await migrateDatabase(first, false);
        expect(await first.query("SELECT version FROM kabuki_schema_versions")).toEqual([
          { version: 1 },
        ]);
        await first.query("DELETE FROM kabuki_schema_versions");
        await migrateDatabase(first, true);
        await first.query("UPDATE kabuki_schema_versions SET checksum='drift'");
        await expect(migrateDatabase(second, true)).rejects.toThrow("checksum mismatch");
      } finally {
        if (first.isInitialized) await first.destroy();
        if (second.isInitialized) await second.destroy();
      }
    } finally {
      await runtime.cleanup();
    }
  },
);
