import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]+$/u)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const boolean = z.enum(["true", "false"]).transform((value) => value === "true");
const nonempty = z.string().min(1);
const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
});
const origin = httpUrl.refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
});
const redisUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["redis:", "rediss:"].includes(url.protocol) && Boolean(url.hostname) && !url.hash;
  } catch {
    return false;
  }
});
function jsonArray<T extends z.ZodType>(item: T) {
  return z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.array(item));
}
const cidr = z.string().refine((value) => {
  const [address, prefix, extra] = value.split("/");
  const family = address ? isIP(address) : 0;
  return (
    !extra &&
    family > 0 &&
    prefix !== undefined &&
    /^\d+$/u.test(prefix) &&
    Number(prefix) <= (family === 4 ? 32 : 128)
  );
});
export const secretValueSchema = z
  .string()
  .min(64)
  .refine(
    (value) =>
      value.trim() === value && !/change.?me|example|sample|secretpassword|your[_ -]/iu.test(value),
    { message: "Invalid secret" },
  );
const optionalPath = z
  .string()
  .transform((value) => (value === "" ? undefined : value))
  .optional();
export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DEPLOYMENT_PROFILE: z.enum(["default", "scale"]),
    DEPLOYMENT_TOPOLOGY: z.enum(["single", "multi"]),
    DEPLOYMENT_INSTANCE_ID: z.uuidv4().regex(/^[0-9a-f-]+$/u),
    API_PORT: integer(1, 65535),
    NEXT_PUBLIC_APP_NAME: nonempty,
    NEXT_PUBLIC_APP_URL: origin,
    NEXT_PUBLIC_API_URL: origin,
    NEXT_PUBLIC_WS_URL: origin,
    APP_URL: origin,
    API_INTERNAL_URL: origin,
    CORS_ORIGIN: z
      .string()
      .transform((value) => value.split(","))
      .pipe(z.array(origin).min(1)),
    JWT_ACCESS_SECRET: secretValueSchema.optional(),
    JWT_REFRESH_SECRET: secretValueSchema.optional(),
    JWT_ACCESS_EXPIRES_IN: z.literal("15m"),
    JWT_REFRESH_EXPIRES_IN: z.literal("7d"),
    APP_SECRET_FILE: nonempty,
    DB_DRIVER: z.enum(["sqlite", "postgres", "mysql"]),
    DB_AUTO_MIGRATE: boolean,
    SQLITE_PATH: nonempty,
    DATABASE_URL: nonempty.optional(),
    DB_POOL_MAX: integer(1, 100),
    STATE_DRIVER: z.enum(["memory", "redis"]),
    REDIS_URL: redisUrl.optional(),
    REDIS_CLUSTER_NODES: jsonArray(redisUrl),
    STATE_NAMESPACE: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    STORAGE_DRIVER: z.enum(["local", "s3"]),
    LOCAL_STORAGE_PATH: nonempty,
    LOCAL_STORAGE_SHARED: boolean,
    STORAGE_LOCATION_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    STORAGE_LOCATIONS_FILE: optionalPath,
    S3_ENDPOINT: httpUrl.optional(),
    S3_REGION: nonempty,
    S3_BUCKET: nonempty,
    S3_ACCESS_KEY: nonempty.optional(),
    S3_SECRET_KEY: nonempty.optional(),
    S3_FORCE_PATH_STYLE: boolean,
    S3_PUBLIC_URL: httpUrl.optional(),
    ALLOW_INSECURE_LOCAL_HTTP: boolean,
    TRUST_PROXY_CIDRS: jsonArray(cidr),
    LOCALE_BUNDLE_PATH: nonempty,
    AUDIO_MANIFEST_PATH: nonempty,
    AUDIT_RETENTION_DAYS: integer(7, 365),
    FINALIZE_CONCURRENCY: integer(1, 8),
    ROOM_MAX_AGE_SEC: integer(3600, 86400),
    MAX_ACTIVE_ROOMS: integer(1, 10000),
  })
  .superRefine((env, ctx) => {
    const invalid = (key: keyof typeof env) =>
      ctx.addIssue({ code: "custom", path: [key], message: "Invalid configuration" });
    if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
      invalid("JWT_REFRESH_SECRET");
    if (env.DEPLOYMENT_TOPOLOGY === "multi") {
      if (env.DB_DRIVER === "sqlite") invalid("DB_DRIVER");
      if (env.STATE_DRIVER !== "redis") invalid("STATE_DRIVER");
      if (env.STORAGE_DRIVER === "local" && !env.LOCAL_STORAGE_SHARED)
        invalid("LOCAL_STORAGE_SHARED");
    }
    if (env.DB_DRIVER !== "sqlite") {
      try {
        const url = new URL(env.DATABASE_URL ?? "");
        if (
          !(env.DB_DRIVER === "postgres" ? ["postgres:", "postgresql:"] : ["mysql:"]).includes(
            url.protocol,
          ) ||
          !url.hostname ||
          url.pathname.length < 2
        )
          invalid("DATABASE_URL");
      } catch {
        invalid("DATABASE_URL");
      }
    }
    if (env.STATE_DRIVER === "redis" && !env.REDIS_URL && env.REDIS_CLUSTER_NODES.length === 0)
      invalid("REDIS_URL");
    if (env.REDIS_URL && env.REDIS_CLUSTER_NODES.length > 0) invalid("REDIS_CLUSTER_NODES");
    if (env.STORAGE_DRIVER === "s3") {
      for (const key of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_PUBLIC_URL"] as const)
        if (!env[key]) invalid(key);
      if (env.S3_ACCESS_KEY === "minioadmin" || env.S3_SECRET_KEY === "minioadmin")
        invalid("S3_SECRET_KEY");
      for (const key of ["S3_ENDPOINT", "S3_PUBLIC_URL"] as const)
        if (env[key] && env[key].startsWith("http:") && !env.ALLOW_INSECURE_LOCAL_HTTP)
          invalid(key);
    }
    if (env.NODE_ENV === "production")
      for (const key of [
        "SQLITE_PATH",
        "APP_SECRET_FILE",
        "LOCAL_STORAGE_PATH",
        "LOCALE_BUNDLE_PATH",
        "AUDIO_MANIFEST_PATH",
      ] as const)
        if (!path.isAbsolute(env[key])) invalid(key);
    if (env.STORAGE_LOCATIONS_FILE && !path.isAbsolute(env.STORAGE_LOCATIONS_FILE))
      invalid("STORAGE_LOCATIONS_FILE");
    if (env.APP_URL !== env.NEXT_PUBLIC_APP_URL) invalid("APP_URL");
  });
export type RuntimeEnvironment = z.infer<typeof environmentSchema>;
export class ConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid configuration fields: ${fields.join(", ")}`);
    this.name = "ConfigurationError";
  }
}
export function parseEnvironment(raw: Record<string, string | undefined>): RuntimeEnvironment {
  const production = raw.NODE_ENV === "production";
  const root = path.resolve(__dirname, "../../../..");
  const scale = raw.DEPLOYMENT_PROFILE === "scale";
  const state = raw.STATE_DRIVER ?? (scale ? "redis" : "memory");
  let hasClusterNodes = false;
  try {
    const nodes: unknown = JSON.parse(raw.REDIS_CLUSTER_NODES ?? "[]");
    hasClusterNodes = Array.isArray(nodes) && nodes.length > 0;
  } catch {
    /* Schema reports malformed JSON without exposing its value. */
  }

  const defaults: Record<string, string | undefined> = {
    NODE_ENV: "development",
    DEPLOYMENT_PROFILE: "default",
    DEPLOYMENT_TOPOLOGY: "single",
    DEPLOYMENT_INSTANCE_ID: randomUUID(),
    API_PORT: raw.PORT ?? "3001",
    NEXT_PUBLIC_APP_NAME: "Kabuki Neko",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:3001",
    NEXT_PUBLIC_WS_URL: "http://localhost:3001",
    APP_URL: raw.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    API_INTERNAL_URL: "http://localhost:3001",
    CORS_ORIGIN: raw.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    JWT_ACCESS_EXPIRES_IN: "15m",
    JWT_REFRESH_EXPIRES_IN: "7d",
    APP_SECRET_FILE: production
      ? "/app/data/runtime-secrets.json"
      : path.join(root, "data/runtime-secrets.json"),
    DB_DRIVER: scale ? "postgres" : "sqlite",
    DB_AUTO_MIGRATE: "true",
    SQLITE_PATH: production
      ? "/app/data/kabuki-neko.sqlite"
      : path.join(root, "data/kabuki-neko.sqlite"),
    DB_POOL_MAX: "20",
    STATE_DRIVER: scale ? "redis" : "memory",
    REDIS_URL: hasClusterNodes
      ? undefined
      : scale
        ? "redis://redis:6379"
        : "redis://localhost:6379",
    REDIS_CLUSTER_NODES: "[]",
    STATE_NAMESPACE: "default",
    STORAGE_DRIVER: scale ? "s3" : "local",
    LOCAL_STORAGE_PATH: production ? "/app/uploads" : path.join(root, "uploads"),
    LOCAL_STORAGE_SHARED: "false",
    STORAGE_LOCATION_ID: "active",
    S3_REGION: "auto",
    S3_BUCKET: "kabuki-neko-media",
    S3_FORCE_PATH_STYLE: "true",
    ALLOW_INSECURE_LOCAL_HTTP: production ? "false" : "true",
    TRUST_PROXY_CIDRS: "[]",
    LOCALE_BUNDLE_PATH: production ? "/app/locales-built" : path.join(root, "locales-built"),
    // Outside production the committed, already optimized audio set is read in place, so the API
    // serves its catalogue without a prior `pnpm build:assets`.
    AUDIO_MANIFEST_PATH: production
      ? "/app/audio/audio-manifest.json"
      : path.join(root, "audio-assets/kabuki-neko-audio/audio-manifest.json"),
    AUDIT_RETENTION_DAYS: "30",
    FINALIZE_CONCURRENCY: "2",
    ROOM_MAX_AGE_SEC: "28800",
    MAX_ACTIVE_ROOMS: state === "redis" ? "200" : "20",
  };
  for (const [key, value] of Object.entries(raw)) if (value !== undefined) defaults[key] = value;
  if (raw.API_PORT !== undefined && raw.PORT !== undefined && raw.API_PORT !== raw.PORT)
    throw new ConfigurationError(["API_PORT", "PORT"]);
  const result = environmentSchema.safeParse(defaults);
  if (!result.success)
    throw new ConfigurationError([
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ]);
  return Object.freeze(result.data);
}
