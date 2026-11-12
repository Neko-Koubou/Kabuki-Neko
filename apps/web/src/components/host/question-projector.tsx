"use client";
/**
 * Host question stage for GAME_START_COUNTDOWN, QUESTION_PREVIEW and QUESTION_ANSWERING
 * (S16; Design §4.7, §7.2–7.3; SA §5.3, §5.5; US-07/10/13/18/21; TASK-159).
 *
 * - Countdown: the server-synced 3, 2, 1 before the first question.
 * - Preview: "Question n of N", type, points multiplier and the full prompt. No options or keys:
 *   the preview payload has none.
 * - Answering:
 *   - the authoritative timer (host size), "n of m answered" and the full prompt;
 *   - the public media with the clock-driven reveal;
 *   - every option with its fixed letter, shape and color.
 *   Nothing marks a correct answer, because keys only arrive with the reveal.
 * - Long content is never cut: a long prompt sits in a labelled, keyboard-scrollable region with an
 *   "Expand" toggle, and options wrap. The layout is a 16:9-friendly stage on desktop
 *   (1280/1920) and a vertical flow on phones.
 * - A media failure shows its own notice inside the media box and never blocks the host controls,
 *   which live outside this component (HostPhaseControls).
 * States:
 * - loading: no snapshot;
 * - empty: untimed phase;
 * - ideal;
 * - partial: media failed or long content;
 * - error: stale clock (shown by the timer).
 */
import { useEffect, useId, useState } from "react";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import type { HostRoomSync } from "@kabuki-neko/shared/schemas/game.schema";
import { AnswerShape, COLOR_CLASS, SHAPE_SYMBOL } from "@/components/player/choice-answer-pad";
import { GameTimer } from "@/components/player/game-timer";
import { TYPE_KEY } from "@/components/studio/slide-navigator";
import { ActionButton } from "@/components/ui/action-button";
import { MediaPreview } from "@/components/ui/media-preview";
import { MediaReveal } from "@/components/ui/media-reveal";
import { useLocale } from "@/providers/locale-provider";

/** Prompts longer than this get the scroll region and Expand toggle. */
export const LONG_PROMPT = 160;

/** Props of {@link QuestionProjector}. */
export interface QuestionProjectorProps {
  /** Host snapshot in countdown, preview or answering (null while syncing). */
  snapshot: HostRoomSync | null;
  /** Server-synchronized clock (epoch ms). */
  serverNow: () => number;
}

/** Server-synced countdown number. */
function CountdownNumber({
  endsAt,
  serverNow,
}: {
  endsAt: number | null;
  serverNow: () => number;
}) {
  const { formatNumber } = useLocale();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 200);
    return () => clearInterval(timer);
  }, []);
  const seconds = endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
  return (
    <p aria-hidden="true" className="text-[96px] leading-none font-bold tabular-nums">
      {formatNumber(seconds)}
    </p>
  );
}

