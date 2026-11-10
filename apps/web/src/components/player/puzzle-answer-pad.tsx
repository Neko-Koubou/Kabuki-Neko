"use client";
/**
 * F14 order puzzle pad for ORDER_PUZZLE questions (Design §2.2, §4.6, §7.1; SA §3.1;
 * US-09/10/18/21; TASK-154).
 *
 * - Exactly the four public items, starting in the server's game order (never the key order).
 *   Each item keeps its own letter, SVG shape and color while it moves: identity follows the item,
 *   not the visual position. The accessible label always carries the letter, shape symbol and
 *   text, also in projector rooms. On narrow phones the text gets its own full-width line, so long
 *   items wrap between words.
 * - Reordering:
 *   - Every item has "Move item up" and "Move item down" buttons, named together with the item.
 *     After a move, focus stays on the same button of the moved item, and the new position is
 *     announced ("Jakarta, position 2").
 *   - A drag handle reorders with mouse, pen or touch (pointer events on the window, so moving
 *     DOM nodes never loses the gesture); the final position is announced when it ends.
 *   - At the edges the button is marked unavailable, and focus is kept.
 * - "Submit answer" sends the order as a frozen copy of the public indices (a permutation of all
 *   four), so later local changes can't alter the request payload.
 * - A stored draft is restored only for the same question while it is still editable and only if
 *   it is a valid permutation. A new question starts from its own draft or the game order.
 * - Locks: while submitting, once accepted (the sent order is shown), after answers close, during
 *   grace and while offline. Moves and drags are ignored, and nothing is sent twice or after the
 *   deadline.
 * States:
 * - loading: submitting;
 * - empty: the game order with instructions;
 * - ideal: reorder and send;
 * - partial: accepted and waiting, or grace;
 * - error: rejected, or offline lock.
 */
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import { ActionButton } from "@/components/ui/action-button";
import { useLocale } from "@/providers/locale-provider";
import {
  AnswerShape,
  AnswerStatusLine,
  COLOR_CLASS,
  SHAPE_SYMBOL,
  isAnswerLocked,
  type AnswerLockState,
  type ChoiceOption,
} from "./choice-answer-pad";

/** True when `order` is a permutation of all the items' public indices. */
export function isPuzzleOrder(
  order: readonly number[] | null | undefined,
  items: readonly ChoiceOption[],
): order is readonly number[] {
  if (!order || order.length !== items.length) return false;
  const expected = new Set(items.map((item) => item.index));
  return new Set(order).size === order.length && order.every((index) => expected.has(index));
}

/** Returns a new list with the entry at `from` moved to `to`. */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [entry] = next.splice(from, 1);
  if (entry === undefined) return next;
  next.splice(to, 0, entry);
  return next;
}

/** Props of {@link PuzzleAnswerPad}. */
export interface PuzzleAnswerPadProps extends AnswerLockState {
  questionId: string;
  /** The four public items in the server's game order. */
  items: readonly ChoiceOption[];
  /** Order already sent for this question (shown while submitting or accepted). */
  submitted?: readonly number[] | null;
  /** Stored local draft of this question (restored only while it is still editable). */
  draft?: readonly number[] | null;
  /** Reports every reorder so the game store can keep the draft for this question. */
  onDraftChange?: (order: readonly number[]) => void;
  /** Sends a frozen copy of the order (called at most once per editable period). */
  onSubmit: (order: readonly number[]) => void;
}

/** Starting order: a usable draft or the game order. */
function initialOrder(
  items: readonly ChoiceOption[],
  draft: readonly number[] | null,
  editable: boolean,
): number[] {
  return editable && isPuzzleOrder(draft, items) ? [...draft] : items.map((item) => item.index);
}

