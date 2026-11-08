/**
 * TASK-126 coverage for the studio draft store and the unsaved-changes guard: saved snapshot vs
 * working draft, stable IDs through add/duplicate/move/delete (including deleting the last and the
 * only slide), structural, locale-independent dirty detection, explicit save only (no autosave),
 * successful saves (with edits made during the save kept dirty), 409 conflicts preserving the
 * draft with manual reconciliation, other save failures, and the navigation guard (stay, discard,
 * save-then-leave waiting for success, native beforeunload warning only while dirty).
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { quizWriteSchema, type QuizDetail } from "@kabuki-neko/shared/schemas/quiz.schema";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ApiError } from "@/lib/api-client";
import { blankQuestion, canonical, createStudioStore, isDirty, toWrite } from "./studio.store";

const QUIZ_ID = "3b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const CREATOR_ID = "4b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";

/** A saved quiz detail with `count` filled slides. */
function detail(count = 3, revision = 2): QuizDetail {
  const questions = Array.from({ length: count }, (_, index) => {
    const question = blankQuestion("SINGLE_CHOICE");
    return {
      ...question,
      orderIndex: index,
      promptText: `Question ${index + 1}`,
      options: question.options.map((option, optionIndex) => ({
        ...option,
        optionText: `Option ${optionIndex + 1}`,
        isCorrect: optionIndex === 0,
      })),
    };
  });
  return {
    id: QUIZ_ID,
    creatorId: CREATOR_ID,
    creatorName: "Ayu",
    title: "Capitals",
    description: null,
    coverMedia: null,
    visibility: "PRIVATE",
    bgmTrack: "kabuki",
    revision,
    questionCount: count,
    isPlayable: true,
    updatedAt: 1,
    capabilities: {
      canEdit: true,
      canDelete: true,
      canDuplicate: true,
      canHost: true,
      canExport: true,
    },
    createdAt: 1,
    questions,
    media: [],
    validationIssues: [],
  } as QuizDetail;
}

/** IDs of the draft's questions in order. */
function ids(store: ReturnType<typeof createStudioStore>) {
  return store.getState().draft?.questions.map((question) => question.id) ?? [];
}

/** Asserts the draft satisfies the shared write schema (contiguous order, unique IDs). */
function expectValid(store: ReturnType<typeof createStudioStore>) {
  const result = quizWriteSchema.safeParse(store.getState().draft);
  expect(result.success, JSON.stringify(result.error?.issues ?? [])).toBe(true);
}

