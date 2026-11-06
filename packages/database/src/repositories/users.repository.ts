import type { DataSource, EntityManager } from "typeorm";
import { emailSchema, userPatchSchema, usersQuerySchema, type User } from "@kabuki-neko/shared";
import { writeTransaction } from "../data-source.factory";
import { lockSettings } from "./settings.repository";
export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  is_active: boolean;
  auth_version: number;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface NewAccount {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}
export async function insertAccount(
  manager: EntityManager,
  account: NewAccount,
  role: User["role"],
  now: number,
) {
  const email = emailSchema.parse(account.email);
  const repo = manager.getRepository<UserRow & { password_hash: string }>("users");
  if (await repo.existsBy({ email })) throw new Error("EMAIL_EXISTS");
  await repo.insert({
    id: account.id,
    name: account.name,
    email,
    password_hash: account.passwordHash,
    role,
    created_at: now,
    updated_at: now,
  });
  return manager.getRepository<UserRow>("users").findOneByOrFail({ id: account.id });
}
export class UsersRepository {
  constructor(private readonly db: DataSource) {}
  current(id: string) {
    return this.db.getRepository<UserRow>("users").findOneBy({ id });
  }
  async list(input: unknown) {
    const { page, limit, search, role, isActive } = usersQuerySchema.parse(input);
    const q = this.db.getRepository<UserRow>("users").createQueryBuilder("u");
    if (search)
      q.andWhere(
        "(LOWER(u.name) LIKE LOWER(:search) ESCAPE '!' OR LOWER(u.email) LIKE LOWER(:search) ESCAPE '!')",
        {
          search: `%${search.replace(/[!%_]/gu, "!$&")}%`,
        },
      );
    if (role !== undefined) q.andWhere("u.role = :role", { role });
    if (isActive !== undefined) q.andWhere("u.is_active = :isActive", { isActive });
    const [items, total] = await q
      .orderBy("u.created_at", "DESC")
      .addOrderBy("u.id", "ASC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
  async patch(id: string, revision: number, input: unknown, now: number) {
    const patch = userPatchSchema.parse(input);
    return writeTransaction(this.db, async (manager) => {
      await lockSettings(manager);
      const repo = manager.getRepository<UserRow>("users");
      const query = repo.createQueryBuilder("u").where("u.id = :id", { id });
      if (manager.connection.options.type !== "better-sqlite3") query.setLock("pessimistic_write");
      const row = await query.getOne();
      if (!row) throw new Error("NOT_FOUND");
      if (row.revision !== revision) throw new Error("REVISION_CONFLICT");
      const role = patch.role ?? row.role,
        active = patch.isActive ?? row.is_active;
      if (role === row.role && active === row.is_active) return row;
      if (
        row.role === "SUPERADMIN" &&
        row.is_active &&
        (role !== "SUPERADMIN" || !active) &&
        (await repo.countBy({ role: "SUPERADMIN", is_active: true })) <= 1
      )
        throw new Error("LAST_SUPERADMIN");
      await repo.update(id, {
        role,
        is_active: active,
        auth_version: row.auth_version + 1,
        revision: row.revision + 1,
        updated_at: now,
      });
      await manager
        .createQueryBuilder()
        .update("refresh_tokens")
        .set({ revoked_at: now })
        .where("user_id = :id AND revoked_at IS NULL", { id })
        .execute();
      return repo.findOneByOrFail({ id });
    });
  }
}
