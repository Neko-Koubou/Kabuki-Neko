/**
 * TASK-139 coverage for the S06 quiz detail against a scripted fake API.
 * - The five states:
 *   - loading skeleton;
 *   - ideal owner view with ordered questions;
 *   - empty quiz with the owner's Edit CTA;
 *   - partial: read-only public quiz, or an invalid draft listing its issues with Host disabled;
 *   - error with retry and reference.
 * - Hidden 404 and non-owner 403 show one fixed message and never the quiz title.
 * - A missing or broken cover falls back to the placeholder.
 * - The JSON export saves the Blob under the server filename; failures and empty downloads are
 *   reported and never "succeed".
 * - Duplicate opens the copy (or reports the failure).
 * - Delete goes through M09 with `If-Match` and returns to the library.
 * - Helpers.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import { QuizDetailView, exportFallbackName, issueQuestionIndex } from "./quiz-detail";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/quizzes/x",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = [
  "common",
  "accessibility",
  "quizzes",
  "studio",
  "host",
  "validation",
  "auth",
] as const;
const QUIZ_ID = "8d6f1a5e-2b4c-4d8e-9f10-112233445566";
const SECRET = "Rahasia Ujian Akhir";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";
const OWNER = {
  canEdit: true,
  canDelete: true,
  canDuplicate: true,
  canHost: true,
  canExport: true,
};
const READ_ONLY = {
  canEdit: false,
  canDelete: false,
  canDuplicate: true,
  canHost: true,
  canExport: true,
};

/** Valid question fixture. */
function question(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ...blankQuestion(),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    orderIndex: index,
    promptText: `Pertanyaan ${index + 1}`,
    timeLimitSec: 20,
    ...overrides,
  };
}

/** Quiz detail fixture. */
function detail(overrides: Record<string, unknown> = {}) {
  const questions = (overrides.questions as unknown[] | undefined) ?? [
    question(0),
    question(1, { type: "TRUE_FALSE" }),
  ];
  return {
    id: QUIZ_ID,
    creatorId: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
    creatorName: "Ayu",
    title: SECRET,
    description: "Kuis untuk kelas XII.\nBaris kedua.",
    coverMedia: null,
    visibility: "PRIVATE",
    bgmTrack: "random",
    revision: 5,
    questionCount: questions.length,
    isPlayable: true,
    updatedAt: 1,
    capabilities: OWNER,
    createdAt: 1,
    media: [],
    validationIssues: [],
    ...overrides,
    questions,
  };
}

/** JSON response. */
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
    correlationId: CORRELATION,
  });
}

