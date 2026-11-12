"use client";
/**
 * S06 quiz detail and JSON export (Design §4.2, §7; SA §4.3; US-03/05/07/21; TASK-139).
 *
 * - Loads `GET /quizzes/:id`. A 404 (hidden PRIVATE or deleted) or 403 shows one fixed message
 *   ("This quiz isn't available…") — never a title, owner or anything else from the request.
 * - Shows the cover (fallback when missing or broken), title, description, owner, visibility,
 *   question count and the ordered questions (position, type, time limit, prompt summary).
 * - Actions follow the server capabilities:
 *   - owners: Edit (studio) and Delete (M09; back to the library after a confirmed delete);
 *   - everyone allowed: Duplicate (opens the copy in the studio; pending and failures stay
 *     visible), Host (M06 for playable quizzes), Export.
 * - Export downloads `GET /quizzes/:id/export?format=json` as a Blob with the server's safe
 *   filename (fallback `<id>.kabukineko.json`). An empty or failed download is reported, never
 *   presented as success.
 * - Invalid drafts list their validation issues (slide + message) and cannot be hosted. Empty
 *   quizzes invite the owner to add questions.
 * States: loading (skeleton), empty (no questions; owner CTA), ideal, partial (read-only public
 * quiz, or a draft that needs fixes) and error (unavailable without details / retry).
 */
import { ArrowLeft, Download, Copy, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  quizDeletedSchema,
  quizDetailSchema,
  type QuizDetail,
} from "@kabuki-neko/shared/schemas/quiz.schema";
import { HostConfigDialog, type CreatedRoom } from "@/components/host/host-config-dialog";
import { duplicateQuiz, type CreateRoomFn } from "@/components/studio/quiz-library-detail";
import { ActionButton } from "@/components/ui/action-button";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, apiErrorMessageKey, saveBlob } from "@/lib/api-client";
import { createGameSocket } from "@/lib/socket-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Catalog keys of the question type labels. */
const TYPE_KEYS: Record<QuizDetail["questions"][number]["type"], string> = {
  SINGLE_CHOICE: "studio.types.singleChoice",
  TRUE_FALSE: "studio.types.trueFalse",
  MULTIPLE_SELECT: "studio.types.multipleSelect",
  TYPE_ANSWER: "studio.types.typeAnswer",
  ORDER_PUZZLE: "studio.types.orderPuzzle",
  POLL: "studio.types.poll",
};

/** Fallback export filename when the server sends none. */
export function exportFallbackName(quizId: string): string {
  return `${quizId}.kabukineko.json`;
}

/** Question position (0-based) referenced by an issue path such as `questions.2.promptText`. */
export function issueQuestionIndex(path: string): number | null {
  const match = /^questions\.(\d+)(?:\.|$)/u.exec(path);
  return match ? Number(match[1]) : null;
}

/** Detail load state. */
type DetailState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; correlationId: string | null }
  | { status: "ready"; quiz: QuizDetail };

/** Props of {@link QuizDetailView}. */
export interface QuizDetailViewProps {
  quizId: string;
  navigate: (href: string) => void;
  /** Room creation (defaults to a short-lived host socket). */
  createRoom?: CreateRoomFn;
  /** Saves a downloaded Blob (defaults to a temporary object-URL link). */
  save?: (blob: Blob, filename: string) => void;
}

