/**
 * TASK-177 cold start, restart and migration of the real Compose deployment (SA §10.2; US-01,
 * US-06, US-12, US-16, US-17).
 *
 * Each profile runs as its own Compose project (`kn-it-<random>`) on free loopback ports, from
 * the production images (`kabuki-neko-api:<tag>`, `kabuki-neko-web:<tag>`;
 * KABUKI_TEST_IMAGE_TAG, default `local`, built with `--build` when missing). Teardown is
 * `docker compose -p <that project> down -v`, which removes only volumes labelled with that
 * project, never unrelated ones. KABUKI_TEST_MINIO_IMAGE can supply the MinIO built from the same
 * pinned source.
 *
 * Default profile (SQLite, memory state, local uploads):
 * - Cold start to healthy with the default drivers, all files owned by uid 10001, and runtime
 *   secrets generated with mode 0600.
 * - Setup, a quiz and an uploaded image the host can download from the public URL.
 * - A finished game whose report is durable, and a live room.
 * - After recreating the API container:
 *   - the same instance remains, and the earlier access token is still valid (persisted secrets);
 *   - the quiz, media and report survive;
 *   - the in-memory room is reported lost (never fabricated).
 * - The browser bundle (pages and every referenced script) holds neither the generated secrets
 *   nor any server credential name.
 *
 * Scale profile (PostgreSQL, Redis, S3 on MinIO):
 * - secrets-init and minio-init complete. Generated files are 0400 with per-service owners, the
 *   API reaches postgres/redis/s3, and the bucket serves objects anonymously but refuses
 *   anonymous listing and writes.
 * - Two extra API containers migrate one fresh database at the same time: the advisory lock lets
 *   exactly one apply each migration while the other waits, and both become healthy.
 * - Recreating the API keeps the shared JWT secrets and the media.
 * - The browser bundle holds no S3 key or database password.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { GameClient, PASSWORD, createRoom, quizWith, until, uploadImage } from "../helpers/game";
import { freePort, httpClient, type ApiProcess } from "../helpers/runtime";

jest.setTimeout(900_000);

const ROOT = path.resolve(__dirname, "../..");
const COMPOSE = path.join(ROOT, "docker/docker-compose.yml");
const TAG = process.env["KABUKI_TEST_IMAGE_TAG"] ?? "local";
const run = promisify(execFile);

/** One isolated Compose project on free ports. */
interface Project {
  name: string;
  env: Record<string, string>;
  ports: { web: number; api: number; media: number };
  profile: "default" | "scale";
}

