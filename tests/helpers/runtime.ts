import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MySqlContainer } from "@testcontainers/mysql";
import { RedisContainer } from "@testcontainers/redis";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { startRedisCluster, type RedisClusterFixture } from "./redis-cluster";

const marker = ".kabuki-test-owned";
const prefix = "kabuki-neko-test-";

// Official MinIO images were withdrawn; build the security release from pinned upstream source.
const minioCommit = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a";
const minioDockerfile = `FROM golang:1.27.3-bookworm AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
RUN git init . && git remote add origin https://github.com/minio/minio.git && git fetch --depth=1 origin ${minioCommit} && git checkout --detach FETCH_HEAD
RUN go build -trimpath -o /out/minio . && mkdir -p /out/data
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/minio /usr/bin/minio
COPY --from=build /src/LICENSE /LICENSE
COPY --from=build --chown=65532:65532 /out/data /data
USER 65532:65532
WORKDIR /data
EXPOSE 9000
ENTRYPOINT ["/usr/bin/minio"]
`;

export async function removeTestDirectory(directory: string): Promise<void> {
  const parent = await realpath(tmpdir());
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) {
    throw new Error("Refusing to remove a directory outside this test run");
  }
  if ((await readFile(path.join(resolved, marker), "utf8")) !== path.basename(resolved)) {
    throw new Error("Test directory ownership marker does not match");
  }
  await rm(resolved, { recursive: true, force: false });
}

export async function createTestRuntime() {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(directory, marker), path.basename(directory), { mode: 0o600 });
  const containers: StartedTestContainer[] = [];
  /** Extra fixtures (Compose projects) removed by `cleanup`, newest first. */
  const deferred: (() => Promise<void>)[] = [];
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;
  const env: Record<string, string> = {
    NODE_ENV: "test",
    DEPLOYMENT_PROFILE: "default",
    DB_DRIVER: "sqlite",
    SQLITE_PATH: path.join(directory, "test.sqlite"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_PATH: path.join(directory, "uploads"),
    STATE_DRIVER: "memory",
    APP_SECRET_FILE: path.join(directory, "runtime-secrets.json"),
    JWT_ACCESS_SECRET: randomBytes(64).toString("hex"),
    JWT_REFRESH_SECRET: randomBytes(64).toString("hex"),
    LOCALE_BUNDLE_PATH: path.join(directory, "locales-built"),
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    disposed = true;
    cleanupPromise = (async () => {
      const results = [
        ...(await Promise.allSettled(deferred.reverse().map((stop) => stop()))),
        ...(await Promise.allSettled(containers.reverse().map((c) => c.stop()))),
      ];
      await removeTestDirectory(directory);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Test container cleanup failed");
    })();
    return cleanupPromise;
  };
  async function start<T extends StartedTestContainer>(
    startContainer: () => Promise<T>,
  ): Promise<T> {
    if (disposed) throw new Error("Test runtime already disposed");
    try {
      const container = await startContainer();
      if (disposed) {
        await container.stop();
        throw new Error("Test runtime disposed during container startup");
      }
      containers.push(container);
      return container;
    } catch (error: unknown) {
      await cleanup();
      throw error;
    }
  }
  return {
    directory,
    env,
    cleanup,
    postgres: () =>
      start(() =>
        new PostgreSqlContainer("postgres:16-alpine")
          .withDatabase("kabuki_test")
          .withUsername("kabuki_test")
          .withPassword(randomBytes(24).toString("hex"))
          .start(),
      ),
    mysql: () =>
      start(() =>
        new MySqlContainer("mysql:8.4")
          .withDatabase("kabuki_test")
          .withUsername("kabuki_test")
          .withUserPassword(randomBytes(24).toString("hex"))
          .withRootPassword(randomBytes(24).toString("hex"))
          .start(),
      ),
    redis: () => start(() => new RedisContainer("redis:7-alpine").start()),
    /** Six-node Redis 7 Cluster from `docker/docker-compose.test-cluster.yml`, removed by cleanup. */
    redisCluster: async (): Promise<RedisClusterFixture> => {
      if (disposed) throw new Error("Test runtime already disposed");
      const cluster = await startRedisCluster();
      deferred.push(() => cluster.stop());
      return cluster;
    },
    minio: async () => {
      const accessKeyId = `test${randomBytes(8).toString("hex")}`;
      const secretAccessKey = randomBytes(32).toString("hex");
      const container = await start(async () => {
        // A prebuilt image of the same pinned source (e.g. built where `docker build` needs an
        // extra CA for a TLS-intercepting proxy) can be supplied instead of building here.
        const prebuilt = process.env["KABUKI_TEST_MINIO_IMAGE"];
        if (prebuilt)
          return new GenericContainer(prebuilt)
            .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
            .withCommand(["server", "/data"])
            .withExposedPorts(9000)
            .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
            .start();
        const context = await mkdtemp(path.join(directory, "minio-build-"));
        await writeFile(path.join(context, "Dockerfile"), minioDockerfile);
        const image = await GenericContainer.fromDockerfile(context)
          .withCache(true)
          .build(`kabuki-neko/minio-test:${minioCommit.slice(0, 12)}-go1.27.3`, {
            deleteOnExit: false,
          });
        return image
          .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
          .withCommand(["server", "/data"])
          .withExposedPorts(9000)
          .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
          .start();
      });
      const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
      const client = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
      const bucket = `test-${randomBytes(8).toString("hex")}`;
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error: unknown) {
        await cleanup();
        throw error;
      } finally {
        client.destroy();
      }
      return { container, endpoint, bucket, accessKeyId, secretAccessKey };
    },
  };
}

