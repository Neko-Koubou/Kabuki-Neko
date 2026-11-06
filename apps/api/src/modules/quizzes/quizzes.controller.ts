import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";
import { QuizzesService } from "./quizzes.service";
const empty = new ZodValidationPipe(z.strictObject({}));
@Controller("quizzes")
@UseGuards(JwtGuard)
export class QuizzesController {
  constructor(
    @Inject(QuizzesService) private readonly quizzes: QuizzesService,
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(RateLimitService) private readonly limiter: RateLimitService,
  ) {}
  private async actor(request: Request, tier: RateTier) {
    const principal = this.jwt.principal(request);
    await this.limiter.consume(tier, principal.user.id);
    return principal;
  }
  private revision(request: Request) {
    const match = request.get("if-match")?.match(/^"([1-9][0-9]*)"$/u);
    if (!match?.[1] || !Number.isSafeInteger(Number(match[1])))
      throw new ApiError("VALIDATION_FAILED", 422);
    return Number(match[1]);
  }
  @Get()
  async list(@Req() request: Request) {
    return this.quizzes.list(await this.actor(request, "READ"), request.query);
  }
  @Post()
  async create(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    const result = await this.quizzes.create(actor, body, request.get("idempotency-key") ?? "");
    response.setHeader("ETag", `"${result.response.revision}"`);
    return result.response;
  }
  @Get(":id")
  async detail(
    @Req() request: Request,
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "READ");
    empty.transform(request.query);
    const quiz = await this.quizzes.read(actor, id);
    response.setHeader("ETag", `"${quiz.revision}"`);
    return quiz;
  }
  @Put(":id")
  async save(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    const quiz = await this.quizzes.save(actor, id, this.revision(request), body);
    response.setHeader("ETag", `"${quiz.revision}"`);
    return quiz;
  }
  @Post(":id/duplicate")
  async duplicate(
    @Req() request: Request,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    empty.transform(body);
    const result = await this.quizzes.duplicate(actor, id, request.get("idempotency-key") ?? "");
    response.setHeader("ETag", `"${result.response.revision}"`);
    return result.response;
  }
  @Delete(":id")
  async delete(@Req() request: Request, @Param("id") id: string) {
    const actor = await this.actor(request, "WRITE");
    empty.transform(request.query);
    return this.quizzes.delete(actor, id, this.revision(request));
  }
}