/** Renders the detail with a scripted API. */
function renderDetail(
  handler: (method: string, path: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { method: string; path: string; headers: Headers }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace("/api/v1", "")}${url.search}`;
    const method = init?.method ?? "GET";
    calls.push({ method, path, headers: new Headers(init?.headers) });
    return handler(method, path, init);
  });
  const navigate = vi.fn();
  const save = vi.fn();
  renderWithLocale(
    <ThemeProvider store={createThemePreferenceStore({ storage: () => null })}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        <QuizDetailView quizId={QUIZ_ID} navigate={navigate} save={save} createRoom={vi.fn()} />
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
  return { calls, navigate, save };
}

describe("QuizDetailView", () => {
  it("loads, then shows metadata, ordered questions and the owner's actions", async () => {
    let answer: (response: Response) => void = () => {};
    renderDetail(() => new Promise((resolve) => (answer = resolve)));
    expect(screen.getByText("Loading the quiz…")).toBeInTheDocument();
    await act(async () => answer(json(200, detail())));
    expect(screen.getByRole("heading", { level: 1, name: SECRET })).toBeInTheDocument();
    expect(screen.getByText("Ayu")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("2 questions")).toBeInTheDocument();
    expect(screen.getByText(/Kuis untuk kelas XII\./u)).toBeInTheDocument();
    const questions = screen.getAllByRole("listitem");
    expect(questions[0]).toHaveTextContent(/1 · Single choice · Time limit: 20 sec/u);
    expect(questions[0]).toHaveTextContent("Pertanyaan 1");
    expect(questions[1]).toHaveTextContent(/2 · True or false/u);
    expect(screen.getByRole("link", { name: "Edit quiz" })).toHaveAttribute(
      "href",
      `/studio/${QUIZ_ID}`,
    );
    for (const name of ["Duplicate quiz", "Download JSON file", "Delete quiz", "Host a game"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Host a game" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByText("No cover image")).toBeInTheDocument();
  });

  it("keeps public quizzes of other creators read-only", async () => {
    renderDetail(() =>
      json(200, detail({ capabilities: READ_ONLY, visibility: "PUBLIC", creatorName: "Budi" })),
    );
    expect(
      await screen.findByText(
        "This public quiz belongs to another creator. You can view, duplicate or host it, but not edit it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit quiz" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete quiz" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate quiz" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download JSON file" })).toBeInTheDocument();
  });

  it("shows one fixed message for hidden (404) and forbidden (403) quizzes, without the title", async () => {
    for (const status of [404, 403] as const) {
      const view = renderDetail(() => failure(status, status === 404 ? "NOT_FOUND" : "FORBIDDEN"));
      expect(
        await screen.findByText(
          "This quiz isn't available. It may have been deleted, or you may not have access.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
      expect(view.calls[0]?.path).toBe(`/quizzes/${QUIZ_ID}`);
      document.body.innerHTML = "";
    }
  });

  it("retries a failed load (error state with reference)", async () => {
    const user = userEvent.setup();
    let fail = true;
    renderDetail(() => (fail ? failure(500, "INTERNAL_ERROR") : json(200, detail())));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This quiz isn't available. Go back to your quizzes.");
    expect(alert).toHaveTextContent(`Reference ID: ${CORRELATION}`);
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: SECRET })).toBeInTheDocument();
  });

  it("invites the owner to add questions to an empty quiz and lists draft issues", async () => {
    renderDetail(() => json(200, detail({ questions: [], isPlayable: false })));
    expect(await screen.findByText("This quiz has no questions yet.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Edit quiz" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Host a game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    document.body.innerHTML = "";

    renderDetail(() =>
      json(
        200,
        detail({
          isPlayable: false,
          validationIssues: [
            { path: "questions.1.promptText", code: "EMPTY_PROMPT", params: {}, severity: "error" },
          ],
        }),
      ),
    );
    const issues = await screen.findByRole("region", {
      name: "This draft has problems that must be fixed before you can host it.",
    });
    expect(issues).toHaveTextContent("Slide 2 of 2: The question needs text.");
    expect(screen.getByRole("button", { name: "Host a game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("falls back when the cover is broken", async () => {
    renderDetail(() =>
      json(
        200,
        detail({
          coverMedia: {
            id: "11111111-1111-4111-8111-111111111111",
            uploaderId: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
            storageDriver: "local",
            publicUrl: "/uploads/covers/missing.webp",
            originalName: "cover.webp",
            mimeType: "image/webp",
            sizeBytes: 10,
            width: 16,
            height: 9,
            durationMs: null,
            accessibility: emptyAccessibility(),
            revision: 1,
            createdAt: 1,
            inUse: true,
            canDelete: false,
          },
        }),
      ),
    );
    await screen.findByRole("heading", { level: 1, name: SECRET });
    const img = document.querySelector('img[src="/uploads/covers/missing.webp"]');
    expect(img).not.toBeNull();
    await act(async () => img?.dispatchEvent(new Event("error")));
    expect(screen.getByText("No cover image")).toBeInTheDocument();
  });

  it("exports JSON under the server filename and reports failed or empty downloads", async () => {
    const user = userEvent.setup();
    let exportMode: "ok" | "fail" | "empty" = "ok";
    let release: () => void = () => {};
    const { save } = renderDetail(async (_method, path) => {
      if (path.includes("/export")) {
        if (exportMode === "ok") {
          await new Promise<void>((resolve) => (release = resolve));
          return new Response('{"version":1}', {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="${QUIZ_ID}.kabukineko.json"`,
            },
          });
        }
        if (exportMode === "empty") return new Response("", { status: 200 });
        return failure(500, "INTERNAL_ERROR");
      }
      return json(200, detail());
    });
    await user.click(await screen.findByRole("button", { name: "Download JSON file" }));
    expect(screen.getByText("Preparing download…")).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[1]).toBe(`${QUIZ_ID}.kabukineko.json`);
    expect(save.mock.calls[0]?.[0]).toBeInstanceOf(Blob);

    exportMode = "fail";
    await user.click(screen.getByRole("button", { name: "Download JSON file" }));
    expect(await screen.findByText("The export failed. Please try again.")).toBeInTheDocument();
    exportMode = "empty";
    await user.click(screen.getByRole("button", { name: "Download JSON file" }));
    await waitFor(() =>
      expect(screen.getByText("The export failed. Please try again.")).toBeInTheDocument(),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("duplicates into the studio, reports failures, and deletes with If-Match back to the library", async () => {
    const user = userEvent.setup();
    let duplicateFails = false;
    const copyId = "99999999-9999-4999-8999-999999999999";
    const { navigate, calls } = renderDetail((method, path) => {
      if (method === "POST" && path.endsWith("/duplicate"))
        return duplicateFails
          ? failure(403, "FORBIDDEN")
          : json(201, detail({ id: copyId, title: `${SECRET} (copy)` }));
      if (method === "DELETE") return json(200, { deleted: true });
      return json(200, detail());
    });
    await user.click(await screen.findByRole("button", { name: "Duplicate quiz" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/studio/${copyId}`));
    duplicateFails = true;
    await user.click(screen.getByRole("button", { name: "Duplicate quiz" }));
    expect(
      await screen.findByText("The action didn't complete. You can try again."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete quiz" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`Affected item: ${SECRET}`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete quiz" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard/quizzes"));
    expect(calls.find((call) => call.method === "DELETE")?.headers.get("If-Match")).toBe('"5"');
  });

  it("derives fallback names and issue positions", () => {
    expect(exportFallbackName(QUIZ_ID)).toBe(`${QUIZ_ID}.kabukineko.json`);
    expect(issueQuestionIndex("questions.3.options.0.text")).toBe(3);
    expect(issueQuestionIndex("questions.12")).toBe(12);
    expect(issueQuestionIndex("title")).toBeNull();
  });
});
