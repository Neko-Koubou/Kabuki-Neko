/**
 * Cross-tab refresh coordination (SA §4.2; US-01/US-02; TASK-125).
 *
 * The refresh cookie is shared by every tab, and the server revokes the whole token family when a
 * consumed refresh token is replayed. Two tabs refreshing at once with the same cookie would log
 * the user out everywhere, so refreshes are serialized:
 *
 * - Within a tab, concurrent callers share one in-flight refresh (single flight).
 * - Across tabs, the refresh runs under the Web Locks API (`navigator.locks`, exclusive lock
 *   `kabuki-neko:auth-refresh`). Where Web Locks is missing, a bounded lease in localStorage
 *   (owner + expiry, default 10 s) elects one tab; others wait for its result up to the lease.
 * - The winner broadcasts the new access token on a `BroadcastChannel` (same-origin, in-memory —
 *   never written to storage). A tab that obtains the lock after another tab already refreshed
 *   reuses that token instead of sending the (now rotated) cookie again.
 * - Failures never loop: `TOKEN_REVOKED`/`TOKEN_EXPIRED` and uncertain outcomes (network errors
 *   during rotation) resolve to `null` so the caller asks the user to sign in again; a logout in
 *   any tab is broadcast to all.
 * - Broadcasting is best effort: a closed or failing channel never turns a successful refresh into
 *   a failure. Given a channel factory, `close()` releases the channel and `reopen()` creates a new
 *   one, so a provider whose effects are cleaned up and re-run (React StrictMode, fast refresh)
 *   keeps cross-tab messaging working.
 */

/** A fresh access token and its expiry (epoch ms). */
export interface SharedToken {
  accessToken: string;
  expiresAt: number;
}

/** Why a refresh produced no token. */
export type RefreshFailure = "revoked" | "expired" | "uncertain" | "unauthenticated";

/** Outcome of one coordinated refresh. */
export type RefreshOutcome =
  { ok: true; token: SharedToken } | { ok: false; reason: RefreshFailure };

/** Messages exchanged between tabs. */
export type AuthMessage = { type: "token"; token: SharedToken } | { type: "logout" };

/** Minimal BroadcastChannel surface (injectable for tests). */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** Minimal Web Locks surface (injectable for tests). */
export interface LocksLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Coordinator configuration. */
export interface RefreshCoordinatorOptions {
  /** Performs `POST /auth/refresh`; resolves the outcome (no retries inside). */
  refresh: () => Promise<RefreshOutcome>;
  locks?: LocksLike | null;
  /** Cross-tab channel, or a factory so the channel can be reopened after `close()`. */
  channel?: ChannelLike | null | (() => ChannelLike | null);
  /** Lease storage when Web Locks is unavailable. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  leaseMs?: number;
  /** Tokens expiring sooner than this are not reused. */
  minRemainingMs?: number;
}

/** Lock and lease names. */
export const REFRESH_LOCK = "kabuki-neko:auth-refresh";
export const REFRESH_LEASE_KEY = "kabuki-neko:auth-refresh-lease";
export const AUTH_CHANNEL = "kabuki-neko:auth";

/** Sleeps `ms` milliseconds. */
function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Validates a message received from another tab. */
function parseMessage(data: unknown): AuthMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === "logout") return { type: "logout" };
  const token = message.token as Record<string, unknown> | undefined;
  if (
    message.type === "token" &&
    typeof token?.accessToken === "string" &&
    token.accessToken.length > 0 &&
    typeof token.expiresAt === "number"
  )
    return { type: "token", token: { accessToken: token.accessToken, expiresAt: token.expiresAt } };
  return null;
}

/** The current lease holder, or null when absent/unreadable/malformed. */
function readLease(storage: Pick<Storage, "getItem">): { owner: string; expiresAt: number } | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(REFRESH_LEASE_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { owner, expiresAt } = value as Record<string, unknown>;
    return typeof owner === "string" && typeof expiresAt === "number" ? { owner, expiresAt } : null;
  } catch {
    return null;
  }
}

