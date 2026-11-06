import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { json, type Request, type Response, type NextFunction } from "express";
import { ApiError, ErrorFilter } from "./error.filter";

export const JSON_BODY_LIMIT = 5 * 1024 * 1024;
export const MULTIPART_METADATA_LIMIT = 256 * 1024;
/** Route upload parsers must additionally enforce configured file/MIME/field limits. */
export const MULTIPART_FILE_LIMIT = 250 * 1024 * 1024;

export function requestContext(request: Request, response: Response, next: NextFunction): void {
  response.locals.correlationId = randomUUID();
  response.setHeader("X-Request-Id", response.locals.correlationId as string);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const hasBody =
    request.headers["transfer-encoding"] !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0;
  if (!hasBody) {
    next();
    return;
  }
  if (["GET", "HEAD", "DELETE"].includes(request.method)) {
    next(new ApiError("VALIDATION_FAILED", 422));
    return;
  }
  const multipart = request.is("multipart/form-data");
  if (multipart) {
    const route = request.path.replace(/\/$/u, "");
    if (
      request.method !== "POST" ||
      !["/api/v1/media/upload", "/api/v1/quizzes/import"].includes(route)
    ) {
      next(new ApiError("UNSUPPORTED_CONTENT_TYPE", 415));
      return;
    }
    const limit =
      (route.endsWith("/import") ? JSON_BODY_LIMIT : MULTIPART_FILE_LIMIT) +
      MULTIPART_METADATA_LIMIT;
    if (Number(request.headers["content-length"] ?? 0) > limit) {
      next(new ApiError("PAYLOAD_TOO_LARGE", 413));
      return;
    }
    if (
      !/;\s*boundary=(?:"[^"\r\n]{1,70}"|[^\s;]{1,70})(?:;|$)/iu.test(
        request.headers["content-type"] ?? "",
      )
    ) {
      next(new ApiError("MALFORMED_MULTIPART", 400));
      return;
    }
    // Enforce the same aggregate cap for chunked requests before file processing.
    let bytes = 0;
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        request.removeListener("data", count);
        request.pause();
        response.setHeader("Connection", "close");
        response.once("finish", () => request.destroy());
        new ErrorFilter().respond(new ApiError("PAYLOAD_TOO_LARGE", 413), response);
      }
    };
    request.on("data", count);
    response.once("close", () => request.removeListener("data", count));
  } else if (!request.is("application/json")) {
    next(new ApiError("UNSUPPORTED_CONTENT_TYPE", 415));
    return;
  }
  next();
}

export function configureHttpBoundary(app: INestApplication): void {
  app.use(requestContext);
  app.use(json({ limit: JSON_BODY_LIMIT, strict: true, inflate: false }));
  app.useGlobalFilters(new ErrorFilter());
}
