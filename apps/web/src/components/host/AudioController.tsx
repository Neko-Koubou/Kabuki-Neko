"use client";
/**
 * Host audio controls (Audio revision 2026-10-31; US-07/13/18/19/21; TASK-130B).
 *
 * - A top-right mute button (also the M key — ignored while typing in inputs, editors or
 *   content-editable areas and with Ctrl/Alt/Meta/Shift combinations) and a "Sound settings"
 *   popover (Radix Popover) with labelled master, music and sound-effect sliders. Values come from
 *   and go to the local audio preference store (clamped 0–1); nothing here changes room settings,
 *   the timer or other participants.
 * - Only in LOBBY: the current lobby track title and "Next track", which asks the audio engine to
 *   cross-fade (500 ms) to the next manifest track.
 * - States: loading ("Loading sound…"), empty (no tracks), ideal, blocked autoplay (message +
 *   "Turn on sound") and failure (message + "Try again"); the game continues in every case.
 * - The keyboard listener is removed on unmount (leaving the host stage).
 */
import { Settings2, Volume2, VolumeX } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId } from "react";
import type { GamePhase } from "@kabuki-neko/shared/constants/game";
import type { AudioStatus } from "@/lib/audio-manager";
import { useLocale } from "@/providers/locale-provider";
import { useAudioStore } from "@/stores/useAudioStore";

/** Props of {@link AudioController}. */
export interface AudioControllerProps {
  phase: GamePhase | null;
  status: AudioStatus;
  /** Manifest loaded (false while loading). */
  manifestReady: boolean;
  /** Number of lobby tracks in the manifest (0 = none available). */
  trackCount: number;
  /** Label of the lobby track now playing. */
  currentTrackLabel: string | null;
  onNextTrack: () => void;
  /** Unlock/retry after blocked autoplay or a failure. */
  onEnableAudio: () => void;
}

/** True when a key event comes from a place where M must type a letter. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Rich-text editors: any contenteditable ancestor except an explicit "false".
  if (
    target.isContentEditable ||
    target.closest("[contenteditable]:not([contenteditable='false'])")
  )
    return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(
      type,
    );
  }
  return target.getAttribute("role") === "textbox";
}

/** One labelled 0–100 % slider bound to a store volume. */
function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (volume: number) => void;
}) {
  const id = useId();
  const percent = Math.round(value * 100);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex justify-between text-label">
        <span>{label}</span>
        <span
          aria-hidden="true"
          className="tabular-nums text-muted-foreground"
        >{`${percent}%`}</span>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        aria-valuetext={`${percent}%`}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="min-h-11 w-full accent-[var(--primary)]"
      />
    </div>
  );
}

/** Mute button, settings popover and lobby track controls for the host stage. */
export function AudioController({
  phase,
  status,
  manifestReady,
  trackCount,
  currentTrackLabel,
  onNextTrack,
  onEnableAudio,
}: AudioControllerProps) {
  const { t } = useLocale();
  const isMuted = useAudioStore((state) => state.isMuted);
  const masterVolume = useAudioStore((state) => state.masterVolume);
  const bgmVolume = useAudioStore((state) => state.bgmVolume);
  const sfxVolume = useAudioStore((state) => state.sfxVolume);

  // M toggles mute, but never while typing or with modifier keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "m" && event.key !== "M") return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      useAudioStore.getState().toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lobby = phase === "LOBBY";
  const notice = !manifestReady
    ? { text: t("host.audio.loading"), action: null }
    : status === "blocked"
      ? { text: t("host.audio.blocked"), action: t("host.audio.enableAudio") }
      : status === "error"
        ? { text: t("host.audio.failed"), action: t("host.audio.retry") }
        : trackCount === 0 && lobby
          ? { text: t("host.audio.noTracks"), action: null }
          : null;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={isMuted}
          onClick={() => useAudioStore.getState().toggleMute()}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border bg-panel hover:bg-subtle"
        >
          {isMuted ? (
            <VolumeX aria-hidden="true" className="size-5" />
          ) : (
            <Volume2 aria-hidden="true" className="size-5" />
          )}
          <span className="sr-only">{isMuted ? t("host.audio.unmute") : t("host.audio.mute")}</span>
        </button>
        <Popover.Root>
          <Popover.Trigger className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border bg-panel hover:bg-subtle">
            <Settings2 aria-hidden="true" className="size-5" />
            <span className="sr-only">{t("host.audio.settings")}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              collisionPadding={16}
              aria-label={t("host.audio.settings")}
              className="z-[var(--layer-menu)] flex w-72 max-w-[calc(100vw-32px)] flex-col gap-3 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-2"
            >
              <VolumeSlider
                label={t("host.audio.masterVolume")}
                value={masterVolume}
                onChange={(v) => useAudioStore.getState().setMasterVolume(v)}
              />
              <VolumeSlider
                label={t("host.audio.bgmVolume")}
                value={bgmVolume}
                onChange={(v) => useAudioStore.getState().setBgmVolume(v)}
              />
              <VolumeSlider
                label={t("host.audio.sfxVolume")}
                value={sfxVolume}
                onChange={(v) => useAudioStore.getState().setSfxVolume(v)}
              />
              <p className="text-small text-muted-foreground">{t("host.audio.localOnly")}</p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {lobby && manifestReady && trackCount > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2 text-small">
          {currentTrackLabel && (
            <span>{t("host.audio.trackPlaying", { track: currentTrackLabel })}</span>
          )}
          {trackCount > 1 && (
            <button
              type="button"
              onClick={onNextTrack}
              className="min-h-11 rounded-md border border-border bg-panel px-3 text-label hover:bg-subtle"
            >
              {t("host.audio.nextBgm")}
            </button>
          )}
        </div>
      )}
      {notice && (
        <div
          role={notice.action ? "alert" : "status"}
          className="flex flex-wrap items-center justify-end gap-2 text-small"
        >
          <span>{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              onClick={onEnableAudio}
              className="min-h-11 rounded-md border border-border bg-panel px-3 text-label hover:bg-subtle"
            >
              {notice.action}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
