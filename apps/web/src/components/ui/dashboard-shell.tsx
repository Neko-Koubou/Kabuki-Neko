"use client";
/**
 * Dashboard shell (Design §1.1, §2.4; SA §1.2; US-01/03/15/18/21; TASK-132).
 *
 * - Protected: nothing of the dashboard (not even its navigation) renders until the session check
 *   finishes. Anonymous visitors are redirected to `/login?returnTo=<safe path>`; a lost session
 *   keeps the page mounted but inert with a "Sign in again" prompt (no unauthorized flash, no
 *   remount of the locale/theme/auth providers, which stay in the root layout).
 * - Navigation by role: creators see Quizzes, Media, Reports and About; superadmins additionally
 *   Settings and Users. Hidden links are only a convenience — direct navigation to a forbidden page
 *   still gets a safe page from the server checks.
 * - Layout: skip link, a 224 px sticky sidebar on desktop and a disclosure "Menu" on small screens
 *   (closes on navigation and Escape, focus back to the button), the language picker and a profile
 *   menu (theme + sign out) in the header, the main landmark and the legal footer. The sidebar
 *   holds About and the music credits dialog. Long labels and names wrap.
 * States: loading (session check), empty (anonymous → redirect), ideal (navigation), partial
 * (creator role: admin links hidden) and error (session expired → inert page + sign-in prompt).
 */
