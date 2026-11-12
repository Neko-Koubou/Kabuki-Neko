/**
 * Browser HTTP client for the Kabuki Neko REST API (SA §4, §6.4; US-01/03/05/06/15/21; TASK-124).
 *
 * - Every request is typed: responses are parsed with a Zod schema (a mismatch is an
 *   `INVALID_RESPONSE` error, never silently trusted data). Paths are relative to the configured
 *   API base; absolute URLs are refused so a token can never be sent elsewhere.
 * - Headers: `Accept`, JSON `Content-Type` (multipart lets the browser set the boundary),
 *   `Authorization: Bearer` from an injected getter (the access token lives in memory only),
 *   `X-Kabuki-Client: web-v1`, `If-Match: "<revision>"` and `Idempotency-Key` when given. The
 *   browser adds `Origin`; `credentials: "include"` carries the HttpOnly refresh cookie.
 * - Errors use the shared envelope: `errorCode`, safe `params` (incl. `retryAfterMs` from the body
 *   or `Retry-After`), `details`, `correlationId`. `apiErrorMessageKey` maps every code to its
 *   `validation.errors.*` message, so the UI never shows server text.
 * - Nothing is retried blindly. One retry after an access-token refresh happens only for
 *   requests that are safe to replay (GET, or mutations protected by `If-Match` or an
 *   `Idempotency-Key`) and never for `/auth/*` credential mutations (setup/register/login/
 *   refresh/logout).
 * - A mutation whose outcome is unknown (network failure, timeout, 502/503/504) is marked
 *   `uncertain`; `reconcileOperation` then asks `GET /operations/:key` instead of re-sending a
 *   create/upload/import.
 * - `createLatestRequest` aborts superseded list requests and drops out-of-order responses.
 * - Downloads are fetched with the bearer header into a Blob and saved through a `blob:` URL; no
 *   token or signed URL is ever put in a link.
 */
import { z } from "zod";
import {
  errorEnvelopeSchema,
  type ErrorCode,
  type Issue,
  type SafeParams,
} from "@kabuki-neko/shared/errors";
import { operationStatusSchema } from "@kabuki-neko/shared/schemas/quiz.schema";

/** Client-side failure codes in addition to the server's `ErrorCode`s. */
export type ClientErrorCode = "NETWORK_ERROR" | "TIMEOUT" | "ABORTED" | "INVALID_RESPONSE";

/** Operations that can be reconciled through `GET /operations/:key` (SA §4.3). */
export type OperationName = z.infer<typeof operationStatusSchema>["operation"];

/** Typed API failure. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | ClientErrorCode,
    readonly params: SafeParams = {},
    readonly details: readonly Issue[] = [],
    readonly correlationId: string | null = null,
    /** The request may have reached the server (mutation outcome unknown). */
    readonly uncertain = false,
  ) {
    super(code);
    this.name = "ApiError";
  }

  /** Wait suggested by the server for 429/503 responses, if any. */
  get retryAfterMs(): number | null {
    return this.params.retryAfterMs ?? null;
  }
}

