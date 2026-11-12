"use client";
/**
 * F04 slide navigator of the quiz studio (S07; Design §4.3, §5 F04, §7.1; SA §3.1;
 * US-04/18/21; TASK-143).
 *
 * - One entry per question, keyed by its stable UUID (never the visual index). Each entry shows
 *   the position, the type, the prompt (two lines visually, full text for assistive technology)
 *   and a problem indicator when the question is incomplete. The indicator jumps to the slide's
 *   first problem (`onShowIssues`).
 * - Reordering:
 *   - dnd-kit drag handles (pointer and keyboard sensors, localized announcements);
 *   - "Move up" / "Move down" buttons as the keyboard alternative.
 *   After a move, focus stays on the same control of the moved slide, and the new position is
 *   announced ("Slide 3 of 10"). A move the parent rejects shows that the previous order was
 *   restored.
 * - Add (after the selected slide), Duplicate (the copy is selected and focused) and Delete
 *   (focus moves to a neighbour, or to "Add slide" when the last slide is gone, leaving the empty
 *   canvas). Adding stops at the quiz limit.
 * - Long lists (100–200 slides) scroll inside the panel; entries keep their DOM identity, so focus
 *   is never lost on re-render. The panel is a pure view of the studio draft, so switching mobile
 *   panels never discards anything.
 * States:
 * - loading: skeleton;
 * - empty: "No slides yet" + Add slide;
 * - ideal: the list;
 * - partial: many slides, scroll hint;
 * - error: reorder rejected, order restored.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { QuestionType } from "@kabuki-neko/shared/constants/game";
import { QUIZ_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { ActionButton } from "@/components/ui/action-button";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useLocale } from "@/providers/locale-provider";

/** From this many slides the panel says it scrolls. */
export const MANY_SLIDES = 20;

/** Catalog key of each question type label. */
export const TYPE_KEY: Record<QuestionType, string> = {
  SINGLE_CHOICE: "studio.types.singleChoice",
  TRUE_FALSE: "studio.types.trueFalse",
  MULTIPLE_SELECT: "studio.types.multipleSelect",
  TYPE_ANSWER: "studio.types.typeAnswer",
  ORDER_PUZZLE: "studio.types.orderPuzzle",
  POLL: "studio.types.poll",
};

/** One slide as the navigator shows it. */
export interface SlideSummary {
  id: string;
  type: QuestionType;
  promptText: string;
  /** Problems that block hosting (incomplete fields). */
  issueCount: number;
}

/** Props of {@link SlideNavigator}. */
export interface SlideNavigatorProps {
  slides: readonly SlideSummary[];
  selectedId: string | null;
  /** The draft is still loading. */
  loading?: boolean;
  onSelect: (id: string) => void;
  /** Adds a slide after `afterId` (null: at the end); returns the new id. */
  onAdd: (afterId: string | null) => string | null;
  /** Moves a slide to `toIndex`; false when the move was rejected (order restored). */
  onMove: (id: string, toIndex: number) => boolean;
  /** Duplicates a slide; returns the copy's id (the parent selects it). */
  onDuplicate: (id: string) => string | null;
  onDelete: (id: string) => void;
  /** Jumps to the first problem of a slide. */
  onShowIssues?: (id: string) => void;
  /** Maximum slides (shared quiz limit). */
  maxSlides?: number;
}

/** Control of a slide that can receive focus after an update. */
type ControlName = "select" | "up" | "down" | "handle";

