import { z } from "zod";
import { AUTH_LIMITS } from "../constants/limits";
import { passwordSchema } from "../unicode";
import { emailSchema, inviteCodeSchema, nameSchema, userSchema } from "./users.schema";
import { instanceNameSchema, localeTagSchema, registrationModeSchema } from "./system.schema";

export { passwordSchema } from "../unicode";
export const setupStatusSchema = z.strictObject({
  isInitialized: z.boolean(),
  registrationMode: registrationModeSchema,
  instanceName: instanceNameSchema,
  license: z.literal("Apache-2.0-with-Commons-Clause"),
  defaultLocale: localeTagSchema,
});
export const setupRequestSchema = z.strictObject({
  instanceName: instanceNameSchema,
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export const registerRequestSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  inviteCode: inviteCodeSchema.optional(),
});
export const loginRequestSchema = z.strictObject({ email: emailSchema, password: passwordSchema });
export const accessTokenSchema = z.string().min(1).max(AUTH_LIMITS.accessTokenChars);
export const refreshResponseSchema = z.strictObject({
  accessToken: accessTokenSchema,
  expiresIn: z.literal(AUTH_LIMITS.accessLifetimeSec),
});
export const authResponseSchema = z.strictObject({
  user: userSchema,
  ...refreshResponseSchema.shape,
});
export const logoutResponseSchema = z.strictObject({ success: z.literal(true) });
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
