"use client";
/**
 * M08 explanation dialog for the reveal (S16 ANSWER_REVEAL; Design §4.7, M08 matrix; US-11/18/21;
 * TASK-155).
 *
 * - Shows a short prompt summary and the full explanation (up to 1,000 characters) from the
 *   reveal payload already in the snapshot; nothing is fetched. Both keep their line breaks.
 *   Long text (CJK too) wraps, and the explanation scrolls in a keyboard-focusable region with a
 *   hint.
 * - Only available during the reveal. The caller shows the button only when an explanation exists,
 *   and the dialog still explains an empty one.
 * - When the reveal snapshot is unavailable (`explanationText` undefined), it says the explanation
 *   couldn't load and offers Close. The caller then re-syncs; no key is shown early.
 * States:
 * - loading: the parent is re-syncing, `pending`;
 * - empty: "No explanation for this question.";
 * - ideal: the explanation;
 * - partial: long text, with a scroll hint;
 * - error: snapshot unavailable.
 */
import { useEffect } from "react";
import { graphemeLength } from "@kabuki-neko/shared/unicode";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { useLocale } from "@/providers/locale-provider";

/** From this many characters, the explanation gets a scroll hint. */
export const LONG_EXPLANATION = 400;

/** Props of {@link ExplanationDialog}. */
export interface ExplanationDialogProps {
  open: boolean;
  /** Prompt of the revealed question (shown as a short summary). */
  promptText: string;
  /** Explanation from the reveal: text, null/blank when there is none, undefined when unavailable. */
  explanationText: string | null | undefined;
  /** The parent is re-syncing the snapshot. */
  pending?: boolean;
  onClose: () => void;
}

/** M08: the full explanation of the revealed question. */
export function ExplanationDialog({
  open,
  promptText,
  explanationText,
  pending = false,
  onClose,
}: ExplanationDialogProps) {
  const { t, ensureNamespaces } = useLocale();

  useEffect(() => {
    void ensureNamespaces(["host"]);
  }, [ensureNamespaces]);

  const unavailable = explanationText === undefined;
  const text = explanationText?.trim() ? explanationText : null;
  const long = text !== null && graphemeLength(text) >= LONG_EXPLANATION;

  return (
    <ModalSheet
      open={open}
      title={t("host.inventory.m08.title")}
      state={pending ? "loading" : "ready"}
      error={unavailable ? t("host.inventory.m08.error") : undefined}
      onCloseRequest={onClose}
      footer={
        <ActionButton variant="secondary" label={t("common.actions.close")} onPress={onClose} />
      }
    >
      <div className="flex flex-col gap-3">
        <p
          dir="auto"
          className="line-clamp-3 text-small whitespace-pre-line break-words text-muted-foreground"
        >
          {promptText}
        </p>
        {!unavailable && text === null && (
          <p role="status" className="text-body text-muted-foreground">
            {t("host.inventory.m08.empty")}
          </p>
        )}
        {text !== null && (
          <>
            {long && (
              <p className="text-small text-muted-foreground">{t("host.inventory.m08.partial")}</p>
            )}
            <div
              role="region"
              aria-label={t("host.inventory.m08.ideal")}
              tabIndex={0}
              dir="auto"
              className="max-h-[50vh] overflow-y-auto rounded-md border border-border p-3 text-body whitespace-pre-line break-words [overflow-wrap:anywhere] focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {text}
            </div>
          </>
        )}
      </div>
    </ModalSheet>
  );
}
