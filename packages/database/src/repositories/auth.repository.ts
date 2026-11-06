import { type DataSource, type EntityManager } from "typeorm";
import { emailSchema, invitationsQuerySchema, type Invitation } from "@kabuki-neko/shared";
import { lockParent, writeTransaction } from "../data-source.factory";
import { lockSettings } from "./settings.repository";
import { insertAccount, type NewAccount, type UserRow } from "./users.repository";
export interface TokenRecord {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  issued_at: number;
  expires_at: number;
}
interface StoredToken extends TokenRecord {
  consumed_at: number | null;
  revoked_at: number | null;
  replaced_by_id: string | null;
}
interface InviteRow {
  id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  used_by: string | null;
}
function invitation(row: InviteRow, now: number): Invitation {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    status:
      row.used_at !== null
        ? "USED"
        : row.revoked_at !== null
          ? "REVOKED"
          : row.expires_at <= now
            ? "EXPIRED"
            : "ACTIVE",
  };
}
async function createWithToken(
  manager: EntityManager,
  account: NewAccount,
  role: UserRow["role"],
  token: TokenRecord,
  now: number,
) {
  if (token.user_id !== account.id || token.expires_at <= now) throw new Error("INVALID_REFERENCE");
  const user = await insertAccount(manager, account, role, now);
  await manager.insert("refresh_tokens", token);
  return user;
}
async function revokeTokens(manager: EntityManager, userId: string, familyId: string, now: number) {
  await manager
    .createQueryBuilder()
    .update("refresh_tokens")
    .set({ revoked_at: now })
    .where("user_id = :userId AND family_id = :familyId AND revoked_at IS NULL", {
      userId,
      familyId,
    })
    .execute();
}
export class AuthRepository {
  constructor(private readonly db: DataSource) {}
  credentials(email: string) {
    return this.db
      .getRepository<UserRow & { password_hash: string }>("users")
      .createQueryBuilder("u")
      .addSelect("u.password_hash")
      .where("u.email = :email", { email: emailSchema.parse(email) })
      .getOne();
  }
  createSession(
    userId: string,
    passwordHash: string,
    version: number,
    token: TokenRecord,
    now: number,
  ) {
    return writeTransaction(this.db, async (manager) => {
      await lockParent(manager, "users", userId);
      const user = await manager
        .getRepository<UserRow & { password_hash: string }>("users")
        .createQueryBuilder("u")
        .addSelect("u.password_hash")
        .where("u.id = :userId", { userId })
        .getOne();
      if (
        !user ||
        !user.is_active ||
        user.auth_version !== version ||
        user.password_hash !== passwordHash
      )
        throw new Error("INVALID_CREDENTIALS");
      if (token.user_id !== userId || token.expires_at <= now || token.issued_at > now)
        throw new Error("INVALID_REFERENCE");
      await manager.insert("refresh_tokens", token);
      return user;
    });
  }
  revokeSession(userId: string, tokenId: string, now: number) {
    return writeTransaction(this.db, async (manager) => {
      await lockParent(manager, "users", userId);
      const token = await manager
        .getRepository<StoredToken>("refresh_tokens")
        .findOneBy({ id: tokenId, user_id: userId });
      if (token) await revokeTokens(manager, userId, token.family_id, now);
    });
  }
  private transaction<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ) {
    if (!manager) return writeTransaction(this.db, work);
    if (!manager.queryRunner?.isTransactionActive || manager.connection !== this.db)
      throw new Error("INVALID_REFERENCE");
    return work(manager);
  }
  setup(
    account: NewAccount,
    instanceName: string,
    token: TokenRecord,
    now: number,
    manager?: EntityManager,
  ) {
    return this.transaction(manager, async (m) => {
      const settings = await lockSettings(m);
      if (settings.initialized || (await m.count("users")) !== 0) throw new Error("SETUP_COMPLETE");
      const user = await createWithToken(m, account, "SUPERADMIN", token, now);
      await m.update("system_settings", "global", {
        initialized: true,
        instance_name: instanceName,
        revision: settings.revision + 1,
        updated_at: now,
      });
      return user;
    });
  }
  register(
    account: NewAccount,
    token: TokenRecord,
    now: number,
    inviteHash?: string,
    manager?: EntityManager,
  ) {
    return this.transaction(manager, async (m) => {
      const settings = await lockSettings(m);
      if (!settings.initialized) throw new Error("SETUP_REQUIRED");
      if (settings.registration_mode === "SINGLE_ADMIN") throw new Error("REGISTRATION_CLOSED");
      if (settings.registration_mode === "PUBLIC" && inviteHash !== undefined)
        throw new Error("VALIDATION_FAILED");
      let invite: InviteRow | undefined;
      if (settings.registration_mode === "INVITE_ONLY") {
        if (!inviteHash) throw new Error("INVITE_UNAVAILABLE");
        const repo = m.getRepository<InviteRow & { code_hash: string }>("invitations");
        const candidate = await repo.findOneBy({ code_hash: inviteHash });
        if (!candidate) throw new Error("INVITE_UNAVAILABLE");
        await lockParent(m, "invitations", candidate.id);
        invite = await repo.findOneByOrFail({ id: candidate.id });
        if (invitation(invite, now).status !== "ACTIVE") throw new Error("INVITE_UNAVAILABLE");
      }
      const user = await createWithToken(m, account, "CREATOR", token, now);
      if (invite) await m.update("invitations", invite.id, { used_at: now, used_by: user.id });
      return user;
    });
  }
  async rotate(
    currentId: string,
    currentHash: string,
    version: number,
    next: TokenRecord,
    now: number,
  ) {
    // Return the reuse outcome from the transaction so family revocation commits before rejection.
    const outcome = await writeTransaction(this.db, async (m) => {
      await lockParent(m, "users", next.user_id);
      const repo = m.getRepository<StoredToken>("refresh_tokens");
      const row = await repo.findOneBy({ id: currentId, token_hash: currentHash });
      if (!row || row.user_id !== next.user_id || row.family_id !== next.family_id)
        return "TOKEN_REVOKED";
      await lockParent(m, "refresh_tokens", row.id);
      if (row.consumed_at !== null) {
        await revokeTokens(m, row.user_id, row.family_id, now);
        return "TOKEN_REVOKED";
      }
      const user = await m.getRepository<UserRow>("users").findOneByOrFail({ id: row.user_id });
      if (!user.is_active || user.auth_version !== version || row.revoked_at !== null)
        return "TOKEN_REVOKED";
      if (row.expires_at <= now) return "TOKEN_EXPIRED";
      await repo.insert({ ...next, expires_at: row.expires_at });
      await repo.update(row.id, { replaced_by_id: next.id, consumed_at: now });
      return "OK";
    });
    if (outcome !== "OK") throw new Error(outcome);
  }
  revokeFamily(userId: string, familyId: string, now: number) {
    return writeTransaction(this.db, async (m) => {
      await lockParent(m, "users", userId);
      await revokeTokens(m, userId, familyId, now);
    });
  }
  purgeExpired(now: number) {
    return this.db
      .createQueryBuilder()
      .delete()
      .from("refresh_tokens")
      .where("expires_at < :cutoff", { cutoff: now - 86_400_000 })
      .execute();
  }
  createInvitation(
    id: string,
    actorId: string,
    codeHash: string,
    expiresAt: number,
    now: number,
    manager?: EntityManager,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(codeHash) || expiresAt <= now) throw new Error("INVALID_REFERENCE");
    return this.transaction(manager, async (m) => {
      await m.insert("invitations", {
        id,
        created_by: actorId,
        code_hash: codeHash,
        created_at: now,
        expires_at: expiresAt,
      });
      return invitation(
        await m.getRepository<InviteRow>("invitations").findOneByOrFail({ id }),
        now,
      );
    });
  }
  async revokeInvitation(id: string, now: number) {
    return writeTransaction(this.db, async (m) => {
      const query = m
        .getRepository<InviteRow>("invitations")
        .createQueryBuilder("i")
        .where("i.id = :id", { id });
      if (m.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
      const row = await query.getOne();
      if (!row) throw new Error("NOT_FOUND");
      if (row.used_at !== null) throw new Error("INVITE_UNAVAILABLE");
      if (row.revoked_at === null) await m.update("invitations", id, { revoked_at: now });
      return { revoked: true as const };
    });
  }
  async invitations(input: unknown, now: number) {
    const { page, limit, status } = invitationsQuerySchema.parse(input);
    const q = this.db.getRepository<InviteRow>("invitations").createQueryBuilder("i");
    if (status === "USED") q.where("i.used_at IS NOT NULL");
    if (status === "REVOKED") q.where("i.used_at IS NULL AND i.revoked_at IS NOT NULL");
    if (status === "EXPIRED" || status === "ACTIVE")
      q.where("i.used_at IS NULL AND i.revoked_at IS NULL").andWhere(
        status === "ACTIVE" ? "i.expires_at > :now" : "i.expires_at <= :now",
        { now },
      );
    const [rows, total] = await q
      .orderBy("i.created_at", "DESC")
      .addOrderBy("i.id", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      items: rows.map((row) => invitation(row, now)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
