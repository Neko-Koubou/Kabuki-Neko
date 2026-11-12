"use client";
/**
 * M05 media picker for quiz covers and question media (Design §4.9 M05, §7.2; SA §3.1, §7.1;
 * US-04/06/18; TASK-142).
 *
 * - Tabs:
 *   - Media library (the creator's READY assets, with upload);
 *   - Upload a file (only the upload area);
 *   - YouTube video (questions only).
 *   Covers accept images only (the list and uploads are locked to images and stored in
 *   `covers`); a cover can never be a YouTube video.
 * - Picking previews the selection first ("Preview your selection, then choose Use media."), above
 *   the list and focused, and lists missing text alternatives as warnings. A new upload becomes selectable only after its
 *   201 READY answer; a file still uploading or processing can't be used.
 * - Question attachments are exclusive: an uploaded file or a YouTube video, never both.
 *   - Videos (library or YouTube) take a clip range in whole seconds; the end must be after the
 *     start, checked with the shared attachment schema.
 *   - YouTube links are accepted only in a recognized form and normalized to the canonical
 *     watch URL; anything else ("malformed") is refused with no request or embed.
 * - The library item's accessibility data is copied into the question context (a deep copy), so
 *   later library edits don't change the question and question edits don't change the library.
 * - Closing the picker never aborts an upload in flight; `onUploadSettled` still reports the READY
 *   asset, so the parent can reconcile it.
 * States:
 * - loading: library loading or upload in flight;
 * - empty: no media of this type;
 * - ideal: preview + Use media;
 * - partial: missing alternatives, wrong type/size, invalid range or link;
 * - error: source failed to load.
 */
import { useEffect, useRef, useState } from "react";
import { QUIZ_LIMITS } from "@kabuki-neko/shared/constants/limits";
import {
  canonicalYouTubeUrl,
  emptyAccessibility,
  mediaAttachmentSchema,
  type Accessibility,
  type Media,
} from "@kabuki-neko/shared/schemas/media.schema";
import {
  AssetLibrary,
  assetOf,
  mediaKind,
  missingAlternatives,
  type MediaQuery,
  type UploadFn,
  type UploadLimits,
} from "@/components/media/asset-library-picker-upload";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { FormField } from "@/components/ui/form-field";
import { MediaPreview, type MediaAsset } from "@/components/ui/media-preview";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { useLocale } from "@/providers/locale-provider";

/** Media chosen as a quiz cover. */
export interface CoverSelection {
  id: string;
  url: string | null;
}

/** Media chosen for a question: the attachment fields plus a copied accessibility snapshot. */
export interface QuestionMediaSelection {
  mediaId: string | null;
  externalVideoUrl: string | null;
  videoStartSec: number;
  videoEndSec: number | null;
  /** Deep copy of the library's text alternatives (question context, edited independently). */
  accessibility: Accessibility;
  /** Playable preview of the selection. */
  preview: MediaAsset;
  /** The chosen library record (null for YouTube). */
  media: Media | null;
}

/** Picker tab. */
type Tab = "library" | "upload" | "youtube";

/** Parses a whole number of seconds; null when empty, NaN when invalid. */
export function parseSeconds(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= QUIZ_LIMITS.videoSec
    ? number
    : Number.NaN;
}

/**
 * Validates a question attachment with the shared schema: exclusive source, clip range for video
 * only and a canonical YouTube URL. Returns the parsed attachment or the problem's message key.
 */