/** Database engines every integration matrix runs against. */
export const DB_DRIVERS = ["sqlite", "postgres", "mysql"] as const;
/** One database engine. */
export type DbDriver = (typeof DB_DRIVERS)[number];

/** Test runtime returned by {@link createTestRuntime}. */
export type TestRuntime = Awaited<ReturnType<typeof createTestRuntime>>;

/**
 * Environment for `driver`: SQLite uses the runtime's file; PostgreSQL 16 and MySQL 8.4 start a
 * real container owned by the runtime (stopped by its cleanup). Never falls back to another engine.
 */
export async function databaseEnv(
  runtime: TestRuntime,
  driver: DbDriver,
): Promise<Record<string, string>> {
  if (driver === "sqlite") return { DB_DRIVER: "sqlite" };
  const container = driver === "postgres" ? await runtime.postgres() : await runtime.mysql();
  return { DB_DRIVER: driver, DATABASE_URL: container.getConnectionUri() };
}

/** A free loopback TCP port. */
export async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** A running API process from `apps/api/dist`. */
export interface ApiProcess {
  /** REST base, e.g. `http://127.0.0.1:1234/api/v1`. */
  base: string;
  /** Server origin (sockets), e.g. `http://127.0.0.1:1234`. */
  url: string;
  /** Everything the process wrote to stdout/stderr so far (for redaction checks). */
  logs: () => string;
  stop: () => Promise<void>;
  /** Crash simulation: SIGKILL, no shutdown hooks; resolves once the process is gone. */
  kill: () => Promise<void>;
  /** Exit code once exited (null while running). */
  exitCode: () => number | null;
}

/**
 * Starts the built API (`apps/api/dist/main.js`) with the runtime env plus `extra`, waits until
 * `/auth/setup-status` answers, and captures its output. Startup failure stops the process and
 * includes the output in the error (secrets in it are the generated test ones).
 */
