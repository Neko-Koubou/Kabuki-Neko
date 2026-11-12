"use client";
/**
 * B02 `FormField` (Design §5.1, §6.3; US-18/US-21; TASK-118): one labelled native control —
 * text, password, number, select or textarea — with help, counter and error wiring.
 *
 * - Stable IDs: the control uses `id` (or a `useId` fallback); help, counter and error get derived
 *   IDs and are linked through `aria-describedby`. Errors set `aria-invalid` and keep the value.
 * - `limit` shows a counter of user-perceived characters (grapheme clusters, the same
 *   `graphemeLength` the shared schemas validate with); exceeding it marks the counter but never
 *   truncates input. The value is passed through unchanged, so IME composition, paste and password
 *   managers (`autoComplete`, `name`) keep working.
 * - Required fields use `aria-required` plus a visible "Required" text (no browser-native
 *   validation bubbles, so messages stay translated).
 * - Password fields get a show/hide toggle (`aria-pressed`, reveal state local, focus kept).
 * - Select: `pending` keeps the current value while options load and says so; an unknown current
 *   value stays selectable under a labelled placeholder instead of silently changing; no options
 *   shows the "No options available." text.
 * - Controls are at least 44 px tall and long labels/help/errors wrap.
 */
import { clsx } from "clsx";
import { Eye, EyeOff } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { graphemeLength } from "@kabuki-neko/shared/unicode";
import { useLocale } from "@/providers/locale-provider";

/** Kinds of control rendered by {@link FormField}. */
export type FormFieldKind = "text" | "email" | "password" | "number" | "select" | "textarea";

/** One select option; `value` is the domain identifier, never a display index. */
export interface FieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Props of {@link FormField}. */
export interface FormFieldProps {
  kind?: FormFieldKind;
  /** Control id (stable across renders); generated when omitted. */
  id?: string;
  name?: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  required?: boolean;
  disabled?: boolean;
  /** Async options (select) or async validation in progress; the current value is kept. */
  pending?: boolean;
  help?: ReactNode;
  /** Translated error text; sets aria-invalid and is announced through the description. */
  error?: ReactNode;
  /** Maximum user-perceived characters; shows a grapheme counter. */
  limit?: number;
  options?: readonly FieldOption[];
  /** Label of the empty choice in a select (an unknown current value is labelled "Unknown"). */
  placeholderOption?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "search" | "tel" | "url";
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  /** Show/hide labels of the password toggle (default: the auth catalog's labels). */
  revealLabels?: { show: string; hide: string };
}

/** Shared control classes: 44 px minimum height, full width, visible border. */
const controlClass =
  "min-h-11 w-full rounded-md border bg-background px-3 py-2 text-body text-foreground disabled:cursor-not-allowed disabled:opacity-60";

/** Labelled native form control with help, counter, error and password reveal. */
export function FormField({
  kind = "text",
  id: providedId,
  name,
  label,
  value,
  onChange,
  onBlur,
  required = false,
  disabled = false,
  pending = false,
  help,
  error,
  limit,
  options = [],
  placeholderOption,
  placeholder,
  autoComplete,
  inputMode,
  min,
  max,
  step,
  rows = 4,
  revealLabels,
}: FormFieldProps) {
  const { t, formatNumber } = useLocale();
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const helpId = `${id}-help`;
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const [revealed, setRevealed] = useState(false);

  const length = limit !== undefined ? graphemeLength(value) : 0;
  const overLimit = limit !== undefined && length > limit;
  const invalid = error !== undefined && error !== null && error !== false;
  const isSelect = kind === "select";
  const noOptions = isSelect && !pending && options.length === 0;
  const unknownValue =
    isSelect && value !== "" && !options.some((option) => option.value === value);
  const describedBy =
    [
      help ? helpId : null,
      limit !== undefined ? counterId : null,
      pending || noOptions ? statusId : null,
      invalid ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const common = {
    id,
    name,
    disabled,
    "aria-invalid": invalid || overLimit || undefined,
    "aria-required": required || undefined,
    "aria-describedby": describedBy,
    onBlur,
    className: clsx(controlClass, invalid || overLimit ? "border-danger" : "border-input"),
  } as const;

  let control: ReactNode;
  if (isSelect) {
    control = (
      <select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        {(placeholderOption !== undefined || value === "") && (
          <option value="" disabled={required}>
            {placeholderOption ?? ""}
          </option>
        )}
        {unknownValue && <option value={value}>{t("common.status.unknown")}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (kind === "textarea") {
    control = (
      <textarea
        {...common}
        value={value}
        rows={rows}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    const inputType = kind === "password" ? (revealed ? "text" : "password") : kind;
    control = (
      <input
        {...common}
        type={inputType}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode ?? (kind === "number" ? "numeric" : undefined)}
        min={min}
        max={max}
        step={step}
        spellCheck={kind === "password" ? false : undefined}
        autoCapitalize={kind === "password" || kind === "email" ? "none" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const reveal = revealLabels ?? {
    show: t("auth.fields.showPassword"),
    hide: t("auth.fields.hidePassword"),
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-label font-semibold break-words text-foreground">
        {label}
        {required && (
          <span className="ms-2 text-small font-normal text-muted-foreground">
            {t("accessibility.controls.required")}
          </span>
        )}
      </label>
      {help && (
        <p id={helpId} className="text-small break-words text-muted-foreground">
          {help}
        </p>
      )}
      {kind === "password" ? (
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">{control}</div>
          <button
            type="button"
            aria-pressed={revealed}
            aria-controls={id}
            disabled={disabled}
            onClick={() => setRevealed((state) => !state)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input bg-panel hover:bg-subtle disabled:opacity-60"
          >
            {revealed ? (
              <EyeOff aria-hidden="true" className="size-5" />
            ) : (
              <Eye aria-hidden="true" className="size-5" />
            )}
            <span className="sr-only">{revealed ? reveal.hide : reveal.show}</span>
          </button>
        </div>
      ) : (
        control
      )}
      {(pending || noOptions) && (
        <p id={statusId} role="status" className="text-small text-muted-foreground">
          {pending ? t("common.inventory.b02.loading") : t("common.inventory.b03.empty")}
        </p>
      )}
      {limit !== undefined && (
        <p
          id={counterId}
          className={clsx(
            "text-small tabular-nums",
            overLimit ? "text-danger" : "text-muted-foreground",
          )}
        >
          <bdi>{`${formatNumber(length)} / ${formatNumber(limit)}`}</bdi>
        </p>
      )}
      {invalid && (
        <p id={errorId} className="text-small break-words text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
