import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { operationQuerySchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { IdempotencyService } from "./idempotency.service";
import { ZodValidationPipe } from "./zod-validation.pipe";

/** Auth wiring supplies a verified current actor and charges the READ tier (TASK-058). */
export abstract class OperationsAccess {
  abstract authenticate(request: Request): Promise<string>;
  abstract authorize(actor: string, operation: string, resourceId: string | null): Promise<void>;
}

@Controller("operations")
export class OperationsController {
  constructor(
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
    @Inject(OperationsAccess) private readonly access: OperationsAccess,
  ) {}

  @Get(":key")
  async lookup(
    @Req() request: Request,
    @Param("key", new ZodValidationPipe(uuidSchema)) key: string,
    @Query(new ZodValidationPipe(operationQuerySchema)) query: { operation: string },
  ) {
    const actor = await this.access.authenticate(request);
    return this.operations.lookup(actor, key, query, (resourceId) =>
      this.access.authorize(actor, query.operation, resourceId),
    );
  }
}
