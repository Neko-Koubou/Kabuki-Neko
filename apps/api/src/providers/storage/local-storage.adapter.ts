import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isMissing,
  uploadKey,
  validateStorageKey,
  type IStorageAdapter,
  type StorageHealth,
  type UploadOptions,
} from "./storage.interface";

export class LocalStorageAdapter implements IStorageAdapter {
  private constructor(
    readonly root: string,
    readonly publicBaseUrl: string,
  ) {}
  static async create(directory: string, publicBaseUrl: string): Promise<LocalStorageAdapter> {
    try {
      const path = resolve(directory);
      await mkdir(path, { recursive: true });
      if (!(await lstat(path)).isDirectory()) throw new Error("Unsafe root");
      const root = await realpath(path);
      for (const folder of ["covers", "questions", "audio", "video"]) {
        const child = join(root, folder);
        await mkdir(child, { recursive: true });
        if (!(await lstat(child)).isDirectory()) throw new Error("Unsafe folder");
      }
      const url = new URL(publicBaseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid public URL");
      return new LocalStorageAdapter(root, publicBaseUrl.replace(/\/$/, ""));
    } catch {
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  private async path(key: string) {
    validateStorageKey(key);
    if (!(await lstat(this.root)).isDirectory() || (await realpath(this.root)) !== this.root)
      throw new Error("STORAGE_UNAVAILABLE");
    const path = join(this.root, key),
      parent = dirname(path);
    if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent)
      throw new Error("STORAGE_UNAVAILABLE");
    return path;
  }
  async upload(options: UploadOptions) {
    const key = uploadKey(options);
    let temporary: string | undefined;
    try {
      const destination = await this.path(key);
      temporary = join(dirname(destination), `.upload-${randomUUID()}`);
      const file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(options.buffer);
        await file.sync();
        if ((await file.stat()).size !== options.buffer.length) throw new Error("Size mismatch");
      } finally {
        await file.close();
      }
      // An exclusive hard link publishes complete bytes without replacing an existing key.
      await this.path(key);
      await link(temporary, destination);
      return {
        key,
        publicUrl: `${this.publicBaseUrl}/${key}`,
        sizeBytes: options.buffer.length,
        mimeType: options.mimeType,
      };
    } catch {
      throw new Error("STORAGE_UNAVAILABLE");
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
  /** Opens only validated regular files. Caller owns closing the handle. */
  async openRead(key: string): Promise<FileHandle | null> {
    validateStorageKey(key);
    let file: FileHandle | undefined;
    try {
      const path = await this.path(key);
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
      return file;
    } catch {
      await file?.close().catch(() => undefined);
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  async readHead(key: string) {
    const file = await this.openRead(key);
    if (!file) return { exists: false, sizeBytes: 0 };
    try {
      return { exists: true, sizeBytes: (await file.stat()).size };
    } finally {
      await file.close();
    }
  }
  async delete(key: string) {
    validateStorageKey(key);
    try {
      const path = await this.path(key);
      try {
        if (!(await lstat(path)).isFile()) throw new Error("Not a regular file");
        await unlink(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    } catch {
      throw new Error("STORAGE_UNAVAILABLE");
    }
  }
  async checkHealth(): Promise<StorageHealth> {
    let temporary: string | undefined;
    try {
      const key = `questions/${randomUUID()}.webp`;
      const destination = await this.path(key);
      temporary = join(dirname(destination), `.health-${randomUUID()}`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile("health");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await unlink(temporary);
      temporary = undefined;
      return { status: "up", checkedAt: Date.now(), errorCode: null };
    } catch {
      return { status: "down", checkedAt: Date.now(), errorCode: "STORAGE_UNAVAILABLE" };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
    }
  }
}