/** F04: the studio's slide list. */
export function SlideNavigator({
  slides,
  selectedId,
  loading = false,
  onSelect,
  onAdd,
  onMove,
  onDuplicate,
  onDelete,
  onShowIssues,
  maxSlides = QUIZ_LIMITS.questions,
}: SlideNavigatorProps) {
  const { t, ensureNamespaces } = useLocale();
  const headingId = useId();
  const [announcement, setAnnouncement] = useState("");
  const [rejected, setRejected] = useState(false);
  const controls = useRef(new Map<string, HTMLElement>());
  const focusNext = useRef<{ id: string | null; control: ControlName | "add" } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const ids = slides.map((slide) => slide.id);
  const total = slides.length;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    void ensureNamespaces(["studio", "quizzes"]);
  }, [ensureNamespaces]);

  // After the parent re-renders the list, focus the requested control (DOM nodes may have moved).
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target.control === "add" || target.id === null) addButton.current?.focus();
    else controls.current.get(`${target.id}:${target.control}`)?.focus();
  }, [slides]);

  /** Position text of a slide id ("Slide 3 of 10"). */
  const positionOf = (id: string | number | null | undefined) =>
    t("studio.slides.position", { position: ids.indexOf(String(id)) + 1, total });

  /** Moves a slide and keeps focus on the control that triggered it. */
  const move = (id: string, toIndex: number, control: ControlName) => {
    if (toIndex < 0 || toIndex >= total) return;
    const accepted = onMove(id, toIndex);
    setRejected(!accepted);
    if (!accepted) return;
    focusNext.current = { id, control };
    setAnnouncement(t("studio.slides.position", { position: toIndex + 1, total }));
  };

  /** Drag end: reorder by the target's index (dropping outside changes nothing). */
  const dragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    move(String(active.id), ids.indexOf(String(over.id)), "handle");
  };

  /** Localized dnd-kit announcements (positions, never internal ids). */
  const announcements: Announcements = {
    onDragStart: ({ active }) => positionOf(active.id),
    onDragOver: ({ over }) => (over ? positionOf(over.id) : undefined),
    onDragEnd: ({ over }) => (over ? positionOf(over.id) : undefined),
    onDragCancel: ({ active }) => positionOf(active.id),
  };

  /** Registers a focusable control of a slide. */
  const register = (id: string, control: ControlName) => (element: HTMLElement | null) => {
    const key = `${id}:${control}`;
    if (element) controls.current.set(key, element);
    else controls.current.delete(key);
  };

  const add = () => {
    const created = onAdd(selectedId);
    if (created) focusNext.current = { id: created, control: "select" };
  };

  const remove = (id: string) => {
    const index = ids.indexOf(id);
    const neighbour = ids[index + 1] ?? ids[index - 1] ?? null;
    onDelete(id);
    focusNext.current = neighbour
      ? { id: neighbour, control: "select" }
      : { id: null, control: "add" };
  };

  const duplicate = (id: string) => {
    const copy = onDuplicate(id);
    if (copy) focusNext.current = { id: copy, control: "select" };
  };

  let body;
  if (loading)
    body = <SkeletonBlock layout="rows" count={4} label={t("studio.inventory.f04.loading")} />;
  else if (total === 0)
    body = (
      <p role="status" className="rounded-md border border-dashed border-border p-4 text-small">
        {t("studio.inventory.f04.empty")}
      </p>
    );
  else
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={dragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t("studio.inventory.f04.ideal") },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2">
            {slides.map((slide, index) => (
              <SortableSlide
                key={slide.id}
                slide={slide}
                index={index}
                total={total}
                selected={slide.id === selectedId}
                register={register}
                onSelect={() => onSelect(slide.id)}
                onMove={(toIndex, control) => move(slide.id, toIndex, control)}
                onDuplicate={() => duplicate(slide.id)}
                onDelete={() => remove(slide.id)}
                canDuplicate={total < maxSlides}
                {...(onShowIssues ? { onShowIssues: () => onShowIssues(slide.id) } : {})}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    );

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-col gap-3">
      <h2 id={headingId} className="text-label font-semibold">
        {t("studio.editor.slides")}
      </h2>
      {rejected && (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
        >
          {t("studio.inventory.f04.error")}
        </p>
      )}
      {total >= MANY_SLIDES && (
        <p className="text-small text-muted-foreground">{t("studio.inventory.f04.partial")}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pe-1">{body}</div>
      <ActionButton
        ref={addButton}
        variant="secondary"
        icon={<Plus />}
        label={t("studio.slides.add")}
        disabled={loading || total >= maxSlides}
        onPress={add}
      />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

/** Props of {@link SortableSlide}. */
interface SortableSlideProps {
  slide: SlideSummary;
  index: number;
  total: number;
  selected: boolean;
  canDuplicate: boolean;
  register: (id: string, control: ControlName) => (element: HTMLElement | null) => void;
  onSelect: () => void;
  onMove: (toIndex: number, control: ControlName) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onShowIssues?: () => void;
}

/** One sortable slide entry with its controls. */
function SortableSlide({
  slide,
  index,
  total,
  selected,
  canDuplicate,
  register,
  onSelect,
  onMove,
  onDuplicate,
  onDelete,
  onShowIssues,
}: SortableSlideProps) {
  const { t } = useLocale();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slide.id });
  const position = t("studio.slides.position", { position: index + 1, total });
  const iconButton =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-subtle focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:opacity-50";

  return (
    <li
      ref={setNodeRef}
      data-slide-id={slide.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-col gap-2 rounded-md border p-2 ${
        selected ? "border-primary bg-primary/10" : "border-border bg-surface"
      } ${isDragging ? "relative z-10 shadow-3" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button
          ref={(element) => {
            setActivatorNodeRef(element);
            register(slide.id, "handle")(element);
          }}
          type="button"
          aria-label={`${t("studio.slides.dragHandle")}: ${position}`}
          className={`${iconButton} cursor-grab touch-none active:cursor-grabbing`}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="size-5" />
        </button>
        <button
          ref={register(slide.id, "select")}
          type="button"
          aria-current={selected || undefined}
          onClick={onSelect}
          className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1 text-start hover:bg-subtle focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="text-caption font-semibold text-muted-foreground">
            {`${position} · ${t(TYPE_KEY[slide.type])}`}
          </span>{" "}
          <span
            dir="auto"
            className="line-clamp-2 w-full text-small break-words [overflow-wrap:anywhere]"
          >
            {slide.promptText.trim() === "" ? t("studio.question.prompt") : slide.promptText}
          </span>
          {selected && (
            <>
              {" "}
              <span className="sr-only">{t("studio.slides.selected")}</span>
            </>
          )}
        </button>
        {slide.issueCount > 0 && (
          <button
            type="button"
            onClick={onShowIssues}
            aria-label={`${t("quizzes.import.issueCount", { count: slide.issueCount })}: ${position}`}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-small font-semibold text-warning hover:bg-subtle focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <AlertTriangle aria-hidden="true" className="size-4" />
            <span aria-hidden="true" className="tabular-nums">
              {slide.issueCount}
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1 ps-12">
        <button
          ref={register(slide.id, "up")}
          type="button"
          aria-label={`${t("studio.slides.moveUp")}: ${position}`}
          aria-disabled={index === 0 || undefined}
          onClick={() => onMove(index - 1, "up")}
          className={iconButton}
        >
          <ArrowUp aria-hidden="true" className="size-4" />
        </button>
        <button
          ref={register(slide.id, "down")}
          type="button"
          aria-label={`${t("studio.slides.moveDown")}: ${position}`}
          aria-disabled={index === total - 1 || undefined}
          onClick={() => onMove(index + 1, "down")}
          className={iconButton}
        >
          <ArrowDown aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label={`${t("studio.slides.duplicate")}: ${position}`}
          aria-disabled={!canDuplicate || undefined}
          onClick={() => {
            if (canDuplicate) onDuplicate();
          }}
          className={iconButton}
        >
          <Copy aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label={`${t("studio.slides.remove")}: ${position}`}
          onClick={onDelete}
          className={`${iconButton} text-danger`}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>
    </li>
  );
}
