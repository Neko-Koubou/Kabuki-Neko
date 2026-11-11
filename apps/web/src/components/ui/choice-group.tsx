"use client";
/**
 * B03 `ChoiceGroup` (Design §5.1, §6.3; US-18/US-21; TASK-118): single choice (radio), multiple
 * choice (checkbox) or tabs over items identified by their domain `id`, never by visual index.
 *
 * - Radio/checkbox use native inputs inside a `fieldset`/`legend`, so keyboard behaviour and
 *   labelling are the browser's own. Each option is a full-width ≥ 44 px label that wraps long
 *   translated text; the selected option shows a check mark and tint, distinct from the focus ring.
 * - Tabs follow the ARIA tabs pattern with manual activation: arrow keys/Home/End move focus
 *   (roving tabindex) without changing the selection; Enter/Space selects. Disabled tabs are
 *   skipped. Horizontal tabs scroll inside their own container instead of overflowing the page.
 * - Selection is controlled by the parent. `pending` makes the group non-interactive and says
 *   "Loading choices…" while keeping the current selection; no items shows "No options
 *   available." plus an optional parent action; `error` is linked through `aria-describedby` and
 *   leaves the last selection untouched. Disabled items can carry a visible reason.
 */
import { clsx } from "clsx";
import { Check } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";

/** One choice; `id` is the stable domain identifier. */
export interface ChoiceItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Visible explanation shown for a disabled item. */
  disabledReason?: ReactNode;
}

/** Props shared by every mode. */
interface BaseProps {
  label: ReactNode;
  items: readonly ChoiceItem[];
  orientation?: "horizontal" | "vertical";
  pending?: boolean;
  disabled?: boolean;
  error?: ReactNode;
  help?: ReactNode;
  /** Parent action offered when there are no items (e.g. "Create one"). */
  emptyAction?: ReactNode;
  /** Hide the legend visually (it stays the accessible group name). */
  hideLabel?: boolean;
}

/** Single selection with radio buttons. */
interface RadioProps extends BaseProps {
  mode: "radio";
  selected: string | null;
  onSelect: (id: string) => void;
  name?: string;
}

/** Multiple selection with checkboxes. */
interface CheckboxProps extends BaseProps {
  mode: "checkbox";
  selected: readonly string[];
  onSelect: (ids: string[]) => void;
  name?: string;
}

/** Tabs; `panelIdFor` links each tab to the panel it controls. */
interface TabsProps extends BaseProps {
  mode: "tabs";
  selected: string | null;
  onSelect: (id: string) => void;
  panelIdFor?: (id: string) => string;
}

/** Props of {@link ChoiceGroup}. */
export type ChoiceGroupProps = RadioProps | CheckboxProps | TabsProps;

/** DOM-safe id fragment derived from a domain id (identity stays the domain id itself). */
function domId(base: string, id: string): string {
  return `${base}-${encodeURIComponent(id)}`;
}

