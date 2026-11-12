/**
 * TASK-177 locale catalog pairing of the production images (SA §8.2, §10.2; US-16, US-17, US-21).
 *
 * The web image's healthcheck is a readiness check: it passes only when the buildId of the web's
 * own `/locales/registry.json` equals the API's `/system/locales` buildId. Containers run from
 * the production images (`kabuki-neko-{api,web}:<KABUKI_TEST_IMAGE_TAG>`, default `local`) on a
 * private network. The web healthcheck interval is shortened for the test. Everything this file
 * creates is removed with its anonymous volumes; nothing else is touched.
 *
 * Covered:
 * 1. Matching pair (both images built from the same bundle): the web becomes healthy.
 * 2. Mismatched pair: the API is replaced by one serving a different, valid bundle (the shipped
 *    built-ins plus a German package, built with `pnpm locales:build`). The API itself is
 *    healthy, but the web turns unhealthy, so a load balancer keeps traffic away.
 * 3. A tampered bundle (an asset that no longer matches its registry hash): the API refuses to
 *    start. It never becomes ready and never serves catalogs the web could not verify.
 * 4. Rollback to the matching API: the web is healthy again, without restarting the web.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GERMAN, writePackage } from "../e2e/fixtures/locale-packages";
import { until } from "../helpers/game";

jest.setTimeout(600_000);

const ROOT = path.resolve(__dirname, "../..");
const TAG = process.env["KABUKI_TEST_IMAGE_TAG"] ?? "local";
const LABEL = `kn-catalog-${randomUUID().slice(0, 8)}`;
const run = promisify(execFile);

/** `docker …` returning trimmed stdout. */
async function docker(args: string[]): Promise<string> {
  return (await run("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

/** Health status of a container. */
const health = (name: string) =>
  docker([
    "inspect",
    "-f",
    "{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Status}}",
    name,
  ]).then(
    (value) => value,
    () => "missing|missing",
  );

/** Makes a directory tree readable by the images' uid 10001 (bind mounts keep host modes). */
async function readableTree(directory: string) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await readableTree(target);
    else await chmod(target, 0o644);
  }
}

/** Builds a bundle (shipped built-ins + `external`) into a new directory; returns it. */
async function bundle(external: string): Promise<string> {
  const out = await mkdtemp(path.join(tmpdir(), "kabuki-catalog-"));
  await run(
    path.join(ROOT, "node_modules/.bin/tsx"),
    [
      path.join(ROOT, "scripts/locales-build.ts"),
      "--builtin-root",
      path.join(ROOT, "packages/shared/locales"),
      "--external-root",
      external,
      "--out",
      out,
      "--web-public",
      "none",
      "--require-builtins",
      "en,id,ja,zh-Hans,es,fr",
    ],
    { cwd: ROOT },
  );
  await readableTree(out);
  return out;
}

/** Starts the API container `api` (network alias) with an optional bundle mounted. */
async function startApi(name: string, bundleDir?: string) {
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    LABEL,
    "--network",
    LABEL,
    "--network-alias",
    "api",
    "-e",
    "NEXT_PUBLIC_APP_URL=http://localhost:3000",
    ...(bundleDir
      ? ["-v", `${bundleDir}:/app/locales-test:ro`, "-e", "LOCALE_BUNDLE_PATH=/app/locales-test"]
      : []),
    `kabuki-neko-api:${TAG}`,
  ]);
}

/** Removes a container and its anonymous volumes (no error when absent). */
const remove = (name: string) => docker(["rm", "-f", "-v", name]).catch(() => "");

const temporary: string[] = [];
afterAll(async () => {
  const ids = await docker(["ps", "-aq", "--filter", `label=${LABEL}`]).catch(() => "");
  for (const id of ids.split("\n").filter(Boolean)) await remove(id);
  await docker(["network", "rm", LABEL]).catch(() => "");
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

it("is ready only with a matching catalog pair and recovers by rolling back the API", async () => {
  await docker(["network", "create", "--label", LABEL, LABEL]);
  const web = `${LABEL}-web`;
  const api = `${LABEL}-api`;

  // 1. Matching pair.
  await startApi(api);
  expect(await until(async () => (await health(api)).split("|")[0], "healthy", 180_000)).toBe(
    "healthy",
  );
  await docker([
    "run",
    "-d",
    "--name",
    web,
    "--label",
    LABEL,
    "--network",
    LABEL,
    "--health-interval",
    "2s",
    "--health-retries",
    "1",
    "--health-start-period",
    "5s",
    "-e",
    "API_INTERNAL_URL=http://api:3001",
    `kabuki-neko-web:${TAG}`,
  ]);
  expect(await until(async () => (await health(web)).split("|")[0], "healthy", 120_000)).toBe(
    "healthy",
  );

  // 2. Mismatch: a different, valid bundle on the API side.
  const external = await mkdtemp(path.join(tmpdir(), "kabuki-catalog-pkg-"));
  temporary.push(external);
  await writePackage(external, GERMAN);
  const different = await bundle(external);
  temporary.push(different);
  await remove(api);
  await startApi(api, different);
  expect(await until(async () => (await health(api)).split("|")[0], "healthy", 180_000)).toBe(
    "healthy",
  );
  const served = JSON.parse(
    await docker([
      "exec",
      api,
      "node",
      "-e",
      "fetch('http://127.0.0.1:3001/api/v1/system/locales').then((r) => r.text()).then((t) => process.stdout.write(t))",
    ]),
  ) as { buildId: string; locales: { tag: string }[] };
  expect(served.locales.map((locale) => locale.tag)).toContain("de");
  expect(await until(async () => (await health(web)).split("|")[0], "unhealthy", 60_000)).toBe(
    "unhealthy",
  );

  // 3. A tampered bundle: the API refuses to start, so it never becomes ready.
  const tampered = await bundle(await mkdtemp(path.join(tmpdir(), "kabuki-catalog-none-")));
  temporary.push(tampered);
  const registry = JSON.parse(await readFile(path.join(tampered, "registry.json"), "utf8")) as {
    locales: { namespaces: { url: string }[] }[];
  };
  const asset = path.join(
    tampered,
    (registry.locales[0]?.namespaces[0]?.url ?? "").replace(/^\/locales\//u, ""),
  );
  expect((await stat(asset)).isFile()).toBe(true);
  await writeFile(asset, "{}");
  await chmod(asset, 0o644);
  const broken = `${LABEL}-broken`;
  await docker([
    "run",
    "-d",
    "--name",
    broken,
    "--label",
    LABEL,
    "--network",
    LABEL,
    "-e",
    "NEXT_PUBLIC_APP_URL=http://localhost:3000",
    "-v",
    `${tampered}:/app/locales-test:ro`,
    "-e",
    "LOCALE_BUNDLE_PATH=/app/locales-test",
    `kabuki-neko-api:${TAG}`,
  ]);
  expect(await until(async () => (await health(broken)).split("|")[1], "exited", 120_000)).toBe(
    "exited",
  );
  expect(await docker(["inspect", "-f", "{{.State.ExitCode}}", broken])).not.toBe("0");

  // 4. Rollback: the matching API again; the running web becomes ready without a restart.
  await remove(api);
  await startApi(api);
  expect(await until(async () => (await health(api)).split("|")[0], "healthy", 180_000)).toBe(
    "healthy",
  );
  expect(await until(async () => (await health(web)).split("|")[0], "healthy", 60_000)).toBe(
    "healthy",
  );
});
