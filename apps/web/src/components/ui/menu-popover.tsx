"use client";
/**
 * B05 `MenuPopover` (Design §5.1, §6.3; US-18/US-21; TASK-119): an actions menu built on Radix
 * DropdownMenu (the Shadcn base).
 *
 * - Keyboard: Enter/Space/ArrowDown open the menu with focus on the first item, arrows/Home/End and
 *   type-ahead move between items, Enter/Space run one, Escape or Tab closes it and focus returns
 *   to the trigger. Disabled items are announced but cannot run.
 * - Items carry a domain `id`; selecting one calls `onAction(id)` once and closes the menu. Item
 *   permissions are decided by the parent; the menu never invents actions.
 * - States: while `loading` the trigger stays and the menu shows "Loading actions…"; a loaded menu
 *   with no items renders nothing at all (the trigger is removed). Long translated labels wrap,
 *   and the content repositions to stay inside the viewport (16 px collision padding).
 */
import { MoreVertical } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";

/** One menu action. */
export interface MenuAction {
  id: string;
  label: ReactNode;
  disabled?: boolean;
  /** Visual danger tone (the parent still confirms destructive actions with M09). */
  destructive?: boolean;
  icon?: ReactNode;
}

/** Props of {@link MenuPopover}. */
export interface MenuPopoverProps {
  /** Accessible name of the trigger (visible unless `iconOnly`). */
  triggerLabel: string;
  /** Icon-only trigger (kebab icon by default) with `triggerLabel` as its name. */
  iconOnly?: boolean;
  triggerIcon?: ReactNode;
  items: readonly MenuAction[];
  /** Actions still loading: trigger kept, menu shows the loading text. */
  loading?: boolean;
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
  onAction: (id: string) => void;
  onOpenChange?: (open: boolean) => void;
}

/** Keyboard-accessible actions menu; renders nothing when there are no actions. */
export function MenuPopover({
  triggerLabel,
  iconOnly = false,
  triggerIcon,
  items,
  loading = false,
  placement = "bottom-end",
  onAction,
  onOpenChange,
}: MenuPopoverProps) {
  const { t } = useLocale();
  if (!loading && items.length === 0) return null;
  const [side, align] = placement.split("-") as ["bottom" | "top", "start" | "end"];

  return (
    <DropdownMenu.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenu.Trigger
        className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-md border border-border bg-panel px-3 text-label break-words text-foreground hover:bg-subtle"
        {...(iconOnly ? { "aria-label": triggerLabel } : {})}
      >
        <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-5">
          {triggerIcon ?? <MoreVertical />}
        </span>
        {!iconOnly && <span className="min-w-0">{triggerLabel}</span>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={16}
          aria-busy={loading || undefined}
          className="z-[var(--layer-menu)] flex max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[min(20rem,calc(100vw-32px))] min-w-48 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-2"
        >
          {loading ? (
            <DropdownMenu.Item
              disabled
              className="min-h-11 px-3 py-2 text-small text-muted-foreground"
            >
              <span role="status">{t("common.inventory.b05.loading")}</span>
            </DropdownMenu.Item>
          ) : (
            items.map((item) => (
              <DropdownMenu.Item
                key={item.id}
                disabled={item.disabled}
                onSelect={() => onAction(item.id)}
                className={[
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-body break-words whitespace-normal outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[highlighted]:bg-subtle",
                  item.destructive ? "text-danger" : "",
                ].join(" ")}
              >
                {item.icon && (
                  <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-5">
                    {item.icon}
                  </span>
                )}
                <span className="min-w-0">{item.label}</span>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
