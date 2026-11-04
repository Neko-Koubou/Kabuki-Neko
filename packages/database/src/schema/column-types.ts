import type { EntitySchemaColumnOptions, ValueTransformer } from "typeorm";
export type DatabaseDriver = "sqlite" | "postgres" | "mysql";
export function safeInteger(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint")
    throw new RangeError("Invalid database integer");
  if (typeof value === "string" && !/^-?\d+$/u.test(value))
    throw new RangeError("Invalid database integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError("Unsafe database integer");
  return number;
}
export const integerTransformer: ValueTransformer = {
  to: (value: unknown) => (value === null ? null : safeInteger(value)),
  from: (value: unknown) => (value === null ? null : safeInteger(value)),
};
export const jsonTransformer: ValueTransformer = {
  to(value: unknown): string {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError("Invalid JSON value");
    return result;
  },
  from(value: unknown): unknown {
    if (typeof value !== "string") throw new TypeError("Invalid database JSON");
    return JSON.parse(value) as unknown;
  },
};
export const booleanTransformer: ValueTransformer = {
  to(value: unknown): number {
    if (typeof value !== "boolean") throw new TypeError("Invalid boolean");
    return value ? 1 : 0;
  },
  from(value: unknown): boolean {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    throw new TypeError("Invalid database boolean");
  },
};
export function columnTypes(driver: DatabaseDriver) {
  return {
    id: {
      type: driver === "postgres" ? "uuid" : "varchar",
      ...(driver === "postgres" ? {} : { length: 36 }),
      ...(driver === "mysql" ? { charset: "ascii", collation: "ascii_bin" } : {}),
    },
    string: (length: number): EntitySchemaColumnOptions => ({
      type: "varchar",
      length,
      ...(driver === "mysql" ? { charset: "utf8mb4", collation: "utf8mb4_bin" } : {}),
    }),
    text: { type: driver === "mysql" ? "longtext" : "text" },
    json: { type: driver === "mysql" ? "longtext" : "text", transformer: jsonTransformer },
    integer: { type: driver === "mysql" ? "int" : "integer", transformer: integerTransformer },
    long: { type: driver === "sqlite" ? "integer" : "bigint", transformer: integerTransformer },
    boolean: {
      type: driver === "sqlite" ? "integer" : "boolean",
      ...(driver === "postgres" ? {} : { transformer: booleanTransformer }),
    },
  } satisfies Record<
    string,
    EntitySchemaColumnOptions | ((length: number) => EntitySchemaColumnOptions)
  >;
}
