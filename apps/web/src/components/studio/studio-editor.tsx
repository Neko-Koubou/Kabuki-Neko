"use client";
/**
 * S07 quiz studio (F03): the editor page composing the slide navigator, question fields,
 * properties, media picker and quiz details (Design §4.3, §6.1; SA §4.3, §6.4;
 * US-03/04/06/07/18/21; TASK-146).
 *
 * - Access gate:
 *   - loads `GET /quizzes/:id`;
 *   - 404/403 show one fixed "not available" message;
 *   - quizzes the user can't edit get a read-only notice with a link to the detail page;
 *   - nothing from the request is shown in either case.
 * - Layout:
 *   - desktop (≥ 1024 px): slide rail (224 px) | canvas | properties (288 px);
 *   - tablet (768–1023 px): canvas | properties, with the slides in a drawer;
 *   - phones: Slides / Editor / Properties tabs.
 *   Every panel is a view of the same studio store, so switching panels, drawers or breakpoints
 *   never discards anything.
 * - Saving is explicit only ("Save draft", Ctrl/Cmd+S): `PUT /quizzes/:id` with the whole draft and
 *   If-Match of the saved revision. The status is accurate: "Unsaved changes", "Saving…",
 *   "Saved at 14:05" (time of the last confirmed save) or "All changes saved". A failure keeps
 *   the draft.
 * - A 409 conflict keeps the draft and offers "Reload saved version" (discards local edits) or
 *   "Keep my draft" (adopts the server revision so the next save deliberately overwrites). Nothing
 *   is overwritten automatically.
 * - Leaving with unsaved edits goes through M10 (Stay / Discard / Save and continue), and the
 *   browser warns on reload or close. A language switch never makes the draft dirty.
 * - Hosting is offered only for the saved, playable revision with no unsaved edits. It opens M06
 *   and then the host stage.
 * - Successful saves and media picks update the local media references (cover and question
 *   previews); the next page load fetches fresh data.
 * States:
 * - loading: skeleton;
 * - empty: zero slides, with Add question;
 * - ideal: editing;
 * - partial: incomplete questions or a conflict;
 * - error: load failure with retry, or save failure keeping the draft.
 */
import { ArrowLeft, Menu, Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Media } from "@kabuki-neko/shared/schemas/media.schema";
import { questionPlayabilityIssues } from "@kabuki-neko/shared/schemas/question.schema";
import { quizDetailSchema, type QuizDetail } from "@kabuki-neko/shared/schemas/quiz.schema";
import {
  HostConfigDialog,
  type CreatedRoom,
  type CreateRoomRequest,
} from "@/components/host/host-config-dialog";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusNotice } from "@/components/ui/status-notice";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ApiError, type ApiClient } from "@/lib/api-client";
import { createGameSocket, type EmitResult } from "@/lib/socket-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";
import { createStudioStore, isDirty, useStudio, type StudioState } from "@/stores/studio.store";
import type { StoreApi } from "zustand";
import { MediaPicker } from "./media-picker";
import { QuestionFields } from "./question-fields";
import { QuestionProperties } from "./question-properties";
import { QuizSettingsModal } from "./QuizSettingsModal";
import { SlideNavigator, type SlideSummary } from "./slide-navigator";
import { UnsavedDialog } from "./unsaved-dialog";

/** Layout chosen from the viewport. */
export type StudioLayout = "desktop" | "tablet" | "mobile";

/** Media queries of the layouts. */
const DESKTOP_QUERY = "(min-width: 1024px)";
const TABLET_QUERY = "(min-width: 768px)";

/** Current layout from the viewport (desktop on the server). */
function useStudioLayout(): StudioLayout {
  const subscribe = useCallback((listener: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(TABLET_QUERY)];
    for (const query of queries) query.addEventListener("change", listener);
    return () => {
      for (const query of queries) query.removeEventListener("change", listener);
    };
  }, []);
  const snapshot = (): StudioLayout => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop";
    if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
    return window.matchMedia(TABLET_QUERY).matches ? "tablet" : "mobile";
  };
  return useSyncExternalStore(subscribe, snapshot, () => "desktop");
}

