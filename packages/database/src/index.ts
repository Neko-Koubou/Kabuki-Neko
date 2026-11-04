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
export function domainSchemas(driver: DatabaseDriver) {
  return [
    ...settingsSchemas(driver),
    ...usersSchemas(driver),
    ...authSchemas(driver),
    ...mediaSchemas(driver),
    ...quizzesSchemas(driver),
  ];
}
