"use client";
/**
 * Music and sound credits (Audio revision 2026-10-31; US-07/13/18/19/21; TASK-130C).
 *
 * - Loads the packaged `/audio/CREDITS.md` (the byte-for-byte copy of the source credits) and
 *   renders it with a small, safe Markdown subset: headings, paragraphs, quotes, lists, tables,
 *   rules, inline code, bold/italic and links. There is no raw HTML: anything that looks like markup
 *   is shown as literal text (React escapes it). Links render only for `https:` URLs (opened in a
 *   new tab with `noopener noreferrer`) and same-origin paths; `javascript:`, `data:`, plain
 *   `http:` and other targets stay plain text.
 * - The credits keep their original language and composer metadata; the dialog chrome is
 *   translated and states that code and audio are licensed separately. The footer links to the
 *   credits file, the third-party notices and the official code license text — it never claims
 *   the code license covers the audio.
 * - States: loading, empty, ideal, partial (the credits flag discrepancies/unverified items with
 *   "⚠" or "release-unverified") and error with Retry. The dialog is the shared ModalSheet (focus
 *   trap, Escape, focus returned to `CreditsButton`).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AUDIO_CREDITS_URL } from "@kabuki-neko/shared/constants/audio";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { useLocale } from "@/providers/locale-provider";

/** Largest credits document rendered (bytes). */
const MAX_CREDITS_BYTES = 256 * 1024;

/** Safe href for a Markdown link target, or null (rendered as text). */
export function safeHref(url: string): { href: string; external: boolean } | null {
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\"))
    return { href: url, external: false };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return { href: parsed.toString(), external: true };
  } catch {
    return null;
  }
}

/** Inline Markdown → React nodes (code, links, bold, italic); everything else is text. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/gu;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const key = `${keyPrefix}-${index++}`;
    if (match[1])
      nodes.push(
        <code key={key} className="rounded-sm bg-subtle px-1">
          {match[1].slice(1, -1)}
        </code>,
      );
    else if (match[2]) {
      const label = match[3] ?? "";
      const target = safeHref(match[4] ?? "");
      nodes.push(
        target ? (
          <a
            key={key}
            href={target.href}
            {...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="text-primary underline"
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else if (match[5]) nodes.push(<strong key={key}>{renderInline(match[6] ?? "", key)}</strong>);
    else if (match[7]) nodes.push(<em key={key}>{match[8]}</em>);
    else if (match[9]) nodes.push(<em key={key}>{match[10]}</em>);
    last = at + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Cells of a Markdown table row. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Block-level Markdown → React nodes (safe subset, no HTML). */