export function checkAttachment(input: {
  mediaId: string | null;
  youtubeUrl: string | null;
  isVideo: boolean;
  start: string;
  end: string;
}):
  | { ok: true; value: Omit<QuestionMediaSelection, "accessibility" | "preview" | "media"> }
  | { ok: false; problem: string } {
  let externalVideoUrl: string | null = null;
  if (input.youtubeUrl !== null) {
    externalVideoUrl = canonicalYouTubeUrl(input.youtubeUrl.trim());
    if (externalVideoUrl === null) return { ok: false, problem: "validation.errors.invalidFormat" };
  }
  const start = input.isVideo ? (parseSeconds(input.start) ?? 0) : 0;
  const end = input.isVideo ? parseSeconds(input.end) : null;
  if (Number.isNaN(start) || (end !== null && Number.isNaN(end)))
    return { ok: false, problem: "media.source.invalidRange" };
  const parsed = mediaAttachmentSchema.safeParse({
    mediaId: input.mediaId,
    externalVideoUrl,
    videoStartSec: start,
    videoEndSec: end,
  });
  if (!parsed.success) {
    const exclusive = parsed.error.issues.some((issue) => issue.message === "INVALID_REFERENCE");
    return {
      ok: false,
      problem: exclusive ? "media.source.exclusiveAttachment" : "media.source.invalidRange",
    };
  }
  return { ok: true, value: parsed.data };
}

/** Props of {@link MediaPicker}. */
export interface MediaPickerProps {
  open: boolean;
  context: "cover" | "question";
  onClose: () => void;
  /** Cover: the chosen READY image. */
  onSelectCover?: (cover: CoverSelection) => void;
  /** Question: the chosen attachment with its copied accessibility data. */
  onSelectQuestion?: (selection: QuestionMediaSelection) => void;
  /** An upload finished (READY), also after the picker was closed. */
  onUploadSettled?: (media: Media) => void;
  /** Upload implementation (tests). */
  upload?: UploadFn;
  /** Size limits (tests). */
  limits?: UploadLimits | null;
}

