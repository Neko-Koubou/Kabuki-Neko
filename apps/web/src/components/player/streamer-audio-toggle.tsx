"use client";
/**
 * Player thinking-music opt-in (Audio revision 2026-10-31; US-07/13/18/21; TASK-130B).
 *
 * Only Streamer rooms offer it: players there may hear the thinking music locally while answering.
 * Projector rooms render nothing (the shared screen carries the sound). The choice is a local,
 * session-only toggle (default off, never persisted and never sent to the room), explained by the
 * translated "Sound plays only on this device." note.
 */
import { Music } from "lucide-react";
import type { DisplayMode } from "@kabuki-neko/shared/constants/game";
import { useLocale } from "@/providers/locale-provider";
import { useAudioStore } from "@/stores/useAudioStore";

/** Props of {@link StreamerAudioToggle}. */
export interface StreamerAudioToggleProps {
  displayMode: DisplayMode | null;
}

/** Local thinking-music switch for Streamer rooms. */
export function StreamerAudioToggle({ displayMode }: StreamerAudioToggleProps) {
  const { t } = useLocale();
  const enabled = useAudioStore((state) => state.streamerBgmOptIn);
  if (displayMode !== "STREAMER") return null;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-pressed={enabled}
        aria-describedby="streamer-audio-note"
        onClick={() => useAudioStore.getState().setStreamerBgmOptIn(!enabled)}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-panel px-3 text-label hover:bg-subtle aria-pressed:border-primary"
      >
        <Music aria-hidden="true" className="size-5" />
        {enabled ? t("player.audio.streamerOptOut") : t("player.audio.streamerOptIn")}
      </button>
      <p id="streamer-audio-note" className="text-small text-muted-foreground">
        {t("player.audio.localOnly")}
      </p>
    </div>
  );
}