export async function startApi(
  runtime: TestRuntime,
  extra: Record<string, string> = {},
): Promise<ApiProcess> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, [path.join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: {
      ...process.env,
      ...runtime.env,
      API_PORT: String(port),
      PORT: String(port),
      // Local uploads are served from this process, so their public URLs point at it.
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port}`,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const url = `http://127.0.0.1:${port}`;
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  const exitCode = () => child.exitCode;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${url}/api/v1/auth/setup-status`)).status === 200)
        return { base: `${url}/api/v1`, url, logs: () => output.join(""), stop, kill, exitCode };
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error(`API did not start:\n${output.join("").slice(-4000)}`);
}

/** Browser origin the test API accepts by default (`CORS_ORIGIN`). */
export const TEST_ORIGIN = "http://localhost:3000";

/** Options of one {@link httpClient} request. */
export interface HttpRequest {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw `refresh_token=…` cookie pair. */
  cookie?: string;
  /** Simulated client address (`X-Forwarded-For`, trusted only from loopback when configured). */
  ip?: string;
}

/** JSON client for the test API with the web client's Origin and client header by default. */
export function httpClient(base: string) {
  return async function call(path: string, options: HttpRequest = {}) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "X-Kabuki-Client": "web-v1",
        Origin: TEST_ORIGIN,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.ip ? { "X-Forwarded-For": options.ip } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    /** Parsed JSON body, or null for empty or non-JSON bodies (CSV, files). */
    const parse = (): unknown => {
      try {
        return text ? (JSON.parse(text) as unknown) : null;
      } catch {
        return null;
      }
    };
    const json = parse();
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? null;
    return { status: response.status, json, text, cookie, headers: response.headers };
  };
}

/** Synthetic fixture messages are for boot tests, never release translations. */
export async function createSyntheticCatalog(
  directory: string,
  contractsFile: string,
): Promise<string> {
  const contracts: unknown = JSON.parse(await readFile(contractsFile, "utf8"));
  if (typeof contracts !== "object" || contracts === null || Array.isArray(contracts)) {
    throw new Error("Invalid message contracts");
  }
  const namespaces: Record<string, Record<string, { type: 0 | 1 | 2 | 3; value: string }[]>> = {};
  for (const [key, contract] of Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b))) {
    const [namespace, ...parts] = key.split(".");
    if (
      !namespace ||
      ![
        "common",
        "auth",
        "quizzes",
        "studio",
        "media",
        "host",
        "player",
        "reports",
        "admin",
        "validation",
        "accessibility",
        "about",
      ].includes(namespace) ||
      parts.length === 0 ||
      !/^[a-zA-Z0-9.]+$/.test(parts.join("."))
    )
      throw new Error("Invalid contract key");
    if (typeof contract !== "object" || contract === null || !("placeholders" in contract))
      throw new Error("Invalid message contract");
    const placeholders = contract.placeholders;
    if (typeof placeholders !== "object" || placeholders === null || Array.isArray(placeholders))
      throw new Error("Invalid placeholders");
    const args = Object.entries(placeholders).map(([name, type]) => {
      if (
        !/^[A-Za-z][A-Za-z0-9]*$/.test(name) ||
        !["string", "number", "date"].includes(String(type))
      )
        throw new Error("Invalid placeholder");
      return {
        type: (type === "string" ? 1 : type === "number" ? 2 : 3) as 1 | 2 | 3,
        value: name,
      };
    });
    (namespaces[namespace] ??= {})[parts.join(".")] = [{ type: 0, value: `Test ${key} ` }, ...args];
  }
  const buildId = createHash("sha256").update(JSON.stringify(namespaces)).digest("hex");
  const entries = [];
  for (const [name, messages] of Object.entries(namespaces)) {
    const content = JSON.stringify(messages);
    const destination = path.join(directory, buildId, "en");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, `${name}.json`), content);
    entries.push({
      name,
      url: `/locales/${buildId}/en/${name}.json`,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  await writeFile(
    path.join(directory, "registry.json"),
    JSON.stringify({
      buildId,
      catalogVersion: "1",
      locales: [
        {
          tag: "en",
          nativeName: "Test English",
          direction: "ltr",
          packageVersion: "1.0.0",
          coverage: 1,
          catalogVersion: "1",
          namespaces: entries,
        },
      ],
    }),
  );
  await writeFile(
    path.join(directory, "TEST_FIXTURE.txt"),
    "Synthetic test messages; not release translations.\n",
  );
  return buildId;
}

export default async function teardownBrowserRuntime(): Promise<void> {
  const directory = process.env["KABUKI_E2E_RUNTIME_DIR"];
  if (directory) await removeTestDirectory(directory);
}
