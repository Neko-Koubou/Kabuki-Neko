"use client";
/**
 * Question properties and media alternatives panel of the quiz studio (S07 properties column;
 * Design §4.3, §7.2; SA §3.1, §7.1; US-04/06/18; TASK-145).
 *
 * - Time limit uses exactly the allowed values (5, 10, 20, 30, 60, 90, 120, 240 s).
 * - Points: none, standard or double (0/1/2). Polls are fixed at 0 with the reason.
 * - Media:
 *   - the current attachment is shown: an uploaded file (kind and name from the library) or a
 *     YouTube video;
 *   - an attachment the creator can't resolve is shown as missing, and its ID is kept unchanged;
 *   - "Choose media" opens M05; "Remove media" clears the attachment, the clip range, the reveal
 *     effect and the question's text alternatives together.
 * - Video clip range in whole seconds for uploaded videos and YouTube. An end at or before the
 *   start is an inline error.
 * - Image reveal: Show immediately, 3 × 3 grid, 5 × 5 grid or Unblur gradually. Effects need an
 *   image. Without one, the effects are unavailable, and an incompatible saved effect is flagged
 *   with a one-click "Show immediately" fix.
 * - Text alternatives in the question's own context (independent of the library copy):
 *   - alt text and visual description for images;
 *   - a transcript for audio;
 *   - transcript, visual description and timed captions for video.
 *   Nothing is auto-filled and the file name is never used as alt text. Missing alternatives are
 *   listed as warnings that focus their field.
 * States:
 * - loading: no question;
 * - empty: no media, with Choose media;
 * - ideal: valid properties;
 * - partial: missing alternatives or an incompatible effect;
 * - error: invalid clip range.
 */
