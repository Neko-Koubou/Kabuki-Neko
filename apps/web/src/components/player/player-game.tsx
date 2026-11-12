"use client";
/**
 * S15 player game screen: every phase for guests, with no account (Design §4.6, §6.1, §7.3;
 * SA §5.1–5.5; Audio revision; US-08–13/18/21; TASK-157).
 *
 * - One stable socket, game store, clock and audio engine per page. They live in this component's
 *   state, so locale or theme switches never reconnect, reset the draft or move focus. Leaving
 *   unmounts everything: the socket disconnects and audio stops, so no background loop is left.
 * - Credentials are the room-scoped token saved at join (`kabuki:player-pin:<pin>`). Reading them
 *   happens after mount, so server and client render the same first frame. The recovery hook
 *   rejoins with them on every connect. Without credentials, F17 offers "Join a game".
 * - ConnectionRecovery (F17) wraps the screen. A reconnect keeps the last phase visible but inert
 *   (answers locked), and kick, replacement or expiry show the terminal fallback once.
 * - The header shows avatar, nickname, score and streak from the server, plus the Streamer-only
 *   opt-in for thinking music. The language picker (F19) sits above the recovery wrapper so it
 *   stays usable while reconnecting or offline; a switch only re-renders text, never the socket,
 *   the accepted answer or the quiz content.
 * - Phases:
 *   - LOBBY: big avatar, "Waiting for the host to start…", and the avatar editor (M01, LOBBY only).
 *   - GAME_START_COUNTDOWN: server-synced 3, 2, 1.
 *   - QUESTION_PREVIEW: progress, type, points multiplier and prompt, with no options or keys.
 *   - QUESTION_ANSWERING: authoritative timer plus the answer pad.
 *     - PROJECTOR shows shapes and letters first, with a local text toggle; the prompt is kept for
 *       screen readers.
 *     - STREAMER shows the prompt, media (clock-driven reveal) and full option text.
 *   - ANSWER_REVEAL: the server's personal result and the reveal chart.
 *   - LEADERBOARD: top five with own row and own rank.
 *   - PODIUM / FINISHED: the podium (no replay after reconnect), own final score and rank, and
 *     "Join a game"; never the host report.
 * - Audio cues come only from the snapshot through useAudioEngine. The accepted-answer sound
 *   follows an authoritative ACK only.
 * States:
 * - loading: reading credentials or the first sync;
 * - empty: no credentials;
 * - ideal: live phases;
 * - partial: reconnecting with locked stale content;
 * - error: lost or terminal (F17).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { PlayerRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { Leaderboard } from "@/components/host/leaderboard";
import { Podium } from "@/components/host/podium";
import { ResultChart } from "@/components/host/result-chart";
import { ActionButton } from "@/components/ui/action-button";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { MediaPreview } from "@/components/ui/media-preview";
import { MediaReveal } from "@/components/ui/media-reveal";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { useGameClock } from "@/hooks/use-game-clock";
import {
  findPlayerSessionByPin,
  useSessionRecovery,
  type PlayerSessionRecord,
} from "@/hooks/use-session-recovery";
import { useGameSocket } from "@/hooks/use-socket";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import type { GameSocket } from "@/lib/socket-client";
import { useLocale } from "@/providers/locale-provider";
import { createGameStore, currentDraft, useGame, type GameState } from "@/stores/game.store";
import type { StoreApi } from "zustand";
import { AvatarCustomizer } from "./avatar-customizer";
import { LocalePicker } from "@/components/ui/locale-picker";
import { ConnectionRecovery } from "./connection-recovery";
import { GameTimer } from "./game-timer";
import { PersonalResult } from "./personal-result";
import { PlayerStageAnswerPad } from "./player-stage-answer-pad";
import { StreamerAudioToggle } from "./streamer-audio-toggle";

/** Socket endpoint of the API (same variable as the join flow). */
const SOCKET_URL = process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001";

