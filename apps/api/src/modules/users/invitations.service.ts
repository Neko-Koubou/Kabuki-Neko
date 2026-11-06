import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AuthRepository } from "@kabuki-neko/database";
import {
  invitationCreateSchema,
  invitationsQuerySchema,
  uuidSchema,
} from "@kabuki-neko/shared/schemas/users.schema";
import { RolesGuard } from "../../common/guards/roles.guard";
import type { VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(AuthRepository) private readonly accounts: AuthRepository,
    @Inject(RolesGuard) private readonly roles: RolesGuard,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
  ) {}
  async list(principal: VerifiedPrincipal, input: unknown) {
    await this.roles.assert(principal, ["SUPERADMIN"]);
    return this.accounts.invitations(
      new ZodValidationPipe(invitationsQuerySchema).transform(input),
      Date.now(),
    );
  }
  async create(principal: VerifiedPrincipal, input: unknown, key: string) {
    const actor = await this.roles.assert(principal, ["SUPERADMIN"]);
    const body = new ZodValidationPipe(invitationCreateSchema).transform(input);
    new ZodValidationPipe(uuidSchema).transform(key);
    return this.operations.execute(
      {
        actorScope: actor.id,
        operation: "invitation.create",
        key,
        method: "POST",
        path: "/api/v1/users/invitations",
        query: {},
        body,
      },
      async (manager) => {
        const now = Date.now();
        const inviteCode = randomBytes(32).toString("base64url");
        const invitation = await this.accounts.createInvitation(
          randomUUID(),
          actor.id,
          createHash("sha256").update(inviteCode).digest("hex"),
          now + body.expiresInHours * 3_600_000,
          now,
          manager,
        );
        return { httpStatus: 201, resourceId: invitation.id, response: { invitation, inviteCode } };
      },
      async () => {
        throw new ApiError("INVITE_CODE_ALREADY_ISSUED", 409);
      },
      async () => {
        await this.roles.assert(principal, ["SUPERADMIN"]);
      },
    );
  }
  async revoke(principal: VerifiedPrincipal, id: unknown) {
    await this.roles.assert(principal, ["SUPERADMIN"]);
    const invitationId = new ZodValidationPipe(uuidSchema).transform(id);
    try {
      return await this.accounts.revokeInvitation(invitationId, Date.now());
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
        if (error.message === "INVITE_UNAVAILABLE") throw new ApiError("INVITE_UNAVAILABLE", 409);
      }
      throw error;
    }
  }
}
