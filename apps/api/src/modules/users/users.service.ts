import { Inject, Injectable } from "@nestjs/common";
import { UsersRepository } from "@kabuki-neko/database";
import {
  revisionSchema,
  userPatchSchema,
  usersQuerySchema,
  uuidSchema,
} from "@kabuki-neko/shared/schemas/users.schema";
import { RolesGuard } from "../../common/guards/roles.guard";
import type { VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ApiError } from "../../common/error.filter";
import { userDto } from "../auth/refresh.service";

@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(RolesGuard) private readonly roles: RolesGuard,
  ) {}
  async list(principal: VerifiedPrincipal, input: unknown) {
    await this.roles.assert(principal, ["SUPERADMIN"]);
    const query = new ZodValidationPipe(usersQuerySchema).transform(input);
    const page = await this.users.list(query);
    return { ...page, items: page.items.map(userDto) };
  }
  async patch(principal: VerifiedPrincipal, id: unknown, revision: unknown, input: unknown) {
    await this.roles.assert(principal, ["SUPERADMIN"]);
    const userId = new ZodValidationPipe(uuidSchema).transform(id);
    const version = new ZodValidationPipe(revisionSchema).transform(revision);
    const patch = new ZodValidationPipe(userPatchSchema).transform(input);
    try {
      return userDto(await this.users.patch(userId, version, patch, Date.now()));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "NOT_FOUND") throw new ApiError("NOT_FOUND", 404);
        if (error.message === "REVISION_CONFLICT" || error.message === "LAST_SUPERADMIN")
          throw new ApiError(error.message, 409);
      }
      throw error;
    }
  }
}
