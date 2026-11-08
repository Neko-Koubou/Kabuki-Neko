/**
 * Integration coverage for serving local uploads through the built API: confined keys, MIME and
 * immutable caching, HEAD/ranges, method checks behind the global Origin guard, traversal/symlink
 * denial without leaking file contents, and fail-closed lookup of unconfigured storage origins.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LocalStorageAdapter } from "../../apps/api/src/providers/storage/local-storage.adapter";
import { StorageRegistry } from "../../apps/api/src/providers/storage/storage-registry";
import { createTestRuntime } from "../helpers/runtime";
it("serves confined uploads with MIME, immutable caching, HEAD/ranges and safe errors", async () => {
  const rt = await createTestRuntime();
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Port unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${port}`;
  const root = rt.env.LOCAL_STORAGE_PATH;
  if (!root) throw new Error("Test runtime has no local storage path");
  const storage = await LocalStorageAdapter.create(root, `${base}/uploads`);
  const upload = await storage.upload({
    buffer: Buffer.from([0, 255, 42, 75]),
    originalName: "test",
    mimeType: "image/webp",
    folder: "questions",
  });
  const child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: rt.directory,
    env: {
      ...process.env,
      ...rt.env,
      API_PORT: String(port),
      PORT: String(port),
      NEXT_PUBLIC_API_URL: base,
    },
    stdio: "ignore",
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("API exited during startup");
      try {
        if ((await fetch(upload.publicUrl)).status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Startup retry. */
      }
      await delay(100);
    }
    expect(ready).toBe(true);
    const response = await fetch(upload.publicUrl);
    expect(response.headers.get("content-type")).toContain("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 255, 42, 75]));
    const head = await fetch(upload.publicUrl, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
    const range = await fetch(upload.publicUrl, { headers: { Range: "bytes=1-2" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(Buffer.from(await range.arrayBuffer())).toEqual(Buffer.from([255, 42]));
    expect((await fetch(upload.publicUrl, { headers: { Range: "bytes=8-9" } })).status).toBe(416);
    // The global Origin guard rejects unattributed unsafe methods before any route runs (TASK-052);
    // a same-site web client reaches the upload server, which only allows GET/HEAD.
    const crossSite = await fetch(upload.publicUrl, { method: "POST" });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ errorCode: "ORIGIN_DENIED" });
    const sameSite = await fetch(upload.publicUrl, {
      method: "POST",
      headers: { Origin: "http://localhost:3000", "X-Kabuki-Client": "web-v1" },
    });
    expect(sameSite.status).toBe(405);
    expect(sameSite.headers.get("allow")).toBe("GET, HEAD");
    for (const path of [
      "%2e%2e%2fsecret",
      "questions/%2fetc%2fpasswd",
      "questions/file.svg",
      `questions/${randomUUID()}.webp`,
    ])
      expect((await fetch(`${base}/uploads/${path}`)).status).toBe(404);
    const secret = join(rt.directory, "secret");
    await writeFile(secret, "private-value");
    const key = `questions/${randomUUID()}.webp`;
    await symlink(secret, join(storage.root, key));
    const denied = await fetch(`${base}/uploads/${key}`);
    expect(denied.status).toBe(503);
    expect(await denied.text()).not.toContain("private-value");
    const registry = await StorageRegistry.create({
      active: { id: "active", driver: "local", path: storage.root, publicUrl: `${base}/uploads` },
      ledgerDirectory: join(rt.directory, "registry-test"),
      credentials: {},
    });
    try {
      expect(() => registry.get("missing-origin")).toThrow("STORAGE_UNAVAILABLE");
    } finally {
      registry.close();
    }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rt.cleanup();
  }
});
