"use client";
/**
 * B11 `MediaPreview` (Design §5.1, §6.3, §7.2; SA §7.1; US-06/US-09/US-18; TASK-122): plays one
 * question/library asset — image, audio, uploaded video or a YouTube clip — safely and accessibly.
 *
 * - URL allowlist: uploads are accepted only as same-origin `/uploads/…` paths without `..`, or as
 *   absolute http(s) URLs on an explicitly configured origin (`allowedOrigins`, e.g. the S3 public
 *   base); YouTube only through the shared `canonicalYouTubeUrl` and embedded from
 *   youtube-nocookie.com in a sandboxed iframe. Anything else (javascript:, data:, foreign hosts,
 *   other embeds) is rejected and shows "This media isn't available." — no wild URLs reach the DOM.
 * - Dimensions are reserved from the asset's width/height (16:9 for video), so loading never
 *   shifts layout; a poster box is shown while it loads.
 * - Text alternatives come from the asset's accessibility data only: image alt, audio transcript,
 *   video captions (rendered from the cue list, half-open [start, end) intervals, toggleable),
 *   visual description. Missing alternatives are stated, never invented.
 * - Clips: video starts at `startSec` and pauses at `endSec`; YouTube gets `start`/`end`.
 * - Autoplay is attempted only when asked; if the browser blocks it, a "Turn on playback" action
 *   appears. A failing asset shows a placeholder with Retry and never stops the game timer (which
 *   this component does not own).
 */
import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { canonicalYouTubeUrl, type Accessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { useLocale } from "@/providers/locale-provider";
import { ActionButton } from "./action-button";

/** A playable asset (the public media payload without its reveal mode). */
export interface MediaAsset {
  kind: "image" | "audio" | "video" | "youtube";
  url: string;
  width: number | null;
  height: number | null;
  startSec: number;
  endSec: number | null;
  accessibility: Accessibility;
}

/** Why an asset could not be shown. */
export type MediaErrorReason = "REJECTED_URL" | "LOAD_FAILED";

/** Props of {@link MediaPreview}. */
export interface MediaPreviewProps {
  asset: MediaAsset | null;
  /** Extra origins allowed for absolute upload URLs (e.g. the S3 public base URL's origin). */
  allowedOrigins?: readonly string[];
  /** Try to start audio/video/YouTube automatically (falls back to a play action). */
  autoPlay?: boolean;
  onReady?: () => void;
  onError?: (reason: MediaErrorReason) => void;
  /** The user started playback explicitly (e.g. after autoplay was blocked). */
  onUserPlay?: () => void;
}

/** Same-origin upload paths: `/uploads/<safe segments>.<ext>`. */
const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9/_-]+\.[A-Za-z0-9]+$/u;

/** True when `url` may be loaded as an uploaded media file. */
export function isAllowedMediaUrl(url: string, allowedOrigins: readonly string[] = []): boolean {
  if (url.startsWith("/"))
    return UPLOAD_PATH.test(url) && !url.includes("..") && !url.startsWith("//");
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      allowedOrigins.includes(parsed.origin)
    );
  } catch {
    return false;
  }
}

/** Privacy-enhanced YouTube embed URL for an allowed YouTube link, or null. */
export function youtubeEmbedUrl(
  url: string,
  startSec: number,
  endSec: number | null,
  autoPlay: boolean,
) {
  const canonical = canonicalYouTubeUrl(url);
  if (canonical === null) return null;
  const id = new URL(canonical).searchParams.get("v");
  if (!id) return null;
  const params = new URLSearchParams({ rel: "0", playsinline: "1", start: String(startSec) });
  if (endSec !== null) params.set("end", String(endSec));
  if (autoPlay) {
    params.set("autoplay", "1");
    params.set("mute", "1");
  }
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

/** Caption cue active at `seconds` (half-open [startMs, endMs)). */
export function activeCaption(captions: Accessibility["captions"], seconds: number) {
  const ms = seconds * 1000;
  return captions.find((cue) => cue.startMs <= ms && ms < cue.endMs) ?? null;
}

/** Reserved box style from intrinsic dimensions (default 16:9). */
function aspect(asset: MediaAsset): CSSProperties {
  const ratio = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  return { aspectRatio: String(ratio) };
}

/** Collapsible text alternative (transcript / visual description). */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-border bg-panel p-2 text-small">
      <summary className="min-h-11 cursor-pointer content-center font-semibold">{summary}</summary>
      <p className="mt-2 break-words whitespace-pre-line">{children}</p>
    </details>
  );
}

