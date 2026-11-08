/**
 * Locale preference resolution and BCP 47 matching (SA §8.2, US-21; TASK-116).
 *
 * Precedence: explicit cookie `kn_locale` → explicit browser storage `kabuki:locale` (client only;
 * the server never sees it) → `Accept-Language` in quality order → the instance default → `en`.
 * Each candidate is matched against the installed registry tags, so a removed or malformed
 * preference simply falls through to the next source.
 *
 * Matching (after an exact installed tag): same language and script — preferring the same region,
 * then a region-less tag, then another region — and never across an explicit or implied script.
 * Chinese uses the exact SA table: TW/HK/MO and `zh-Hant-*` are Traditional, everything else
 * (CN, SG, `zh-Hans-*`, bare `zh`) is Simplified, and a missing `zh-Hant` package never falls back
 * to Simplified. Other languages take their implied script from CLDR likely subtags
 * (`Intl.Locale#maximize`). Everything here is pure and runs on the server and in the browser.
 */

/** Cookie holding the explicit locale preference (JS-readable; not a credential). */
export const LOCALE_COOKIE = "kn_locale";
/** localStorage key holding the explicit preference when the cookie is unavailable. */
export const LOCALE_STORAGE_KEY = "kabuki:locale";
/** Cookie lifetime: one year (SA §8.2). */
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;
/** The always-installed, always-complete fallback locale. */
export const FALLBACK_LOCALE = "en";

/** Longest tag accepted (SA §8.1: 1–63 characters). */
const MAX_TAG_LENGTH = 63;
/** Accept-Language headers longer than this are truncated before parsing (DoS guard). */
const MAX_ACCEPT_LANGUAGE_LENGTH = 4_096;
/** At most this many Accept-Language entries are considered. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;
/** Chinese regions written in Traditional script (SA §8.2 table). */
const TRADITIONAL_CHINESE_REGIONS = new Set(["TW", "HK", "MO"]);

/** Where the resolved locale came from. */
export type LocaleSource = "cookie" | "storage" | "accept-language" | "default" | "fallback";

/** Result of resolving the active locale. */
export interface ResolvedLocale {
  locale: string;
  source: LocaleSource;
}

/** Inputs for {@link resolveLocale}; omit `stored` on the server. */
export interface LocaleInputs {
  installed: readonly string[];
  cookie?: string | null | undefined;
  stored?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
  instanceDefault?: string | null | undefined;
}

/** Canonical BCP 47 form of `tag`, or null when it is malformed, too long or contains separators. */
export function canonicalTag(tag: string | null | undefined): string | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH || !/^[A-Za-z0-9-]+$/u.test(trimmed))
    return null;
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Language tags from an `Accept-Language` header, highest quality first (ties keep header order).
 * Entries with q=0, `*`, malformed tags or invalid weights are dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== "string") return [];
  const entries: { tag: string; q: number; index: number }[] = [];
  const parts = header.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH).split(",");
  for (const [index, part] of parts.slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES).entries()) {
    const [rawTag = "", ...params] = part.split(";");
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/u.exec(param);
      if (!match) continue;
      const value = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/u.test(match[1] ?? "") ? Number(match[1]) : NaN;
      q = Number.isNaN(value) ? 0 : value;
    }
    const tag = canonicalTag(rawTag);
    if (tag !== null && q > 0) entries.push({ tag, q, index });
  }
  return entries.sort((a, b) => b.q - a.q || a.index - b.index).map((entry) => entry.tag);
}

/** Language, script (explicit or implied) and region of a canonical tag. */
interface TagParts {
  language: string;
  script: string | undefined;
  explicitScript: boolean;
  region: string | undefined;
}