/** Radio, checkbox or tabs group with the five design states. */
export function ChoiceGroup(props: ChoiceGroupProps) {
  const { t } = useLocale();
  const baseId = useId();
  const helpId = `${baseId}-help`;
  const errorId = `${baseId}-error`;
  const statusId = `${baseId}-status`;
  const { items, pending = false, disabled = false, error, help, emptyAction } = props;
  const invalid = error !== undefined && error !== null && error !== false;
  const empty = !pending && items.length === 0;
  const describedBy =
    [help ? helpId : null, pending || empty ? statusId : null, invalid ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const status = (pending || empty) && (
    <div id={statusId} role="status" className="flex flex-wrap items-center gap-2 text-small">
      <span className="text-muted-foreground">
        {pending ? t("common.inventory.b03.loading") : t("common.inventory.b03.empty")}
      </span>
      {empty && emptyAction}
    </div>
  );
  const helpNode = help && (
    <p id={helpId} className="text-small break-words text-muted-foreground">
      {help}
    </p>
  );
  const errorNode = invalid && (
    <p id={errorId} className="text-small break-words text-danger">
      {error}
    </p>
  );

  if (props.mode === "tabs")
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Tabs {...props} baseId={baseId} describedBy={describedBy} blocked={pending || disabled} />
        {helpNode}
        {status}
        {errorNode}
      </div>
    );

  const multiple = props.mode === "checkbox";
  const name = props.name ?? baseId;
  const isSelected = (id: string) =>
    multiple ? props.selected.includes(id) : props.selected === id;

  /** Applies a change from one native input. */
  function change(id: string, checked: boolean) {
    if (props.mode === "checkbox") {
      const next = checked
        ? [...props.selected.filter((item) => item !== id), id]
        : props.selected.filter((item) => item !== id);
      props.onSelect(next);
    } else if (checked) props.onSelect(id);
  }

  return (
    <fieldset
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className="flex min-w-0 flex-col gap-2 border-0 p-0"
    >
      <legend
        className={clsx(
          "text-label font-semibold break-words text-foreground",
          props.hideLabel && "sr-only",
        )}
      >
        {props.label}
      </legend>
      {helpNode}
      {items.length > 0 && (
        <div
          className={clsx(
            "flex gap-2",
            props.orientation === "horizontal" ? "flex-row flex-wrap" : "flex-col",
          )}
        >
          {items.map((item) => {
            const inputId = domId(baseId, item.id);
            const selected = isSelected(item.id);
            const reasonId = `${inputId}-reason`;
            const descriptionId = `${inputId}-description`;
            const titleId = `${inputId}-title`;
            return (
              <label
                key={item.id}
                htmlFor={inputId}
                className={clsx(
                  "flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md border px-3 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                  selected ? "border-primary bg-subtle" : "border-border bg-panel hover:bg-subtle",
                )}
              >
                <input
                  id={inputId}
                  type={multiple ? "checkbox" : "radio"}
                  name={name}
                  value={item.id}
                  checked={selected}
                  disabled={item.disabled}
                  // Name = the title only; description and reason are the accessible description.
                  aria-labelledby={titleId}
                  aria-describedby={
                    [
                      item.description ? descriptionId : null,
                      item.disabled && item.disabledReason ? reasonId : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  onChange={(event) => change(item.id, event.target.checked)}
                  className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span id={titleId} className="text-body break-words">
                    {item.label}
                  </span>
                  {item.description && (
                    <span
                      id={descriptionId}
                      className="text-small break-words text-muted-foreground"
                    >
                      {item.description}
                    </span>
                  )}
                  {item.disabled && item.disabledReason && (
                    <span id={reasonId} className="text-small break-words text-muted-foreground">
                      {item.disabledReason}
                    </span>
                  )}
                </span>
                {selected && (
                  <Check aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary-text" />
                )}
              </label>
            );
          })}
        </div>
      )}
      {status}
      {errorNode}
    </fieldset>
  );
}

/** ARIA tabs with roving focus and manual activation. */
function Tabs({
  label,
  items,
  selected,
  onSelect,
  panelIdFor,
  orientation = "horizontal",
  hideLabel,
  baseId,
  describedBy,
  blocked,
}: TabsProps & { baseId: string; describedBy: string | undefined; blocked: boolean }) {
  const enabled = items.filter((item) => !item.disabled);
  const initialFocus = selected ?? enabled[0]?.id ?? null;
  const [focused, setFocused] = useState<string | null>(initialFocus);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const labelId = `${baseId}-label`;
  // The roving tab stop: the focused tab if it still exists, else the selected/first enabled tab.
  const tabStop = enabled.some((item) => item.id === focused) ? focused : initialFocus;

  /** Moves focus to the enabled tab `offset` steps away (wrapping), or to the first/last. */
  function move(event: KeyboardEvent<HTMLButtonElement>, current: string) {
    const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const previous = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const index = enabled.findIndex((item) => item.id === current);
    let target: string | undefined;
    if (event.key === next) target = enabled[(index + 1) % enabled.length]?.id;
    else if (event.key === previous)
      target = enabled[(index - 1 + enabled.length) % enabled.length]?.id;
    else if (event.key === "Home") target = enabled[0]?.id;
    else if (event.key === "End") target = enabled[enabled.length - 1]?.id;
    if (target === undefined) return;
    event.preventDefault();
    setFocused(target);
    refs.current.get(target)?.focus();
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span
        id={labelId}
        className={clsx("text-label font-semibold text-foreground", hideLabel && "sr-only")}
      >
        {label}
      </span>
      <div
        role="tablist"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-orientation={orientation}
        aria-busy={blocked || undefined}
        className={clsx(
          // Padding keeps the 2 px focus outline visible inside the scroll container.
          "flex gap-1 p-1",
          orientation === "horizontal" ? "flex-row overflow-x-auto" : "flex-col",
        )}
      >
        {items.map((item) => {
          const active = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) refs.current.set(item.id, node);
                else refs.current.delete(item.id);
              }}
              id={domId(baseId, item.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelIdFor?.(item.id)}
              aria-disabled={item.disabled || blocked || undefined}
              tabIndex={item.id === tabStop ? 0 : -1}
              onFocus={() => setFocused(item.id)}
              onKeyDown={(event) => move(event, item.id)}
              onClick={() => {
                if (!item.disabled && !blocked) onSelect(item.id);
              }}
              className={clsx(
                "min-h-11 shrink-0 rounded-t-md border-b-2 px-4 py-2 text-label break-words aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
                active
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-subtle",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
