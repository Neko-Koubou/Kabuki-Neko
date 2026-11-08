"use client";
/**
 * Unsaved-changes guard for the studio (M10; Design §4.9, SA §6.4, US-04; TASK-126).
 *
 * - While `dirty`, the browser's native "leave site?" warning is armed through `beforeunload`
 *   (where the browser supports it); nothing is promised about keeping the draft after the tab
 *   closes — there is no offline persistence.
 * - In-app navigation goes through `requestNavigation(go)`: when clean it navigates immediately;
 *   when dirty it opens the guard instead, offering Stay, Discard (navigate without saving) and
 *   Save then continue — which waits for the save to succeed before navigating and, if it fails,
 *   stays on the page with the draft and the error visible.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Options of {@link useUnsavedChanges}. */
export interface UnsavedChangesOptions {
  dirty: boolean;
  /** Saves the draft; resolves true on success. */
  save: () => Promise<boolean>;
}

/** Guard state for the unsaved-changes dialog. */
export interface UnsavedChangesGuard {
  /** Whether the dialog should be shown. */
  open: boolean;
  /** A save started from the dialog is running. */
  saving: boolean;
  /** The last save from the dialog failed (the draft is kept). */
  failed: boolean;
  /** Navigates now when clean; otherwise opens the guard for `go`. */
  requestNavigation: (go: () => void) => void;
  /** Keep editing (closes the dialog, forgets the pending navigation). */
  stay: () => void;
  /** Leave without saving. */
  discard: () => void;
  /** Save, then leave only after the save succeeded. */
  saveThenLeave: () => Promise<void>;
}

/** Tracks pending navigation and arms the native unload warning while there are unsaved edits. */
export function useUnsavedChanges({ dirty, save }: UnsavedChangesOptions): UnsavedChangesGuard {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<(() => void) | null>(null);

  // Native warning on reload/close/external navigation while dirty.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require a returnValue to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const requestNavigation = useCallback(
    (go: () => void) => {
      if (!dirty) {
        go();
        return;
      }
      pending.current = go;
      setFailed(false);
      setOpen(true);
    },
    [dirty],
  );

  const stay = useCallback(() => {
    pending.current = null;
    setOpen(false);
  }, []);

  const discard = useCallback(() => {
    const go = pending.current;
    pending.current = null;
    setOpen(false);
    go?.();
  }, []);

  const saveThenLeave = useCallback(async () => {
    setSaving(true);
    setFailed(false);
    const saved = await save().catch(() => false);
    setSaving(false);
    if (!saved) {
      setFailed(true); // stay on the page with the draft
      return;
    }
    const go = pending.current;
    pending.current = null;
    setOpen(false);
    go?.();
  }, [save]);

  return { open, saving, failed, requestNavigation, stay, discard, saveThenLeave };
}
