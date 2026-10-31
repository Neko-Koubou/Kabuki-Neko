import { describe, expect, it } from "vitest";
import {
  authResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
  setupRequestSchema,
} from "./auth.schema";
import {
  emailSchema,
  invitationCreateSchema,
  invitationSchema,
  invitationsQuerySchema,
  pageSchema,
  singletonIdSchema,
  userPatchSchema,
  userSchema,
  usersQuerySchema,
  uuidSchema,
} from "./users.schema";
import {
  healthSchema,
  localeTagSchema,
  publicConfigSchema,
  settingsPatchSchema,
  settingsSchema,
} from "./system.schema";

const id = "8a16b9fb-64e1-4e98-9daf-4bfe691d518b";
const account = { name: " Neko ", email: " NEKO@Example.COM ", password: " e\u0301 password " };
const user = {
  id,
  name: "Neko",
  email: "neko@example.com",
  role: "CREATOR",
  avatar: { style: "bottts", seed: "neko_1" },
  isActive: true,
  revision: 1,
  createdAt: 0,
};
const settings = {
  instanceName: "Kabuki Neko",
  registrationMode: "PUBLIC",
  maxImageSizeMb: 5,
  maxAudioSizeMb: 10,
  maxVideoSizeMb: 25,
  maxPlayersPerRoom: 200,
  profanityWords: [],
  defaultLocale: "id",
  revision: 1,
  updatedAt: 0,
};

