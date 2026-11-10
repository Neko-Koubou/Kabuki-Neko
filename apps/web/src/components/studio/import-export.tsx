"use client";
/**
 * M04 / F07 quiz import dialog and template downloads (Design §4.9 M04, §7; SA §7.2;
 * US-05/06/21; TASK-140).
 *
 * - Accepts one `.json` (Kabuki Neko export) or `.csv` (template) file up to 5 MiB; anything else
 *   is rejected before upload. JSON and CSV templates download through the authenticated API.
 * - Media references in the file (the JSON `media` list, or the CSV `media_ref` column) can be
 *   mapped to the user's own READY assets of the same kind (`mediaMap`), because the server never
 *   downloads public URLs and only accepts owned media. Unmapped references are left to the
 *   server, which reports each missing location.
 * - `POST /quizzes/import` (multipart `file` + optional `mediaMap`) is sent with an
 *   Idempotency-Key. The server validates everything before one atomic commit, so there is no
 *   preview step and never a partial quiz:
 *   - success opens the new quiz in the studio;
 *   - validation failures list up to 200 problems with their row/column (or path) and the total
 *     count;
 *   - an unknown outcome (lost response) is looked up through the operation key (`quiz.import`)
 *     before anything is re-sent; "not received" allows a retry with the same key.
 * States: empty (no file), loading (uploading and checking), ideal (imported → opening the
 * studio), partial (format/version/row problems listed) and error (failed or unconfirmed: check
 * the status before retrying).
 */
import { Download, FileUp } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { IMPORT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import type { Issue } from "@kabuki-neko/shared/errors";
import { mediaPageSchema } from "@kabuki-neko/shared/schemas/media.schema";
import { quizDetailSchema, type QuizDetail } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { ApiError, apiErrorMessageKey, saveBlob } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Import file formats. */
export type ImportFormat = "json" | "csv";

/** A media reference found in the file. */
export interface MediaReference {
  ref: string;
  /** Kind of media expected (unknown for CSV references). */
  kind: "image" | "audio" | "video" | null;
  /** Original file name (JSON exports) for the mapping label. */
  name: string;
}

/** Format of a chosen file from its extension (MIME is corroborated by the server parser). */
export function detectFormat(file: Pick<File, "name">): ImportFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".csv")) return "csv";
  return null;
}

/** RFC 4180 parser (quotes, doubled quotes, CRLF/LF, optional BOM); no evaluation of cells. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value !== ""));
}

/** UUID shape of media references. */
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Kind of media from a MIME type. */
function kindOf(mimeType: unknown): MediaReference["kind"] {
  if (typeof mimeType !== "string") return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

/**
 * Media references of a file, for the mapping step. Unreadable files yield none (the server
 * reports the real problems with their locations).
 */
export function referencedMedia(format: ImportFormat, text: string): MediaReference[] {
  const found = new Map<string, MediaReference>();
  try {
    if (format === "json") {
      const parsed: unknown = JSON.parse(text);
      const media = (parsed as { media?: unknown }).media;
      if (Array.isArray(media))
        for (const entry of media.slice(0, IMPORT_LIMITS.mediaMapEntries)) {
          const { ref, mimeType, originalName } = (entry ?? {}) as Record<string, unknown>;
          if (typeof ref === "string" && REF.test(ref))
            found.set(ref, {
              ref,
              kind: kindOf(mimeType),
              name: typeof originalName === "string" ? originalName : ref,
            });
        }
    } else {
      const [header, ...rows] = parseCsvRows(text);
      const column = header?.indexOf("media_ref") ?? -1;
      if (column >= 0)
        for (const cells of rows) {
          const ref = cells[column]?.trim() ?? "";
          if (REF.test(ref) && found.size < IMPORT_LIMITS.mediaMapEntries)
            found.set(ref, { ref, kind: null, name: ref });
        }
    }
  } catch {
    return [];
  }
  return [...found.values()];
}

/** Human location of an import issue: "Row 3, column options_json" or the raw path. */
export function issueLocation(
  issue: Issue,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const { row, column } = issue.params as { row?: unknown; column?: unknown };
  if (typeof row === "number" && typeof column === "string")
    return t("quizzes.import.issueLocation", { row, column });
  return issue.path;
}

/** One of the user's media files offered for mapping. */
interface OwnedMedia {
  id: string;
  name: string;
  kind: MediaReference["kind"];
}

/** Dialog phase. */
type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "done" }
  | { kind: "problems"; issues: Issue[]; total: number; message: string | null }
  | { kind: "failed"; message: string | null; canCheck: boolean };

