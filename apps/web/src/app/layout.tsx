/**
 * Root layout (SA §8.2, US-21): resolves the request locale on the server — `kn_locale` cookie,
 * then `Accept-Language`, then the instance default, then English — and renders `<html lang dir>`
 * plus the initial shell catalog, so the client locale provider hydrates with identical text.
 * The layout is therefore dynamic (it varies by cookie and header). A missing or invalid locale
 * bundle never breaks the page: the provider then renders the safe fallback text. The theme
 * provider applies the saved system/light/dark preference to <html>, and the auth provider holds
 * the in-memory session for the public API URL. All three live here, above every route group, so
 * moving between public, dashboard and live routes never remounts them.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { loadInitialLocale } from "@/lib/i18n/locale.server";
import { AuthProvider } from "@/providers/auth-provider";
import { LocaleProvider } from "@/providers/locale-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import "./globals.css";

export const metadata: Metadata = { title: "Kabuki Neko" };

/** Public REST API base (`NEXT_PUBLIC_API_URL` + `/api/v1`), as the browser must reach it. */
function apiBaseUrl(): string {
  return new URL("/api/v1", process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString();
}

/** Server-rendered document shell with the request locale. */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const requestHeaders = await headers();
  const initial = await loadInitialLocale({
    cookieHeader: requestHeaders.get("cookie"),
    acceptLanguage: requestHeaders.get("accept-language"),
  });
  return (
    // Client providers update lang/dir/theme attributes on <html> after hydration.
    <html
      lang={initial?.catalog.tag ?? "en"}
      dir={initial?.catalog.direction ?? "ltr"}
      suppressHydrationWarning
    >
      <body>
        <LocaleProvider initial={initial}>
          <ThemeProvider>
            <AuthProvider apiBaseUrl={apiBaseUrl()}>{children}</AuthProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
