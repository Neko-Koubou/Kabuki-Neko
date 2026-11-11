/**
 * TASK-178 backup and restore per SQL dialect (SA §10.3; US-15, US-16, US-17, US-20).
 *
 * For SQLite, PostgreSQL 16 and MySQL 8.4, the built API runs with local uploads and memory game
 * state. The backup commands of docs/operations.md are executed exactly as documented, against
 * the test's own database:
 * - SQLite's online backup API while the API runs;
 * - pg_dump/pg_restore and mysqldump/mysql inside the database container.
 *
 * Each case then:
 * 1. backs up the database, the media blobs, `runtime-secrets.json` and the storage-origin
 *    ledger, after a quiz with an uploaded image, a finished game with a durable report and a
 *    live in-memory room exist;
 * 2. changes the instance after the backup: a new quiz, and a new sign-in (refresh session);
 * 3. stops the API, restores all four parts and starts a new API process;
 * 4. checks that:
 *    - the instance, the quiz and its media reference are back;
 *    - the media file is served again;
 *    - the report is byte-for-byte the same;
 *    - the post-backup quiz is gone;
 *    - the pre-backup access token still verifies (restored secrets);
 *    - the post-backup refresh session is refused (session policy);
 *    - the live room is reported lost (recovery limit).
 * PostgreSQL additionally shows that switching DB_DRIVER moves no data: the same runtime on SQLite
 * starts uninitialized. Every documented command used here must appear verbatim in the guide.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StartedMySqlContainer } from "@testcontainers/mysql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GameClient, PASSWORD, createRoom, quizWith, until, uploadImage } from "../helpers/game";
import {
  createTestRuntime,
  httpClient,
  startApi,
  type ApiProcess,
  type TestRuntime,
} from "../helpers/runtime";

jest.setTimeout(600_000);

const ROOT = path.resolve(__dirname, "../..");
const run = promisify(execFile);

/** SQLite online backup (docs/operations.md), destination as the first script argument. */
const SQLITE_BACKUP =
  'const {createRequire}=require("node:module");const Database=createRequire(require.resolve("@kabuki-neko/database"))("better-sqlite3");new Database(process.env.SQLITE_PATH,{readonly:true}).backup(process.argv[1]).then(()=>console.log("sqlite backup complete"))';
/** Documented PostgreSQL commands for `user`/`db`. */
const pgDump = (user: string, db: string) =>
  `pg_dump -U ${user} -d ${db} --format=custom --file=/tmp/kabuki.pgdump`;
const pgRestore = (user: string, db: string) =>
  `pg_restore -U ${user} -d ${db} --clean --if-exists --no-owner /tmp/kabuki.pgdump`;
/** Documented MySQL commands for `user`/`db` (password through MYSQL_PWD). */
const mysqlDump = (user: string, db: string) =>
  `mysqldump --single-transaction --routines --triggers --no-tablespaces -u ${user} --result-file=/tmp/kabuki.sql ${db}`;
const mysqlRestore = (user: string, db: string) =>
  `mysql -u ${user} ${db} -e "source /tmp/kabuki.sql"`;

/** One database engine with the documented backup and restore for it. */
interface Engine {
  env: Record<string, string>;
  backup: (runtime: TestRuntime, directory: string) => Promise<void>;
  restore: (runtime: TestRuntime, directory: string) => Promise<void>;
}

/** Runs a shell command in a database container and fails with its output on a non-zero exit. */
async function inContainer(
  container: StartedPostgreSqlContainer | StartedMySqlContainer,
  command: string,
) {
  const result = await container.exec(["sh", "-c", command]);
  if (result.exitCode !== 0) throw new Error(`${command.split(" ")[0]} failed: ${result.output}`);
}