/** HTTP methods used by the API. */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One API request. */
export interface ApiRequest<T> {
  method?: ApiMethod;
  /** Path relative to the API base, e.g. `/quizzes`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body or multipart form data. */
  body?: unknown;
  /** Response schema; omit for empty (204) responses. */
  schema?: z.ZodType<T>;
  /** Optimistic concurrency: sends `If-Match: "<revision>"`. */
  ifMatch?: number;
  /** Idempotency key (UUID) for creates/uploads/imports. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Successful response with its revision (from `ETag`). */
export interface ApiResponse<T> {
  data: T;
  status: number;
  revision: number | null;
}

/** Client configuration. */
export interface ApiClientOptions {
  /** API base including the version prefix, e.g. `http://localhost:3001/api/v1`. */
  baseUrl: string;
  /** Current in-memory access token (null when signed out). */
  getAccessToken?: () => string | null;
  /** Refreshes the access token once after `TOKEN_EXPIRED`; resolves true when refreshed. */
  refreshAccessToken?: () => Promise<boolean>;
  fetch?: typeof fetch;
  /** Default timeout per request (ms). */
  timeoutMs?: number;
}

/** Statuses after which a mutation may or may not have been applied. */
const UNCERTAIN_STATUSES = new Set([502, 503, 504]);
/** Default request timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Client header required on browser requests (SA §4). */
export const CLIENT_HEADER = "web-v1";

/** `validation.errors.<camelCase>` message key for an error code. */
export function apiErrorMessageKey(code: ErrorCode | ClientErrorCode): string {
  if (code === "NETWORK_ERROR") return "common.status.offline";
  if (code === "TIMEOUT") return "validation.errors.dependencyUnavailable";
  if (code === "INVALID_RESPONSE" || code === "ABORTED") return "validation.errors.internalError";
  const [first = "", ...rest] = code.toLowerCase().split("_");
  return `validation.errors.${first}${rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`;
}

/** Revision from an `ETag: "<n>"` header. */
function revisionFrom(etag: string | null): number | null {
  const match = etag?.match(/^"([1-9][0-9]*)"$/u);
  return match ? Number(match[1]) : null;
}

/** Milliseconds from a `Retry-After` header (seconds or HTTP date). */
function retryAfterFrom(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/u.test(header.trim())) return Number(header.trim()) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** True when the request can be sent again without duplicating its effect. */
function replaySafe(request: ApiRequest<unknown>): boolean {
  const method = request.method ?? "GET";
  if (method === "GET") return true;
  // Credential lifecycle mutations (setup, register, login, refresh, logout) are never replayed.
  if (request.path.startsWith("/auth/")) return false;
  return request.ifMatch !== undefined || request.idempotencyKey !== undefined;
}

/** Safe file name from a `Content-Disposition` header (no paths or control characters). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  let name: string | undefined;
  const star = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (star) {
    try {
      name = decodeURIComponent(star.trim());
    } catch {
      name = undefined;
    }
  }
  name ??=
    header?.match(/filename\s*=\s*"([^"]*)"/iu)?.[1] ??
    header?.match(/filename\s*=\s*([^;]+)/iu)?.[1];
  // Replace control characters and path separators (no regex control ranges, per lint policy).
  const cleaned = Array.from(name ?? "", (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || char === "/" || char === "\\" ? "_" : char;
  })
    .join("")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

/** Creates the API client. */
export function createApiClient(options: ApiClientOptions) {
  const base = new URL(options.baseUrl);
  const fetchImpl =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  /** Absolute URL for a relative API path (absolute URLs and traversal are refused). */
  function urlFor(path: string, query?: ApiRequest<unknown>["query"]): URL {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("://") ||
      path.includes("..")
    )
      throw new ApiError(0, "INVALID_RESPONSE");
    const url = new URL(`${base.pathname.replace(/\/$/u, "")}${path}`, base.origin);
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url;
  }

