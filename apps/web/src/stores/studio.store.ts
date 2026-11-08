/**
 * Studio draft store (SA §6.4, US-04; TASK-126): the quiz being edited, kept apart from the last
 * saved server version.
 *
 * - `saved` is the server snapshot with its revision; `draft` is the working copy. `isDirty` is a
 *   structural comparison of both (canonical JSON), so it does not depend on locale, formatting
 *   or the order object keys were written in — switching language never makes a draft dirty or
 *   clean. New slides use empty, untranslated content.
 * - Questions and options keep stable UUIDs: add, duplicate (fresh IDs), move and delete operate
 *   by ID, never by visual index, and `orderIndex` is renumbered contiguously after each change.
 *   Deleting the last slide leaves an empty quiz and selects nothing; deleting another slide
 *   selects its neighbour.
 * - Saving is explicit only (no autosave, no offline persistence): `save(persist)` sends the
 *   draft with the saved revision. Success replaces `saved` (edits made meanwhile stay dirty); a
 *   409 `REVISION_CONFLICT` keeps the draft and records the conflict for manual reconciliation
 *   (`reloadFromServer` discards local edits, `rebaseDraft` adopts the server revision so the
 *   user can deliberately overwrite); other failures keep the draft and expose the error.
 */
import { createStore, useStore, type StoreApi } from "zustand";
import type { QuestionType } from "@kabuki-neko/shared/constants/game";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type { Option, Question } from "@kabuki-neko/shared/schemas/question.schema";
import type { QuizDetail, QuizWrite } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ApiError } from "@/lib/api-client";

/** Editable quiz metadata. */
export type QuizMetadata = Omit<QuizWrite, "questions">;

/** Result of a save attempt. */
export type SaveResult = "saved" | "conflict" | "failed" | "skipped";

/** Persists a draft with the expected revision; resolves the server's new detail. */
export type PersistQuiz = (draft: QuizWrite, revision: number) => Promise<QuizDetail>;

/** Store state and actions. */
export interface StudioState {
  quizId: string | null;
  saved: { revision: number; snapshot: QuizWrite } | null;
  draft: QuizWrite | null;
  selectedId: string | null;
  saving: boolean;
  /** Set after a 409: the server has a newer revision than the draft was based on. */
  conflict: { currentRevision: number | null } | null;
  saveError: ApiError | null;
  load(detail: QuizDetail): void;
  updateMetadata(patch: Partial<QuizMetadata>): void;
  addQuestion(type?: QuestionType, afterId?: string | null): string | null;
  duplicateQuestion(id: string): string | null;
  moveQuestion(id: string, toIndex: number): void;
  deleteQuestion(id: string): void;
  updateQuestion(id: string, update: (question: Question) => Question): void;
  select(id: string | null): void;
  save(persist: PersistQuiz): Promise<SaveResult>;
  reloadFromServer(detail: QuizDetail): void;
  rebaseDraft(detail: QuizDetail): void;
}

/** Maximum questions per quiz (shared limit). */
const MAX_QUESTIONS = 100;

/** JSON with recursively sorted keys (stable structural comparison). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Write model of a server quiz detail. */
export function toWrite(detail: QuizDetail): QuizWrite {
  return {
    title: detail.title,
    description: detail.description,
    coverMediaId: detail.coverMedia?.id ?? null,
    visibility: detail.visibility,
    bgmTrack: detail.bgmTrack,
    questions: detail.questions,
  };
}

/** Empty option at `index` (visual colour follows the index). */
function blankOption(index: number, textOption: boolean): Option {
  return {
    id: crypto.randomUUID(),
    optionIndex: index,
    colorIndex: textOption ? 0 : index % 4,
    optionText: "",
    isCorrect: false,
    sortOrder: index,
  };
}

/** A new, empty slide of `type` (content left blank; never translated defaults). */
export function blankQuestion(type: QuestionType = "SINGLE_CHOICE"): Question {
  const optionCount = type === "TYPE_ANSWER" ? 1 : type === "TRUE_FALSE" ? 2 : 4;
  return {
    id: crypto.randomUUID(),
    orderIndex: 0,
    type,
    promptText: "",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier: type === "POLL" ? 0 : 1,
    explanationText: null,
    accessibility: emptyAccessibility(),
    options: Array.from({ length: optionCount }, (_, index) =>
      blankOption(index, type === "TYPE_ANSWER"),
    ),
  } as Question;
}

/** Copy of `question` with fresh question and option IDs. */
function withFreshIds(question: Question): Question {
  const copy = structuredClone(question);
  return {
    ...copy,
    id: crypto.randomUUID(),
    options: copy.options.map((option) => ({ ...option, id: crypto.randomUUID() })),
  } as Question;
}

