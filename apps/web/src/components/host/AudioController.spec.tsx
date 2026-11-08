/**
 * TASK-130B coverage for the host audio controller and the player Streamer opt-in: mute button and
 * M shortcut (ignored in inputs, editors and with modifiers), keyboard access to the settings
 * popover with labelled sliders and clamped volumes, lobby-only track title and Next track, the
 * loading/empty/blocked/error states with their actions, Projector exclusion, the session-only
 * opt-in that is never persisted, and listener cleanup on exit.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_PREFERENCE_STORAGE_KEY } from "@kabuki-neko/shared/constants/audio";
import { StreamerAudioToggle } from "@/components/player/streamer-audio-toggle";
import { useAudioStore } from "@/stores/useAudioStore";
import { renderWithLocale } from "@/test/locale";
import { AudioController, isEditableTarget, type AudioControllerProps } from "./AudioController";

const NAMESPACES = ["common", "accessibility", "host", "player"] as const;

/** Renders the controller with defaults. */
function renderController(props: Partial<AudioControllerProps> = {}) {
  const onNextTrack = vi.fn();
  const onEnableAudio = vi.fn();
  const view = renderWithLocale(
    <AudioController
      phase="LOBBY"
      status="ready"
      manifestReady
      trackCount={4}
      currentTrackLabel="Kabuki Matsuri"
      onNextTrack={onNextTrack}
      onEnableAudio={onEnableAudio}
      {...props}
    />,
    { namespaces: [...NAMESPACES] },
  );
  return { ...view, onNextTrack, onEnableAudio };
}

beforeEach(() => {
  localStorage.clear();
  useAudioStore.setState({
    isMuted: false,
    masterVolume: 0.8,
    bgmVolume: 0.7,
    sfxVolume: 0.9,
    currentLobbyTrackId: null,
    streamerBgmOptIn: false,
  });
});

describe("AudioController", () => {
  it("toggles mute by button and M, but not while typing or with modifiers", async () => {
    const user = userEvent.setup();
    renderController();
    const mute = screen.getByRole("button", { name: "Mute" });
    await user.click(mute);
    expect(useAudioStore.getState().isMuted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveFocus();

    await user.keyboard("m");
    expect(useAudioStore.getState().isMuted).toBe(false);
    fireEvent.keyDown(window, { key: "m", ctrlKey: true });
    fireEvent.keyDown(window, { key: "M", shiftKey: true });
    fireEvent.keyDown(window, { key: "m", metaKey: true });
    expect(useAudioStore.getState().isMuted).toBe(false);

    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(input, editor);
    input.focus();
    await user.keyboard("m");
    expect(input).toHaveValue("m");
    expect(useAudioStore.getState().isMuted).toBe(false);
    expect(isEditableTarget(editor)).toBe(true);
    expect(
      isEditableTarget(Object.assign(document.createElement("input"), { type: "range" })),
    ).toBe(false);
    input.remove();
    editor.remove();
  });

  it("opens the settings popover by keyboard with labelled sliders and clamped volumes", async () => {
    const user = userEvent.setup();
    renderController();
    const trigger = screen.getByRole("button", { name: "Sound settings" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Sound settings" });
    const master = within(dialog).getByRole("slider", { name: /^Volume/u });
    const music = within(dialog).getByRole("slider", { name: /^Music volume/u });
    const effects = within(dialog).getByRole("slider", { name: /^Sound effects volume/u });
    expect([master, music, effects].map((slider) => (slider as HTMLInputElement).value)).toEqual([
      "80",
      "70",
      "90",
    ]);
    expect(music).toHaveAttribute("aria-valuetext", "70%");
    fireEvent.change(music, { target: { value: "35" } });
    expect(useAudioStore.getState().bgmVolume).toBe(0.35);
    useAudioStore.getState().setSfxVolume(4);
    expect(useAudioStore.getState().sfxVolume).toBe(1);
    expect(within(dialog).getByText("Sound plays only on this device.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows the track title and Next track only in the lobby", async () => {
    const user = userEvent.setup();
    const { rerender, onNextTrack, onEnableAudio } = renderController();
    expect(screen.getByText("Now playing: Kabuki Matsuri")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next track" }));
    expect(onNextTrack).toHaveBeenCalledTimes(1);
    expect(onEnableAudio).not.toHaveBeenCalled();
    rerender(
      <AudioController
        phase="QUESTION_ANSWERING"
        status="ready"
        manifestReady
        trackCount={4}
        currentTrackLabel="Kabuki Matsuri"
        onNextTrack={onNextTrack}
        onEnableAudio={onEnableAudio}
      />,
    );
    expect(screen.queryByRole("button", { name: "Next track" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Now playing/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute" })).toBeInTheDocument();
  });

  it("covers loading, empty, blocked and failed states", async () => {
    const user = userEvent.setup();
    const { rerender, onEnableAudio } = renderController({ manifestReady: false });
    expect(screen.getByRole("status")).toHaveTextContent("Loading sound…");
    const base = {
      phase: "LOBBY" as const,
      currentTrackLabel: null,
      onNextTrack: vi.fn(),
      onEnableAudio,
    };
    rerender(<AudioController {...base} status="ready" manifestReady trackCount={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("No music tracks available.");
    rerender(<AudioController {...base} status="blocked" manifestReady trackCount={4} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your browser blocked sound.");
    await user.click(screen.getByRole("button", { name: "Turn on sound" }));
    rerender(<AudioController {...base} status="error" manifestReady trackCount={4} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sound couldn't play. The game continues without it.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onEnableAudio).toHaveBeenCalledTimes(2);
  });

  it("removes the M shortcut when leaving the stage", () => {
    const { unmount } = renderController();
    unmount();
    fireEvent.keyDown(window, { key: "m" });
    expect(useAudioStore.getState().isMuted).toBe(false);
  });
});

describe("StreamerAudioToggle", () => {
  it("is absent in Projector rooms and a session-only local opt-in in Streamer rooms", async () => {
    const user = userEvent.setup();
    const { rerender, container } = renderWithLocale(
      <StreamerAudioToggle displayMode="PROJECTOR" />,
      { namespaces: [...NAMESPACES] },
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<StreamerAudioToggle displayMode="STREAMER" />);
    const toggle = screen.getByRole("button", { name: "Play thinking music on this device" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAccessibleDescription("Sound plays only on this device.");
    await user.click(toggle);
    expect(useAudioStore.getState().streamerBgmOptIn).toBe(true);
    expect(screen.getByRole("button", { name: "Turn off thinking music" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Policy: the opt-in is never written to storage.
    useAudioStore.getState().setMasterVolume(0.5);
    expect(localStorage.getItem(AUDIO_PREFERENCE_STORAGE_KEY) ?? "").not.toContain(
      "streamerBgmOptIn",
    );
  });
});
