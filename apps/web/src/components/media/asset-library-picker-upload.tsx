"use client";
/**
 * S08 media library and F06 asset picker with upload and accessibility metadata (Design §4.4,
 * §7.2; SA §4.4, §7.1; US-06/18/21; TASK-141).
 *
 * - Lists the caller's READY media, 24 per page, newest first.
 *   - Filters by type (all, images, audio, video) and searches by file name.
 *   - The query lives in the URL (back/forward/reload), and only the latest response is applied.
 *   - Cards show a preview (image) or a type icon, the name, type and size, an "In use" badge and
 *     missing text alternatives.
 * - Upload (button or drop) checks each file before sending.
 *   - Allowed MIME types only; SVG and anything else is refused.
 *   - The instance's per-type size limit applies to the original file.
 *   - Each file then shows "Uploading… n%" (XHR progress) and "Processing…" until the server
 *     answers 201 with a READY asset. Only then is it in the library or selectable.
 *   - Failures are per file (partial failure), with the server's translated reason and
 *     "Try again".
 *   - Uploads use an Idempotency-Key. A lost response is reconciled through
 *     `/operations/:key`, never re-sent blindly; a "not received" result is retried with the
 *     same key.
 *   - At most two uploads run at once (the server's per-user limit).
 * - "Edit" opens the full preview with the accessibility fields for the media kind:
 *   - alt text and visual description for images;
 *   - a transcript for audio;
 *   - transcript, visual description and timed captions for video.
 *   It saves with `PATCH` + `If-Match`. A revision conflict is explained and reloads the latest
 *   version; edits are never silently merged. Nothing is auto-filled (no filename as alt text).
 * - Delete goes through M09. Media in use (or not deletable) is blocked with the reason, and a
 *   server-side "in use" answer is reported in the dialog.
 * - Picker mode (TASK-142) adds "Select" and can lock the list to one kind (e.g. cover images).
 * States:
 * - loading: skeletons;
 * - empty: no media, or no search matches;
 * - ideal: the grid;
 * - partial: some uploads failed, items in use, stale list;
 * - error: list failed, with retry.
 */
import { File as FileIcon, Film, Music, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { errorEnvelopeSchema } from "@kabuki-neko/shared/errors";
import { ACCESSIBILITY_LIMITS, PAGING } from "@kabuki-neko/shared/constants/limits";
import {
  MEDIA_MIME_TYPES,
  accessibilitySchema,
  mediaDeletedSchema,
  mediaPageSchema,
  mediaSchema,
  type Accessibility,
  type Media,
} from "@kabuki-neko/shared/schemas/media.schema";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { MediaPreview, type MediaAsset } from "@/components/ui/media-preview";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { usePublicConfig } from "@/components/ui/public-shell";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import {
  ApiError,
  CLIENT_HEADER,
  apiErrorMessageKey,
  createLatestRequest,
  type ApiClient,
} from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Media kinds of the library. */
export type MediaKind = "image" | "audio" | "video";
/** Library page size (SA paging default for media). */
export const MEDIA_PAGE_SIZE = PAGING.defaults.media;
/** Longest search text sent to the API. */
const MAX_SEARCH = 100;
/** Uploads running at the same time (the server allows two per user). */
export const UPLOAD_CONCURRENCY = 2;
/** `accept` attribute: the exact allowed MIME types (no SVG). */
export const ACCEPTED_TYPES = MEDIA_MIME_TYPES.join(",");
const MIB = 1024 * 1024;

/** Kind of an allowed MIME type (null for anything else, including SVG). */
export function mediaKind(mime: string): MediaKind | null {
  if (!(MEDIA_MIME_TYPES as readonly string[]).includes(mime)) return null;
  if (mime.startsWith("image/")) return "image";
  return mime.startsWith("audio/") ? "audio" : "video";
}

/** Per-type original size limits in MiB (instance settings). */
export interface UploadLimits {
  imageMb: number;
  audioMb: number;
  videoMb: number;
}

/** Why a file can't be uploaded (checked before sending), or null. */
export function fileProblem(
  file: { type: string; size: number },
  limits: UploadLimits,
  lockedKind: MediaKind | null = null,
): "unsupportedType" | "tooLarge" | null {
  const kind = mediaKind(file.type);
  if (!kind || (lockedKind && kind !== lockedKind)) return "unsupportedType";
  const limit =
    kind === "image" ? limits.imageMb : kind === "audio" ? limits.audioMb : limits.videoMb;
  return file.size > limit * MIB ? "tooLarge" : null;
}

/** Storage folder of an upload. */
export type UploadFolder = "covers" | "questions" | "audio" | "video";

/** Default folder for a kind. */
export function folderFor(kind: MediaKind): UploadFolder {
  return kind === "image" ? "questions" : kind;
}

/** Library query (URL state). */
export interface MediaQuery {
  type: MediaKind | null;
  search: string;
  page: number;
}

/** Raw URL parameters of the media page. */
export type RawMediaParams = Partial<Record<"type" | "search" | "page", string>>;

/** Parses and clamps the URL parameters. */
export function parseMediaQuery(raw: RawMediaParams): MediaQuery {
  const page = Number.parseInt(raw.page ?? "1", 10);
  const type =
    raw.type === "image" || raw.type === "audio" || raw.type === "video" ? raw.type : null;
  return {
    type,
    search: (raw.search ?? "").slice(0, MAX_SEARCH),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, PAGING.maxPage) : 1,
  };
}