/** Saves the whole draft with the expected revision (bulk PUT). */
async function persistQuiz(api: ApiClient, quizId: string, draft: unknown, revision: number) {
  const { data } = await api.request({
    method: "PUT",
    path: `/quizzes/${quizId}`,
    body: draft,
    ifMatch: revision,
    schema: quizDetailSchema,
  });
  return data;
}

/** Load state of the studio. */
type LoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; error: unknown }
  | { status: "readOnly" }
  | { status: "ready" };

/** Props of {@link StudioEditor}. */
export interface StudioEditorProps {
  quizId: string;
  /** In-app navigation (router push). */
  navigate: (href: string) => void;
  /** Room creation (tests); defaults to a short-lived host socket. */
  createRoom?: (request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>;
  /** Layout override (tests); defaults to the viewport. */
  layout?: StudioLayout;
}

/** S07: the quiz studio. */
export function StudioEditor({
  quizId,
  navigate,
  createRoom,
  layout: forcedLayout,
}: StudioEditorProps) {
  const { t, ensureNamespaces } = useLocale();
  const { api, getAccessToken } = useAuth();
  const [store] = useState<StoreApi<StudioState>>(createStudioStore);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [server, setServer] = useState<QuizDetail | null>(null);
  const [media, setMedia] = useState<Map<string, Media>>(new Map());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const viewportLayout = useStudioLayout();
  const layout = forcedLayout ?? viewportLayout;

  useEffect(() => {
    void ensureNamespaces([
      "studio",
      "quizzes",
      "media",
      "host",
      "validation",
      "reports",
      "player",
    ]);
  }, [ensureNamespaces]);

  // Load the quiz (and re-load on retry).
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    api
      .request({ path: `/quizzes/${quizId}`, schema: quizDetailSchema, signal: controller.signal })
      .then(
        ({ data }) => {
          if (controller.signal.aborted) return;
          setServer(data);
          setMedia(new Map(data.media.map((item) => [item.id, item])));
          if (!data.capabilities.canEdit) {
            setLoad({ status: "readOnly" });
            return;
          }
          store.getState().load(data);
          setLoad({ status: "ready" });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setLoad(
            error instanceof ApiError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
              ? { status: "unavailable" }
              : { status: "error", error },
          );
        },
      );
    return () => controller.abort();
  }, [api, quizId, attempt, store]);

  if (load.status === "loading")
    return (
      <div className="flex flex-col gap-4 p-4">
        <SkeletonBlock layout="rows" count={4} label={t("studio.inventory.s07.loading")} />
      </div>
    );
  if (load.status === "unavailable")
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <h1 className="text-title font-bold">{t("studio.editor.title")}</h1>
        <p role="alert">{t("quizzes.detail.unavailable")}</p>
        <Link href="/dashboard/quizzes" className="underline">
          {t("common.actions.back")}
        </Link>
      </div>
    );
  if (load.status === "error")
    return (
      <div className="p-4">
        <StatusNotice
          tone="error"
          message={t("quizzes.inventory.s06.error")}
          correlationId={load.error instanceof ApiError ? load.error.correlationId : null}
          action={{ label: t("common.actions.retry"), onAction: () => setAttempt((n) => n + 1) }}
        />
      </div>
    );
  if (load.status === "readOnly" || !server)
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <h1 className="text-title font-bold">{t("studio.editor.title")}</h1>
        <p role="status">{t("quizzes.detail.publicReadOnly")}</p>
        <Link href={`/dashboard/quizzes/${quizId}`} className="underline">
          {t("quizzes.detail.title")}
        </Link>
      </div>
    );

  return (
    <StudioWorkspace
      store={store}
      server={server}
      media={media}
      layout={layout}
      savedAt={savedAt}
      navigate={navigate}
      onSaved={(detail) => {
        setServer(detail);
        setMedia(
          (current) =>
            new Map([...current, ...detail.media.map((item) => [item.id, item] as const)]),
        );
        setSavedAt(Date.now());
      }}
      onMediaPicked={(item) => setMedia((current) => new Map(current).set(item.id, item))}
      persist={(draft, revision) => persistQuiz(api, quizId, draft, revision)}
      reloadDetail={async () =>
        (await api.request({ path: `/quizzes/${quizId}`, schema: quizDetailSchema })).data
      }
      createRoom={
        createRoom ??
        (async (request) => {
          const socket = createGameSocket({
            url: process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001",
            role: "host",
            getAccessToken,
            ackTimeoutMs: 10_000,
          });
          socket.connect();
          try {
            return await socket.emit("host:create_room", request);
          } finally {
            socket.disconnect();
          }
        })
      }
    />
  );
}

