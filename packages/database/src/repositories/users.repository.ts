import type { DataSource, EntityManager } from "typeorm";
import { emailSchema, userPatchSchema, type User } from "@kabuki-neko/shared";
import { lockParent, writeTransaction } from "../data-source.factory";
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
  async patch(id: string, revision: number, input: unknown, now: number) {
    const patch = userPatchSchema.parse(input);
    return writeTransaction(this.db, async (manager) => {
      await lockSettings(manager);
      await lockParent(manager, "users", id);
      const repo = manager.getRepository<UserRow>("users");
      const row = await repo.findOneByOrFail({ id });
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
