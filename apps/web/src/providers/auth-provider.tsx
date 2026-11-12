"use client";
/**
 * Auth provider (SA §4.2, US-01/US-02; TASK-125): the signed-in principal, the in-memory access
 * token and the API client wired to them.
 *
 * - The access JWT lives only in memory (a ref) — never in localStorage, sessionStorage or a
 *   cookie the page can read. The rotating refresh cookie is HttpOnly and handled by the server.
 * - The session is checked lazily: `RequireAuth` (protected routes) calls `ensureSession`, which
 *   refreshes through the cross-tab coordinator and loads `GET /auth/me`. Public pages never
 *   call the refresh endpoint. Protected content stays hidden until that check succeeds.
 * - Expired access tokens are refreshed once per request by the API client through the
 *   coordinator. A revoked/expired/uncertain refresh (e.g. a consumed token replayed) disables
 *   further automatic refreshes — no loop — and moves an authenticated session to `reauth`: the
 *   page stays mounted (non-secret drafts in memory survive) but becomes inert behind a sign-in
 *   prompt. A 401 from `/auth/me` (deactivated user) means anonymous.
 * - `acceptSession` stores a sign-in/setup/register response and shares the token with other
 *   tabs (which resume if they were waiting for re-authentication). `signOut` calls
 *   `/auth/logout`, clears the token and principal, aborts requests bound to `sessionSignal` and
 *   signs out every tab.
 * - `safeReturnTo` only accepts same-origin paths inside an allowlist of app areas.
 */
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
import {
  logoutResponseSchema,
  refreshResponseSchema,
  type authResponseSchema,
} from "@kabuki-neko/shared/schemas/auth.schema";
import { userSchema, type User } from "@kabuki-neko/shared/schemas/users.schema";
import type { z } from "zod";
import { ApiError, createApiClient, type ApiClient } from "@/lib/api-client";
import {
  AUTH_CHANNEL,
  createRefreshCoordinator,
  type ChannelLike,
  type LocksLike,
  type RefreshCoordinator,
  type RefreshOutcome,
  type SharedToken,
} from "@/lib/refresh-coordinator";
import { useLocale } from "@/providers/locale-provider";

/** Sign-in, setup and register responses. */
export type AuthResponse = z.infer<typeof authResponseSchema>;

/**
 * Session status. `unavailable`: the session could not be checked for a transient reason
 * (offline, timeout, 5xx); the token is kept and the user can retry — it is not a sign-out.
 */
export type AuthStatus =
  "unknown" | "checking" | "authenticated" | "anonymous" | "reauth" | "unavailable";

/** `/auth/me` answers that really mean the session is gone (after the client's refresh attempt). */
const SESSION_LOST_CODES: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "TOKEN_REVOKED",
  "TOKEN_EXPIRED",
]);

/** Value exposed by {@link useAuth}. */
export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  api: ApiClient;
  /** Aborted when the session ends (sign-out or loss); pass it to session-bound requests. */
  sessionSignal: AbortSignal;
  /** Checks (once) whether a session exists; resolves true when authenticated. */
  ensureSession: () => Promise<boolean>;
  /** Stores a successful sign-in/setup/register response. */
  acceptSession: (response: AuthResponse) => void;
  signOut: () => Promise<void>;
  /** Current in-memory access token (e.g. for the game socket handshake); never stored. */
  getAccessToken: () => string | null;
  /** Reloads `GET /auth/me` (e.g. after a 403 changed what the user may do); true when signed in. */
  reloadPrincipal: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** App areas a `returnTo` may point at (never auth pages or other origins). */
export const RETURN_TO_PREFIXES = [
  "/dashboard",
  "/studio",
  "/host",
  "/reports",
  "/join",
  "/play",
  "/about",
  "/help",
] as const;
/** Default landing after sign-in. */
export const DEFAULT_RETURN_TO = "/dashboard";

