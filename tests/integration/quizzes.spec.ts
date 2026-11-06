import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { quizDetailSchema, quizzesPageSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { createTestRuntime } from "../helpers/runtime";

it("exposes all six quiz routes with revisions, idempotency and resource authorization", async () => {
  const runtime = await createTestRuntime();
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: { ...process.env, ...runtime.env, API_PORT: String(port), PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("API exited during startup");
      try {
        if ((await fetch(`${base}/auth/setup-status`)).status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for server startup. */
      }
      await delay(100);
    }
    expect(ready).toBe(true);
    const request = (
      path: string,
      method = "GET",
      token?: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          "X-Kabuki-Client": "web-v1",
          Origin: "http://localhost:3000",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const credentials = z.object({ user: userSchema, accessToken: z.string() });
    const setup = await request(
      "/auth/setup",
      "POST",
      undefined,
      {
        instanceName: "Quiz integration",
        name: "Admin",
        email: "admin@example.org",
        password: "Correct-password-123!",
      },
      { "Idempotency-Key": randomUUID() },
    );
    expect(setup.status).toBe(201);
    const admin = credentials.parse(await setup.json());
    const register = await request(
      "/auth/register",
      "POST",
      undefined,
      { name: "Creator", email: "creator@example.org", password: "Correct-password-123!" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(register.status).toBe(201);
    const creator = credentials.parse(await register.json());
    expect((await request("/quizzes")).status).toBe(401);
    const key = randomUUID();
    const create = await request(
      "/quizzes",
      "POST",
      creator.accessToken,
      { title: "Private quiz" },
      { "Idempotency-Key": key },
    );
    expect(create.status).toBe(201);
    expect(create.headers.get("etag")).toBe('"1"');
    const draft = quizDetailSchema.parse(await create.json());
    expect(draft.isPlayable).toBe(false);
    const replay = await request(
      "/quizzes",
      "POST",
      creator.accessToken,
      { title: "Private quiz" },
      { "Idempotency-Key": key },
    );
    expect(replay.status).toBe(201);
    expect(quizDetailSchema.parse(await replay.json()).id).toBe(draft.id);
    expect((await request(`/quizzes/${draft.id}`, "GET", admin.accessToken)).status).toBe(404);
    const detail = await request(`/quizzes/${draft.id}`, "GET", creator.accessToken);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("etag")).toBe('"1"');
    const list = await request("/quizzes", "GET", creator.accessToken);
    const page = quizzesPageSchema.parse(await list.json());
    expect(page.meta).toMatchObject({ limit: 12, total: 1 });
    expect(page.items.map((q) => q.id)).toEqual([draft.id]);
    expect(
      (await request("/quizzes?scope=public&visibility=PRIVATE", "GET", creator.accessToken))
        .status,
    ).toBe(422);
    const write = {
      title: draft.title,
      description: draft.description,
      visibility: "PUBLIC",
      coverMediaId: null,
      bgmTrack: draft.bgmTrack,
      questions: draft.questions,
    };
    expect((await request(`/quizzes/${draft.id}`, "PUT", creator.accessToken, write)).status).toBe(
      422,
    );
    const saved = await request(`/quizzes/${draft.id}`, "PUT", creator.accessToken, write, {
      "If-Match": '"1"',
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("etag")).toBe('"2"');
    expect(
      (
        await request(`/quizzes/${draft.id}`, "PUT", creator.accessToken, write, {
          "If-Match": '"1"',
        })
      ).status,
    ).toBe(409);
    expect((await request(`/quizzes/${draft.id}`, "GET", admin.accessToken)).status).toBe(200);
    expect(
      (
        await request(`/quizzes/${draft.id}`, "PUT", admin.accessToken, write, {
          "If-Match": '"2"',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/quizzes/${draft.id}`, "DELETE", admin.accessToken, undefined, {
          "If-Match": '"2"',
        })
      ).status,
    ).toBe(403);
    const duplicateKey = randomUUID();
    const duplicate = await request(
      `/quizzes/${draft.id}/duplicate`,
      "POST",
      admin.accessToken,
      {},
      { "Idempotency-Key": duplicateKey },
    );
    expect(duplicate.status).toBe(201);
    const copy = quizDetailSchema.parse(await duplicate.json());
    expect(copy.visibility).toBe("PRIVATE");
    expect(copy.creatorId).toBe(admin.user.id);
    expect(copy.questions[0]?.id).not.toBe(draft.questions[0]?.id);
    const copiedAgain = await request(
      `/quizzes/${draft.id}/duplicate`,
      "POST",
      admin.accessToken,
      {},
      { "Idempotency-Key": duplicateKey },
    );
    expect(quizDetailSchema.parse(await copiedAgain.json()).id).toBe(copy.id);
    expect(
      (
        await request(
          "/quizzes",
          "POST",
          creator.accessToken,
          { title: "Oversize", description: "x".repeat(5 * 1024 * 1024) },
          { "Idempotency-Key": randomUUID() },
        )
      ).status,
    ).toBe(413);
    const deleted = await request(
      `/quizzes/${draft.id}`,
      "DELETE",
      creator.accessToken,
      undefined,
      { "If-Match": '"2"' },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await request(`/quizzes/${draft.id}`, "GET", creator.accessToken)).status).toBe(404);
    expect(
      (
        await request(
          "/quizzes",
          "POST",
          creator.accessToken,
          { title: "Private quiz" },
          { "Idempotency-Key": key },
        )
      ).status,
    ).toBe(404);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await runtime.cleanup();
  }
});