export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const k = `b-${key++}`;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      // The dialog title is the h2: document headings start at h3.
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2);
      const Tag = `h${level}` as "h3";
      blocks.push(
        <Tag key={k} className="mt-4 text-label font-semibold break-words">
          {renderInline(heading[2] ?? "", k)}
        </Tag>,
      );
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
      blocks.push(<hr key={k} className="my-3 border-border" />);
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|"))
        rows.push(lines[i++] ?? "");
      const [header, separator, ...body] = rows;
      const hasHeader = separator !== undefined && /^\|?\s*:?-{3,}/u.test(separator.trim());
      blocks.push(
        <div
          key={k}
          className="overflow-x-auto"
          role="region"
          aria-label={cells(header ?? "").join(" · ")}
          tabIndex={0}
        >
          <table className="w-full border-collapse text-small">
            {hasHeader && (
              <thead>
                <tr>
                  {cells(header ?? "").map((cell, c) => (
                    <th key={c} scope="col" className="border-b border-border px-2 py-1 text-start">
                      {renderInline(cell, `${k}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(hasHeader ? body : rows).map((row, r) => (
                <tr key={r} className="align-top">
                  {cells(row).map((cell, c) => (
                    <td
                      key={c}
                      className="border-b border-border px-2 py-1 break-words [overflow-wrap:anywhere]"
                    >
                      {renderInline(cell, `${k}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">"))
        quote.push((lines[i++] ?? "").replace(/^>\s?/u, ""));
      blocks.push(
        <blockquote key={k} className="border-s-4 border-warning ps-3 text-small break-words">
          {renderInline(quote.join(" "), k)}
        </blockquote>,
      );
      continue;
    }
    const ordered = /^\s*\d+\.\s+/u.test(line);
    if (ordered || /^\s*[-*]\s+/u.test(line)) {
      const items: string[] = [];
      const itemPattern = ordered ? /^\s*\d+\.\s+/u : /^\s*[-*]\s+/u;
      while (i < lines.length && itemPattern.test(lines[i] ?? ""))
        items.push((lines[i++] ?? "").replace(itemPattern, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={k} className={`${ordered ? "list-decimal" : "list-disc"} ps-5 text-small`}>
          {items.map((item, n) => (
            <li key={n} className="break-words">
              {renderInline(item, `${k}-${n}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|>|\||\s*[-*]\s|\s*\d+\.\s)/u.test(lines[i] ?? "")
    )
      paragraph.push(lines[i++] ?? "");
    if (paragraph.length === 0) {
      paragraph.push(line);
      i += 1;
    }
    blocks.push(
      <p key={k} className="text-small break-words">
        {renderInline(paragraph.join(" "), k)}
      </p>,
    );
  }
  return blocks;
}

/** Load state of the credits document. */
type CreditsState = { status: "loading" } | { status: "error" } | { status: "ready"; text: string };

/** Props of {@link CreditsModal}. */
export interface CreditsModalProps {
  open: boolean;
  onClose: () => void;
  /** Credits loader (tests); defaults to fetching the packaged file. */
  loadCredits?: () => Promise<string>;
}

/** Fetches the packaged credits text. */
async function fetchCredits(): Promise<string> {
  const response = await fetch(AUDIO_CREDITS_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_CREDITS_BYTES) throw new Error("too large");
  return text;
}

/** The credits dialog. */
export function CreditsModal({ open, onClose, loadCredits }: CreditsModalProps) {
  const { t, ensureNamespaces } = useLocale();
  const [state, setState] = useState<CreditsState>({ status: "loading" });
  const loader = useRef(loadCredits ?? fetchCredits);
  loader.current = loadCredits ?? fetchCredits;

  const load = useCallback(() => {
    setState({ status: "loading" });
    loader.current().then(
      (text) => setState({ status: "ready", text }),
      () => setState({ status: "error" }),
    );
  }, []);

  useEffect(() => {
    void ensureNamespaces(["about"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const text = state.status === "ready" ? state.text.trim() : "";
  const partial =
    state.status === "ready" && (text.includes("⚠") || text.includes("release-unverified"));

  let body: ReactNode = null;
  if (state.status === "error")
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 text-small">
        <p className="text-danger">{t("about.audio.failed")}</p>
        <ActionButton variant="secondary" label={t("about.audio.retry")} onPress={load} />
      </div>
    );
  else if (state.status === "ready" && text === "")
    body = <p className="text-small text-muted-foreground">{t("about.audio.empty")}</p>;
  else if (state.status === "ready")
    body = (
      <div className="flex flex-col gap-2">
        {partial && (
          <p
            role="note"
            className="rounded-md border border-warning bg-warning-surface p-2 text-small"
          >
            {t("about.audio.incomplete")}
          </p>
        )}
        <div lang="id">{renderMarkdown(text)}</div>
      </div>
    );

  return (
    <ModalSheet
      open={open}
      title={t("about.audio.credits")}
      description={t("about.audio.codeAndAudioLicenses")}
      size="media"
      fullHeight
      state={state.status === "loading" ? "loading" : "ready"}
      onCloseRequest={onClose}
      footer={
        <nav aria-label={t("about.audio.license")} className="flex flex-wrap gap-3 text-label">
          <a
            href={AUDIO_CREDITS_URL}
            download="CREDITS.md"
            className="min-h-11 content-center text-primary underline"
          >
            {t("about.audio.downloadCredits")}
          </a>
          <a
            href="/legal/THIRD-PARTY-NOTICES.txt"
            className="min-h-11 content-center text-primary underline"
          >
            {t("about.document.thirdPartyNotices")}
          </a>
          <a href="/legal/LICENSE.txt" className="min-h-11 content-center text-primary underline">
            {t("about.document.codeLicense")}
          </a>
        </nav>
      }
    >
      {body}
    </ModalSheet>
  );
}

/** Footer/admin trigger that opens the credits dialog (focus returns here on close). */
export function CreditsButton({
  loadCredits,
  className = "min-h-11 rounded-md px-2 text-label text-primary underline hover:bg-subtle",
}: {
  loadCredits?: () => Promise<string>;
  /** Trigger styling, so footers can match their link style. */
  className?: string;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {t("about.audio.credits")}
      </button>
      <CreditsModal
        open={open}
        onClose={() => setOpen(false)}
        {...(loadCredits ? { loadCredits } : {})}
      />
    </>
  );
}