import { useEffect, useId } from "react";
import {
  POINTS_MULTIPLIERS,
  REVEAL_MODES,
  TIME_LIMITS_SEC,
} from "@kabuki-neko/shared/constants/game";
import { ACCESSIBILITY_LIMITS, QUIZ_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { emptyAccessibility, type Accessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type { Question } from "@kabuki-neko/shared/schemas/question.schema";
import {
  mediaKind,
  missingAlternatives,
  type MediaKind,
} from "@/components/media/asset-library-picker-upload";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { FormField } from "@/components/ui/form-field";
import { useLocale } from "@/providers/locale-provider";

/** Reveal mode label keys. */
const REVEAL_KEY: Record<(typeof REVEAL_MODES)[number], string> = {
  NONE: "studio.reveal.none",
  GRID_3X3: "studio.reveal.grid3x3",
  GRID_5X5: "studio.reveal.grid5x5",
  BLUR: "studio.reveal.blur",
};

/** Points label keys. */
const POINTS_KEY: Record<(typeof POINTS_MULTIPLIERS)[number], string> = {
  0: "studio.points.none",
  1: "studio.points.standard",
  2: "studio.points.double",
};

/** Library record of the attached upload, as far as the creator can resolve it. */
export interface AttachedMedia {
  mimeType: string;
  originalName: string;
}

/** Kind of the question's attachment (null without media; "missing" when unresolvable). */
export function attachmentKind(
  question: Pick<Question, "mediaId" | "externalVideoUrl">,
  media: AttachedMedia | null | undefined,
): MediaKind | "missing" | null {
  if (question.externalVideoUrl !== null) return "video";
  if (question.mediaId === null) return null;
  return media ? (mediaKind(media.mimeType) ?? "missing") : "missing";
}

/** Clip range problem: end at or before the start. */
export function rangeInvalid(question: Pick<Question, "videoStartSec" | "videoEndSec">): boolean {
  return question.videoEndSec !== null && question.videoEndSec <= question.videoStartSec;
}

/** A question without its attachment (range, effect and alternatives reset together). */
export function clearAttachment(question: Question): Question {
  return {
    ...question,
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    accessibility: emptyAccessibility(),
  };
}

/** Parses whole seconds within the video limit (null when empty, NaN when invalid). */
function seconds(value: string): number {
  const number = Number(value);
  return value.trim() !== "" &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= QUIZ_LIMITS.videoSec
    ? number
    : Number.NaN;
}

/** Props of {@link QuestionProperties}. */
export interface QuestionPropertiesProps {
  question: Question | null;
  /** Applies an edit to the question (studio store `updateQuestion`). */
  onChange: (update: (question: Question) => Question) => void;
  /** The library record of `question.mediaId` (null when unresolved or none). */
  media?: AttachedMedia | null;
  /** Opens the M05 media picker for this question. */
  onChooseMedia?: () => void;
  /** Field to focus (e.g. `accessibility.altText`, `videoEndSec`, `mediaRevealMode`). */
  focusPath?: string | null;
}

/** The studio's properties column for one question. */
export function QuestionProperties({
  question,
  onChange,
  media = null,
  onChooseMedia,
  focusPath,
}: QuestionPropertiesProps) {
  const { t, ensureNamespaces } = useLocale();
  const base = useId();
  const ids = {
    time: `${base}-time`,
    reveal: `${base}-reveal`,
    start: `${base}-start`,
    end: `${base}-end`,
    alt: `${base}-alt`,
    transcript: `${base}-transcript`,
    description: `${base}-description`,
    captions: `${base}-captions`,
  };

  useEffect(() => {
    void ensureNamespaces(["studio", "media", "validation"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    if (!focusPath) return;
    const target: Record<string, string> = {
      timeLimitSec: ids.time,
      mediaRevealMode: ids.reveal,
      videoStartSec: ids.start,
      videoEndSec: ids.end,
      "accessibility.altText": ids.alt,
      "accessibility.transcript": ids.transcript,
      "accessibility.visualDescription": ids.description,
      "accessibility.captions": ids.captions,
    };
    const id = target[focusPath];
    if (id) document.getElementById(id)?.focus();
    // ids derive from the stable `base`.
  }, [focusPath, base]);

  if (!question)
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("studio.inventory.f05.loading")}
      </p>
    );

  const kind = attachmentKind(question, media);
  const isVideo = kind === "video";
  const isImage = kind === "image";
  const incompatibleEffect = question.mediaRevealMode !== "NONE" && !isImage;
  const badRange = isVideo && rangeInvalid(question);
  const a11y = question.accessibility;
  const missing =
    kind === null || kind === "missing"
      ? []
      : missingAlternatives({
          mimeType: kind === "image" ? "image/webp" : kind === "audio" ? "audio/mpeg" : "video/mp4",
          accessibility: a11y,
        });
  const missingTarget: Record<string, string> = {
    "media.accessibility.missingAlt": ids.alt,
    "media.accessibility.missingTranscript": ids.transcript,
    "media.accessibility.missingCaptions": ids.captions,
    "media.accessibility.missingVisualDescription": ids.description,
  };

  /** Updates the question's own text alternatives. */
  const setA11y = (patch: Partial<Accessibility>) =>
    onChange((current) => ({ ...current, accessibility: { ...current.accessibility, ...patch } }));

  /** Updates one caption cue (seconds typed, ms stored). */
  const setCue = (
    index: number,
    patch: Partial<{ startMs: number; endMs: number; text: string }>,
  ) =>
    setA11y({
      captions: a11y.captions.map((cue, position) =>
        position === index ? { ...cue, ...patch } : cue,
      ),
    });

  const isPoll = question.type === "POLL";

  return (
    <section aria-labelledby={`${base}-title`} className="flex flex-col gap-4">
      <h2 id={`${base}-title`} className="text-label font-semibold">
        {t("studio.editor.properties")}
      </h2>
      <FormField
        kind="select"
        id={ids.time}
        label={t("studio.question.timeLimit")}
        value={String(question.timeLimitSec)}
        options={TIME_LIMITS_SEC.map((value) => ({
          value: String(value),
          label: t("studio.question.duration", { seconds: value }),
        }))}
        onChange={(value) => {
          const next = TIME_LIMITS_SEC.find((limit) => String(limit) === value);
          if (next !== undefined) onChange((current) => ({ ...current, timeLimitSec: next }));
        }}
      />
      <ChoiceGroup
        mode="radio"
        name={`${base}-points`}
        label={t("studio.question.pointsMultiplier")}
        items={POINTS_MULTIPLIERS.map((value) => ({
          id: String(value),
          label: t(POINTS_KEY[value]),
          disabled: isPoll && value !== 0,
          ...(isPoll && value !== 0 ? { disabledReason: t("studio.points.pollNoPoints") } : {}),
        }))}
        selected={String(question.pointsMultiplier)}
        onSelect={(id) => {
          const next = POINTS_MULTIPLIERS.find((value) => String(value) === id);
          if (next !== undefined && !(isPoll && next !== 0))
            onChange((current) => ({ ...current, pointsMultiplier: next }));
        }}
        {...(isPoll ? { help: t("studio.points.pollNoPoints") } : {})}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-label font-semibold">{t("media.inventory.m05.title")}</legend>
        {kind === null ? (
          <p className="text-small text-muted-foreground">{t("media.library.empty")}</p>
        ) : (
          <p className="text-small break-words [overflow-wrap:anywhere]">
            {question.externalVideoUrl !== null
              ? `${t("media.source.youtube")}: ${question.externalVideoUrl}`
              : kind === "missing"
                ? t("media.library.missing")
                : `${t(kind === "image" ? "media.library.images" : kind === "audio" ? "media.library.audio" : "media.library.video")}: ${media?.originalName ?? ""}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {onChooseMedia && (
            <ActionButton
              variant="secondary"
              label={t("media.inventory.m05.title")}
              onPress={onChooseMedia}
            />
          )}
          {kind !== null && (
            <ActionButton
              variant="ghost"
              label={t("media.source.clearAttachment")}
              onPress={() => onChange(clearAttachment)}
            />
          )}
        </div>
        {isVideo && (
          <div className="grid grid-cols-2 gap-3">
            <FormField
              kind="number"
              id={ids.start}
              label={t("media.source.startSeconds")}
              value={String(question.videoStartSec)}
              min={0}
              step={1}
              onChange={(value) => {
                const next = seconds(value);
                if (!Number.isNaN(next))
                  onChange((current) => ({ ...current, videoStartSec: next }));
              }}
            />
            <FormField
              kind="number"
              id={ids.end}
              label={t("media.source.endSeconds")}
              value={question.videoEndSec === null ? "" : String(question.videoEndSec)}
              min={0}
              step={1}
              onChange={(value) => {
                const next = value.trim() === "" ? null : seconds(value);
                if (next === null || !Number.isNaN(next))
                  onChange((current) => ({ ...current, videoEndSec: next }));
              }}
              error={badRange ? t("media.source.invalidRange") : undefined}
            />
          </div>
        )}
      </fieldset>
      <FormField
        kind="select"
        id={ids.reveal}
        label={t("studio.reveal.label")}
        value={question.mediaRevealMode}
        options={REVEAL_MODES.map((mode) => ({
          value: mode,
          label: t(REVEAL_KEY[mode]),
          disabled: mode !== "NONE" && !isImage,
        }))}
        help={isImage || incompatibleEffect ? undefined : t("studio.reveal.imageRequired")}
        error={incompatibleEffect ? t("studio.reveal.imageRequired") : undefined}
        onChange={(value) => {
          const next = REVEAL_MODES.find((mode) => mode === value);
          if (next && (next === "NONE" || isImage))
            onChange((current) => ({ ...current, mediaRevealMode: next }));
        }}
      />
      {incompatibleEffect && (
        <ActionButton
          variant="secondary"
          label={t("studio.reveal.none")}
          onPress={() => onChange((current) => ({ ...current, mediaRevealMode: "NONE" }))}
          className="self-start"
        />
      )}
      {kind !== null && kind !== "missing" && (
        <div className="flex flex-col gap-3">
          {missing.length > 0 && (
            <ul role="status" className="flex flex-col gap-1 text-small text-warning">
              {missing.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    className="text-start underline underline-offset-2"
                    onClick={() => {
                      const id = missingTarget[key];
                      if (id) document.getElementById(id)?.focus();
                    }}
                  >
                    {t(key)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {isImage && (
            <FormField
              id={ids.alt}
              label={t("media.accessibility.altText")}
              limit={ACCESSIBILITY_LIMITS.altText}
              value={a11y.altText ?? ""}
              onChange={(value) => setA11y({ altText: value.trim() === "" ? null : value })}
            />
          )}
          {!isImage && (
            <FormField
              kind="textarea"
              id={ids.transcript}
              label={t("media.accessibility.transcript")}
              rows={4}
              limit={ACCESSIBILITY_LIMITS.transcript}
              value={a11y.transcript ?? ""}
              onChange={(value) => setA11y({ transcript: value.trim() === "" ? null : value })}
            />
          )}
          {kind !== "audio" && (
            <FormField
              kind="textarea"
              id={ids.description}
              label={t("media.accessibility.visualDescription")}
              rows={3}
              limit={ACCESSIBILITY_LIMITS.visualDescription}
              value={a11y.visualDescription ?? ""}
              onChange={(value) =>
                setA11y({ visualDescription: value.trim() === "" ? null : value })
              }
            />
          )}
          {isVideo && (
            <div id={ids.captions} tabIndex={-1} className="flex flex-col gap-3">
              <p className="text-label font-semibold">{t("media.accessibility.captions")}</p>
              {a11y.captions.map((cue, index) => (
                <div
                  key={index}
                  role="group"
                  aria-label={t("media.accessibility.cuePosition", { position: index + 1 })}
                  className="flex flex-col gap-2 rounded-md border border-border p-3"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <FormField
                      kind="number"
                      label={t("media.accessibility.startTime")}
                      value={String(cue.startMs / 1000)}
                      min={0}
                      step={0.1}
                      onChange={(value) => {
                        const ms = Math.round(Number(value) * 1000);
                        if (Number.isFinite(ms) && ms >= 0) setCue(index, { startMs: ms });
                      }}
                    />
                    <FormField
                      kind="number"
                      label={t("media.accessibility.endTime")}
                      value={String(cue.endMs / 1000)}
                      min={0}
                      step={0.1}
                      onChange={(value) => {
                        const ms = Math.round(Number(value) * 1000);
                        if (Number.isFinite(ms) && ms >= 0) setCue(index, { endMs: ms });
                      }}
                      error={cue.endMs <= cue.startMs ? t("media.source.invalidRange") : undefined}
                    />
                  </div>
                  <FormField
                    kind="textarea"
                    label={t("media.accessibility.cueText")}
                    rows={2}
                    limit={ACCESSIBILITY_LIMITS.captionText}
                    value={cue.text}
                    onChange={(text) => setCue(index, { text })}
                  />
                  <ActionButton
                    variant="ghost"
                    label={t("media.accessibility.removeCue")}
                    accessibleName={`${t("media.accessibility.removeCue")} ${index + 1}`}
                    onPress={() =>
                      setA11y({
                        captions: a11y.captions.filter((_, position) => position !== index),
                      })
                    }
                    className="self-start"
                  />
                </div>
              ))}
              <ActionButton
                variant="secondary"
                label={t("media.accessibility.addCue")}
                disabled={a11y.captions.length >= ACCESSIBILITY_LIMITS.captionCount}
                onPress={() => {
                  const start = a11y.captions.at(-1)?.endMs ?? 0;
                  setA11y({
                    captions: [...a11y.captions, { startMs: start, endMs: start + 2000, text: "" }],
                  });
                }}
                className="self-start"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
