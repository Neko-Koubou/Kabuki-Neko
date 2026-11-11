"use client";
/**
 * S16 host stage: every phase of a hosted game, with recovery, podium and report status
 * (Design §4.7, §6.1; SA §5.1–5.5, §6.3; Audio revision; US-07/10/12/13/14/21; TASK-160).
 *
 * - Protected: the stage renders only after the session check. Anonymous visitors go to sign-in
 *   with a safe returnTo, and a lost session keeps the stage mounted but inert behind "Sign in
 *   again".
 * - One stable socket, game store, clock and audio engine per page. They live in component state,
 *   so locale or theme switches never reconnect. Leaving unmounts everything: the socket
 *   disconnects and the audio engine releases its lease, so no background loop is left playing.
 * - Recovery: every (re)connect sends `host:recover_room` for the route's session with the user's
 *   access token. An expired token is renewed once (`auth:update`); if renewal fails the
 *   "sign in again" fallback is shown. ConnectionRecovery (F17) keeps the last phase visible but
 *   inert while reconnecting, and shows the terminal fallback when the room expired or was lost.
 * - Phases (all eight):
 *   - LOBBY: HostStageLobby (PIN, link, QR, roster, Lock/Start/End) with the AudioController slot;
 *   - GAME_START_COUNTDOWN, QUESTION_PREVIEW, QUESTION_ANSWERING: QuestionProjector;
 *   - ANSWER_REVEAL: ResultChart plus the explanation dialog (M08);
 *   - LEADERBOARD: Leaderboard;
 *   - PODIUM, FINISHED: Podium (no replay after reconnect) plus the report status.
 *   Start, Skip, Next and End use HostPhaseControls (End from every active phase).
 * - Commands carry the snapshot's phaseVersion as expectedPhaseVersion. The phase is never changed
 *   optimistically; an unknown ACK asks for a sync instead of re-sending, so a duplicate Next can
 *   never skip a question. Feedback comes only from the ACK result or the next snapshot.
 * - Audio: one useAudioEngine with role host decides every cue from the snapshot. The single
 *   AudioController sits in the lobby slot or the stage header. New roster entries trigger the
 *   join pop. There is no other local music player, also not in PROJECTOR mode.
 * - The language picker (F19) sits above the recovery wrapper, so it stays usable while
 *   reconnecting; switching never touches the room.
 * - Report status (pending, ready, failed with retry, lost) does not depend on the cosmetic
 *   FINISHED phase. It follows host-only pushes and falls back to REST while the socket can't
 *   deliver them, including after the room is gone. The report link appears only for a ready
 *   report with its real id.
 * States:
 * - loading: session check or first sync;
 * - empty: lobby without players;
 * - ideal: live phases;
 * - partial: reconnecting with locked stale content;
 * - error: lost, expired or sign-in required (F17).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoreApi } from "zustand";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import type { ClientEventName } from "@kabuki-neko/shared/socket-events";
import { ConnectionRecovery } from "@/components/player/connection-recovery";
import { ReauthPrompt, RedirectToLogin, loginHref } from "@/components/ui/dashboard-shell";
import { useGameClock } from "@/hooks/use-game-clock";
import { useSessionRecovery } from "@/hooks/use-session-recovery";
import { useGameSocket } from "@/hooks/use-socket";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import type { EmitResult, GameSocket } from "@/lib/socket-client";
import { RequireAuth, useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";
import { createGameStore, useGame, type GameState } from "@/stores/game.store";
import { useAudioStore } from "@/stores/useAudioStore";
import { LocalePicker } from "@/components/ui/locale-picker";
import { AudioController } from "./AudioController";
import { ExplanationDialog } from "./explanation-dialog";
import { HostPhaseControls, type HostPhaseCommands } from "./host-phase-controls";
import { HostStageLobby, type CommandOutcome, type HostLobbyCommands } from "./host-stage-lobby";
import { Leaderboard } from "./leaderboard";
import { Podium } from "./podium";
import { QuestionProjector } from "./question-projector";
import { ReportFinalizationNotice } from "./report-finalization-notice";
import { ResultChart } from "./result-chart";

/** Socket endpoint of the API (same variable as the player screens). */
const SOCKET_URL = process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001";

