/**
 * TASK-142 coverage for the M05 media picker against a scripted fake API.
 * - Five states:
 *   - loading;
 *   - empty for the type;
 *   - ideal preview + Use media;
 *   - partial (missing alternatives, invalid range, malformed link);
 *   - error source with retry.
 * - Covers: images only and no YouTube tab.
 * - Questions: clip range checked before use; a malformed external URL is refused; a YouTube link
 *   is normalized to the canonical watch URL.
 * - A pending upload can't be used until its READY answer.
 * - The question's accessibility copy stays independent of later library edits.
 * - Helpers: attachment checks and seconds.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Media } from "@kabuki-neko/shared/schemas/media.schema";
import type { UploadFn, UploadInput } from "@/components/media/asset-library-picker-upload";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import {
  MediaPicker,
  checkAttachment,
  parseSeconds,
  type MediaPickerProps,
  type QuestionMediaSelection,
} from "./media-picker";

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio/x",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = ["common", "accessibility", "media", "validation", "auth"] as const;
const ME = "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const LIMITS = { imageMb: 5, audioMb: 10, videoMb: 50 };

/** Media fixture. */
function media(n: number, overrides: Partial<Media> = {}): Media {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    uploaderId: ME,
    storageDriver: "local",
    publicUrl: `/uploads/media/${n}.webp`,
    originalName: `foto-${n}.webp`,
    mimeType: "image/webp",
    sizeBytes: 120_000,
    width: 640,
    height: 480,
    durationMs: null,
    accessibility: { altText: null, transcript: null, captions: [], visualDescription: null },
    revision: 2,
    createdAt: 1_790_000_000_000,
    inUse: false,
    canDelete: true,
    ...overrides,
  };
}

const VIDEO = media(7, {
  originalName: "klip.mp4",
  mimeType: "video/mp4",
  publicUrl: "/uploads/media/7.mp4",
  accessibility: { altText: null, transcript: "Narasi", captions: [], visualDescription: null },
});

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Page response. */
function page(items: unknown[]) {
  return json(200, {
    items,
    meta: { page: 1, limit: 24, total: items.length, totalPages: Math.ceil(items.length / 24) },
  });
}

/** Error envelope. */
function failure(status: number, errorCode: string) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params: {},
    details: [],
    correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
  });
}

/** Scripted API recording media list queries. */
function fakeApi(handler: (query: URLSearchParams) => Response | Promise<Response>) {
  const queries: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/media")) {
      queries.push(url.searchParams);
      return handler(url.searchParams);
    }
    return failure(404, "NOT_FOUND");
  });
  return { fetchMock, queries };
}