/** Renumbers `orderIndex` contiguously in array order. */
function renumber(questions: readonly Question[]): Question[] {
  return questions.map((question, index) =>
    question.orderIndex === index ? question : { ...question, orderIndex: index },
  );
}

/** True when the draft differs structurally from the saved snapshot. */
export function isDirty(state: Pick<StudioState, "draft" | "saved">): boolean {
  if (state.draft === null) return false;
  if (state.saved === null) return true;
  return canonical(state.draft) !== canonical(state.saved.snapshot);
}

/** Creates one studio store (one per open quiz). */
export function createStudioStore(): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    /** Applies a question-list change to the draft (no-op without a draft). */
    const editQuestions = (change: (questions: Question[]) => Question[]) => {
      const draft = get().draft;
      if (draft === null) return;
      set({ draft: { ...draft, questions: renumber(change([...draft.questions])) } });
    };

    return {
      quizId: null,
      saved: null,
      draft: null,
      selectedId: null,
      saving: false,
      conflict: null,
      saveError: null,

      load(detail) {
        const snapshot = toWrite(detail);
        set({
          quizId: detail.id,
          saved: { revision: detail.revision, snapshot },
          draft: structuredClone(snapshot),
          selectedId: snapshot.questions[0]?.id ?? null,
          conflict: null,
          saveError: null,
        });
      },

      updateMetadata(patch) {
        const draft = get().draft;
        if (draft) set({ draft: { ...draft, ...patch } });
      },

      addQuestion(type = "SINGLE_CHOICE", afterId = get().selectedId) {
        const draft = get().draft;
        if (draft === null || draft.questions.length >= MAX_QUESTIONS) return null;
        const question = blankQuestion(type);
        editQuestions((questions) => {
          const at = afterId ? questions.findIndex((item) => item.id === afterId) : -1;
          questions.splice(at >= 0 ? at + 1 : questions.length, 0, question);
          return questions;
        });
        set({ selectedId: question.id });
        return question.id;
      },

      duplicateQuestion(id) {
        const draft = get().draft;
        const source = draft?.questions.find((item) => item.id === id);
        if (!draft || !source || draft.questions.length >= MAX_QUESTIONS) return null;
        const copy = withFreshIds(source);
        editQuestions((questions) => {
          questions.splice(questions.findIndex((item) => item.id === id) + 1, 0, copy);
          return questions;
        });
        set({ selectedId: copy.id });
        return copy.id;
      },

      moveQuestion(id, toIndex) {
        editQuestions((questions) => {
          const from = questions.findIndex((item) => item.id === id);
          if (from < 0) return questions;
          const target = Math.max(0, Math.min(questions.length - 1, toIndex));
          const [moved] = questions.splice(from, 1);
          if (moved) questions.splice(target, 0, moved);
          return questions;
        });
      },

      deleteQuestion(id) {
        const draft = get().draft;
        if (!draft) return;
        const index = draft.questions.findIndex((item) => item.id === id);
        if (index < 0) return;
        const remaining = draft.questions.filter((item) => item.id !== id);
        editQuestions(() => remaining);
        if (get().selectedId === id)
          set({ selectedId: remaining[Math.min(index, remaining.length - 1)]?.id ?? null });
      },

      updateQuestion(id, update) {
        editQuestions((questions) =>
          questions.map((question) =>
            question.id === id
              ? { ...update(question), id, orderIndex: question.orderIndex }
              : question,
          ),
        );
      },

      select(id) {
        set({ selectedId: id });
      },

      async save(persist) {
        const { draft, saved, saving } = get();
        if (draft === null || saved === null || saving) return "skipped";
        const sent = draft;
        set({ saving: true, saveError: null });
        try {
          const detail = await persist(sent, saved.revision);
          const snapshot = toWrite(detail);
          // Edits made while saving stay in the draft (and keep it dirty).
          const current = get().draft;
          set({
            saved: { revision: detail.revision, snapshot },
            draft: current === sent ? structuredClone(snapshot) : current,
            saving: false,
            conflict: null,
          });
          return "saved";
        } catch (error) {
          const apiError = error instanceof ApiError ? error : new ApiError(0, "NETWORK_ERROR");
          if (apiError.code === "REVISION_CONFLICT") {
            set({
              saving: false,
              conflict: { currentRevision: apiError.params.currentRevision ?? null },
              saveError: apiError,
            });
            return "conflict";
          }
          set({ saving: false, saveError: apiError });
          return "failed";
        }
      },

      reloadFromServer(detail) {
        get().load(detail);
      },

      rebaseDraft(detail) {
        set({
          saved: { revision: detail.revision, snapshot: toWrite(detail) },
          conflict: null,
          saveError: null,
        });
      },
    };
  });
}

/** React binding for a studio store instance. */
export function useStudio<T>(store: StoreApi<StudioState>, selector: (state: StudioState) => T): T {
  return useStore(store, selector);
}
