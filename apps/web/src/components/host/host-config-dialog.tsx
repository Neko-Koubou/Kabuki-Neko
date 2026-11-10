"use client";
/**
 * M06 host configuration dialog (Design §4.9 M06, §7; SA §5 room creation; US-03/04/07; TASK-137).
 *
 * - Shows the quiz title and question count, the display mode (Projector by default, Streamer;
 *   vertical choices with descriptions) and "friendly random nicknames" (off by default).
 * - No room exists before "Open lobby". A quiz without playable questions, or a studio draft
 *   with unsaved changes, cannot be hosted: the dialog explains why, and the button stays
 *   disabled. The server still validates the saved snapshot (`quizRevision`).
 * - Submitting emits `host:create_room` once (pending ignores repeated presses) and waits for the
 *   ACK. A lost ACK (timeout) is reconciled through the operation lookup (`room.create`) with the
 *   same `requestId` before anything is retried. A retry re-sends that same `requestId`, which the
 *   server de-duplicates, so a lost ACK can never create a second room. A definitive error starts a
 *   fresh attempt id.
 * States: loading (Creating the room…), empty (no playable questions), ideal (choose and open),
 * partial (unsaved draft / stale revision; the player limit follows the instance settings) and
 * error (could not be created or confirmed: retry after reconciliation).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayMode } from "@kabuki-neko/shared/constants/game";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { apiErrorMessageKey } from "@/lib/api-client";
import type { EmitResult } from "@/lib/socket-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Quiz facts the dialog needs. */
export interface HostableQuiz {
  id: string;
  title: string;
  /** Saved revision the room snapshot is created from. */
  revision: number;
  questionCount: number;
  isPlayable: boolean;
}

/** Room creation request (without the generated request id). */
export interface CreateRoomRequest {
  requestId: string;
  quizId: string;
  quizRevision: number;
  displayMode: DisplayMode;
  friendlyNicknames: boolean;
}

/** Created room (pin is unknown when only reconciliation confirmed it). */
export interface CreatedRoom {
  sessionId: string;
  pinCode: string | null;
}

/** Reconciliation answer for a lost ACK. */
export type RoomReconcile =
  | { status: "done"; resourceId: string | null }
  | { status: "pending" | "not-received" | "unknown" };