/** Props of {@link ImportDialog}. */
export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** The created quiz (the caller opens it in the studio). */
  onImported: (quiz: QuizDetail) => void;
  /** Saves template downloads (defaults to a temporary object-URL link). */
  save?: (blob: Blob, filename: string) => void;
}

/** The M04 import dialog. */
export function ImportDialog({ open, onClose, onImported, save = saveBlob }: ImportDialogProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const inputId = useId();
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [refs, setRefs] = useState<MediaReference[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [owned, setOwned] = useState<OwnedMedia[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [template, setTemplate] = useState<ImportFormat | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    void ensureNamespaces(["quizzes", "validation", "media"]);
  }, [ensureNamespaces]);

  // Focus the problem summary when it appears.
  useEffect(() => {
    if (phase.kind === "problems" || phase.kind === "failed") summaryRef.current?.focus();
  }, [phase]);

  // Load the user's media once references need mapping.
  useEffect(() => {
    if (refs.length === 0 || owned !== null) return;
    let active = true;
    api.request({ path: "/media", query: { page: 1, limit: 100 }, schema: mediaPageSchema }).then(
      ({ data }) => {
        if (active)
          setOwned(
            data.items.map((media) => ({
              id: media.id,
              name: media.originalName,
              kind: kindOf(media.mimeType),
            })),
          );
      },
      () => {
        if (active) setOwned([]);
      },
    );
    return () => {
      active = false;
    };
  }, [api, refs.length, owned]);

  /** A new file: checks type and size, then finds its media references. */
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setPhase({ kind: "idle" });
    setMapping({});
    setRefs([]);
    setFile(null);
    setFileError(null);
    keyRef.current = crypto.randomUUID();
    if (!chosen) return;
    const format = detectFormat(chosen);
    if (!format) {
      setFileError(t("validation.errors.unsupportedContentType"));
      return;
    }
    if (chosen.size > IMPORT_LIMITS.bytes) {
      setFileError(t("validation.errors.payloadTooLarge"));
      return;
    }
    setFile(chosen);
    setRefs(referencedMedia(format, await chosen.text()));
  };

  /** Loads the quiz an unconfirmed import created, if any. */
  const lookup = useCallback(async (): Promise<"done" | "pending" | "not-received" | "unknown"> => {
    const outcome = await api.reconcileOperation(keyRef.current, "quiz.import").catch(() => null);
    if (outcome?.status === "done" && outcome.resourceId) {
      const { data } = await api.request({
        path: `/quizzes/${outcome.resourceId}`,
        schema: quizDetailSchema,
      });
      setPhase({ kind: "done" });
      keyRef.current = crypto.randomUUID();
      onImported(data);
      return "done";
    }
    return outcome?.status === "pending" || outcome?.status === "not-received"
      ? outcome.status
      : "unknown";
  }, [api, onImported]);

  /** Uploads once; problems are listed, unknown outcomes are looked up before any retry. */
  const submit = async () => {
    if (!file || phase.kind === "uploading") return;
    setPhase({ kind: "uploading" });
    const body = new FormData();
    body.append("file", file, file.name);
    const map = Object.fromEntries(Object.entries(mapping).filter(([, id]) => id !== ""));
    if (Object.keys(map).length > 0) body.append("mediaMap", JSON.stringify(map));
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/quizzes/import",
        body,
        schema: quizDetailSchema,
        idempotencyKey: keyRef.current,
        timeoutMs: 60_000,
      });
      setPhase({ kind: "done" });
      keyRef.current = crypto.randomUUID();
      onImported(data);
    } catch (error) {
      if (!(error instanceof ApiError) || error.uncertain) {
        const answer = await lookup().catch(() => "unknown" as const);
        if (answer === "done") return;
        setPhase({
          kind: "failed",
          message: answer === "pending" ? t("validation.errors.operationPending") : null,
          canCheck: answer !== "not-received",
        });
        return;
      }
      keyRef.current = crypto.randomUUID();
      const total =
        typeof error.params.actual === "number" ? error.params.actual : error.details.length;
      if (error.status === 422 || error.code.startsWith("MALFORMED") || error.details.length > 0)
        setPhase({
          kind: "problems",
          issues: error.details.slice(0, IMPORT_LIMITS.returnedIssues),
          total: Math.max(total, error.details.length),
          message:
            error.code === "IMPORT_VALIDATION_FAILED"
              ? null
              : error.code === "UNSUPPORTED_IMPORT_VERSION"
                ? t("quizzes.import.unsupportedVersion")
                : t(apiErrorMessageKey(error.code)),
        });
      else
        setPhase({ kind: "failed", message: t(apiErrorMessageKey(error.code)), canCheck: false });
    }
  };

  /** Downloads a template. */
  const downloadTemplate = async (format: ImportFormat) => {
    setTemplate(format);
    try {
      const { blob, filename } = await api.download(
        `/quizzes/import-template?format=${format}`,
        `kabuki-neko-template.${format}`,
      );
      if (blob.size === 0) throw new Error("empty template");
      save(blob, filename);
    } catch {
      setFileError(t("quizzes.inventory.f07.error"));
    } finally {
      setTemplate(null);
    }
  };

  const uploading = phase.kind === "uploading";
  const format = file ? detectFormat(file) : null;

  return (
    <ModalSheet
      open={open}
      title={t("quizzes.import.title")}
      description={t("quizzes.import.formatHelp")}
      size="media"
      pending={uploading}
      onCloseRequest={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton variant="secondary" label={t("common.actions.cancel")} onPress={onClose} />
          {phase.kind === "failed" && phase.canCheck ? (
            <ActionButton
              label={t("common.actions.retry")}
              onPress={() =>
                void lookup().then((answer) => {
                  if (answer === "not-received")
                    setPhase({ kind: "failed", message: null, canCheck: false });
                })
              }
            />
          ) : (
            <ActionButton
              icon={<FileUp />}
              pending={uploading}
              disabled={!file || phase.kind === "done"}
              {...(!file ? { disabledReason: t("quizzes.inventory.m04.empty") } : {})}
              label={t("quizzes.import.submit")}
              onPress={() => void submit()}
            />
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-label font-semibold">
            {t("quizzes.import.chooseFile")}
          </label>
          <input
            id={inputId}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            disabled={uploading}
            onChange={(event) => void choose(event)}
            className="min-h-11 text-small file:me-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-panel file:px-4 file:font-semibold"
          />
          <p className="text-small text-muted-foreground">
            {file
              ? `${file.name} · ${format === "csv" ? t("quizzes.import.csv") : t("quizzes.import.json")} · ${formatNumber(file.size / 1024, { maximumFractionDigits: 1 })} KB`
              : t("quizzes.inventory.m04.empty")}
          </p>
          {fileError && (
            <p role="alert" className="text-small text-danger">
              {fileError}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            variant="ghost"
            icon={<Download />}
            pending={template === "json"}
            label={t("quizzes.import.templateJson")}
            onPress={() => void downloadTemplate("json")}
          />
          <ActionButton
            variant="ghost"
            icon={<Download />}
            pending={template === "csv"}
            label={t("quizzes.import.templateCsv")}
            onPress={() => void downloadTemplate("csv")}
          />
        </div>
        {refs.length > 0 && (
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-label font-semibold">
              {t("quizzes.import.mappingRequired")}
            </legend>
            {refs.map((reference) => {
              const choices = (owned ?? []).filter(
                (media) => reference.kind === null || media.kind === reference.kind,
              );
              return (
                <label key={reference.ref} className="flex flex-col gap-1 text-small">
                  <span className="break-all">{reference.name}</span>
                  <select
                    value={mapping[reference.ref] ?? ""}
                    disabled={uploading || owned === null}
                    onChange={(event) =>
                      setMapping((current) => ({ ...current, [reference.ref]: event.target.value }))
                    }
                    className="min-h-11 rounded-md border border-input bg-background px-3 text-body"
                  >
                    <option value="">{t("common.status.unknown")}</option>
                    {choices.map((media) => (
                      <option key={media.id} value={media.id}>
                        {media.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </fieldset>
        )}
        <p role="status" aria-live="polite" className="text-small empty:hidden">
          {uploading
            ? t("quizzes.inventory.m04.loading")
            : phase.kind === "done"
              ? t("quizzes.inventory.m04.ideal")
              : ""}
        </p>
        {phase.kind === "problems" && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-warning bg-warning-surface p-3 text-small text-warning"
          >
            <p className="font-semibold">{t("quizzes.inventory.m04.partial")}</p>
            {phase.message && <p>{phase.message}</p>}
            <p>{t("quizzes.import.issueCount", { count: phase.total })}</p>
            <p>{t("quizzes.import.atomicFailure")}</p>
            {phase.issues.length > 0 && (
              <ol className="max-h-64 list-decimal overflow-y-auto ps-5">
                {phase.issues.map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="break-words">
                    {`${issueLocation(issue, t)}: ${t(apiErrorMessageKey(issue.code))}`}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {phase.kind === "failed" && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="flex flex-col gap-1 rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
          >
            <p>{t("quizzes.inventory.m04.error")}</p>
            {phase.message && <p>{phase.message}</p>}
          </div>
        )}
      </div>
    </ModalSheet>
  );
}