/** Creates the coordinator for one tab. */
export function createRefreshCoordinator(options: RefreshCoordinatorOptions) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 10_000;
  const minRemainingMs = options.minRemainingMs ?? 30_000;
  const tabId = typeof crypto !== "undefined" ? crypto.randomUUID() : String(Math.random());
  const listeners = new Set<(message: AuthMessage) => void>();
  /** Newest token seen from any tab (including this one). */
  let latest: SharedToken | null = null;
  let inFlight: Promise<RefreshOutcome> | null = null;

  /** Handles a message from another tab. */
  const onMessage = (event: MessageEvent) => {
    const message = parseMessage(event.data);
    if (message === null) return;
    if (message.type === "token" && (latest === null || message.token.expiresAt > latest.expiresAt))
      latest = message.token;
    if (message.type === "logout") latest = null;
    for (const listener of listeners) listener(message);
  };
  /** The open channel (null when none or after `close()`). */
  let channel: ChannelLike | null = null;
  /** Opens the channel (from the factory or the given object) and listens to it. */
  const open = () => {
    channel = typeof options.channel === "function" ? options.channel() : (options.channel ?? null);
    channel?.addEventListener("message", onMessage);
  };
  open();
  /** Broadcasts to other tabs; a closed or broken channel only loses the broadcast. */
  const post = (message: AuthMessage) => {
    try {
      channel?.postMessage(message);
    } catch {
      // Other tabs fall back to their own (serialized) refresh.
    }
  };

  /** A token newer than `current` that is still comfortably valid, if any tab has one. */
  function reusable(current: string | null): SharedToken | null {
    if (latest === null || latest.accessToken === current) return null;
    return latest.expiresAt - now() > minRemainingMs ? latest : null;
  }

  /** The critical section: reuse another tab's token or refresh and broadcast. */
  async function critical(current: string | null): Promise<RefreshOutcome> {
    const shared = reusable(current);
    if (shared) return { ok: true, token: shared };
    const outcome = await options.refresh();
    if (outcome.ok) {
      latest = outcome.token;
      post({ type: "token", token: outcome.token });
    }
    return outcome;
  }

  /** Lease fallback when Web Locks is unavailable: one tab refreshes, others wait for it. */
  async function withLease(current: string | null): Promise<RefreshOutcome> {
    const storage = options.storage;
    if (!storage) return critical(current);
    const deadline = now() + leaseMs;
    for (;;) {
      const holder = readLease(storage);
      const held = holder !== null && holder.owner !== tabId && holder.expiresAt > now();
      if (!held) break;
      // Another tab is refreshing: use its broadcast token as soon as it arrives.
      const shared = reusable(current);
      if (shared) return { ok: true, token: shared };
      if (now() >= deadline) break; // bounded wait; then take over
      await delay(50);
    }
    try {
      storage.setItem(
        REFRESH_LEASE_KEY,
        JSON.stringify({ owner: tabId, expiresAt: now() + leaseMs }),
      );
    } catch {
      return critical(current);
    }
    try {
      return await critical(current);
    } finally {
      try {
        storage.removeItem(REFRESH_LEASE_KEY);
      } catch {
        // Storage became unavailable; the lease simply expires.
      }
    }
  }

  return {
    /**
     * Returns a fresh token for a caller whose token `current` was rejected (or null at start-up).
     * Concurrent calls in this tab share one refresh; tabs are serialized by lock or lease.
     */
    refresh(current: string | null): Promise<RefreshOutcome> {
      if (inFlight) return inFlight;
      const run = options.locks
        ? options.locks.request(REFRESH_LOCK, () => critical(current))
        : withLease(current);
      inFlight = run
        .catch((): RefreshOutcome => ({ ok: false, reason: "uncertain" }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    /** Shares a token obtained outside a refresh (sign-in) with every tab. */
    share(token: SharedToken) {
      latest = token;
      post({ type: "token", token });
    },
    /** Tells every tab that the user signed out. */
    announceLogout() {
      latest = null;
      post({ type: "logout" });
    },
    /** Subscribes to other tabs' token/logout messages. */
    subscribe(listener: (message: AuthMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Releases the channel (subscriptions are removed by their own cleanups). */
    close() {
      channel?.removeEventListener("message", onMessage);
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      channel = null;
    },
    /** Reopens the channel after `close()` (only possible with a channel factory). */
    reopen() {
      if (channel === null && typeof options.channel === "function") open();
    },
  };
}

/** The coordinator type. */
export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>;