/** Host stage for countdown, preview and answering. */
export function QuestionProjector({ snapshot, serverNow }: QuestionProjectorProps) {
  const { t, ensureNamespaces } = useLocale();
  const promptId = useId();
  const [expanded, setExpanded] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);

  useEffect(() => {
    void ensureNamespaces(["host", "studio", "player", "accessibility", "media"]);
  }, [ensureNamespaces]);

  const questionId = snapshot?.question?.id ?? null;
  // A new question starts collapsed and with its media status reset.
  useEffect(() => {
    setExpanded(false);
    setMediaFailed(false);
  }, [questionId]);

  if (!snapshot)
    return (
      <p role="status" className="p-6 text-body text-muted-foreground">
        {t("host.inventory.s16.loading")}
      </p>
    );

  if (snapshot.phase === "GAME_START_COUNTDOWN")
    return (
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <h1 className="text-title font-bold break-words">{snapshot.quizTitle}</h1>
        <p role="status" className="text-title-sm">
          {t("host.stage.countdown")}
        </p>
        <CountdownNumber endsAt={snapshot.timing.phaseEndsAt} serverNow={serverNow} />
      </section>
    );

  const question = snapshot.question;
  if (
    !question ||
    (snapshot.phase !== "QUESTION_PREVIEW" && snapshot.phase !== "QUESTION_ANSWERING")
  )
    return null;

  const answering = snapshot.phase === "QUESTION_ANSWERING";
  const long = question.promptText.length > LONG_PROMPT;

  const heading = (
    <h1
      id={promptId}
      dir="auto"
      className={`font-bold whitespace-pre-line break-words ${answering ? "text-title" : "text-[clamp(1.75rem,3vw,3rem)] leading-tight"}`}
    >
      {question.promptText}
    </h1>
  );
  const prompt = (
    <div className="flex min-w-0 flex-col gap-2">
      {long ? (
        <div
          role="region"
          aria-labelledby={promptId}
          tabIndex={0}
          className={expanded ? "" : "max-h-40 overflow-y-auto rounded-md border border-border p-3"}
        >
          {heading}
        </div>
      ) : (
        heading
      )}
      {long && (
        <ActionButton
          variant="ghost"
          label={expanded ? t("common.actions.close") : t("common.actions.open")}
          aria-expanded={expanded}
          aria-controls={promptId}
          onPress={() => setExpanded((value) => !value)}
          className="self-start"
        />
      )}
    </div>
  );

  return (
    <section className="flex flex-col gap-5 p-4 lg:p-8" data-phase={snapshot.phase}>
      <div className="flex flex-wrap items-center justify-between gap-3 text-small text-muted-foreground">
        <span>
          {t("host.stage.questionProgress", {
            index: question.questionIndex + 1,
            total: question.totalQuestions,
          })}
          {` · ${t(TYPE_KEY[question.type])}`}
          {question.pointsMultiplier === 2 && ` · ${t("studio.points.double")}`}
          {question.pointsMultiplier === 0 && ` · ${t("studio.points.none")}`}
        </span>
        {answering && (
          <span
            role="status"
            aria-live="polite"
            className="text-label font-semibold text-foreground tabular-nums"
          >
            {t("host.stage.answerCount", {
              answered: snapshot.answeredCount,
              total: snapshot.eligibleCount,
            })}
          </span>
        )}
      </div>
      {!answering ? (
        <>
          {prompt}
          <p role="status" className="text-title-sm text-muted-foreground">
            {t("host.stage.preview")}
          </p>
        </>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
            <GameTimer
              size="host"
              questionStartedAt={snapshot.timing.questionStartedAt}
              inputClosesAt={snapshot.timing.inputClosesAt}
              acceptanceClosesAt={snapshot.timing.acceptanceClosesAt}
              serverNow={serverNow}
            />
            {prompt}
          </div>
          {question.media && (
            <div className="mx-auto w-full max-w-3xl">
              {mediaFailed && (
                <p role="status" className="mb-2 text-small text-warning">
                  {t("media.player.unavailable")}
                </p>
              )}
              <MediaReveal
                mode={question.media.revealMode}
                seed={question.id}
                startsAt={snapshot.timing.questionStartedAt ?? snapshot.timing.phaseStartedAt}
                endsAt={snapshot.timing.inputClosesAt ?? snapshot.timing.phaseStartedAt}
                now={serverNow}
              >
                <MediaPreview asset={question.media} onError={() => setMediaFailed(true)} />
              </MediaReveal>
            </div>
          )}
          {question.options.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label={t("host.stage.answering")}>
              {question.options.map((option) => {
                const geometry = ANSWER_GEOMETRY[option.index] ?? ANSWER_GEOMETRY[0];
                return (
                  <li
                    key={option.id}
                    data-option-index={option.index}
                    className={`flex min-h-20 items-center gap-3 rounded-md p-4 text-title-sm font-semibold ${COLOR_CLASS[option.index] ?? COLOR_CLASS[0]}`}
                  >
                    <AnswerShape index={option.index} className="size-10 shrink-0" />
                    <span aria-hidden="true" className="text-title font-bold">
                      {geometry.label}
                    </span>
                    <span className="sr-only">
                      {t("accessibility.game.optionLabel", {
                        label: geometry.label,
                        shape: SHAPE_SYMBOL[geometry.shape],
                        text: option.text,
                      })}
                    </span>
                    <span
                      aria-hidden="true"
                      dir="auto"
                      className="min-w-0 break-words [overflow-wrap:anywhere]"
                    >
                      {option.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
