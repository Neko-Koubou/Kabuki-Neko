import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { LocalStorageAdapter } from "./local-storage.adapter";
import { S3StorageAdapter } from "./s3-storage.adapter";
import { type IStorageAdapter } from "./storage.interface";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const url = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    ["http:", "https:"].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash
  );
});
const credentialRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const locationSchema = z.discriminatedUnion("driver", [
  z.strictObject({ id, driver: z.literal("local"), path: z.string().min(1), publicUrl: url }),
  z.strictObject({
    id,
    driver: z.literal("s3"),
    endpoint: url,
    region: z.string().min(1),
    bucket: z.string().min(1),
    forcePathStyle: z.boolean(),
    publicUrl: url,
    accessKeyEnv: credentialRef,
    secretKeyEnv: credentialRef,
  }),
]);
export type StorageLocation = z.infer<typeof locationSchema>;
async function readJson(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid registry file");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
/** Durable identity ledger prevents a reused location ID from silently changing its origin. */
async function pinLocation(directory: string, location: StorageLocation) {
  await mkdir(directory, { recursive: true });
  const identity =
    location.driver === "local"
      ? {
          driver: location.driver,
          path: resolve(location.path),
          publicUrl: location.publicUrl.replace(/\/$/, ""),
        }
      : {
          driver: location.driver,
          endpoint: location.endpoint.replace(/\/$/, ""),
          region: location.region,
          bucket: location.bucket,
          forcePathStyle: location.forcePathStyle,
          publicUrl: location.publicUrl.replace(/\/$/, ""),
        };
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const path = join(directory, `${location.id}.json`),
    temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ fingerprint }));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const stored = z.strictObject({ fingerprint: z.string() }).parse(await readJson(path));
    if (stored.fingerprint !== fingerprint) throw new Error("Storage location identity changed");
  } finally {
    await unlink(temporary);
  }
}
export class StorageRegistry {
  private readonly adapters = new Map<string, IStorageAdapter>();
  private constructor(readonly activeId: string) {}
  static async create(options: {
    active: StorageLocation;
    historicalFile?: string;
    ledgerDirectory: string;
    credentials: Record<string, string | undefined>;
  }) {
    const registry = new StorageRegistry(options.active.id);
    try {
      const active = locationSchema.parse(options.active);
      const historical = options.historicalFile
        ? z
            .array(locationSchema)
            .max(100)
            .parse(await readJson(options.historicalFile))
        : [];
      const seen = new Set<string>();
      for (const location of [active, ...historical]) {
        if (seen.has(location.id)) throw new Error("Duplicate origin");
        seen.add(location.id);
        await pinLocation(options.ledgerDirectory, location);
        try {
          let adapter: IStorageAdapter;
          if (location.driver === "local")
            adapter = await LocalStorageAdapter.create(location.path, location.publicUrl);
          else {
            const accessKeyId = options.credentials[location.accessKeyEnv],
              secretAccessKey = options.credentials[location.secretKeyEnv];
            if (!accessKeyId || !secretAccessKey) throw new Error("Missing credentials");
            adapter = new S3StorageAdapter({ ...location, accessKeyId, secretAccessKey });
          }
          registry.adapters.set(location.id, adapter);
        } catch {
          if (location.id === active.id) throw new Error("STORAGE_UNAVAILABLE");
        }
      }
      return registry;
    } catch {
      registry.close();
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  get(locationId: string): IStorageAdapter {
    const adapter = this.adapters.get(locationId);
    if (!adapter) throw new Error("STORAGE_UNAVAILABLE");
    return adapter;
  }
  get active() {
    return this.get(this.activeId);
  }
  close() {
    for (const adapter of this.adapters.values())
      if (adapter instanceof S3StorageAdapter) adapter.close();
  }
}
