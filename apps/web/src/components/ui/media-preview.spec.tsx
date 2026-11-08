/**
 * TASK-122 coverage for B11 MediaPreview and the progressive reveal: rejected URLs (scripts, data,
 * foreign hosts, traversal, non-YouTube embeds) never reach the DOM; allowed uploads/origins and
 * privacy-enhanced YouTube embeds with clip bounds; video clip start/end and half-open caption cue
 * boundaries with a captions toggle; blocked autoplay with a user play action; unavailable assets
 * with retry; transcript/visual description and honest "not available" notes; reveal progress
 * derived only from the server clock (no frame-count drift under irregular ticks), deterministic
 * tile order, discrete reduced-motion blur, completion, and a failing image that does not stop it.
 */
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { renderWithLocale } from "@/test/locale";
import {
  MediaPreview,
  activeCaption,
  isAllowedMediaUrl,
  youtubeEmbedUrl,
  type MediaAsset,
} from "./media-preview";
import {
  MAX_BLUR_PX,
  MediaReveal,
  blurRadius,
  cellOrder,
  revealProgress,
  revealedCellCount,
} from "./media-reveal";

const NAMESPACES = ["common", "accessibility", "media"] as const;

/** Builds an asset with defaults. */
function asset(overrides: Partial<MediaAsset>): MediaAsset {
  return {
    kind: "image",
    url: "/uploads/quiz/cover.webp",
    width: 800,
    height: 600,
    startSec: 0,
    endSec: null,
    accessibility: emptyAccessibility(),
    ...overrides,
  };
}

/** Renders a preview with the media namespace loaded. */
function show(element: Parameters<typeof renderWithLocale>[0]) {
  return renderWithLocale(element, { namespaces: [...NAMESPACES] });
}

describe("URL allowlist", () => {
  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://evil.example/x.png",
    "/uploads/../secret.png",
    "//evil.example/uploads/a.png",
    "/static/a.png",
    "https://user:pass@cdn.example.com/a.png",
  ])("rejects %s", (url) => {
    expect(isAllowedMediaUrl(url, ["https://cdn.example.com"])).toBe(false);
  });

  it("accepts same-origin uploads and configured origins only", () => {
    expect(isAllowedMediaUrl("/uploads/a/b-c_d.webp")).toBe(true);
    expect(
      isAllowedMediaUrl("https://cdn.example.com/media/a.webp", ["https://cdn.example.com"]),
    ).toBe(true);
    expect(isAllowedMediaUrl("https://cdn.example.com/media/a.webp")).toBe(false);
    expect(youtubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ", 15, 45, false)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&start=15&end=45",
    );
    expect(youtubeEmbedUrl("https://vimeo.com/123456", 0, null, false)).toBeNull();
    expect(
      youtubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=x", 0, null, false),
    ).toBeNull();
  });

  it("shows the unavailable placeholder and reports a rejected URL without rendering it", () => {
    const onError = vi.fn();
    const { container } = show(
      <MediaPreview asset={asset({ url: "javascript:alert(1)" })} onError={onError} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("This media isn't available.");
    expect(container.querySelector("img, iframe, video, audio")).toBeNull();
    expect(onError).toHaveBeenCalledWith("REJECTED_URL");

    const { container: embed } = show(
      <MediaPreview
        asset={asset({ kind: "youtube", url: "https://vimeo.com/1", width: null, height: null })}
      />,
    );
    expect(embed.querySelector("iframe")).toBeNull();
  });
});

