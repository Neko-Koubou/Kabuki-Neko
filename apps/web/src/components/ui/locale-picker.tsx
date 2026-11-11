"use client";
/**
 * Language picker (F19; Design §8.1, SA §8.2, US-21; TASK-117).
 *
 * - The trigger shows a globe icon plus the active language's native name (never a flag alone),
 *   so users can find it even in a language they cannot read.
 * - The panel is a popover on wide screens and a bottom sheet on small ones. Its heading is the
 *   localized "Language" label followed by the English one when the UI is not English.
 * - Every installed registry locale is listed (no fixed six-entry list) with its untranslated
 *   native name (`lang`/`dir` of that locale), the name localized into the current UI language and
 *   the tag; partial packages say the rest is shown in English. Search matches native name,
 *   localized name and tag, case- and accent-insensitively.
 * - Choosing a language keeps the current one active while the new catalog loads ("Loading
 *   language…" on that option); on success the panel closes and focus returns to the trigger, on
 *   failure the old language stays with an alert and a retry. "Add a language" links to the public
 *   language guide. Escape or the close button closes the panel and restores focus; clicking
 *   outside closes it without moving focus.
 */
import { Globe } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale } from "@/providers/locale-provider";

/** Props of {@link LocalePicker}. */
export interface LocalePickerProps {
  /** Public language guide (S13); defaults to the SA route. */
  guideHref?: string;
}

/** Lowercased, accent-free, compatibility-normalized text for searching. */
function searchable(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");
}

/** Language name of `tag` in `uiLocale`, or null when Intl cannot name it. */
function localizedName(names: Intl.DisplayNames | null, tag: string): string | null {
  try {
    const name = names?.of(tag);
    return name && name !== tag ? name : null;
  } catch {
    return null;
  }
}

/** Globe button plus the language list panel. */
export function LocalePicker({ guideHref = "/help/languages" }: LocalePickerProps) {
  const { locale, options, pending, error, setLocale, clearError, t, tEnglish } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const titleId = useId();
  const searchId = useId();

  const names = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      return null;
    }
  }, [locale]);
  const current = options.find((option) => option.tag === locale);
  const items = useMemo(() => {
    const needle = searchable(query.trim());
    return options
      .map((option) => ({ ...option, localized: localizedName(names, option.tag) }))
      .filter(
        (option) =>
          needle.length === 0 ||
          [option.nativeName, option.localized ?? "", option.tag].some((text) =>
            searchable(text).includes(needle),
          ),
      );
  }, [options, names, query]);

  /** Closes the panel; optionally returns focus to the trigger. */
  function close(restoreFocus: boolean) {
    setOpen(false);
    setQuery("");
    clearError();
    if (restoreFocus) triggerRef.current?.focus();
  }

  /** Switches to `tag`; closes and restores focus once the new language is active. */
  async function choose(tag: string) {
    if (await setLocale(tag)) close(true);
  }

  // Focus the search field when the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Clicking outside the trigger and panel closes the panel without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panelRef.current?.contains(target) && !triggerRef.current?.contains(target))
        close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  });

  const label = t("common.language.label");
  const englishLabel = locale === "en" ? null : tEnglish("common.language.label");

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-panel px-3 text-label text-foreground hover:bg-subtle"
      >
        <Globe aria-hidden="true" className="size-5" />
        {/* Accessible name "<Language label> <native name>", without locale-specific punctuation. */}
        <span className="sr-only">{label}</span>{" "}
        <span lang={locale} dir={current?.direction}>
          {current?.nativeName ?? locale}
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close(true);
            }
          }}
          className="fixed inset-x-0 bottom-0 z-[var(--layer-menu)] flex max-h-[80vh] flex-col gap-3 overflow-y-auto rounded-t-lg border border-border bg-popover p-4 text-popover-foreground shadow-3 md:absolute md:inset-x-auto md:bottom-auto md:end-0 md:top-full md:mt-2 md:w-80 md:rounded-md"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-title-sm">
              {label}
              {englishLabel && englishLabel !== label && (
                <>
                  {" / "}
                  <span lang="en">{englishLabel}</span>
                </>
              )}
            </h2>
            <button
              type="button"
              onClick={() => close(true)}
              className="min-h-11 rounded-md px-3 text-label hover:bg-subtle"
            >
              {t("common.actions.close")}
            </button>
          </div>
          <label htmlFor={searchId} className="text-label">
            {t("common.language.search")}
          </label>
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 rounded-md border border-input bg-background px-3 text-body"
          />
          {items.length === 0 ? (
            <p role="status" className="text-small text-muted-foreground">
              {t("common.inventory.f19.empty")}
            </p>
          ) : (
            <ul aria-label={label} className="flex flex-col gap-1">
              {items.map((option) => {
                const active = option.tag === locale;
                const loading = pending === option.tag;
                return (
                  <li key={option.tag}>
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-busy={loading || undefined}
                      onClick={() => void choose(option.tag)}
                      className="flex min-h-11 w-full flex-col items-start rounded-md px-3 py-2 text-start hover:bg-subtle aria-pressed:bg-subtle aria-pressed:font-semibold"
                    >
                      <span lang={option.tag} dir={option.direction} className="text-body">
                        {option.nativeName}
                      </span>
                      <span className="text-small text-muted-foreground">
                        {option.localized ? `${option.localized} · ` : ""}
                        <bdi>{option.tag}</bdi>
                        {option.coverage < 1 ? ` · ${t("common.language.fallback")}` : ""}
                      </span>
                      {active && <span className="sr-only">{t("common.language.current")}</span>}
                      {loading && (
                        <span role="status" className="text-small">
                          {t("common.inventory.f19.loading")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && (
            <div role="alert" className="flex items-center justify-between gap-2 text-small">
              <span>{t("common.language.switchFailed")}</span>
              <button
                type="button"
                onClick={() => void choose(error.tag)}
                className="min-h-11 rounded-md px-3 text-label hover:bg-subtle"
              >
                {t("common.actions.retry")}
              </button>
            </div>
          )}
          <a href={guideHref} className="text-label text-primary-text underline">
            {t("common.language.addLanguage")}
          </a>
        </div>
      )}
    </div>
  );
}
