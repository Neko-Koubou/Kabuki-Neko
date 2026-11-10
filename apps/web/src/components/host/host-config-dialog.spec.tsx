/**
 * TASK-137 coverage.
 *
 * M06 host configuration, in its five states:
 * - ideal: Projector and friendly-off defaults, one emit despite double submit, onCreated with
 *   the ACK;
 * - empty: zero or unplayable questions, with no room command at all;
 * - partial: a dirty draft blocks hosting; a stale revision asks to save and the next attempt gets
 *   a new id;
 * - loading: the creating status;
 * - error: a definitive failure with a reference.
 * A lost ACK is reconciled before the retry, and the retry re-sends the same request id, so only
 * one room exists. A reconciled "done" opens that room without re-sending.
 *
 * M03 quiz details:
 * - Random default plus the manifest tracks;
 * - one preview at a time, stopped on track change and on close;
 * - a legacy unknown id is kept, cannot be previewed and is applied to the draft unchanged;
 * - create sends one POST with an idempotency key; a lost response is reconciled to the created
 *   quiz;
 * - required title; error keeps entries.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { QuizSettingsModal, type PreviewPlayer } from "@/components/studio/QuizSettingsModal";
import type { EmitResult } from "@/lib/socket-client";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import {
  HostConfigDialog,
  type CreateRoomRequest,
  type HostableQuiz,
  type RoomReconcile,
} from "./host-config-dialog";

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio/q",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = ["common", "accessibility", "host", "quizzes", "validation"] as const;
const QUIZ: HostableQuiz = {
  id: "8d6f1a5e-2b4c-4d8e-9f10-112233445566",
  title: "Sejarah Kemerdekaan Indonesia",
  revision: 4,
  questionCount: 3,
  isPlayable: true,
};
const SESSION = "3f2a9c1e-7b6d-4e5f-8a9b-0c1d2e3f4a5b";
const CORRELATION = "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41";

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Renders `ui` with the root providers over a scripted fetch (`rerenderApp` keeps them). */
function renderApp(
  ui: ReactElement,
  fetchImpl: (path: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(new URL(String(input)).pathname.replace("/api/v1", ""), init),
  );
  const store = createThemePreferenceStore({ storage: () => null });
  const wrap = (node: ReactElement) => (
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        {node}
      </AuthProvider>
    </ThemeProvider>
  );
  const view = renderWithLocale(wrap(ui), { namespaces: [...NAMESPACES] });
  return { ...view, fetchMock, rerenderApp: (node: ReactElement) => view.rerender(wrap(node)) };
}

/** ACK helpers. */
const ok = (requestId: string): EmitResult<"host:create_room"> => ({
  status: "ok",
  requestId,
  serverTime: 1,
  data: { pinCode: "012345", sessionId: SESSION, phaseVersion: 1 },
});
const failed = (requestId: string, errorCode: string): EmitResult<"host:create_room"> => ({
  status: "error",
  requestId,
  error: {
    statusCode: 409,
    errorCode: errorCode as "REVISION_CONFLICT",
    message: "x",
    params: {},
    details: [],
    correlationId: CORRELATION,
  },
});

