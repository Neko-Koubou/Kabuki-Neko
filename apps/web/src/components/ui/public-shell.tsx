"use client";
/**
 * Public shell and shared shell parts (Design §1.1, §4, §7; SA §1.2; US-01/03/15/18/21; TASK-132).
 *
 * - `PublicShell`: skip link, header (logo → `/`, instance name, Join → `/join`, Sign in →
 *   `/login`, language picker, theme menu), one `main` landmark and the legal footer.
 * - `SiteFooter`: consistent attribution plus About, the code license, third-party notices, the
 *   language guide and the music credits dialog (packaged CREDITS.md, rendered safely by
 *   `CreditsModal`). Code and audio licenses are linked separately.
 * - `BrandMark`: the self-hosted square brand mark with the instance name; long names wrap, and a missing logo
 *   (failed before or after hydration) becomes a text monogram.
 * - `ThemeMenu`: system/light/dark preference through the existing `ThemeProvider` (no remount).
 * - `usePublicConfig`: loads `/system/public-config` once per shell mount; pages inside the shell
 *   read the same result through `usePublicShell` (no second request).
 * Shell states: loading (default name "Kabuki Neko" while the config loads), empty (no instance
 * name → "Kabuki Neko"), ideal (instance name), partial (logo missing → monogram; long names wrap)
 * and error (service-unavailable banner with Try again; static content and links stay usable).
 * The shells reuse the root locale/auth/theme providers, so navigating never remounts them.
 */
