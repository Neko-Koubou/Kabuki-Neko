import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AuthRepository, SettingsRepository } from "@kabuki-neko/database";
import {
  setupRequestSchema,
  registerRequestSchema,
  setupStatusSchema,
} from "@kabuki-neko/shared/schemas/auth.schema";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ApiError } from "../../common/error.filter";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PasswordHasher } from "./auth.service";
import { RefreshService, userDto } from "./refresh.service";

@Injectable()
export class SetupService {
  constructor(
    @Inject(AuthRepository) private readonly accounts: AuthRepository,
    @Inject(SettingsRepository) private readonly settings: SettingsRepository,
    @Inject(IdempotencyService) private readonly operations: IdempotencyService,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(RefreshService) private readonly refresh: RefreshService,
  ) {}
  async status() {
    const settings = await this.settings.current();
    return setupStatusSchema.parse({
      isInitialized: settings.initialized,
      registrationMode: settings.registration_mode,
      instanceName: settings.instance_name,
      license: "Apache-2.0-with-Commons-Clause",
      defaultLocale: settings.default_locale,
    });
  }
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  private async domain<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error) {
        switch (error.message) {
          case "SETUP_COMPLETE":
          case "EMAIL_EXISTS":
          case "INVITE_UNAVAILABLE":
            throw new ApiError(error.message, 409);
          case "SETUP_REQUIRED":
          case "REGISTRATION_CLOSED":
            throw new ApiError(error.message, 403);
          case "VALIDATION_FAILED":
            throw new ApiError(error.message, 422);
        }
      }
      throw error;
    }
  }
  private async noCredentialReplay(): Promise<never> {
    throw new ApiError("OPERATION_COMPLETED_REAUTH_REQUIRED", 409);
  }

  async setup(input: unknown, key: string) {
    new ZodValidationPipe(uuidSchema).transform(key);
    const body = new ZodValidationPipe(setupRequestSchema).transform(input);
    const account = {
      id: randomUUID(),
      email: body.email,
      name: body.name,
      passwordHash: await this.passwords.hash(body.password),
    };
    return this.domain(() =>
      this.operations.execute(
        {
          actorScope: "setup",
          operation: "auth.setup",
          key,
          method: "POST",
          path: "/api/v1/auth/setup",
          query: {},
          body,
        },
        async (manager) => {
          const session = this.refresh.issue({ id: account.id, auth_version: 1 });
          const user = await this.accounts.setup(
            account,
            body.instanceName,
            session.record,
            Date.now(),
            manager,
          );
          return {
            httpStatus: 201,
            resourceId: user.id,
            response: { user: userDto(user), session },
          };
        },
        () => this.noCredentialReplay(),
        () => this.noCredentialReplay(),
      ),
    );
  }

  async register(input: unknown, key: string) {
    new ZodValidationPipe(uuidSchema).transform(key);
    const body = new ZodValidationPipe(registerRequestSchema).transform(input);
    const account = {
      id: randomUUID(),
      email: body.email,
      name: body.name,
      passwordHash: await this.passwords.hash(body.password),
    };
    const inviteHash = body.inviteCode === undefined ? undefined : this.hash(body.inviteCode);
    return this.domain(() =>
      this.operations.execute(
        {
          actorScope: `registration:${this.hash(body.email)}`,
          operation: "auth.register",
          key,
          method: "POST",
          path: "/api/v1/auth/register",
          query: {},
          body,
        },
        async (manager) => {
          const session = this.refresh.issue({ id: account.id, auth_version: 1 });
          const user = await this.accounts.register(
            account,
            session.record,
            Date.now(),
            inviteHash,
            manager,
          );
          return {
            httpStatus: 201,
            resourceId: user.id,
            response: { user: userDto(user), session },
          };
        },
        () => this.noCredentialReplay(),
        () => this.noCredentialReplay(),
      ),
    );
  }
}