/** Maps an emit result to the outcome the stage components show. */
export function toOutcome<E extends ClientEventName>(result: EmitResult<E>): CommandOutcome {
  if (result.status === "ok") return { status: "ok" };
  if (result.status === "error") return { status: "error", errorCode: result.error.errorCode };
  return { status: "unknown" };
}

/** Builds the lobby and phase commands; each reads the latest snapshot when it runs. */
export function createHostCommands(
  socket: Pick<GameSocket, "emit">,
  store: StoreApi<GameState>,
): HostLobbyCommands & HostPhaseCommands {
  /** Room identity of the current host snapshot, or null while none is synced. */
  const member = () => {
    const snapshot = store.getState().snapshot;
    return snapshot?.role === "host"
      ? { sessionId: snapshot.sessionId, pinCode: snapshot.pinCode, version: snapshot.phaseVersion }
      : null;
  };
  /** Converts a result and asks for a sync when the outcome is unknown. */
  const settle = <E extends ClientEventName>(result: EmitResult<E>): CommandOutcome => {
    const outcome = toOutcome(result);
    if (outcome.status === "unknown") store.getState().requestSync();
    return outcome;
  };
  const notSynced: CommandOutcome = { status: "error", errorCode: "INVALID_PHASE" };
  /** Sends a phase command with the snapshot's phase version. */
  const phase = async (
    event: "host:start_game" | "host:skip_timer" | "host:next_step" | "host:end_game",
  ): Promise<CommandOutcome> => {
    const room = member();
    if (!room) return notSynced;
    return settle(
      await socket.emit(event, {
        sessionId: room.sessionId,
        pinCode: room.pinCode,
        expectedPhaseVersion: room.version,
      }),
    );
  };
  return {
    lock: async (isLocked) => {
      const room = member();
      if (!room) return notSynced;
      return settle(
        await socket.emit("host:lock_room", {
          sessionId: room.sessionId,
          pinCode: room.pinCode,
          isLocked,
        }),
      );
    },
    kick: async (playerId) => {
      const room = member();
      if (!room) return notSynced;
      return settle(
        await socket.emit("host:kick_player", {
          sessionId: room.sessionId,
          pinCode: room.pinCode,
          playerId,
        }),
      );
    },
    start: () => phase("host:start_game"),
    skip: () => phase("host:skip_timer"),
    next: () => phase("host:next_step"),
    end: () => phase("host:end_game"),
  };
}

/** Props of {@link HostStage}. */
export interface HostStageProps {
  /** Room session from the route. */
  sessionId: string;
}

/** S16 route content: the stage behind the session check. */
export function HostStageRoute({ sessionId }: HostStageProps) {
  const { ensureNamespaces } = useLocale();
  const pathname = usePathname();
  const href = loginHref(pathname);

  useEffect(() => {
    void ensureNamespaces(["auth"]);
  }, [ensureNamespaces]);

  return (
    <RequireAuth
      fallback={<RedirectToLogin href={href} />}
      reauthPrompt={<ReauthPrompt href={href} />}
    >
      <HostStage sessionId={sessionId} />
    </RequireAuth>
  );
}

