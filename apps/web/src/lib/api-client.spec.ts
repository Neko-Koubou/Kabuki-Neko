/**
 * TASK-124 coverage for the browser API client: headers (bearer, X-Kabuki-Client, If-Match,
 * Idempotency-Key, credentials) without tokens in URLs, typed responses and ETag revisions,
 * relative-path enforcement, error envelopes with 409/429 retry metadata and localized message
 * keys for every error code, a single refresh-and-replay only for replay-safe requests, latest-only
 * list requests (out-of-order responses dropped), reconciliation of uncertain upload/import/create
 * mutations through the operation lookup instead of blind re-sends, and Blob downloads saved via
 * `blob:` URLs with sanitized file names.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ERROR_CODES } from "@kabuki-neko/shared/errors";
import {
  ApiError,
  apiErrorMessageKey,
  createApiClient,
  createLatestRequest,
  filenameFromDisposition,
  saveBlob,
} from "./api-client";

const BASE = "http://api.test:3001/api/v1";
const KEY = "7f1d7a8e-4c1b-4a8e-9d3f-2b6c8e1a5f40";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** JSON response helper. */
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Error envelope helper. */
function envelope(statusCode: number, errorCode: string, params: Record<string, unknown> = {}) {
  return { statusCode, errorCode, message: "x", params, details: [], correlationId: CORRELATION };
}

