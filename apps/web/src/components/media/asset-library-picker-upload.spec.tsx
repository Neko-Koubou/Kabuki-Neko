/**
 * TASK-141 coverage for the S08 media library and F06 picker against a scripted fake API.
 * - Five states:
 *   - loading skeleton;
 *   - ideal cards (24-per-page query, in-use badge, missing alternatives);
 *   - empty and no-match;
 *   - error with retry;
 *   - partial (some uploads failed while others succeeded).
 * - Uploads:
 *   - wrong MIME (SVG) and oversized files are refused before sending;
 *   - progress, then processing, then READY;
 *   - per-file failures with retry (new key);
 *   - a lost response is reconciled through `/operations/:key`.
 * - Metadata: If-Match PATCH, a revision conflict explained with reload, and an invalid caption
 *   range.
 * - Delete: M09 with an "in use" answer from the server, and blocked delete for media in use.
 * - Picker: locked kind and selection of READY items only.
 * - Helpers: URL query, file checks, seconds.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Media } from "@kabuki-neko/shared/schemas/media.schema";
import { ApiError } from "@/lib/api-client";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import {
  AssetLibrary,
  fileProblem,
  mediaHref,
  mediaKind,
  parseMediaQuery,
  secondsToMs,
  type AssetLibraryProps,
  type MediaQuery,
  type UploadFn,
  type UploadInput,
} from "./asset-library-picker-upload";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/media",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = ["common", "accessibility", "media", "validation", "auth"] as const;
const ALL: MediaQuery = { type: null, search: "", page: 1 };
const ME = "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";
const LIMITS = { imageMb: 1, audioMb: 2, videoMb: 3 };
const MIB = 1024 * 1024;

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

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Page response. */
function page(items: unknown[], total = items.length) {
  return json(200, {
    items,
    meta: { page: 1, limit: 24, total, totalPages: Math.ceil(total / 24) },
  });
}

/** Error envelope. */
function failure(status: number, errorCode: string, params: Record<string, unknown> = {}) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params,
    details: [],
    correlationId: CORRELATION,
  });
}

/** One recorded request. */
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** Scripted API: handler per call; records every request. */
function fakeApi(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    return handler(call);
  });
  return {
    calls,
    fetchMock,
    lists: () => calls.filter((call) => call.path === "/media" && call.method === "GET"),
  };
}

/** Renders the library inside the providers. */
function renderLibrary(api: ReturnType<typeof fakeApi>, props: Partial<AssetLibraryProps> = {}) {
  const onQueryChange = vi.fn();
  const store = createThemePreferenceStore({ storage: () => null });
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
  const view = renderWithLocale(
    wrap(<AssetLibrary query={ALL} onQueryChange={onQueryChange} limits={LIMITS} {...props} />),
    { namespaces: [...NAMESPACES] },
  );
  return { ...view, onQueryChange };
}

/** A file of `size` bytes. */
function file(name: string, type: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type });
}

/** Adds files through the hidden file input. */
function choose(files: File[]) {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
  fireEvent.change(input, { target: { files } });
}

