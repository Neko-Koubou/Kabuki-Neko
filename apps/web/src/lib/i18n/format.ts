/**
 * ICU message, number and date formatting over loaded catalogs (SA §8.1–8.2, US-21; TASK-116).
 *
 * - `t("namespace.key", values)` formats the compiled AST of the active locale with
 *   `intl-messageformat` (plural/select/number/date via `Intl`). Output is always a plain string:
 *   tags are ignored and catalogs never contain markup, so nothing is evaluated as HTML; React
 *   escapes the text when rendering.
 * - A key missing from the active locale uses the `en` message (formatted with English rules) and
 *   reports `MISSING_TRANSLATION`. A key missing everywhere, an unloaded namespace or a formatting
 *   error never shows the raw key: the localized `common.status.unavailable` text (or "…") is
 *   returned and `UNKNOWN_KEY`/`FORMAT_ERROR` is reported to the optional diagnostic sink.
 * - Dates (epoch milliseconds or Date) use the browser-resolved time zone unless one is given, for
 *   every ICU date/time style and for {@link Translator.formatDate}; the zone is exposed with a
 *   localized label so the UI can show it. Intl formatters are cached per locale and options.
 */
import { IntlMessageFormat, type Formatters } from "intl-messageformat";
import { LOCALE_NAMESPACES, type LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import type { LocaleCatalog, MessageAst } from "./catalog-loader";
import { FALLBACK_LOCALE } from "./resolve";

/** Value accepted by a placeholder (`date` placeholders take epoch milliseconds or a Date). */
export type MessageValue = string | number | Date;
/** Placeholder values of one message. */
export type MessageValues = Readonly<Record<string, MessageValue>>;

/** Runtime i18n diagnostics (programmer errors that escaped the build-time checks). */
export type I18nDiagnosticCode = "UNKNOWN_KEY" | "MISSING_TRANSLATION" | "FORMAT_ERROR";
/** One diagnostic event. */
export interface I18nDiagnostic {
  code: I18nDiagnosticCode;
  key: string;
  locale: string;
}

/** Localized minimal text shown instead of an unknown or broken message. */
export const UNAVAILABLE_MESSAGE_KEY = "common.status.unavailable";
/** Last-resort text when even the unavailable message is missing. */
export const LAST_RESORT_TEXT = "…";

/** Formatter options. */
export interface TranslatorOptions {
  /** IANA time zone for dates (default: the runtime's resolved zone, else UTC). */
  timeZone?: string;
  /** Receives diagnostics; never throws into rendering. */
  onDiagnostic?: (diagnostic: I18nDiagnostic) => void;
}

/** Bound formatting helpers for one loaded catalog. */
export interface Translator {
  readonly locale: string;
  readonly direction: "ltr" | "rtl";
  readonly timeZone: string;
  /** Formats `namespace.key`; never throws and never returns the raw key. */
  t(key: string, values?: MessageValues): string;
  /** True when the key exists in the active locale or the `en` fallback. */
  has(key: string): boolean;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string;
  /** Localized short name of the time zone at `at` (default now), e.g. "GMT+7". */
  timeZoneLabel(at?: number): string;
}

/** The runtime's IANA zone when valid, otherwise UTC. */
export function resolveTimeZone(requested?: string): string {
  for (const candidate of [requested, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    if (!candidate) continue;
    try {
      return new Intl.DateTimeFormat("en", { timeZone: candidate }).resolvedOptions().timeZone;
    } catch {
      // Unknown zone: try the next candidate.
    }
  }
  return "UTC";
}

/** Stable cache key for a locale plus an options object. */
function cacheKey(locales: unknown, options: unknown): string {
  return JSON.stringify([locales, options ?? null]);
}

/** Intl formatter factory with caches; every date/time format is pinned to `timeZone`. */
function createFormatters(timeZone: string): Formatters {
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const plurals = new Map<string, Intl.PluralRules>();
  return {
    getNumberFormat(locales, options) {
      const key = cacheKey(locales, options);
      let formatter = numbers.get(key);
      if (formatter === undefined) {
        formatter = new Intl.NumberFormat(locales, options as Intl.NumberFormatOptions | undefined);
        numbers.set(key, formatter);
      }
      return formatter;
    },
    getDateTimeFormat(locales, options) {
      const pinned = { ...options, timeZone };
      const key = cacheKey(locales, pinned);
      let formatter = dates.get(key);
      if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat(locales, pinned);
        dates.set(key, formatter);
      }
      return formatter;
    },
    getPluralRules(locales, options) {
      const key = cacheKey(locales, options);
      let rules = plurals.get(key);
      if (rules === undefined) {
        rules = new Intl.PluralRules(locales, options);
        plurals.set(key, rules);
      }
      return rules;
    },
  };
}

/** Splits `namespace.key` into its namespace and in-namespace key, or null when malformed. */
function splitKey(key: string): [LocaleNamespace, string] | null {
  const dot = key.indexOf(".");
  if (dot < 0) return null;
  const namespace = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  if (!(LOCALE_NAMESPACES as readonly string[]).includes(namespace) || rest.length === 0)
    return null;
  return [namespace as LocaleNamespace, rest];
}

/** Creates the translator for a loaded catalog. */
export function createTranslator(
  catalog: LocaleCatalog,
  options: TranslatorOptions = {},
): Translator {
  const timeZone = resolveTimeZone(options.timeZone);
  const formatters = createFormatters(timeZone);
  const compiled = new Map<string, IntlMessageFormat>();
  const report = (code: I18nDiagnosticCode, key: string) => {
    try {
      options.onDiagnostic?.({ code, key, locale: catalog.tag });
    } catch {
      // A failing diagnostic sink must never break rendering.
    }
  };

  /** AST of `key` in the active locale, then in `en`; with the locale whose rules apply. */
  function lookup(key: string): { ast: MessageAst; locale: string; fallback: boolean } | null {
    const parts = splitKey(key);
    if (parts === null) return null;
    const [namespace, rest] = parts;
    const own = catalog.namespaces.get(namespace)?.get(rest);
    if (own !== undefined) return { ast: own, locale: catalog.tag, fallback: false };
    const english = catalog.fallback.get(namespace)?.get(rest);
    if (english !== undefined) return { ast: english, locale: FALLBACK_LOCALE, fallback: true };
    return null;
  }

  /** Formats one AST; throws on invalid or missing values. */
  function render(key: string, ast: MessageAst, locale: string, values?: MessageValues): string {
    const cacheId = `${locale}\u0000${key}`;
    let message = compiled.get(cacheId);
    if (message === undefined) {
      message = new IntlMessageFormat(ast, locale, undefined, { formatters, ignoreTag: true });
      compiled.set(cacheId, message);
    }
    const result: unknown = message.format(values as Record<string, MessageValue> | undefined);
    if (typeof result === "string") return result;
    if (Array.isArray(result)) return result.map(String).join("");
    return String(result);
  }

  /** Localized unavailable text without recursion or diagnostics. */
  function unavailable(): string {
    const found = lookup(UNAVAILABLE_MESSAGE_KEY);
    if (found === null) return LAST_RESORT_TEXT;
    try {
      return render(UNAVAILABLE_MESSAGE_KEY, found.ast, found.locale);
    } catch {
      return LAST_RESORT_TEXT;
    }
  }

  return {
    locale: catalog.tag,
    direction: catalog.direction,
    timeZone,
    t(key, values) {
      const found = lookup(key);
      if (found === null) {
        report("UNKNOWN_KEY", key);
        return unavailable();
      }
      if (found.fallback && catalog.tag !== FALLBACK_LOCALE) report("MISSING_TRANSLATION", key);
      try {
        return render(key, found.ast, found.locale, values);
      } catch {
        report("FORMAT_ERROR", key);
        return unavailable();
      }
    },
    has: (key) => lookup(key) !== null,
    formatNumber(value, numberOptions) {
      // Standard Intl options are a subset of the formatter's option type.
      const options = numberOptions as Parameters<Formatters["getNumberFormat"]>[1];
      return formatters.getNumberFormat(catalog.tag, options).format(value);
    },
    formatDate(value, dateOptions) {
      return formatters.getDateTimeFormat(catalog.tag, dateOptions).format(value);
    },
    timeZoneLabel(at = Date.now()) {
      const parts = formatters
        .getDateTimeFormat(catalog.tag, { timeZoneName: "short" })
        .formatToParts(at);
      return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
    },
  };
}
