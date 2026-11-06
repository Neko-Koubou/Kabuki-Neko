import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  type DatabaseDriver,
} from "../../packages/database/src";
import {
  AuthRepository,
  type TokenRecord,
} from "../../packages/database/src/repositories/auth.repository";
import { UsersRepository } from "../../packages/database/src/repositories/users.repository";
import { SettingsRepository } from "../../packages/database/src/repositories/settings.repository";
import { createTestRuntime } from "../helpers/runtime";
const account = (email: string) => ({
  id: randomUUID(),
  email,
  name: "猫",
  passwordHash: "fixture-hash",
});
const token = (user_id: string): TokenRecord => ({
  id: randomUUID(),
  user_id,
  family_id: randomUUID(),
  token_hash: randomUUID(),
  issued_at: 1,
  expires_at: 10000,
});
it.each<DatabaseDriver>(["sqlite", "postgres", "mysql"])(
  "%s serializes account policy/credentials and rolls back partial mutations",
  async (driver) => {
    const runtime = await createTestRuntime();
    try {
      const url =
        driver === "postgres"
          ? (await runtime.postgres()).getConnectionUri()
          : driver === "mysql"
            ? (await runtime.mysql()).getConnectionUri()
            : undefined;
      const db = createDataSource(
        { driver, sqlitePath: runtime.env.SQLITE_PATH ?? ":memory:", ...(url ? { url } : {}) },
        domainSchemas(driver),
      );
      await db.initialize();
      try {
        await migrateDatabase(db, true);
        const auth = new AuthRepository(db),
          users = new UsersRepository(db),
          settings = new SettingsRepository(db);
        const admin = account("Admin@Example.ORG"),
          original = token(admin.id);
        const setup = await Promise.allSettled([
          auth.setup(admin, "Test", original, 1),
          auth.setup(admin, "Test", original, 1),
        ]);
        expect(setup.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        expect((await users.current(admin.id))?.email).toBe("admin@example.org");
        await expect(users.patch(admin.id, 1, { isActive: false }, 2)).rejects.toThrow(
          "LAST_SUPERADMIN",
        );
        await settings.patch(2, { registrationMode: "INVITE_ONLY" }, 2);
        const inviteId = randomUUID(),
          inviteHash = randomUUID();
        await db.manager.insert("invitations", {
          id: inviteId,
          created_by: admin.id,
          code_hash: inviteHash,
          created_at: 2,
          expires_at: 999,
        });
        const entrants = [account("one@example.org"), account("two@example.org")];
        const join = await Promise.allSettled(
          entrants.map((a) => auth.register(a, token(a.id), 3, inviteHash)),
        );
        expect(join.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        expect((await auth.invitations({ status: "USED" }, 4)).meta.total).toBe(1);
        const credentials = await auth.credentials("ADMIN@example.org");
        expect(credentials?.password_hash).toBe(admin.passwordHash);
        expect(await auth.credentials("missing@example.org")).toBeNull();
        const session = token(admin.id);
        await expect(auth.createSession(admin.id, "changed", 1, session, 4)).rejects.toThrow(
          "INVALID_CREDENTIALS",
        );
        await expect(
          auth.createSession(admin.id, admin.passwordHash, 2, session, 4),
        ).rejects.toThrow("INVALID_CREDENTIALS");
        await expect(
          auth.createSession(
            admin.id,
            admin.passwordHash,
            1,
            { ...session, user_id: randomUUID() },
            4,
          ),
        ).rejects.toThrow("INVALID_REFERENCE");
        expect(await db.manager.findOneBy("refresh_tokens", { id: session.id })).toBeNull();
        await auth.createSession(admin.id, admin.passwordHash, 1, session, 4);
        const other =
          (await auth.credentials("one@example.org")) ??
          (await auth.credentials("two@example.org"));
        if (!other) throw new Error("Missing registered user");
        await auth.revokeSession(other.id, session.id, 4);
        expect(
          (
            await db.manager.findOneByOrFail<TokenRecord & { revoked_at: number | null }>(
              "refresh_tokens",
              { id: session.id },
            )
          ).revoked_at,
        ).toBeNull();
        await auth.revokeSession(admin.id, session.id, 5);
        await auth.revokeSession(admin.id, session.id, 6);
        expect(
          (
            await db.manager.findOneByOrFail<TokenRecord & { revoked_at: number | null }>(
              "refresh_tokens",
              { id: session.id },
            )
          ).revoked_at,
        ).toBe(5);
        expect(
          (
            await db.manager.findOneByOrFail<TokenRecord & { revoked_at: number | null }>(
              "refresh_tokens",
              { id: original.id },
            )
          ).revoked_at,
        ).toBeNull();
        await users.patch(other.id, other.revision, { isActive: false }, 6);
        await expect(
          auth.createSession(other.id, other.password_hash, other.auth_version, token(other.id), 7),
        ).rejects.toThrow("INVALID_CREDENTIALS");
        const next = { ...token(admin.id), family_id: original.family_id, expires_at: 20000 };
        await expect(
          auth.rotate(original.id, original.token_hash, 1, { ...next, id: original.id }, 4),
        ).rejects.toThrow();
        await auth.rotate(original.id, original.token_hash, 1, next, 5);
        expect(
          (
            await db.manager.findOneByOrFail<TokenRecord & { revoked_at: number | null }>(
              "refresh_tokens",
              { id: next.id },
            )
          ).expires_at,
        ).toBe(10000);
        await expect(
          auth.rotate(original.id, original.token_hash, 1, { ...next, id: randomUUID() }, 6),
        ).rejects.toThrow("TOKEN_REVOKED");
        expect(
          (
            await db.manager.findOneByOrFail<TokenRecord & { revoked_at: number | null }>(
              "refresh_tokens",
              { id: next.id },
            )
          ).revoked_at,
        ).toBe(6);
      } finally {
        await db.destroy();
      }
    } finally {
      await runtime.cleanup();
    }
  },
);
