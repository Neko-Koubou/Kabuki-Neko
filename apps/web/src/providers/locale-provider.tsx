"use client";
/**
 * Locale provider (SA §8.2, Design §8.1, US-21; TASK-117): SSR-consistent hydration and atomic
 * locale switches that never remount the app.
 *
 * - The first render uses exactly the catalog the server rendered (`initial`), so `lang`/`dir` and
 *   every message match during hydration. Dates render in UTC on the server and in the browser's
 *   time zone after hydration (`useSyncExternalStore` server/client snapshots).
 * - When the server had no explicit cookie, a preference saved only in browser storage
 *   (`kabuki:locale`) is applied after hydration: the new catalog loads first, then locale,
 *   direction and messages switch in one state update, and the cookie is written so the next SSR
 *   renders it directly.
 * - `setLocale` keeps the previous locale fully usable while loading (`pending`), ignores stale
 *   results when a newer choice was made, and on failure keeps the old locale and exposes `error`
 *   for a retry. Choices persist to the `kn_locale` cookie and to localStorage with an in-memory
 *   fallback when storage is denied. Children are never keyed on the locale, so focus, drafts,
 *   sockets and other component state survive a switch.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import {
  CatalogLoadError,
  SHELL_NAMESPACES,
  createCatalogLoader,
  deserializeCatalog,
  type CatalogErrorCode,
  type CatalogLoader,
  type LocaleCatalog,
} from "@/lib/i18n/catalog-loader";
import {
  createTranslator,
  resolveTimeZone,
  type I18nDiagnostic,
  type MessageValues,
  type Translator,
} from "@/lib/i18n/format";
import {
  FALLBACK_LOCALE,
  LOCALE_STORAGE_KEY,
  canonicalTag,
  matchLocale,
  serializeLocaleCookie,
} from "@/lib/i18n/resolve";
import type { InitialLocale } from "@/lib/i18n/locale.server";
import type { PreferenceStorage } from "@/lib/preferences";

/** One installed locale as offered by the picker (from the registry, never a fixed list). */
export interface LocaleOption {
  tag: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  /** 0–1 share of keys translated; below 1 the rest is shown in English. */
  coverage: number;
}

/** A failed switch: the locale that could not be loaded and why. */
export interface LocaleSwitchError {
  tag: string;
  code: CatalogErrorCode;
}

/** Value exposed by {@link useLocale}. */
export interface LocaleContextValue {
  locale: string;
  direction: "ltr" | "rtl";
  timeZone: string;
  t: (key: string, values?: MessageValues) => string;
  /** Same key formatted from the English fallback (used for bilingual recovery labels). */
  tEnglish: (key: string, values?: MessageValues) => string;
  has: (key: string) => boolean;
  formatNumber: Translator["formatNumber"];
  formatDate: Translator["formatDate"];
  timeZoneLabel: Translator["timeZoneLabel"];
  options: readonly LocaleOption[];
  /** Locale currently loading, while the previous one stays active. */
  pending: string | null;
  error: LocaleSwitchError | null;
  /** Loads then atomically switches; resolves false when it failed or was superseded. */
  setLocale: (tag: string) => Promise<boolean>;
  /** Loads extra namespaces for the active locale (route-level messages). */
  ensureNamespaces: (namespaces: readonly LocaleNamespace[]) => Promise<boolean>;
  clearError: () => void;
}

/** Explicit preference persistence (cookie + storage with memory fallback). */
export interface LocalePreferences {
  /** Preference saved in browser storage (or memory), if any. */
  readStored(): string | null;
  /** Persists an explicit choice to the cookie and storage; never throws. */
  save(tag: string): void;
}

/** Default storage accessor: localStorage, or null when unavailable. */
function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Default cookie writer: `kn_locale` with Secure on HTTPS. */
function writeBrowserCookie(tag: string): void {
  document.cookie = serializeLocaleCookie(tag, { secure: window.location.protocol === "https:" });
}

/** Creates the preference persistence used by the provider (injectable for tests). */
export function createLocalePreferences(
  options: {
    storage?: () => PreferenceStorage | null;
    writeCookie?: (tag: string) => void;
  } = {},
): LocalePreferences {
  const storage = options.storage ?? browserStorage;
  const writeCookie = options.writeCookie ?? writeBrowserCookie;
  let memory: string | null = null;
  return {
    readStored() {
      try {
        const value = storage()?.getItem(LOCALE_STORAGE_KEY);
        if (value != null) return canonicalTag(value);
      } catch {
        // Storage denied: fall back to the in-memory value.
      }
      return memory;
    },
    save(tag) {
      memory = tag;
      try {
        storage()?.setItem(LOCALE_STORAGE_KEY, tag);
      } catch {
        // Storage denied or full: the memory value and the cookie still apply.
      }
      try {
        writeCookie(tag);
      } catch {
        // Cookies blocked: the choice still applies for this page session.
      }
    },
  };
}

/** Catalog used when no valid bundle is installed: every message shows the safe fallback text. */
const EMPTY_CATALOG: LocaleCatalog = {
  tag: FALLBACK_LOCALE,
  direction: "ltr",
  buildId: "",
  namespaces: new Map(),
  fallback: new Map(),
};

