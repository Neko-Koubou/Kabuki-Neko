/**
 * Server-side locale bootstrap for the root layout (SA §8.2, US-21; TASK-117).
 *
 * - Reads the generated registry (`<cwd>/public/locales/registry.json`, written by
 *   `pnpm locales:build`; `KN_LOCALES_DIR` overrides the directory) and loads catalogs from the same
 *   files the browser fetches, through the shared catalog loader, so the SSR messages pass the same
 *   SHA-256 and AST validation. The registry is re-read only when its mtime changes.
 * - Resolves the locale from the `kn_locale` cookie, then `Accept-Language`, then the instance
 *   default from the API's public config (`API_INTERNAL_URL`, cached 30 s per process and bounded
 *   by a 1.5 s timeout, because every SSR request shares the web server's rate-limit budget), then
 *   `en`. Browser storage is client-only and handled by the provider after hydration.
 * - Returns a plain serializable snapshot (ASTs as JSON objects) for the client provider. When the
 *   bundle is missing or invalid it returns null and the shell renders with the safe fallback text.
 * This module uses Node APIs and must only be imported from server components.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import { publicConfigSchema } from "@kabuki-neko/shared/schemas/system.schema";
import {
  SHELL_NAMESPACES,
  createCatalogLoader,
  serializeCatalog,
  type CatalogLoader,
  type LocaleCatalog,
  type SerializedCatalog,
} from "./catalog-loader";
import { createTranslator, type Translator } from "./format";
import { readLocaleCookie, resolveLocale, type LocaleSource } from "./resolve";

/** Instance default cache lifetime and fetch timeout. */
const INSTANCE_DEFAULT_TTL_MS = 30_000;
const INSTANCE_DEFAULT_TIMEOUT_MS = 1_500;

/** Snapshot handed from the root layout to the client locale provider. */
export interface InitialLocale {
  /** Raw registry JSON (validated again by the client loader). */
  registry: unknown;
  catalog: SerializedCatalog;
  /** Where the SSR locale came from; `cookie` means the explicit choice already applied. */
  source: LocaleSource;
}

/** Directory holding `registry.json` and the content-addressed catalogs. */
function localesDir(): string {
  // turbopackIgnore: the public directory ships beside the server; it must not be traced into it.
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.KN_LOCALES_DIR ??
      path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "locales"),
  );
}

/** Loader cached per registry file version (mtime) so namespace files are read once. */
let cached: { mtimeMs: number; registry: unknown; loader: CatalogLoader } | null = null;

/** Loader over the on-disk bundle; null when the registry is missing or invalid. */
async function diskLoader(): Promise<{ registry: unknown; loader: CatalogLoader } | null> {
  const dir = localesDir();
  const file = path.join(dir, "registry.json");
  try {
    const { mtimeMs } = await stat(/*turbopackIgnore: true*/ file);
    if (cached?.mtimeMs === mtimeMs) return cached;
    const registry: unknown = JSON.parse(await readFile(/*turbopackIgnore: true*/ file, "utf8"));
    const loader = createCatalogLoader({
      registry,
      // Registry URLs are `/locales/<buildId>/<tag>/<ns>.json`; map them into the directory.
      fetch: async (url) => {
        const relative = url.replace(/^\/locales\//u, "");
        const target = path.resolve(/*turbopackIgnore: true*/ dir, relative);
        if (!target.startsWith(`${dir}${path.sep}`)) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(await readFile(/*turbopackIgnore: true*/ target)));
      },
    });
    cached = { mtimeMs, registry, loader };
    return cached;
  } catch {
    return null;
  }
}

/** Last known instance default locale, with its expiry. */
let instanceDefaultCache: { value: string | null; expires: number } | null = null;

/** Instance default locale from the API public config; cached, never throws. */
export async function instanceDefaultLocale(now = Date.now()): Promise<string | null> {
  if (instanceDefaultCache && instanceDefaultCache.expires > now) return instanceDefaultCache.value;
  const base = process.env.API_INTERNAL_URL;
  let value = instanceDefaultCache?.value ?? null;
  if (base) {
    try {
      const response = await fetch(new URL("/api/v1/system/public-config", base), {
        cache: "no-store",
        signal: AbortSignal.timeout(INSTANCE_DEFAULT_TIMEOUT_MS),
      });
      if (response.ok) {
        const parsed = publicConfigSchema.safeParse(await response.json());
        if (parsed.success) value = parsed.data.defaultLocale;
      }
    } catch {
      // API unavailable: keep the last known value (or none) until the next attempt.
    }
  }
  instanceDefaultCache = { value, expires: now + INSTANCE_DEFAULT_TTL_MS };
  return value;
}

/** Resolves and loads the SSR locale for one request; null when no valid bundle is installed. */
export async function loadInitialLocale(request: {
  cookieHeader: string | null;
  acceptLanguage: string | null;
}): Promise<InitialLocale | null> {
  const disk = await diskLoader();
  if (disk === null) return null;
  const resolved = resolveLocale({
    installed: disk.loader.installed,
    cookie: readLocaleCookie(request.cookieHeader),
    acceptLanguage: request.acceptLanguage,
    instanceDefault: await instanceDefaultLocale(),
  });
  let catalog: LocaleCatalog;
  try {
    catalog = await disk.loader.load(resolved.locale, SHELL_NAMESPACES);
  } catch {
    // A broken locale package must not take the page down: fall back to English.
    try {
      catalog = await disk.loader.load("en", SHELL_NAMESPACES);
    } catch {
      return null;
    }
    return { registry: disk.registry, catalog: serializeCatalog(catalog), source: "fallback" };
  }
  return { registry: disk.registry, catalog: serializeCatalog(catalog), source: resolved.source };
}

/**
 * Server-side translator for text rendered outside the client provider, such as page titles in
 * `generateMetadata`. Uses the same locale resolution as the root layout and loads the shell
 * namespaces plus `namespaces` (English fallback when the chosen package is broken). Returns null
 * when no valid bundle is installed, so callers keep a static fallback.
 */
export async function serverTranslator(
  request: { cookieHeader: string | null; acceptLanguage: string | null },
  namespaces: readonly LocaleNamespace[],
): Promise<Translator | null> {
  const disk = await diskLoader();
  if (disk === null) return null;
  const wanted = [...new Set([...SHELL_NAMESPACES, ...namespaces])];
  const resolved = resolveLocale({
    installed: disk.loader.installed,
    cookie: readLocaleCookie(request.cookieHeader),
    acceptLanguage: request.acceptLanguage,
    instanceDefault: await instanceDefaultLocale(),
  });
  for (const tag of [resolved.locale, "en"]) {
    try {
      return createTranslator(await disk.loader.load(tag, wanted));
    } catch {
      // Try the English fallback next.
    }
  }
  return null;
}
