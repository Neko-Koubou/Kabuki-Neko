import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalStorageAdapter } from "./local-storage.adapter";
describe("LocalStorageAdapter", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kabuki-storage-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("publishes exact bytes, preserves immutable keys and deletes missing objects", async () => {
    const storage = await LocalStorageAdapter.create(
      join(directory, "uploads"),
      "https://media.example.org/uploads/",
    );
    const buffer = Buffer.from([0, 255, 42]),
      key = `questions/${randomUUID()}.webp`;
    const result = await storage.upload({
      buffer,
      key,
      originalName: "../../original",
      mimeType: "image/webp",
      folder: "questions",
    });
    expect(result).toEqual({
      key,
      publicUrl: `https://media.example.org/uploads/${key}`,
      sizeBytes: 3,
      mimeType: "image/webp",
    });
    expect(await readFile(join(storage.root, key))).toEqual(buffer);
    expect(await storage.readHead(key)).toEqual({ exists: true, sizeBytes: 3 });
    await expect(
      storage.upload({
        buffer: Buffer.from("overwrite"),
        key,
        originalName: "x",
        mimeType: "image/webp",
        folder: "questions",
      }),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect(await readFile(join(storage.root, key))).toEqual(buffer);
    expect(await readdir(join(storage.root, "questions"))).toEqual([key.split("/")[1]]);
    expect(await storage.checkHealth()).toMatchObject({ status: "up", errorCode: null });
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.readHead(key)).toEqual({ exists: false, sizeBytes: 0 });
  });
  it("rejects traversal, symlink files/folders and incompatible MIME folders", async () => {
    const storage = await LocalStorageAdapter.create(
      join(directory, "uploads"),
      "http://localhost/uploads",
    );
    for (const key of [
      "../outside",
      "/etc/passwd",
      "questions/%2e%2e/secret",
      "questions\\outside",
    ]) {
      await expect(storage.readHead(key)).rejects.toThrow("INVALID_REFERENCE");
      await expect(storage.delete(key)).rejects.toThrow("INVALID_REFERENCE");
    }
    await expect(
      storage.upload({
        buffer: Buffer.from("x"),
        originalName: "x",
        mimeType: "audio/mpeg",
        folder: "covers",
      }),
    ).rejects.toThrow("UNSUPPORTED_MEDIA");
    const outside = join(directory, "secret");
    await writeFile(outside, "unchanged");
    const key = `questions/${randomUUID()}.webp`;
    await symlink(outside, join(storage.root, key));
    await expect(storage.readHead(key)).rejects.toThrow("STORAGE_UNAVAILABLE");
    await expect(storage.delete(key)).rejects.toThrow("STORAGE_UNAVAILABLE");
    await rm(join(storage.root, "questions"), { recursive: true });
    await symlink(directory, join(storage.root, "questions"));
    await expect(
      storage.upload({
        buffer: Buffer.from("x"),
        originalName: "x",
        mimeType: "image/webp",
        folder: "questions",
      }),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect((await storage.checkHealth()).status).toBe("down");
    expect(await readFile(outside, "utf8")).toBe("unchanged");
    await expect(
      LocalStorageAdapter.create(join(storage.root, "questions"), "http://localhost/uploads"),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
  });
  it("returns safe errors for unavailable filesystem and invalid configuration", async () => {
    const path = join(directory, "file");
    await writeFile(path, "not a directory");
    await expect(LocalStorageAdapter.create(path, "http://localhost/uploads")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await expect(
      LocalStorageAdapter.create(join(directory, "uploads"), "https://user:secret@example.org"),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    const storage = await LocalStorageAdapter.create(
      join(directory, "valid"),
      "http://localhost/uploads",
    );
    await rm(storage.root, { recursive: true });
    expect(await storage.checkHealth()).toMatchObject({
      status: "down",
      errorCode: "STORAGE_UNAVAILABLE",
    });
  });
});
