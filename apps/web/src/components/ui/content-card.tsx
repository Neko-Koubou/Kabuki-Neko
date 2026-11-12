"use client";
/**
 * B09 `ContentCard` (Design §5.1, §6.3; US-18/US-21; TASK-121): a quiz/media/report card with a
 * single, unambiguous primary link.
 *
 * - The heading is the only link (or button, with `onOpen`); actions render in their own row and
 *   are never nested inside it, so no click target is ambiguous and every control has one name.
 * - The title is visually clamped to two lines on the card, but the full text stays in the DOM
 *   (screen readers and the detail page get the whole title); long words and CJK text wrap.
 * - Cover: reserved 16:9 box; a broken image falls back to a neutral placeholder with "The cover
 *   image isn't available." instead of a broken icon — also when it failed before hydration
 *   (checked with `img.decode()` on mount). Covers are decorative unless `alt` is given.
 * - States: `loading` (stable skeleton with one label), `missing` ("This item no longer exists."),
 *   `error` ("This item couldn't load." + optional Retry), `ready`.
 */
import { clsx } from "clsx";
import { ImageOff } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";
import { SkeletonBlock } from "./skeleton-block";

/** One metadata entry (label/value pair rendered as a description list). */
export interface CardMeta {
  label: ReactNode;
  value: ReactNode;
}

/** Props of {@link ContentCard}. */
export interface ContentCardProps {
  heading?: string;
  headingLevel?: 2 | 3 | 4;
  /** Navigation target of the heading link. */
  href?: string;
  /** Alternative to `href`: the heading becomes a button. */
  onOpen?: () => void;
  /** Optional cover; `alt` empty/omitted = decorative. */
  media?: { src: string; alt?: string } | null;
  metadata?: readonly CardMeta[];
  badges?: ReactNode;
  /** Buttons/menus rendered outside the heading link. */
  actions?: ReactNode;
  state?: "loading" | "missing" | "error" | "ready";
  onRetry?: () => void;
}

/** Card with one heading link, metadata, cover fallback and separate actions. */
export function ContentCard({
  heading = "",
  headingLevel = 3,
  href,
  onOpen,
  media,
  metadata = [],
  badges,
  actions,
  state = "ready",
  onRetry,
}: ContentCardProps) {
  const { t } = useLocale();
  const [coverFailed, setCoverFailed] = useState(false);
  const Heading = `h${headingLevel}` as const;
  const frame =
    "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground";

  if (state === "loading")
    return (
      <article className={frame}>
        <SkeletonBlock layout="card" label={t("common.inventory.b09.loading")} />
      </article>
    );
  if (state === "missing" || state === "error")
    return (
      <article className={clsx(frame, "border-dashed")}>
        <p
          role={state === "error" ? "alert" : undefined}
          className="text-small text-muted-foreground"
        >
          {state === "error" ? t("common.inventory.b09.error") : t("common.inventory.b09.empty")}
        </p>
        {state === "error" && onRetry && (
          <div>
            <ActionButton variant="secondary" label={t("common.actions.retry")} onPress={onRetry} />
          </div>
        )}
      </article>
    );

  const title = (
    // Visually clamped; the full title remains available to assistive technology.
    <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">{heading}</span>
  );
  let primary: ReactNode = title;
  if (href)
    primary = (
      <Link href={href} className="rounded-sm text-foreground underline-offset-4 hover:underline">
        {title}
      </Link>
    );
  else if (onOpen)
    primary = (
      <button
        type="button"
        onClick={onOpen}
        className="min-h-11 rounded-sm text-start text-foreground underline-offset-4 hover:underline"
      >
        {title}
      </button>
    );

  return (
    <article className={frame}>
      {media && (
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-subtle">
          {coverFailed ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-small text-muted-foreground">
              <ImageOff aria-hidden="true" className="size-6" />
              <span>{t("common.inventory.b09.partial")}</span>
            </div>
          ) : (
            // Plain <img>: user media from the API, not a static asset for next/image.
            <img
              src={media.src}
              alt={media.alt ?? ""}
              loading="lazy"
              decoding="async"
              onError={() => setCoverFailed(true)}
              // An SSR-rendered image can fail before hydration attaches onError: check on mount.
              ref={(node) => {
                if (node && typeof node.decode === "function")
                  node.decode().catch(() => setCoverFailed(true));
              }}
              className="h-full w-full object-cover"
            />
          )}
        </div>
      )}
      <Heading className="text-title-sm">{primary}</Heading>
      {badges && <div className="flex flex-wrap gap-2">{badges}</div>}
      {metadata.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          {metadata.map((entry, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </article>
  );
}