/** The ORDER_PUZZLE pad. */
export function PuzzleAnswerPad({
  questionId,
  items,
  status,
  inputOpen,
  grace = false,
  offline = false,
  submitted = null,
  draft = null,
  onDraftChange,
  onSubmit,
}: PuzzleAnswerPadProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const baseId = useId();
  const upLabelId = `${baseId}-up`;
  const downLabelId = `${baseId}-down`;
  const locked = isAnswerLocked({ status, inputOpen, grace, offline });
  const [order, setOrder] = useState(() => initialOrder(items, draft, !locked));
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const orderRef = useRef(order);
  const lastQuestion = useRef(questionId);
  const listRef = useRef<HTMLOListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    void ensureNamespaces(["player", "accessibility"]);
  }, [ensureNamespaces]);

  // A new question starts from its own draft (only while editable) or the game order.
  useEffect(() => {
    if (lastQuestion.current === questionId) return;
    lastQuestion.current = questionId;
    const next = initialOrder(items, draft, !locked);
    orderRef.current = next;
    setOrder(next);
    setAnnouncement("");
    setDragging(null);
  }, [questionId, items, draft, locked]);

  // Keyboard moves keep focus on the same button of the moved item (its DOM node may move).
  useEffect(() => {
    const key = focusAfter.current;
    if (key === null) return;
    focusAfter.current = null;
    buttons.current.get(key)?.focus();
  }, [order]);

  const byIndex = new Map(items.map((item) => [item.index, item]));
  const shown = locked && isPuzzleOrder(submitted, items) ? submitted : order;

  /** The accessible label of an item: letter, shape symbol and text. */
  const itemLabel = (item: ChoiceOption) => {
    const geometry = ANSWER_GEOMETRY[item.index] ?? ANSWER_GEOMETRY[0];
    return t("accessibility.game.optionLabel", {
      label: geometry.label,
      shape: SHAPE_SYMBOL[geometry.shape],
      text: item.text,
    });
  };

  /** Applies a new order, reports the draft and announces the item's new position. */
  const commit = (next: number[], itemIndex: number, announce: boolean) => {
    orderRef.current = next;
    setOrder(next);
    onDraftChange?.(next);
    const item = byIndex.get(itemIndex);
    if (announce && item)
      setAnnouncement(
        t("player.answer.puzzlePosition", {
          text: item.text,
          position: next.indexOf(itemIndex) + 1,
        }),
      );
  };

  /** Keyboard/button move by one position. */
  const move = (itemIndex: number, delta: -1 | 1) => {
    if (locked) return;
    const current = orderRef.current;
    const from = current.indexOf(itemIndex);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.length) return;
    focusAfter.current = `${itemIndex}:${delta < 0 ? "up" : "down"}`;
    commit(moveEntry(current, from, to), itemIndex, true);
  };

  /** Target position for a pointer at `clientY`: items (except the dragged one) above it. */
  const slotAt = (clientY: number, itemIndex: number) => {
    const list = listRef.current;
    if (!list) return null;
    let slot = 0;
    for (const element of Array.from(list.children)) {
      if (Number((element as HTMLElement).dataset.itemIndex) === itemIndex) continue;
      const rect = element.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) slot += 1;
    }
    return slot;
  };

  // While dragging, follow the pointer on the window and end on release/cancel or a lock.
  useEffect(() => {
    if (dragging === null) return;
    if (locked) {
      setDragging(null);
      return;
    }
    const onMove = (event: PointerEvent) => {
      const to = slotAt(event.clientY, dragging);
      const current = orderRef.current;
      const from = current.indexOf(dragging);
      if (to === null || to === from) return;
      commit(moveEntry(current, from, to), dragging, false);
    };
    const onEnd = () => {
      commit(orderRef.current, dragging, true);
      setDragging(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  });

  /** Starts a drag from an item's handle (primary button / touch / pen only). */
  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>, itemIndex: number) => {
    if (locked || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    setDragging(itemIndex);
  };

  /** Sends a frozen copy of the current order once. */
  const send = () => {
    if (locked) return;
    onSubmit(Object.freeze([...orderRef.current]));
  };

  /** Registers a move button for focus restoration. */
  const register = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(key, element);
    else buttons.current.delete(key);
  };

  const moveButton =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:opacity-50";

  return (
    <section aria-describedby={`${baseId}-hint`} className="flex flex-col gap-3">
      <div id={`${baseId}-hint`} className="flex flex-col gap-1 text-small text-muted-foreground">
        <p>{t("player.answer.orderPuzzle")}</p>
        <p>{t("accessibility.game.puzzleInstructions")}</p>
      </div>
      <span id={upLabelId} hidden>
        {t("accessibility.game.moveUp")}
      </span>
      <span id={downLabelId} hidden>
        {t("accessibility.game.moveDown")}
      </span>
      <ol ref={listRef} className="flex flex-col gap-2">
        {shown.map((itemIndex, position) => {
          const item = byIndex.get(itemIndex);
          if (!item) return null;
          const geometry = ANSWER_GEOMETRY[item.index] ?? ANSWER_GEOMETRY[0];
          const labelId = `${baseId}-item-${item.index}`;
          const first = position === 0;
          const last = position === shown.length - 1;
          return (
            <li
              key={item.id}
              data-item-index={item.index}
              className={`flex min-h-16 flex-wrap items-center gap-x-2 gap-y-1 rounded-md p-2 font-semibold ${COLOR_CLASS[item.index] ?? COLOR_CLASS[0]} ${
                dragging === item.index ? "outline outline-4 outline-offset-2 outline-ring" : ""
              } ${locked ? "opacity-90" : ""}`}
            >
              <span aria-hidden="true" className="w-6 shrink-0 text-center text-title tabular-nums">
                {formatNumber(position + 1)}
              </span>
              <span
                aria-hidden="true"
                data-drag-handle=""
                onPointerDown={(event) => startDrag(event, item.index)}
                className={`flex size-11 shrink-0 touch-none items-center justify-center rounded-md ${locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"}`}
              >
                <GripVertical className="size-6" />
              </span>
              <AnswerShape index={item.index} className="size-8 shrink-0" />
              <span aria-hidden="true" className="text-title font-bold">
                {geometry.label}
              </span>
              <span id={labelId} className="sr-only">
                {itemLabel(item)}
              </span>
              <span
                aria-hidden="true"
                className="order-last min-w-0 basis-full px-1 pb-1 text-body break-words min-[480px]:order-none min-[480px]:flex-1 min-[480px]:basis-0 min-[480px]:p-0"
              >
                {item.text}
              </span>
              <span className="ms-auto flex shrink-0 gap-2">
                <button
                  ref={register(`${item.index}:up`)}
                  type="button"
                  aria-labelledby={`${upLabelId} ${labelId}`}
                  aria-disabled={locked || first || undefined}
                  onClick={() => move(item.index, -1)}
                  className={moveButton}
                >
                  <ArrowUp aria-hidden="true" className="size-5" />
                </button>
                <button
                  ref={register(`${item.index}:down`)}
                  type="button"
                  aria-labelledby={`${downLabelId} ${labelId}`}
                  aria-disabled={locked || last || undefined}
                  onClick={() => move(item.index, 1)}
                  className={moveButton}
                >
                  <ArrowDown aria-hidden="true" className="size-5" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {status !== "accepted" && (
        <ActionButton
          size="lg"
          pending={status === "submitting"}
          disabled={locked && status !== "submitting"}
          label={t("player.answer.submit")}
          onPress={send}
        />
      )}
      <AnswerStatusLine status={status} inputOpen={inputOpen} grace={grace} />
    </section>
  );
}
