import { BlockList, isIP } from "node:net";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { ConfigService } from "../../config/config.service";
import { StateConnections } from "../../providers/state/state.module";
import { ApiError } from "../error.filter";
import { RateLimitService } from "../rate-limit.service";

export function normalizeIp(value: string): string {
  if (value.toLowerCase().startsWith("::ffff:") && isIP(value.slice(7)) === 4)
    return value.slice(7);
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  throw new ApiError("VALIDATION_FAILED", 422);
}
export function trustedProxies(cidrs: readonly string[]): (address: string) => boolean {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, bits] = cidr.split("/");
    if (!address) throw new Error("Invalid proxy CIDR");
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    list.addSubnet(address, Number(bits), family);
  }
  return (address) => {
    try {
      const ip = normalizeIp(address);
      return list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
    } catch {
      return false;
    }
  };
}
export function clientIp(
  remote: string,
  forwarded: string | undefined,
  trusted: (ip: string) => boolean,
): string {
  let current = normalizeIp(remote);
  if (!forwarded || !trusted(current)) return current;
  for (const candidate of forwarded.split(",").reverse()) {
    if (!trusted(current)) break;
    current = normalizeIp(candidate.trim());
  }
  return current;
}
export class OriginGuard implements CanActivate {
  constructor(private readonly origins: readonly string[]) {}
  assert(origin: string | undefined, client?: string): void {
    if (!origin || !this.origins.includes(origin) || (client !== undefined && client !== "web-v1"))
      throw new ApiError("ORIGIN_DENIED", 403);
  }
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    this.assert(request.get("origin"), request.get("x-kabuki-client") ?? "");
    return true;
  }
}
const services = new WeakMap<ConfigService, RateLimitService>();
/** CommonModule and bootstrap share the same single-instance counters. */
export function rateLimiter(
  config: ConfigService,
  connections: StateConnections,
): RateLimitService {
  let service = services.get(config);
  if (!service) {
    if (config.get("STATE_DRIVER") === "redis" && !connections.command)
      throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    service = new RateLimitService(connections.command, config.get("STATE_NAMESPACE"));
    services.set(config, service);
  }
  return service;
}
export function configureRequestGuards(app: INestApplication): void {
  const config = app.get(ConfigService),
    origins = config.get("CORS_ORIGIN");
  const guard = new OriginGuard(origins),
    trusted = trustedProxies(config.get("TRUST_PROXY_CIDRS"));
  const limiter = rateLimiter(config, app.get(StateConnections));
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow: boolean) => void) =>
      callback(null, !!origin && origins.includes(origin)),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Kabuki-Client",
      "If-Match",
      "Idempotency-Key",
    ],
    exposedHeaders: ["ETag", "X-Request-Id", "Retry-After"],
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.vary("Origin");
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
        guard.assert(request.get("origin"), request.get("x-kabuki-client") ?? "");
      const ip = clientIp(
        request.socket.remoteAddress ?? "127.0.0.1",
        request.get("x-forwarded-for"),
        trusted,
      );
      response.locals.clientIp = ip;
      // Authenticated route tiers attach after identity validation in CommonModule.
      // Only anonymous public routes consume the IP PUBLIC tier here.
      if (
        [
          "/api/v1/auth/setup-status",
          "/api/v1/health",
          "/api/v1/locales",
          "/api/v1/system/public",
        ].includes(request.path)
      ) {
        void limiter.consume("PUBLIC", ip).then(() => next(), next);
      } else next();
    } catch (error) {
      next(error);
    }
  });
}