/** Props of {@link StudioWorkspace}. */
interface StudioWorkspaceProps {
  store: StoreApi<StudioState>;
  server: QuizDetail;
  media: ReadonlyMap<string, Media>;
  layout: StudioLayout;
  savedAt: number | null;
  navigate: (href: string) => void;
  onSaved: (detail: QuizDetail) => void;
  onMediaPicked: (media: Media) => void;
  persist: (draft: unknown, revision: number) => Promise<QuizDetail>;
  reloadDetail: () => Promise<QuizDetail>;
  createRoom: (request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>;
}

/** The loaded, editable studio. */
function StudioWorkspace({
  store,
  server,
  media,
  layout,
  savedAt,
  navigate,
  onSaved,
  onMediaPicked,
  persist,
  reloadDetail,
  createRoom,
}: StudioWorkspaceProps) {
  const { t } = useLocale();
  const draft = useStudio(store, (state) => state.draft);
  const saved = useStudio(store, (state) => state.saved);
  const selectedId = useStudio(store, (state) => state.selectedId);
  const saving = useStudio(store, (state) => state.saving);
  const conflict = useStudio(store, (state) => state.conflict);
  const saveError = useStudio(store, (state) => state.saveError);
  const dirty = isDirty({ draft, saved });
  const [tab, setTab] = useState<"slides" | "editor" | "properties">("editor");
  const [drawer, setDrawer] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [focusPath, setFocusPath] = useState<{ path: string; nonce: number } | null>(null);
  const [reconciling, setReconciling] = useState(false);

  /** Saves through the store; true on success. */
  const save = useCallback(async () => {
    const result = await store.getState().save(async (sent, revision) => {
      const detail = await persist(sent, revision);
      onSaved(detail);
      return detail;
    });
    return result === "saved" || result === "skipped";
  }, [store, persist, onSaved]);

  const guard = useUnsavedChanges({ dirty, save });

  // Ctrl/Cmd+S saves explicitly.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const questions = useMemo(() => draft?.questions ?? [], [draft]);
  const selected = questions.find((question) => question.id === selectedId) ?? null;
  const slides: SlideSummary[] = questions.map((question) => ({
    id: question.id,
    type: question.type,
    promptText: question.promptText,
    issueCount: questionPlayabilityIssues(question, "draft").length,
  }));
  const incomplete = slides.some((slide) => slide.issueCount > 0);
  const hostable =
    !dirty && server.isPlayable && server.capabilities.canHost && questions.length > 0;
  const coverUrl = draft?.coverMediaId ? (media.get(draft.coverMediaId)?.publicUrl ?? null) : null;

  /** Resolves the conflict either way (fetches the latest saved version first). */
  const resolveConflict = async (mode: "reload" | "keep") => {
    setReconciling(true);
    try {
      const detail = await reloadDetail();
      if (mode === "reload") store.getState().reloadFromServer(detail);
      else store.getState().rebaseDraft(detail);
      onSaved(detail);
    } finally {
      setReconciling(false);
    }
  };

  let status: string;
  if (saving) status = t("studio.editor.saving");
  else if (saveError && !conflict) status = t("studio.editor.saveFailed");
  else if (dirty) status = t("studio.editor.unsaved");
  else if (savedAt !== null) status = t("studio.editor.savedAt", { savedAt });
  else status = t("studio.editor.saved");

  const navigator = (
    <SlideNavigator
      slides={slides}
      selectedId={selectedId}
      onSelect={(id) => {
        store.getState().select(id);
        setDrawer(false);
        if (layout === "mobile") setTab("editor");
      }}
      onAdd={(afterId) => store.getState().addQuestion("SINGLE_CHOICE", afterId)}
      onMove={(id, toIndex) => {
        store.getState().moveQuestion(id, toIndex);
        return true;
      }}
      onDuplicate={(id) => store.getState().duplicateQuestion(id)}
      onDelete={(id) => store.getState().deleteQuestion(id)}
      onShowIssues={(id) => {
        store.getState().select(id);
        const question = questions.find((item) => item.id === id);
        const first = question ? questionPlayabilityIssues(question, "draft")[0] : undefined;
        setFocusPath({ path: first?.path ?? "promptText", nonce: Date.now() });
        setDrawer(false);
        if (layout === "mobile") setTab("editor");
      }}
    />
  );

  const canvas = selected ? (
    <QuestionFields
      key={selected.id}
      question={selected}
      onChange={(update) => store.getState().updateQuestion(selected.id, update)}
      onChooseMedia={() => setPickerOpen(true)}
      focusPath={focusPath?.path ?? null}
    />
  ) : (
    <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-6">
      <p role="status">{t("studio.inventory.s07.empty")}</p>
      <ActionButton
        label={t("studio.editor.addQuestion")}
        onPress={() => store.getState().addQuestion("SINGLE_CHOICE", null)}
      />
    </div>
  );

  const properties = selected ? (
    <QuestionProperties
      key={selected.id}
      question={selected}
      onChange={(update) => store.getState().updateQuestion(selected.id, update)}
      media={selected.mediaId ? (media.get(selected.mediaId) ?? null) : null}
      onChooseMedia={() => setPickerOpen(true)}
      focusPath={focusPath?.path ?? null}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        data-dirty={dirty ? "true" : "false"}
        className="sticky top-0 z-[var(--layer-sticky)] flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-3"
      >
        <ActionButton
          variant="ghost"
          icon={<ArrowLeft />}
          label={t("common.actions.back")}
          onPress={() => guard.requestNavigation(() => navigate(`/dashboard/quizzes/${server.id}`))}
        />
        <h1 className="min-w-0 flex-1 basis-48 text-title-sm font-bold break-words">
          {draft?.title ?? server.title}
        </h1>
        <p role="status" aria-live="polite" className="text-small text-muted-foreground">
          {status}
        </p>
        <ActionButton
          variant="secondary"
          label={t("studio.editor.metadata")}
          onPress={() => setMetadataOpen(true)}
        />
        <ActionButton
          icon={<Save />}
          label={t("studio.editor.saveDraft")}
          pending={saving}
          disabled={!dirty && !saveError}
          onPress={() => void save()}
        />
        <ActionButton
          variant="secondary"
          label={t("studio.editor.host")}
          disabled={!hostable}
          {...(!hostable
            ? {
                disabledReason: dirty
                  ? t("host.config.saveBeforeHosting")
                  : t("quizzes.detail.invalidDraft"),
              }
            : {})}
          onPress={() => setHostOpen(true)}
        />
      </header>
      <div className="flex flex-col gap-3 px-4 pt-3">
        {conflict && <StatusNotice tone="warning" message={t("studio.editor.conflict")} />}
        {conflict && (
          <div className="flex flex-wrap gap-2">
            <ActionButton
              variant="secondary"
              label={t("studio.editor.reloadServer")}
              pending={reconciling}
              onPress={() => void resolveConflict("reload")}
            />
            <ActionButton
              label={t("studio.editor.keepDraft")}
              pending={reconciling}
              onPress={() => void resolveConflict("keep")}
            />
          </div>
        )}
        {saveError && !conflict && (
          <StatusNotice
            tone="error"
            message={t("studio.inventory.s07.error")}
            correlationId={saveError.correlationId}
          />
        )}
        {incomplete && <p className="text-small text-warning">{t("studio.editor.incomplete")}</p>}
      </div>
      {layout === "desktop" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[224px_minmax(0,1fr)_288px] gap-4 p-4">
          <aside className="min-h-0">{navigator}</aside>
          <div className="min-w-0">{canvas}</div>
          <aside className="min-w-0">{properties}</aside>
        </div>
      ) : layout === "tablet" ? (
        <div className="flex flex-col gap-3 p-4">
          <ActionButton
            variant="secondary"
            icon={<Menu />}
            label={t("studio.editor.slides")}
            onPress={() => setDrawer(true)}
            className="self-start"
          />
          <div className="grid grid-cols-[minmax(0,1fr)_288px] gap-4">
            <div className="min-w-0">{canvas}</div>
            <aside className="min-w-0">{properties}</aside>
          </div>
          <ModalSheet
            open={drawer}
            fullHeight
            title={t("studio.editor.slides")}
            onCloseRequest={() => setDrawer(false)}
          >
            {navigator}
          </ModalSheet>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <ChoiceGroup
            mode="tabs"
            label={t("studio.editor.title")}
            hideLabel
            items={[
              { id: "slides", label: t("studio.editor.slides") },
              { id: "editor", label: t("studio.editor.editor") },
              { id: "properties", label: t("studio.editor.properties") },
            ]}
            selected={tab}
            onSelect={(id) => setTab(id === "slides" || id === "properties" ? id : "editor")}
          />
          {tab === "slides" ? navigator : tab === "properties" ? properties : canvas}
        </div>
      )}
      <QuizSettingsModal
        open={metadataOpen}
        mode="edit"
        onClose={() => setMetadataOpen(false)}
        initial={{ ...(draft ?? {}), coverUrl }}
        onApply={(values) => {
          store.getState().updateMetadata(values);
          setMetadataOpen(false);
        }}
      />
      <MediaPicker
        open={pickerOpen}
        context="question"
        onClose={() => setPickerOpen(false)}
        onUploadSettled={onMediaPicked}
        onSelectQuestion={(selection) => {
          if (!selected) return;
          if (selection.media) onMediaPicked(selection.media);
          const isImage = selection.preview.kind === "image";
          store.getState().updateQuestion(selected.id, (question) => ({
            ...question,
            mediaId: selection.mediaId,
            externalVideoUrl: selection.externalVideoUrl,
            videoStartSec: selection.videoStartSec,
            videoEndSec: selection.videoEndSec,
            accessibility: selection.accessibility,
            mediaRevealMode: isImage ? question.mediaRevealMode : "NONE",
          }));
        }}
      />
      <HostConfigDialog
        open={hostOpen}
        onClose={() => setHostOpen(false)}
        dirty={dirty}
        quiz={{
          id: server.id,
          title: server.title,
          revision: server.revision,
          questionCount: server.questionCount,
          isPlayable: server.isPlayable,
        }}
        createRoom={createRoom}
        onCreated={(room: CreatedRoom) => {
          setHostOpen(false);
          navigate(`/host/${room.sessionId}`);
        }}
      />
      <UnsavedDialog guard={guard} incomplete={incomplete} />
    </div>
  );
}

/** Route wrapper with Next navigation. */
export function StudioRoute({ quizId }: { quizId: string }) {
  const router = useRouter();
  return <StudioEditor quizId={quizId} navigate={(href) => router.push(href)} />;
}