import { Check, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { publicConfigSchema } from "@kabuki-neko/shared/schemas/system.schema";
import type { z } from "zod";
import { CreditsButton } from "@/components/common/CreditsModal";
import { LocalePicker } from "@/components/ui/locale-picker";
import { MenuPopover } from "@/components/ui/menu-popover";
import { StatusNotice } from "@/components/ui/status-notice";
import type { ThemePreference } from "@/lib/preferences";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";
import { useTheme } from "@/providers/theme-provider";

/** Public instance configuration. */
export type PublicConfig = z.infer<typeof publicConfigSchema>;
/** Loader of the public configuration (injectable in tests). */
export type PublicConfigLoader = (signal: AbortSignal) => Promise<PublicConfig>;
/** Product name shown when the instance name is unknown. */
export const PRODUCT_NAME = "Kabuki Neko";

/** Load state of the public configuration. */
export type PublicConfigState =
  { status: "loading" } | { status: "ready"; config: PublicConfig } | { status: "error" };

/** Loads the public configuration with retry; aborted on unmount. */
export function usePublicConfig(loadConfig?: PublicConfigLoader) {
  const { api } = useAuth();
  const [state, setState] = useState<PublicConfigState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(loadConfig);
  loader.current = loadConfig;

  useEffect(() => {
    const controller = new AbortController();
    const load: PublicConfigLoader =
      loader.current ??
      (async (signal) =>
        (await api.request({ path: "/system/public-config", schema: publicConfigSchema, signal }))
          .data);
    load(controller.signal).then(
      (config) => {
        if (!controller.signal.aborted) setState({ status: "ready", config });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [api, attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
}

/** Skip link to the page's main landmark (first focusable element of every shell). */
export function SkipLink({ target = "main-content" }: { target?: string }) {
  const { t } = useLocale();
  return (
    <a
      href={`#${target}`}
      className="sr-only z-[var(--layer-toast)] rounded-md bg-panel px-4 py-2 text-label focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
    >
      {t("common.navigation.skipToContent")}
    </a>
  );
}

/** Two-letter monogram of a name (letters/digits only), "KN" as the product default. */
export function monogramOf(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters =
    words.length > 1 ? `${words[0]?.[0]}${words[1]?.[0]}` : (words[0] ?? "").slice(0, 2);
  return letters ? letters.toLocaleUpperCase() : "KN";
}

/** Logo + instance name linking home; a missing logo falls back to a monogram. */
export function BrandMark({ name, href = "/" }: { name: string; href?: string }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // The image can fail before hydration attaches onError: check its decoded state once.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0 && img.currentSrc) setLogoFailed(true);
  }, []);

  return (
    <Link
      href={href}
      className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-md text-body font-bold"
    >
      {logoFailed ? (
        <span
          aria-hidden="true"
          data-testid="brand-monogram"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-pill bg-primary text-small font-bold text-primary-foreground"
        >
          {monogramOf(name)}
        </span>
      ) : (
        // Plain <img>: a static self-hosted SVG, no optimizer needed.
        <img
          ref={imgRef}
          src="/brand/favicon.svg"
          alt=""
          width={36}
          height={36}
          className="size-9 shrink-0"
          onError={() => setLogoFailed(true)}
        />
      )}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{name}</span>
    </Link>
  );
}

/** Icons per theme preference. */
const THEME_ICONS: Record<ThemePreference, ReactNode> = {
  system: <Monitor aria-hidden="true" className="size-4" />,
  light: <Sun aria-hidden="true" className="size-4" />,
  dark: <Moon aria-hidden="true" className="size-4" />,
};

/** Theme preference menu (system / light / dark); the current choice is checked. */
export function ThemeMenu() {
  const { t } = useLocale();
  const { preference, setPreference } = useTheme();
  const choices: ThemePreference[] = ["system", "light", "dark"];
  return (
    <MenuPopover
      triggerLabel={t("common.theme.label")}
      triggerIcon={THEME_ICONS[preference]}
      placement="bottom-end"
      items={choices.map((choice) => ({
        id: choice,
        label: (
          <span className="inline-flex items-center gap-2">
            {t(`common.theme.${choice}`)}
            {choice === preference && <Check aria-hidden="true" className="size-4" />}
            {choice === preference && (
              <span className="sr-only">{t("accessibility.game.selectedOption")}</span>
            )}
          </span>
        ),
        icon: THEME_ICONS[choice],
      }))}
      onAction={(id) => setPreference(id as ThemePreference)}
    />
  );
}

/** Footer link style. */
const FOOTER_LINK = "inline-flex min-h-11 items-center rounded-md px-2 text-primary underline";

/** Legal/attribution footer shared by the public and dashboard shells. */
export function SiteFooter({
  instanceName,
  showCredits = true,
}: {
  instanceName: string;
  /** False where the credits button already lives elsewhere (dashboard sidebar). */
  showCredits?: boolean;
}) {
  const { t } = useLocale();
  return (
    <footer className="border-t border-border px-4 py-4 text-small md:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="break-words text-muted-foreground [overflow-wrap:anywhere]">
          {instanceName === PRODUCT_NAME ? PRODUCT_NAME : `${instanceName} · ${PRODUCT_NAME}`}
        </p>
        <nav
          aria-label={t("common.navigation.about")}
          className="flex flex-wrap items-center gap-1"
        >
          <Link href="/about" className={FOOTER_LINK}>
            {t("common.navigation.about")}
          </Link>
          <a href="/legal/LICENSE.txt" className={FOOTER_LINK}>
            {t("about.document.codeLicense")}
          </a>
          <a href="/legal/THIRD-PARTY-NOTICES.txt" className={FOOTER_LINK}>
            {t("about.document.thirdPartyNotices")}
          </a>
          <Link href="/help/languages" className={FOOTER_LINK}>
            {t("about.languages.title")}
          </Link>
          {showCredits && <CreditsButton className={`${FOOTER_LINK} hover:bg-subtle`} />}
        </nav>
      </div>
    </footer>
  );
}

/** Instance name for display: the configured name, else the product name. */
export function displayName(state: PublicConfigState): string {
  return state.status === "ready" && state.config.instanceName.trim()
    ? state.config.instanceName
    : PRODUCT_NAME;
}

/** Configuration shared by the public shell with its pages (one request per shell mount). */
export interface PublicShellContextValue {
  state: PublicConfigState;
  retry: () => void;
  /** Display name: the instance name, else "Kabuki Neko". */
  name: string;
}

const PublicShellContext = createContext<PublicShellContextValue | null>(null);

/** Public configuration of the surrounding {@link PublicShell}; throws outside one. */
export function usePublicShell(): PublicShellContextValue {
  const value = useContext(PublicShellContext);
  if (!value) throw new Error("usePublicShell must be used inside PublicShell");
  return value;
}

/** Props of {@link PublicShell}. */
export interface PublicShellProps {
  children: ReactNode;
  /** Public configuration loader (tests); defaults to `GET /system/public-config`. */
  loadConfig?: PublicConfigLoader;
}

/** Public pages shell: header navigation, main landmark and legal footer. */
export function PublicShell({ children, loadConfig }: PublicShellProps) {
  const { t, ensureNamespaces } = useLocale();
  const { state, retry } = usePublicConfig(loadConfig);
  const name = displayName(state);
  const shared = useMemo(() => ({ state, retry, name }), [state, retry, name]);

  useEffect(() => {
    void ensureNamespaces(["auth", "player", "about"]);
  }, [ensureNamespaces]);

  return (
    <PublicShellContext.Provider value={shared}>
      <div className="flex min-h-dvh flex-col bg-canvas text-foreground">
        <SkipLink />
        <header className="border-b border-border bg-panel px-4 py-2 md:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2">
            <BrandMark name={name} />
            <nav
              aria-label={t("common.navigation.menu")}
              className="flex flex-wrap items-center gap-1"
            >
              <Link
                href="/join"
                className="inline-flex min-h-11 items-center rounded-md px-3 text-label font-semibold hover:bg-subtle"
              >
                {t("player.join.title")}
              </Link>
              <Link
                href="/login"
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-label font-semibold text-primary-foreground hover:bg-primary/90"
              >
                {t("auth.login.submit")}
              </Link>
              <LocalePicker />
              <ThemeMenu />
            </nav>
          </div>
        </header>
        {state.status === "error" && (
          <div className="px-4 pt-4 md:px-6 lg:px-8">
            <div className="mx-auto max-w-[1280px]">
              <StatusNotice
                tone="error"
                message={t("common.inventory.s01.error")}
                action={{ label: t("common.actions.retry"), onAction: retry }}
              />
            </div>
          </div>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 outline-none md:px-6 lg:px-8"
        >
          {children}
        </main>
        <SiteFooter instanceName={name} />
      </div>
    </PublicShellContext.Provider>
  );
}