/** S16: the whole host stage for one session. */
export function HostStage({ sessionId }: HostStageProps) {
  const { ensureNamespaces } = useLocale();
  const router = useRouter();
  const { api, getAccessToken, reloadPrincipal } = useAuth();
  const [store] = useState(createGameStore);
  const [authExpired, setAuthExpired] = useState(false);
  const socket = useGameSocket({ url: SOCKET_URL, role: "host", store, getAccessToken });
  const clock = useGameClock({ socket, store });
  const onAuthExpired = useCallback(async () => {
    const token = (await reloadPrincipal()) ? getAccessToken() : null;
    if (!token) setAuthExpired(true);
    return token;
  }, [reloadPrincipal, getAccessToken]);
  useSessionRecovery({
    socket,
    store,
    role: "host",
    sessionId,
    serverNow: clock.serverNow,
    onAuthExpired,
  });
  const snapshot = useGame(store, (state) => state.snapshot);
  const terminal = useGame(store, (state) => state.terminal);
  const host = snapshot?.role === "host" ? snapshot : null;
  const audio = useAudioEngine({ role: "host", snapshot: host, serverNow: clock.serverNow });
  const commands = useMemo(() => createHostCommands(socket, store), [socket, store]);
  const known = useRef<{ sessionId: string; ids: Set<string> } | null>(null);
  const { signal } = audio;

  useEffect(() => {
    void ensureNamespaces(["host", "player", "reports", "studio", "accessibility", "validation"]);
  }, [ensureNamespaces]);

  // A new roster entry plays the join pop once (not for the roster of the first sync).
  useEffect(() => {
    if (!host) return;
    const ids = new Set(host.players.map((player) => player.id));
    const previous = known.current;
    if (previous?.sessionId === host.sessionId)
      for (const id of ids) if (!previous.ids.has(id)) signal("playerJoined", id);
    known.current = { sessionId: host.sessionId, ids };
  }, [host, signal]);

  const retry = useCallback(() => {
    store.getState().setTransport("connecting");
    socket.connect();
  }, [socket, store]);
  const leave = useCallback(() => {
    socket.disconnect();
    router.push("/dashboard/quizzes");
  }, [socket, router]);

  return (
    <>
      {/* Design §3/§8.1: the language control stays usable outside the recovery wrapper (inert
          while reconnecting); switching never touches the room or its commands. */}
      <div className="mx-auto flex w-full max-w-[1920px] justify-end px-4 pt-2 md:px-8">
        <LocalePicker />
      </div>
      <ConnectionRecovery
        role="host"
        store={store}
        sessionId={sessionId}
        authExpired={authExpired}
        onRetry={retry}
        onLeave={leave}
      >
        {host && (
          <HostScreen
            snapshot={host}
            store={store}
            commands={commands}
            serverNow={clock.serverNow}
            api={api}
            audio={audio}
          />
        )}
      </ConnectionRecovery>
      {terminal !== null && (
        <div className="mx-auto w-full max-w-[640px] px-4 pb-6">
          <ReportFinalizationNotice
            sessionId={sessionId}
            status={host?.finalization ?? null}
            api={api}
            poll
          />
        </div>
      )}
    </>
  );
}

/** Props of {@link HostScreen}. */
interface HostScreenProps {
  snapshot: HostRoomSync;
  store: StoreApi<GameState>;
  commands: HostLobbyCommands & HostPhaseCommands;
  serverNow: () => number;
  api: ReturnType<typeof useAuth>["api"];
  audio: ReturnType<typeof useAudioEngine>;
}