/** Props of {@link HostConfigDialog}. */
export interface HostConfigDialogProps {
  open: boolean;
  onClose: () => void;
  quiz: HostableQuiz;
  /** The studio draft has unsaved changes. */
  dirty?: boolean;
  /** Emits `host:create_room` (e.g. `socket.emit("host:create_room", request)`). */
  createRoom: (request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>;
  /** Looks up a lost create by request id (defaults to the API operation lookup). */
  reconcileRoom?: (requestId: string) => Promise<RoomReconcile>;
  /** Called once with the created room (navigate to the host stage). */
  onCreated: (room: CreatedRoom) => void;
}

/** Dialog outcome after a failed attempt. */
type Failure =
  | { kind: "stale" }
  | { kind: "empty" }
  | { kind: "error"; messageKey: string | null; correlationId: string | null };

/** The M06 dialog. */
export function HostConfigDialog({
  open,
  onClose,
  quiz,
  dirty = false,
  createRoom,
  reconcileRoom,
  onCreated,
}: HostConfigDialogProps) {
  const { t, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const [displayMode, setDisplayMode] = useState<DisplayMode>("PROJECTOR");
  const [friendly, setFriendly] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Attempt id: kept across retries of an unconfirmed create, renewed after a definitive error. */
  const requestId = useRef<string>(crypto.randomUUID());
  const running = useRef(false);

  useEffect(() => {
    void ensureNamespaces(["host", "quizzes", "validation"]);
  }, [ensureNamespaces]);

  const reconcile = useCallback(
    (id: string): Promise<RoomReconcile> =>
      reconcileRoom ? reconcileRoom(id) : api.reconcileOperation(id, "room.create"),
    [reconcileRoom, api],
  );

  const empty = quiz.questionCount === 0 || !quiz.isPlayable || failure?.kind === "empty";
  const blocked = empty || dirty;

  /** Emits once; on a lost ACK reconciles before any retry. */
  const submit = async () => {
    if (running.current || blocked) return;
    running.current = true;
    setPending(true);
    setFailure(null);
    const request: CreateRoomRequest = {
      requestId: requestId.current,
      quizId: quiz.id,
      quizRevision: quiz.revision,
      displayMode,
      friendlyNicknames: friendly,
    };
    try {
      const result = await createRoom(request);
      if (result.status === "ok") {
        onCreated({ sessionId: result.data.sessionId, pinCode: result.data.pinCode });
        requestId.current = crypto.randomUUID();
        return;
      }
      if (result.status === "error") {
        // Definitive answer: the next attempt is a new command.
        requestId.current = crypto.randomUUID();
        const code = result.error.errorCode;
        if (code === "REVISION_CONFLICT") setFailure({ kind: "stale" });
        else if (code === "QUIZ_NOT_PLAYABLE") setFailure({ kind: "empty" });
        else
          setFailure({
            kind: "error",
            messageKey: apiErrorMessageKey(code),
            correlationId: result.error.correlationId,
          });
        return;
      }
      // Lost ACK: ask whether the room exists before retrying.
      const answer = await reconcile(request.requestId).catch((): RoomReconcile => ({
        status: "unknown",
      }));
      if (answer.status === "done" && answer.resourceId) {
        onCreated({ sessionId: answer.resourceId, pinCode: null });
        requestId.current = crypto.randomUUID();
        return;
      }
      // Not confirmed: keep the same request id so a retry is de-duplicated by the server.
      setFailure({ kind: "error", messageKey: null, correlationId: null });
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  let notice: { tone: "warning" | "error"; text: string; detail: string | null } | null = null;
  if (empty)
    notice = {
      tone: "warning",
      text: t("host.inventory.m06.empty"),
      detail: t("host.config.noPlayableQuestions"),
    };
  else if (dirty) notice = { tone: "warning", text: t("host.inventory.m06.partial"), detail: null };
  else if (failure?.kind === "stale")
    notice = {
      tone: "warning",
      text: t("host.config.saveBeforeHosting"),
      detail: t("validation.errors.revisionConflict"),
    };
  else if (failure?.kind === "error")
    notice = {
      tone: "error",
      text: t("host.inventory.m06.error"),
      detail: failure.messageKey ? t(failure.messageKey) : null,
    };

  return (
    <ModalSheet
      open={open}
      title={t("host.config.title")}
      description={t("host.inventory.m06.ideal")}
      pending={pending}
      onCloseRequest={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton variant="secondary" label={t("common.actions.cancel")} onPress={onClose} />
          {empty ? (
            <Link
              href={`/studio/${quiz.id}`}
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
            >
              {t("common.actions.edit")}
            </Link>
          ) : (
            <ActionButton
              pending={pending}
              disabled={blocked}
              {...(blocked ? { disabledReason: notice?.text ?? "" } : {})}
              label={
                failure?.kind === "error" ? t("common.actions.retry") : t("host.config.openLobby")
              }
              onPress={() => void submit()}
            />
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-body font-semibold break-words [overflow-wrap:anywhere]">
            {quiz.title}
          </p>
          <p className="text-small text-muted-foreground">
            {t("quizzes.detail.questionCount", { count: quiz.questionCount })}
          </p>
        </div>
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "note"}
            className={`flex flex-col gap-1 rounded-md border p-3 text-small ${
              notice.tone === "error"
                ? "border-danger bg-danger-surface text-danger"
                : "border-warning bg-warning-surface text-warning"
            }`}
          >
            <p>{notice.text}</p>
            {notice.detail && <p>{notice.detail}</p>}
            {failure?.kind === "error" && failure.correlationId && (
              <p className="font-mono text-caption">
                {t("common.error.correlation", { correlationId: failure.correlationId })}
              </p>
            )}
          </div>
        )}
        <ChoiceGroup
          mode="radio"
          name="displayMode"
          label={t("host.inventory.m06.title")}
          orientation="vertical"
          disabled={pending}
          items={[
            {
              id: "PROJECTOR",
              label: t("host.config.projector"),
              description: t("host.config.projectorDescription"),
            },
            {
              id: "STREAMER",
              label: t("host.config.streamer"),
              description: t("host.config.streamerDescription"),
            },
          ]}
          selected={displayMode}
          onSelect={(id) => setDisplayMode(id === "STREAMER" ? "STREAMER" : "PROJECTOR")}
        />
        <label className="flex min-h-11 items-center gap-3 text-body">
          <input
            type="checkbox"
            checked={friendly}
            disabled={pending}
            onChange={(event) => setFriendly(event.target.checked)}
            className="size-5 accent-[var(--primary)]"
          />
          {t("host.config.friendlyNicknames")}
        </label>
        <p role="status" aria-live="polite" className="text-small empty:hidden">
          {pending ? t("host.config.creatingRoom") : ""}
        </p>
      </div>
    </ModalSheet>
  );
}
