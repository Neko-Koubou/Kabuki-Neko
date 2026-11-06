import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  OperationsRepository,
  OPERATION_TIMING,
  type OperationRequest,
  type OperationResult,
  type OperationRow,
} from "@kabuki-neko/database";
import type { EntityManager } from "typeorm";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { operationQuerySchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ApiError } from "./error.filter";

export interface HttpOperation {
  actorScope: string;
  operation: OperationRequest["operation"];
  key: string;
  method: string;
  path: string;
  query: unknown;
  body: unknown;
  fileSha256?: string;
}
export interface MutationResponse<T> extends OperationResult {
  response: T;
}
export type ResourceAuthorization = (resourceId: string | null) => Promise<void>;

@Injectable()
export class IdempotencyService {
  constructor(@Inject(OperationsRepository) private readonly repository: OperationsRepository) {}

  async fileHash(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of chunks) hash.update(chunk);
    return hash.digest("hex");
  }

  private request(input: HttpOperation): OperationRequest {
    if (
      !uuidSchema.safeParse(input.key).success ||
      !/^[a-zA-Z0-9:_-]{1,80}$/.test(input.actorScope) ||
      !/^[A-Z]+$/.test(input.method) ||
      !input.path.startsWith("/") ||
      (input.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.fileSha256))
    )
      throw new ApiError("VALIDATION_FAILED", 422);
    return {
      actorScope: input.actorScope,
      operation: input.operation,
      key: input.key,
      request: {
        method: input.method,
        path: input.path,
        query: input.query,
        body: input.body,
        fileSha256: input.fileSha256 ?? null,
      },
    };
  }

  private async boundary<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error) {
        if (error.message === "IDEMPOTENCY_CONFLICT" || error.message === "OPERATION_PENDING")
          throw new ApiError(error.message, 409);
        if (error.message === "INVALID_FORMAT") throw new ApiError("VALIDATION_FAILED", 422);
      }
      throw error;
    }
  }

  /** Mutation is SQL-only. Credentials exist only in the response of the committing call. */
  async execute<T>(
    input: HttpOperation,
    mutate: (manager: EntityManager) => Promise<MutationResponse<T>>,
    replay: (resourceId: string | null) => Promise<T>,
    authorize: ResourceAuthorization,
    reconcile?: (
      manager: EntityManager,
      row: Readonly<OperationRow>,
    ) => Promise<OperationResult | null>,
  ): Promise<{ httpStatus: number; response: T }> {
    let fresh: (MutationResponse<T> & { receiptId: string }) | undefined;
    const row = await this.boundary(() =>
      this.repository.run(
        this.request(input),
        Date.now(),
        async (manager) => {
          const receipt = await manager
            .getRepository<OperationRow>("request_dedup")
            .findOneByOrFail({
              actor_scope: input.actorScope,
              operation: input.operation,
              key: input.key,
            });
          fresh = { ...(await mutate(manager)), receiptId: receipt.id };
          return fresh;
        },
        reconcile,
      ),
    );
    // A transaction retry can observe another caller's commit after our callback rolled back.
    if (fresh && fresh.receiptId === row.id)
      return { httpStatus: fresh.httpStatus, response: fresh.response };
    if (input.operation === "auth.setup" || input.operation === "auth.register")
      throw new ApiError("OPERATION_COMPLETED_REAUTH_REQUIRED", 409);
    await authorize(row.resource_id);
    if (input.operation === "invitation.create")
      throw new ApiError("INVITE_CODE_ALREADY_ISSUED", 409);
    if (row.http_status === null) throw new ApiError("OPERATION_PENDING", 409);
    return { httpStatus: row.http_status, response: await replay(row.resource_id) };
  }

  /** Reserve durable resource state before starting external work; never repeat expired work blindly. */
  async reserve(
    input: HttpOperation,
    reserve: (manager: EntityManager) => Promise<{ pendingResourceId: string }>,
    reconcile: (
      manager: EntityManager,
      row: Readonly<OperationRow>,
    ) => Promise<OperationResult | null>,
    authorize: ResourceAuthorization,
  ) {
    const row = await this.boundary(() =>
      this.repository.run(this.request(input), Date.now(), reserve, reconcile),
    );
    await authorize(row.resource_id);
    return row;
  }

  /** Renew every 30 seconds during external work; never complete after losing the lease. */
  async withLease<T>(id: string, work: () => Promise<T>): Promise<T> {
    let lost = false;
    let renewing: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewing || lost) return;
      renewing = this.renew(id)
        .then(
          (ok) => {
            lost = !ok;
          },
          () => {
            lost = true;
          },
        )
        .finally(() => {
          renewing = undefined;
        });
    }, OPERATION_TIMING.renewalMs);
    timer.unref();
    try {
      const result = await work();
      await renewing;
      if (lost) throw new ApiError("OPERATION_PENDING", 409);
      return result;
    } finally {
      clearInterval(timer);
      await renewing;
    }
  }

  renew(id: string) {
    return this.repository.renew(id, Date.now());
  }
  complete(id: string, mutate: (manager: EntityManager) => Promise<OperationResult>) {
    return this.boundary(() => this.repository.complete(id, Date.now(), mutate));
  }

  async lookup(actorScope: string, key: string, query: unknown, authorize: ResourceAuthorization) {
    const parsed = operationQuerySchema.safeParse(query);
    if (!uuidSchema.safeParse(key).success || !parsed.success)
      throw new ApiError("VALIDATION_FAILED", 422);
    const result = await this.repository.lookup(actorScope, parsed.data.operation, key, Date.now());
    if (!result) throw new ApiError("NOT_FOUND", 404);
    await authorize(result.resourceId);
    return result;
  }
}