/** Engine setup for `driver`, starting its container when needed. */
async function engine(
  runtime: TestRuntime,
  driver: "sqlite" | "postgres" | "mysql",
): Promise<Engine> {
  if (driver === "sqlite") {
    const database = runtime.env["SQLITE_PATH"] ?? "";
    return {
      env: { DB_DRIVER: "sqlite" },
      backup: async (_runtime, directory) => {
        const { stdout } = await run(
          process.execPath,
          ["-e", SQLITE_BACKUP, path.join(directory, "kabuki-neko.sqlite")],
          {
            cwd: path.join(ROOT, "apps/api"),
            env: { ...process.env, SQLITE_PATH: database },
          },
        );
        expect(stdout).toContain("sqlite backup complete");
      },
      restore: async (_runtime, directory) => {
        await cp(path.join(directory, "kabuki-neko.sqlite"), database);
        await rm(`${database}-wal`, { force: true });
        await rm(`${database}-shm`, { force: true });
      },
    };
  }
  if (driver === "postgres") {
    const container = await runtime.postgres();
    const [user, db] = [container.getUsername(), container.getDatabase()];
    return {
      env: { DB_DRIVER: "postgres", DATABASE_URL: container.getConnectionUri() },
      backup: () => inContainer(container, pgDump(user, db)),
      restore: () => inContainer(container, pgRestore(user, db)),
    };
  }
  const container = await runtime.mysql();
  const [user, db, password] = [
    container.getUsername(),
    container.getDatabase(),
    container.getUserPassword(),
  ];
  return {
    env: { DB_DRIVER: "mysql", DATABASE_URL: container.getConnectionUri() },
    backup: () => inContainer(container, `MYSQL_PWD='${password}' ${mysqlDump(user, db)}`),
    restore: () => inContainer(container, `MYSQL_PWD='${password}' ${mysqlRestore(user, db)}`),
  };
}

it("documents every command this test runs, verbatim", async () => {
  const guide = await readFile(path.join(ROOT, "docs/operations.md"), "utf8");
  for (const command of [
    SQLITE_BACKUP,
    pgDump("kabuki", "kabuki"),
    pgRestore("kabuki", "kabuki"),
    mysqlDump("kabuki", "kabuki"),
    mysqlRestore("kabuki", "kabuki"),
  ])
    expect({ command, documented: guide.includes(command) }).toEqual({ command, documented: true });
});