/** Renders the picker inside the providers; `rerenderPicker` keeps them. */
function renderPicker(api: ReturnType<typeof fakeApi>, props: Partial<MediaPickerProps> = {}) {
  const onClose = vi.fn();
  const onSelectCover = vi.fn();
  const onSelectQuestion = vi.fn<(selection: QuestionMediaSelection) => void>();
  const onUploadSettled = vi.fn();
  const store = createThemePreferenceStore({ storage: () => null });
  const base: MediaPickerProps = {
    open: true,
    context: "question",
    onClose,
    onSelectCover,
    onSelectQuestion,
    onUploadSettled,
    limits: LIMITS,
    ...props,
  };
  const wrap = (node: ReactElement) => (
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={api.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        {node}
      </AuthProvider>
    </ThemeProvider>
  );
  const view = renderWithLocale(wrap(<MediaPicker {...base} />), { namespaces: [...NAMESPACES] });
  return {
    ...view,
    onClose,
    onSelectCover,
    onSelectQuestion,
    onUploadSettled,
    rerenderPicker: (next: Partial<MediaPickerProps>) =>
      view.rerender(wrap(<MediaPicker {...base} {...next} />)),
  };
}

/** Deferred helper. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MediaPicker", () => {
  it("chooses a cover image from the library after a preview, with no YouTube tab", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const api = fakeApi(() => gate.promise);
    const view = renderPicker(api, { context: "cover" });
    const dialog = screen.getByRole("dialog", { name: "Choose media" });
    expect(
      within(dialog)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Media library", "Upload a file"]);
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull();
    const use = within(dialog).getByRole("button", { name: /^Use media/u });
    expect(use).toHaveAttribute("aria-disabled", "true");
    gate.resolve(page([media(1)]));
    await user.click(await within(dialog).findByRole("button", { name: "Select: foto-1.webp" }));
    expect(api.queries[0]?.get("type")).toBe("image");
    const preview = within(dialog).getByRole("region", {
      name: "Preview your selection, then choose Use media.",
    });
    expect(within(preview).getByText("Alternative text is missing.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Use media" }));
    expect(view.onSelectCover).toHaveBeenCalledWith({
      id: media(1).id,
      url: "/uploads/media/1.webp",
    });
    expect(view.onClose).toHaveBeenCalled();
  });

  it("shows the empty and error states of the source", async () => {
    const user = userEvent.setup();
    const answers = [page([]), failure(503, "DEPENDENCY_UNAVAILABLE"), page([media(1)])];
    const empty = renderPicker(fakeApi(() => answers.shift() ?? page([])));
    expect(
      await screen.findByText("There's no media of this type yet. Upload a file to add some."),
    ).toBeInTheDocument();
    empty.unmount();
    renderPicker(fakeApi(() => answers.shift() ?? page([])));
    expect(
      await screen.findByText("This source couldn't load. Only ready files can be selected."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Select: foto-1.webp" })).toBeInTheDocument();
  });

  it("checks the clip range of a library video and copies its accessibility independently", async () => {
    const user = userEvent.setup();
    let library = VIDEO;
    const view = renderPicker(fakeApi(() => page([library])));
    await user.click(await screen.findByRole("button", { name: "Select: klip.mp4" }));
    await user.clear(screen.getByLabelText(/^Start at/u));
    await user.type(screen.getByLabelText(/^Start at/u), "5");
    await user.type(screen.getByLabelText(/^End at/u), "3");
    await user.click(screen.getByRole("button", { name: "Use media" }));
    expect(screen.getByText("The end time must be after the start time.")).toBeInTheDocument();
    expect(view.onSelectQuestion).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/^End at/u));
    await user.type(screen.getByLabelText(/^End at/u), "9");
    await user.click(screen.getByRole("button", { name: "Use media" }));
    const selection = view.onSelectQuestion.mock.calls[0]?.[0];
    expect(selection).toMatchObject({
      mediaId: VIDEO.id,
      externalVideoUrl: null,
      videoStartSec: 5,
      videoEndSec: 9,
      accessibility: VIDEO.accessibility,
    });
    expect(selection?.preview).toMatchObject({ kind: "video", startSec: 5, endSec: 9 });
    // A later library edit doesn't reach the question's copy.
    library = media(7, {
      ...VIDEO,
      accessibility: { ...VIDEO.accessibility, transcript: "Diubah di library" },
    });
    view.rerenderPicker({ open: false });
    view.rerenderPicker({ open: true });
    await user.click(await screen.findByRole("button", { name: "Select: klip.mp4" }));
    expect(selection?.accessibility.transcript).toBe("Narasi");
  });

  it("refuses a malformed external URL and normalizes a YouTube link", async () => {
    const user = userEvent.setup();
    const view = renderPicker(fakeApi(() => page([])));
    await user.click(screen.getByRole("tab", { name: "YouTube video" }));
    expect(
      screen.getByText("A question can have either an uploaded file or a YouTube video, not both."),
    ).toBeInTheDocument();
    const link = screen.getByLabelText(/^Video link/u);
    await user.type(link, "https://evil.example/watch?v=dQw4w9WgXcQ");
    await user.click(screen.getByRole("button", { name: "Use media" }));
    expect(screen.getByText("This value isn't in the expected format.")).toBeInTheDocument();
    expect(view.onSelectQuestion).not.toHaveBeenCalled();
    await user.clear(link);
    await user.type(link, "https://youtu.be/dQw4w9WgXcQ");
    await user.clear(screen.getByLabelText(/^Start at/u));
    await user.type(screen.getByLabelText(/^Start at/u), "10");
    await user.type(screen.getByLabelText(/^End at/u), "20");
    await user.click(screen.getByRole("button", { name: "Use media" }));
    expect(view.onSelectQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId: null,
        externalVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        videoStartSec: 10,
        videoEndSec: 20,
        accessibility: { altText: null, transcript: null, captions: [], visualDescription: null },
      }),
    );
  });

  it("keeps a pending upload unusable until it is READY", async () => {
    const user = userEvent.setup();
    const ready = deferred<Media>();
    const upload: UploadFn = vi.fn(async (input: UploadInput) => {
      input.onProcessing();
      return ready.promise;
    });
    const view = renderPicker(
      fakeApi(() => page([])),
      { context: "cover", upload },
    );
    await user.click(screen.getByRole("tab", { name: "Upload a file" }));
    expect(screen.queryByRole("button", { name: /^Select:/u })).not.toBeInTheDocument();
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
    expect(input).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(10)], "baru.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Processing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Use media/u })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect((upload as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      folder: "covers",
    });
    ready.resolve(media(11, { originalName: "baru.png" }));
    await waitFor(() =>
      expect(view.onUploadSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id: media(11).id }),
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Use media" }));
    expect(view.onSelectCover).toHaveBeenCalledWith({
      id: media(11).id,
      url: "/uploads/media/11.webp",
    });
  });

  it("validates attachments with the shared rules", () => {
    expect(
      checkAttachment({
        mediaId: VIDEO.id,
        youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
        isVideo: true,
        start: "0",
        end: "",
      }),
    ).toEqual({ ok: false, problem: "media.source.exclusiveAttachment" });
    expect(
      checkAttachment({
        mediaId: media(1).id,
        youtubeUrl: null,
        isVideo: false,
        start: "4",
        end: "9",
      }),
    ).toEqual({
      ok: true,
      value: { mediaId: media(1).id, externalVideoUrl: null, videoStartSec: 0, videoEndSec: null },
    });
    expect(parseSeconds("")).toBeNull();
    expect(parseSeconds("1.5")).toBeNaN();
    expect(parseSeconds("12")).toBe(12);
  });
});
