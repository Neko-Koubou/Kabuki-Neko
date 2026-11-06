import { randomBytes } from "node:crypto";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import * as argon2 from "argon2";
import { AuthRepository } from "@kabuki-neko/database";
import { AUTH_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { loginRequestSchema, passwordSchema } from "@kabuki-neko/shared/schemas/auth.schema";
import { ApiError } from "../../common/error.filter";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { RefreshService, userDto } from "./refresh.service";

/** Shared bound for hashing and verification: at most 128 MiB of Argon2 workspace. */
export class PasswordWorkQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= AUTH_LIMITS.concurrentHashJobs) {
      if (this.waiting.length >= AUTH_LIMITS.queuedHashJobs)
        throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
@Injectable()
export class PasswordHasher implements OnModuleInit {
  private readonly queue = new PasswordWorkQueue();
  private dummy: Promise<string> | undefined;
  async onModuleInit() {
    await this.dummyHash();
  }
  private dummyHash() {
    this.dummy ??= this.hash(randomBytes(32).toString("hex"));
    return this.dummy;
  }
  hash(password: string) {
    new ZodValidationPipe(passwordSchema).transform(password);
    return this.queue.run(() =>
      argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: AUTH_LIMITS.argonMemoryKiB,
        timeCost: AUTH_LIMITS.argonIterations,
        parallelism: AUTH_LIMITS.argonParallelism,
        salt: randomBytes(AUTH_LIMITS.saltBytes),
      }),
    );
  }
  async verify(password: string, hash: string | null) {
    const encoded = hash ?? (await this.dummyHash());
    return this.queue.run(async () => {
      try {
        return await argon2.verify(encoded, password);
      } catch {
        return false;
      }
    });
  }
}
@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(RefreshService) private readonly refresh: RefreshService,
  ) {}
  async login(input: unknown) {
    const request = new ZodValidationPipe(loginRequestSchema).transform(input);
    const credentials = await this.repository.credentials(request.email);
    const valid = await this.passwords.verify(request.password, credentials?.password_hash ?? null);
    if (!credentials || !valid || !credentials.is_active)
      throw new ApiError("INVALID_CREDENTIALS", 401);
    const session = this.refresh.issue(credentials);
    try {
      const user = await this.repository.createSession(
        credentials.id,
        credentials.password_hash,
        credentials.auth_version,
        session.record,
        Date.now(),
      );
      return { user: userDto(user), session };
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_CREDENTIALS")
        throw new ApiError("INVALID_CREDENTIALS", 401);
      throw error;
    }
  }
}
