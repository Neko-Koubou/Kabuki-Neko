export * from "./data-source.factory";
export * from "./schema/column-types";
export { EntitySchema } from "typeorm";
// Domain registry
import type { DatabaseDriver } from "./schema/column-types";
import { settingsSchemas } from "./schema/settings.schema";
import { usersSchemas } from "./schema/users.schema";
import { authSchemas } from "./schema/auth.schema";
import { mediaSchemas } from "./schema/media.schema";
import { quizzesSchemas } from "./schema/quizzes.schema";
import { runtimeSchemas } from "./schema/runtime.schema";
import { jobsSchemas } from "./schema/jobs.schema";
import { reportsSchemas } from "./schema/reports.schema";
export function domainSchemas(driver: DatabaseDriver) {
  return [
    ...settingsSchemas(driver),
    ...usersSchemas(driver),
    ...authSchemas(driver),
    ...mediaSchemas(driver),
    ...quizzesSchemas(driver),
    ...runtimeSchemas(driver),
    ...jobsSchemas(driver),
    ...reportsSchemas(driver),
  ];
}
export { migrateDatabase } from "./migrations/migration-runner";

export * from "./repositories/settings.repository";
export * from "./repositories/users.repository";
export * from "./repositories/auth.repository";
export * from "./repositories/quizzes.repository";
export * from "./repositories/media.repository";
export * from "./repositories/runtime.repository";
export * from "./repositories/jobs.repository";
export * from "./repositories/reports.repository";
export * from "./repositories/operations.repository";
export * from "./repositories/audit.repository";