import { LogOut, Menu, UserRound, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { USER_ROLES } from "@kabuki-neko/shared/constants/game";
import { CreditsButton } from "@/components/common/CreditsModal";
import { LocalePicker } from "@/components/ui/locale-picker";
import { MenuPopover } from "@/components/ui/menu-popover";
import {
  BrandMark,
  SiteFooter,
  SkipLink,
  displayName,
  usePublicConfig,
  type PublicConfigLoader,
} from "@/components/ui/public-shell";
import type { ThemePreference } from "@/lib/preferences";
import { RequireAuth, safeReturnTo, useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";
import { useTheme } from "@/providers/theme-provider";

/** Account role. */
export type UserRole = (typeof USER_ROLES)[number];

/** One dashboard navigation entry. */
export interface DashboardNavItem {
  href: string;
  labelKey: string;
  /** Shown to superadmins only. */
  superadminOnly?: boolean;
}

/** Dashboard navigation in display order (SA §1.2 routes). */
export const DASHBOARD_NAV: readonly DashboardNavItem[] = [
  { href: "/dashboard/quizzes", labelKey: "common.navigation.quizzes" },
  { href: "/dashboard/media", labelKey: "common.navigation.media" },
  { href: "/dashboard/reports", labelKey: "common.navigation.reports" },
  { href: "/dashboard/settings", labelKey: "common.navigation.settings", superadminOnly: true },
  { href: "/dashboard/users", labelKey: "common.navigation.users", superadminOnly: true },
  { href: "/dashboard/about", labelKey: "common.navigation.about" },
];

/** Navigation entries a role may see (none without a role). */
export function navItemsFor(role: UserRole | null): DashboardNavItem[] {
  if (!role) return [];
  return DASHBOARD_NAV.filter((item) => !item.superadminOnly || role === "SUPERADMIN");
}

/** True when `pathname` is `href` or one of its sub-pages. */
export function isActivePath(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

/** Sign-in URL that returns to a safe dashboard path afterwards. */
export function loginHref(pathname: string | null): string {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(pathname))}`;
}

/** Anonymous visitor: replace the URL with the sign-in page (link kept as a fallback). */
function RedirectToLogin({ href }: { href: string }) {
  const { t } = useLocale();
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [router, href]);
  return (
    <p role="status" className="p-4 text-small">
      {t("common.status.loading")}{" "}
      <Link href={href} className="text-primary underline">
        {t("auth.login.submit")}
      </Link>
    </p>
  );
}

/** Session lost: message and "Sign in again", shown over the inert page and focused. */
function ReauthPrompt({ href }: { href: string }) {
  const { t } = useLocale();
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => linkRef.current?.focus(), []);
  return (
    <div
      role="alert"
      className="fixed inset-x-4 top-4 z-[var(--layer-toast)] mx-auto flex max-w-[480px] flex-col gap-2 rounded-md border border-danger bg-danger-surface p-4 text-small text-danger shadow-2"
    >
      <p>{t("auth.login.sessionExpired")}</p>
      <Link
        ref={linkRef}
        href={href}
        className="inline-flex min-h-11 items-center self-start rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
      >
        {t("auth.recovery.signInAgain")}
      </Link>
    </div>
  );
}

/** Profile menu: theme preference and sign out. */
function ProfileMenu() {
  const { t } = useLocale();
  const { user, signOut } = useAuth();
  const { preference, setPreference } = useTheme();
  const router = useRouter();
  const themes: ThemePreference[] = ["system", "light", "dark"];
  return (
    <MenuPopover
      triggerLabel={user?.name ?? t("common.navigation.profile")}
      triggerIcon={<UserRound aria-hidden="true" className="size-5" />}
      placement="bottom-end"
      items={[
        ...themes.map((choice) => ({
          id: `theme:${choice}`,
          label: `${t("common.theme.label")}: ${t(`common.theme.${choice}`)}${
            choice === preference ? ` (${t("accessibility.game.selectedOption")})` : ""
          }`,
        })),
        {
          id: "sign-out",
          label: t("common.actions.signOut"),
          icon: <LogOut aria-hidden="true" className="size-4" />,
        },
      ]}
      onAction={(id) => {
        if (id.startsWith("theme:")) setPreference(id.slice("theme:".length) as ThemePreference);
        else if (id === "sign-out")
          void signOut().then(() => {
            router.replace("/login");
          });
      }}
    />
  );
}

/** Authenticated dashboard chrome. */
function DashboardFrame({
  children,
  pathname,
  loadConfig,
}: {
  children: ReactNode;
  pathname: string | null;
  loadConfig?: PublicConfigLoader;
}) {
  const { t } = useLocale();
  const { user } = useAuth();
  const { state } = usePublicConfig(loadConfig);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const navId = useId();
  const items = navItemsFor(user?.role ?? null);
  const name = displayName(state);

  // Navigating closes the small-screen menu.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-foreground lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
      <SkipLink />
      <aside className="border-b border-border bg-panel lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto lg:border-e lg:border-b-0">
        <div className="flex items-center justify-between gap-2 p-3">
          <BrandMark name={name} href="/dashboard/quizzes" />
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3 text-label lg:hidden"
          >
            {menuOpen ? (
              <X aria-hidden="true" className="size-5" />
            ) : (
              <Menu aria-hidden="true" className="size-5" />
            )}
            {t("common.navigation.menu")}
          </button>
        </div>
        <nav
          id={navId}
          aria-label={t("common.navigation.menu")}
          onKeyDown={(event) => {
            if (event.key === "Escape" && menuOpen) {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }
          }}
          className={`${menuOpen ? "flex" : "hidden"} flex-col gap-3 px-3 pb-3 lg:flex lg:flex-1`}
        >
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-11 items-center rounded-md px-3 py-2 text-label break-words [overflow-wrap:anywhere] hover:bg-subtle ${
                      active ? "bg-subtle font-semibold text-primary" : ""
                    }`}
                  >
                    {t(item.labelKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border pt-3 lg:mt-auto">
            <CreditsButton />
          </div>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-2 border-b border-border bg-panel px-4 py-2 md:px-6 lg:px-8">
          <LocalePicker />
          <ProfileMenu />
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 outline-none md:px-6 lg:px-8"
        >
          {children}
        </main>
        <SiteFooter instanceName={name} showCredits={false} />
      </div>
    </div>
  );
}

/** Props of {@link DashboardShell}. */
export interface DashboardShellProps {
  children: ReactNode;
  /** Public configuration loader (tests); defaults to `GET /system/public-config`. */
  loadConfig?: PublicConfigLoader;
}

/** Protected dashboard shell. */
export function DashboardShell({ children, loadConfig }: DashboardShellProps) {
  const { ensureNamespaces } = useLocale();
  const pathname = usePathname();
  const href = loginHref(pathname);

  useEffect(() => {
    void ensureNamespaces(["auth", "about"]);
  }, [ensureNamespaces]);

  return (
    <RequireAuth
      fallback={<RedirectToLogin href={href} />}
      reauthPrompt={<ReauthPrompt href={href} />}
    >
      <DashboardFrame pathname={pathname} {...(loadConfig ? { loadConfig } : {})}>
        {children}
      </DashboardFrame>
    </RequireAuth>
  );
}
