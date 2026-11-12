"use client";
/**
 * F17 connection and role recovery for player and host screens (Design §6.4, §4.8; SA §5.1, §6.4;
 * US-07/12/21; TASK-152).
 *
 * - No room credentials: "Join a game to connect" with a link to /join (empty).
 * - First sync (no snapshot yet): a full "Connecting…" status. If the transport is down before
 *   any snapshot arrived, an error with Try again and Leave.
 * - Live (connected, synced, no outage): the screen with an unobtrusive "Connected" status for
 *   assistive technology.
 * - Not live with a previous snapshot (reconnecting, catching up after missed phases, or a
 *   state-store outage reported by the server): the last screen stays visible but inert, so
 *   answer and host controls are locked. A banner says what is happening, shows the next automatic
 *   attempt (backoff), and offers Retry now and Leave. A pending answer is reported as
 *   "Sending your answer… Catching up with the game…", never as accepted.
 * - Terminal outcomes (kicked, opened elsewhere, game expired or lost) show the S17 fallback.
 *   Nothing reconnects or rejoins on its own, and a player's stored room credentials are cleared
 *   once (an invalid token can never loop). A host whose sign-in expired is asked to sign in
 *   again.
 * States: loading (connecting), empty (no credentials), ideal (live), partial (reconnecting /
 * catching up / outage with stale content locked) and error (lost / terminal).
 */
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import { SessionFallback } from "@/components/ui/session-fallback";
import { ActionButton } from "@/components/ui/action-button";
import { clearPlayerSession, type RecordStorage } from "@/hooks/use-session-recovery";
import { currentDraft, useGame, type GameState, type TerminalReason } from "@/stores/game.store";
import { useLocale } from "@/providers/locale-provider";

/** Fallback variant for each terminal outcome. */
const TERMINAL_VARIANT: Record<TerminalReason, "kicked" | "replaced" | "roomExpired"> = {
  KICKED: "kicked",
  SESSION_REPLACED: "replaced",
  ROOM_EXPIRED: "roomExpired",
  ROOM_LOST: "roomExpired",
};

/** What the recovery layer shows. */
export type RecoveryView =
  | { kind: "empty" }
  | { kind: "connecting" }
  | { kind: "lost" }
  | { kind: "terminal"; reason: TerminalReason }
  | { kind: "auth" }
  | { kind: "live" }
  | { kind: "stale"; reason: "reconnecting" | "resyncing" | "outage" | "lost" };

/** Derives the view from the game state and the socket layer's flags. */
export function recoveryView(
  state: Pick<GameState, "snapshot" | "transport" | "syncRequested" | "terminal">,
  flags: {
    hasCredentials: boolean;
    outage: boolean;
    authExpired: boolean;
    /** A recovery attempt failed without ending the session (MJ-26); defaults to false. */
    recoveryFailed?: boolean;
  },
): RecoveryView {
  if (state.terminal) return { kind: "terminal", reason: state.terminal };
  if (flags.authExpired) return { kind: "auth" };
  if (!flags.hasCredentials) return { kind: "empty" };
  const transport = state.transport.status;
  // A failed recovery offers Retry/Leave instead of an endless "Connecting…" (MJ-26).
  if (!state.snapshot)
    return transport === "disconnected" || flags.recoveryFailed
      ? { kind: "lost" }
      : { kind: "connecting" };
  if (flags.outage) return { kind: "stale", reason: "outage" };
  if (transport === "disconnected" || flags.recoveryFailed)
    return { kind: "stale", reason: "lost" };
  if (transport !== "connected") return { kind: "stale", reason: "reconnecting" };
  if (state.syncRequested) return { kind: "stale", reason: "resyncing" };
  return { kind: "live" };
}

/** Props of {@link ConnectionRecovery}. */
export interface ConnectionRecoveryProps {
  role: "player" | "host";
  store: StoreApi<GameState>;
  /** Room session of the stored credentials (null = none). */
  sessionId: string | null;
  /** Seconds until the next automatic reconnect (null when none is scheduled). */
  nextRetryInSec?: number | null;
  /** The server reported its state store unavailable: controls stay locked. */
  outage?: boolean;
  /** Host only: the sign-in expired and could not be renewed. */
  authExpired?: boolean;
  /** A recovery attempt failed and is being retried with backoff: show Retry/Leave. */
  recoveryFailed?: boolean;
  /** Reconnect now (manual retry). */
  onRetry: () => void;
  /** Leave the game screen. */
  onLeave: () => void;
  storage?: RecordStorage | null;
  children: ReactNode;
}

