"use client";
/**
 * Host phase controls for the running game (S16; Design §4.7; SA §5.2, §5.5; US-07/10/13/21;
 * TASK-159).
 *
 * - Distinct actions, each shown only when the server capabilities allow it:
 *   - Start (lobby);
 *   - Skip timer (answering);
 *   - Next (reveal/leaderboard);
 *   - End game (any active phase, through M09).
 * - The Next label comes from the server state, never guessed from local timing:
 *   - reveal of the last question → "Show podium";
 *   - other reveals → "Show leaderboard";
 *   - leaderboard → "Next question".
 * - Commands carry the phase version the stage sends (expectedPhaseVersion). The phase is never
 *   advanced optimistically: the screen changes only when the server's snapshot does.
 * - One command at a time: while one is pending every control is busy, so a double click emits one
 *   command. A refusal or unknown outcome is explained, and a lost host connection pauses the
 *   controls.
 * States:
 * - loading: a command is pending;
 * - empty: no actions in this phase;
 * - ideal;
 * - partial: unknown outcome;
 * - error: refusal, or connection lost.
 */
import { useEffect, useRef, useState } from "react";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, apiErrorMessageKey } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";
import type { CommandOutcome } from "./host-stage-lobby";

/** Phase commands of the running game. */
export interface HostPhaseCommands {
  start: () => Promise<CommandOutcome>;
  skip: () => Promise<CommandOutcome>;
  next: () => Promise<CommandOutcome>;
  end: () => Promise<CommandOutcome>;
}

/** Label key of Next for the current server state. */
export function nextLabelKey(snapshot: Pick<HostRoomSync, "phase" | "question">): string {
  if (snapshot.phase === "LEADERBOARD") return "host.controls.nextQuestion";
  const question = snapshot.question;
  const last = question !== null && question.questionIndex >= question.totalQuestions - 1;
  return last ? "host.controls.podium" : "host.controls.leaderboard";
}

/** Props of {@link HostPhaseControls}. */
export interface HostPhaseControlsProps {
  snapshot: HostRoomSync;
  /** The host's connection is live. */
  connected: boolean;
  commands: HostPhaseCommands;
}

/** The host's Start / Skip / Next / End controls. */
export function HostPhaseControls({ snapshot, connected, commands }: HostPhaseControlsProps) {
  const { t, ensureNamespaces } = useLocale();
  const [pending, setPending] = useState<"start" | "skip" | "next" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    void ensureNamespaces(["host", "validation"]);
  }, [ensureNamespaces]);

  // A new phase clears an old refusal.
  useEffect(() => setProblem(null), [snapshot.phaseVersion]);

  const end = useConfirmAction({
    run: async () => {
      const outcome = await commands.end();
      if (outcome.status === "unknown") throw new ApiError(0, "NETWORK_ERROR", {}, [], null, true);
      if (outcome.status === "error") throw new ApiError(409, outcome.errorCode);
    },
  });

  /** Sends one command; extra presses while it is pending do nothing. */
  const send = async (name: "start" | "skip" | "next") => {
    if (running.current || !connected) return;
    running.current = true;
    setPending(name);
    setProblem(null);
    try {
      const outcome = await commands[name]();
      if (outcome.status === "error") setProblem(t(apiErrorMessageKey(outcome.errorCode)));
      if (outcome.status === "unknown") setProblem(t("host.inventory.f13.partial"));
    } finally {
      running.current = false;
      setPending(null);
    }
  };

  const caps = snapshot.capabilities;
  const busy = pending !== null;
  const off = !connected;
  const answering = snapshot.phase === "QUESTION_ANSWERING";
  const nextPhase = snapshot.phase === "ANSWER_REVEAL" || snapshot.phase === "LEADERBOARD";

  return (
    <div className="flex flex-col gap-2">
      {off && <StatusNotice tone="error" message={t("host.controls.controlsLocked")} />}
      {problem && (
        <StatusNotice tone="error" message={problem} onDismiss={() => setProblem(null)} />
      )}
      <div
        className="flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label={t("host.inventory.f13.ideal")}
      >
        {snapshot.phase === "LOBBY" && caps.canStart && (
          <ActionButton
            label={t("host.controls.start")}
            pending={pending === "start"}
            disabled={off || busy}
            onPress={() => void send("start")}
          />
        )}
        {answering && caps.canSkip && (
          <ActionButton
            variant="secondary"
            label={t("host.controls.skipTimer")}
            pending={pending === "skip"}
            disabled={off || busy}
            onPress={() => void send("skip")}
          />
        )}
        {nextPhase && caps.canNext && (
          <ActionButton
            label={t(nextLabelKey(snapshot))}
            pending={pending === "next"}
            disabled={off || busy}
            onPress={() => void send("next")}
          />
        )}
        {caps.canEnd && (
          <ActionButton
            variant="danger"
            label={t("host.controls.endGame")}
            disabled={off || busy}
            onPress={end.request}
          />
        )}
      </div>
      <ConfirmDialog
        controller={end}
        impact={t("common.confirm.endGame")}
        targetName={snapshot.quizTitle}
        confirmLabel={t("host.controls.confirmEnd")}
      />
    </div>
  );
}
