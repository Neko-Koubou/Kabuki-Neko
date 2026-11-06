import { randomUUID } from "node:crypto";
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import {
  internalError,
  type ErrorCode,
  type Issue,
  type SafeParams,
} from "@kabuki-neko/shared/errors";

/** Only explicitly constructed application errors may supply response details. */
export class ApiError extends HttpException {
  constructor(
    readonly errorCode: ErrorCode,
    status: number,
    readonly params: SafeParams = {},
    readonly details: Issue[] = [],
  ) {
    super(errorCode, status);
  }
}
const defaults: Readonly<Record<number, ErrorCode>> = {
  400: "MALFORMED_JSON",
  401: "AUTH_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_CONTENT_TYPE",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
  503: "DEPENDENCY_UNAVAILABLE",
};
const messages: Partial<Record<ErrorCode, string>> = {
  MALFORMED_JSON: "Malformed JSON request",
  MALFORMED_MULTIPART: "Malformed multipart request",
  AUTH_REQUIRED: "Authentication required",
  FORBIDDEN: "Access denied",
  NOT_FOUND: "Resource not found",
  PAYLOAD_TOO_LARGE: "Request payload is too large",
  UNSUPPORTED_CONTENT_TYPE: "Unsupported content type",
  VALIDATION_FAILED: "Request validation failed",
  RATE_LIMITED: "Too many requests",
  DEPENDENCY_UNAVAILABLE: "A required service is unavailable",
};
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    this.respond(error, host.switchToHttp().getResponse<Response>());
  }
  respond(error: unknown, response: Response): void {
    if (response.headersSent) return;
    const id: unknown = response.locals.correlationId;
    const correlationId = typeof id === "string" ? id : randomUUID();
    let envelope = internalError(correlationId);
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const code = error instanceof ApiError ? error.errorCode : defaults[status];
      if (code && status >= 400 && status < 600)
        envelope = {
          statusCode: status,
          errorCode: code,
          message: messages[code] ?? "The request could not be completed",
          params: error instanceof ApiError ? error.params : {},
          details: error instanceof ApiError ? error.details : [],
          correlationId,
        };
    } else if (error instanceof Error && "type" in error) {
      // Express body-parser errors contain raw input: never serialize them.
      const code =
        error.type === "entity.too.large"
          ? "PAYLOAD_TOO_LARGE"
          : error.type === "entity.parse.failed"
            ? "MALFORMED_JSON"
            : error.type === "encoding.unsupported" || error.type === "charset.unsupported"
              ? "UNSUPPORTED_CONTENT_TYPE"
              : undefined;
      if (code)
        envelope = {
          ...envelope,
          statusCode: code === "PAYLOAD_TOO_LARGE" ? 413 : code === "MALFORMED_JSON" ? 400 : 415,
          errorCode: code,
          message: messages[code] ?? "Invalid request",
        };
    }
    response.setHeader("X-Request-Id", correlationId);
    response.setHeader("Cache-Control", "private, no-store");
    if (envelope.statusCode === 429 && envelope.params.retryAfterMs !== undefined)
      response.setHeader("Retry-After", Math.ceil(envelope.params.retryAfterMs / 1000));
    response.status(envelope.statusCode).json(envelope);
  }
}