describe("auth and identity boundaries", () => {
  it("normalizes display fields and IDNA email while preserving passwords exactly", () => {
    const result = setupRequestSchema.parse({ ...account, instanceName: " Kabuki Neko " });
    expect(result).toEqual({
      name: "Neko",
      email: "neko@example.com",
      password: account.password,
      instanceName: "Kabuki Neko",
    });
    expect(emailSchema.parse("User@bücher.example")).toBe("user@xn--bcher-kva.example");
    expect(emailSchema.safeParse("İ@example.com").success).toBe(false);
  });
  it.each([
    "a@evil.com/path",
    "a@evil.com:443",
    "a@evil.com#x",
    "a@evil.com?x",
    "a@@evil.com",
    "a@%65xample.com",
    "a\n@example.com",
    "a@evil.com\\test",
  ])("rejects ambiguous email %s", (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });
  it("rejects role injection, unknown keys, invalid invite codes and password bounds", () => {
    expect(registerRequestSchema.safeParse({ ...account, role: "SUPERADMIN" }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...account, inviteCode: null }).success).toBe(false);
    expect(
      registerRequestSchema.parse({ ...account, inviteCode: "a".repeat(43) }).inviteCode,
    ).toHaveLength(43);
    expect(
      registerRequestSchema.safeParse({ ...account, inviteCode: "a".repeat(42) }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.parse({ email: account.email, password: " ".repeat(12) }).password,
    ).toBe(" ".repeat(12));
    expect(
      loginRequestSchema.safeParse({ email: account.email, password: "a".repeat(129) }).success,
    ).toBe(false);
    expect(loginRequestSchema.safeParse({ email: account.email, password: "short" }).success).toBe(
      false,
    );
  });
  it("requires complete safe responses and canonical UUIDs without conflating singleton IDs", () => {
    expect(userSchema.parse(user)).toEqual(user);
    expect(
      authResponseSchema.safeParse({
        user,
        accessToken: "token",
        expiresIn: 900,
        refreshToken: "leak",
      }).success,
    ).toBe(false);
    expect(userSchema.safeParse({ ...user, passwordHash: "leak" }).success).toBe(false);
    expect(uuidSchema.safeParse(id.toUpperCase()).success).toBe(false);
    expect(uuidSchema.safeParse("global").success).toBe(false);
    expect(singletonIdSchema.parse("global")).toBe("global");
    expect(singletonIdSchema.safeParse(id).success).toBe(false);
    expect(userSchema.safeParse({ ...user, createdAt: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(
      false,
    );
  });
});
describe("settings and policy contracts", () => {
  it("requires full responses and nonempty patches of editable fields only", () => {
    expect(settingsSchema.parse(settings)).toEqual(settings);
    expect(settingsPatchSchema.parse({ maxPlayersPerRoom: 5_000 })).toEqual({
      maxPlayersPerRoom: 5_000,
    });
    for (const patch of [
      {},
      { maxPlayersPerRoom: undefined },
      { maxPlayersPerRoom: null },
      { initialized: true },
      { revision: 2 },
      { id: "global" },
      { maxPlayersPerRoom: 5_001 },
      { maxImageSizeMb: 26 },
      { maxAudioSizeMb: 101 },
      { maxVideoSizeMb: 251 },
      { maxVideoSizeMb: 0 },
    ])
      expect(settingsPatchSchema.safeParse(patch).success).toBe(false);
    expect(
      settingsPatchSchema.safeParse({ profanityWords: ["École", " e\u0301cole "] }).success,
    ).toBe(false);
    expect(
      settingsPatchSchema.safeParse({
        profanityWords: Array.from({ length: 1001 }, (_, i) => `word${i}`),
      }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, updatedAt: undefined }).success).toBe(false);
  });
  it("accepts extensible canonical locale syntax for service-level installed-registry checks", () => {
    expect(settingsPatchSchema.parse({ defaultLocale: "de-de" })).toEqual({
      defaultLocale: "de-DE",
    });
    expect(localeTagSchema.parse("zh-Hant")).toBe("zh-Hant");
    for (const locale of ["../id", "id<script>", "", "en_US"])
      expect(localeTagSchema.safeParse(locale).success).toBe(false);
  });
  it("rejects empty user mutation and credential leakage through public health/config", () => {
    expect(userPatchSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(userPatchSchema.safeParse({}).success).toBe(false);
    expect(userPatchSchema.safeParse({ email: "other@example.com" }).success).toBe(false);
    const part = { status: "up", checkedAt: 0, errorCode: null };
    const health = {
      app: "Kabuki Neko",
      status: "ok",
      dbDriver: "sqlite",
      storageDriver: "local",
      stateDriver: "memory",
      storageHealth: "up",
      checkedAt: 0,
      db: part,
      storage: part,
      state: part,
    };
    expect(healthSchema.parse(health)).toEqual(health);
    expect(
      healthSchema.safeParse({ ...health, db: { ...part, url: "postgres://secret" } }).success,
    ).toBe(false);
    expect(publicConfigSchema.safeParse({ ...settings, password: "secret" }).success).toBe(false);
  });
});
describe("paging and invitations", () => {
  it("parses only deliberate query coercions and rejects unknown filter/sort fields", () => {
    expect(usersQuerySchema.parse({ page: "2", limit: "10", isActive: "false" })).toEqual({
      page: 2,
      limit: 10,
      isActive: false,
      search: "",
      sort: "created_desc",
    });
    expect(invitationsQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sort: "created_desc" });
    for (const query of [
      { page: "" },
      { page: "1e2" },
      { page: "1.1" },
      { page: true },
      { page: 100001 },
      { limit: 101 },
      { isActive: "0" },
      { sort: "email_asc" },
      { secret: "x" },
    ])
      expect(usersQuerySchema.safeParse(query).success).toBe(false);
    expect(
      pageSchema(userSchema).parse({
        items: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      }).items,
    ).toEqual([]);
    expect(
      pageSchema(userSchema).safeParse({
        items: [user],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      }).success,
    ).toBe(false);
  });
  it("enforces invitation lifetime and explicit nullable response fields", () => {
    expect(invitationCreateSchema.parse({})).toEqual({ expiresInHours: 168 });
    for (const expiresInHours of [0, 721, 1.5, null])
      expect(invitationCreateSchema.safeParse({ expiresInHours }).success).toBe(false);
    expect(
      invitationSchema.parse({
        id,
        status: "ACTIVE",
        createdAt: 0,
        expiresAt: 1000,
        usedAt: null,
        revokedAt: null,
      }).usedAt,
    ).toBeNull();
    expect(
      invitationSchema.safeParse({ id, status: "ACTIVE", createdAt: 0, expiresAt: 1000 }).success,
    ).toBe(false);
  });
});