/** Image, audio, video or YouTube preview with allowlisted URLs and text alternatives. */
export function MediaPreview({
  asset,
  allowedOrigins = [],
  autoPlay = false,
  onReady,
  onError,
  onUserPlay,
}: MediaPreviewProps) {
  const { t, ensureNamespaces } = useLocale();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [time, setTime] = useState(0);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const reported = useRef<string | null>(null);

  // The player labels live in the media namespace; load it on demand.
  useEffect(() => {
    void ensureNamespaces(["media"]);
  }, [ensureNamespaces]);

  const youtube =
    asset?.kind === "youtube"
      ? youtubeEmbedUrl(asset.url, asset.startSec, asset.endSec, autoPlay)
      : null;
  const rejected =
    asset !== null &&
    (asset.kind === "youtube" ? youtube === null : !isAllowedMediaUrl(asset.url, allowedOrigins));

  // Report a rejected URL once per asset URL.
  useEffect(() => {
    if (rejected && asset && reported.current !== asset.url) {
      reported.current = asset.url;
      onError?.("REJECTED_URL");
    }
  }, [rejected, asset, onError]);

  if (asset === null) return null;

  /** Marks a load failure (shown with Retry; the game continues). */
  const fail = () => {
    setFailed(true);
    onError?.("LOAD_FAILED");
  };

  if (rejected || failed) {
    const unavailable =
      asset.kind === "image"
        ? t("accessibility.media.imageUnavailable")
        : asset.kind === "audio"
          ? t("accessibility.media.audioUnavailable")
          : t("accessibility.media.videoUnavailable");
    return (
      <div
        style={asset.kind === "audio" ? undefined : aspect(asset)}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-md bg-subtle p-4 text-center text-small text-muted-foreground"
      >
        <ImageOff aria-hidden="true" className="size-6" />
        <p role="status">{rejected ? t("media.player.unavailable") : unavailable}</p>
        {!rejected && (
          <ActionButton
            variant="secondary"
            label={t("media.player.retry")}
            onPress={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          />
        )}
      </div>
    );
  }

  const { accessibility } = asset;

  if (asset.kind === "youtube" && youtube)
    return (
      <div className="flex flex-col gap-2">
        <div style={aspect(asset)} className="w-full overflow-hidden rounded-md bg-subtle">
          <iframe
            src={youtube}
            title={accessibility.altText ?? t("media.source.youtube")}
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
            onLoad={onReady}
            className="h-full w-full border-0"
          />
        </div>
        {accessibility.visualDescription && (
          <Disclosure summary={t("media.accessibility.visualDescription")}>
            {accessibility.visualDescription}
          </Disclosure>
        )}
      </div>
    );

  if (asset.kind === "image")
    return (
      <div style={aspect(asset)} className="w-full overflow-hidden rounded-md bg-subtle">
        {/* Plain <img>: allowlisted user media, not a static asset for next/image. */}
        <img
          key={attempt}
          src={asset.url}
          alt={accessibility.altText ?? ""}
          decoding="async"
          onLoad={onReady}
          onError={fail}
          ref={(node) => {
            // An SSR-rendered image can fail before hydration attaches onError.
            if (node && typeof node.decode === "function") node.decode().catch(fail);
          }}
          className="h-full w-full object-contain"
        />
      </div>
    );

  /** Starts playback after a user action (autoplay was blocked or the user pressed Play). */
  const playByUser = () => {
    setBlocked(false);
    onUserPlay?.();
    void mediaRef.current?.play()?.catch(() => setBlocked(true));
  };

  const cue =
    asset.kind === "video" && captionsOn ? activeCaption(accessibility.captions, time) : null;
  const common = {
    ref: mediaRef,
    src: asset.url,
    controls: true,
    preload: "metadata" as const,
    onError: fail,
    onCanPlay: () => {
      onReady?.();
      if (autoPlay) void mediaRef.current?.play()?.catch(() => setBlocked(true));
    },
    onLoadedMetadata: () => {
      if (mediaRef.current && asset.startSec > 0) mediaRef.current.currentTime = asset.startSec;
    },
    onTimeUpdate: () => {
      const element = mediaRef.current;
      if (!element) return;
      // Keep playback inside the clip [startSec, endSec].
      if (element.currentTime < asset.startSec) element.currentTime = asset.startSec;
      if (asset.endSec !== null && element.currentTime >= asset.endSec) {
        element.pause();
        element.currentTime = asset.endSec;
      }
      setTime(element.currentTime);
    },
  };

  return (
    <div className="flex flex-col gap-2">
      {asset.kind === "video" ? (
        <div
          style={aspect(asset)}
          className="relative w-full overflow-hidden rounded-md bg-brand-ink"
        >
          <video key={attempt} {...common} playsInline className="h-full w-full" />
          {cue && (
            <p className="pointer-events-none absolute inset-x-4 bottom-12 rounded-sm bg-brand-ink/80 px-2 py-1 text-center text-body text-white">
              {cue.text}
            </p>
          )}
        </div>
      ) : (
        <audio key={attempt} {...common} className="w-full" />
      )}
      {blocked && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-small">
          <span>{t("media.player.autoplayBlocked")}</span>
          <ActionButton
            variant="secondary"
            label={t("media.player.enablePlayback")}
            onPress={playByUser}
          />
        </div>
      )}
      {asset.kind === "video" &&
        (accessibility.captions.length > 0 ? (
          <div>
            <button
              type="button"
              aria-pressed={captionsOn}
              onClick={() => setCaptionsOn((value) => !value)}
              className="min-h-11 rounded-md border border-border px-3 text-label hover:bg-subtle"
            >
              {t("media.player.captions")}
            </button>
          </div>
        ) : (
          <p className="text-small text-muted-foreground">
            {t("accessibility.media.captionsUnavailable")}
          </p>
        ))}
      {asset.kind === "audio" &&
        (accessibility.transcript ? (
          <Disclosure summary={t("media.player.transcript")}>{accessibility.transcript}</Disclosure>
        ) : (
          <p className="text-small text-muted-foreground">
            {t("accessibility.media.transcriptUnavailable")}
          </p>
        ))}
      {accessibility.visualDescription && (
        <Disclosure summary={t("media.accessibility.visualDescription")}>
          {accessibility.visualDescription}
        </Disclosure>
      )}
    </div>
  );
}
