import "reflect-metadata";
import { randomInt } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { DataSource, type DataSourceOptions, type EntityManager } from "typeorm";
import type { DatabaseDriver } from "./schema/column-types";

export interface DatabaseConfiguration {
  driver: DatabaseDriver;
  sqlitePath?: string;
  url?: string;
  poolMax?: number;
}
export function createDataSource(
  config: DatabaseConfiguration,
  entities: NonNullable<DataSourceOptions["entities"]> = [],
): DataSource {
  const base = { entities, synchronize: false, logging: false, migrationsRun: false } as const;
  if (config.driver === "sqlite") {
    if (!config.sqlitePath) throw new Error("SQLite path required");
    return new DataSource({
      ...base,
      type: "better-sqlite3",
      database: config.sqlitePath,
      prepareDatabase: (database) => {
        database.pragma("foreign_keys = ON");
        database.pragma("journal_mode = WAL");
        database.pragma("busy_timeout = 5000");
      },
    });
  }
  if (!config.url) throw new Error("Database URL required");
  const parsed = new URL(config.url);
  if (
    !(config.driver === "postgres" ? ["postgres:", "postgresql:"] : ["mysql:"]).includes(
      parsed.protocol,
    )
  )
    throw new Error("Database URL driver mismatch");
  const pool = config.poolMax ?? 20;
  if (!Number.isInteger(pool) || pool < 1 || pool > 100) throw new Error("Invalid database pool");
  return config.driver === "postgres"
    ? new DataSource({
        ...base,
        type: "postgres",
        url: config.url,
        poolSize: pool,
        extra: { options: "-c timezone=UTC" },
      })
    : new DataSource({
        ...base,
        type: "mysql",
        connectorPackage: "mysql2",
        url: config.url,
        timezone: "Z",
        charset: "utf8mb4_bin",
        supportBigNumbers: true,
        bigNumberStrings: true,
        extra: { connectionLimit: pool },
      });
}
function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (
    "code" in error &&
    ["40001", "40P01", "ER_LOCK_DEADLOCK", "SQLITE_BUSY"].includes(String(error.code))
  )
    return true;
  return "driverError" in error && retryable(error.driverError);
}
const sqliteQueues = new WeakMap<DataSource, Promise<void>>();
/** Callback must keep external side effects outside the transaction; retries rerun it. */
export async function writeTransaction<T>(
  source: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const sqlite = source.options.type === "better-sqlite3";
  let unlock: (() => void) | undefined;
  if (sqlite) {
    const previous = sqliteQueues.get(source) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    sqliteQueues.set(source, current);
    await previous;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      const runner = source.createQueryRunner();
      const originalQuery = runner.query;
      try {
        await runner.connect();
        if (sqlite) {
          runner.query = new Proxy(originalQuery, {
            apply(target, receiver, args: unknown[]) {
              if (args[0] === "BEGIN TRANSACTION") args[0] = "BEGIN IMMEDIATE";
              return Reflect.apply(target, receiver, args);
            },
          });
        }
        await runner.startTransaction(sqlite ? undefined : "READ COMMITTED");
        const result = await work(runner.manager);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        if (attempt >= 3 || !retryable(error)) throw error;
        await setTimeout(randomInt(25, 101));
      } finally {
        runner.query = originalQuery;
        await runner.release();
      }
    }
  } finally {
    unlock?.();
  }
}
/** Lock a parent row inside writeTransaction; SQLite already reserves the writer. */
export async function lockParent(
  manager: EntityManager,
  entity: string,
  id: string,
): Promise<void> {
  const query = manager.createQueryBuilder(entity, "parent").where("parent.id = :id", { id });
  if (manager.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
  if (!(await query.getOne())) throw new Error("Parent resource not found");
}
