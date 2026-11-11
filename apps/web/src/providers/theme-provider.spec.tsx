/**
 * TASK-087 coverage: theme preference persistence with denied storage (memory fallback), system
 * dark-mode changes and forced host themes that never remount the subtree (state preserved),
 * cross-tab updates, and the design-token contract in globals.css — the four answer colors and
 * their text pairs are exact solid values matching the shared geometry, identical in both themes,
 * with green/white and yellow/ink meeting 4.5:1 exactly as computed in Design §2.2.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import {
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  createThemePreferenceStore,
  resolveTheme,
  type PreferenceStorage,
} from "@/lib/preferences";
import { ThemeProvider, useTheme } from "./theme-provider";

/**
 * Raw globals.css. Vitest replaces CSS imports (even `?raw`) with an empty string, so the spec —
 * which runs in Node and is never bundled for the browser — reads the file through Node's builtin.
 */
const css = process
  .getBuiltinModule("node:fs")
  .readFileSync(`${process.cwd()}/src/app/globals.css`, "utf8"); // Vitest runs in apps/web.

/** In-memory Web Storage stand-in. */
function memoryStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}
/** Storage whose every access throws (privacy mode / blocked site data). */
const deniedStorage: PreferenceStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};
/** Flips the mocked OS dark-mode media query (see src/test/setup.ts). */
function setSystemDark(matches: boolean) {
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  act(() => {
    query.dispatchEvent(Object.assign(new Event("change"), { matches }));
  });
}
/** Child with local state and a mount counter, to prove theme changes never remount it. */
let mounts = 0;
function Probe() {
  const { preference, theme, forced, setPreference } = useTheme();
  const [count, setCount] = useState(() => {
    mounts++;
    return 0;
  });
  return (
    <div>
      <output aria-label="theme">{`${preference}/${theme}/${forced ? "forced" : "free"}`}</output>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        {`count ${count}`}
      </button>
      <button type="button" onClick={() => setPreference("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setPreference("light")}>
        light
      </button>
    </div>
  );
}
/** CSS custom property value declared in a selector block of globals.css. */
function token(block: string, name: string): string | undefined {
  const start = css.indexOf(`${block} {`);
  if (start < 0) return undefined;
  const body = css.slice(start, css.indexOf("\n}", start));
  return new RegExp(`${name}:\\s*([^;]+);`, "u").exec(body)?.[1]?.trim().toLowerCase();
}
/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
/** WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("preference store", () => {
  it("persists to storage and falls back to memory when storage is denied", () => {
    const storage = memoryStorage();
    const store = createThemePreferenceStore({ storage: () => storage });
    expect(store.get()).toBe("system");
    store.set("dark");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(createThemePreferenceStore({ storage: () => storage }).get()).toBe("dark");
    storage.data.set(THEME_STORAGE_KEY, "neon");
    expect(createThemePreferenceStore({ storage: () => storage }).get()).toBe("system");

    const denied = createThemePreferenceStore({ storage: () => deniedStorage, fallback: "light" });
    expect(denied.get()).toBe("light");
    expect(() => denied.set("dark")).not.toThrow();
    expect(denied.get()).toBe("dark");
    const missing = createThemePreferenceStore({ storage: () => null });
    missing.set("light");
    expect(missing.get()).toBe("light");
    expect(() => missing.set("neon" as never)).toThrow("INVALID_FORMAT");
  });

  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("ThemeProvider", () => {
  it("keeps child state across preference, system and storage-denied changes", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const store = createThemePreferenceStore({ storage: () => deniedStorage });
    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );
    const root = document.documentElement;
    expect(screen.getByLabelText("theme")).toHaveTextContent("system/light/free");
    expect(root.dataset.theme).toBe("light");
    await user.click(screen.getByRole("button", { name: "count 0" }));
    await user.click(screen.getByRole("button", { name: "count 1" }));

    setSystemDark(true);
    expect(screen.getByLabelText("theme")).toHaveTextContent("system/dark/free");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");

    // Storage throws on every access: the choice still applies (memory fallback).
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(screen.getByLabelText("theme")).toHaveTextContent("light/light/free");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.themePreference).toBe("light");
    setSystemDark(false);
    setSystemDark(true);
    expect(screen.getByLabelText("theme")).toHaveTextContent("light/light/free");

    expect(screen.getByRole("button", { name: "count 2" })).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("forces the host theme without remounting or overwriting the saved preference", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const storage = memoryStorage();
    const store = createThemePreferenceStore({ storage: () => storage });
    store.set("light");
    const view = render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "count 0" }));
    view.rerender(
      <ThemeProvider store={store} forcedTheme="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("light/dark/forced");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
    view.rerender(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("theme")).toHaveTextContent("light/light/free");
    expect(screen.getByRole("button", { name: "count 1" })).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it("follows a preference changed in another tab", () => {
    const storage = memoryStorage();
    const store = createThemePreferenceStore({ storage: () => storage });
    render(
      <ThemeProvider store={store}>
        <Probe />
      </ThemeProvider>,
    );
    storage.data.set(THEME_STORAGE_KEY, "dark");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect(screen.getByLabelText("theme")).toHaveTextContent("dark/dark/free");
  });

  it("refuses to be used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow("useTheme must be used inside ThemeProvider");
  });
});

describe("design tokens", () => {
  it("declares exact solid answer colors and text pairs that never change with the theme", () => {
    const letters = ["a", "b", "c", "d"] as const;
    for (const geometry of ANSWER_GEOMETRY) {
      const letter = letters[geometry.index] ?? "a";
      expect(token(":root", `--answer-${letter}`)).toBe(geometry.background.toLowerCase());
      expect(token(":root", `--answer-${letter}-foreground`)).toBe(
        geometry.foreground.toLowerCase(),
      );
      expect(token(':root[data-theme="dark"]', `--answer-${letter}`)).toBeUndefined();
    }
    // Green/white and yellow/ink are the exact pairs of Design §2.2.
    expect([token(":root", "--answer-d"), token(":root", "--answer-d-foreground")]).toEqual([
      "#26890c",
      "#ffffff",
    ]);
    expect([token(":root", "--answer-c"), token(":root", "--answer-c-foreground")]).toEqual([
      "#d89e00",
      "#18181b",
    ]);
    expect(contrast("#26890C", "#FFFFFF")).toBeCloseTo(4.50066, 4);
    expect(contrast("#26890C", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#D89E00", "#18181B")).toBeCloseTo(7.43, 2);
    expect(contrast("#D89E00", "#FFFFFF")).toBeLessThan(4.5);
    // No translucency or blending is ever declared on the answer tokens.
    expect(css).not.toMatch(/--answer-[a-d][^:]*:\s*(rgb|hsl|color-mix|linear-gradient)/u);
    expect(css).not.toMatch(/answer[^{]*\{[^}]*opacity/u);
  });

  it("defines the light/dark semantic pairs and the reduced-motion and focus baselines", () => {
    expect(token(":root", "--primary")).toBe("#d9381e");
    expect(token(':root[data-theme="dark"]', "--primary")).toBe("#ff8a75");
    expect(token(":root", "--background")).toBe("#fafaf9");
    expect(token(':root[data-theme="dark"]', "--background")).toBe("#18181b");
    expect(token(":root", "--ring")).toBe("#1d4ed8");
    expect(token(':root[data-theme="dark"]', "--ring")).toBe("#93c5fd");
    expect(contrast("#D9381E", "#FFFFFF")).toBeCloseTo(4.63, 2);
    expect(contrast("#FF8A75", "#18181B")).toBeCloseTo(7.71, 2);
    // Primary as text (links, active navigation) meets AA on every surface it is used on.
    expect(token(":root", "--primary-text")).toBe("#c2311a");
    expect(token(':root[data-theme="dark"]', "--primary-text")).toBe("#ff8a75");
    for (const surface of ["#FAFAF9", "#FFFFFF", "#F4F4F5"])
      expect(contrast("#C2311A", surface)).toBeGreaterThanOrEqual(4.5);
    for (const surface of ["#18181B", "#27272A", "#3F3F46"])
      expect(contrast("#FF8A75", surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#D9381E", "#F4F4F5")).toBeLessThan(4.5);
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(css).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--ring\);\s*outline-offset: 2px;/u,
    );
  });
});