/** Deferred value helper. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AssetLibrary", () => {
  it("shows a skeleton, then cards with the 24-per-page query, in-use badge and missing alternatives", async () => {
    const gate = deferred<Response>();
    const api = fakeApi((call) =>
      call.path === "/media" ? gate.promise : failure(404, "NOT_FOUND"),
    );
    renderLibrary(api);
    expect(screen.getByRole("heading", { level: 1, name: "Media library" })).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    gate.resolve(
      page([
        media(1),
        media(2, {
          originalName: "lagu.mp3",
          mimeType: "audio/mpeg",
          publicUrl: "/uploads/media/2.mp3",
          width: null,
          height: null,
          durationMs: 3_000,
          inUse: true,
          canDelete: false,
        }),
      ]),
    );
    expect(await screen.findByText("foto-1.webp")).toBeInTheDocument();
    const [list] = api.lists();
    expect(list?.query.get("limit")).toBe("24");
    expect(list?.query.get("page")).toBe("1");
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(screen.getByText("Alternative text is missing.")).toBeInTheDocument();
    expect(screen.getByText("A transcript is missing.")).toBeInTheDocument();
    const blocked = screen.getByRole("button", { name: /^Delete: lagu\.mp3/u });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription(
      "This file is used by a quiz or room, so it can't be deleted right now.",
    );
  });

  it("covers empty, no matches and a failed load with retry", async () => {
    const user = userEvent.setup();
    const answers = [page([]), failure(503, "DEPENDENCY_UNAVAILABLE"), page([media(1)])];
    const api = fakeApi((call) =>
      call.path === "/media" ? (answers.shift() ?? page([])) : failure(404, "NOT_FOUND"),
    );
    const empty = renderLibrary(api);
    expect(
      await screen.findByText(
        "No media yet. Upload images, audio or video to use in your quizzes.",
      ),
    ).toBeInTheDocument();
    empty.unmount();
    const errored = renderLibrary(api, { query: { ...ALL, search: "kucing" } });
    expect(
      await screen.findByText("Something went wrong. Failed uploads can be retried one by one."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("foto-1.webp")).toBeInTheDocument();
    errored.unmount();
    const none = renderLibrary(
      fakeApi(() => page([])),
      { query: { ...ALL, search: "zzz" } },
    );
    expect(await screen.findByText("No results")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(none.onQueryChange).toHaveBeenCalledWith({ type: null, search: "", page: 1 });
  });

  it("refuses wrong types and sizes before sending, shows progress and keeps per-file failures", async () => {
    const user = userEvent.setup();
    const api = fakeApi((call) => (call.path === "/media" ? page([]) : failure(404, "NOT_FOUND")));
    const first = deferred<Media>();
    const sent: UploadInput[] = [];
    let call = 0;
    const upload: UploadFn = vi.fn(async (input: UploadInput) => {
      sent.push(input);
      call += 1;
      if (input.file.name === "cat.png") {
        input.onProgress(40);
        return first.promise;
      }
      if (call <= 2) throw new ApiError(503, "STORAGE_UNAVAILABLE");
      return media(9, { originalName: input.file.name });
    });
    renderLibrary(api, { upload });
    expect(await screen.findByText("Images: Maximum size: 1 MiB")).toBeInTheDocument();
    choose([
      file("logo.svg", "image/svg+xml"),
      file("big.png", "image/png", 1.5 * MIB),
      file("cat.png", "image/png"),
      file("dog.png", "image/png"),
    ]);
    expect(await screen.findByText("This file type isn't supported.")).toBeInTheDocument();
    expect(screen.getByText("This file is too large.")).toBeInTheDocument();
    expect(await screen.findByText("Uploading… 40%")).toBeInTheDocument();
    expect(
      await screen.findByText("File storage is temporarily unavailable. Please try again shortly."),
    ).toBeInTheDocument();
    // Neither the SVG nor the oversized file was sent.
    expect(sent.map((input) => input.file.name).sort()).toEqual(["cat.png", "dog.png"]);
    expect(sent[0]?.folder).toBe("questions");
    const lists = api.lists().length;
    first.resolve(media(8, { originalName: "cat.png" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    await waitFor(() => expect(api.lists().length).toBeGreaterThan(lists));
    expect(
      screen.getByText(
        "Some previews couldn't load, some files are still processing, or some are in use.",
      ),
    ).toBeInTheDocument();
    const dogKey = sent.find((input) => input.file.name === "dog.png")?.idempotencyKey;
    await user.click(screen.getByRole("button", { name: "Try again: dog.png" }));
    await waitFor(() =>
      expect(sent.filter((input) => input.file.name === "dog.png")).toHaveLength(2),
    );
    expect(sent.at(-1)?.idempotencyKey).not.toBe(dogKey);
    await waitFor(() => expect(screen.getAllByText("Saved")).toHaveLength(2));
    // The invalid files offer no retry.
    expect(screen.queryByRole("button", { name: "Try again: logo.svg" })).not.toBeInTheDocument();
  });

  it("reconciles a lost upload response through its idempotency key", async () => {
    const api = fakeApi((request) =>
      request.path === "/media"
        ? page([])
        : request.path.startsWith("/operations/")
          ? json(200, {
              key: request.path.split("/").at(-1),
              operation: "media.upload",
              status: "done",
              resourceId: media(5).id,
            })
          : failure(404, "NOT_FOUND"),
    );
    const upload: UploadFn = vi.fn(async (input: UploadInput) => {
      input.onProcessing();
      throw new ApiError(0, "NETWORK_ERROR", {}, [], null, true);
    });
    renderLibrary(api, { upload });
    await screen.findByText("No media yet. Upload images, audio or video to use in your quizzes.");
    choose([file("sky.webp", "image/webp")]);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const lookup = api.calls.find((call) => call.path.startsWith("/operations/"));
    expect(lookup?.query.get("operation")).toBe("media.upload");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("saves accessibility with If-Match and explains a revision conflict", async () => {
    const user = userEvent.setup();
    let patches = 0;
    const api = fakeApi((call) => {
      if (call.path === "/media" && call.method === "GET") return page([media(1)]);
      if (call.method === "PATCH") {
        patches += 1;
        return patches === 1
          ? failure(409, "REVISION_CONFLICT", { expectedRevision: 2, currentRevision: 3 })
          : json(200, media(1, { revision: 3 }));
      }
      return failure(404, "NOT_FOUND");
    });
    renderLibrary(api);
    await user.click(await screen.findByRole("button", { name: "Edit: foto-1.webp" }));
    const dialog = await screen.findByRole("dialog", { name: "foto-1.webp" });
    expect(within(dialog).getByText("Alternative text is missing.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Alternative text/u)).toHaveValue("");
    await user.type(within(dialog).getByLabelText(/^Alternative text/u), "Kucing tidur");
    expect(within(dialog).queryByText("Alternative text is missing.")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch?.headers.get("If-Match")).toBe('"2"');
    expect(patch?.body).toEqual({
      accessibility: {
        altText: "Kucing tidur",
        transcript: null,
        captions: [],
        visualDescription: null,
      },
    });
    expect(
      await within(dialog).findByText(
        "Someone else changed this (your version 2, latest version 3). Reload to see the latest changes.",
      ),
    ).toBeInTheDocument();
    const lists = api.lists().length;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(api.lists().length).toBeGreaterThan(lists));
    await user.click(await screen.findByRole("button", { name: "Edit: foto-1.webp" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("validates caption ranges for video before saving", async () => {
    const user = userEvent.setup();
    const api = fakeApi((call) =>
      call.path === "/media"
        ? page([
            media(3, {
              originalName: "klip.mp4",
              mimeType: "video/mp4",
              publicUrl: "/uploads/media/3.mp4",
            }),
          ])
        : failure(404, "NOT_FOUND"),
    );
    renderLibrary(api);
    await user.click(await screen.findByRole("button", { name: "Edit: klip.mp4" }));
    const dialog = await screen.findByRole("dialog", { name: "klip.mp4" });
    expect(within(dialog).getByText("Captions are missing.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add caption" }));
    const cue = within(dialog).getByRole("group", { name: "Caption 1" });
    await user.clear(within(cue).getByLabelText(/^End time/u));
    await user.type(within(cue).getByLabelText(/^End time/u), "0");
    await user.type(within(cue).getByLabelText(/^Caption text/u), "Halo");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(cue).getByText("The end time must be after the start time.")).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("deletes through M09 and reports an in-use answer from the server", async () => {
    const user = userEvent.setup();
    let deletes = 0;
    const api = fakeApi((call) => {
      if (call.path === "/media" && call.method === "GET") return page([media(1)]);
      if (call.method === "DELETE") {
        deletes += 1;
        return deletes === 1 ? failure(409, "MEDIA_IN_USE") : json(200, { deleted: true });
      }
      return failure(404, "NOT_FOUND");
    });
    renderLibrary(api);
    await user.click(await screen.findByRole("button", { name: /^Delete: foto-1\.webp/u }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Delete this media file? It can't be restored."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Delete/u }));
    expect(
      await within(dialog).findByText(
        "This media is used by a quiz or game, so it can't be deleted.",
      ),
    ).toBeInTheDocument();
    // Blocked: only Close remains; a later attempt can succeed.
    expect(within(dialog).queryByRole("button", { name: /^Delete/u })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const lists = api.lists().length;
    await user.click(screen.getByRole("button", { name: /^Delete: foto-1\.webp/u }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /^Delete/u }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(api.lists().length).toBeGreaterThan(lists));
    expect(api.calls.filter((call) => call.method === "DELETE")[0]?.path).toBe(
      `/media/${media(1).id}`,
    );
  });

  it("locks the picker to one kind and selects READY items", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const api = fakeApi((call) =>
      call.path === "/media" ? page([media(1)]) : failure(404, "NOT_FOUND"),
    );
    renderLibrary(api, { mode: "picker", lockedKind: "image", folder: "covers", onSelect });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Choose media" }),
    ).toBeInTheDocument();
    expect(api.lists()[0]?.query.get("type")).toBe("image");
    expect(screen.queryByRole("tab", { name: "Audio" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toHaveAttribute(
      "accept",
      "image/jpeg,image/png,image/webp",
    );
    await user.click(screen.getByRole("button", { name: "Select: foto-1.webp" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: media(1).id }));
  });

  it("parses the URL query and checks files", () => {
    expect(parseMediaQuery({ type: "video", search: "klip", page: "3" })).toEqual({
      type: "video",
      search: "klip",
      page: 3,
    });
    expect(parseMediaQuery({ type: "svg", page: "-2" })).toEqual({
      type: null,
      search: "",
      page: 1,
    });
    expect(mediaHref({ type: "image", search: "kucing", page: 2 })).toBe(
      "/dashboard/media?type=image&search=kucing&page=2",
    );
    expect(mediaHref(ALL)).toBe("/dashboard/media");
    expect(mediaKind("image/svg+xml")).toBeNull();
    expect(mediaKind("video/webm")).toBe("video");
    expect(fileProblem({ type: "audio/mpeg", size: 3 * MIB }, LIMITS)).toBe("tooLarge");
    expect(fileProblem({ type: "audio/mpeg", size: MIB }, LIMITS, "image")).toBe("unsupportedType");
    expect(fileProblem({ type: "image/png", size: MIB }, LIMITS)).toBeNull();
    expect(secondsToMs("1,5")).toBe(1_500);
    expect(secondsToMs("")).toBeNull();
  });
});
