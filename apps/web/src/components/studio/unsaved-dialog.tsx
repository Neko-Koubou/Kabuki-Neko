"use client";
/**
 * M10 unsaved-changes dialog for the studio and dirty forms (Design §4.9 M10, §7; SA §6.4;
 * US-04/18; TASK-136).
 *
 * Driven by `useUnsavedChanges` (the parent owns the draft, the save and the pending navigation):
 * - three stacked choices: Stay on this page (initial focus), Discard changes, Save and continue;
 * - "Save and continue" shows "Saving, then continuing…" and navigates only after the save
 *   succeeded. A failed save keeps the dialog on the page with the draft and an error, so the
 *   navigation stays blocked;
 * - `incomplete` explains that incomplete drafts can still be saved, while some problems must be
 *   fixed first;
 * - when nothing is dirty the guard navigates directly and this dialog never opens (empty state);
 * - it is the shared ModalSheet: focus trap, Escape (= stay), focus return, one active modal.
 */
import { useEffect, useRef } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import type { UnsavedChangesGuard } from "@/hooks/use-unsaved-changes";
import { useLocale } from "@/providers/locale-provider";

/** Props of {@link UnsavedDialog}. */
export interface UnsavedDialogProps {
  guard: UnsavedChangesGuard;
  /** The draft is saveable but still incomplete (partial state). */
  incomplete?: boolean;
}

/** The M10 dialog. */
export function UnsavedDialog({ guard, incomplete = false }: UnsavedDialogProps) {
  const { t, ensureNamespaces } = useLocale();
  const stayRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    void ensureNamespaces(["studio"]);
  }, [ensureNamespaces]);

  return (
    <ModalSheet
      open={guard.open}
      title={t("studio.unsaved.title")}
      description={t("studio.unsaved.description")}
      initialFocus={stayRef}
      pending={guard.saving}
      dismissOnOutside={!guard.saving}
      onCloseRequest={guard.stay}
      footer={
        <div className="flex w-full flex-col gap-2">
          <ActionButton
            ref={stayRef}
            variant="secondary"
            label={t("studio.unsaved.stay")}
            onPress={guard.stay}
          />
          <ActionButton
            variant="danger"
            label={t("studio.unsaved.discard")}
            disabled={guard.saving}
            onPress={guard.discard}
          />
          <ActionButton
            pending={guard.saving}
            label={t("studio.unsaved.saveAndContinue")}
            onPress={() => void guard.saveThenLeave()}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-small">
        <p>{t("studio.inventory.m10.ideal")}</p>
        {incomplete && (
          <p
            role="note"
            className="rounded-md border border-warning bg-warning-surface p-3 text-warning"
          >
            {t("studio.inventory.m10.partial")}
          </p>
        )}
        <p role="status" aria-live="polite" className="empty:hidden">
          {guard.saving ? t("studio.inventory.m10.loading") : ""}
        </p>
        {guard.failed && !guard.saving && (
          <p
            role="alert"
            className="rounded-md border border-danger bg-danger-surface p-3 text-danger"
          >
            {t("studio.inventory.m10.error")}
          </p>
        )}
      </div>
    </ModalSheet>
  );
}
