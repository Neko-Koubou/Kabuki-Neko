/**
 * Unit coverage for the request-context boundary (TASK-064B): multipart bodies must survive async
 * work before the route parser consumes them, while aggregate caps, the multipart route allowlist
 * and boundary validation keep their existing error envelopes.
 */
import { once } from "node:events";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { ErrorFilter } from "./error.filter";
import {
  JSON_BODY_LIMIT,
  MULTIPART_METADATA_LIMIT,
  requestContext,
} from "./request-context.middleware";

const multipartType = "multipart/form-data; boundary=kabuki";
let server: Server;
let port: number;

/** Reads the whole request after an async pause, like guards + rate limits before multer. */
async function delayedReader(request: Request, response: Response) {
  await delay(50);
  let bytes = 0;
  try {
    for await (const chunk of request) bytes += (chunk as Buffer).length;
  } catch {
    /* The middleware destroyed an over-limit request after answering 413. */
  }
  if (!response.headersSent) response.json({ bytes });
}
/** Response statuses the server finished writing, in order (the client may miss an early 413). */
const finished: number[] = [];
/**
 * Sends one raw HTTP request, optionally chunked. Resolves the status and JSON body, or `undefined`
 * when the server closed the connection before the client could read its response.
 */
async function send(
  path: string,
  headers: Record<string, string>,
  chunks: readonly Buffer[],
): Promise<{ status: number; body: unknown; headers: IncomingHttpHeaders } | undefined> {
  const outgoing = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers });
  let settled = false;
  // `events.once` would reject on the EPIPE that follows an early 413, so listen directly.
  const answer = new Promise<IncomingMessage | undefined>((resolve) => {
    outgoing.once("response", (incoming: IncomingMessage) => {
      settled = true;
      resolve(incoming);
    });
    outgoing.once("close", () => {
      settled = true;
      resolve(undefined);
    });
  });
  outgoing.on("error", () => {
    /* Over-limit uploads may see the socket closed after the response. */
  });
  for (const chunk of chunks) {
    if (settled || outgoing.destroyed) break;
    if (!outgoing.write(chunk))
      await Promise.race([new Promise((resolve) => outgoing.once("drain", resolve)), answer]);
  }
  if (!settled && !outgoing.destroyed) outgoing.end();
  const incoming = await answer;
  if (!incoming) return undefined;
  let text = "";
  for await (const chunk of incoming) text += String(chunk);
  return {
    status: incoming.statusCode ?? 0,
    body: JSON.parse(text) as unknown,
    headers: incoming.headers,
  };
}

beforeAll(async () => {
  const app = express();
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.once("finish", () => finished.push(response.statusCode));
    next();
  });
  app.use(requestContext);
  app.post("/api/v1/quizzes/import", (request, response) => {
    void delayedReader(request, response);
  });
  app.post("/api/v1/quizzes", (request, response) => {
    void delayedReader(request, response);
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    new ErrorFilter().respond(error, response);
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("keeps every multipart chunk for a parser that starts after async work", async () => {
  const chunks = Array.from({ length: 8 }, (_, i) => Buffer.alloc(16 * 1024, 65 + i));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = await send(
    "/api/v1/quizzes/import",
    { "Content-Type": multipartType, "Content-Length": String(total) },
    chunks,
  );
  expect(result).toMatchObject({ status: 200, body: { bytes: total } });
  expect(result?.headers["x-request-id"]).toEqual(expect.any(String));
});

it("answers 413 once a chunked multipart body exceeds the route aggregate cap", async () => {
  const limit = JSON_BODY_LIMIT + MULTIPART_METADATA_LIMIT;
  const chunk = Buffer.alloc(512 * 1024, 66);
  const chunks = Array.from({ length: Math.ceil(limit / chunk.length) + 2 }, () => chunk);
  finished.length = 0;
  const result = await send(
    "/api/v1/quizzes/import",
    { "Content-Type": multipartType, "Transfer-Encoding": "chunked" },
    chunks,
  );
  if (result)
    expect(result).toMatchObject({ status: 413, body: { errorCode: "PAYLOAD_TOO_LARGE" } });
  expect(finished).toEqual([413]);
});

it("rejects multipart outside the upload allowlist and without a boundary", async () => {
  const body = [Buffer.from("--kabuki--\r\n")];
  const length = String(body[0]?.length ?? 0);
  expect(
    await send(
      "/api/v1/quizzes",
      { "Content-Type": multipartType, "Content-Length": length },
      body,
    ),
  ).toMatchObject({ status: 415, body: { errorCode: "UNSUPPORTED_CONTENT_TYPE" } });
  expect(
    await send(
      "/api/v1/quizzes/import",
      { "Content-Type": "multipart/form-data", "Content-Length": length },
      body,
    ),
  ).toMatchObject({ status: 400, body: { errorCode: "MALFORMED_MULTIPART" } });
});
