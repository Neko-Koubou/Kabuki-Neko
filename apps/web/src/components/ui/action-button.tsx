"use client";
/**
 * B01 `ActionButton` (Design §5.1, §6.3; US-18/US-21; TASK-118): the one native button used for
 * every action, text or icon-only.
 *
 * - Always a native `<button>` (default `type="button"`), at least 44×44 px (`size="lg"`: 48 px
 *   tall for primary mobile actions); long translated labels wrap instead of truncating.
 * - `pending` keeps the visible label, adds a spinner and a "Working…" status for assistive
 *   technology, sets `aria-busy`/`aria-disabled` but keeps focus, and blocks further presses —
 *   including form submission — so a request cannot be sent twice.
 * - `disabled` uses the native attribute; with `disabledReason` the button instead stays
 *   focusable (`aria-disabled`) and its description says why it is unavailable (Design §6.3).
 *   The reason is exposed to assistive technology; parents show it visibly where layout allows.
 * - Icon-only buttons must provide `accessibleName` (enforced by the props type); the icon itself
 *   is hidden from assistive technology.
 */
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { LoaderCircle } from "lucide-react";
import { useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from "react";
import { twMerge } from "tailwind-merge";
import { useLocale } from "@/providers/locale-provider";

/** Visual intent of the button. */
export type ActionButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Variant/size styles; every size keeps the 44 px minimum target. */
const buttonStyles = cva(
  "inline-flex max-w-full items-center justify-center gap-2 rounded-md border text-label font-semibold whitespace-normal break-words text-center transition-colors duration-[var(--motion-press)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60 disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/90 aria-disabled:hover:bg-primary",
        secondary: "border-border bg-panel text-foreground hover:bg-subtle",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-subtle",
        danger:
          "border-transparent bg-destructive text-primary-foreground hover:bg-destructive/90 aria-disabled:hover:bg-destructive",
      },
      size: {
        md: "min-h-11 min-w-11 px-4 py-2",
        lg: "min-h-12 min-w-12 px-5 py-3",
      },
      iconOnly: { true: "px-0 py-0", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", iconOnly: false },
  },
);

/** Props shared by text and icon-only buttons. */
interface BaseProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "disabled" | "aria-label"
> {
  variant?: ActionButtonVariant;
  size?: "md" | "lg";
  /** Request in flight (controlled by the parent): label kept, presses ignored. */
  pending?: boolean;
  disabled?: boolean;
  /** Why the action is unavailable; keeps the disabled button focusable and described. */
  disabledReason?: string;
  /** Optional leading icon (decorative). */
  icon?: ReactNode;
  onPress?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Ref to the native button (React 19 ref-as-prop), e.g. a dialog's initial focus target. */
  ref?: Ref<HTMLButtonElement>;
}

/** Text button: the label is the accessible name. */
interface TextButtonProps extends BaseProps {
  label: ReactNode;
  iconOnly?: false;
  accessibleName?: string;
}

/** Icon-only button: `accessibleName` is mandatory. */
interface IconButtonProps extends BaseProps {
  iconOnly: true;
  icon: ReactNode;
  accessibleName: string;
  label?: never;
}

/** Props of {@link ActionButton}. */
export type ActionButtonProps = TextButtonProps | IconButtonProps;

/** Native action button with pending, disabled-with-reason and icon-only variants. */
export function ActionButton(props: ActionButtonProps) {
  const {
    variant,
    size,
    pending = false,
    disabled = false,
    disabledReason,
    icon,
    onPress,
    className,
    type = "button",
    iconOnly = false,
    accessibleName,
    label,
    ...rest
  } = props;
  const { t } = useLocale();
  const reasonId = useId();
  const softDisabled = disabled && disabledReason !== undefined;
  const blocked = pending || disabled;
  const describedBy = [rest["aria-describedby"], softDisabled ? reasonId : undefined]
    .filter(Boolean)
    .join(" ");

  /** Ignores presses while pending/disabled (also stops form submission). */
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (blocked) {
      event.preventDefault();
      return;
    }
    onPress?.(event);
  }

  return (
    <>
      <button
        {...rest}
        type={type}
        disabled={disabled && !softDisabled}
        aria-disabled={pending || softDisabled || undefined}
        aria-busy={pending || undefined}
        aria-label={accessibleName}
        aria-describedby={describedBy || undefined}
        onClick={handleClick}
        className={twMerge(clsx(buttonStyles({ variant, size, iconOnly }), className))}
      >
        {pending ? (
          <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin" />
        ) : (
          icon && (
            <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-5">
              {icon}
            </span>
          )
        )}
        {!iconOnly && <span className="min-w-0">{label}</span>}
        {pending && <span className="sr-only">{t("common.inventory.b01.loading")}</span>}
      </button>
      {softDisabled && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </>
  );
}
