"use client";
/**
 * S17 safe fallbacks and inline connection banners (Design §4.8; SA §1.2; US-08/12/19/21; TASK-133).
 *
 * - `SessionFallback` renders one terminal or page-level outcome with a safe reason and the next
 *   step: not found → Home; no access → Back; auth expired → Sign in again (returns to a safe path,
 *   non-secret drafts stay in memory with the page owner); room expired/lost → Join a game (a new
 *   PIN, never "recovered"); kicked → explanation without any automatic rejoin; replaced → the game
 *   was opened elsewhere; service failure → Try again (busy state, the reason stays visible, a
 *   failed retry says it is still not working) plus a reference ID when it is a safe token.
 * - It never shows resource titles, owners or raw error text — only fixed translated messages —
 *   so a 404/403 does not reveal what exists.
 * - Terminal variants (kicked, replaced, room expired) never retry or navigate on their own: every
 *   way forward is a user action, so there is no rejoin loop.
 * - `ConnectionBanner` is for temporary trouble on an active screen (reconnecting, offline,
 *   catching up, lost with Retry): it stays inline instead of replacing the screen.
 * - Text from route namespaces (validation, auth, player) is used once loaded; until then the
 *   shell (`common`) messages are shown, so server-rendered fallbacks are never blank.
 * States: loading (retry busy "Trying again…"), empty (generic "go back home"), ideal (variant
 * message + actions), partial (reference ID guidance) and error (retry failed again).
 */
import {
  AlertTriangle,
  Ban,
  Clock,
  KeyRound,
  LogOut,
  MonitorSmartphone,
  SearchX,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark, PRODUCT_NAME } from "@/components/ui/public-shell";
import { LocalePicker } from "@/components/ui/locale-picker";
import { ApiError } from "@/lib/api-client";
import { safeReturnTo } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Fallback outcomes (Design §4.8 variants). */
export const FALLBACK_VARIANTS = [
  "notFound",
  "forbidden",
  "authExpired",
  "roomExpired",
  "kicked",
  "replaced",
  "service",
] as const;
/** One fallback outcome. */
export type FallbackVariant = (typeof FALLBACK_VARIANTS)[number];

/** Variants that end a game session; they never retry or rejoin by themselves. */
const TERMINAL: ReadonlySet<FallbackVariant> = new Set(["roomExpired", "kicked", "replaced"]);

/** True for outcomes that must not trigger automatic reconnects or rejoins. */
export function isTerminalVariant(variant: FallbackVariant): boolean {
  return TERMINAL.has(variant);
}

/** Maps an API/socket error code to the fallback to show (unknown codes → service failure). */
export function fallbackForError(code: string | null | undefined): FallbackVariant {
  switch (code) {
    case "NOT_FOUND":
      return "notFound";
    case "FORBIDDEN":
    case "ORIGIN_DENIED":
      return "forbidden";
    case "AUTH_REQUIRED":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
    case "OPERATION_COMPLETED_REAUTH_REQUIRED":
      return "authExpired";
    case "ROOM_NOT_FOUND":
    case "ROOM_EXPIRED":
    case "ROOM_LOST":
    case "INVALID_SESSION_TOKEN":
      return "roomExpired";
    case "PLAYER_KICKED":
      return "kicked";
    case "SESSION_REPLACED":
      return "replaced";
    default:
      return "service";
  }
}

/** Error code and reference of a thrown value (never its message). */
export function describeError(error: unknown): { code: string | null; reference: string | null } {
  if (error instanceof ApiError) return { code: error.code, reference: error.correlationId };
  const digest =
    typeof error === "object" && error !== null && "digest" in error ? error.digest : null;
  return { code: null, reference: typeof digest === "string" ? digest : null };
}

/** Reference IDs are shown only when they are plain tokens (no markup or spaces). */
const SAFE_REFERENCE = /^[A-Za-z0-9_-]{1,128}$/u;

/** The reference ID to display, or null when absent or unsafe. */
export function safeReference(value: string | null | undefined): string | null {
  return value && SAFE_REFERENCE.test(value) ? value : null;
}

