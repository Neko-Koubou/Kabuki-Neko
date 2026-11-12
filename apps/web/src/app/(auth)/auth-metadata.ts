/**
 * Server helpers shared by the auth routes (TASK-135): localized page titles from the request
 * locale (cookie → Accept-Language → instance default), noindex metadata, a one-shot no-cache
 * setup-status check against the internal API URL, and `returnTo` extraction from search params.
 * Server-only: imported from the `(auth)` page modules.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { setupStatusSchema } from "@kabuki-neko/shared/schemas/auth.schema";
import type { z } from "zod";
import { serverTranslator } from "@/lib/i18n/locale.server";

/** Product name appended to titles. */
const PRODUCT = "Kabuki Neko";
/** Upper bound for the server-side setup-status request. */
const STATUS_TIMEOUT_MS = 1_500;

/** Metadata with a localized title (`<key> · Kabuki Neko`) that is never indexed. */
export async function authMetadata(titleKey: string): Promise<Metadata> {
  const requestHeaders = await headers();
  const translator = await serverTranslator(
    {
      cookieHeader: requestHeaders.get("cookie"),
      acceptLanguage: requestHeaders.get("accept-language"),
    },
    ["auth"],
  );
  const title = translator?.has(titleKey) ? `${translator.t(titleKey)} · ${PRODUCT}` : PRODUCT;
  return { title, robots: { index: false, follow: false } };
}

/** Current setup status (no cache); null when the API cannot be reached or answers badly. */
export async function fetchSetupStatus(): Promise<z.infer<typeof setupStatusSchema> | null> {
  const base = process.env.API_INTERNAL_URL;
  if (!base) return null;
  try {
    const response = await fetch(new URL("/api/v1/auth/setup-status", base), {
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = setupStatusSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Search params as Next passes them to pages. */
export type AuthSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First `returnTo` value (sanitized later on the client by `safeReturnTo`). */
export async function returnToFrom(searchParams: AuthSearchParams): Promise<string | null> {
  const value = (await searchParams).returnTo;
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length <= 2048 ? first : null;
}
