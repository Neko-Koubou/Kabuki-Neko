import { z } from "zod";
import { AVATAR_STYLES, USER_ROLES } from "../constants/game";
import { AUTH_LIMITS, PAGING, TEXT_LIMITS } from "../constants/limits";
import { hasForbiddenControls, textSchema } from "../unicode";

export const uuidSchema = z.uuidv4().regex(/^[0-9a-f-]+$/u);
export const timestampSchema = z.number().int().nonnegative();
export const revisionSchema = z.number().int().positive();
export const singletonIdSchema = z.literal("global");
export const nameSchema = textSchema({ min: 1, max: TEXT_LIMITS.name, trim: true });
export const emailSchema = z
  .string()
  .transform((input, ctx) => {
    const value = input.normalize("NFC").trim();
    const at = value.lastIndexOf("@");
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (
      at < 1 ||
      hasForbiddenControls(input, { identifier: true }) ||
      !/^[\x21-\x7E]+$/u.test(local) ||
      /[\s/@:\\?#[\]%]/u.test(domain)
    ) {
      ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
      return z.NEVER;
    }
    try {
      // WHATWG URL applies IDNA without importing Node-only modules into shared code.
      const asciiDomain = new URL(`https://${domain}`).hostname;
      return `${local}@${asciiDomain}`.toLowerCase();
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .email()
      .max(TEXT_LIMITS.emailAscii)
      .regex(/^[\x21-\x7E]+$/u),
  );
export const avatarSchema = z.strictObject({
  style: z.enum(AVATAR_STYLES),
  seed: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u),
});
export const userSchema = z.strictObject({
  id: uuidSchema,
  email: emailSchema,
  name: nameSchema,
  role: z.enum(USER_ROLES),
  avatar: avatarSchema,
  isActive: z.boolean(),
  revision: revisionSchema,
  createdAt: timestampSchema,
});
export type User = z.infer<typeof userSchema>;
export const userPatchSchema = z
  .strictObject({
    role: z.enum(USER_ROLES).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "REQUIRED",
  });

export const queryIntegerSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[0-9]+$/u)
      .transform(Number),
  ])
  .pipe(z.number().int());
export const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);
export function pagingQueryShape(defaultLimit: number) {
  return {
    page: queryIntegerSchema
      .pipe(z.number().min(PAGING.minPage).max(PAGING.maxPage))
      .default(PAGING.defaultPage),
    limit: queryIntegerSchema
      .pipe(z.number().min(PAGING.minLimit).max(PAGING.maxLimit))
      .default(defaultLimit),
  };
}
export const searchSchema = textSchema({ max: TEXT_LIMITS.search, trim: true });
export const usersQuerySchema = z.strictObject({
  ...pagingQueryShape(PAGING.defaults.users),
  search: searchSchema.default(""),
  role: z.enum(USER_ROLES).optional(),
  isActive: queryBooleanSchema.optional(),
  sort: z.literal("created_desc").default("created_desc"),
});
export const paginationMetaSchema = z
  .strictObject({
    page: z.number().int().min(1).max(PAGING.maxPage),
    limit: z.number().int().min(1).max(PAGING.maxLimit),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .refine((value) => value.totalPages === Math.ceil(value.total / value.limit), {
    message: "OUT_OF_RANGE",
    path: ["totalPages"],
  });
export function pageSchema<T extends z.ZodType>(item: T) {
  return z
    .strictObject({ items: z.array(item), meta: paginationMetaSchema })
    .refine(
      (value) => value.items.length <= value.meta.limit && value.items.length <= value.meta.total,
      { message: "OUT_OF_RANGE", path: ["items"] },
    );
}
export const usersPageSchema = pageSchema(userSchema);
export const invitationStatuses = ["ACTIVE", "USED", "REVOKED", "EXPIRED"] as const;
export const inviteCodeSchema = z
  .string()
  .length(AUTH_LIMITS.inviteCodeChars)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const invitationSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(invitationStatuses),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  usedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationCreateSchema = z.strictObject({
  expiresInHours: z.number().int().min(1).max(720).default(168),
});
export const invitationCreatedSchema = z.strictObject({
  invitation: invitationSchema,
  inviteCode: inviteCodeSchema,
});
export const invitationRevokedSchema = z.strictObject({ revoked: z.literal(true) });
export const invitationsQuerySchema = z.strictObject({
  ...pagingQueryShape(PAGING.defaults.invitations),
  status: z.enum(invitationStatuses).optional(),
  sort: z.literal("created_desc").default("created_desc"),
});
export const invitationsPageSchema = pageSchema(invitationSchema);
