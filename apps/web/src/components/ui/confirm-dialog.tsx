"use client";
/**
 * M09 confirmation dialog and its action controller (Design §4.9 M09, §7; SA §6.4;
 * US-03/04/06/07/15/18; TASK-136).
 *
 * - The dialog always names the target ("Affected item: …"), states the impact (for example "It
 *   can't be restored"), and offers Cancel plus a specific action ("Delete quiz", never "OK").
 *   Cancel has the initial focus. It is the shared ModalSheet: focus trap, Escape, focus return,
 *   one active modal.
 * - `useConfirmAction` keeps the operation in the parent: closing the dialog while the action is
 *   pending never cancels it; reopening shows it still pending; the parent's `onDone` runs when
 *   it really succeeds, even if the dialog was closed meanwhile.
 * - Outcomes never pretend success:
 *   - a missing target (404) → "This item no longer exists" with Close only;
 *   - denied (403) or a referential/role conflict (409) → "This action isn't allowed right now"
 *     with the safe reason;
 *   - a definitive failure → error with Try again;
 *   - an ambiguous outcome (lost response) → the optional `reconcile` check decides; "unknown"
 *     stays an error with the reference ID.
 * States: loading (Confirming…, target still visible), empty (target gone), ideal (target +
 * impact + CTA), partial (not allowed + reason) and error (not completed, retry).
 */
import { useCallback, useRef, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { ApiError, apiErrorMessageKey } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";

/** Result of a confirmed action that did not simply succeed. */
export type ConfirmResult =
  | { status: "missing" }
  | { status: "blocked"; reasonKey: string | null }
  | { status: "failed"; reasonKey: string | null; correlationId: string | null };

/** Conflict codes that mean "not allowed right now" rather than a transient failure. */
const BLOCKING_CODES = new Set([
  "FORBIDDEN",
  "MEDIA_IN_USE",
  "LAST_SUPERADMIN",
  "REVISION_CONFLICT",
  "ROOM_ACTIVE",
  "RESOURCE_BUSY",
  "FINALIZATION_PENDING",
  "OPERATION_PENDING",
  "INVITE_UNAVAILABLE",
]);

/** Answer of a reconciliation check after an ambiguous outcome. */
export type ReconcileAnswer = "done" | "not-done" | "unknown";

/** Maps a thrown error to a dialog result (`null` = ambiguous: reconcile first). */
export function confirmResultFromError(error: unknown): ConfirmResult | null {
  if (!(error instanceof ApiError)) return null;
  if (error.uncertain) return null;
  if (error.code === "NOT_FOUND") return { status: "missing" };
  if (BLOCKING_CODES.has(error.code))
    return { status: "blocked", reasonKey: apiErrorMessageKey(error.code) };
  return {
    status: "failed",
    reasonKey:
      error.code === "INTERNAL_ERROR" || error.status === 0 ? null : apiErrorMessageKey(error.code),
    correlationId: error.correlationId,
  };
}

/** Options of {@link useConfirmAction}. */
export interface ConfirmActionOptions {
  /** Performs the action; throws (preferably an ApiError) when it did not succeed. */
  run: () => Promise<void>;
  /** Called once when the action succeeded (also after the dialog was closed). */
  onDone?: () => void;
  /** Checks whether an ambiguous request took effect (e.g. re-fetch the target). */
  reconcile?: () => Promise<ReconcileAnswer>;
}

/** Controller for a confirmation: dialog visibility plus the parent-owned pending operation. */
export interface ConfirmController {
  open: boolean;
  pending: boolean;
  result: ConfirmResult | null;
  /** Opens the dialog (keeps a still-pending operation). */
  request: () => void;
  /** Closes the dialog; a pending operation continues and still reports to the parent. */
  cancel: () => void;
  /** Runs the action once at a time. */
  confirm: () => Promise<void>;
}

/** Owns a confirmable action for a parent component. */
export function useConfirmAction(options: ConfirmActionOptions): ConfirmController {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);

  const request = useCallback(() => {
    if (!running.current) setResult(null);
    setOpen(true);
  }, []);
  const cancel = useCallback(() => setOpen(false), []);

  const confirm = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setResult(null);
    let outcome: ConfirmResult | "done";
    try {
      await latest.current.run();
      outcome = "done";
    } catch (error) {
      const mapped = confirmResultFromError(error);
      if (mapped) outcome = mapped;
      else {
        // Ambiguous: never report success unless the target confirms it.
        const answer = await (
          latest.current.reconcile?.() ?? Promise.resolve("unknown" as const)
        ).catch(() => "unknown" as const);
        outcome =
          answer === "done"
            ? "done"
            : {
                status: "failed",
                reasonKey: answer === "unknown" ? "auth.recovery.uncertainRequest" : null,
                correlationId: error instanceof ApiError ? error.correlationId : null,
              };
      }
    }
    running.current = false;
    setPending(false);
    if (outcome === "done") {
      setOpen(false);
      latest.current.onDone?.();
    } else setResult(outcome);
  }, []);

  return { open, pending, result, request, cancel, confirm };
}

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  controller: ConfirmController;
  /** Impact statement, e.g. `t("common.confirm.deleteQuiz")`. */
  impact: string;
  /** Target name (null when the target is already gone). */
  targetName: string | null;
  /** Specific action label, e.g. "Delete quiz". */
  confirmLabel: string;
  /** Dialog title (default: the translated "Confirm action"). */
  title?: string;
  /** Danger styling for destructive actions. */
  destructive?: boolean;
}