/**
 * A safe local redirect target: same-origin, normalized, inside `RETURN_TO_PREFIXES`; anything
 * else (other origins, `//host`, backslashes, schemes, auth pages, traversal) gives the default.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return DEFAULT_RETURN_TO;
  if (value.length > 2000 || Array.from(value).some((char) => (char.codePointAt(0) ?? 0) < 0x20))
    return DEFAULT_RETURN_TO;
  try {
    const origin = "https://kabuki-neko.invalid";
    const url = new URL(value, origin);
    if (url.origin !== origin) return DEFAULT_RETURN_TO;
    const allowed = RETURN_TO_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );
    return allowed ? `${url.pathname}${url.search}${url.hash}` : DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

/** Props of {@link AuthProvider}. */
export interface AuthProviderProps {
  /** API base including `/api/v1`. */
  apiBaseUrl: string;
  children: ReactNode;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  locks?: LocksLike | null;
  channel?: ChannelLike | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** Browser Web Locks, when available. */
function browserLocks(): LocksLike | null {
  return typeof navigator !== "undefined" && "locks" in navigator
    ? (navigator.locks as LocksLike)
    : null;
}
/** Browser BroadcastChannel, when available. */
function browserChannel(): ChannelLike | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AUTH_CHANNEL);
}
/** Browser localStorage (lease fallback), when accessible. */
function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Holds the principal and token and provides the authenticated API client. */
export function AuthProvider({
  apiBaseUrl,
  children,
  fetch: fetchImpl,
  locks,
  channel,
  storage,
}: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>("unknown");
  const [user, setUser] = useState<User | null>(null);
  const [sessionController, setSessionController] = useState(() => new AbortController());
  const token = useRef<SharedToken | null>(null);
  const refreshDisabled = useRef(false);
  const statusRef = useRef<AuthStatus>("unknown");
  statusRef.current = status;
  const checking = useRef<Promise<boolean> | null>(null);

  /** Ends the current session signal and starts a new one. */
  const resetSession = useCallback(() => {
    setSessionController((current) => {
      current.abort();
      return new AbortController();
    });
  }, []);

  const [coordinator] = useState<RefreshCoordinator>(() => {
    // The refresh call itself uses a bare client (no bearer, no nested refresh).
    const bare = createApiClient({
      baseUrl: apiBaseUrl,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    return createRefreshCoordinator({
      locks: locks === undefined ? browserLocks() : locks,
      // A factory, so the channel can be reopened when effects re-run (StrictMode, fast refresh).
      channel: channel === undefined ? browserChannel : channel,
      storage: storage === undefined ? browserStorage() : storage,
      refresh: async (): Promise<RefreshOutcome> => {
        try {
          const { data } = await bare.request({
            method: "POST",
            path: "/auth/refresh",
            body: {},
            schema: refreshResponseSchema,
          });
          return {
            ok: true,
            token: { accessToken: data.accessToken, expiresAt: Date.now() + data.expiresIn * 1000 },
          };
        } catch (error) {
          const code = error instanceof ApiError ? error.code : null;
          if (code === "TOKEN_REVOKED") return { ok: false, reason: "revoked" };
          if (code === "TOKEN_EXPIRED") return { ok: false, reason: "expired" };
          if (code === "AUTH_REQUIRED") return { ok: false, reason: "unauthenticated" };
          return { ok: false, reason: "uncertain" };
        }
      },
    });
  });

  /** The session was lost: stop refreshing, keep the page (reauth) or end it (anonymous). */
  const loseSession = useCallback(() => {
    token.current = null;
    refreshDisabled.current = true;
    setStatus((current) =>
      current === "authenticated" || current === "reauth" ? "reauth" : "anonymous",
    );
    resetSession();
  }, [resetSession]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        getAccessToken: () => token.current?.accessToken ?? null,
        refreshAccessToken: async () => {
          if (refreshDisabled.current) return false;
          const outcome = await coordinator.refresh(token.current?.accessToken ?? null);
          if (outcome.ok) {
            token.current = outcome.token;
            return true;
          }
          loseSession();
          return false;
        },
      }),
    [apiBaseUrl, fetchImpl, coordinator, loseSession],
  );

  /**
   * Loads the principal for the current token. Only a lost session (401 AUTH_REQUIRED /
   * TOKEN_REVOKED / TOKEN_EXPIRED, e.g. deactivated) signs out. A transient failure (offline,
   * timeout, 5xx) keeps the token and the current page (code review MJ-30): during the initial
   * check the status becomes `unavailable` (retryable); an authenticated page stays as it is.
   */
  const loadPrincipal = useCallback(async (): Promise<boolean> => {
    try {
      const { data } = await api.request({ path: "/auth/me", schema: userSchema });
      setUser(data);
      setStatus("authenticated");
      return true;
    } catch (error) {
      if (error instanceof ApiError && SESSION_LOST_CODES.has(error.code)) {
        token.current = null;
        setUser(null);
        setStatus("anonymous");
        return false;
      }
      setStatus((current) =>
        current === "checking" || current === "unknown" ? "unavailable" : current,
      );
      return false;
    }
  }, [api]);

  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (statusRef.current === "authenticated") return true;
    if (checking.current) return checking.current;
    if (refreshDisabled.current) return false;
    setStatus("checking");
    checking.current = (async () => {
      const outcome = await coordinator.refresh(null);
      if (!outcome.ok) {
        token.current = null;
        if (outcome.reason !== "unauthenticated") refreshDisabled.current = true;
        setStatus("anonymous");
        return false;
      }
      token.current = outcome.token;
      return loadPrincipal();
    })().finally(() => {
      checking.current = null;
    });
    return checking.current;
  }, [coordinator, loadPrincipal]);

  const acceptSession = useCallback(
    (response: AuthResponse) => {
      const shared = {
        accessToken: response.accessToken,
        expiresAt: Date.now() + response.expiresIn * 1000,
      };
      token.current = shared;
      refreshDisabled.current = false;
      setUser(response.user);
      setStatus("authenticated");
      coordinator.share(shared);
    },
    [coordinator],
  );

  const signOut = useCallback(async () => {
    try {
      await api.request({
        method: "POST",
        path: "/auth/logout",
        body: {},
        schema: logoutResponseSchema,
      });
    } catch {
      // The local session ends regardless; the server revokes the family when reachable.
    }
    token.current = null;
    refreshDisabled.current = false;
    setUser(null);
    setStatus("anonymous");
    resetSession();
    coordinator.announceLogout();
  }, [api, coordinator, resetSession]);

  // Other tabs: a shared token resumes a session waiting for re-authentication; a logout ends it.
  useEffect(() => {
    const unsubscribe = coordinator.subscribe((message) => {
      if (message.type === "logout") {
        token.current = null;
        setUser(null);
        setStatus("anonymous");
        resetSession();
        return;
      }
      if (token.current === null || message.token.expiresAt > token.current.expiresAt)
        token.current = message.token;
      if (statusRef.current === "reauth") {
        refreshDisabled.current = false;
        void loadPrincipal();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [coordinator, loadPrincipal, resetSession]);

  // Own the cross-tab channel for the provider's lifetime (reopened if the effect re-runs).
  useEffect(() => {
    coordinator.reopen();
    return () => coordinator.close();
  }, [coordinator]);

  const getAccessToken = useCallback(() => token.current?.accessToken ?? null, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      api,
      sessionSignal: sessionController.signal,
      ensureSession,
      acceptSession,
      signOut,
      getAccessToken,
      reloadPrincipal: loadPrincipal,
    }),
    [
      status,
      user,
      api,
      sessionController,
      ensureSession,
      acceptSession,
      signOut,
      getAccessToken,
      loadPrincipal,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Auth context; throws outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

/** Props of {@link RequireAuth}. */
export interface RequireAuthProps {
  children: ReactNode;
  /** Rendered for anonymous visitors (e.g. a redirect to sign-in with a safe returnTo). */
  fallback: ReactNode;
  /** Rendered over the inert page when the session must be renewed. */
  reauthPrompt: ReactNode;
}

/** Shows protected content only after the session check; keeps it mounted but inert on reauth. */
export function RequireAuth({ children, fallback, reauthPrompt }: RequireAuthProps) {
  const { status, ensureSession } = useAuth();
  const { t } = useLocale();

  useEffect(() => {
    if (status === "unknown") void ensureSession();
  }, [status, ensureSession]);

  if (status === "unknown" || status === "checking")
    return (
      <p role="status" className="p-4 text-small text-muted-foreground">
        {t("common.status.loading")}
      </p>
    );
  if (status === "anonymous") return <>{fallback}</>;
  if (status === "unavailable")
    return (
      <div role="alert" className="m-4 flex flex-col items-start gap-3 text-small">
        <p>{t("common.inventory.s17.error")}</p>
        <button
          type="button"
          className="inline-flex min-h-11 items-center rounded-md border border-border px-4 font-semibold"
          onClick={() => void ensureSession()}
        >
          {t("common.actions.retry")}
        </button>
      </div>
    );
  // Same wrapper for authenticated and reauth, so a lost session never remounts the page.
  const locked = status === "reauth";
  return (
    <>
      <div inert={locked} aria-hidden={locked || undefined} className="contents">
        {children}
      </div>
      {locked && reauthPrompt}
    </>
  );
}
