/**
 * TASK-170 cloud object storage smoke tests (SA §11.2; US-06, US-17).
 *
 * The S3 adapter is verified against each hosted provider independently, with test credentials
 * an operator supplies. MinIO (driver-matrix.spec.ts) only proves the protocol; it certifies no
 * provider. A provider is configured when all of these are set, with `<P>` one of `AWS_S3`, `R2`
 * or `SPACES`:
 *
 *   KABUKI_CLOUD_<P>_ENDPOINT, KABUKI_CLOUD_<P>_REGION, KABUKI_CLOUD_<P>_BUCKET,
 *   KABUKI_CLOUD_<P>_ACCESS_KEY, KABUKI_CLOUD_<P>_SECRET_KEY, KABUKI_CLOUD_<P>_PUBLIC_URL
 *
 * Optionally KABUKI_CLOUD_<P>_FORCE_PATH_STYLE=true. The bucket must be a dedicated test bucket
 * whose objects are publicly readable at PUBLIC_URL, as production media requires.
 *
 * Against each configured provider:
 * - upload with the production write options;
 * - the second write of an immutable key is refused;
 * - head reports the exact size;
 * - the public URL serves the bytes with their content type and an immutable cache;
 * - the health probe is up;
 * - delete is idempotent and the object is gone afterwards;
 * - a wrong secret makes the health probe report down.
 *
 * A provider without credentials is recorded as NOT RUN (unverified) and its test is skipped:
 * never a pass, never a stand-in endpoint. Evidence goes to
 * `test-results/driver-verification/cloud-storage.json` (summarised in docs/driver-verification.md).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  S3StorageAdapter,
  type S3StorageConfiguration,
} from "../../apps/api/src/providers/storage/s3-storage.adapter";

jest.setTimeout(120_000);

/** Hosted providers this project documents. */
const PROVIDERS = [
  { id: "AWS_S3", name: "Amazon S3" },
  { id: "R2", name: "Cloudflare R2" },
  { id: "SPACES", name: "DigitalOcean Spaces" },
] as const;
/** Variables required for a provider to count as configured. */
const REQUIRED = [
  "ENDPOINT",
  "REGION",
  "BUCKET",
  "ACCESS_KEY",
  "SECRET_KEY",
  "PUBLIC_URL",
] as const;

/** One evidence row. */
interface Evidence {
  provider: string;
  result: "pass" | "fail" | "not run";
  reason?: string;
  endpointHost?: string;
  durationMs?: number;
}
const evidence: Evidence[] = [];

/** The adapter configuration of `id` from the environment, or the names of the missing variables. */
function configuration(id: string): S3StorageConfiguration | { missing: string[] } {
  const read = (name: string) => process.env[`KABUKI_CLOUD_${id}_${name}`]?.trim() ?? "";
  const missing = REQUIRED.filter((name) => !read(name)).map(
    (name) => `KABUKI_CLOUD_${id}_${name}`,
  );
  if (missing.length > 0) return { missing };
  return {
    endpoint: read("ENDPOINT"),
    region: read("REGION"),
    bucket: read("BUCKET"),
    accessKeyId: read("ACCESS_KEY"),
    secretAccessKey: read("SECRET_KEY"),
    publicUrl: read("PUBLIC_URL"),
    forcePathStyle: read("FORCE_PATH_STYLE") === "true",
  };
}

afterAll(async () => {
  const directory = path.join(process.cwd(), "test-results", "driver-verification");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "cloud-storage.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), evidence }, null, 2)}\n`,
  );
});

describe.each(PROVIDERS)("$name", ({ id, name }) => {
  const config = configuration(id);
  if ("missing" in config) {
    // Recorded as unverified: credentials were not supplied, so nothing about this provider is
    // claimed. The skipped test makes the gap visible in the run summary.
    evidence.push({
      provider: name,
      result: "not run",
      reason: `credentials not supplied (${config.missing.join(", ")})`,
    });
    it.skip(`smoke test (NOT RUN: set KABUKI_CLOUD_${id}_* to verify ${name})`, () => undefined);
    return;
  }

  it("stores immutable public media, reports health and deletes idempotently", async () => {
    const started = Date.now();
    const adapter = new S3StorageAdapter(config);
    const row: Evidence = {
      provider: name,
      result: "fail",
      endpointHost: new URL(config.endpoint).host,
    };
    evidence.push(row);
    try {
      const buffer = randomBytes(64);
      const options = {
        key: `questions/${randomUUID()}.webp`,
        buffer,
        originalName: "smoke.webp",
        mimeType: "image/webp" as const,
        folder: "questions" as const,
      };
      const stored = await adapter.upload(options);
      try {
        await expect(
          adapter.upload({ ...options, buffer: Buffer.from("replace") }),
        ).rejects.toThrow("STORAGE_UNAVAILABLE");
        expect(await adapter.readHead(options.key)).toEqual({ exists: true, sizeBytes: 64 });
        const response = await fetch(stored.publicUrl);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(response.headers.get("cache-control")).toContain("immutable");
        expect((await adapter.checkHealth()).status).toBe("up");
      } finally {
        await adapter.delete(options.key);
      }
      await adapter.delete(options.key);
      expect(await adapter.readHead(options.key)).toEqual({ exists: false, sizeBytes: 0 });
      const wrong = new S3StorageAdapter({
        ...config,
        secretAccessKey: `${config.secretAccessKey}x`,
      });
      try {
        expect((await wrong.checkHealth()).status).toBe("down");
      } finally {
        wrong.close();
      }
      row.result = "pass";
    } catch (error) {
      row.reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
      throw error;
    } finally {
      row.durationMs = Date.now() - started;
      adapter.close();
    }
  });
});

it("never reports an unconfigured provider as verified", () => {
  for (const { id, name } of PROVIDERS) {
    const row = evidence.find((item) => item.provider === name);
    expect(row).toBeDefined();
    if ("missing" in configuration(id)) expect(row?.result).toBe("not run");
  }
});
