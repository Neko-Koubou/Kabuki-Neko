import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { UserRow } from "@kabuki-neko/database";
import { RefreshService } from "../../modules/auth/refresh.service";
import { ApiError } from "../error.filter";

export interface VerifiedPrincipal {
  readonly user: Readonly<UserRow>;
}
// Nest may instantiate route enhancers separately from injected service providers.
const tokens = new WeakMap<VerifiedPrincipal, string>();
const requests = new WeakMap<Request, VerifiedPrincipal>();
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(RefreshService) private readonly refresh: RefreshService) {}
  async authenticate(token: string): Promise<VerifiedPrincipal> {
    const { user } = await this.refresh.authenticateAccess(token);
    const principal = Object.freeze({ user: Object.freeze(user) });
    tokens.set(principal, token);
    return principal;
  }
  /** Reusable for each host command: an earlier socket handshake is insufficient. */
  async current(principal: VerifiedPrincipal): Promise<UserRow> {
    const token = tokens.get(principal);
    if (!token) throw new ApiError("AUTH_REQUIRED", 401);
    return (await this.refresh.authenticateAccess(token)).user;
  }
  principal(request: Request): VerifiedPrincipal {
    const principal = requests.get(request);
    if (!principal) throw new ApiError("AUTH_REQUIRED", 401);
    return principal;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.get("authorization");
    const token = header?.match(/^Bearer ([^\s]+)$/iu)?.[1];
    if (!token) throw new ApiError("AUTH_REQUIRED", 401);
    requests.set(request, await this.authenticate(token));
    return true;
  }
}
