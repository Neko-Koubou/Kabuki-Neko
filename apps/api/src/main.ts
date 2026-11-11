import { configureUploads } from "./providers/storage/storage.module";
import "reflect-metadata";
import { configureHttpBoundary } from "./common/request-context.middleware";
import { configureRequestGuards } from "./common/guards/origin.guard";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";

/**
 * Browser security headers for API responses (SA §10.1; TASK-164).
 *
 * The API serves JSON, CSV downloads and uploaded media, never HTML for browsing. Its responses:
 * - may not be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`);
 * - load nothing if opened directly (`default-src 'none'`, plus `sandbox` so an uploaded file
 *   opened in a tab cannot run anything);
 * - keep referrers to the origin (`strict-origin-when-cross-origin`).
 * `/uploads` stays loadable cross-origin by the web app (`Cross-Origin-Resource-Policy:
 * cross-origin`); every other response is same-site only. MIME types and `nosniff` are set by the
 * request-context and uploads handlers. HSTS is the HTTPS reverse proxy's job
 * (docs/security-headers.md).
 */
export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; sandbox",
  );
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Cross-Origin-Resource-Policy",
    request.path.startsWith("/uploads/") ? "cross-origin" : "same-site",
  );
  next();
}

/** Creates the Nest app with the HTTP boundary, guards, uploads and security headers. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false, bodyParser: false });
  try {
    const config = app.get(ConfigService);
    app.setGlobalPrefix("api/v1");
    app.use(securityHeaders);
    configureHttpBoundary(app);
    configureRequestGuards(app);
    configureUploads(app);
    app.enableShutdownHooks();
    await app.listen(config.get("API_PORT"), "0.0.0.0");
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch(() => {
  Logger.error("API startup failed", "Bootstrap");
  process.exitCode = 1;
});
