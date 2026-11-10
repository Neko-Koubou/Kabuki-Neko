"use client";
/**
 * F14 answer area of the player's QUESTION_ANSWERING screen (S15; Design §4.6; SA §5.2–5.3;
 * US-09/10/12/18/21; TASK-157).
 *
 * - Picks the pad for the question type:
 *   - choice pad for single choice, true/false, poll and multiple select;
 *   - text pad for TYPE_ANSWER;
 *   - puzzle pad for ORDER_PUZZLE.
 *   The options come from the player-safe snapshot only.
 * - The local draft lives in the game store keyed by session and question (`setDraft`). It
 *   survives re-renders, locale/theme switches and reconnects for the same question while
 *   editable, and a new question starts clean.
 * - Sending writes the final value into the draft and calls the recovery hook's `submit`, which
 *   sends once before `inputClosesAt` and never re-sends blindly on an unknown ACK.
 * - Status is exact:
 *   - accepted from the snapshot's `self.acceptedAnswer` or a confirmed ACK (also after a page
 *     refresh);
 *   - submitting while the ACK is pending;
 *   - rejected/closed from the server's reply;
 *   - grace ("Time's up.") from the authoritative `inputClosesAt` on the synchronized clock;
 *   - offline when the transport is not connected.
 * - Feedback (the accepted nekoPop) only follows an authoritative acceptance; the server's result
 *   comes later in the reveal.
 * States:
 * - loading: submitting;
 * - empty: nothing chosen;
 * - ideal: answering;
 * - partial: accepted and waiting, or grace;
 * - error: rejected or offline.
 */
import { useEffect, useState } from "react";
import type { Answer } from "@kabuki-neko/shared/schemas/question.schema";
import type { PlayerRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import type { SubmitOutcome } from "@/hooks/use-session-recovery";
import type { AnswerDraft } from "@/stores/game.store";
import { ChoiceAnswerPad, type ChoiceType, type PadStatus } from "./choice-answer-pad";
import { PuzzleAnswerPad } from "./puzzle-answer-pad";
import { TextAnswerPad } from "./text-answer-pad";

/** The player's snapshot while answering (question present). */
export type AnsweringSnapshot = Extract<PlayerRoomSync, { phase: "QUESTION_ANSWERING" }>;

/** Option indices of an answer value (empty for text). */
export function answerIndices(value: Answer | null | undefined): number[] {
  if (Array.isArray(value)) return [...value];
  return typeof value === "number" ? [value] : [];
}

/** Props of {@link PlayerStageAnswerPad}. */
export interface PlayerStageAnswerPadProps {
  snapshot: AnsweringSnapshot;
  /** Store draft of the current question (null when none). */
  draft: AnswerDraft | null;
  /** The transport is not connected: input is locked. */
  offline: boolean;
  /** Server-synchronized clock (epoch ms). */
  serverNow: () => number;
  /** Stores the local draft for the current question (game store `setDraft`). */
  setDraft: (questionId: string, value: Answer | null) => boolean;
  /** Sends the stored draft once (session recovery `submit`). */
  submit: () => Promise<SubmitOutcome>;
  /** Authoritative acceptance (audio feedback). */
  onAccepted?: () => void;
}

/** Chooses and wires the answer pad for the current question. */
export function PlayerStageAnswerPad({
  snapshot,
  draft,
  offline,
  serverNow,
  setDraft,
  submit,
  onAccepted,
}: PlayerStageAnswerPadProps) {
  const question = snapshot.question;
  const { inputClosesAt } = snapshot.timing;
  const [, setTick] = useState(0);
  const [rejectedFor, setRejectedFor] = useState<string | null>(null);
  const now = serverNow();

  // Re-render exactly when the input deadline passes (locks the pad, shows "Time's up.").
  useEffect(() => {
    if (inputClosesAt === null) return;
    const wait = inputClosesAt - serverNow();
    if (wait < 0) return;
    const timer = setTimeout(() => setTick((value) => value + 1), wait + 5);
    return () => clearTimeout(timer);
  }, [inputClosesAt, serverNow]);

  const mine = draft?.questionId === question.id ? draft : null;
  const accepted =
    snapshot.self.acceptedAnswer?.questionIndex === question.questionIndex
      ? snapshot.self.acceptedAnswer
      : null;
  let status: PadStatus = "idle";
  if (accepted || mine?.status === "accepted") status = "accepted";
  else if (mine?.status === "submitting") status = "submitting";
  else if (rejectedFor === question.id) status = "rejected";
  const sentValue = accepted?.answer ?? (status === "idle" ? null : (mine?.value ?? null));
  const inputOpen = inputClosesAt !== null && now < inputClosesAt;
  const grace = inputClosesAt !== null && now >= inputClosesAt && status !== "accepted";
  const editable = mine?.status === "editing" ? mine.value : null;

  /** Stores the final value and sends it once; reports the server's verdict. */
  const send = (value: Answer) => {
    if (!setDraft(question.id, value)) return;
    void submit().then((outcome) => {
      if (outcome === "accepted") onAccepted?.();
      else if (outcome === "rejected" || outcome === "closed") setRejectedFor(question.id);
    });
  };

  const lock = { status, inputOpen, grace, offline };

  if (question.type === "TYPE_ANSWER")
    return (
      <TextAnswerPad
        {...lock}
        questionId={question.id}
        submitted={typeof sentValue === "string" ? sentValue : null}
        draft={typeof editable === "string" ? editable : null}
        onDraftChange={(value) => setDraft(question.id, value === "" ? null : value)}
        onSubmit={send}
      />
    );

  if (question.type === "ORDER_PUZZLE")
    return (
      <PuzzleAnswerPad
        {...lock}
        questionId={question.id}
        items={question.options}
        submitted={Array.isArray(sentValue) ? sentValue : null}
        draft={Array.isArray(editable) ? editable : null}
        onDraftChange={(order) => setDraft(question.id, [...order])}
        onSubmit={(order) => send([...order])}
      />
    );

  return (
    <ChoiceAnswerPad
      {...lock}
      questionId={question.id}
      type={question.type as ChoiceType}
      options={question.options}
      displayMode={snapshot.displayMode}
      chosen={sentValue === null ? null : answerIndices(sentValue)}
      onSubmit={(answer) => send(answer)}
    />
  );
}
