import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigService } from "./config.service";
import { ConfigurationError, parseEnvironment } from "./env.schema";
import { SecretsService } from "./secrets.service";
const secret = () => randomBytes(64).toString("hex");
const scaleInput = {
  DEPLOYMENT_PROFILE: "scale",
  DATABASE_URL: "postgresql://test:database-password@database:5432/quiz",
  S3_ENDPOINT: "https://storage.example.test",
  S3_PUBLIC_URL: "https://media.example.test/bucket",
  S3_ACCESS_KEY: "test-access",
  S3_SECRET_KEY: "test-storage-secret",
};

describe("configuration boundaries", () => {
  it("provides zero-config single-instance defaults and profile defaults only when absent", () => {
    const env = parseEnvironment({ NODE_ENV: "test" });
    expect(env.DB_DRIVER).toBe("sqlite");
    expect(env.STATE_DRIVER).toBe("memory");
    expect(env.STORAGE_DRIVER).toBe("local");
    expect(env.MAX_ACTIVE_ROOMS).toBe(20);
    expect(path.isAbsolute(env.APP_SECRET_FILE)).toBe(true);
    expect(parseEnvironment(scaleInput)).toMatchObject({
      DB_DRIVER: "postgres",
      STATE_DRIVER: "redis",
      STORAGE_DRIVER: "s3",
      MAX_ACTIVE_ROOMS: 200,
    });
    expect(
      parseEnvironment({
        DEPLOYMENT_PROFILE: "scale",
        DB_DRIVER: "sqlite",
        STATE_DRIVER: "memory",
        STORAGE_DRIVER: "local",
      }).DB_DRIVER,
    ).toBe("sqlite");
    expect(parseEnvironment({ PORT: "43101" }).API_PORT).toBe(43101);
    expect(() => parseEnvironment({ PORT: "43101", API_PORT: "3001" })).toThrow(ConfigurationError);
  });
  it.each([
    { API_PORT: "1e3" },
    { API_PORT: "" },
    { DB_POOL_MAX: "1.5" },
    { MAX_ACTIVE_ROOMS: "10001" },
    { DB_AUTO_MIGRATE: "yes" },
    { DB_DRIVER: "oracle" },
    { JWT_ACCESS_EXPIRES_IN: "30m" },
    { ROOM_MAX_AGE_SEC: "-1" },
    { TRUST_PROXY_CIDRS: '["10.0.0.1/33"]' },
    { TRUST_PROXY_CIDRS: '["::1/129"]' },
    { NODE_ENV: "production", SQLITE_PATH: "./data.db" },
  ])("rejects malformed environment %j", (input) => {
    expect(() => parseEnvironment(input)).toThrow(ConfigurationError);
  });
  it("validates CIDRs/Redis cluster settings and driver-specific requirements", () => {
    expect(
      parseEnvironment({ TRUST_PROXY_CIDRS: '["10.0.0.0/8","2001:db8::/32"]' }).TRUST_PROXY_CIDRS,
    ).toHaveLength(2);
    const cluster = parseEnvironment({
      STATE_DRIVER: "redis",
      REDIS_CLUSTER_NODES: '["rediss://redis.example.test:6379"]',
    });
    expect(cluster.REDIS_URL).toBeUndefined();
    expect(cluster.REDIS_CLUSTER_NODES).toHaveLength(1);
    expect(parseEnvironment({ STATE_DRIVER: "redis", REDIS_CLUSTER_NODES: "[ ]" }).REDIS_URL).toBe(
      "redis://localhost:6379",
    );
    expect(() =>
      parseEnvironment({
        STATE_DRIVER: "redis",
        REDIS_URL: "redis://localhost:6379",
        REDIS_CLUSTER_NODES: '["redis://node:6379"]',
      }),
    ).toThrow(ConfigurationError);
    expect(() => parseEnvironment({ DB_DRIVER: "postgres" })).toThrow(ConfigurationError);
    expect(() => parseEnvironment({ ...scaleInput, DB_DRIVER: "mysql" })).toThrow(
      ConfigurationError,
    );
    expect(() => parseEnvironment({ ...scaleInput, S3_SECRET_KEY: "minioadmin" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      parseEnvironment({ ...scaleInput, NODE_ENV: "production", S3_ENDPOINT: "http://minio:9000" }),
    ).toThrow(ConfigurationError);
    expect(
      parseEnvironment({
        ...scaleInput,
        NODE_ENV: "production",
        S3_ENDPOINT: "http://minio:9000",
        ALLOW_INSECURE_LOCAL_HTTP: "true",
      }).S3_ENDPOINT,
    ).toBe("http://minio:9000");
  });
  it("rejects unsupported multi-instance topology without silently choosing other drivers", () => {
    expect(() => parseEnvironment({ DEPLOYMENT_TOPOLOGY: "multi" })).toThrow(ConfigurationError);
    expect(() =>
      parseEnvironment({ ...scaleInput, DEPLOYMENT_TOPOLOGY: "multi", STATE_DRIVER: "memory" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseEnvironment({ ...scaleInput, DEPLOYMENT_TOPOLOGY: "multi", STORAGE_DRIVER: "local" }),
    ).toThrow(ConfigurationError);
    expect(
      parseEnvironment({
        ...scaleInput,
        DEPLOYMENT_TOPOLOGY: "multi",
        STORAGE_DRIVER: "local",
        LOCAL_STORAGE_SHARED: "true",
      }).STORAGE_DRIVER,
    ).toBe("local");
  });
  it("rejects sample/equal secrets and redacts malformed URL credentials in errors", () => {
    for (const value of ["short", "change_me_to_a_secure_64_char_random_string_access".repeat(2)])
      expect(() => parseEnvironment({ JWT_ACCESS_SECRET: value })).toThrow(ConfigurationError);
    const same = secret();
    expect(() => parseEnvironment({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })).toThrow(
      ConfigurationError,
    );
    const credential = "do-not-log-this-password";
    try {
      parseEnvironment({
        DB_DRIVER: "postgres",
        DATABASE_URL: `invalid://user:${credential}@host/db`,
      });
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(credential);
    }
    expect(() => parseEnvironment({ CORS_ORIGIN: "*" })).toThrow(ConfigurationError);
    expect(() =>
      parseEnvironment({ NEXT_PUBLIC_API_URL: "https://user:password@example.test" }),
    ).toThrow(ConfigurationError);
  });
});
describe("persistent runtime secrets", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kabuki-config-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const service = new SecretsService();
  function env(extra: Record<string, string> = {}) {
    return parseEnvironment({
      NODE_ENV: "test",
      APP_SECRET_FILE: path.join(directory, "runtime-secrets.json"),
      ...extra,
    });
  }
  it("concurrently initializes one complete0600 file and preserves it across restarts", async () => {
    const config = env();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => new SecretsService().load(config)),
    );
    expect(new Set(results.map((value) => value.accessSecret)).size).toBe(1);
    expect(results[0]?.accessSecret).toHaveLength(128);
    expect(results[0]?.accessSecret).not.toBe(results[0]?.refreshSecret);
    expect(await service.load(config)).toEqual(results[0]);
    expect((await stat(config.APP_SECRET_FILE)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["runtime-secrets.json"]);
    expect(JSON.parse(await readFile(config.APP_SECRET_FILE, "utf8"))).toMatchObject({
      version: 1,
    });
  });
  it("never replaces corrupt, permissive or symlinked secret files", async () => {
    const config = env();
    await writeFile(config.APP_SECRET_FILE, "{broken", { mode: 0o600 });
    await expect(service.load(config)).rejects.toThrow("Invalid runtime secret file");
    expect(await readFile(config.APP_SECRET_FILE, "utf8")).toBe("{broken");
    await writeFile(
      config.APP_SECRET_FILE,
      JSON.stringify({ version: 1, accessSecret: secret(), refreshSecret: secret() }),
    );
    await chmod(config.APP_SECRET_FILE, 0o644);
    await expect(service.load(config)).rejects.toThrow("Invalid runtime secret file");
    const alias = path.join(directory, "alias.json");
    await symlink(config.APP_SECRET_FILE, alias);
    await expect(service.load(env({ APP_SECRET_FILE: alias }))).rejects.toThrow("cannot be opened");
  });
  it("uses explicit distinct env overrides without creating a file and redacts config serialization", async () => {
    const access = secret(),
      refresh = secret();
    const config = await ConfigService.load({
      NODE_ENV: "test",
      APP_SECRET_FILE: path.join(directory, "unused.json"),
      JWT_ACCESS_SECRET: access,
      JWT_REFRESH_SECRET: refresh,
    });
    expect(config.secrets).toEqual({ accessSecret: access, refreshSecret: refresh });
    expect(await readdir(directory)).toEqual([]);
    expect(JSON.stringify(config)).not.toContain(access);
    expect(JSON.stringify(config)).not.toContain(refresh);
    expect(config.get("DB_DRIVER")).toBe("sqlite");
  });
  it("does not auto-generate per-node secrets for multi-instance startup", async () => {
    const config = env({ ...scaleInput, DEPLOYMENT_TOPOLOGY: "multi" });
    await expect(service.load(config)).rejects.toThrow("shared pre-provisioned secrets");
    expect(await readdir(directory)).toEqual([]);
    const single = await service.load(env());
    expect(await service.load(config)).toEqual(single);
  });
});
