"use client";
/**
 * M03 quiz details dialog: create a quiz or edit the studio draft's metadata
 * (Design §4.9 M03, §7; SA §4.3; Audio revision 2026-10-31; US-03/04/07; TASK-137).
 *
 * - Fields: title (required, 150), description (optional, multiline), cover (choose/remove; the
 *   parent may open its own picker through `onChooseCover`, otherwise the built-in M05 picker opens
 *   locked to images and hands back the chosen READY image — TASK-142),
 *   visibility (default PRIVATE) and background music.
 * - Background music: "Random lobby music" (the default) followed by the real lobby tracks from
 *   the packaged audio manifest. A saved track id the manifest no longer has (legacy/unknown) is
 *   kept as its own option so saving never silently changes it; at playback it resolves to
 *   random.
 * - Preview uses the audio manager singleton: one preview at a time (a new one stops the old), and
 *   it stops when the dialog closes or unmounts, and when live music starts.
 * - Create mode sends `POST /quizzes` once (Idempotency-Key kept for retries). A lost response is
 *   reconciled through the operation lookup (`quiz.create`) and the created quiz loaded, instead
 *   of creating a second one. Edit mode only applies the values to the studio draft; nothing is
 *   saved until the studio's Save.
 * States: loading (Saving details…), empty (title missing → required, cover optional), ideal,
 * partial (title too long / cover image failed) and error (not saved, entries kept).
 */
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AUDIO_MANIFEST_URL, DEFAULT_AUDIO_TRACK } from "@kabuki-neko/shared/constants/audio";
import { TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { audioManifestSchema } from "@kabuki-neko/shared/schemas/audio.schema";
import {
  quizCreateSchema,
  quizDescriptionSchema,
  quizDetailSchema,
  quizTitleSchema,
  type QuizDetail,
} from "@kabuki-neko/shared/schemas/quiz.schema";
import { issueMessageKey } from "@/components/auth/public-auth-forms";
import { MediaPicker } from "@/components/studio/media-picker";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { FormField } from "@/components/ui/form-field";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { ApiError } from "@/lib/api-client";
import { getAudioManager } from "@/lib/audio-manager";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Quiz metadata edited by the dialog. */
export interface QuizMetadataValues {
  title: string;
  description: string | null;
  coverMediaId: string | null;
  visibility: "PRIVATE" | "PUBLIC";
  bgmTrack: string;
}

/** Media chosen as cover by the picker. */
export interface CoverChoice {
  id: string;
  url: string | null;
}

/** One selectable lobby track. */
export interface TrackOption {
  id: string;
  label: string;
}

/** Preview surface of the audio manager (injectable in tests). */
export interface PreviewPlayer {
  previewLobby(id: string): Promise<boolean>;
  stopPreview(): void;
}

/** Loads the lobby tracks from the packaged manifest (also hands it to the audio manager). */
export function useLobbyTracks(provided?: readonly TrackOption[]) {
  const [loaded, setLoaded] = useState<{ tracks: TrackOption[] | null; failed: boolean }>({
    tracks: provided ? [...provided] : null,
    failed: false,
  });
  useEffect(() => {
    if (provided) return;
    let active = true;
    fetch(AUDIO_MANIFEST_URL, { cache: "force-cache" })
      .then((response) => response.json())
      .then((json: unknown) => {
        const manifest = audioManifestSchema.parse(json);
        getAudioManager().setManifest(manifest);
        if (active)
          setLoaded({
            tracks: manifest.lobby.map((track) => ({ id: track.id, label: track.label })),
            failed: false,
          });
      })
      .catch(() => {
        if (active) setLoaded({ tracks: [], failed: true });
      });
    return () => {
      active = false;
    };
  }, [provided]);
  return provided ? { tracks: [...provided], failed: false } : loaded;
}

/** Options for the music select: Random, the manifest tracks, then a kept unknown id. */
export function bgmOptions(
  tracks: readonly TrackOption[],
  current: string,
  randomLabel: string,
): { value: string; label: string; known: boolean }[] {
  const options = [
    { value: DEFAULT_AUDIO_TRACK, label: randomLabel, known: true },
    ...tracks.map((track) => ({ value: track.id, label: track.label, known: true })),
  ];
  if (!options.some((option) => option.value === current))
    options.push({ value: current, label: `${randomLabel} (${current})`, known: false });
  return options;
}

/** Field errors (message keys) for the metadata values. */
function validate(values: QuizMetadataValues): Partial<Record<"title" | "description", string>> {
  const errors: Partial<Record<"title" | "description", string>> = {};
  if (values.title.trim() === "") errors.title = "validation.errors.required";
  else {
    const title = quizTitleSchema.safeParse(values.title);
    if (!title.success) {
      const issue = title.error.issues[0];
      errors.title = issueMessageKey(
        issue?.code === "custom" ? issue.message : (issue?.code ?? ""),
      );
    }
  }
  const description = quizDescriptionSchema.safeParse(values.description);
  if (!description.success) {
    const issue = description.error.issues[0];
    errors.description = issueMessageKey(
      issue?.code === "custom" ? issue.message : (issue?.code ?? ""),
    );
  }
  return errors;
}

/** Props of {@link QuizSettingsModal}. */
export interface QuizSettingsModalProps {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  /** Current values (edit) or prefill (create); `coverUrl` shows the current cover. */
  initial?: Partial<QuizMetadataValues> & { coverUrl?: string | null };
  /** Edit mode: apply the values to the studio draft. */
  onApply?: (values: QuizMetadataValues) => void;
  /** Create mode: the created quiz (with its single empty slide). */
  onCreated?: (quiz: QuizDetail) => void;
  /** Opens the media picker; it calls `select` with the chosen cover. */
  onChooseCover?: (select: (cover: CoverChoice) => void) => void;
  /** Lobby tracks (defaults to the packaged manifest). */
  tracks?: readonly TrackOption[];
  /** Preview player (defaults to the audio manager singleton). */
  player?: PreviewPlayer;
}

/** The M03 dialog. */
export function QuizSettingsModal({
  open,
  onClose,
  mode,
  initial,
  onApply,
  onCreated,
  onChooseCover,
  tracks: providedTracks,
  player,
}: QuizSettingsModalProps) {
  const { t, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const ids = { title: useId(), description: useId(), bgm: useId() };
  const { tracks } = useLobbyTracks(providedTracks);
  const audio = useRef<PreviewPlayer>(player ?? getAudioManager());
  audio.current = player ?? getAudioManager();
  const [values, setValues] = useState<QuizMetadataValues>({
    title: initial?.title ?? "",
    description: initial?.description ?? null,
    coverMediaId: initial?.coverMediaId ?? null,
    visibility: initial?.visibility ?? "PRIVATE",
    bgmTrack: initial?.bgmTrack ?? DEFAULT_AUDIO_TRACK,
  });
  const [coverUrl, setCoverUrl] = useState<string | null>(initial?.coverUrl ?? null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<"title" | "description", string>>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    void ensureNamespaces(["quizzes", "host", "validation"]);
  }, [ensureNamespaces]);

  /** Stops any preview (dialog close, unmount). */
  const stopPreview = useCallback(() => {
    audio.current.stopPreview();
    setPreviewing(null);
  }, []);
  useEffect(() => {
    if (!open) stopPreview();
  }, [open, stopPreview]);
  useEffect(() => () => audio.current.stopPreview(), []);

  const options = bgmOptions(tracks ?? [], values.bgmTrack, t("quizzes.metadata.randomBgm"));
  const selected = options.find((option) => option.value === values.bgmTrack);
  const canPreview = selected?.known === true && selected.value !== DEFAULT_AUDIO_TRACK;

  /** Starts or stops the preview of the selected track (one at a time). */
  const togglePreview = async () => {
    if (previewing === values.bgmTrack) {
      stopPreview();
      return;
    }
    const started = await audio.current.previewLobby(values.bgmTrack);
    setPreviewing(started ? values.bgmTrack : null);
  };

  /** Loads a quiz created by a request whose response was lost. */
  const loadCreated = async (): Promise<QuizDetail | null> => {
    const outcome = await api.reconcileOperation(keyRef.current, "quiz.create");
    if (outcome.status !== "done" || !outcome.resourceId) return null;
    const { data } = await api.request({
      path: `/quizzes/${outcome.resourceId}`,
      schema: quizDetailSchema,
    });
    return data;
  };

  /** Validates, then creates the quiz or applies the draft values. */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found = validate(values);
    setErrors(found);
    setFailed(false);
    if (Object.keys(found).length > 0) return;
    const clean: QuizMetadataValues = {
      ...values,
      title: values.title.trim(),
      description: values.description?.trim() ? values.description : null,
    };
    stopPreview();
    if (mode === "edit") {
      onApply?.(clean);
      onClose();
      return;
    }
    setPending(true);
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/quizzes",
        body: quizCreateSchema.parse(clean),
        schema: quizDetailSchema,
        idempotencyKey: keyRef.current,
      });
      keyRef.current = crypto.randomUUID();
      onCreated?.(data);
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.uncertain;
      const recovered = uncertain ? await loadCreated().catch(() => null) : null;
      if (recovered) {
        keyRef.current = crypto.randomUUID();
        onCreated?.(recovered);
      } else {
        if (!uncertain) keyRef.current = crypto.randomUUID();
        const titleIssue =
          error instanceof ApiError
            ? error.details.find((issue) => issue.path.startsWith("title"))
            : undefined;
        if (titleIssue) setErrors({ title: issueMessageKey(titleIssue.code) });
        else setFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  const partial = coverFailed || errors.title === "validation.errors.tooLong";
  const set = <K extends keyof QuizMetadataValues>(key: K, value: QuizMetadataValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  /** Applies a chosen cover (from the parent's picker or the built-in one). */
  const applyCover = (cover: CoverChoice) => {
    set("coverMediaId", cover.id);
    setCoverUrl(cover.url);
    setCoverFailed(false);
  };

  return (
    <>
      <ModalSheet
        open={open}
        title={t("quizzes.metadata.title")}
        description={t("quizzes.inventory.m03.empty")}
        pending={pending}
        onCloseRequest={onClose}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <ActionButton
              variant="secondary"
              label={t("common.actions.cancel")}
              onPress={onClose}
            />
            <ActionButton
              type="submit"
              form={`${ids.title}-form`}
              pending={pending}
              label={mode === "create" ? t("quizzes.metadata.create") : t("quizzes.metadata.apply")}
            />
          </div>
        }
      >
        <form
          id={`${ids.title}-form`}
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
        >
          {failed && (
            <p
              role="alert"
              className="rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
            >
              {t("quizzes.inventory.m03.error")}
            </p>
          )}
          {partial && (
            <p
              role="note"
              className="rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
            >
              {t("quizzes.inventory.m03.partial")}
            </p>
          )}
          <FormField
            id={ids.title}
            name="title"
            label={t("quizzes.metadata.quizTitle")}
            required
            limit={TEXT_LIMITS.title}
            value={values.title}
            onChange={(title) => set("title", title)}
            error={errors.title ? t(errors.title) : undefined}
          />
          <FormField
            id={ids.description}
            name="description"
            kind="textarea"
            rows={3}
            label={t("quizzes.metadata.description")}
            limit={TEXT_LIMITS.description}
            value={values.description ?? ""}
            onChange={(description) => set("description", description === "" ? null : description)}
            error={errors.description ? t(errors.description) : undefined}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-label font-semibold">{t("quizzes.metadata.cover")}</legend>
            <div className="flex flex-wrap items-center gap-3">
              {coverUrl && !coverFailed ? (
                // Plain <img>: user media from the API, not a static asset for next/image.
                <img
                  src={coverUrl}
                  alt=""
                  className="h-20 w-32 rounded-md border border-border object-cover"
                  onError={() => setCoverFailed(true)}
                />
              ) : (
                <span className="inline-flex h-20 w-32 items-center justify-center rounded-md border border-dashed border-border p-2 text-center text-caption text-muted-foreground">
                  {t("quizzes.detail.coverMissing")}
                </span>
              )}
              <ActionButton
                variant="secondary"
                label={t("quizzes.metadata.chooseCover")}
                onPress={() => {
                  if (onChooseCover) onChooseCover(applyCover);
                  else setPickerOpen(true);
                }}
              />
              {values.coverMediaId && (
                <ActionButton
                  variant="ghost"
                  label={t("quizzes.metadata.removeCover")}
                  onPress={() => {
                    set("coverMediaId", null);
                    setCoverUrl(null);
                    setCoverFailed(false);
                  }}
                />
              )}
            </div>
          </fieldset>
          <ChoiceGroup
            mode="radio"
            name="visibility"
            label={t("quizzes.metadata.visibility")}
            orientation="horizontal"
            items={[
              { id: "PRIVATE", label: t("common.visibility.private") },
              { id: "PUBLIC", label: t("common.visibility.public") },
            ]}
            selected={values.visibility}
            onSelect={(id) => set("visibility", id === "PUBLIC" ? "PUBLIC" : "PRIVATE")}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.bgm} className="text-label font-semibold">
              {t("quizzes.metadata.bgmTrack")}
            </label>
            <div className="flex flex-wrap items-stretch gap-2">
              <select
                id={ids.bgm}
                name="bgmTrack"
                value={values.bgmTrack}
                onChange={(event) => {
                  stopPreview();
                  set("bgmTrack", event.target.value);
                }}
                className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-body"
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ActionButton
                variant="secondary"
                disabled={!canPreview}
                icon={previewing === values.bgmTrack ? <Pause /> : <Play />}
                label={
                  previewing === values.bgmTrack
                    ? t("quizzes.metadata.stopPreview")
                    : t("quizzes.metadata.previewBgm")
                }
                onPress={() => void togglePreview()}
              />
            </div>
          </div>
          <p role="status" aria-live="polite" className="text-small empty:hidden">
            {pending ? t("quizzes.inventory.m03.loading") : ""}
          </p>
        </form>
      </ModalSheet>
      <MediaPicker
        open={pickerOpen}
        context="cover"
        onClose={() => setPickerOpen(false)}
        onSelectCover={applyCover}
      />
    </>
  );
}