describe.each(["sqlite", "postgres", "mysql"] as const)("backup and restore on %s", (driver) => {
  let runtime: TestRuntime;
  let api: ApiProcess | undefined;
  let backupDir = "";

  afterAll(async () => {
    await api?.stop();
    await runtime?.cleanup();
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  });

  it("restores quiz, media references, history and secrets from one consistent backup", async () => {
    runtime = await createTestRuntime();
    // As in production defaults: no explicit JWT secrets, so the API generates and persists them
    // in runtime-secrets.json (part of the backup).
    delete runtime.env["JWT_ACCESS_SECRET"];
    delete runtime.env["JWT_REFRESH_SECRET"];
    const database = await engine(runtime, driver);
    const env = {
      ...database.env,
      // One stable public origin: the storage ledger pins it across processes.
      NEXT_PUBLIC_API_URL: "http://localhost:3001",
      TRUST_PROXY_CIDRS: '["127.0.0.1/32","::1/128"]',
    };
    api = await startApi(runtime, env);
    let call = httpClient(api.base);
    const setup = await call("/auth/setup", {
      method: "POST",
      ip: "10.12.0.1",
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        instanceName: "Cadangan",
        name: "Admin",
        email: "admin@example.org",
        password: PASSWORD,
      },
    });
    expect(setup.status).toBe(201);
    const token = (setup.json as { accessToken: string }).accessToken;

    // Content before the backup: an image, a quiz using it, a finished game and a live room.
    const image = await uploadImage(api, token);
    const quiz = await quizWith(call, token, "Sebelum Cadangan", [
      {
        type: "SINGLE_CHOICE",
        prompt: "Gambar?",
        options: [["Ya", true], ["Tidak"]],
        mediaId: image.id,
      },
    ]);
    const mediaList = (await call("/media?page=1&limit=24", { token })).json as {
      items: { id: string; publicUrl: string }[];
    };
    const mediaPath = new URL(mediaList.items.find((item) => item.id === image.id)?.publicUrl ?? "")
      .pathname;
    const host = await GameClient.connect(api.url, token);
    const finished = await createRoom(host, quiz);
    expect((await host.emit("host:end_game", { ...finished, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );
    const status = async (sessionId: string) =>
      ((await call(`/reports/${sessionId}/status`, { token })).json as { status?: string } | null)
        ?.status ?? null;
    expect(await until(() => status(finished.sessionId), "ready", 60_000)).toBe("ready");
    const report = (await call(`/reports/${finished.sessionId}`, { token })).text;
    const live = await createRoom(host, quiz);
    host.close();

    // Backup, in the documented order: database first (online), then blobs, secrets and ledger.
    backupDir = await mkdtemp(path.join(tmpdir(), "kabuki-backup-"));
    await database.backup(runtime, backupDir);
    await cp(path.join(runtime.directory, "uploads"), path.join(backupDir, "uploads"), {
      recursive: true,
    });
    await cp(
      path.join(runtime.directory, "runtime-secrets.json"),
      path.join(backupDir, "runtime-secrets.json"),
    );
    await cp(
      path.join(runtime.directory, "storage-origins"),
      path.join(backupDir, "storage-origins"),
      { recursive: true },
    );

    // Changes after the backup point.
    const later = await quizWith(call, token, "Setelah Cadangan", [
      { type: "SINGLE_CHOICE", prompt: "Baru?", options: [["Ya", true], ["Tidak"]] },
    ]);
    const signIn = await call("/auth/login", {
      method: "POST",
      ip: "10.12.0.2",
      body: { email: "admin@example.org", password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    const laterCookie = signIn.cookie ?? "";
    expect(laterCookie).toMatch(/^refresh_token=/u);

    // Restore all four parts with the API stopped, then start a new process.
    await api.stop();
    await database.restore(runtime, backupDir);
    await rm(path.join(runtime.directory, "uploads"), { recursive: true, force: true });
    await cp(path.join(backupDir, "uploads"), path.join(runtime.directory, "uploads"), {
      recursive: true,
    });
    await cp(
      path.join(backupDir, "runtime-secrets.json"),
      path.join(runtime.directory, "runtime-secrets.json"),
    );
    await rm(path.join(runtime.directory, "storage-origins"), { recursive: true, force: true });
    await cp(
      path.join(backupDir, "storage-origins"),
      path.join(runtime.directory, "storage-origins"),
      { recursive: true },
    );
    api = await startApi(runtime, env);
    call = httpClient(api.base);

    expect(
      ((await call("/auth/setup-status")).json as { isInitialized: boolean }).isInitialized,
    ).toBe(true);
    // Restored secrets: a token issued before the backup still verifies.
    expect((await call("/auth/me", { token })).status).toBe(200);
    // Content and media references are back, the blob is served, history is identical.
    const restored = (await call(`/quizzes/${quiz.id}`, { token })).json as {
      questions: { mediaId: string | null }[];
    };
    expect(restored.questions[0]?.mediaId).toBe(image.id);
    expect((await fetch(`${api.url}${mediaPath}`)).status).toBe(200);
    expect((await call(`/reports/${finished.sessionId}`, { token })).text).toBe(report);
    // Nothing after the backup point survives.
    expect((await call(`/quizzes/${later.id}`, { token })).status).toBe(404);
    // Session policy: a refresh session created after the backup does not exist any more.
    const refreshed = await call("/auth/refresh", {
      method: "POST",
      ip: "10.12.0.3",
      body: {},
      cookie: laterCookie,
    });
    expect(refreshed.status).toBe(401);
    // Recovery limit: the in-memory room cannot be restored and is reported lost.
    expect(await until(() => status(live.sessionId), "lost", 60_000)).toBe("lost");

    if (driver === "postgres") {
      // A driver switch moves no data: the same runtime on SQLite is a new, empty instance.
      await api.stop();
      const sqliteEnv = Object.fromEntries(
        Object.entries({ ...env, DB_DRIVER: "sqlite" }).filter(([key]) => key !== "DATABASE_URL"),
      );
      const switched = await startApi(runtime, sqliteEnv);
      try {
        const fresh = await httpClient(switched.base)("/auth/setup-status");
        expect((fresh.json as { isInitialized: boolean }).isInitialized).toBe(false);
      } finally {
        await switched.stop();
      }
      api = undefined;
    }
  });
});