/** Splits a canonical tag; Chinese scripts follow the SA table, others CLDR likely subtags. */
function tagParts(tag: string): TagParts | null {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag);
  } catch {
    return null;
  }
  const language = locale.language;
  const region = locale.region;
  if (locale.script) return { language, script: locale.script, explicitScript: true, region };
  let script: string | undefined;
  if (language === "zh")
    script = region !== undefined && TRADITIONAL_CHINESE_REGIONS.has(region) ? "Hant" : "Hans";
  else {
    try {
      script = new Intl.Locale(language).maximize().script;
    } catch {
      script = undefined;
    }
  }
  return { language, script, explicitScript: false, region };
}

/**
 * Best installed tag for one requested tag, or null when no installed package is compatible.
 * Ranking: exact → same language+script+region → language-script tag without region (`zh-Hans`)
 * → bare base language (`en`) → same language+script with another region (alphabetical, for
 * determinism). The script, explicit or implied, must always agree.
 */
export function matchLocale(requested: string, installed: readonly string[]): string | null {
  const tag = canonicalTag(requested);
  if (tag === null) return null;
  const candidates = installed
    .map((item) => canonicalTag(item))
    .filter((item): item is string => item !== null);
  const exact = candidates.find((item) => item.toLowerCase() === tag.toLowerCase());
  if (exact !== undefined) return exact;
  const want = tagParts(tag);
  if (want === null) return null;
  const ranked = candidates
    .map((item) => ({ item, parts: tagParts(item) }))
    .filter(
      (entry): entry is { item: string; parts: TagParts } =>
        entry.parts !== null &&
        entry.parts.language === want.language &&
        entry.parts.script !== undefined &&
        entry.parts.script === want.script,
    )
    .map(({ item, parts }) => ({
      item,
      // 0 same region, 1 language-script tag, 2 bare base language, 3 another region.
      rank:
        want.region !== undefined && parts.region === want.region
          ? 0
          : parts.region === undefined
            ? parts.explicitScript
              ? 1
              : 2
            : 3,
    }))
    .sort((a, b) => a.rank - b.rank || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return ranked[0]?.item ?? null;
}

/**
 * Resolves the active locale from every preference source in SA §8.2 order. The result is always
 * an installed tag when `installed` is non-empty (`en` is always installed in a valid registry).
 */
export function resolveLocale(inputs: LocaleInputs): ResolvedLocale {
  const sources: [LocaleSource, string | null | undefined][] = [
    ["cookie", inputs.cookie],
    ["storage", inputs.stored],
  ];
  for (const [source, value] of sources) {
    const match = value ? matchLocale(value, inputs.installed) : null;
    if (match !== null) return { locale: match, source };
  }
  for (const requested of parseAcceptLanguage(inputs.acceptLanguage)) {
    const match = matchLocale(requested, inputs.installed);
    if (match !== null) return { locale: match, source: "accept-language" };
  }
  const instance = inputs.instanceDefault
    ? matchLocale(inputs.instanceDefault, inputs.installed)
    : null;
  if (instance !== null) return { locale: instance, source: "default" };
  const fallback = matchLocale(FALLBACK_LOCALE, inputs.installed);
  return { locale: fallback ?? FALLBACK_LOCALE, source: "fallback" };
}

/** Value of the `kn_locale` cookie in a `Cookie` header (or `document.cookie`), if present. */
export function readLocaleCookie(cookieHeader: string | null | undefined): string | null {
  if (typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== LOCALE_COOKIE) continue;
    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return canonicalTag(value);
  }
  return null;
}

/**
 * `Set-Cookie`/`document.cookie` string persisting an explicit choice: Path=/, SameSite=Lax,
 * one-year Max-Age and Secure on HTTPS (SA §8.2). Throws for a malformed tag.
 */
export function serializeLocaleCookie(tag: string, options: { secure: boolean }): string {
  const canonical = canonicalTag(tag);
  if (canonical === null) throw new Error("INVALID_LOCALE");
  return `${LOCALE_COOKIE}=${canonical}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${options.secure ? "; Secure" : ""}`;
}