/** Catalog key of each question type label. */
const TYPE_LABEL: Record<string, string> = {
  SINGLE_CHOICE: "studio.types.singleChoice",
  TRUE_FALSE: "studio.types.trueFalse",
  MULTIPLE_SELECT: "studio.types.multipleSelect",
  TYPE_ANSWER: "studio.types.typeAnswer",
  ORDER_PUZZLE: "studio.types.orderPuzzle",
  POLL: "studio.types.poll",
};

/** Props of {@link PlayerGame}. */
export interface PlayerGameProps {
  /** The six-digit PIN from the route (credentials are looked up by it). */
  pinCode: string;
}

/** S15: the whole guest game screen for one PIN. */
export function PlayerGame({ pinCode }: PlayerGameProps) {
  const { t, ensureNamespaces } = useLocale();
  const router = useRouter();
  const [store] = useState(createGameStore);
  const socket = useGameSocket({ url: SOCKET_URL, role: "player", store });
  const clock = useGameClock({ socket, store });
  const { submit, recoveryFailed, retryNow } = useSessionRecovery({
    socket,
    store,
    role: "player",
    pinCode,
    serverNow: clock.serverNow,
  });
  const snapshot = useGame(store, (state) => state.snapshot);
  const audio = useAudioEngine({ role: "player", snapshot, serverNow: clock.serverNow });
  const [record, setRecord] = useState<PlayerSessionRecord | null | undefined>(undefined);

  useEffect(() => {
    void ensureNamespaces(["player", "host", "reports", "studio", "accessibility", "validation"]);
  }, [ensureNamespaces]);

  // Credentials are read after mount (localStorage), so the first render matches the server's.
  useEffect(() => {
    setRecord(findPlayerSessionByPin(pinCode));
  }, [pinCode]);

  /** Manual retry: recover now on a live socket, otherwise reconnect (which recovers). */
  const retry = useCallback(() => {
    if (socket.connected) {
      retryNow();
      return;
    }
    store.getState().setTransport("connecting");
    socket.connect();
  }, [socket, store, retryNow]);
  const leave = useCallback(() => {
    socket.disconnect();
    router.push("/join");
  }, [socket, router]);

  if (record === undefined)
    return (
      <p role="status" aria-live="polite" className="p-4 text-small text-muted-foreground">
        {t("player.inventory.s15.loading")}
      </p>
    );

  const sessionId = snapshot?.sessionId ?? record?.sessionId ?? null;
  return (
    <>
      {/* Design §3/§8.1: the language control stays usable outside the recovery wrapper, which
          makes a stale screen inert while reconnecting or offline; switching never touches the
          socket, the accepted answer or the quiz content. */}
      <div className="flex justify-end pt-2">
        <LocalePicker />
      </div>
      <ConnectionRecovery
        role="player"
        store={store}
        sessionId={sessionId}
        recoveryFailed={recoveryFailed}
        onRetry={retry}
        onLeave={leave}
      >
        {snapshot?.role === "player" && (
          <PlayerScreen
            snapshot={snapshot}
            store={store}
            socket={socket}
            serverNow={clock.serverNow}
            submit={submit}
            onAccepted={() => audio.signal("answerAccepted")}
          />
        )}
      </ConnectionRecovery>
    </>
  );
}

/** Props of {@link PlayerScreen}. */
interface PlayerScreenProps {
  snapshot: PlayerRoomSync;
  store: StoreApi<GameState>;
  socket: GameSocket;
  serverNow: () => number;
  submit: ReturnType<typeof useSessionRecovery>["submit"];
  onAccepted: () => void;
}