  /** Sends one HTTP request and returns the raw response (or a typed transport error). */
  async function send(request: ApiRequest<unknown>, accept: string): Promise<Response> {
    const method = request.method ?? "GET";
    const headers = new Headers({ Accept: accept, "X-Kabuki-Client": CLIENT_HEADER });
    const token = options.getAccessToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (request.ifMatch !== undefined) headers.set("If-Match", `"${request.ifMatch}"`);
    if (request.idempotencyKey !== undefined)
      headers.set("Idempotency-Key", request.idempotencyKey);
    let body: BodyInit | undefined;
    if (request.body instanceof FormData) body = request.body;
    else if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(request.body);
    }
    const timeout = AbortSignal.timeout(
      request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      return await fetchImpl(urlFor(request.path, request.query), {
        method,
        headers,
        body: body ?? null,
        credentials: "include",
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const mutation = method !== "GET";
      if (request.signal?.aborted) throw new ApiError(0, "ABORTED");
      if (timeout.aborted) throw new ApiError(0, "TIMEOUT", {}, [], null, mutation);
      throw new ApiError(0, "NETWORK_ERROR", {}, [], null, mutation);
    }
  }

  /** Converts a non-2xx response into an ApiError. */
  async function failure(response: Response, request: ApiRequest<unknown>): Promise<ApiError> {
    const mutation = (request.method ?? "GET") !== "GET";
    const uncertain = mutation && UNCERTAIN_STATUSES.has(response.status);
    const json: unknown = await response.json().catch(() => null);
    const envelope = errorEnvelopeSchema.safeParse(json);
    const retryAfterMs = retryAfterFrom(response.headers.get("Retry-After"));
    if (!envelope.success) {
      const params: SafeParams = retryAfterMs === undefined ? {} : { retryAfterMs };
      return new ApiError(response.status, "INTERNAL_ERROR", params, [], null, uncertain);
    }
    const params: SafeParams = { ...envelope.data.params };
    if (params.retryAfterMs === undefined && retryAfterMs !== undefined)
      params.retryAfterMs = retryAfterMs;
    return new ApiError(
      envelope.data.statusCode,
      envelope.data.errorCode,
      params,
      envelope.data.details,
      envelope.data.correlationId,
      uncertain,
    );
  }

  /** Sends a request; retries once after a token refresh only when replay-safe. */
  async function exchange(request: ApiRequest<unknown>, accept: string): Promise<Response> {
    let response = await send(request, accept);
    if (response.ok) return response;
    let error = await failure(response, request);
    if (error.code === "TOKEN_EXPIRED" && replaySafe(request) && options.refreshAccessToken) {
      if (await options.refreshAccessToken()) {
        response = await send(request, accept);
        if (response.ok) return response;
        error = await failure(response, request);
      }
    }
    throw error;
  }

  /** Typed JSON request. */
  async function request<T>(req: ApiRequest<T>): Promise<ApiResponse<T>> {
    const response = await exchange(req, "application/json");
    const revision = revisionFrom(response.headers.get("ETag"));
    if (req.schema === undefined || response.status === 204)
      return { data: undefined as T, status: response.status, revision };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE");
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new ApiError(response.status, "INVALID_RESPONSE");
    return { data: parsed.data, status: response.status, revision };
  }

  /**
   * Looks up an ambiguous mutation by its idempotency key: `done` (with the resource id),
   * `pending`, `not-received` (404 — safe to resend with the same key) or `unknown` (lookup failed).
   */
  async function reconcileOperation(
    key: string,
    operation: OperationName,
  ): Promise<
    | { status: "done"; resourceId: string | null }
    | { status: "pending" | "not-received" | "unknown" }
  > {
    try {
      const { data } = await request({
        path: `/operations/${encodeURIComponent(key)}`,
        query: { operation },
        schema: operationStatusSchema,
      });
      if (data.key !== key || data.operation !== operation) return { status: "unknown" };
      return data.status === "done"
        ? { status: "done", resourceId: data.resourceId }
        : { status: "pending" };
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND")
        return { status: "not-received" };
      return { status: "unknown" };
    }
  }

  /**
   * Runs a keyed mutation once. On an uncertain failure it reconciles through the operation
   * lookup instead of re-sending; other failures are rethrown.
   */
  async function mutate<T>(
    operation: OperationName,
    req: ApiRequest<T> & { idempotencyKey: string },
  ): Promise<
    | { outcome: "done"; response: ApiResponse<T> }
    | { outcome: "reconciled"; resourceId: string | null }
    | { outcome: "pending" | "not-received" | "unknown" }
  > {
    try {
      return { outcome: "done", response: await request(req) };
    } catch (error) {
      if (!(error instanceof ApiError) || !error.uncertain) throw error;
      const result = await reconcileOperation(req.idempotencyKey, operation);
      return result.status === "done"
        ? { outcome: "reconciled", resourceId: result.resourceId }
        : { outcome: result.status };
    }
  }

  /** Fetches a file with the bearer header into a Blob (never a token-bearing URL). */
  async function download(path: string, fallbackName: string, signal?: AbortSignal) {
    const response = await exchange({ path, ...(signal ? { signal } : {}) }, "*/*");
    const blob = await response.blob();
    return {
      blob,
      filename: filenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName),
    };
  }

  return { request, mutate, reconcileOperation, download, urlFor };
}

/** The API client type. */
export type ApiClient = ReturnType<typeof createApiClient>;

/** Saves a downloaded Blob through a temporary `blob:` URL, revoked right after the click. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Keeps only the latest of overlapping requests (lists, searches): starting a new one aborts the
 * previous and results of superseded runs are reported as stale instead of applied.
 */
export function createLatestRequest() {
  let sequence = 0;
  let controller: AbortController | null = null;
  return {
    async run<T>(
      task: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ stale: true } | { stale: false; value: T }> {
      const id = ++sequence;
      controller?.abort();
      controller = new AbortController();
      try {
        const value = await task(controller.signal);
        return id === sequence ? { stale: false, value } : { stale: true };
      } catch (error) {
        if (id !== sequence) return { stale: true };
        throw error;
      }
    },
    /** Aborts the in-flight request (e.g. on unmount). */
    cancel() {
      sequence++;
      controller?.abort();
    },
  };
}
