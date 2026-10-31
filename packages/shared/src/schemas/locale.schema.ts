import { z } from "zod";
import { LOCALE_LIMITS } from "../constants/limits";
import { codePointLength, hasForbiddenControls, textSchema } from "../unicode";
import { jsonByteLimitSchema } from "./quiz.schema";
import { localeTagSchema } from "./system.schema";

export const LOCALE_NAMESPACES = [
  "common",
  "auth",
  "quizzes",
  "studio",
  "media",
  "host",
  "player",
  "reports",
  "admin",
  "validation",
  "accessibility",
  "about",
] as const;
export const localeNamespaceSchema = z.enum(LOCALE_NAMESPACES);
export type LocaleNamespace = z.infer<typeof localeNamespaceSchema>;
export const CATALOG_VERSION = "1" as const;
export const localeDirectionSchema = z.enum(["ltr", "rtl"]);
const productionTagSchema = localeTagSchema.refine((tag) => !["en-XA", "ar-XB"].includes(tag), {
  message: "INVALID_LOCALE",
});
export const packageVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
  )
  .refine(
    (version) => {
      const prerelease = version.split("+")[0]?.split("-").slice(1).join("-");
      return (
        !prerelease ||
        prerelease
          .split(".")
          .every((part) => !/^\d+$/u.test(part) || part === "0" || !part.startsWith("0"))
      );
    },
    { message: "INVALID_FORMAT" },
  );
const creditUrlSchema = z
  .string()
  .max(LOCALE_LIMITS.creditUrlChars)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    },
    { message: "INVALID_FORMAT" },
  );
const manifestFields = {
  schemaVersion: z.literal(1),
  locale: productionTagSchema,
  nativeName: textSchema({ min: 1, max: LOCALE_LIMITS.nativeName, trim: true }),
  direction: localeDirectionSchema,
  packageVersion: packageVersionSchema,
  catalogVersion: z.literal(CATALOG_VERSION),
  credits: z
    .array(
      z.strictObject({
        name: textSchema({ min: 1, max: LOCALE_LIMITS.creditName, trim: true }),
        url: creditUrlSchema.nullable(),
      }),
    )
    .max(LOCALE_LIMITS.credits),
};
export const localeManifestSchema = z.strictObject(manifestFields);
/** Explicit test/build opt-in only; production schemas always reject reserved pseudo locales. */
export const pseudoLocaleManifestSchema = z.strictObject({
  ...manifestFields,
  locale: localeTagSchema,
});
export type LocaleManifest = z.infer<typeof localeManifestSchema>;
export const messageKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/u);
export const fullMessageKeySchema = messageKeySchema.refine(
  (key) => {
    const [namespace, ...parts] = key.split(".");
    return localeNamespaceSchema.safeParse(namespace).success && parts.length > 0;
  },
  { message: "INVALID_FORMAT" },
);
export const placeholderNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*$/u)
  .refine((name) => !["constructor", "prototype", "__proto__"].includes(name), {
    message: "INVALID_FORMAT",
  });
export const messageContractSchema = z.strictObject({
  description: textSchema({ min: 1, max: 4_000, multiline: true }),
  placeholders: z.record(placeholderNameSchema, z.enum(["string", "number", "date"])),
  required: z.boolean(),
});
export const messageContractsSchema = z
  .record(fullMessageKeySchema, messageContractSchema)
  .refine((contracts) => Object.keys(contracts).length <= LOCALE_LIMITS.keys, {
    message: "TOO_MANY_ITEMS",
  });
export type MessageContracts = z.infer<typeof messageContractsSchema>;
export const messageValueSchema = z.string().superRefine((value, ctx) => {
  const length = codePointLength(value);
  if (length < 1 || length > LOCALE_LIMITS.messageCodePoints)
    ctx.addIssue({ code: "custom", message: "TOO_LONG" });
  if (/[\uD800-\uDFFF]/u.test(value) || hasForbiddenControls(value, { multiline: true }))
    ctx.addIssue({ code: "custom", message: "INVALID_FORMAT" });
  if (/<\/?[A-Za-z][^>]*>/u.test(value))
    ctx.addIssue({ code: "custom", message: "FORBIDDEN_MARKUP" });
});
/** ICU AST/placeholder validation and duplicate JSON key detection are build-tool responsibilities. */
export const namespaceMessagesSchema = jsonByteLimitSchema(LOCALE_LIMITS.namespaceBytes)
  .pipe(z.record(messageKeySchema, messageValueSchema))
  .refine((messages) => Object.keys(messages).length <= LOCALE_LIMITS.keys, {
    message: "TOO_MANY_ITEMS",
  });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const localeAssetSchema = z.strictObject({
  name: localeNamespaceSchema,
  url: z.string().regex(/^\/locales\/[a-f0-9]{64}\/[A-Za-z0-9-]{1,63}\/[a-z]+\.json$/u),
  sha256: sha256Schema,
});
export const localeEntrySchema = z
  .strictObject({
    tag: productionTagSchema,
    nativeName: manifestFields.nativeName,
    direction: localeDirectionSchema,
    packageVersion: packageVersionSchema,
    coverage: z.number().min(0).max(1),
    catalogVersion: z.literal(CATALOG_VERSION),
    namespaces: z.array(localeAssetSchema).length(LOCALE_NAMESPACES.length),
  })
  .superRefine((entry, ctx) => {
    if (new Set(entry.namespaces.map((asset) => asset.name)).size !== LOCALE_NAMESPACES.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_ID" });
    for (const asset of entry.namespaces)
      if (!asset.url.endsWith(`/${entry.tag}/${asset.name}.json`))
        ctx.addIssue({ code: "custom", message: "INVALID_REFERENCE" });
  });
export const localeRegistrySchema = z
  .strictObject({
    buildId: sha256Schema,
    catalogVersion: z.literal(CATALOG_VERSION),
    locales: z.array(localeEntrySchema).min(1),
  })
  .superRefine((registry, ctx) => {
    if (new Set(registry.locales.map((locale) => locale.tag)).size !== registry.locales.length)
      ctx.addIssue({ code: "custom", message: "DUPLICATE_LOCALE" });
    if (!registry.locales.some((locale) => locale.tag === "en" && locale.coverage === 1))
      ctx.addIssue({ code: "custom", message: "MISSING_KEY" });
    if (
      registry.locales.some((locale) =>
        locale.namespaces.some((asset) => !asset.url.startsWith(`/locales/${registry.buildId}/`)),
      )
    )
      ctx.addIssue({ code: "custom", message: "INCOMPATIBLE_VERSION" });
  });
export const localeDiagnosticCodes = [
  "INVALID_MANIFEST",
  "DUPLICATE_LOCALE",
  "UNKNOWN_KEY",
  "MISSING_KEY",
  "PLACEHOLDER_MISMATCH",
  "INVALID_ICU",
  "FORBIDDEN_MARKUP",
  "PACKAGE_TOO_LARGE",
  "INCOMPATIBLE_VERSION",
] as const;
export const localeDiagnosticSchema = z.strictObject({
  file: z.string(),
  namespace: localeNamespaceSchema.nullable(),
  key: z.string().nullable(),
  severity: z.enum(["error", "warning"]),
  code: z.enum(localeDiagnosticCodes),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  message: z.string(),
});
export type LocaleEntry = z.infer<typeof localeEntrySchema>;
export type LocaleRegistry = z.infer<typeof localeRegistrySchema>;
export type LocaleDiagnostic = z.infer<typeof localeDiagnosticSchema>;
