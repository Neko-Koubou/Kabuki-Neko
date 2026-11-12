/**
 * TASK-140 coverage for the M04 import dialog against a scripted fake API.
 * - Five states: empty (no file), loading (uploading), ideal (imported, then opening the studio),
 *   partial (problems listed with row/column, total count and focused summary) and error
 *   (unconfirmed outcome, checked before any retry).
 * - Client checks: unsupported type and size limit, before any upload.
 * - Server problems: malformed CSV, unsupported version, missing media (path location).
 * - Media mapping to the user's own media of the same kind, sent as `mediaMap`.
 * - Lost responses: reconciled through `quiz.import`. A confirmed quiz opens without re-sending;
 *   "not received" re-sends with the same Idempotency-Key.
 * - Template download; parsing helpers; the library's Import button opens the dialog.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import {
  ImportDialog,
  detectFormat,
  issueLocation,
  parseCsvRows,
  referencedMedia,
} from "./import-export";
import { QuizLibrary } from "./quiz-library-detail";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/quizzes",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = [
  "common",
  "accessibility",
  "quizzes",
  "validation",
  "media",
  "host",
  "auth",
] as const;
const QUIZ_ID = "8d6f1a5e-2b4c-4d8e-9f10-112233445566";
const REF = "aaaaaaaa-1111-4222-8333-444444444444";
const OWNED_IMAGE = "bbbbbbbb-1111-4222-8333-444444444444";
const OWNED_AUDIO = "cccccccc-1111-4222-8333-444444444444";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
/** Error envelope. */
function failure(
  status: number,
  errorCode: string,
  details: unknown[] = [],
  params: Record<string, unknown> = {},
) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params,
    details,
    correlationId: CORRELATION,
  });
}
/** Created quiz. */
function created() {
  return json(201, {
    id: QUIZ_ID,
    creatorId: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
    creatorName: "Ayu",
    title: "Kuis Impor",
    description: null,
    coverMedia: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    revision: 1,
    questionCount: 1,
    isPlayable: false,
    updatedAt: 1,
    capabilities: {
      canEdit: true,
      canDelete: true,
      canDuplicate: true,
      canHost: true,
      canExport: true,
    },
    createdAt: 1,
    questions: [{ ...blankQuestion(), orderIndex: 0 }],
    media: [],
    validationIssues: [],
  });
}
/** Owned media page for the mapping step. */
function mediaPage() {
  const media = (id: string, name: string, mimeType: string) => ({
    id,
    uploaderId: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
    storageDriver: "local",
    publicUrl: `/uploads/${id}.bin`,
    originalName: name,
    mimeType,
    sizeBytes: 10,
    width: null,
    height: null,
    durationMs: null,
    accessibility: emptyAccessibility(),
    revision: 1,
    createdAt: 1,
    inUse: false,
    canDelete: true,
  });
  return json(200, {
    items: [
      media(OWNED_IMAGE, "sampul-sekolah.png", "image/png"),
      media(OWNED_AUDIO, "lagu.mp3", "audio/mpeg"),
    ],
    meta: { page: 1, limit: 100, total: 2, totalPages: 1 },
  });
}

/** One recorded request. */
interface Call {
  method: string;
  path: string;
  body: BodyInit | null | undefined;
  headers: Headers;
}