describe("studio store", () => {
  it("keeps the saved snapshot apart from the working draft", () => {
    const store = createStudioStore();
    const quiz = detail();
    store.getState().load(quiz);
    const state = store.getState();
    expect(state.quizId).toBe(QUIZ_ID);
    expect(state.selectedId).toBe(quiz.questions[0]?.id);
    expect(isDirty(state)).toBe(false);
    expect(state.draft).not.toBe(state.saved?.snapshot);
    store.getState().updateMetadata({ title: "Capitals of Asia" });
    expect(store.getState().saved?.snapshot.title).toBe("Capitals");
    expect(isDirty(store.getState())).toBe(true);
    store.getState().updateMetadata({ title: "Capitals" });
    expect(isDirty(store.getState())).toBe(false); // structural, not "was touched"
  });

  it("adds, duplicates and reorders by stable IDs", () => {
    const store = createStudioStore();
    store.getState().load(detail(3));
    const [a, b, c] = ids(store);
    store.getState().select(a ?? null);
    const added = store.getState().addQuestion("TRUE_FALSE");
    expect(ids(store)).toEqual([a, added, b, c]);
    expect(store.getState().selectedId).toBe(added);
    expectValid(store);

    const copy = store.getState().duplicateQuestion(b ?? "");
    const draft = store.getState().draft;
    const source = draft?.questions.find((question) => question.id === b);
    const duplicate = draft?.questions.find((question) => question.id === copy);
    expect(ids(store)).toEqual([a, added, b, copy, c]);
    expect(duplicate?.promptText).toBe(source?.promptText);
    expect(duplicate?.options.map((option) => option.id)).not.toEqual(
      source?.options.map((option) => option.id),
    );
    expectValid(store);

    const before = new Set(ids(store));
    store.getState().moveQuestion(c ?? "", 0);
    store.getState().moveQuestion(a ?? "", 99); // clamped to the end
    expect(ids(store)).toEqual([c, added, b, copy, a]);
    expect(new Set(ids(store))).toEqual(before);
    expect(store.getState().draft?.questions.map((question) => question.orderIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expectValid(store);
  });

  it("deletes the last slide and the only slide with sensible selection", () => {
    const store = createStudioStore();
    store.getState().load(detail(3));
    const [a, b, c] = ids(store);
    store.getState().select(b ?? null);
    store.getState().deleteQuestion(b ?? "");
    expect(store.getState().selectedId).toBe(c); // next neighbour
    store.getState().deleteQuestion(c ?? "");
    expect(store.getState().selectedId).toBe(a); // last slide deleted → previous
    store.getState().deleteQuestion(a ?? "");
    expect(store.getState().draft?.questions).toEqual([]);
    expect(store.getState().selectedId).toBeNull();
    expect(isDirty(store.getState())).toBe(true);
    expectValid(store);
    store.getState().deleteQuestion("missing"); // no-op
    expect(store.getState().draft?.questions).toEqual([]);
  });

  it("derives dirty structurally and independently of locale", () => {
    const store = createStudioStore();
    const quiz = detail(1);
    store.getState().load(quiz);
    // Same data with a different key order is not a change.
    const reordered = Object.fromEntries(Object.entries(toWrite(quiz)).reverse()) as ReturnType<
      typeof toWrite
    >;
    expect(canonical(reordered)).toBe(canonical(toWrite(quiz)));
    // New slides carry no translated default text, so the draft is the same in every UI language.
    const languages = vi.spyOn(navigator, "language", "get");
    languages.mockReturnValue("ja-JP");
    const ja = blankQuestion("POLL");
    languages.mockReturnValue("fr-FR");
    const fr = blankQuestion("POLL");
    const strip = (question: typeof ja) =>
      canonical({
        ...question,
        id: "",
        options: question.options.map((option) => ({ ...option, id: "" })),
      });
    expect(strip(ja)).toBe(strip(fr));
    expect(ja.promptText).toBe("");
    expect(ja.pointsMultiplier).toBe(0);
    document.documentElement.lang = "zh-Hans";
    expect(isDirty(store.getState())).toBe(false);
  });

  it("saves explicitly only and keeps edits made during the save", async () => {
    vi.useFakeTimers();
    const store = createStudioStore();
    store.getState().load(detail(2, 5));
    store.getState().updateMetadata({ title: "Renamed" });
    const persist = vi.fn(async (draft: ReturnType<typeof toWrite>, revision: number) => {
      // The user keeps typing while the request is in flight.
      store.getState().updateMetadata({ description: "Added while saving" });
      return { ...detail(2, revision + 1), title: draft.title, questions: draft.questions };
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).not.toHaveBeenCalled(); // no autosave
    await expect(store.getState().save(persist)).resolves.toBe("saved");
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ title: "Renamed" }), 5);
    expect(store.getState().saved?.revision).toBe(6);
    expect(store.getState().saved?.snapshot.title).toBe("Renamed");
    expect(store.getState().draft?.description).toBe("Added while saving");
    expect(isDirty(store.getState())).toBe(true);
  });

  it("preserves the draft on a 409 conflict and supports manual reconciliation", async () => {
    const store = createStudioStore();
    store.getState().load(detail(2, 3));
    const kept = store.getState().addQuestion("TYPE_ANSWER");
    const draftBefore = store.getState().draft;
    const conflict = new ApiError(409, "REVISION_CONFLICT", {
      expectedRevision: 3,
      currentRevision: 7,
    });
    await expect(store.getState().save(async () => Promise.reject(conflict))).resolves.toBe(
      "conflict",
    );
    expect(store.getState().draft).toBe(draftBefore);
    expect(store.getState().conflict).toEqual({ currentRevision: 7 });
    expect(isDirty(store.getState())).toBe(true);

    // Deliberate overwrite: adopt the server revision, keep the draft, save again.
    store.getState().rebaseDraft(detail(2, 7));
    expect(store.getState().conflict).toBeNull();
    const persist = vi.fn(async (_draft: ReturnType<typeof toWrite>, revision: number) => ({
      ...detail(3, revision + 1),
    }));
    await store.getState().save(persist);
    expect(persist).toHaveBeenCalledWith(expect.anything(), 7);

    // Or reload: discard local edits for the server version.
    store.getState().addQuestion("POLL");
    store.getState().reloadFromServer(detail(1, 9));
    expect(ids(store)).not.toContain(kept);
    expect(isDirty(store.getState())).toBe(false);
  });

  it("keeps the draft and the error when a save fails", async () => {
    const store = createStudioStore();
    store.getState().load(detail(1));
    store.getState().updateMetadata({ title: "Offline edit" });
    await expect(
      store.getState().save(async () => Promise.reject(new TypeError("offline"))),
    ).resolves.toBe("failed");
    expect(store.getState().draft?.title).toBe("Offline edit");
    expect(store.getState().saveError?.code).toBe("NETWORK_ERROR");
    expect(store.getState().saving).toBe(false);
    await expect(
      store.getState().save(async () => Promise.reject(new ApiError(422, "VALIDATION_FAILED"))),
    ).resolves.toBe("failed");
    expect(store.getState().saveError?.code).toBe("VALIDATION_FAILED");
  });
});

describe("useUnsavedChanges", () => {
  it("navigates directly when clean and guards when dirty", async () => {
    const go = vi.fn();
    let saveResult = false;
    const save = vi.fn(async () => saveResult);
    const { result, rerender } = renderHook(({ dirty }) => useUnsavedChanges({ dirty, save }), {
      initialProps: { dirty: false },
    });
    act(() => result.current.requestNavigation(go));
    expect(go).toHaveBeenCalledTimes(1);

    rerender({ dirty: true });
    act(() => result.current.requestNavigation(go));
    expect(result.current.open).toBe(true);
    act(() => result.current.stay());
    expect(result.current.open).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);

    act(() => result.current.requestNavigation(go));
    await act(async () => result.current.saveThenLeave());
    expect(result.current.open).toBe(true); // save failed: stay with the draft
    expect(result.current.failed).toBe(true);
    expect(go).toHaveBeenCalledTimes(1);

    saveResult = true;
    await act(async () => result.current.saveThenLeave());
    expect(go).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(false);

    act(() => result.current.requestNavigation(go));
    act(() => result.current.discard());
    expect(go).toHaveBeenCalledTimes(3);
  });

  it("arms the native unload warning only while dirty", () => {
    const { rerender, unmount } = renderHook(
      ({ dirty }) => useUnsavedChanges({ dirty, save: async () => true }),
      {
        initialProps: { dirty: true },
      },
    );
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    rerender({ dirty: false });
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
    unmount();
  });
});

// Keep the fixture helper honest: accessibility defaults are the shared empty value.
it("uses the shared empty accessibility defaults for new slides", () => {
  expect(blankQuestion().accessibility).toEqual(emptyAccessibility());
});