/** Header plus the content of the current phase. */
function PlayerScreen({
  snapshot,
  store,
  socket,
  serverNow,
  submit,
  onAccepted,
}: PlayerScreenProps) {
  const { t, formatNumber } = useLocale();
  const drafts = useGame(store, (state) => state.drafts);
  const transport = useGame(store, (state) => state.transport.status);
  const [editing, setEditing] = useState(false);
  const self = snapshot.players.find((player) => player.id === snapshot.self.playerId);
  const phaseKey = `${snapshot.sessionId}:${snapshot.phaseVersion}`;
  const question = snapshot.question;
  const inQuestion =
    question !== null &&
    (snapshot.phase === "QUESTION_PREVIEW" ||
      snapshot.phase === "QUESTION_ANSWERING" ||
      snapshot.phase === "ANSWER_REVEAL");

  let content;
  switch (snapshot.phase) {
    case "LOBBY":
      content = (
        <section className="flex flex-col items-center gap-4 py-6 text-center">
          <AvatarIllustration
            avatar={self?.avatar}
            nickname={self?.nickname ?? ""}
            size={128}
            decorative
          />
          <h1 className="text-title font-bold break-words">
            <bdi>{self?.nickname}</bdi>
          </h1>
          <p role="status" className="text-body text-muted-foreground">
            {t("player.inventory.s15.empty")}
          </p>
          <ActionButton
            variant="secondary"
            label={t("player.avatar.title")}
            onPress={() => setEditing(true)}
          />
        </section>
      );
      break;
    case "GAME_START_COUNTDOWN":
      content = <Countdown endsAt={snapshot.timing.phaseEndsAt} serverNow={serverNow} />;
      break;
    case "QUESTION_PREVIEW":
      content = question && (
        <section className="flex flex-col gap-3 py-4">
          <p className="text-small font-semibold text-muted-foreground">
            {t(TYPE_LABEL[question.type] ?? "studio.types.singleChoice")}
            {question.pointsMultiplier === 2 && ` · ${t("studio.points.double")}`}
            {question.pointsMultiplier === 0 && ` · ${t("player.result.noPoints")}`}
          </p>
          <h1 dir="auto" className="text-title font-bold whitespace-pre-line break-words">
            {question.promptText}
          </h1>
          <p role="status" className="text-body text-muted-foreground">
            {t("host.stage.countdown")}
          </p>
        </section>
      );
      break;
    case "QUESTION_ANSWERING":
      content = question && (
        <section className="flex flex-col gap-4 py-2">
          <GameTimer
            questionStartedAt={snapshot.timing.questionStartedAt}
            inputClosesAt={snapshot.timing.inputClosesAt}
            acceptanceClosesAt={snapshot.timing.acceptanceClosesAt}
            serverNow={serverNow}
          />
          {snapshot.displayMode === "PROJECTOR" ? (
            <>
              <h1 className="sr-only">{question.promptText}</h1>
              <p className="text-small text-muted-foreground">
                {t("host.config.projectorDescription")}
              </p>
            </>
          ) : (
            <>
              <h1 dir="auto" className="text-title font-bold whitespace-pre-line break-words">
                {question.promptText}
              </h1>
              {question.media && (
                <MediaReveal
                  mode={question.media.revealMode}
                  seed={question.id}
                  startsAt={snapshot.timing.questionStartedAt ?? snapshot.timing.phaseStartedAt}
                  endsAt={snapshot.timing.inputClosesAt ?? snapshot.timing.phaseStartedAt}
                  now={serverNow}
                >
                  <MediaPreview asset={question.media} />
                </MediaReveal>
              )}
            </>
          )}
          <PlayerStageAnswerPad
            snapshot={snapshot as Extract<PlayerRoomSync, { phase: "QUESTION_ANSWERING" }>}
            draft={currentDraft({ snapshot, drafts })}
            offline={transport !== "connected"}
            serverNow={serverNow}
            setDraft={(questionId, value) => store.getState().setDraft(questionId, value)}
            submit={submit}
            onAccepted={onAccepted}
          />
        </section>
      );
      break;
    case "ANSWER_REVEAL":
      content = (
        <section className="flex flex-col gap-6 py-2">
          <PersonalResult
            result={snapshot.self.result}
            phaseKey={phaseKey}
            phaseStartedAt={snapshot.timing.phaseStartedAt}
            now={serverNow}
          />
          {question && (
            <ResultChart
              question={question}
              reveal={snapshot.reveal}
              phaseKey={phaseKey}
              phaseStartedAt={snapshot.timing.phaseStartedAt}
              now={serverNow}
            />
          )}
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
          selfPlayerId={snapshot.self.playerId}
          selfRank={snapshot.self.rank}
        />
      );
      break;
    default:
      content = (
        <section className="flex flex-col gap-6 py-2">
          <Podium
            podium={snapshot.podium}
            phase={snapshot.phase === "FINISHED" ? "FINISHED" : "PODIUM"}
            phaseKey={phaseKey}
            phaseStartedAt={snapshot.timing.phaseStartedAt}
            now={serverNow}
            role="player"
            selfPlayerId={snapshot.self.playerId}
          />
          <dl className="flex flex-col gap-1 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{t("reports.detail.totalScore")}</dt>
              <dd className="text-title font-bold tabular-nums">
                {formatNumber(snapshot.self.score)}
              </dd>
            </div>
            {snapshot.self.rank !== null && (
              <div>
                <dt className="sr-only">{t("reports.table.rank")}</dt>
                <dd className="font-semibold">
                  {t("player.result.rankPosition", { rank: snapshot.self.rank })}
                </dd>
              </div>
            )}
          </dl>
          {snapshot.phase === "FINISHED" && (
            <Link
              href="/join"
              className="inline-flex min-h-11 items-center self-start rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
            >
              {t("player.join.title")}
            </Link>
          )}
        </section>
      );
  }

  return (
    <div className="flex flex-col gap-2">
      <header className="flex flex-wrap items-center gap-3 border-b border-border py-3">
        <AvatarIllustration
          avatar={self?.avatar}
          nickname={self?.nickname ?? ""}
          size={40}
          decorative
        />
        <p className="min-w-0 flex-1 font-semibold break-words">
          <bdi>{self?.nickname}</bdi>
        </p>
        <dl className="flex gap-4 text-end">
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.table.score")}</dt>
            <dd className="font-bold tabular-nums">{formatNumber(snapshot.self.score)}</dd>
          </div>
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.table.streak")}</dt>
            <dd className="font-bold tabular-nums">{formatNumber(snapshot.self.streak)}</dd>
          </div>
        </dl>
        <StreamerAudioToggle displayMode={snapshot.displayMode} />
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
      {self && (
        <ModalSheet
          open={editing && snapshot.phase === "LOBBY"}
          title={t("player.avatar.title")}
          onCloseRequest={() => setEditing(false)}
        >
          <AvatarCustomizer
            mode="edit"
            phase={snapshot.phase}
            sessionId={snapshot.sessionId}
            pinCode={snapshot.pinCode}
            nickname={self.nickname}
            avatar={self.avatar}
            socket={socket}
            onSaved={() => setEditing(false)}
          />
        </ModalSheet>
      )}
    </div>
  );
}

/** Server-synchronized 3…2…1 before the first question. */
function Countdown({ endsAt, serverNow }: { endsAt: number | null; serverNow: () => number }) {
  const { t, formatNumber } = useLocale();
  const [, setTick] = useState(0);

  // Re-read the clock a few times per second; the number always comes from the server deadline.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 200);
    return () => clearInterval(timer);
  }, []);

  const seconds = endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
  return (
    <section className="flex flex-col items-center gap-2 py-10 text-center">
      <p role="status" className="text-title font-semibold">
        {t("host.stage.countdown")}
      </p>
      <p aria-hidden="true" className="text-display font-bold tabular-nums">
        {formatNumber(seconds)}
      </p>
    </section>
  );
}