/** M09 confirmation dialog. */
export function ConfirmDialog({
  controller,
  impact,
  targetName,
  confirmLabel,
  title,
  destructive = true,
}: ConfirmDialogProps) {
  const { t, has } = useLocale();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const { open, pending, result, cancel, confirm } = controller;
  const missing = targetName === null || result?.status === "missing";
  const blocked = result?.status === "blocked";

  /** Translated reason when its namespace is loaded. */
  const reason = (key: string | null) => (key && has(key) ? t(key) : null);

  let notice: {
    tone: "error" | "warning";
    text: string;
    detail: string | null;
    reference: string | null;
  } | null = null;
  if (result?.status === "blocked")
    notice = {
      tone: "warning",
      text: t("common.inventory.m09.partial"),
      detail: reason(result.reasonKey),
      reference: null,
    };
  else if (result?.status === "failed")
    notice = {
      tone: "error",
      text: t("common.inventory.m09.error"),
      detail: reason(result.reasonKey),
      reference: result.correlationId,
    };

  return (
    <ModalSheet
      open={open}
      title={title ?? t("common.inventory.m09.title")}
      description={missing ? t("common.inventory.m09.empty") : impact}
      initialFocus={cancelRef}
      pending={pending}
      onCloseRequest={cancel}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton
            ref={cancelRef}
            variant="secondary"
            label={missing || blocked ? t("common.actions.close") : t("common.actions.cancel")}
            onPress={cancel}
          />
          {!missing && !blocked && (
            <ActionButton
              variant={destructive ? "danger" : "primary"}
              pending={pending}
              label={confirmLabel}
              onPress={() => void confirm()}
            />
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-small">
        {!missing && targetName !== null && (
          <p className="font-semibold break-words [overflow-wrap:anywhere]">
            {t("common.confirm.namedTarget", { name: targetName })}
          </p>
        )}
        <p role="status" aria-live="polite" className="empty:hidden">
          {pending ? t("common.inventory.m09.loading") : ""}
        </p>
        {notice && (
          <div
            role="alert"
            className={`flex flex-col gap-1 rounded-md border p-3 ${
              notice.tone === "error"
                ? "border-danger bg-danger-surface text-danger"
                : "border-warning bg-warning-surface text-warning"
            }`}
          >
            <p>{notice.text}</p>
            {notice.detail && <p>{notice.detail}</p>}
            {notice.reference && /^[A-Za-z0-9_-]{1,128}$/u.test(notice.reference) && (
              <p className="font-mono text-caption break-all">
                {t("common.error.correlation", { correlationId: notice.reference })}
              </p>
            )}
          </div>
        )}
      </div>
    </ModalSheet>
  );
}
