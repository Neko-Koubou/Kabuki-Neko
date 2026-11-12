import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { z } from "zod";
import {
  AuthRepository,
  UsersRepository,
  type TokenRecord,
  type UserRow,
} from "@kabuki-neko/database";
import { AUTH_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { uuidSchema, userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import type { CookieOptions } from "express";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";

const claimsSchema = z.object({
  iss: z.literal("kabuki-neko"),
  aud: z.string(),
  sub: uuidSchema,
  jti: uuidSchema,
  ver: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
const refreshClaimsSchema = claimsSchema.extend({ familyId: uuidSchema });
export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: 900;
  refreshExpiresAt: number;
  record: TokenRecord;
}
export function userDto(user: UserRow) {
  return userSchema.parse({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatar: {
      style: "avatar_style" in user ? user.avatar_style : undefined,
      seed: "avatar_seed" in user ? user.avatar_seed : undefined,
    },
    isActive: user.is_active,
    revision: user.revision,
    createdAt: user.created_at,
  });
}
export function refreshCookieOptions(
  secure: boolean,
  expiresAt: number,
  now = Date.now(),
): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/api/v1/auth",
    maxAge: Math.max(0, expiresAt - now),
  };
}
@Injectable()
export class RefreshService {
  private readonly jwt = new JwtService();
  /** Lazily derived HMAC key for credential fingerprints (see `credentialFingerprint`). */
  private fingerprintKey: Buffer | null = null;
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
  ) {}

  /**
   * Keyed, non-reversible fingerprint of a credential (password or invite code) for idempotency
   * request hashes (code review CR-01; SA §2.3 "request_dedup does not store credentials", §4.2).
   * HMAC-SHA256 under a key derived by HKDF from the refresh secret, which never reaches the
   * database, so a database copy cannot be used to test password guesses at hash speed. Equal
   * inputs still give equal fingerprints, so a replayed key with a different password keeps
   * failing with IDEMPOTENCY_CONFLICT.
   */
  credentialFingerprint(value: string): string {
    this.fingerprintKey ??= Buffer.from(
      hkdfSync("sha256", this.config.secrets.refreshSecret, "", "kabuki-neko:request-dedup:v1", 32),
    );
    return createHmac("sha256", this.fingerprintKey).update(value, "utf8").digest("hex");
  }

  issue(
    user: Pick<UserRow, "id" | "auth_version">,
    familyId: string = randomUUID(),
    familyExpiresAt?: number,
  ): IssuedSession {
    const iat = Math.floor(Date.now() / 1000),
      jti = randomUUID();
    const exp =
      familyExpiresAt === undefined
        ? iat + AUTH_LIMITS.refreshFamilyLifetimeSec
        : Math.floor(familyExpiresAt / 1000);
    if (exp <= iat) throw new ApiError("TOKEN_EXPIRED", 401);
    const base = { sub: user.id, jti, ver: user.auth_version, iat };
    const refreshToken = this.jwt.sign(
      { ...base, familyId, exp },
      {
        algorithm: "HS256",
        secret: this.config.secrets.refreshSecret,
        issuer: "kabuki-neko",
        audience: "kabuki-neko-refresh",
      },
    );
    const accessToken = this.jwt.sign(
      { ...base, exp: iat + AUTH_LIMITS.accessLifetimeSec },
      {
        algorithm: "HS256",
        secret: this.config.secrets.accessSecret,
        issuer: "kabuki-neko",
        audience: "kabuki-neko-web",
      },
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: AUTH_LIMITS.accessLifetimeSec,
      refreshExpiresAt: exp * 1000,
      record: {
        id: jti,
        user_id: user.id,
        family_id: familyId,
        token_hash: this.hash(refreshToken),
        issued_at: iat * 1000,
        expires_at: exp * 1000,
      },
    };
  }

  private hash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  private decode(token: string, refresh: boolean) {
    if (!token || token.length > AUTH_LIMITS.accessTokenChars)
      throw new ApiError("AUTH_REQUIRED", 401);
    try {
      const payload: unknown = this.jwt.verify(token, {
        secret: refresh ? this.config.secrets.refreshSecret : this.config.secrets.accessSecret,
        algorithms: ["HS256"],
        issuer: "kabuki-neko",
        audience: refresh ? "kabuki-neko-refresh" : "kabuki-neko-web",
        clockTimestamp: Math.floor(Date.now() / 1000),
      });
      const claims = claimsSchema.parse(payload);
      if (claims.iat > Math.floor(Date.now() / 1000) || claims.exp <= claims.iat)
        throw new Error("Invalid lifetime");
      return payload;
    } catch (error) {
      throw new ApiError(
        error instanceof Error && error.name === "TokenExpiredError"
          ? "TOKEN_EXPIRED"
          : "TOKEN_REVOKED",
        401,
      );
    }
  }
  private refreshClaims(token: string) {
    const parsed = refreshClaimsSchema.safeParse(this.decode(token, true));
    if (!parsed.success) throw new ApiError("TOKEN_REVOKED", 401);
    return parsed.data;
  }
  async authenticateAccess(token: string) {
    const claims = claimsSchema.parse(this.decode(token, false));
    const user = await this.users.current(claims.sub);
    if (!user || !user.is_active || user.auth_version !== claims.ver)
      throw new ApiError("TOKEN_REVOKED", 401);
    return { user, claims };
  }
  async rotate(token: string): Promise<IssuedSession> {
    const claims = this.refreshClaims(token);
    const next = this.issue(
      { id: claims.sub, auth_version: claims.ver },
      claims.familyId,
      claims.exp * 1000,
    );
    try {
      await this.repository.rotate(
        claims.jti,
        this.hash(token),
        claims.ver,
        next.record,
        Date.now(),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "TOKEN_EXPIRED" || error.message === "TOKEN_REVOKED")
      )
        throw new ApiError(error.message, 401);
      throw error;
    }
    return next;
  }
  async logout(input: { refreshToken?: string; accessToken?: string }) {
    if (input.refreshToken) {
      const claims = this.refreshClaims(input.refreshToken);
      await this.repository.revokeFamily(claims.sub, claims.familyId, Date.now());
    } else if (input.accessToken) {
      const { claims } = await this.authenticateAccess(input.accessToken);
      await this.repository.revokeSession(claims.sub, claims.jti, Date.now());
    } else throw new ApiError("AUTH_REQUIRED", 401);
    return { success: true as const };
  }
}