/** Renders `ui` with the root providers over a scripted API. */
function renderApp(ui: ReactElement, handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname.replace("/api/v1", "")}${url.search}`,
      body: init?.body,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call);
  });
  const view = renderWithLocale(
    <ThemeProvider store={createThemePreferenceStore({ storage: () => null })}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        {ui}
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
  return {
    ...view,
    calls,
    imports: () =>
      calls.filter((call) => call.method === "POST" && call.path === "/quizzes/import"),
  };
}

/** Renders the dialog. */
function renderDialog(handler: (call: Call) => Response | Promise<Response>) {
  const onImported = vi.fn();
  const save = vi.fn();
  const view = renderApp(
    <ImportDialog open onClose={() => {}} onImported={onImported} save={save} />,
    handler,
  );
  return { ...view, onImported, save };
}

/** A small CSV file. */
const csvFile = () =>
  new File(["schema_version,quiz_title\r\n1,Kuis\r\n"], "kuis.csv", { type: "text/csv" });

describe("ImportDialog", () => {
  it("walks the empty, loading and ideal states and opens the created quiz", async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => {};
    const { onImported, imports } = renderDialog((call) =>
      call.path === "/quizzes/import"
        ? new Promise((resolve) => (answer = resolve))
        : json(404, {}),
    );
    const dialog = await screen.findByRole("dialog", { name: "Import a quiz" });
    expect(dialog).toHaveAccessibleDescription(
      "Upload a Kabuki Neko JSON export or a CSV file that follows the template.",
    );
    expect(within(dialog).getAllByText("No file selected yet.").length).toBeGreaterThan(0);
    const importButton = within(dialog).getByRole("button", { name: "Import quiz" });
    expect(importButton).toHaveAttribute("aria-disabled", "true");
    expect(importButton).toHaveAccessibleDescription("No file selected yet.");
    await user.upload(within(dialog).getByLabelText("Choose a file"), csvFile());
    expect(await within(dialog).findByText(/^kuis\.csv · CSV file · /u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Import quiz" }));
    expect(within(dialog).getByText("Uploading and checking the file…")).toBeInTheDocument();
    // Pending: a second press sends nothing.
    await user.click(within(dialog).getByRole("button", { name: /^Import quiz/u }));
    expect(imports()).toHaveLength(1);
    const body = imports()[0]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toBeInstanceOf(File);
    expect((body as FormData).get("mediaMap")).toBeNull();
    expect(imports()[0]?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);
    await act(async () => answer(created()));
    expect(
      within(dialog).getByText("Import complete. Opening the quiz editor…"),
    ).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: QUIZ_ID }));
  });

  it("rejects unsupported and oversized files before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { imports } = renderDialog(() => json(404, {}));
    const input = await screen.findByLabelText("Choose a file");
    await user.upload(input, new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This content type isn't supported.",
    );
    await user.upload(
      input,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.json", { type: "application/json" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("This is too large.");
    expect(screen.getByRole("button", { name: "Import quiz" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(imports()).toHaveLength(0);
  });

  it("lists row and column problems with the total count (partial) and focuses the summary", async () => {
    const user = userEvent.setup();
    renderDialog(() =>
      failure(
        422,
        "IMPORT_VALIDATION_FAILED",
        [
          {
            path: "rows.3.options_json.1.isCorrect",
            code: "INVALID_TYPE",
            params: { row: 3, column: "options_json" },
            severity: "error",
          },
          {
            path: "rows.4.type",
            code: "INVALID_ENUM",
            params: { row: 4, column: "type" },
            severity: "error",
          },
        ],
        { actual: 250 },
      ),
    );
    await user.upload(await screen.findByLabelText("Choose a file"), csvFile());
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("The file has format or version problems.");
    expect(within(summary).getByText("250 problems found")).toBeInTheDocument();
    expect(
      within(summary).getByText(
        "Nothing was imported. Fix the problems in the file and try again.",
      ),
    ).toBeInTheDocument();
    const items = within(summary)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Row 3, column options_json: This kind of value isn't allowed here.",
      "Row 4, column type: Choose one of the available options.",
    ]);
    await waitFor(() => expect(summary).toHaveFocus());
  });

  it("reports malformed CSV and unsupported versions", async () => {
    const user = userEvent.setup();
    let code = "MALFORMED_CSV";
    renderDialog(() => failure(422, code));
    const input = await screen.findByLabelText("Choose a file");
    await user.upload(input, csvFile());
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The CSV file couldn't be read.");
    code = "UNSUPPORTED_IMPORT_VERSION";
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This file uses a format version that isn't supported.",
      ),
    );
  });

  it("maps referenced media to owned media of the same kind and shows missing-media locations", async () => {
    const user = userEvent.setup();
    const exportFile = new File(
      [
        JSON.stringify({
          format: "kabukineko.quiz",
          schemaVersion: 1,
          quiz: {
            title: "Kuis",
            description: null,
            visibility: "PRIVATE",
            bgmTrack: "random",
            coverMediaRef: REF,
          },
          media: [
            {
              ref: REF,
              mimeType: "image/png",
              originalName: "cover-lama.png",
              publicUrl: "/uploads/x.png",
              accessibility: emptyAccessibility(),
            },
          ],
          questions: [],
        }),
      ],
      "kuis.kabukineko.json",
      { type: "application/json" },
    );
    let missing = true;
    const { imports, onImported } = renderDialog((call) => {
      if (call.path.startsWith("/media")) return mediaPage();
      if (call.path === "/quizzes/import")
        return missing
          ? failure(
              422,
              "INVALID_REFERENCE",
              [
                {
                  path: "questions.0.mediaRef",
                  code: "INVALID_REFERENCE",
                  params: {},
                  severity: "error",
                },
              ],
              { actual: 1 },
            )
          : created();
      return json(404, {});
    });
    await user.upload(await screen.findByLabelText("Choose a file"), exportFile);
    const group = await screen.findByRole("group", {
      name: "Choose which of your media files to use for each media reference in the file.",
    });
    const select = within(group).getByLabelText("cover-lama.png");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(within(select).getByRole("option", { name: "sampul-sekolah.png" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "lagu.mp3" })).not.toBeInTheDocument();

    // Unmapped: the server reports the missing reference with its location.
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    expect(
      await screen.findByText(
        "questions.0.mediaRef: A referenced item is missing or can't be used.",
      ),
    ).toBeInTheDocument();

    missing = false;
    await user.selectOptions(select, OWNED_IMAGE);
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((imports()[1]?.body as FormData).get("mediaMap")))).toEqual({
      [REF]: OWNED_IMAGE,
    });
  });

  it("reconciles a lost response before any retry (error state)", async () => {
    const user = userEvent.setup();
    let lookup: "done" | "not-received" | "unknown" = "unknown";
    let fail = true;
    const { imports, onImported, calls } = renderDialog((call) => {
      if (call.path === "/quizzes/import") {
        if (fail) throw new TypeError("Failed to fetch");
        return created();
      }
      if (call.path.startsWith("/operations/")) {
        if (lookup === "unknown") return failure(503, "DEPENDENCY_UNAVAILABLE");
        if (lookup === "not-received") return failure(404, "NOT_FOUND");
        return json(200, {
          key: call.path.split("/")[2]?.split("?")[0],
          operation: "quiz.import",
          status: "done",
          resourceId: QUIZ_ID,
        });
      }
      if (call.path === `/quizzes/${QUIZ_ID}`) return created();
      return json(404, {});
    });
    await user.upload(await screen.findByLabelText("Choose a file"), csvFile());
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The import failed and no quiz was created. Check the import status before trying again.",
    );
    expect(calls.some((call) => call.path.startsWith("/operations/"))).toBe(true);
    // Checking again: nothing was received, so the import may be re-sent with the same key.
    lookup = "not-received";
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const resend = await screen.findByRole("button", { name: "Import quiz" });
    fail = false;
    await user.click(resend);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(imports()).toHaveLength(2);
    expect(imports()[1]?.headers.get("Idempotency-Key")).toBe(
      imports()[0]?.headers.get("Idempotency-Key"),
    );
  });

  it("opens a quiz whose import response was lost without re-sending", async () => {
    const user = userEvent.setup();
    const { imports, onImported } = renderDialog((call) => {
      if (call.path === "/quizzes/import") throw new TypeError("Failed to fetch");
      if (call.path.startsWith("/operations/"))
        return json(200, {
          key: call.path.split("/")[2]?.split("?")[0],
          operation: "quiz.import",
          status: "done",
          resourceId: QUIZ_ID,
        });
      if (call.path === `/quizzes/${QUIZ_ID}`) return created();
      return json(404, {});
    });
    await user.upload(await screen.findByLabelText("Choose a file"), csvFile());
    await user.click(screen.getByRole("button", { name: "Import quiz" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(imports()).toHaveLength(1);
  });

  it("downloads templates through the API", async () => {
    const user = userEvent.setup();
    const { save } = renderDialog((call) =>
      call.path.startsWith("/quizzes/import-template")
        ? new Response("schema_version,quiz_title\r\n", {
            status: 200,
            headers: {
              "Content-Type": "text/csv",
              "Content-Disposition": 'attachment; filename="kabuki-neko-template.csv"',
            },
          })
        : json(404, {}),
    );
    await user.click(await screen.findByRole("button", { name: "Download CSV template" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[1]).toBe("kabuki-neko-template.csv");
  });
});

describe("import helpers", () => {
  it("detects formats, parses RFC 4180 CSV and finds media references", () => {
    expect(detectFormat({ name: "Kuis.JSON" })).toBe("json");
    expect(detectFormat({ name: "kuis.csv" })).toBe("csv");
    expect(detectFormat({ name: "kuis.xlsx" })).toBeNull();
    expect(parseCsvRows('﻿a,b\r\n"x, ""y""",=1+1\n\n"multi\nline",z')).toEqual([
      ["a", "b"],
      ['x, "y"', "=1+1"],
      ["multi\nline", "z"],
    ]);
    const csv = [
      "schema_version,quiz_title,media_ref",
      `1,Kuis,${REF}`,
      `1,Kuis,${REF}`,
      "1,Kuis,not-a-uuid",
    ].join("\n");
    expect(referencedMedia("csv", csv)).toEqual([{ ref: REF, kind: null, name: REF }]);
    expect(referencedMedia("json", "{broken")).toEqual([]);
    const t = (key: string, values?: Record<string, string | number>) =>
      `${key}:${JSON.stringify(values)}`;
    expect(
      issueLocation(
        {
          path: "rows.2.type",
          code: "INVALID_ENUM",
          params: { row: 2, column: "type" },
          severity: "error",
        },
        t,
      ),
    ).toBe('quizzes.import.issueLocation:{"row":2,"column":"type"}');
    expect(
      issueLocation({ path: "quiz.title", code: "REQUIRED", params: {}, severity: "error" }, t),
    ).toBe("quiz.title");
  });

  it("opens the import dialog from the library", async () => {
    const user = userEvent.setup();
    renderApp(
      <QuizLibrary
        query={{ scope: "own", page: 1, search: "", sort: "updated_desc" }}
        onQueryChange={vi.fn()}
        navigate={vi.fn()}
      />,
      () => json(200, { items: [], meta: { page: 1, limit: 12, total: 0, totalPages: 0 } }),
    );
    await user.click(await screen.findByRole("button", { name: "Import quiz" }));
    expect(await screen.findByRole("dialog", { name: "Import a quiz" })).toBeInTheDocument();
  });
});