/** Message keys and icon per variant (messages show shell text until their namespace loads). */
const VARIANT_COPY: Record<FallbackVariant, { title: string; message: string; icon: ReactNode }> = {
  notFound: {
    title: "common.inventory.s17.ideal",
    message: "validation.errors.notFound",
    icon: <SearchX aria-hidden="true" className="size-10" />,
  },
  forbidden: {
    title: "common.inventory.s17.ideal",
    message: "validation.errors.forbidden",
    icon: <Ban aria-hidden="true" className="size-10" />,
  },
  authExpired: {
    title: "common.inventory.s17.ideal",
    message: "validation.errors.tokenExpired",
    icon: <KeyRound aria-hidden="true" className="size-10" />,
  },
  roomExpired: {
    title: "common.inventory.s17.ideal",
    message: "player.connection.expired",
    icon: <Clock aria-hidden="true" className="size-10" />,
  },
  kicked: {
    title: "common.inventory.s17.ideal",
    message: "player.connection.kicked",
    icon: <LogOut aria-hidden="true" className="size-10" />,
  },
  replaced: {
    title: "common.inventory.s17.ideal",
    message: "player.connection.replaced",
    icon: <MonitorSmartphone aria-hidden="true" className="size-10" />,
  },
  service: {
    title: "common.inventory.s17.title",
    message: "validation.errors.internalError",
    icon: <AlertTriangle aria-hidden="true" className="size-10" />,
  },
};

/** Namespaces holding the variant messages. */
const FALLBACK_NAMESPACES = ["validation", "auth", "player"] as const;

/** Link and button styles (44 px targets, wrapping labels). */
const PRIMARY =
  "inline-flex min-h-12 max-w-full items-center justify-center rounded-md bg-primary px-5 py-2 text-center text-label font-semibold break-words text-primary-foreground hover:bg-primary/90 disabled:opacity-80";
const SECONDARY =
  "inline-flex min-h-12 max-w-full items-center justify-center rounded-md border border-border bg-panel px-5 py-2 text-center text-label font-semibold break-words hover:bg-subtle";

/** Props of {@link SessionFallback}. */
export interface SessionFallbackProps {
  variant: FallbackVariant;
  /** Server correlation ID (shown only when it is a safe token). */
  correlationId?: string | null;
  /**
   * Service retry. Resolve `false` (or reject) when it still fails; the reason stays visible and
   * the "still not working" message is added.
   */
  onRetry?: () => Promise<boolean> | boolean;
  /** Start in the "retry already failed" state (e.g. an error boundary that failed again). */
  retryFailed?: boolean;
  /** Path to return to after signing in again (sanitized). */
  returnTo?: string | null;
  /** Show the logo + language header (false inside a shell that already has one). */
  chrome?: boolean;
}