/** Renders the host dialog with a scripted createRoom/reconcile. */
function renderHost(
  props: {
    quiz?: Partial<HostableQuiz>;
    dirty?: boolean;
    createRoom?: (request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>;
    reconcileRoom?: (requestId: string) => Promise<RoomReconcile>;
  } = {},
) {
  const createRoom = vi.fn(
    props.createRoom ?? (async (request: CreateRoomRequest) => ok(request.requestId)),
  );
  const onCreated = vi.fn();
  const view = renderApp(
    <HostConfigDialog
      open
      onClose={() => {}}
      quiz={{ ...QUIZ, ...props.quiz }}
      dirty={props.dirty ?? false}
      createRoom={createRoom}
      {...(props.reconcileRoom ? { reconcileRoom: props.reconcileRoom } : {})}
      onCreated={onCreated}
    />,
    () => json(404, {}),
  );
  return { ...view, createRoom, onCreated };
}

describe("M06 HostConfigDialog", () => {
  it("defaults to Projector without friendly nicknames and creates one room despite a double submit", async () => {
    const user = userEvent.setup();
    let release: (value: EmitResult<"host:create_room">) => void = () => {};
    const { createRoom, onCreated } = renderHost({
      createRoom: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const dialog = await screen.findByRole("dialog", { name: "Host a game" });
    expect(dialog).toHaveAccessibleDescription("Choose a display mode, then open the lobby.");
    expect(within(dialog).getByText("Sejarah Kemerdekaan Indonesia")).toBeInTheDocument();
    expect(within(dialog).getByText("3 questions")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Projector/u })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /^Streamer/u })).not.toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: "Give players friendly random nicknames" }),
    ).not.toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    expect(within(dialog).getByText("Creating the room…")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Open lobby/u }));
    expect(createRoom).toHaveBeenCalledTimes(1);
    const request = createRoom.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      quizId: QUIZ.id,
      quizRevision: 4,
      displayMode: "PROJECTOR",
      friendlyNicknames: false,
    });
    expect(request?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    await act(async () => release(ok(request?.requestId ?? "")));
    expect(onCreated).toHaveBeenCalledWith({ sessionId: SESSION, pinCode: "012345" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("sends the chosen mode and friendly nicknames", async () => {
    const user = userEvent.setup();
    const { createRoom } = renderHost();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /^Streamer/u }));
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    expect(createRoom.mock.calls[0]?.[0]).toMatchObject({
      displayMode: "STREAMER",
      friendlyNicknames: true,
    });
  });

  it("refuses quizzes without playable questions (empty) and unsaved drafts (partial)", async () => {
    const user = userEvent.setup();
    const empty = renderHost({ quiz: { questionCount: 0, isPlayable: false } });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "This quiz has no questions to play. Fix it in the studio first.",
    );
    expect(within(dialog).queryByRole("button", { name: /Open lobby/u })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/studio/${QUIZ.id}`,
    );
    expect(empty.createRoom).not.toHaveBeenCalled();
    empty.unmount();

    const dirty = renderHost({ dirty: true });
    const second = await screen.findByRole("dialog");
    expect(within(second).getByRole("note")).toHaveTextContent(
      "Save your changes first. The player limit follows this instance's settings.",
    );
    const open = within(second).getByRole("button", { name: /^Open lobby/u });
    expect(open).toHaveAttribute("aria-disabled", "true");
    await user.click(open);
    expect(dirty.createRoom).not.toHaveBeenCalled();
  });

  it("asks to save after a stale revision and uses a new request id for the next attempt", async () => {
    const user = userEvent.setup();
    const createRoom = vi
      .fn<(request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>>()
      .mockImplementationOnce(async (request) => failed(request.requestId, "REVISION_CONFLICT"))
      .mockImplementationOnce(async (request) => ok(request.requestId));
    const { onCreated } = renderHost({ createRoom });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    const note = await within(dialog).findByRole("note");
    expect(note).toHaveTextContent("Save your changes before hosting.");
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [first, second] = createRoom.mock.calls.map((call) => call[0].requestId);
    expect(second).not.toBe(first);
  });

  it("reconciles a lost ACK before retrying with the same request id (one room)", async () => {
    const user = userEvent.setup();
    const createRoom = vi
      .fn<(request: CreateRoomRequest) => Promise<EmitResult<"host:create_room">>>()
      .mockImplementationOnce(async (request) => ({
        status: "unknown",
        requestId: request.requestId,
      }))
      .mockImplementationOnce(async (request) => ok(request.requestId));
    const reconcileRoom = vi.fn(async (): Promise<RoomReconcile> => ({ status: "not-received" }));
    const { onCreated } = renderHost({ createRoom, reconcileRoom });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      "The room couldn't be created. Check whether it already exists before trying again.",
    );
    const first = createRoom.mock.calls[0]?.[0].requestId;
    expect(reconcileRoom).toHaveBeenCalledWith(first);
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createRoom.mock.calls[1]?.[0].requestId).toBe(first);
  });

  it("opens the reconciled room without re-sending, and reports definitive failures", async () => {
    const user = userEvent.setup();
    const lost = renderHost({
      createRoom: async (request) => ({ status: "unknown", requestId: request.requestId }),
      reconcileRoom: async () => ({ status: "done", resourceId: SESSION }),
    });
    await user.click(await screen.findByRole("button", { name: "Open lobby" }));
    await waitFor(() =>
      expect(lost.onCreated).toHaveBeenCalledWith({ sessionId: SESSION, pinCode: null }),
    );
    expect(lost.createRoom).toHaveBeenCalledTimes(1);
    lost.unmount();

    const capacity = renderHost({
      createRoom: async (request) => failed(request.requestId, "CAPACITY_REACHED"),
    });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Open lobby" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The room couldn't be created.");
    expect(alert).toHaveTextContent(`Reference ID: ${CORRELATION}`);
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    const ids = capacity.createRoom.mock.calls.map((call) => call[0].requestId);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

/** Preview player double: one track at a time, like the audio manager. */
function fakePlayer() {
  const state = { playing: null as string | null };
  const player: PreviewPlayer & { state: typeof state } = {
    state,
    previewLobby: vi.fn(async (id: string) => {
      state.playing = id;
      return true;
    }),
    stopPreview: vi.fn(() => {
      state.playing = null;
    }),
  };
  return player;
}

const TRACKS = [
  { id: "kabuki-matsuri", label: "Kabuki Matsuri" },
  { id: "sakura-breeze", label: "Sakura Breeze" },
];

/** Quiz detail returned by the API for a created quiz. */
function createdQuiz(title: string) {
  const question = { ...blankQuestion(), orderIndex: 0 };
  return {
    id: QUIZ.id,
    creatorId: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
    creatorName: "Ayu",
    title,
    description: null,
    coverMedia: null,
    visibility: "PRIVATE",
    bgmTrack: "sakura-breeze",
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
    questions: [question],
    media: [],
    validationIssues: [],
  };
}

describe("M03 QuizSettingsModal", () => {
  it("creates a quiz with the chosen track, previewing one track at a time", async () => {
    const user = userEvent.setup();
    const player = fakePlayer();
    const onCreated = vi.fn();
    const { fetchMock, rerenderApp } = renderApp(
      <QuizSettingsModal
        open
        mode="create"
        onClose={() => {}}
        onCreated={onCreated}
        tracks={TRACKS}
        player={player}
      />,
      (path, init) =>
        path === "/quizzes" && init?.method === "POST"
          ? json(201, createdQuiz("Kuis Budaya"))
          : json(404, {}),
    );
    const dialog = await screen.findByRole("dialog", { name: "Quiz details" });
    const music = within(dialog).getByLabelText("Background music");
    expect(music).toHaveValue("random");
    expect(
      within(music)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Random lobby music", "Kabuki Matsuri", "Sakura Breeze"]);
    expect(within(dialog).getByRole("radio", { name: "Private" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Preview music" })).toHaveAttribute(
      "disabled",
    );

    // Required title first (empty state).
    await user.click(within(dialog).getByRole("button", { name: "Create quiz" }));
    expect(await within(dialog).findByText("This field is required.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/quizzes"),
      expect.anything(),
    );

    await user.type(within(dialog).getByLabelText(/^Quiz title/u), "Kuis Budaya");
    await user.selectOptions(music, "kabuki-matsuri");
    await user.click(within(dialog).getByRole("button", { name: "Preview music" }));
    expect(player.previewLobby).toHaveBeenLastCalledWith("kabuki-matsuri");
    expect(within(dialog).getByRole("button", { name: "Stop preview" })).toBeInTheDocument();
    // Changing the track stops the running preview before another can start.
    await user.selectOptions(music, "sakura-breeze");
    expect(player.stopPreview).toHaveBeenCalled();
    expect(player.state.playing).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Preview music" }));
    expect(player.state.playing).toBe("sakura-breeze");

    await user.click(within(dialog).getByRole("button", { name: "Create quiz" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(player.state.playing).toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      title: "Kuis Budaya",
      description: null,
      coverMediaId: null,
      visibility: "PRIVATE",
      bgmTrack: "sakura-breeze",
    });
    expect(new Headers(post?.[1]?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);

    // Closing the dialog stops any preview.
    await user.click(within(dialog).getByRole("button", { name: "Preview music" }));
    rerenderApp(
      <QuizSettingsModal
        open={false}
        mode="create"
        onClose={() => {}}
        tracks={TRACKS}
        player={player}
      />,
    );
    expect(player.state.playing).toBeNull();
  });

  it("keeps a legacy track id, cannot preview it, and applies it to the draft unchanged", async () => {
    const user = userEvent.setup();
    const player = fakePlayer();
    const onApply = vi.fn();
    renderApp(
      <QuizSettingsModal
        open
        mode="edit"
        onClose={() => {}}
        onApply={onApply}
        tracks={TRACKS}
        player={player}
        initial={{
          title: "Kuis Lama",
          bgmTrack: "old-festival",
          visibility: "PUBLIC",
          description: "Deskripsi",
        }}
      />,
      () => json(404, {}),
    );
    const dialog = await screen.findByRole("dialog");
    const music = within(dialog).getByLabelText("Background music");
    expect(music).toHaveValue("old-festival");
    expect(
      within(music).getByRole("option", { name: "Random lobby music (old-festival)" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Preview music" })).toHaveAttribute(
      "disabled",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({
      title: "Kuis Lama",
      description: "Deskripsi",
      coverMediaId: null,
      visibility: "PUBLIC",
      bgmTrack: "old-festival",
    });
    expect(player.previewLobby).not.toHaveBeenCalled();
  });

  it("reconciles a lost create response to the created quiz and keeps entries on errors", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    let posts = 0;
    let mode: "lost" | "fail" = "lost";
    renderApp(
      <QuizSettingsModal
        open
        mode="create"
        onClose={() => {}}
        onCreated={onCreated}
        tracks={TRACKS}
        player={fakePlayer()}
      />,
      (path, init) => {
        if (path === "/quizzes" && init?.method === "POST") {
          posts += 1;
          if (mode === "lost") throw new TypeError("Failed to fetch");
          return json(500, {
            statusCode: 500,
            errorCode: "INTERNAL_ERROR",
            message: "x",
            params: {},
            details: [],
            correlationId: CORRELATION,
          });
        }
        if (path.startsWith("/operations/"))
          return json(200, {
            key: path.split("/")[2],
            operation: "quiz.create",
            status: "done",
            resourceId: QUIZ.id,
          });
        if (path === `/quizzes/${QUIZ.id}`) return json(200, createdQuiz("Kuis Hilang"));
        return json(404, {});
      },
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Quiz title/u), "Kuis Hilang");
    await user.click(within(dialog).getByRole("button", { name: "Create quiz" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ id: QUIZ.id, title: "Kuis Hilang" });
    expect(posts).toBe(1);

    mode = "fail";
    await user.click(within(dialog).getByRole("button", { name: "Create quiz" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The details couldn't be saved. Your entries have been kept.",
    );
    expect(within(dialog).getByLabelText(/^Quiz title/u)).toHaveValue("Kuis Hilang");
  });
});
