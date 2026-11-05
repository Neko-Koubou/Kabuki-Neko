import {
  Global,
  Inject,
  Injectable,
  Module,
  type INestApplication,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ConfigService } from "../../config/config.service";
import { StorageRegistry, type StorageLocation } from "./storage-registry";
import { LocalStorageAdapter } from "./local-storage.adapter";
import { STORAGE_ADAPTER, STORAGE_EXTENSIONS, validateStorageKey } from "./storage.interface";

export async function initializeStorage(config: ConfigService) {
  const env = config.values;
  if (env.STORAGE_DRIVER === "s3" && (!env.S3_ENDPOINT || !env.S3_PUBLIC_URL))
    throw new Error("STORAGE_UNAVAILABLE");
  const active: StorageLocation =
    env.STORAGE_DRIVER === "local"
      ? {
          id: env.STORAGE_LOCATION_ID,
          driver: "local",
          path: env.LOCAL_STORAGE_PATH,
          publicUrl: `${env.NEXT_PUBLIC_API_URL}/uploads`,
        }
      : {
          id: env.STORAGE_LOCATION_ID,
          driver: "s3",
          endpoint: env.S3_ENDPOINT ?? "",
          region: env.S3_REGION,
          bucket: env.S3_BUCKET,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          publicUrl: env.S3_PUBLIC_URL ?? "",
          accessKeyEnv: "S3_ACCESS_KEY",
          secretKeyEnv: "S3_SECRET_KEY",
        };
  return StorageRegistry.create({
    active,
    ...(env.STORAGE_LOCATIONS_FILE ? { historicalFile: env.STORAGE_LOCATIONS_FILE } : {}),
    ledgerDirectory: join(dirname(env.APP_SECRET_FILE), "storage-origins"),
    credentials: {
      ...process.env,
      S3_ACCESS_KEY: env.S3_ACCESS_KEY,
      S3_SECRET_KEY: env.S3_SECRET_KEY,
    },
  });
}
@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(StorageRegistry) private readonly registry: StorageRegistry) {}
  onApplicationShutdown() {
    this.registry.close();
  }
}
@Global()
@Module({
  providers: [
    { provide: StorageRegistry, inject: [ConfigService], useFactory: initializeStorage },
    {
      provide: STORAGE_ADAPTER,
      inject: [StorageRegistry],
      useFactory: (registry: StorageRegistry) => registry.active,
    },
    StorageLifecycle,
  ],
  exports: [StorageRegistry, STORAGE_ADAPTER],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class StorageModule {}

/** Serving uses the same confined file handle as storage reads, never arbitrary static paths. */
export function configureUploads(app: INestApplication) {
  const adapter = app.get(StorageRegistry).active;
  app.use("/uploads", (request: Request, response: Response) => {
    void serve(request, response, adapter instanceof LocalStorageAdapter ? adapter : null);
  });
}
async function serve(request: Request, response: Response, adapter: LocalStorageAdapter | null) {
  if (!adapter) {
    response.sendStatus(404);
    return;
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    response.sendStatus(405);
    return;
  }
  let key: string;
  try {
    key = validateStorageKey(decodeURIComponent(request.path.replace(/^\//, "")));
  } catch {
    response.sendStatus(404);
    return;
  }
  try {
    const file = await adapter.openRead(key);
    if (!file) {
      response.sendStatus(404);
      return;
    }
    try {
      const { size } = await file.stat();
      const mime = Object.entries(STORAGE_EXTENSIONS).find(([, ext]) =>
        key.endsWith(`.${ext}`),
      )?.[0];
      if (!mime) {
        response.sendStatus(404);
        return;
      }
      response.setHeader("Content-Type", mime);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.setHeader("Accept-Ranges", "bytes");
      let start = 0,
        end = size - 1;
      if (request.headers.range && request.method === "GET") {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        } else start = size;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          end >= size
        ) {
          response.setHeader("Content-Range", `bytes */${size}`);
          response.status(416).end();
          return;
        }
        response.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      response.setHeader("Content-Length", Math.max(0, end - start + 1));
      if (request.method === "HEAD" || size === 0) {
        response.end();
        return;
      }
      await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
    } finally {
      await file.close();
    }
  } catch {
    if (!response.headersSent) response.status(503).json({ errorCode: "STORAGE_UNAVAILABLE" });
    else response.destroy();
  }
}