/** S17 fallback screen. */
export function SessionFallback({
  variant,
  correlationId,
  onRetry,
  retryFailed = false,
  returnTo,
  chrome = true,
}: SessionFallbackProps) {
  const { t, has, ensureNamespaces } = useLocale();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(retryFailed);
  const copy = VARIANT_COPY[variant];
  const reference = safeReference(correlationId);

  useEffect(() => {
    void ensureNamespaces(FALLBACK_NAMESPACES);
  }, [ensureNamespaces]);

  /** Translated text for `key`, or the shell text while its namespace is loading. */
  const text = (key: string, fallback: string) => (has(key) ? t(key) : t(fallback));

  /** Runs the retry once at a time, keeping the reason and reporting a repeated failure. */
  const retry = async () => {
    if (!onRetry || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await Promise.resolve()
      .then(onRetry)
      .then(
        (result) => result,
        () => false,
      );
    setBusy(false);
    setFailed(!ok);
  };

  const home = (
    <Link href="/" className={SECONDARY}>
      {t("common.actions.goHome")}
    </Link>
  );
  const joinLabel = text("player.join.title", "common.actions.continue");
  let actions: ReactNode;
  switch (variant) {
    case "notFound":
      actions = (
        <Link href="/" className={PRIMARY}>
          {t("common.actions.goHome")}
        </Link>
      );
      break;
    case "forbidden":
      actions = (
        <>
          <button
            type="button"
            className={PRIMARY}
            onClick={() =>
              window.history.length > 1 ? window.history.back() : window.location.assign("/")
            }
          >
            {t("common.actions.back")}
          </button>
          {home}
        </>
      );
      break;
    case "authExpired":
      actions = (
        <>
          <Link
            href={`/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`}
            className={PRIMARY}
          >
            {text("auth.recovery.signInAgain", "common.actions.continue")}
          </Link>
          {home}
        </>
      );
      break;
    case "roomExpired":
    case "kicked":
      actions = (
        <>
          <Link href="/join" className={PRIMARY}>
            {joinLabel}
          </Link>
          {home}
        </>
      );
      break;
    case "replaced":
      actions = (
        <>
          <Link href="/" className={PRIMARY}>
            {t("common.actions.goHome")}
          </Link>
          <Link href="/join" className={SECONDARY}>
            {joinLabel}
          </Link>
        </>
      );
      break;
    case "service":
      actions = (
        <>
          {onRetry && (
            <button
              type="button"
              className={PRIMARY}
              aria-disabled={busy || undefined}
              onClick={() => void retry()}
            >
              {busy ? t("common.inventory.s17.loading") : t("common.actions.retry")}
            </button>
          )}
          {home}
        </>
      );
      break;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-foreground">
      {chrome && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-4 py-2 md:px-6">
          <BrandMark name={PRODUCT_NAME} />
          <LocalePicker />
        </header>
      )}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 py-10 outline-none md:items-center"
      >
        <section
          aria-labelledby="fallback-title"
          data-variant={variant}
          className="flex w-full max-w-[560px] flex-col gap-4 rounded-lg border border-border bg-panel p-6 shadow-1"
        >
          <span className="text-muted-foreground">{copy.icon}</span>
          <h1
            id="fallback-title"
            className="text-title font-bold break-words [overflow-wrap:anywhere]"
          >
            {t(copy.title)}
          </h1>
          <p className="break-words [overflow-wrap:anywhere]">
            {text(copy.message, "common.inventory.s17.empty")}
          </p>
          <div role="status" aria-live="polite" className="text-small empty:hidden">
            {failed && !busy ? t("common.inventory.s17.error") : null}
          </div>
          {reference && (
            <div className="flex flex-col gap-1 rounded-md bg-subtle p-3 text-small">
              <p>{t("common.inventory.s17.partial")}</p>
              <p className="font-mono break-all">
                {t("common.error.correlation", { correlationId: reference })}
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-3">{actions}</div>
        </section>
      </main>
    </div>
  );
}

/** Temporary connection states shown inline on an active screen. */
export type ConnectionState = "reconnecting" | "offline" | "resyncing" | "lost";

/** Props of {@link ConnectionBanner}. */
export interface ConnectionBannerProps {
  state: ConnectionState;
  /** Manual retry, offered only once the connection is lost. */
  onRetry?: () => void;
}

/** Inline banner for temporary connection trouble (the screen underneath stays usable). */
export function ConnectionBanner({ state, onRetry }: ConnectionBannerProps) {
  const { t, has } = useLocale();
  const fallback: Record<ConnectionState, string> = {
    reconnecting: "common.status.reconnecting",
    offline: "common.status.offline",
    resyncing: "common.status.processing",
    lost: "common.status.unavailable",
  };
  const key = `player.connection.${state}`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-connection={state}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning bg-warning-surface px-4 py-2 text-small text-warning"
    >
      <span className="break-words">{has(key) ? t(key) : t(fallback[state])}</span>
      {state === "lost" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center rounded-md border border-border bg-panel px-3 text-label text-foreground hover:bg-subtle"
        >
          {t("common.actions.retry")}
        </button>
      )}
    </div>
  );
}
