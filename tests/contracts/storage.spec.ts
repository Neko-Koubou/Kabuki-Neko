import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { S3Client, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import { LocalStorageAdapter } from "../../apps/api/src/providers/storage/local-storage.adapter";
import { S3StorageAdapter } from "../../apps/api/src/providers/storage/s3-storage.adapter";
import {
  StorageRegistry,
  type StorageLocation,
} from "../../apps/api/src/providers/storage/storage-registry";
import { createTestRuntime } from "../helpers/runtime";
it("preserves local and real MinIO bytes, immutable keys and browser URLs", async () => {
  const rt = await createTestRuntime();
  let remote: S3StorageAdapter | undefined;
  try {
    const minio = await rt.minio();
    const client = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
    });
    try {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: minio.bucket,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: `arn:aws:s3:::${minio.bucket}/*`,
              },
            ],
          }),
        }),
      );
    } finally {
      client.destroy();
    }
    remote = new S3StorageAdapter({
      ...minio,
      region: "us-east-1",
      forcePathStyle: true,
      publicUrl: `${minio.endpoint}/${minio.bucket}`,
    });
    const local = await LocalStorageAdapter.create(
      join(rt.directory, "uploads"),
      "https://media.example.org/uploads",
    );
    for (const adapter of [local, remote]) {
      const buffer = Buffer.from([0, 255, 50]),
        key = `questions/${randomUUID()}.webp`;
      const options = {
        key,
        buffer,
        originalName: "test.webp",
        mimeType: "image/webp" as const,
        folder: "questions" as const,
      };
      const result = await adapter.upload(options);
      expect(await adapter.readHead(key)).toEqual({ exists: true, sizeBytes: 3 });
      await expect(adapter.upload({ ...options, buffer: Buffer.from("replace") })).rejects.toThrow(
        "STORAGE_UNAVAILABLE",
      );
      if (adapter === remote) {
        const response = await fetch(result.publicUrl);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(buffer);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(response.headers.get("cache-control")).toContain("immutable");
      } else expect(await readFile(join(local.root, key))).toEqual(buffer);
      expect((await adapter.checkHealth()).status).toBe("up");
      await adapter.delete(key);
      await adapter.delete(key);
      expect(await adapter.readHead(key)).toEqual({ exists: false, sizeBytes: 0 });
      await expect(adapter.delete("../secret")).rejects.toThrow("INVALID_REFERENCE");
    }
  } finally {
    remote?.close();
    await rt.cleanup();
  }
});
it("pins location identities across restarts, preserves historical origin and rejects missing origins", async () => {
  const rt = await createTestRuntime();
  try {
    const active: StorageLocation = {
      id: "active",
      driver: "local",
      path: join(rt.directory, "one"),
      publicUrl: "http://localhost/uploads",
    };
    const ledgerDirectory = join(rt.directory, "ledger");
    const first = await StorageRegistry.create({ active, ledgerDirectory, credentials: {} });
    const asset = await first.active.upload({
      buffer: Buffer.from("old"),
      originalName: "old",
      mimeType: "image/webp",
      folder: "questions",
    });
    first.close();
    await expect(
      StorageRegistry.create({
        active: { ...active, path: join(rt.directory, "two") },
        ledgerDirectory,
        credentials: {},
      }),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    const historicalFile = join(rt.directory, "origins.json");
    await writeFile(historicalFile, JSON.stringify([active]));
    const next = await StorageRegistry.create({
      active: { ...active, id: "new", path: join(rt.directory, "two") },
      historicalFile,
      ledgerDirectory,
      credentials: {},
    });
    try {
      expect(await next.get("active").readHead(asset.key)).toEqual({ exists: true, sizeBytes: 3 });
      expect(await next.active.readHead(asset.key)).toEqual({ exists: false, sizeBytes: 0 });
      expect(() => next.get("unknown")).toThrow("STORAGE_UNAVAILABLE");
      await next.get("active").delete(asset.key);
    } finally {
      next.close();
    }
    const unavailable = new S3StorageAdapter({
      endpoint: "http://127.0.0.1:1",
      publicUrl: "http://localhost/media",
      region: "us-east-1",
      bucket: "missing",
      forcePathStyle: true,
      accessKeyId: "private-key",
      secretAccessKey: "private-secret",
    });
    try {
      expect(await unavailable.checkHealth()).toMatchObject({
        status: "down",
        errorCode: "STORAGE_UNAVAILABLE",
      });
    } finally {
      unavailable.close();
    }
  } finally {
    await rt.cleanup();
  }
});
