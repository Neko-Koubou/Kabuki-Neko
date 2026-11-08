/**
 * Browser-local UI preferences (Design §2.1, US-18): the theme choice `system | light | dark`.
 *
 * Preferences are stored per browser in `localStorage` under a versioned key. Storage can be
 * unavailable (privacy mode, blocked cookies, quota, SSR): every access is guarded and the value
 * then lives in memory for the rest of the page session, so a choice is never lost or throws.
 * The store is a tiny external store (`get` / `set` / `subscribe`) usable with React's
 * `useSyncExternalStore`; it also follows changes made in other tabs through `storage` events.
 */

/** Theme preference chosen by the user. */
export type ThemePreference = "system" | "light" | "dark";
/** Theme actually applied to the document. */
export type ResolvedTheme = "light" | "dark";

/** Allowed preference values, in display order. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];
/** Versioned storage key of the theme preference. */
export const THEME_STORAGE_KEY = "kabuki-neko.theme.v1";
/** Media query that reports the operating system's dark mode. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** True when `value` is one of the allowed theme preferences. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Resolves a preference against the system setting (`system` follows the OS). */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Minimal storage surface used by the store (subset of the Web Storage API). */
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** External store holding one theme preference. */
export interface ThemePreferenceStore {
  /** Current preference (stored value, in-memory fallback, or the default). */
  get(): ThemePreference;
  /** Saves a preference; falls back to memory if storage is denied. Notifies listeners. */
  set(preference: ThemePreference): void;
  /** Subscribes to changes (own `set` calls and other tabs); returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Default accessor: the page's localStorage, or null when absent or access throws. */
function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Creates a theme preference store. `storage` is resolved lazily on every access (it may start
 * failing later, e.g. quota); `fallback` is used when nothing valid is stored.
 */
export function createThemePreferenceStore(
  options: {
    storage?: () => PreferenceStorage | null;
    fallback?: ThemePreference;
  } = {},
): ThemePreferenceStore {
  const storage = options.storage ?? browserStorage;
  const fallback = options.fallback ?? "system";
  const listeners = new Set<() => void>();
  let memory: ThemePreference | null = null;

  /** Reads the stored value; null when missing, invalid or storage is denied. */
  const read = (): ThemePreference | null => {
    try {
      const value = storage()?.getItem(THEME_STORAGE_KEY) ?? null;
      return isThemePreference(value) ? value : null;
    } catch {
      return null;
    }
  };
  /** Notifies every subscriber. */
  const emit = () => {
    for (const listener of listeners) listener();
  };
  /** Cross-tab updates: another tab changed (or cleared) the stored preference. */
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) emit();
  };

  return {
    get() {
      return memory ?? read() ?? fallback;
    },
    set(preference) {
      if (!isThemePreference(preference)) throw new Error("INVALID_FORMAT");
      memory = preference;
      try {
        storage()?.setItem(THEME_STORAGE_KEY, preference);
        // Persisted: let later reads (and other tabs) be the source of truth again.
        if (read() === preference) memory = null;
      } catch {
        // Storage denied or full: keep the in-memory value for this page session.
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && typeof window !== "undefined")
        window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
  };
}
