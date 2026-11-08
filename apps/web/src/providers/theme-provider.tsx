"use client";
/**
 * Theme provider (Design §2.1, US-18): applies the resolved theme to <html> without remounting.
 *
 * - The user's preference (`system | light | dark`) comes from the browser preference store and
 *   the OS setting from `matchMedia("(prefers-color-scheme: dark)")`, both read through
 *   `useSyncExternalStore`, so a system change or another tab updates the theme in place.
 * - `forcedTheme` lets surfaces such as the host stage (default dark) or player game phases render
 *   dark without overwriting the saved preference; switching it never changes the React tree, so
 *   game state, selections and phases are preserved.
 * - The provider only writes `data-theme`, `data-theme-preference` and `color-scheme` on the
 *   document element; the CSS tokens in `globals.css` do the rest. During SSR the server snapshot
 *   is the default preference and the CSS `prefers-color-scheme` fallback covers the first paint.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  SYSTEM_DARK_QUERY,
  createThemePreferenceStore,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
  type ThemePreferenceStore,
} from "@/lib/preferences";

/** Value exposed by `useTheme`. */
export interface ThemeContextValue {
  /** The user's saved (or in-memory) preference. */
  preference: ThemePreference;
  /** Theme applied to the document (forced theme first, then the resolved preference). */
  theme: ResolvedTheme;
  /** True when a surface forces the theme regardless of the preference. */
  forced: boolean;
  /** Saves a new preference (memory fallback when storage is denied). */
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Shared default store for the app (one per browser page). */
let defaultStore: ThemePreferenceStore | null = null;
/** Lazily created default preference store. */
function appStore(): ThemePreferenceStore {
  defaultStore ??= createThemePreferenceStore();
  return defaultStore;
}

/** Subscribes to OS dark-mode changes; a no-op where `matchMedia` is unavailable. */
function subscribeSystem(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
/** Current OS dark-mode flag (false where `matchMedia` is unavailable). */
function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SYSTEM_DARK_QUERY).matches
  );
}

/** Props of `ThemeProvider`. */
export interface ThemeProviderProps {
  children: ReactNode;
  /** Theme forced by the surface (e.g. host stage dark); the saved preference is untouched. */
  forcedTheme?: ResolvedTheme;
  /** Preference store; defaults to the browser localStorage store with memory fallback. */
  store?: ThemePreferenceStore;
  /** Preference rendered on the server before the browser value is known. */
  serverPreference?: ThemePreference;
}

/** Provides the theme context and keeps <html> in sync with the resolved theme. */
export function ThemeProvider({
  children,
  forcedTheme,
  store,
  serverPreference = "system",
}: ThemeProviderProps) {
  const preferences = store ?? appStore();
  const preference = useSyncExternalStore(
    preferences.subscribe,
    preferences.get,
    () => serverPreference,
  );
  const dark = useSyncExternalStore(subscribeSystem, systemDark, () => false);
  const theme = forcedTheme ?? resolveTheme(preference, dark);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = theme;
  }, [theme, preference]);

  const setPreference = useCallback(
    (next: ThemePreference) => preferences.set(next),
    [preferences],
  );
  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme, forced: forcedTheme !== undefined, setPreference }),
    [preference, theme, forcedTheme, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Theme context of the nearest `ThemeProvider`; throws when used outside one. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