/** M05: choose a cover or question media. */
export function MediaPicker({
  open,
  context,
  onClose,
  onSelectCover,
  onSelectQuestion,
  onUploadSettled,
  upload,
  limits,
}: MediaPickerProps) {
  const { t, ensureNamespaces } = useLocale();
  const cover = context === "cover";
  const [tab, setTab] = useState<Tab>("library");
  const [query, setQuery] = useState<MediaQuery>({
    type: cover ? "image" : null,
    search: "",
    page: 1,
  });
  const [selected, setSelected] = useState<Media | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const previewRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void ensureNamespaces(["media", "validation"]);
  }, [ensureNamespaces]);

  // Each opening starts fresh.
  useEffect(() => {
    if (!open) return;
    setTab("library");
    setSelected(null);
    setYoutubeUrl("");
    setStart("0");
    setEnd("");
    setProblem(null);
  }, [open]);

  const isVideo =
    tab === "youtube" || (selected !== null && mediaKind(selected.mimeType) === "video");
  const canUse = tab === "youtube" ? youtubeUrl.trim() !== "" : selected !== null;

  // A new selection moves focus to its preview (it sits above the list, so it scrolls into view).
  useEffect(() => {
    if (selected) previewRef.current?.focus();
  }, [selected]);

  /** Selects a READY item (resets the clip range); covers accept images only. */
  const choose = (media: Media) => {
    if (cover && mediaKind(media.mimeType) !== "image") return;
    setSelected(media);
    setStart("0");
    setEnd("");
    setProblem(null);
  };

  /** Hands the selection to the parent after validation. */
  const use = () => {
    if (cover) {
      if (!selected || mediaKind(selected.mimeType) !== "image") return;
      onSelectCover?.({ id: selected.id, url: selected.publicUrl });
      onClose();
      return;
    }
    const fromYoutube = tab === "youtube";
    const checked = checkAttachment({
      mediaId: fromYoutube ? null : (selected?.id ?? null),
      youtubeUrl: fromYoutube ? youtubeUrl : null,
      isVideo,
      start,
      end,
    });
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    const { value } = checked;
    const accessibility =
      fromYoutube || !selected ? emptyAccessibility() : structuredClone(selected.accessibility);
    const preview: MediaAsset =
      fromYoutube || !selected
        ? {
            kind: "youtube",
            url: value.externalVideoUrl ?? "",
            width: null,
            height: null,
            startSec: value.videoStartSec,
            endSec: value.videoEndSec,
            accessibility,
          }
        : {
            ...assetOf(selected),
            startSec: value.videoStartSec,
            endSec: value.videoEndSec,
            accessibility,
          };
    onSelectQuestion?.({
      ...value,
      accessibility,
      preview,
      media: fromYoutube ? null : selected,
    });
    onClose();
  };

  const tabs = [
    { id: "library", label: t("media.source.library") },
    { id: "upload", label: t("media.source.upload") },
    ...(cover ? [] : [{ id: "youtube", label: t("media.source.youtube") }]),
  ];

  const range = isVideo && !cover && (
    <div className="grid grid-cols-2 gap-3">
      <FormField
        kind="number"
        label={t("media.source.startSeconds")}
        value={start}
        min={0}
        step={1}
        onChange={(value) => {
          setStart(value);
          setProblem(null);
        }}
      />
      <FormField
        kind="number"
        label={t("media.source.endSeconds")}
        value={end}
        min={0}
        step={1}
        onChange={(value) => {
          setEnd(value);
          setProblem(null);
        }}
        error={problem === "media.source.invalidRange" ? t(problem) : undefined}
      />
    </div>
  );

  return (
    <ModalSheet
      open={open}
      size="media"
      fullHeight
      title={t("media.inventory.m05.title")}
      onCloseRequest={onClose}
      footer={
        <>
          <ActionButton variant="secondary" label={t("common.actions.cancel")} onPress={onClose} />
          <ActionButton
            label={t("media.library.useMedia")}
            disabled={!canUse}
            {...(!canUse ? { disabledReason: t("media.inventory.m05.ideal") } : {})}
            onPress={use}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChoiceGroup
          mode="tabs"
          label={t("media.inventory.m05.title")}
          hideLabel
          items={tabs}
          selected={tab}
          onSelect={(id) => {
            setTab(id === "upload" || id === "youtube" ? id : "library");
            setProblem(null);
          }}
        />
        {tab !== "youtube" && selected && (
          <section
            ref={previewRef}
            tabIndex={-1}
            aria-label={t("media.inventory.m05.ideal")}
            className="flex flex-col gap-3 rounded-md border border-border p-3"
          >
            <p className="text-small text-muted-foreground">{t("media.inventory.m05.ideal")}</p>
            <p className="text-label font-semibold break-words [overflow-wrap:anywhere]">
              {selected.originalName}
            </p>
            <MediaPreview asset={assetOf(selected)} />
            {missingAlternatives(selected).length > 0 && (
              <ul className="text-small text-warning">
                {missingAlternatives(selected).map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            )}
            {range}
          </section>
        )}
        {tab === "youtube" ? (
          <div className="flex flex-col gap-3">
            <p className="text-small text-muted-foreground">
              {t("media.source.exclusiveAttachment")}
            </p>
            <FormField
              label={t("media.source.url")}
              value={youtubeUrl}
              inputMode="url"
              autoComplete="off"
              placeholder="https://www.youtube.com/watch?v="
              onChange={(value) => {
                setYoutubeUrl(value);
                setProblem(null);
              }}
              error={
                problem === "validation.errors.invalidFormat" ||
                problem === "media.source.exclusiveAttachment"
                  ? t(problem)
                  : undefined
              }
            />
            {range}
            {canonicalYouTubeUrl(youtubeUrl.trim()) && (
              <MediaPreview
                asset={{
                  kind: "youtube",
                  url: canonicalYouTubeUrl(youtubeUrl.trim()) ?? "",
                  width: null,
                  height: null,
                  startSec: parseSeconds(start) || 0,
                  endSec: null,
                  accessibility: emptyAccessibility(),
                }}
              />
            )}
          </div>
        ) : (
          <AssetLibrary
            mode="picker"
            embedded
            view={tab === "upload" ? "upload" : "full"}
            query={query}
            onQueryChange={setQuery}
            lockedKind={cover ? "image" : null}
            folder={cover ? "covers" : null}
            onSelect={choose}
            onUploaded={(media) => {
              onUploadSettled?.(media);
              choose(media);
            }}
            {...(upload ? { upload } : {})}
            {...(limits !== undefined ? { limits } : {})}
          />
        )}
      </div>
    </ModalSheet>
  );
}
