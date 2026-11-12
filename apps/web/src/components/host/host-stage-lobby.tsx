"use client";
/**
 * F13 host lobby with moderation (S16 LOBBY; Design §4.7, §7.3; SA §5.2; US-07/08/18/21;
 * TASK-158).
 *
 * - Join panel:
 *   - large PIN and the join link (domain/join), with "Copy link";
 *   - when the clipboard is unavailable, the link is selectable for manual copying;
 *   - a QR code with "Enlarge QR code" (M07).
 * - Audio: the host's AudioController is rendered in the given slot, so audio ownership stays with
 *   the stage's single useAudioEngine. There is no extra local player here.
 * - Roster:
 *   - "n of capacity players" with the effective room capacity;
 *   - a grid keyed by player id in join order, stable for 200 players: a new join never moves
 *     focus, and joins are announced politely;
 *   - connected and disconnected badges; a kicked player leaves only when the server's roster
 *     says so (never optimistically);
 *   - "Remove" is always visible (keyboard and touch, not hover-only) and goes through M09.
 * - Controls follow the server capabilities and wait for each ACK (pending, no repeats):
 *   - Lock/Unlock: the state shown is the server's. A failed lock leaves it unchanged and
 *     explains why.
 *   - Start: disabled with the reason while no player is connected.
 *   - End game: through M09.
 *   - A lost host connection pauses every control.
 * States:
 * - loading: no snapshot;
 * - empty: no players;
 * - ideal;
 * - partial: some players disconnected;
 * - error: host connection lost, controls paused.
 */
import { Copy } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ErrorCode } from "@kabuki-neko/shared/errors";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { ActionButton } from "@/components/ui/action-button";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, apiErrorMessageKey } from "@/lib/api-client";
import { buildJoinUrl, configuredAppOrigin } from "@/lib/qr";
import { useLocale } from "@/providers/locale-provider";
import { QrCodeImage, QrEnlargeButton, type ClipboardLike, type QrGenerator } from "./qr-dialog";

/** Result of a host command, as the server answered it. */
export type CommandOutcome =
  { status: "ok" } | { status: "error"; errorCode: ErrorCode } | { status: "unknown" };

/** Host lobby commands (socket emits in the host stage). */
export interface HostLobbyCommands {
  lock: (isLocked: boolean) => Promise<CommandOutcome>;
  start: () => Promise<CommandOutcome>;
  kick: (playerId: string) => Promise<CommandOutcome>;
  end: () => Promise<CommandOutcome>;
}

/** Throws the outcome as an ApiError so M09 shows blocked/failed honestly. */
function throwUnlessOk(outcome: CommandOutcome): void {
  if (outcome.status === "ok") return;
  if (outcome.status === "unknown") throw new ApiError(0, "NETWORK_ERROR", {}, [], null, true);
  throw new ApiError(409, outcome.errorCode);
}

/** Props of {@link HostStageLobby}. */
export interface HostStageLobbyProps {
  /** Host snapshot in LOBBY (null while syncing). */
  snapshot: HostRoomSync | null;
  /** The host's own connection is live. */
  connected: boolean;
  commands: HostLobbyCommands;
  /** AudioController rendered in the top-right slot. */
  audio?: ReactNode;
  /** Join origin (defaults to the configured app origin). */
  origin?: string;
  /** Clipboard (tests); defaults to `navigator.clipboard`, null when unavailable. */
  clipboard?: ClipboardLike;
  /** QR generator (tests). */
  generate?: QrGenerator;
}

