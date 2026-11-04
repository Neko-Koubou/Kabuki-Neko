import { parseEnvironment } from "../apps/api/src/config/env.schema";
import { createDataSource, domainSchemas, migrateDatabase } from "../packages/database/src";
async function main() {
  const env = parseEnvironment(process.env);
  const db = createDataSource(
    {
      driver: env.DB_DRIVER,
      sqlitePath: env.SQLITE_PATH,
      poolMax: env.DB_POOL_MAX,
      ...(env.DATABASE_URL ? { url: env.DATABASE_URL } : {}),
    },
    domainSchemas(env.DB_DRIVER),
  );
  await db.initialize();
  try {
    await migrateDatabase(db, env.DB_AUTO_MIGRATE);
  } finally {
    await db.destroy();
  }
}
void main().catch(() => {
  console.error("Database migration failed");
  process.exitCode = 1;
});
