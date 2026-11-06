import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { User } from "@kabuki-neko/shared";
import type { Request } from "express";
import { JwtGuard, type VerifiedPrincipal } from "./jwt.guard";
import { ApiError } from "../error.filter";

const rolesKey = Symbol("required-roles");
export const RequireRoles = (...roles: User["role"][]) => SetMetadata(rolesKey, roles);
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(JwtGuard) private readonly jwt: JwtGuard,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async assert(principal: VerifiedPrincipal, roles: readonly User["role"][]) {
    const user = await this.jwt.current(principal);
    if (!roles.includes(user.role)) throw new ApiError("FORBIDDEN", 403);
    return user;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<User["role"][]>(rolesKey, [
      context.getHandler(),
      context.getClass(),
    ]) ?? ["SUPERADMIN", "CREATOR"];
    await this.assert(this.jwt.principal(context.switchToHttp().getRequest<Request>()), roles);
    return true;
  }
}
