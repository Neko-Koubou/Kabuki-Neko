/**
 * Report REST routes (SA §4.5): ready-only list, finalization status, idempotent retry, full
 * report, player and answer pages, and the streamed CSV export.
 *
 * Every route requires a valid access token and is answered only for the current active host of
 * the session (the source quiz owner or a SUPERADMIN gets 404 like anyone else). Reads use the
 * READ tier, retry WRITE and the CSV EXPORT. A session that is still finalizing answers 409
 * FINALIZATION_PENDING and a failed one 503 REPORT_SAVE_FAILED, so no partial report or CSV is ever
 * sent. Retry needs an Idempotency-Key: a replayed key never re-executes and returns the current
 * status; a different request under the same key is 409 IDEMPOTENCY_CONFLICT.
 */
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ApiError } from "../../common/error.filter";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ReportsService } from "./reports.service";

const empty = new ZodValidationPipe(z.strictObject({}));

/** Route UUID; anything else is indistinguishable from an unknown report (404). */
function id(value: string): string {
  if (!uuidSchema.safeParse(value).success) throw new ApiError("NOT_FOUND", 404);
  return value;
}

@Controller("reports")
@UseGuards(JwtGuard)
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
  ) {}

  /** Current active host's ID after charging the route's rate tier. */
  private async host(request: Request, tier: RateTier): Promise<string> {
    const principal = this.jwt.principal(request);
    await this.limiter.consume(tier, principal.user.id);
    return (await this.jwt.current(principal)).id;
  }

  /** GET /reports — ready reports, newest first (page, limit 15, quizId?, search). */
  @Get()
  async list(@Req() request: Request) {
    return this.reports.list(await this.host(request, "READ"), request.query);
  }

  /** GET /reports/:sessionId/status — FinalizeStatus (pending, ready, failed or lost). */
  @Get(":sessionId/status")
  async status(@Req() request: Request, @Param("sessionId") sessionId: string) {
    const host = await this.host(request, "READ");
    empty.transform(request.query);
    return this.reports.status(host, id(sessionId));
  }

  /** POST /reports/:sessionId/retry-finalize — `{}` + Idempotency-Key; pending or ready status. */
  @Post(":sessionId/retry-finalize")
  @HttpCode(200)
  async retry(
    @Req() request: Request,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    const host = await this.host(request, "WRITE");
    empty.transform(request.query);
    empty.transform(body ?? {});
    const session = id(sessionId);
    const receipt = await this.operations.reserve(
      {
        actorScope: host,
        operation: "report.retry",
        key: request.get("idempotency-key") ?? "",
        method: "POST",
        path: `/api/v1/reports/${session}/retry-finalize`,
        query: {},
        body: {},
      },
      async () => ({ pendingResourceId: session }),
      // An interrupted retry left nothing half-done: the queue state is the source of truth.
      async (_manager, row) => ({ httpStatus: 200, resourceId: row.resource_id }),
      async () => undefined,
    );
    if (receipt.state === "DONE") return this.reports.status(host, session);
    try {
      const status = await this.reports.retry(host, session);
      await this.operations.complete(receipt.id, async () => ({
        httpStatus: 200,
        resourceId: session,
      }));
      return status;
    } catch (error) {
      const httpStatus = error instanceof ApiError ? error.getStatus() : 500;
      await this.operations
        .complete(receipt.id, async () => ({ httpStatus, resourceId: session }))
        .catch(() => undefined);
      throw error;
    }
  }

  /** GET /reports/:sessionId — SessionFullReport with the first 20 players. */
  @Get(":sessionId")
  async detail(@Req() request: Request, @Param("sessionId") sessionId: string) {
    const host = await this.host(request, "READ");
    empty.transform(request.query);
    return this.reports.detail(host, id(sessionId));
  }

  /** GET /reports/:sessionId/players — player page (page, limit, search, sort=rank_asc). */
  @Get(":sessionId/players")
  async players(@Req() request: Request, @Param("sessionId") sessionId: string) {
    return this.reports.players(await this.host(request, "READ"), id(sessionId), request.query);
  }

  /** GET /reports/:sessionId/players/:playerId/answers — one row per question, paged. */
  @Get(":sessionId/players/:playerId/answers")
  async answers(
    @Req() request: Request,
    @Param("sessionId") sessionId: string,
    @Param("playerId") playerId: string,
  ) {
    return this.reports.answers(
      await this.host(request, "READ"),
      id(sessionId),
      id(playerId),
      request.query,
    );
  }

  /**
   * GET /reports/:sessionId/export-csv — text/csv with BOM, streamed with backpressure. The whole
   * report is loaded and gated first, so errors are JSON envelopes and never partial CSV.
   */
  @Get(":sessionId/export-csv")
  async exportCsv(
    @Req() request: Request,
    @Param("sessionId") sessionId: string,
    @Res() response: Response,
  ) {
    const host = await this.host(request, "EXPORT");
    empty.transform(request.query);
    const csv = await this.reports.exportCsv(host, id(sessionId));
    response.status(200);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${csv.filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    await streamChunks(csv.chunks, response);
  }
}

/**
 * Streams `chunks` into `target` with backpressure and ends it (code review MJ-14). A client
 * that disconnects mid-download rejects the pipeline (premature close) instead of leaving the
 * handler waiting forever for a `drain` that never comes, so the request and the chunk array
 * are released. Headers are already sent at that point, so the outcome is only logged by
 * Node; the response is destroyed rather than answered.
 */
export async function streamChunks(chunks: Iterable<string>, target: Writable): Promise<void> {
  try {
    await pipeline(Readable.from(chunks, { objectMode: false }), target);
  } catch {
    if (!target.destroyed) target.destroy();
  }
}