/** URL of the media page for `query` (defaults omitted). */
export function mediaHref(query: MediaQuery): string {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.search) params.set("search", query.search);
  if (query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return text ? `/dashboard/media?${text}` : "/dashboard/media";
}

/** The playable asset of a media record (for previews). */
export function assetOf(media: Media): MediaAsset {
  const kind = mediaKind(media.mimeType) ?? "image";
  return {
    kind,
    url: media.publicUrl,
    width: media.width,
    height: media.height,
    startSec: 0,
    endSec: null,
    accessibility: media.accessibility,
  };
}

/** Missing text alternatives of a media record (message keys). */
export function missingAlternatives(media: Pick<Media, "mimeType" | "accessibility">): string[] {
  const kind = mediaKind(media.mimeType);
  const { altText, transcript, captions, visualDescription } = media.accessibility;
  const missing: string[] = [];
  if (kind === "image" && !altText) missing.push("media.accessibility.missingAlt");
  if ((kind === "audio" || kind === "video") && !transcript)
    missing.push("media.accessibility.missingTranscript");
  if (kind === "video" && captions.length === 0)
    missing.push("media.accessibility.missingCaptions");
  if (kind === "video" && !visualDescription)
    missing.push("media.accessibility.missingVisualDescription");
  return missing;
}

/** Input of one upload. */
export interface UploadInput {
  file: File;
  folder: UploadFolder;
  idempotencyKey: string;
  onProgress: (percent: number) => void;
  /** All bytes are sent; the server is processing. */
  onProcessing: () => void;
}

/** Uploads one file and resolves the READY media (throws ApiError). */
export type UploadFn = (input: UploadInput) => Promise<Media>;

/** Public REST API base, as the browser reaches it (same as the root layout). */
function browserApiBase(): string {
  return new URL("/api/v1", process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").toString();
}

/**
 * XHR upload with byte progress, sent with the same headers as the API client. On an expired
 * access token it refreshes once through the API client and retries with the same
 * Idempotency-Key. Network failures are `uncertain` (to reconcile, never re-send blindly).
 */
export function createXhrUpload(options: {
  baseUrl: string;
  getAccessToken: () => string | null;
  /** Renews the access token (any authenticated request through the API client). */
  refresh: () => Promise<boolean>;
}): UploadFn {
  /** One XHR attempt. */
  const attempt = (input: UploadInput) =>
    new Promise<Media>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${options.baseUrl.replace(/\/$/u, "")}/media/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("X-Kabuki-Client", CLIENT_HEADER);
      xhr.setRequestHeader("Idempotency-Key", input.idempotencyKey);
      const token = options.getAccessToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0)
          input.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      };
      xhr.upload.onload = () => input.onProcessing();
      xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", {}, [], null, true));
      xhr.ontimeout = () => reject(new ApiError(0, "TIMEOUT", {}, [], null, true));
      xhr.onload = () => {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText) as unknown;
        } catch {
          body = null;
        }
        if (xhr.status === 200 || xhr.status === 201) {
          const media = mediaSchema.safeParse(body);
          if (media.success) resolve(media.data);
          else reject(new ApiError(xhr.status, "INVALID_RESPONSE"));
          return;
        }
        const envelope = errorEnvelopeSchema.safeParse(body);
        if (envelope.success)
          reject(
            new ApiError(
              xhr.status,
              envelope.data.errorCode,
              envelope.data.params,
              envelope.data.details,
              envelope.data.correlationId,
              xhr.status >= 502 && xhr.status <= 504,
            ),
          );
        else reject(new ApiError(xhr.status, "INVALID_RESPONSE", {}, [], null, xhr.status >= 502));
      };
      const form = new FormData();
      form.append("folder", input.folder);
      form.append("file", input.file, input.file.name);
      xhr.send(form);
    });
  return async (input) => {
    try {
      return await attempt(input);
    } catch (error) {
      if (error instanceof ApiError && error.code === "TOKEN_EXPIRED" && (await options.refresh()))
        return attempt(input);
      throw error;
    }
  };
}