describe("B11 MediaPreview", () => {
  it("renders images with their alt, reserved ratio and a retry after a load failure", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { container } = show(
      <MediaPreview
        asset={asset({ accessibility: { ...emptyAccessibility(), altText: "A red torii gate" } })}
        onError={onError}
      />,
    );
    const image = screen.getByRole("img", { name: "A red torii gate" });
    expect((container.firstElementChild as HTMLElement).style.aspectRatio).toMatch(/^1\.3333/u);
    fireEvent.error(image);
    expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
    expect(onError).toHaveBeenCalledWith("LOAD_FAILED");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("img", { name: "A red torii gate" })).toBeInTheDocument();
  });

  it("embeds YouTube from the privacy-enhanced host in a sandbox with clip bounds", () => {
    const { container } = show(
      <MediaPreview
        asset={asset({
          kind: "youtube",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          startSec: 10,
          endSec: 20,
          width: null,
          height: null,
        })}
      />,
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&start=10&end=20",
    );
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-presentation",
    );
    expect(frame).toHaveAttribute("title", "YouTube video");
  });

  it("keeps video inside the clip and shows captions on half-open cue boundaries", async () => {
    const user = userEvent.setup();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const captions = [
      { startMs: 5_000, endMs: 6_000, text: "Konnichiwa" },
      { startMs: 6_000, endMs: 7_500, text: "Welcome" },
    ];
    const { container } = show(
      <MediaPreview
        asset={asset({
          kind: "video",
          url: "/uploads/v/clip.mp4",
          startSec: 5,
          endSec: 8,
          accessibility: { ...emptyAccessibility(), captions },
        })}
      />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    let current = 0;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => current,
      set: (value: number) => {
        current = value;
      },
    });
    fireEvent.loadedMetadata(video);
    expect(current).toBe(5);

    const at = (seconds: number) => {
      current = seconds;
      fireEvent.timeUpdate(video);
    };
    at(5.999);
    expect(screen.getByText("Konnichiwa")).toBeInTheDocument();
    at(6);
    expect(screen.queryByText("Konnichiwa")).not.toBeInTheDocument();
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    at(7.5);
    expect(screen.queryByText("Welcome")).not.toBeInTheDocument();
    at(2);
    expect(current).toBe(5); // before the clip → snapped to its start
    at(8.2);
    expect(pause).toHaveBeenCalled();
    expect(current).toBe(8);

    at(5.5);
    const toggle = screen.getByRole("button", { name: "Captions" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(screen.queryByText("Konnichiwa")).not.toBeInTheDocument();
    expect(activeCaption(captions, 7.499)?.text).toBe("Welcome");
  });

  it("falls back to a user play action when autoplay is blocked", async () => {
    const user = userEvent.setup();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const onUserPlay = vi.fn();
    const { container } = show(
      <MediaPreview
        asset={asset({ kind: "audio", url: "/uploads/a/song.mp3", width: null, height: null })}
        autoPlay
        onUserPlay={onUserPlay}
      />,
    );
    await act(async () => {
      fireEvent.canPlay(container.querySelector("audio") as HTMLAudioElement);
    });
    expect(screen.getByText("Your browser blocked automatic playback.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn on playback" }));
    expect(onUserPlay).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Your browser blocked automatic playback.")).not.toBeInTheDocument();
  });

  it("shows transcripts and visual descriptions, and says when they are missing", () => {
    const { rerender } = show(
      <MediaPreview
        asset={asset({
          kind: "audio",
          url: "/uploads/a/song.mp3",
          accessibility: {
            ...emptyAccessibility(),
            transcript: "Shamisen melody.",
            visualDescription: "A stage.",
          },
        })}
      />,
    );
    expect(screen.getByText("Transcript")).toBeInTheDocument();
    expect(screen.getByText("Shamisen melody.")).toBeInTheDocument();
    expect(screen.getByText("Visual description")).toBeInTheDocument();
    rerender(<MediaPreview asset={asset({ kind: "audio", url: "/uploads/a/song.mp3" })} />);
    expect(screen.getByText("A transcript isn't available for this audio.")).toBeInTheDocument();
    rerender(<MediaPreview asset={asset({ kind: "video", url: "/uploads/v/clip.mp4" })} />);
    expect(screen.getByText("Captions aren't available for this video.")).toBeInTheDocument();
    rerender(<MediaPreview asset={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("progressive reveal", () => {
  it("derives progress and tiles only from the clock and the authoritative window", () => {
    expect(revealProgress(-5, 0, 9_000)).toBe(0);
    expect(revealProgress(4_500, 0, 9_000)).toBe(0.5);
    expect(revealProgress(99_000, 0, 9_000)).toBe(1);
    expect(revealProgress(NaN, 0, 9_000)).toBe(0);
    expect(
      [0, 999, 1_000, 4_500, 8_999, 9_000].map((t) =>
        revealedCellCount("GRID_3X3", revealProgress(t, 0, 9_000)),
      ),
    ).toEqual([0, 0, 1, 4, 8, 9]);
    expect(revealedCellCount("GRID_5X5", 0.5)).toBe(12);
    expect(blurRadius(0, false)).toBe(MAX_BLUR_PX);
    expect(blurRadius(1, false)).toBe(0);
    expect(blurRadius(0.3, true)).toBe((MAX_BLUR_PX * 3) / 4); // discrete step: ceil(0.7×4)/4 = 0.75
    expect(blurRadius(0.5, true)).toBe(MAX_BLUR_PX / 2);
    expect(blurRadius(0.8, true)).toBe(MAX_BLUR_PX / 4);
  });

  it("uses a deterministic, shared tile order per question", () => {
    const order = cellOrder("GRID_5X5", "question-7");
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(cellOrder("GRID_5X5", "question-7")).toEqual(order);
    expect(cellOrder("GRID_5X5", "question-8")).not.toEqual(order);
  });

  it("shows the clock-derived step under irregular ticks, keeps going when the image fails, and completes", () => {
    vi.useFakeTimers();
    let serverNow = 1_000_000;
    const now = () => serverNow;
    const { container, rerender } = show(
      <MediaReveal mode="GRID_3X3" seed="q-1" startsAt={1_000_000} endsAt={1_009_000} now={now}>
        <MediaPreview asset={asset({})} />
      </MediaReveal>,
    );
    const covered = () => container.querySelectorAll("[data-covered='true']").length;
    expect(covered()).toBe(9);
    // Simulate a throttled tab: the clock jumps irregularly between ticks.
    for (const jump of [700, 2_350, 90, 1_610]) {
      serverNow += jump;
      act(() => vi.advanceTimersByTime(100));
      expect(covered()).toBe(
        9 - revealedCellCount("GRID_3X3", revealProgress(serverNow, 1_000_000, 1_009_000)),
      );
    }
    // The image fails: the placeholder shows, the reveal keeps progressing.
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
    serverNow = 1_008_999;
    act(() => vi.advanceTimersByTime(100));
    expect(covered()).toBe(1);
    serverNow = 1_009_000;
    act(() => vi.advanceTimersByTime(100));
    expect(covered()).toBe(0);

    rerender(
      <MediaReveal
        mode="BLUR"
        seed="q-1"
        startsAt={1_000_000}
        endsAt={1_009_000}
        now={() => 1_000_000}
        complete
      >
        <span>media</span>
      </MediaReveal>,
    );
    expect(container.querySelector("[data-reveal-progress]")).toHaveAttribute(
      "data-reveal-progress",
      "1.000",
    );
  });
});