/** Never-changing subscription for snapshot-only external values. */
function subscribeNever(): () => void {
  return () => {};
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Props of {@link LocaleProvider}. */
export interface LocaleProviderProps {
  children: ReactNode;
  /** Snapshot rendered by the server (null when no locale bundle is installed). */
  initial: InitialLocale | null;
  /** Catalog loader; defaults to one over `initial.registry` fetching same-origin URLs. */
  loader?: CatalogLoader;
  /** Preference persistence; defaults to the browser cookie + localStorage. */
  preferences?: LocalePreferences;
  /** Fixed IANA time zone (default: UTC on the server, the browser zone after hydration). */
  timeZone?: string;
  onDiagnostic?: (diagnostic: I18nDiagnostic) => void;
}

/** Provides the active locale, its messages and the switch API to the whole app. */
export function LocaleProvider({
  children,
  initial,
  loader: injectedLoader,
  preferences: injectedPreferences,
  timeZone: fixedZone,
  onDiagnostic,
}: LocaleProviderProps) {
  const [loader] = useState<CatalogLoader | null>(() => {
    if (injectedLoader) return injectedLoader;
    if (!initial) return null;
    try {
      return createCatalogLoader({ registry: initial.registry });
    } catch {
      return null;
    }
  });
  const [preferences] = useState(() => injectedPreferences ?? createLocalePreferences());
  const [catalog, setCatalog] = useState<LocaleCatalog>(() => {
    if (!initial) return EMPTY_CATALOG;
    try {
      return deserializeCatalog(initial.catalog);
    } catch {
      return EMPTY_CATALOG;
    }
  });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<LocaleSwitchError | null>(null);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const sequence = useRef(0);
  const diagnosticRef = useRef(onDiagnostic);
  diagnosticRef.current = onDiagnostic;

  const timeZone = useSyncExternalStore(
    subscribeNever,
    () => fixedZone ?? resolveTimeZone(),
    () => fixedZone ?? "UTC",
  );

  const translator = useMemo(
    () =>
      createTranslator(catalog, {
        timeZone,
        onDiagnostic: (diagnostic) => diagnosticRef.current?.(diagnostic),
      }),
    [catalog, timeZone],
  );
  const english = useMemo(
    () =>
      createTranslator(
        { ...catalog, tag: FALLBACK_LOCALE, direction: "ltr", namespaces: catalog.fallback },
        { timeZone },
      ),
    [catalog, timeZone],
  );

  const setLocale = useCallback(
    async (requested: string) => {
      const target =
        loader?.entry(requested) !== undefined
          ? requested
          : loader
            ? matchLocale(requested, loader.installed)
            : null;
      if (loader === null || target === null) {
        setError({ tag: requested, code: "LOCALE_NOT_INSTALLED" });
        return false;
      }
      const id = ++sequence.current;
      const current = catalogRef.current;
      if (target === current.tag) {
        setPending(null);
        setError(null);
        preferences.save(target);
        return true;
      }
      setPending(target);
      setError(null);
      const namespaces = [...new Set([...SHELL_NAMESPACES, ...current.namespaces.keys()])];
      try {
        const next = await loader.load(target, namespaces);
        if (id !== sequence.current) return false;
        setCatalog(next);
        setPending(null);
        preferences.save(target);
        return true;
      } catch (failure) {
        if (id !== sequence.current) return false;
        setPending(null);
        setError({
          tag: target,
          code: failure instanceof CatalogLoadError ? failure.code : "NAMESPACE_FETCH_FAILED",
        });
        return false;
      }
    },
    [loader, preferences],
  );

  const ensureNamespaces = useCallback(
    async (wanted: readonly LocaleNamespace[]) => {
      const current = catalogRef.current;
      const missing = wanted.filter((name) => !current.namespaces.has(name));
      if (missing.length === 0) return true;
      if (loader === null) return false;
      try {
        const next = await loader.load(current.tag, [...current.namespaces.keys(), ...missing]);
        // Apply only if the locale did not change meanwhile.
        if (catalogRef.current.tag !== next.tag) return false;
        setCatalog((previous) => ({
          ...previous,
          namespaces: new Map([...previous.namespaces, ...next.namespaces]),
          fallback: new Map([...previous.fallback, ...next.fallback]),
        }));
        return true;
      } catch {
        return false;
      }
    },
    [loader],
  );

  // A storage-only preference (no explicit cookie on the server) applies after hydration.
  useEffect(() => {
    if (!initial || initial.source === "cookie" || loader === null) return;
    const stored = preferences.readStored();
    const target = stored ? matchLocale(stored, loader.installed) : null;
    if (target !== null) void setLocale(target);
    // Runs once after the first (hydrated) render; later choices go through setLocale directly.
  }, []); // intentionally empty: a one-time post-hydration check

  // Keep <html lang/dir> in sync after client-side switches (the server renders the first values).
  // A layout effect applies them in the same commit as the new messages, never a frame later.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = catalog.tag;
    root.dir = catalog.direction;
  }, [catalog.tag, catalog.direction]);

  const options = useMemo<LocaleOption[]>(
    () =>
      loader?.registry.locales.map((entry) => ({
        tag: entry.tag,
        nativeName: entry.nativeName,
        direction: entry.direction,
        coverage: entry.coverage,
      })) ?? [],
    [loader],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale: catalog.tag,
      direction: catalog.direction,
      timeZone: translator.timeZone,
      t: translator.t,
      tEnglish: english.t,
      has: translator.has,
      formatNumber: translator.formatNumber,
      formatDate: translator.formatDate,
      timeZoneLabel: translator.timeZoneLabel,
      options,
      pending,
      error,
      setLocale,
      ensureNamespaces,
      clearError: () => setError(null),
    }),
    [catalog, translator, english, options, pending, error, setLocale, ensureNamespaces],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Active locale context; throws outside {@link LocaleProvider}. */
export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}

/** Shortcut for the message formatter of the active locale. */
export function useT(): LocaleContextValue["t"] {
  return useLocale().t;
}