/** One file in the upload queue. */
export interface UploadItem {
  id: string;
  name: string;
  kind: MediaKind | null;
  status: "queued" | "uploading" | "processing" | "done" | "failed" | "uncertain";
  progress: number;
  /** Translated reason key of a failure. */
  errorKey: string | null;
  /** Idempotency key (kept for an uncertain retry). */
  key: string;
  file: File;
}

/** Props of {@link AssetLibrary}. */
export interface AssetLibraryProps {
  query: MediaQuery;
  onQueryChange: (query: MediaQuery) => void;
  /** Picker mode shows "Select" on READY items. */
  mode?: "library" | "picker";
  /** Restricts listing and uploads to one kind (e.g. cover images). */
  lockedKind?: MediaKind | null;
  /** Folder for new uploads (default by kind). */
  folder?: UploadFolder | null;
  /** Picker: a READY item was chosen. */
  onSelect?: (media: Media) => void;
  /** Upload implementation (tests); defaults to the XHR uploader. */
  upload?: UploadFn;
  /** Size limits (tests); defaults to the public configuration. */
  limits?: UploadLimits | null;
}

/** Fetches one library page. */
async function fetchMedia(api: ApiClient, query: MediaQuery, signal: AbortSignal) {
  const { data } = await api.request({
    path: "/media",
    query: {
      page: query.page,
      limit: MEDIA_PAGE_SIZE,
      ...(query.type ? { type: query.type } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
    schema: mediaPageSchema,
    signal,
  });
  return data;
}

/** List state. */
type ListState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; items: Media[]; totalPages: number; stale: boolean };

/** S08/F06: media library, picker and uploads. */
export function AssetLibrary({
  query,
  onQueryChange,
  mode = "library",
  lockedKind = null,
  folder = null,
  onSelect,
  upload,
  limits: providedLimits,
}: AssetLibraryProps) {
  const { t, formatNumber, ensureNamespaces } = useLocale();
  const { api, getAccessToken } = useAuth();
  const config = usePublicConfig();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const [searchText, setSearchText] = useState(query.search);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [editing, setEditing] = useState<Media | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useMemo(() => createLatestRequest(), []);
  const baseId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef(0);
  const effectiveQuery = lockedKind ? { ...query, type: lockedKind } : query;

  const limits: UploadLimits | null =
    providedLimits !== undefined
      ? providedLimits
      : config.state.status === "ready"
        ? config.state.config.limits
        : null;
  const uploader = useMemo(
    () =>
      upload ??
      createXhrUpload({
        baseUrl: browserApiBase(),
        getAccessToken,
        refresh: async () => {
          try {
            await api.request({ path: "/auth/me", schema: userSchema });
            return true;
          } catch {
            return false;
          }
        },
      }),
    [upload, api, getAccessToken],
  );

  useEffect(() => {
    void ensureNamespaces(["media", "validation"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    setSearchText(query.search);
  }, [query.search]);

  // Load the page for the current query (only the latest response is applied).
  useEffect(() => {
    let active = true;
    setState((current) =>
      current.status === "ready" ? { ...current, stale: false } : { status: "loading" },
    );
    latest
      .run((signal) => fetchMedia(api, effectiveQuery, signal))
      .then(
        (result) => {
          if (!active || result.stale) return;
          const { items, meta } = result.value;
          if (meta.total > 0 && query.page > meta.totalPages) {
            onQueryChange({ ...query, page: meta.totalPages });
            return;
          }
          setState({ status: "ready", items, totalPages: meta.totalPages, stale: false });
        },
        (error: unknown) => {
          if (!active) return;
          setState((current) =>
            current.status === "ready" ? { ...current, stale: true } : { status: "error", error },
          );
        },
      );
    return () => {
      active = false;
    };
    // The request depends on the query values only (`onQueryChange` is navigation).
  }, [api, latest, effectiveQuery.type, query.search, query.page, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  /** Re-fetches the list. */
  const invalidate = useCallback(() => setVersion((value) => value + 1), []);

  /** Updates one queue item. */
  const patchItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setQueue((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /** Runs one upload; a lost response is reconciled by its key instead of re-sent. */
  const runUpload = useCallback(
    async (item: UploadItem) => {
      patchItem(item.id, { status: "uploading", progress: 0, errorKey: null });
      try {
        await uploader({
          file: item.file,
          folder: folder ?? folderFor(item.kind ?? "image"),
          idempotencyKey: item.key,
          onProgress: (progress) => patchItem(item.id, { progress }),
          onProcessing: () => patchItem(item.id, { status: "processing", progress: 100 }),
        });
        patchItem(item.id, { status: "done" });
        invalidate();
      } catch (error) {
        if (error instanceof ApiError && error.uncertain) {
          const answer = await api.reconcileOperation(item.key, "media.upload");
          if (answer.status === "done") {
            patchItem(item.id, { status: "done" });
            invalidate();
          } else
            patchItem(item.id, {
              status: "uncertain",
              errorKey:
                answer.status === "pending"
                  ? "media.upload.processing"
                  : "auth.recovery.uncertainRequest",
            });
          return;
        }
        patchItem(item.id, {
          status: "failed",
          errorKey:
            error instanceof ApiError
              ? error.code === "PAYLOAD_TOO_LARGE"
                ? "media.upload.tooLarge"
                : error.code === "UNSUPPORTED_MEDIA" || error.code === "UNSUPPORTED_CONTENT_TYPE"
                  ? "media.upload.invalidSignature"
                  : apiErrorMessageKey(error.code)
              : "media.upload.failed",
        });
      }
    },
    [api, folder, invalidate, patchItem, uploader],
  );

  // Start queued uploads, at most UPLOAD_CONCURRENCY at once.
  useEffect(() => {
    const waiting = queue.filter((item) => item.status === "queued");
    for (const item of waiting) {
      if (running.current >= UPLOAD_CONCURRENCY) break;
      running.current += 1;
      patchItem(item.id, { status: "uploading" });
      void runUpload(item).finally(() => {
        running.current -= 1;
        setQueue((items) => [...items]);
      });
    }
  }, [queue, patchItem, runUpload]);

  /** Adds files: invalid ones fail at once (partial failure), valid ones are queued. */
  const addFiles = (files: readonly File[]) => {
    if (!limits) return;
    const added = files.map((file): UploadItem => {
      const problem = fileProblem(file, limits, lockedKind);
      return {
        id: crypto.randomUUID(),
        name: file.name,
        kind: mediaKind(file.type),
        status: problem ? "failed" : "queued",
        progress: 0,
        errorKey: problem ? `media.upload.${problem}` : null,
        key: crypto.randomUUID(),
        file,
      };
    });
    setQueue((items) => [...added, ...items]);
  };

  /** Retries a failed upload (same key when the outcome was uncertain). */
  const retry = (item: UploadItem) => {
    if (limits && fileProblem(item.file, limits, lockedKind)) return;
    patchItem(item.id, {
      status: "queued",
      errorKey: null,
      progress: 0,
      key: item.status === "uncertain" ? item.key : crypto.randomUUID(),
    });
  };

  const confirmDelete = useConfirmAction({
    run: async () => {
      if (!deleting) return;
      await api.request({
        method: "DELETE",
        path: `/media/${deleting.id}`,
        schema: mediaDeletedSchema,
      });
    },
    onDone: () => {
      setDeleting(null);
      invalidate();
    },
  });

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    onQueryChange({ ...query, search: searchText.trim().slice(0, MAX_SEARCH), page: 1 });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const items = state.status === "ready" ? state.items : [];
  const kindLabel = (kind: MediaKind | null) =>
    kind === "image"
      ? t("media.library.images")
      : kind === "audio"
        ? t("media.library.audio")
        : kind === "video"
          ? t("media.library.video")
          : t("media.library.unavailable");

  let body;
  if (state.status === "loading")
    body = (
      <div aria-busy="true" className="flex flex-col gap-3">
        <SkeletonBlock layout="media" count={3} label={t("media.inventory.s08.loading")} />
      </div>
    );
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("media.inventory.s08.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: invalidate }}
      />
    );
  else if (items.length === 0)
    body = (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-6">
        <p role="status">
          {query.search
            ? t("common.pagination.resultCount", { count: 0 })
            : t("media.inventory.s08.empty")}
        </p>
        {query.search && (
          <ActionButton
            variant="secondary"
            label={t("common.actions.clearSearch")}
            onPress={() => onQueryChange({ ...query, search: "", page: 1 })}
          />
        )}
      </div>
    );
  else
    body = (
      <ul className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3">
        {items.map((media) => {
          const kind = mediaKind(media.mimeType);
          const missing = missingAlternatives(media);
          const blocked = media.inUse || !media.canDelete;
          return (
            <li
              key={media.id}
              data-media-id={media.id}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-3"
            >
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
                {kind === "image" ? (
                  <img
                    src={media.publicUrl}
                    alt=""
                    width={media.width ?? undefined}
                    height={media.height ?? undefined}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                ) : kind === "audio" ? (
                  <Music aria-hidden="true" className="size-10 text-muted-foreground" />
                ) : kind === "video" ? (
                  <Film aria-hidden="true" className="size-10 text-muted-foreground" />
                ) : (
                  <FileIcon aria-hidden="true" className="size-10 text-muted-foreground" />
                )}
              </div>
              <p className="text-label font-semibold break-words [overflow-wrap:anywhere]">
                {media.originalName}
              </p>
              <p className="text-small text-muted-foreground">
                {`${kindLabel(kind)} · ${formatNumber(media.sizeBytes / 1_000_000, {
                  style: "unit",
                  unit: "megabyte",
                  maximumFractionDigits: 1,
                })}`}
              </p>
              <div className="flex flex-wrap gap-2">
                {media.inUse && <StatusBadge tone="info" label={t("media.library.inUse")} />}
              </div>
              {missing.length > 0 && (
                <ul className="text-small text-warning">
                  {missing.map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </ul>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                {mode === "picker" && onSelect && (
                  <ActionButton
                    label={t("media.library.select")}
                    accessibleName={`${t("media.library.select")}: ${media.originalName}`}
                    onPress={() => onSelect(media)}
                  />
                )}
                <ActionButton
                  variant="secondary"
                  label={t("common.actions.edit")}
                  accessibleName={`${t("common.actions.edit")}: ${media.originalName}`}
                  onPress={() => setEditing(media)}
                />
                <ActionButton
                  variant="ghost"
                  label={t("media.library.delete")}
                  accessibleName={`${t("media.library.delete")}: ${media.originalName}`}
                  disabled={blocked}
                  {...(blocked ? { disabledReason: t("media.inventory.f06.partial") } : {})}
                  onPress={() => {
                    setDeleting(media);
                    confirmDelete.request();
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    );

  const totalPages = state.status === "ready" ? state.totalPages : 0;
  const failedUploads = queue.filter(
    (item) => item.status === "failed" || item.status === "uncertain",
  );

  return (
    <section aria-labelledby={`${baseId}-title`} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id={`${baseId}-title`} className="text-title font-bold">
          {mode === "picker" ? t("media.inventory.m05.title") : t("media.library.title")}
        </h1>
        <div className="flex flex-col items-end gap-1">
          <ActionButton
            icon={<Upload />}
            label={t("media.library.upload")}
            disabled={!limits}
            onPress={() => fileInput.current?.click()}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={
              lockedKind
                ? MEDIA_MIME_TYPES.filter((mime) => mediaKind(mime) === lockedKind).join(",")
                : ACCEPTED_TYPES
            }
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
      </div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col gap-1 rounded-md border-2 border-dashed p-4 text-small ${
          dragging ? "border-primary bg-primary/10" : "border-border"
        }`}
      >
        <p className="font-semibold">{t("media.upload.dropFiles")}</p>
        {limits && (
          <ul className="text-muted-foreground">
            {(lockedKind ? [lockedKind] : (["image", "audio", "video"] as const)).map((kind) => (
              <li key={kind}>
                {`${kindLabel(kind)}: ${t("media.upload.sizeLimit", {
                  limit:
                    kind === "image"
                      ? limits.imageMb
                      : kind === "audio"
                        ? limits.audioMb
                        : limits.videoMb,
                })}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {queue.length > 0 && (
        <ul aria-label={t("media.library.upload")} className="flex flex-col gap-2">
          {queue.map((item) => (
            <li
              key={item.id}
              data-upload-status={item.status}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-small"
            >
              <span className="min-w-0 basis-full font-semibold break-words [overflow-wrap:anywhere] sm:flex-1 sm:basis-0">
                {item.name}
              </span>
              {item.status === "uploading" || item.status === "queued" ? (
                <span role="status" className="flex items-center gap-2">
                  <progress
                    max={100}
                    value={item.progress}
                    aria-label={t("media.upload.progress")}
                    className="h-2 w-24"
                  />
                  {t("media.upload.progressPercent", { percent: item.progress })}
                </span>
              ) : item.status === "processing" ? (
                <span role="status">{t("media.upload.processing")}</span>
              ) : item.status === "done" ? (
                <span role="status" className="text-success">
                  {t("common.status.saved")}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <span role="alert" className="text-danger">
                    {item.errorKey ? t(item.errorKey) : t("media.upload.failed")}
                  </span>
                  {!(limits && fileProblem(item.file, limits, lockedKind)) && (
                    <ActionButton
                      variant="secondary"
                      label={t("media.upload.retry")}
                      accessibleName={`${t("media.upload.retry")}: ${item.name}`}
                      onPress={() => retry(item)}
                    />
                  )}
                </span>
              )}
              {(item.status === "done" || item.status === "failed") && (
                <ActionButton
                  variant="ghost"
                  label={t("common.actions.close")}
                  accessibleName={`${t("common.actions.close")}: ${item.name}`}
                  onPress={() => setQueue((list) => list.filter((entry) => entry.id !== item.id))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {failedUploads.length > 0 && queue.some((item) => item.status === "done") && (
        <p className="text-small text-warning">{t("media.inventory.s08.partial")}</p>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        {!lockedKind && (
          <ChoiceGroup
            mode="tabs"
            label={t("media.library.title")}
            hideLabel
            items={[
              { id: "all", label: t("media.library.all") },
              { id: "image", label: t("media.library.images") },
              { id: "audio", label: t("media.library.audio") },
              { id: "video", label: t("media.library.video") },
            ]}
            selected={query.type ?? "all"}
            onSelect={(id) =>
              onQueryChange({
                ...query,
                type: id === "image" || id === "audio" || id === "video" ? id : null,
                page: 1,
              })
            }
          />
        )}
        <form
          role="search"
          onSubmit={submitSearch}
          className="flex w-full items-end gap-2 md:w-auto"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={`${baseId}-search`} className="text-label font-semibold">
              {t("media.library.search")}
            </label>
            <input
              id={`${baseId}-search`}
              type="search"
              value={searchText}
              maxLength={MAX_SEARCH}
              onChange={(event) => setSearchText(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-body md:w-64"
            />
          </div>
          <ActionButton type="submit" variant="secondary" label={t("common.actions.search")} />
        </form>
      </div>
      {state.status === "ready" && state.stale && (
        <StatusNotice
          tone="warning"
          message={t("common.status.stale")}
          action={{ label: t("common.actions.retry"), onAction: invalidate }}
        />
      )}
      {body}
      {state.status === "ready" && totalPages > 1 && (
        <nav
          aria-label={t("common.pagination.label")}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <ActionButton
            variant="secondary"
            label={t("common.pagination.previous")}
            disabled={query.page <= 1}
            onPress={() => onQueryChange({ ...query, page: query.page - 1 })}
          />
          <span aria-current="page" className="text-label tabular-nums">
            {t("common.pagination.pageOf", { page: query.page, totalPages })}
          </span>
          <ActionButton
            variant="secondary"
            label={t("common.pagination.next")}
            disabled={query.page >= totalPages}
            onPress={() => onQueryChange({ ...query, page: query.page + 1 })}
          />
        </nav>
      )}
      {editing && (
        <MediaMetadataDialog
          media={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
          onReload={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
      <ConfirmDialog
        controller={confirmDelete}
        impact={t("common.confirm.deleteMedia")}
        targetName={deleting?.originalName ?? null}
        confirmLabel={t("media.library.delete")}
      />
    </section>
  );
}

/** Editable caption cue (seconds as typed). */
interface CueDraft {
  id: string;
  start: string;
  end: string;
  text: string;
}

/** Props of {@link MediaMetadataDialog}. */
export interface MediaMetadataDialogProps {
  media: Media;
  onClose: () => void;
  /** Saved (new revision). */
  onSaved: (media: Media) => void;
  /** A revision conflict: reload the latest version. */
  onReload: () => void;
}

/** Converts typed seconds to whole milliseconds (null when not a valid number). */
export function secondsToMs(value: string): number | null {
  const number = Number(value.replace(",", "."));
  return value.trim() !== "" && Number.isFinite(number) && number >= 0
    ? Math.round(number * 1000)
    : null;
}

/** Full preview plus the accessibility fields of one media file, saved with If-Match. */
export function MediaMetadataDialog({
  media,
  onClose,
  onSaved,
  onReload,
}: MediaMetadataDialogProps) {
  const { t } = useLocale();
  const { api } = useAuth();
  const kind = mediaKind(media.mimeType);
  const [altText, setAltText] = useState(media.accessibility.altText ?? "");
  const [transcript, setTranscript] = useState(media.accessibility.transcript ?? "");
  const [description, setDescription] = useState(media.accessibility.visualDescription ?? "");
  const [cues, setCues] = useState<CueDraft[]>(() =>
    media.accessibility.captions.map((cue) => ({
      id: crypto.randomUUID(),
      start: String(cue.startMs / 1000),
      end: String(cue.endMs / 1000),
      text: cue.text,
    })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  /** The accessibility payload, or null with a range error. */
  const draft = (): Accessibility | null => {
    const captions = [];
    for (const cue of cues) {
      const startMs = secondsToMs(cue.start);
      const endMs = secondsToMs(cue.end);
      if (startMs === null || endMs === null || endMs <= startMs || cue.text.trim() === "") {
        setRangeError(cue.id);
        return null;
      }
      captions.push({ startMs, endMs, text: cue.text });
    }
    setRangeError(null);
    return {
      altText: kind === "image" && altText.trim() ? altText : null,
      transcript: kind !== "image" && transcript.trim() ? transcript : null,
      captions: kind === "video" ? captions : [],
      visualDescription: kind !== "audio" && description.trim() ? description : null,
    };
  };

  const save = async () => {
    const accessibility = draft();
    if (!accessibility || pending) return;
    const parsed = accessibilitySchema.safeParse(accessibility);
    if (!parsed.success) {
      setError({ message: t("validation.errors.validationFailed"), conflict: false });
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { data } = await api.request({
        method: "PATCH",
        path: `/media/${media.id}`,
        body: { accessibility: parsed.data },
        ifMatch: media.revision,
        schema: mediaSchema,
      });
      onSaved(data);
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.code === "REVISION_CONFLICT";
      setError({
        message:
          failure instanceof ApiError
            ? t(apiErrorMessageKey(failure.code), {
                expectedRevision: failure.params.expectedRevision ?? media.revision,
                currentRevision: failure.params.currentRevision ?? media.revision,
              })
            : t("media.inventory.f06.error"),
        conflict,
      });
    } finally {
      setPending(false);
    }
  };

  const missing = missingAlternatives({
    mimeType: media.mimeType,
    accessibility: {
      altText: altText.trim() || null,
      transcript: transcript.trim() || null,
      captions: cues.length > 0 ? [{ startMs: 0, endMs: 1, text: "x" }] : [],
      visualDescription: description.trim() || null,
    },
  });

  return (
    <ModalSheet
      open
      size="media"
      title={media.originalName}
      pending={pending}
      onCloseRequest={onClose}
      error={
        error ? (
          <span className="flex flex-col items-start gap-2">
            <span>{error.message}</span>
            {error.conflict && (
              <ActionButton
                variant="secondary"
                label={t("common.actions.retry")}
                onPress={onReload}
              />
            )}
          </span>
        ) : undefined
      }
      footer={
        <>
          <ActionButton variant="secondary" label={t("common.actions.cancel")} onPress={onClose} />
          <ActionButton
            label={t("common.actions.save")}
            pending={pending}
            onPress={() => void save()}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <MediaPreview asset={assetOf(media)} />
        {missing.length > 0 && (
          <ul className="text-small text-warning">
            {missing.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        )}
        {kind === "image" && (
          <FormField
            label={t("media.accessibility.altText")}
            value={altText}
            onChange={setAltText}
            limit={ACCESSIBILITY_LIMITS.altText}
          />
        )}
        {kind !== "image" && (
          <FormField
            kind="textarea"
            label={t("media.accessibility.transcript")}
            value={transcript}
            onChange={setTranscript}
            limit={ACCESSIBILITY_LIMITS.transcript}
            rows={5}
          />
        )}
        {kind !== "audio" && (
          <FormField
            kind="textarea"
            label={t("media.accessibility.visualDescription")}
            value={description}
            onChange={setDescription}
            limit={ACCESSIBILITY_LIMITS.visualDescription}
            rows={3}
          />
        )}
        {kind === "video" && (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-label font-semibold">
              {t("media.accessibility.captions")}
            </legend>
            {cues.map((cue, index) => (
              <div
                key={cue.id}
                role="group"
                aria-label={t("media.accessibility.cuePosition", { position: index + 1 })}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <div className="grid grid-cols-2 gap-2">
                  <FormField
                    kind="number"
                    label={t("media.accessibility.startTime")}
                    value={cue.start}
                    min={0}
                    step={0.1}
                    onChange={(value) =>
                      setCues((list) =>
                        list.map((item) => (item.id === cue.id ? { ...item, start: value } : item)),
                      )
                    }
                  />
                  <FormField
                    kind="number"
                    label={t("media.accessibility.endTime")}
                    value={cue.end}
                    min={0}
                    step={0.1}
                    onChange={(value) =>
                      setCues((list) =>
                        list.map((item) => (item.id === cue.id ? { ...item, end: value } : item)),
                      )
                    }
                    error={rangeError === cue.id ? t("media.source.invalidRange") : undefined}
                  />
                </div>
                <FormField
                  kind="textarea"
                  label={t("media.accessibility.cueText")}
                  value={cue.text}
                  onChange={(value) =>
                    setCues((list) =>
                      list.map((item) => (item.id === cue.id ? { ...item, text: value } : item)),
                    )
                  }
                  limit={ACCESSIBILITY_LIMITS.captionText}
                  rows={2}
                />
                <ActionButton
                  variant="ghost"
                  label={t("media.accessibility.removeCue")}
                  accessibleName={`${t("media.accessibility.removeCue")} ${index + 1}`}
                  onPress={() => setCues((list) => list.filter((item) => item.id !== cue.id))}
                  className="self-start"
                />
              </div>
            ))}
            <ActionButton
              variant="secondary"
              label={t("media.accessibility.addCue")}
              disabled={cues.length >= ACCESSIBILITY_LIMITS.captionCount}
              onPress={() =>
                setCues((list) => {
                  const previous = secondsToMs(list.at(-1)?.end ?? "0") ?? 0;
                  return [
                    ...list,
                    {
                      id: crypto.randomUUID(),
                      start: String(previous / 1000),
                      end: String(previous / 1000 + 2),
                      text: "",
                    },
                  ];
                })
              }
              className="self-start"
            />
          </fieldset>
        )}
      </div>
    </ModalSheet>
  );
}

/** Route wrapper: query from the URL parameters, changes pushed back into the URL. */
export function AssetLibraryRoute({ params }: { params: RawMediaParams }) {
  const router = useRouter();
  return (
    <AssetLibrary
      query={parseMediaQuery(params)}
      onQueryChange={(next) => router.push(mediaHref(next))}
    />
  );
}
