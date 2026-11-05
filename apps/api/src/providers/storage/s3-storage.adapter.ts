import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import {
  uploadKey,
  validateStorageKey,
  type IStorageAdapter,
  type StorageHealth,
  type UploadOptions,
} from "./storage.interface";
export interface S3StorageConfiguration {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export class S3StorageAdapter implements IStorageAdapter {
  private readonly client: S3Client;
  private readonly publicUrl: string;
  constructor(private readonly config: S3StorageConfiguration) {
    for (const value of [config.endpoint, config.publicUrl]) {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("STORAGE_UNAVAILABLE");
    }
    this.publicUrl = config.publicUrl.replace(/\/$/, "");
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 2,
    });
  }
  async upload(options: UploadOptions) {
    const key = uploadKey(options);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: options.buffer,
          ContentLength: options.buffer.length,
          ContentType: options.mimeType,
          CacheControl: "public, max-age=31536000, immutable",
          IfNoneMatch: "*",
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      const head = await this.readHead(key);
      if (!head.exists || head.sizeBytes !== options.buffer.length)
        throw new Error("Size mismatch");
      return {
        key,
        publicUrl: `${this.publicUrl}/${key}`,
        sizeBytes: head.sizeBytes,
        mimeType: options.mimeType,
      };
    } catch {
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  async readHead(key: string) {
    validateStorageKey(key);
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      if (
        head.ContentLength === undefined ||
        !Number.isSafeInteger(head.ContentLength) ||
        head.ContentLength < 0
      )
        throw new Error("Invalid size");
      return { exists: true, sizeBytes: head.ContentLength };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        ["NotFound", "NoSuchKey"].includes(String(error.name))
      )
        return { exists: false, sizeBytes: 0 };
      // eslint-disable-next-line preserve-caught-error -- Driver causes can expose signed requests or credentials.
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  async delete(key: string) {
    validateStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  async checkHealth(): Promise<StorageHealth> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }), {
        abortSignal: AbortSignal.timeout(5000),
      });
      return { status: "up", checkedAt: Date.now(), errorCode: null };
    } catch {
      return { status: "down", checkedAt: Date.now(), errorCode: "STORAGE_UNAVAILABLE" };
    }
  }
  close() {
    this.client.destroy();
  }
}