/** F17: wraps a live game screen with honest connection and recovery states. */
export function ConnectionRecovery({
  role,
  store,
  sessionId,
  nextRetryInSec = null,
  outage = false,
  authExpired = false,
  recoveryFailed = false,
  onRetry,
  onLeave,
  storage,
  children,
}: ConnectionRecoveryProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const snapshot = useGame(store, (state) => state.snapshot);
  const transport = useGame(store, (state) => state.transport);
  const syncRequested = useGame(store, (state) => state.syncRequested);
  const terminal = useGame(store, (state) => state.terminal);
  const drafts = useGame(store, (state) => state.drafts);
  const cleared = useRef(false);
  const view = recoveryView(
    { snapshot, transport, syncRequested, terminal },
    { hasCredentials: sessionId !== null, outage, authExpired, recoveryFailed },
  );

  useEffect(() => {
    void ensureNamespaces(["player", "validation", "auth"]);
  }, [ensureNamespaces]);

  // A terminal outcome ends the stored player session exactly once (no rejoin loop). A replaced
  // session keeps the record: the replacing tab uses the same credentials (MJ-28).
  useEffect(() => {
    if (view.kind !== "terminal" || role !== "player" || !sessionId || cleared.current) return;
    if (view.reason === "SESSION_REPLACED") return;
    cleared.current = true;
    clearPlayerSession(sessionId, storage === undefined ? undefined : storage);
  }, [view.kind, role, sessionId, storage]);

  if (view.kind === "terminal")
    return <SessionFallback variant={TERMINAL_VARIANT[view.reason]} chrome={false} />;
  if (view.kind === "auth")
    return <SessionFallback variant="authExpired" chrome={false} returnTo={null} />;
  if (view.kind === "empty")
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p role="status">{t("player.inventory.f17.empty")}</p>
        <Link
          href="/join"
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
        >
          {t("player.join.title")}
        </Link>
      </div>
    );
  if (view.kind === "connecting")
    return (
      <p role="status" aria-live="polite" className="p-4 text-small text-muted-foreground">
        {t("player.inventory.f17.loading")}
      </p>
    );

  const actions = (
    <div className="flex flex-wrap gap-2">
      <ActionButton variant="secondary" label={t("common.actions.retry")} onPress={onRetry} />
      <ActionButton variant="ghost" label={t("common.actions.goHome")} onPress={onLeave} />
    </div>
  );

  if (view.kind === "lost")
    return (
      <div
        role="alert"
        className="m-4 flex flex-col items-start gap-3 rounded-md border border-danger bg-danger-surface p-4 text-small text-danger"
      >
        <p>{t("player.inventory.f17.error")}</p>
        {actions}
      </div>
    );

  if (view.kind === "live")
    return (
      <>
        <p role="status" className="sr-only">
          {t("player.inventory.f17.ideal")}
        </p>
        {children}
      </>
    );

  // Stale: keep the last screen visible but locked.
  const draft = currentDraft({ snapshot, drafts });
  const pending = draft?.status === "submitting";
  let message: string;
  if (view.reason === "outage") message = t("validation.errors.stateUnavailable");
  else if (view.reason === "resyncing") message = t("player.inventory.f17.partial");
  else if (view.reason === "lost") message = t("player.inventory.f17.error");
  else message = t("player.connection.reconnecting");
  const wait =
    nextRetryInSec !== null && view.reason !== "resyncing"
      ? ` (${formatNumber(Math.max(0, Math.ceil(nextRetryInSec)), { style: "unit", unit: "second", unitDisplay: "short" })})`
      : "";

  return (
    <>
      <div
        role={view.reason === "lost" || view.reason === "outage" ? "alert" : "status"}
        aria-live="polite"
        data-recovery={view.reason}
        className="sticky top-0 z-[var(--layer-sticky)] flex flex-col gap-2 border-b border-warning bg-warning-surface px-4 py-2 text-small text-warning"
      >
        <p>{`${message}${wait}`}</p>
        {pending && <p>{`${t("player.answer.pendingAck")} ${t("player.connection.resyncing")}`}</p>}
        {view.reason !== "resyncing" && actions}
      </div>
      <div inert aria-busy="true" className="opacity-70">
        {children}
      </div>
    </>
  );
}