/** F13: the host lobby. */
export function HostStageLobby({
  snapshot,
  connected,
  commands,
  audio,
  origin,
  clipboard,
  generate,
}: HostStageLobbyProps) {
  const { t, ensureNamespaces } = useLocale();
  const linkId = useId();
  const [busy, setBusy] = useState<"lock" | "start" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [kicking, setKicking] = useState<{ id: string; nickname: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    void ensureNamespaces(["host", "validation", "auth"]);
  }, [ensureNamespaces]);

  const players = useMemo(
    () => [...(snapshot?.players ?? [])].sort((a, b) => a.joinOrder - b.joinOrder),
    [snapshot?.players],
  );

  // Announce new joins without moving focus.
  useEffect(() => {
    const ids = new Set(players.map((player) => player.id));
    if (known.current) {
      const joined = players.filter((player) => !known.current?.has(player.id)).at(-1);
      if (joined) setAnnouncement(t("host.lobby.playerJoined", { nickname: joined.nickname }));
    }
    known.current = ids;
  }, [players, t]);

  const kick = useConfirmAction({
    run: async () => {
      if (!kicking) return;
      throwUnlessOk(await commands.kick(kicking.id));
    },
    onDone: () => setKicking(null),
  });
  const end = useConfirmAction({ run: async () => throwUnlessOk(await commands.end()) });

  if (!snapshot)
    return (
      <p role="status" aria-live="polite" className="p-4 text-body text-muted-foreground">
        {t("host.inventory.s16.loading")}
      </p>
    );

  const appOrigin = origin ?? configuredAppOrigin() ?? "";
  const joinUrl = appOrigin
    ? buildJoinUrl(appOrigin, snapshot.pinCode)
    : `/join?pin=${snapshot.pinCode}`;
  const caps = snapshot.capabilities;
  const connectedPlayers = players.filter((player) => player.connected).length;
  const disconnected = players.length - connectedPlayers;
  const locked = !connected;
  const writer: ClipboardLike =
    clipboard !== undefined
      ? clipboard
      : typeof navigator !== "undefined" && navigator.clipboard
        ? navigator.clipboard
        : null;

  /** Runs a toggle/start command once and reports a refusal. */
  const run = async (name: "lock" | "start", command: () => Promise<CommandOutcome>) => {
    if (busy || locked) return;
    setBusy(name);
    setProblem(null);
    try {
      const outcome = await command();
      if (outcome.status === "error") setProblem(t(apiErrorMessageKey(outcome.errorCode)));
      if (outcome.status === "unknown") setProblem(t("host.inventory.f13.partial"));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!writer) {
      setCopy("failed");
      return;
    }
    try {
      await writer.writeText(joinUrl);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <section aria-labelledby={`${linkId}-title`} className="flex flex-col gap-6 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-small text-muted-foreground">{t("host.lobby.title")}</p>
          <h1 id={`${linkId}-title`} className="text-title font-bold break-words">
            {snapshot.quizTitle}
          </h1>
        </div>
        {audio}
      </div>
      {locked && <StatusNotice tone="error" message={t("host.inventory.f13.error")} />}
      <div className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-[1fr_auto]">
        <div className="flex min-w-0 flex-col gap-3">
          <p className="text-label font-semibold">{t("host.lobby.sharePin")}</p>
          <p
            className="font-mono text-display font-bold tracking-widest tabular-nums"
            aria-label={`PIN ${snapshot.pinCode}`}
          >
            <bdi>{snapshot.pinCode}</bdi>
          </p>
          <label htmlFor={linkId} className="sr-only">
            {t("host.qr.copyLink")}
          </label>
          <input
            id={linkId}
            readOnly
            value={joinUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-small"
          />
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              variant="secondary"
              icon={<Copy />}
              label={t("host.qr.copyLink")}
              onPress={() => void copyLink()}
            />
            <QrEnlargeButton
              pin={snapshot.pinCode}
              {...(appOrigin ? { origin: appOrigin } : {})}
              {...(generate ? { generate } : {})}
              {...(clipboard !== undefined ? { clipboard } : {})}
            />
          </div>
          <p role="status" aria-live="polite" className="text-small empty:hidden">
            {copy === "copied" ? t("host.qr.copied") : ""}
          </p>
          {copy === "failed" && (
            <p role="alert" className="text-small text-danger">
              {`${t("host.qr.copyFailed")} ${t("host.qr.manualCopy")}`}
            </p>
          )}
        </div>
        <QrCodeImage
          value={joinUrl}
          label={t("host.qr.title")}
          {...(generate ? { generate } : {})}
          className="size-40 self-center"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-title-sm font-semibold tabular-nums">
          {t("host.lobby.playerCount", { count: players.length, capacity: snapshot.maxPlayers })}
        </p>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            variant="secondary"
            label={snapshot.isLocked ? t("host.lobby.unlock") : t("host.lobby.lock")}
            pending={busy === "lock"}
            disabled={locked || !caps.canLock}
            aria-pressed={snapshot.isLocked}
            onPress={() => void run("lock", () => commands.lock(!snapshot.isLocked))}
          />
          <ActionButton
            label={t("host.lobby.startGame")}
            pending={busy === "start"}
            disabled={locked || !caps.canStart || connectedPlayers === 0}
            {...(connectedPlayers === 0 ? { disabledReason: t("host.inventory.s16.empty") } : {})}
            onPress={() => void run("start", commands.start)}
          />
          <ActionButton
            variant="danger"
            label={t("host.controls.endGame")}
            disabled={locked || !caps.canEnd}
            onPress={end.request}
          />
        </div>
      </div>
      {problem && (
        <StatusNotice tone="error" message={problem} onDismiss={() => setProblem(null)} />
      )}
      {disconnected > 0 && (
        <p className="text-small text-warning">{t("host.inventory.f13.partial")}</p>
      )}
      {players.length === 0 ? (
        <p role="status" className="rounded-md border border-dashed border-border p-6 text-center">
          {t("host.inventory.f13.empty")}
        </p>
      ) : (
        <ul
          className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
          aria-label={t("host.lobby.title")}
        >
          {players.map((player) => (
            <li
              key={player.id}
              data-player-id={player.id}
              className={`flex min-w-0 flex-col items-center gap-2 rounded-md border border-border p-3 text-center ${
                player.connected ? "" : "opacity-70"
              }`}
            >
              <AvatarIllustration
                avatar={player.avatar}
                nickname={player.nickname}
                size={56}
                decorative
              />
              <span className="w-full text-label font-semibold break-words">
                <bdi>{player.nickname}</bdi>
              </span>
              <StatusBadge
                tone={player.connected ? "success" : "neutral"}
                label={player.connected ? t("host.lobby.connected") : t("host.lobby.disconnected")}
              />
              {caps.canKick && (
                <ActionButton
                  variant="ghost"
                  size="md"
                  label={t("host.lobby.kick")}
                  accessibleName={`${t("host.lobby.kick")}: ${player.nickname}`}
                  disabled={locked}
                  onPress={() => {
                    setKicking({ id: player.id, nickname: player.nickname });
                    kick.request();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ConfirmDialog
        controller={kick}
        impact={t("common.confirm.kickPlayer")}
        targetName={kicking?.nickname ?? null}
        confirmLabel={t("host.controls.confirmKick")}
      />
      <ConfirmDialog
        controller={end}
        impact={t("common.confirm.endGame")}
        targetName={snapshot.quizTitle}
        confirmLabel={t("host.controls.confirmEnd")}
      />
    </section>
  );
}