/** The S06 page body. */
export function QuizDetailView({
  quizId,
  navigate,
  createRoom,
  save = saveBlob,
}: QuizDetailViewProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const { api, getAccessToken } = useAuth();
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [hostOpen, setHostOpen] = useState(false);
  const [busy, setBusy] = useState<"duplicate" | "export" | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    void ensureNamespaces(["quizzes", "studio", "host", "validation", "auth"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .request({ path: `/quizzes/${quizId}`, schema: quizDetailSchema, signal: controller.signal })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted) setState({ status: "ready", quiz: data });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (
            error instanceof ApiError &&
            (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
          )
            setState({ status: "unavailable" });
          else
            setState({
              status: "error",
              correlationId: error instanceof ApiError ? error.correlationId : null,
            });
        },
      );
    return () => controller.abort();
  }, [api, quizId, attempt]);

  const quiz = state.status === "ready" ? state.quiz : null;

  const roomCreator = useMemo<CreateRoomFn>(
    () =>
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
      }),
    [createRoom, getAccessToken],
  );

  const confirmDelete = useConfirmAction({
    run: async () => {
      if (!quiz) return;
      await api.request({
        method: "DELETE",
        path: `/quizzes/${quiz.id}`,
        schema: quizDeletedSchema,
        ifMatch: quiz.revision,
      });
    },
    reconcile: async () => {
      try {
        await api.request({ path: `/quizzes/${quizId}`, schema: quizDetailSchema });
        return "not-done";
      } catch (error) {
        return error instanceof ApiError && error.code === "NOT_FOUND" ? "done" : "unknown";
      }
    },
    onDone: () => navigate("/dashboard/quizzes"),
  });

  /** Duplicates and opens the copy; pending and failures stay visible. */
  const duplicate = useCallback(async () => {
    if (!quiz || busy) return;
    setBusy("duplicate");
    setNotice(null);
    const outcome = await duplicateQuiz(api, quiz.id);
    setBusy(null);
    if (outcome.status === "done") navigate(`/studio/${outcome.id}`);
    else
      setNotice({
        tone: "error",
        text:
          outcome.status === "failed"
            ? t("common.inventory.b01.error")
            : t("auth.recovery.uncertainRequest"),
      });
  }, [api, busy, navigate, quiz, t]);

  /** Downloads the JSON export; an empty or failed download is an error, never a success. */
  const exportJson = useCallback(async () => {
    if (!quiz || busy) return;
    setBusy("export");
    setNotice(null);
    try {
      const { blob, filename } = await api.download(
        `/quizzes/${quiz.id}/export?format=json`,
        exportFallbackName(quiz.id),
      );
      if (blob.size === 0) throw new Error("empty export");
      save(blob, filename);
    } catch (error) {
      const key =
        error instanceof ApiError && error.code !== "INTERNAL_ERROR"
          ? apiErrorMessageKey(error.code)
          : null;
      setNotice({
        tone: "error",
        text: key ? `${t("quizzes.export.failed")} ${t(key)}` : t("quizzes.export.failed"),
      });
    } finally {
      setBusy(null);
    }
  }, [api, busy, quiz, save, t]);

  const back = (
    <Link
      href="/dashboard/quizzes"
      className="inline-flex min-h-11 items-center gap-2 self-start rounded-md px-2 text-label hover:bg-subtle"
    >
      <ArrowLeft aria-hidden="true" className="size-5" />
      {t("common.actions.back")}
    </Link>
  );

  if (state.status === "loading")
    return (
      <div className="flex flex-col gap-4">
        {back}
        <SkeletonBlock layout="card" label={t("quizzes.inventory.s06.loading")} />
      </div>
    );
  if (state.status === "unavailable")
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h1 className="text-title font-bold">{t("quizzes.detail.title")}</h1>
        <StatusNotice tone="error" message={t("quizzes.detail.unavailable")} />
      </div>
    );
  if (state.status === "error")
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h1 className="text-title font-bold">{t("quizzes.detail.title")}</h1>
        <StatusNotice
          tone="error"
          message={t("quizzes.inventory.s06.error")}
          correlationId={state.correlationId}
          action={{ label: t("common.actions.retry"), onAction: () => setAttempt((n) => n + 1) }}
        />
      </div>
    );

  const detail = state.quiz;
  const { capabilities } = detail;
  const readOnly = !capabilities.canEdit;
  const issues = detail.validationIssues.filter((issue) => issue.severity === "error");
  const hostable = detail.isPlayable && detail.questionCount > 0;
  const cover = detail.coverMedia?.publicUrl ?? null;

  return (
    <article aria-labelledby="quiz-title" className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <h1
          id="quiz-title"
          className="min-w-0 text-title font-bold break-words [overflow-wrap:anywhere]"
        >
          {detail.title}
        </h1>
        {capabilities.canHost && (
          <ActionButton
            size="lg"
            className="shrink-0"
            disabled={!hostable}
            {...(!hostable ? { disabledReason: t("quizzes.detail.invalidDraft") } : {})}
            label={t("quizzes.detail.host")}
            onPress={() => setHostOpen(true)}
          />
        )}
      </header>
      {notice && (
        <StatusNotice tone={notice.tone} message={notice.text} onDismiss={() => setNotice(null)} />
      )}
      {readOnly && (
        <p role="note" className="rounded-md border border-border bg-subtle p-3 text-small">
          {t("quizzes.detail.publicReadOnly")}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-subtle">
          {cover && !coverFailed ? (
            // Plain <img>: user media from the API, not a static asset for next/image.
            <img
              src={cover}
              alt=""
              className="size-full object-cover"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <span className="flex size-full items-center justify-center p-4 text-center text-small text-muted-foreground">
              {t("quizzes.detail.coverMissing")}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
            <dt className="text-muted-foreground">{t("quizzes.detail.owner")}</dt>
            <dd className="break-words">{detail.creatorName}</dd>
            <dt className="text-muted-foreground">{t("quizzes.metadata.visibility")}</dt>
            <dd>
              {detail.visibility === "PUBLIC"
                ? t("common.visibility.public")
                : t("common.visibility.private")}
            </dd>
            <dt className="text-muted-foreground">{t("quizzes.detail.questions")}</dt>
            <dd>{t("quizzes.detail.questionCount", { count: detail.questionCount })}</dd>
          </dl>
          {detail.description && (
            <section aria-label={t("quizzes.detail.description")}>
              <p className="text-body break-words whitespace-pre-line">{detail.description}</p>
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            {capabilities.canEdit && (
              <Link
                href={`/studio/${detail.id}`}
                className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-label font-semibold hover:bg-subtle"
              >
                {t("quizzes.detail.edit")}
              </Link>
            )}
            {capabilities.canDuplicate && (
              <ActionButton
                variant="secondary"
                icon={<Copy />}
                pending={busy === "duplicate"}
                label={t("quizzes.detail.duplicate")}
                onPress={() => void duplicate()}
              />
            )}
            {capabilities.canExport && (
              <ActionButton
                variant="secondary"
                icon={<Download />}
                pending={busy === "export"}
                label={t("quizzes.export.downloadJson")}
                onPress={() => void exportJson()}
              />
            )}
            {capabilities.canDelete && (
              <ActionButton
                variant="danger"
                icon={<Trash2 />}
                label={t("quizzes.detail.delete")}
                onPress={confirmDelete.request}
              />
            )}
          </div>
          <p role="status" aria-live="polite" className="text-small empty:hidden">
            {busy === "export" ? t("quizzes.export.downloading") : ""}
          </p>
        </div>
      </div>
      {issues.length > 0 && (
        <section
          aria-labelledby="quiz-issues"
          className="rounded-md border border-warning bg-warning-surface p-4 text-small text-warning"
        >
          <h2 id="quiz-issues" className="font-semibold">
            {t("quizzes.detail.invalidDraft")}
          </h2>
          <ul className="mt-2 list-disc ps-5">
            {issues.map((issue, index) => {
              const position = issueQuestionIndex(issue.path);
              return (
                <li key={`${issue.path}-${index}`}>
                  {position !== null
                    ? `${t("studio.slides.position", { position: position + 1, total: detail.questionCount })}: `
                    : ""}
                  {t(apiErrorMessageKey(issue.code))}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section aria-labelledby="quiz-questions" className="flex flex-col gap-3">
        <h2 id="quiz-questions" className="text-title-sm font-semibold">
          {t("quizzes.detail.questions")}
        </h2>
        {detail.questions.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-4">
            <p role="status">{t("quizzes.inventory.s06.empty")}</p>
            {capabilities.canEdit && (
              <Link
                href={`/studio/${detail.id}`}
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
              >
                {t("quizzes.detail.edit")}
              </Link>
            )}
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {detail.questions.map((question, index) => (
              <li
                key={question.id}
                className="flex flex-col gap-1 rounded-md border border-border bg-panel p-3"
              >
                <p className="text-caption text-muted-foreground">
                  <span className="tabular-nums">{formatNumber(index + 1)}</span>
                  {" · "}
                  {t(TYPE_KEYS[question.type])}
                  {" · "}
                  {t("studio.question.timeLimit")}:{" "}
                  {formatNumber(question.timeLimitSec, {
                    style: "unit",
                    unit: "second",
                    unitDisplay: "short",
                  })}
                </p>
                <p className="text-body break-words [overflow-wrap:anywhere]">
                  {question.promptText || t("common.status.empty")}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
      {hostOpen && (
        <HostConfigDialog
          open
          onClose={() => setHostOpen(false)}
          quiz={detail}
          createRoom={roomCreator}
          onCreated={(room: CreatedRoom) => {
            setHostOpen(false);
            navigate(`/host/${room.sessionId}`);
          }}
        />
      )}
      <ConfirmDialog
        controller={confirmDelete}
        impact={t("common.confirm.deleteQuiz")}
        targetName={detail.title}
        confirmLabel={t("quizzes.detail.delete")}
      />
    </article>
  );
}

/** Route wrapper with Next navigation. */
export function QuizDetailRoute({ quizId }: { quizId: string }) {
  const router = useRouter();
  return <QuizDetailView quizId={quizId} navigate={(href) => router.push(href)} />;
}
