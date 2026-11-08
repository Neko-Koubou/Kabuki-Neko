/**
 * Test helper: renders UI inside a real `LocaleProvider` built from the repository's locale
 * sources (compiled like `pnpm locales:build`), so component tests assert the actual translated
 * text instead of keys. No registry is attached, so the provider never fetches; switching locales
 * is covered by the provider's own spec. Test-only code (reads files through Node at runtime).
 */
import { parse } from "@formatjs/icu-messageformat-parser";
import type { LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import type { SerializedCatalog } from "@/lib/i18n/catalog-loader";
import type { InitialLocale } from "@/lib/i18n/locale.server";
import { LocaleProvider, createLocalePreferences } from "@/providers/locale-provider";

/** Repository locale sources (Vitest runs in apps/web). */
const LOCALES_DIR = `${process.cwd()}/../../packages/shared/locales`;
/** Namespaces loaded by default for component tests. */
const DEFAULT_NAMESPACES: LocaleNamespace[] = ["common", "accessibility", "auth", "validation"];

/** Compiles one real namespace file of `tag` into the serialized AST form. */
function compiledNamespace(tag: string, name: LocaleNamespace): Record<string, never> {
  const fs = process.getBuiltinModule("node:fs");
  const messages = JSON.parse(
    fs.readFileSync(`${LOCALES_DIR}/${tag}/${name}.json`, "utf8"),
  ) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      parse(value, { requiresOtherClause: true, ignoreTag: false }),
    ]),
  ) as Record<string, never>;
}

/** Server-style snapshot for `tag` with the given namespaces (and the en fallback). */
export function testInitialLocale(
  tag = "en",
  namespaces: LocaleNamespace[] = DEFAULT_NAMESPACES,
  direction: "ltr" | "rtl" = "ltr",
): InitialLocale {
  const build = (locale: string) =>
    Object.fromEntries(namespaces.map((name) => [name, compiledNamespace(locale, name)]));
  const catalog: SerializedCatalog = {
    tag,
    direction,
    buildId: "test",
    namespaces: build(tag),
    fallback: build("en"),
  };
  return { registry: null, catalog, source: "cookie" };
}

/** Options of {@link renderWithLocale}. */
export interface LocaleRenderOptions extends Omit<RenderOptions, "wrapper"> {
  locale?: string;
  namespaces?: LocaleNamespace[];
}

/** Renders `ui` inside a LocaleProvider for `locale` (default en) with in-memory preferences. */
export function renderWithLocale(
  ui: ReactElement,
  options: LocaleRenderOptions = {},
): RenderResult {
  const { locale = "en", namespaces, ...renderOptions } = options;
  const initial = testInitialLocale(locale, namespaces);
  const preferences = createLocalePreferences({ storage: () => null, writeCookie: () => {} });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <LocaleProvider initial={initial} preferences={preferences} timeZone="UTC">
        {children}
      </LocaleProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