/** Client with a mocked fetch that records requests. */
function setup(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  token = "access-1",
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  let current = token;
  const refresh = vi.fn(async () => {
    current = "access-2";
    return true;
  });
  const client = createApiClient({
    baseUrl: BASE,
    getAccessToken: () => current,
    refreshAccessToken: refresh,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls, fetchMock, refresh };
}

/** Header value of a recorded request. */
function header(init: RequestInit, name: string) {
  return new Headers(init.headers).get(name);
}

describe("requests", () => {
  it("sends typed requests with the required headers and no token in the URL", async () => {
    const { client, calls } = setup(() =>
      json(200, { id: "q-1", title: "Capitals" }, { ETag: '"4"' }),
    );
    const schema = z.object({ id: z.string(), title: z.string() });
    const result = await client.request({
      path: "/quizzes/q-1",
      query: { page: 2, search: "a b", skip: undefined },
      schema,
    });
    expect(result).toEqual({ data: { id: "q-1", title: "Capitals" }, status: 200, revision: 4 });
    const { url, init } = calls[0] ?? { url: new URL(BASE), init: {} };
    expect(url.toString()).toBe(`${BASE}/quizzes/q-1?page=2&search=a+b`);
    expect(url.toString()).not.toMatch(/access|token/iu);
    expect(header(init, "Authorization")).toBe("Bearer access-1");
    expect(header(init, "X-Kabuki-Client")).toBe("web-v1");
    expect(header(init, "Accept")).toBe("application/json");
    expect(init.credentials).toBe("include");

    await client.request({
      method: "PUT",
      path: "/quizzes/q-1",
      body: { title: "x" },
      ifMatch: 4,
      schema,
    });
    expect(header(calls[1]?.init ?? {}, "If-Match")).toBe('"4"');
    expect(header(calls[1]?.init ?? {}, "Content-Type")).toBe("application/json");
    expect(calls[1]?.init.body).toBe('{"title":"x"}');

    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.png");
    await client.request({
      method: "POST",
      path: "/media",
      body: form,
      idempotencyKey: KEY,
      schema,
    });
    expect(header(calls[2]?.init ?? {}, "Idempotency-Key")).toBe(KEY);
    expect(header(calls[2]?.init ?? {}, "Content-Type")).toBeNull(); // browser sets the boundary
  });

  it("rejects absolute or traversal paths and invalid response shapes", async () => {
    const { client, fetchMock } = setup(() => json(200, { unexpected: true }));
    for (const path of ["https://evil.example/x", "//evil.example/x", "quizzes", "/a/../../x"])
      await expect(client.request({ path })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      client.request({ path: "/quizzes", schema: z.object({ items: z.array(z.string()) }) }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

describe("errors", () => {
  it("exposes 409 conflict params and 429 retry metadata from the body or Retry-After", async () => {
    const responses = [
      json(409, envelope(409, "REVISION_CONFLICT", { expectedRevision: 3, currentRevision: 5 })),
      json(429, envelope(429, "RATE_LIMITED", { retryAfterMs: 1500 }), { "Retry-After": "9" }),
      json(429, envelope(429, "RATE_LIMITED"), { "Retry-After": "7" }),
      new Response("<html>bad gateway</html>", { status: 503, headers: { "Retry-After": "2" } }),
    ];
    const { client } = setup(() => responses.shift() ?? json(500, {}));
    const conflict = await client
      .request({ method: "PUT", path: "/quizzes/q", ifMatch: 3 })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({
      status: 409,
      code: "REVISION_CONFLICT",
      correlationId: CORRELATION,
      uncertain: false,
    });
    expect((conflict as ApiError).params).toEqual({ expectedRevision: 3, currentRevision: 5 });
    expect(apiErrorMessageKey((conflict as ApiError).code)).toBe(
      "validation.errors.revisionConflict",
    );

    const limited = (await client
      .request({ path: "/quizzes" })
      .catch((e: unknown) => e)) as ApiError;
    expect(limited.retryAfterMs).toBe(1500); // body value wins
    const header429 = (await client
      .request({ path: "/quizzes" })
      .catch((e: unknown) => e)) as ApiError;
    expect(header429.retryAfterMs).toBe(7000);
    const malformed = (await client
      .request({ method: "POST", path: "/x", idempotencyKey: KEY })
      .catch((e: unknown) => e)) as ApiError;
    expect(malformed).toMatchObject({ status: 503, code: "INTERNAL_ERROR", uncertain: true });
    expect(malformed.retryAfterMs).toBe(2000);
  });

  it("maps every error code to an existing localized message key", () => {
    const fs = process.getBuiltinModule("node:fs");
    const read = (ns: string) =>
      JSON.parse(
        fs.readFileSync(`${process.cwd()}/../../packages/shared/locales/en/${ns}.json`, "utf8"),
      ) as Record<string, string>;
    const catalogs: Record<string, Record<string, string>> = {
      validation: read("validation"),
      common: read("common"),
    };
    for (const code of [
      ...ERROR_CODES,
      "NETWORK_ERROR",
      "TIMEOUT",
      "INVALID_RESPONSE",
      "ABORTED",
    ] as const) {
      const [ns = "", ...rest] = apiErrorMessageKey(code).split(".");
      expect(catalogs[ns]?.[rest.join(".")], code).toBeTypeOf("string");
    }
  });

  it("refreshes and replays once only for replay-safe requests, never for credential flows", async () => {
    const expired = () => json(401, envelope(401, "TOKEN_EXPIRED"));
    const { client, calls, refresh } = setup((url, init) =>
      header(init, "Authorization") === "Bearer access-2" && !url.pathname.endsWith("/auth/refresh")
        ? json(200, { ok: true })
        : expired(),
    );
    await expect(
      client.request({ path: "/auth/me", schema: z.object({ ok: z.boolean() }) }),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => header(call.init, "Authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);

    const fresh = setup(expired);
    await expect(
      fresh.client.request({ method: "POST", path: "/auth/refresh" }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    await expect(
      fresh.client.request({ method: "POST", path: "/quizzes/q/archive" }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(fresh.refresh).not.toHaveBeenCalled();
    expect(fresh.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("latest-only lists", () => {
  it("aborts superseded requests and drops out-of-order responses", async () => {
    const latest = createLatestRequest();
    let finishFirst: ((value: string) => void) | null = null;
    const signals: AbortSignal[] = [];
    const first = latest.run(
      (signal) =>
        new Promise<string>((resolve) => {
          signals.push(signal);
          finishFirst = resolve;
        }),
    );
    const second = latest.run(async (signal) => {
      signals.push(signal);
      return "page 2";
    });
    await expect(second).resolves.toEqual({ stale: false, value: "page 2" });
    expect(signals[0]?.aborted).toBe(true);
    (finishFirst as ((value: string) => void) | null)?.("page 1 (late)");
    await expect(first).resolves.toEqual({ stale: true });
    const failing = latest.run(async () => {
      throw new ApiError(500, "INTERNAL_ERROR");
    });
    await expect(failing).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("uncertain mutations", () => {
  const created = z.object({ id: z.string() });

  it("reconciles an upload that lost its response instead of uploading again", async () => {
    const { client, calls } = setup((url) => {
      if (url.pathname.endsWith("/media")) throw new TypeError("network down");
      return json(200, { key: KEY, operation: "media.upload", status: "done", resourceId: "m-9" });
    });
    const result = await client.mutate("media.upload", {
      method: "POST",
      path: "/media",
      body: new FormData(),
      idempotencyKey: KEY,
      schema: created,
    });
    expect(result).toEqual({ outcome: "reconciled", resourceId: "m-9" });
    expect(calls.filter((call) => call.url.pathname.endsWith("/media"))).toHaveLength(1);
    expect(calls[1]?.url.toString()).toBe(`${BASE}/operations/${KEY}?operation=media.upload`);
  });

  it("reports a pending import after a gateway timeout and a not-received create after a timeout", async () => {
    const importer = setup((url) =>
      url.pathname.endsWith("/import")
        ? json(504, envelope(504, "DEPENDENCY_UNAVAILABLE"))
        : json(200, { key: KEY, operation: "quiz.import", status: "pending", resourceId: null }),
    );
    await expect(
      importer.client.mutate("quiz.import", {
        method: "POST",
        path: "/quizzes/import",
        body: new FormData(),
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ outcome: "pending" });

    const creator = setup((url, init) => {
      if (url.pathname.endsWith("/quizzes"))
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "TimeoutError")),
          ),
        );
      return json(404, envelope(404, "NOT_FOUND"));
    });
    const outcome = await creator.client.mutate("quiz.create", {
      method: "POST",
      path: "/quizzes",
      body: { title: "New" },
      idempotencyKey: KEY,
      schema: created,
      timeoutMs: 20,
    });
    expect(outcome).toEqual({ outcome: "not-received" });
    expect(creator.calls.filter((call) => call.url.pathname.endsWith("/quizzes"))).toHaveLength(1);
  });

  it("rethrows definite failures and returns unknown when the lookup fails too", async () => {
    const invalid = setup(() => json(422, envelope(422, "VALIDATION_FAILED")));
    await expect(
      invalid.client.mutate("quiz.create", {
        method: "POST",
        path: "/quizzes",
        body: {},
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(invalid.fetchMock).toHaveBeenCalledTimes(1);

    const down = setup(() => {
      throw new TypeError("offline");
    });
    await expect(
      down.client.mutate("quiz.duplicate", {
        method: "POST",
        path: "/quizzes/q/duplicate",
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ outcome: "unknown" });
  });
});

describe("downloads", () => {
  it("fetches files with the bearer header and saves them through a blob: URL", async () => {
    const { client, calls } = setup(
      () =>
        new Response("title,questions\n", {
          status: 200,
          headers: {
            "Content-Disposition": "attachment; filename*=UTF-8''kuis%20sejarah%2F..%2Fx.csv",
          },
        }),
    );
    const { blob, filename } = await client.download("/quizzes/q-1/export", "quiz.csv");
    expect(await blob.text()).toBe("title,questions\n");
    expect(filename).toBe("kuis sejarah_.._x.csv");
    expect(header(calls[0]?.init ?? {}, "Authorization")).toBe("Bearer access-1");
    expect(calls[0]?.url.search).toBe("");

    const create = vi.fn(() => "blob:http://localhost/abc");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    saveBlob(blob, filename);
    expect(click).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(blob);
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost/abc");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(filenameFromDisposition('attachment; filename=".hidden"', "f.csv")).toBe("hidden");
    expect(filenameFromDisposition(null, "fallback.json")).toBe("fallback.json");
  });
});