/** Stage header plus the content of the current phase. */
function HostScreen({ snapshot, store, commands, serverNow, api, audio }: HostScreenProps) {
  const { t } = useLocale();
  const transport = useGame(store, (state) => state.transport.status);
  const syncRequested = useGame(store, (state) => state.syncRequested);
  const currentTrackId = useAudioStore((state) => state.currentLobbyTrackId);
  const [explaining, setExplaining] = useState(false);
  const live = transport === "connected" && !syncRequested;
  const phaseKey = `${snapshot.sessionId}:${snapshot.phaseVersion}`;
  const question = snapshot.question;

  // The explanation belongs to one reveal: a phase change closes it.
  useEffect(() => setExplaining(false), [snapshot.phaseVersion]);

  const controller = (
    <AudioController
      phase={snapshot.phase}
      status={audio.status}
      manifestReady={audio.manifestReady}
      trackCount={audio.lobbyTracks.length}
      currentTrackLabel={
        audio.lobbyTracks.find((track) => track.id === currentTrackId)?.label ?? null
      }
      onNextTrack={audio.cycleNextLobbyTrack}
      onEnableAudio={() => void audio.unlock()}
    />
  );

  if (snapshot.phase === "LOBBY")
    return (
      <div data-phase="LOBBY" className="mx-auto w-full max-w-[1920px] px-4 py-4 md:px-8">
        <HostStageLobby
          snapshot={snapshot}
          connected={live}
          commands={commands}
          audio={controller}
        />
      </div>
    );

  let content;
  switch (snapshot.phase) {
    case "GAME_START_COUNTDOWN":
    case "QUESTION_PREVIEW":
    case "QUESTION_ANSWERING":
      content = <QuestionProjector snapshot={snapshot} serverNow={serverNow} />;
      break;
    case "ANSWER_REVEAL":
      content = question && (
        <section className="flex flex-col gap-4">
          <h1 dir="auto" className="text-title font-bold whitespace-pre-line break-words">
            {question.promptText}
          </h1>
          <ResultChart
            question={question}
            reveal={snapshot.reveal}
            phaseKey={phaseKey}
            phaseStartedAt={snapshot.timing.phaseStartedAt}
            now={serverNow}
            stale={!live}
            onExplanation={() => setExplaining(true)}
          />
          <ExplanationDialog
            open={explaining}
            promptText={question.promptText}
            explanationText={snapshot.reveal.explanationText}
            pending={syncRequested}
            onClose={() => setExplaining(false)}
          />
        </section>
      );
      break;
    case "LEADERBOARD":
      content = (
        <Leaderboard
          leaderboard={snapshot.leaderboard}
          phaseKey={phaseKey}
          phaseStartedAt={snapshot.timing.phaseStartedAt}
          now={serverNow}
          stale={!live}
        />
      );
      break;
    default:
      content = (
        <section className="flex flex-col gap-6">
          <Podium
            podium={snapshot.podium}
            phase={snapshot.phase === "FINISHED" ? "FINISHED" : "PODIUM"}
            phaseKey={phaseKey}
            phaseStartedAt={snapshot.timing.phaseStartedAt}
            now={serverNow}
            role="host"
            stale={!live}
          />
          <ReportFinalizationNotice
            sessionId={snapshot.sessionId}
            status={snapshot.finalization}
            api={api}
            poll={!live}
          />
          {snapshot.phase === "FINISHED" && (
            <Link
              href="/dashboard/quizzes"
              className="inline-flex min-h-11 items-center self-start rounded-md border border-border px-4 text-label font-semibold"
            >
              {t("common.navigation.quizzes")}
            </Link>
          )}
        </section>
      );
  }

  const inQuestion =
    question !== null && (snapshot.phase === "ANSWER_REVEAL" || snapshot.phase === "LEADERBOARD");

  return (
    <div
      data-phase={snapshot.phase}
      className="mx-auto flex w-full max-w-[1920px] flex-col gap-4 px-4 py-4 md:px-8"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
        <p dir="auto" className="min-w-0 flex-1 font-semibold break-words">
          {snapshot.quizTitle}
        </p>
        <p className="text-small text-muted-foreground">
          {t("player.inventory.f11.title")}{" "}
          <strong className="font-bold text-foreground tabular-nums">{snapshot.pinCode}</strong>
        </p>
        {controller}
      </header>
      {inQuestion && (
        <p className="text-small text-muted-foreground">
          {t("host.stage.questionProgress", {
            index: question.questionIndex + 1,
            total: question.totalQuestions,
          })}
        </p>
      )}
      {content}
      <HostPhaseControls snapshot={snapshot} connected={live} commands={commands} />
    </div>
  );
}