/** Runs `docker compose` for `project`; returns stdout (throws with stderr on failure). */
async function compose(project: Project, args: string[]): Promise<string> {
  const profile = project.profile === "scale" ? ["--profile", "scale"] : [];
  const { stdout } = await run(
    "docker",
    ["compose", "-f", COMPOSE, "-p", project.name, ...profile, ...args],
    {
      cwd: ROOT,
      env: { ...process.env, ...project.env },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout;
}

/** True when the image exists locally. */
async function imageExists(image: string): Promise<boolean> {
  return run("docker", ["image", "inspect", image]).then(
    () => true,
    () => false,
  );
}

/** A new project definition for `profile` on free ports. */
async function project(profile: "default" | "scale"): Promise<Project> {
  const ports = { web: await freePort(), api: await freePort(), media: await freePort() };
  const env: Record<string, string> = {
    DEPLOYMENT_PROFILE: profile,
    KN_IMAGE_TAG: TAG,
    KN_BIND_ADDRESS: "127.0.0.1",
    KN_WEB_PORT: String(ports.web),
    KN_API_PORT: String(ports.api),
    KN_MEDIA_PORT: String(ports.media),
    // The test clients present this origin (tests/helpers/runtime TEST_ORIGIN).
    KN_PUBLIC_URL: "http://localhost:3000",
    KN_API_PUBLIC_URL: `http://127.0.0.1:${ports.api}`,
    KN_MEDIA_PUBLIC_URL: `http://127.0.0.1:${ports.media}/kabuki-neko-media`,
  };
  if (profile === "scale") env["ALLOW_INSECURE_LOCAL_HTTP"] = "true";
  if (process.env["KABUKI_TEST_MINIO_IMAGE"])
    env["KN_MINIO_IMAGE"] = process.env["KABUKI_TEST_MINIO_IMAGE"];
  return { name: `kn-it-${randomUUID().slice(0, 8)}`, env, ports, profile };
}

/** Starts `p` and waits for the API and web containers to be healthy. */
async function up(p: Project, extra: string[] = []) {
  const built =
    (await imageExists(`kabuki-neko-api:${TAG}`)) && (await imageExists(`kabuki-neko-web:${TAG}`));
  await compose(p, ["up", "-d", ...(built ? ["--no-build"] : ["--build"]), ...extra]);
  for (const service of ["api", "web"])
    expect(await until(() => health(p, service), "healthy", 240_000)).toBe("healthy");
}

/** Health status of a service's container. */
async function health(p: Project, service: string): Promise<string> {
  const id = (await compose(p, ["ps", "-q", service])).trim();
  if (!id) return "missing";
  return (await run("docker", ["inspect", "-f", "{{.State.Health.Status}}", id])).stdout.trim();
}

/** Runs a shell command inside a running service container (as its own user unless `user`). */
async function exec(p: Project, service: string, command: string, user?: string) {
  return compose(p, [
    "exec",
    "-T",
    ...(user ? ["--user", user] : []),
    service,
    "sh",
    "-c",
    command,
  ]);
}

/** HTTP client for the project's API (as the browser reaches it). */
const api = (p: Project) => httpClient(`http://127.0.0.1:${p.ports.api}/api/v1`);

/** First-run setup; returns the administrator's access token. */
async function setup(p: Project): Promise<string> {
  const response = await api(p)("/auth/setup", {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
    body: { instanceName: "Deploy", name: "Admin", email: "admin@example.org", password: PASSWORD },
  });
  if (response.status !== 201) throw new Error(`setup failed: ${response.text}`);
  return (response.json as { accessToken: string }).accessToken;
}

/** Uploads an image; returns its id and browser URL. */
async function media(p: Project, token: string) {
  const uploaded = await uploadImage(
    { base: `http://127.0.0.1:${p.ports.api}/api/v1` } as ApiProcess,
    token,
  );
  const listed = await api(p)("/media?page=1&limit=24", { token });
  const item = (listed.json as { items: { id: string; publicUrl: string }[] }).items.find(
    (entry) => entry.id === uploaded.id,
  );
  if (!item) throw new Error("uploaded media not listed");
  return item;
}

/** Every secret-looking value and server credential name must be absent from the web bundle. */
async function expectCleanBundle(p: Project, secrets: string[]) {
  const base = `http://127.0.0.1:${p.ports.web}`;
  const documents = await Promise.all(
    ["/", "/join", "/login", "/register", "/about"].map((route) =>
      fetch(`${base}${route}`).then((r) => r.text()),
    ),
  );
  const scripts = new Set(
    documents.flatMap((html) =>
      [...html.matchAll(/\/_next\/static\/[^"'\s]+\.js/gu)].map((m) => m[0]),
    ),
  );
  expect(scripts.size).toBeGreaterThan(3);
  const bodies = [
    ...documents,
    ...(await Promise.all([...scripts].map((src) => fetch(`${base}${src}`).then((r) => r.text())))),
  ];
  for (const body of bodies) {
    for (const secret of secrets) expect(body.includes(secret)).toBe(false);
    for (const name of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "DATABASE_URL",
      "S3_SECRET_KEY",
      "S3_ACCESS_KEY",
      "runtime-secrets",
    ])
      expect({ name, found: body.includes(name) }).toEqual({ name, found: false });
  }
}

const projects: Project[] = [];
afterAll(async () => {
  // Only this run's projects, and only their own (project-labelled) volumes.
  for (const p of projects)
    await compose(p, ["down", "-v", "--remove-orphans"]).catch(() => undefined);
});

describe("default profile", () => {
  it("cold-starts, keeps data and secrets across a recreate, and loses only in-memory rooms", async () => {
    const p = await project("default");
    projects.push(p);
    await up(p);
    const healthJson = (await api(p)("/system/health")).json as Record<string, unknown>;
    expect(healthJson).toMatchObject({
      status: "ok",
      dbDriver: "sqlite",
      stateDriver: "memory",
      storageDriver: "local",
    });
    // Non-root, owned data, private generated secrets.
    expect((await exec(p, "api", "id -u")).trim()).toBe("10001");
    expect(
      (await exec(p, "api", "stat -c '%u %a' /app/data /app/uploads")).trim().split("\n"),
    ).toEqual(["10001 755", "10001 755"]);
    const token = await setup(p);
    expect((await exec(p, "api", "stat -c '%u %a' /app/data/runtime-secrets.json")).trim()).toBe(
      "10001 600",
    );
    const generated = JSON.parse(
      await exec(p, "api", "cat /app/data/runtime-secrets.json"),
    ) as Record<string, unknown>;
    const secretValues = Object.values(generated).filter(
      (value): value is string => typeof value === "string" && value.length >= 32,
    );
    expect(secretValues.length).toBeGreaterThan(0);

    // Content, media reachable by the browser, a finished game and a live room.
    const image = await media(p, token);
    expect(image.publicUrl.startsWith(`http://127.0.0.1:${p.ports.api}/`)).toBe(true);
    expect((await fetch(image.publicUrl)).status).toBe(200);
    const quiz = await quizWith(api(p), token, "Kuis Penerapan", [
      {
        type: "SINGLE_CHOICE",
        prompt: "Siap?",
        options: [["Ya", true], ["Tidak"]],
        mediaId: image.id,
      },
    ]);
    const host = await GameClient.connect(`http://127.0.0.1:${p.ports.api}`, token);
    const finished = await createRoom(host, quiz);
    expect((await host.emit("host:end_game", { ...finished, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );
    const status = async (sessionId: string) =>
      ((await api(p)(`/reports/${sessionId}/status`, { token })).json as { status?: string } | null)
        ?.status ?? null;
    expect(await until(() => status(finished.sessionId), "ready", 60_000)).toBe("ready");
    const live = await createRoom(host, quiz);
    host.close();

    // Recreate the API container (same volumes, new process).
    await compose(p, ["up", "-d", "--no-build", "--force-recreate", "api"]);
    expect(await until(() => health(p, "api"), "healthy", 240_000)).toBe("healthy");
    expect(
      ((await api(p)("/auth/setup-status")).json as { isInitialized: boolean }).isInitialized,
    ).toBe(true);
    // The pre-restart access token still verifies: the JWT secrets were persisted, not regenerated.
    expect((await api(p)("/auth/me", { token })).status).toBe(200);
    expect((await api(p)(`/quizzes/${quiz.id}`, { token })).status).toBe(200);
    expect((await fetch(image.publicUrl)).status).toBe(200);
    expect((await api(p)(`/reports/${finished.sessionId}`, { token })).status).toBe(200);
    // In-memory game state is gone: the live room is reported lost, never revived.
    expect(await until(() => status(live.sessionId), "lost", 60_000)).toBe("lost");

    await expectCleanBundle(p, secretValues);
  });
});

describe("scale profile", () => {
  it("initialises secrets and the bucket, migrates concurrently once, and keeps shared secrets", async () => {
    const p = await project("scale");
    projects.push(p);
    await up(p);
    const healthJson = (await api(p)("/system/health")).json as Record<string, unknown>;
    expect(healthJson).toMatchObject({
      status: "ok",
      dbDriver: "postgres",
      stateDriver: "redis",
      storageDriver: "s3",
    });
    // One-shot jobs completed.
    for (const job of ["secrets-init", "minio-init"]) {
      const id = (await compose(p, ["ps", "-a", "-q", job])).trim();
      expect(
        (await run("docker", ["inspect", "-f", "{{.State.ExitCode}}", id])).stdout.trim(),
      ).toBe("0");
    }
    // Generated secrets: 0400, owned by the reading service's user.
    const modes = (await exec(p, "postgres", "stat -c '%n %a %u' /run/kabuki-secrets/*"))
      .trim()
      .split("\n");
    const owner = (name: string) =>
      modes
        .find((line) => line.startsWith(`/run/kabuki-secrets/${name} `))
        ?.split(" ")
        .slice(1)
        .join(" ");
    expect(owner("postgres_password")).toBe("400 0");
    expect(owner("database_url")).toBe("400 10001");
    expect(owner("jwt_access_secret")).toBe("400 10001");
    expect(owner("s3_secret_key")).toBe("400 10001");
    expect(owner("minio_root_password")).toBe("400 65532");
    const databaseUrl = (await exec(p, "api", "cat /run/kabuki-secrets/database_url")).trim();
    const s3Secret = (await exec(p, "api", "cat /run/kabuki-secrets/s3_secret_key")).trim();
    const jwtAccess = (await exec(p, "api", "cat /run/kabuki-secrets/jwt_access_secret")).trim();
    expect(databaseUrl.startsWith("postgresql://kabuki:")).toBe(true);
    expect(s3Secret).not.toContain("minioadmin");

    // Media through MinIO: anonymous GET works, anonymous listing and writes are refused.
    const token = await setup(p);
    const image = await media(p, token);
    const bucket = `http://127.0.0.1:${p.ports.media}/kabuki-neko-media`;
    expect(image.publicUrl.startsWith(`${bucket}/`)).toBe(true);
    expect((await fetch(image.publicUrl)).status).toBe(200);
    expect((await fetch(`${bucket}?list-type=2`)).status).toBe(403);
    expect(
      (await fetch(`${bucket}/questions/anonymous.webp`, { method: "PUT", body: "x" })).status,
    ).toBe(403);

    // Concurrent migration of a fresh database by two API processes.
    await exec(p, "postgres", "psql -U kabuki -d kabuki -c 'CREATE DATABASE kabuki_concurrent'");
    const freshUrl = databaseUrl.replace(/\/kabuki$/u, "/kabuki_concurrent");
    const workers = await Promise.all(
      [1, 2].map(
        async () =>
          (await compose(p, ["run", "-d", "--no-deps", "-e", `DATABASE_URL=${freshUrl}`, "api"]))
            .trim()
            .split("\n")
            .at(-1) ?? "",
      ),
    );
    for (const id of workers) {
      const ready = async () =>
        await run("docker", [
          "exec",
          id,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3001/api/v1/system/health').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))",
        ]).then(
          () => true,
          () => false,
        );
      expect(await until(ready, true, 120_000)).toBe(true);
    }
    const versions = (
      await exec(
        p,
        "postgres",
        "psql -U kabuki -d kabuki_concurrent -tAc 'SELECT count(*), count(DISTINCT version) FROM kabuki_schema_versions'",
      )
    ).trim();
    const [rows, distinct] = versions.split("|").map(Number);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBe(distinct);
    for (const id of workers) await run("docker", ["rm", "-f", id]);

    // Recreate the API: the shared JWT secret file is reused, so earlier tokens stay valid.
    await compose(p, ["up", "-d", "--no-build", "--force-recreate", "api"]);
    expect(await until(() => health(p, "api"), "healthy", 240_000)).toBe("healthy");
    expect((await exec(p, "api", "cat /run/kabuki-secrets/jwt_access_secret")).trim()).toBe(
      jwtAccess,
    );
    expect((await api(p)("/auth/me", { token })).status).toBe(200);
    expect((await fetch(image.publicUrl)).status).toBe(200);

    const password = /^postgresql:\/\/kabuki:([^@]+)@/u.exec(databaseUrl)?.[1] ?? "";
    await expectCleanBundle(p, [password, s3Secret, jwtAccess]);
  });
});
