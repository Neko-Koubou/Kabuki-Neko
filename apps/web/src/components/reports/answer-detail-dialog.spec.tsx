/**
 * TASK-162 coverage for M12 (player answer detail) against a scripted API.
 * - Five states:
 *   - loading;
 *   - empty;
 *   - ideal: readable answers against the question snapshots;
 *   - partial: partial credit and unavailable media;
 *   - error: Retry, never an empty list.
 * - Readable payloads: single choice, multiple select (partial), typed text, order puzzle (numbered,
 *   submitted order), poll (no correct answer), a zero-point question labelled "No points".
 * - NOT_PLAYED, NOT_ELIGIBLE and UNANSWERED stay distinct; response time, base, bonus and total
 *   points, with "—" only for missing values.
 * - Pagination: 20 per page, page request, keyboard focus moved to the list heading.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QuestionReport } from "@kabuki-neko/shared/schemas/report.schema";
import { renderWithLocale } from "@/test/locale";
import {
  AnswerDetailDialog,
  readableAnswer,
  readableSolution,
  type AnswerDetailDialogProps,
} from "./answer-detail-dialog";

const NAMESPACES = [
  "common",
  "accessibility",
  "reports",
  "player",
  "studio",
  "validation",
] as const;
const SESSION = "30000000-0000-4000-8000-000000000001";
const PLAYER = { id: "50000000-0000-4000-8000-000000000001", nickname: "Mimi" };

/** Option fixture. */
function option(n: number, q: number, text: string, isCorrect = false) {
  return {
    id: `6000000${q}-0000-4000-8000-00000000000${n}`,
    optionIndex: n,
    colorIndex: n,
    optionText: text,
    isCorrect,
    sortOrder: n,
  };
}

/** Question snapshot fixture (only what the dialog reads). */
function question(
  index: number,
  type: string,
  promptText: string,
  options: ReturnType<typeof option>[],
  extra: Record<string, unknown> = {},
) {
  return {
    questionIndex: index,
    question: {
      id: `70000000-0000-4000-8000-00000000000${index}`,
      orderIndex: index,
      type,
      promptText,
      mediaId: null,
      pointsMultiplier: 1,
      options,
      ...extra,
    },
  };
}

const QUESTIONS = [
  question(0, "SINGLE_CHOICE", "Ibu kota Indonesia?", [
    option(0, 0, "Jakarta", true),
    option(1, 0, "Bandung"),
  ]),
  question(1, "MULTIPLE_SELECT", "Kota di Jawa?", [
    option(0, 1, "Bandung", true),
    option(1, 1, "Surabaya", true),
    option(2, 1, "Medan"),
  ]),
  question(2, "TYPE_ANSWER", "Kucing dalam bahasa Jepang?", [option(0, 2, "Neko", true)]),
  question(3, "ORDER_PUZZLE", "Urutkan", [
    option(0, 3, "Satu"),
    option(1, 3, "Dua"),
    option(2, 3, "Tiga"),
    option(3, 3, "Empat"),
  ]),
  question(4, "POLL", "Musim favorit?", [option(0, 4, "Hujan"), option(1, 4, "Kemarau")]),
  question(5, "TRUE_FALSE", "Tanpa poin?", [option(0, 5, "Benar", true), option(1, 5, "Salah")], {
    pointsMultiplier: 0,
  }),
  question(6, "SINGLE_CHOICE", "Dengan gambar", [option(0, 6, "Ya", true), option(1, 6, "Tidak")], {
    mediaId: "80000000-0000-4000-8000-000000000001",
  }),
  question(7, "SINGLE_CHOICE", "Tidak dijawab", [option(0, 7, "A", true), option(1, 7, "B")]),
  question(8, "SINGLE_CHOICE", "Tidak dimainkan", [option(0, 8, "A", true), option(1, 8, "B")]),
] as unknown as QuestionReport[];

const none = {
  submittedPayload: null,
  result: null,
  isCorrect: null,
  accuracyNumerator: 0,
  accuracyDenominator: 0,
  responseTimeMs: null,
  pointsAwarded: 0,
  streakBonus: 0,
  basePoints: 0,
};

/** The answer rows of the first page. */
const ROWS = [
  {
    questionIndex: 0,
    status: "ANSWERED",
    submittedPayload: 0,
    result: "CORRECT",
    isCorrect: true,
    accuracyNumerator: 1,
    accuracyDenominator: 1,
    responseTimeMs: 1200,
    pointsAwarded: 950,
    streakBonus: 0,
    basePoints: 950,
  },
  {
    questionIndex: 1,
    status: "ANSWERED",
    submittedPayload: [0, 2],
    result: "PARTIAL",
    isCorrect: true,
    accuracyNumerator: 1,
    accuracyDenominator: 2,
    responseTimeMs: 3400,
    pointsAwarded: 600,
    streakBonus: 100,
    basePoints: 500,
  },
  {
    questionIndex: 2,
    status: "ANSWERED",
    submittedPayload: "nekko",
    result: "INCORRECT",
    isCorrect: false,
    accuracyNumerator: 0,
    accuracyDenominator: 1,
    responseTimeMs: 0,
    pointsAwarded: 0,
    streakBonus: 0,
    basePoints: 0,
  },
  {
    questionIndex: 3,
    status: "ANSWERED",
    submittedPayload: [2, 0, 1, 3],
    result: "INCORRECT",
    isCorrect: false,
    accuracyNumerator: 0,
    accuracyDenominator: 1,
    responseTimeMs: 5000,
    pointsAwarded: 0,
    streakBonus: 0,
    basePoints: 0,
  },
  {
    questionIndex: 4,
    status: "ANSWERED",
    submittedPayload: 1,
    result: "POLL",
    isCorrect: null,
    accuracyNumerator: 0,
    accuracyDenominator: 0,
    responseTimeMs: 2000,
    pointsAwarded: 0,
    streakBonus: 0,
    basePoints: 0,
  },
  {
    questionIndex: 5,
    status: "ANSWERED",
    submittedPayload: 0,
    result: "CORRECT",
    isCorrect: true,
    accuracyNumerator: 1,
    accuracyDenominator: 1,
    responseTimeMs: 900,
    pointsAwarded: 0,
    streakBonus: 0,
    basePoints: 0,
  },
  { ...none, questionIndex: 6, status: "NOT_ELIGIBLE" },
  { ...none, questionIndex: 7, status: "UNANSWERED", result: "UNANSWERED" },
  { ...none, questionIndex: 8, status: "NOT_PLAYED" },
];

/** JSON page response. */
function page(items: unknown[], total = items.length, pageNumber = 1) {
  return new Response(
    JSON.stringify({
      items,
      meta: { page: pageNumber, limit: 20, total, totalPages: Math.ceil(total / 20) },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Scripted API client exposing `request` and the recorded calls. */
function fakeApi(answer: (query: Record<string, unknown>) => Promise<unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const request = vi.fn(
    async (req: {
      path: string;
      query?: Record<string, unknown>;
      schema?: { parse: (v: unknown) => unknown };
    }) => {
      calls.push({ path: req.path, query: req.query ?? {} });
      const body = await answer(req.query ?? {});
      return { data: req.schema ? req.schema.parse(body) : body, status: 200, revision: null };
    },
  );
  return { calls, request: request as unknown as AnswerDetailDialogProps["api"]["request"] };
}

/** The JSON body of a page response. */
async function body(response: Response) {
  return (await response.json()) as unknown;
}

/** Renders the open dialog. */
function renderDialog(api: ReturnType<typeof fakeApi>) {
  return renderWithLocale(
    <AnswerDetailDialog
      open
      onClose={() => undefined}
      api={{ request: api.request }}
      sessionId={SESSION}
      player={PLAYER}
      questions={QUESTIONS}
    />,
    { namespaces: [...NAMESPACES] },
  );
}

/** The answer item of question `index`. */
function item(index: number) {
  const element = document.querySelectorAll("li[data-status]")[index];
  if (!(element instanceof HTMLElement)) throw new Error(`item ${index} missing`);
  return within(element);
}

describe("readable answers", () => {
  it("turns payloads and solutions into option texts", () => {
    const [single, multi, typed, order, poll] = QUESTIONS.map((report) => report.question);
    if (!single || !multi || !typed || !order || !poll) throw new Error("fixtures");
    expect(readableAnswer(single, 0)).toEqual(["Jakarta"]);
    expect(readableAnswer(multi, [0, 2])).toEqual(["Bandung", "Medan"]);
    expect(readableAnswer(typed, "nekko")).toEqual(["nekko"]);
    expect(readableAnswer(order, [2, 0, 1, 3])).toEqual(["Tiga", "Satu", "Dua", "Empat"]);
    expect(readableSolution(order)).toEqual(["Satu", "Dua", "Tiga", "Empat"]);
    expect(readableSolution(multi)).toEqual(["Bandung", "Surabaya"]);
    expect(readableSolution(poll)).toEqual([]);
  });
});

describe("AnswerDetailDialog", () => {
  it("loads, then shows readable answers, outcomes and points per question", async () => {
    let release: (value: unknown) => void = () => undefined;
    const api = fakeApi(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    renderDialog(api);
    expect(await screen.findByText("Loading answers…")).toBeInTheDocument();
    expect(screen.getByText("Mimi")).toBeInTheDocument();
    release(await body(page(ROWS)));
    await screen.findByText("Ibu kota Indonesia?");
    expect(api.calls[0]).toEqual({
      path: `/reports/${SESSION}/players/${PLAYER.id}/answers`,
      query: { page: 1, limit: 20, sort: "question_asc" },
    });

    const single = item(0);
    expect(single.getByText("Correct")).toBeInTheDocument();
    expect(single.getAllByText("Jakarta")).toHaveLength(2); // submitted + correct answer
    expect(single.getByText("1,200 ms")).toBeInTheDocument();
    expect(single.getAllByText("950")).toHaveLength(2); // base + total

    const partial = item(1);
    expect(partial.getByText("Partly correct")).toBeInTheDocument();
    expect(partial.getByText("Medan")).toBeInTheDocument();
    expect(partial.getByText("100")).toBeInTheDocument(); // streak bonus
    expect(partial.getByText("600")).toBeInTheDocument();

    const typed = item(2);
    expect(typed.getByText("Incorrect")).toBeInTheDocument();
    expect(typed.getByText("nekko")).toBeInTheDocument();
    expect(typed.getByText("Neko")).toBeInTheDocument();
    expect(typed.getByText("0 ms")).toBeInTheDocument(); // 0 is a value, not "—"

    const order = item(3);
    const [submittedOrder] = order.getAllByRole("list");
    expect(submittedOrder?.tagName).toBe("OL");
    expect(
      within(submittedOrder as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Tiga", "Satu", "Dua", "Empat"]);

    const poll = item(4);
    expect(poll.getByText("Answered")).toBeInTheDocument();
    expect(poll.getByText("Kemarau")).toBeInTheDocument();
    expect(poll.queryByText("Correct answer")).not.toBeInTheDocument();

    expect(item(5).getByText("No points")).toBeInTheDocument();
  });

  it("keeps not eligible, unanswered and not played apart, with unavailable media", async () => {
    const api = fakeApi(async () => body(page(ROWS)));
    renderDialog(api);
    await screen.findByText("Dengan gambar");
    const late = item(6);
    expect(late.getByText("Not eligible (joined after the question started)")).toBeInTheDocument();
    expect(late.getByText("This media is no longer available.")).toBeInTheDocument();
    expect(late.queryByText("Submitted answer")).not.toBeInTheDocument();
    const unanswered = item(7);
    expect(unanswered.getAllByText("No answer").length).toBeGreaterThan(0);
    expect(unanswered.getByText("—")).toBeInTheDocument(); // no response time
    const unplayed = item(8);
    expect(unplayed.getByText("This question wasn't played.")).toBeInTheDocument();
    expect(unplayed.queryByText("No answer")).not.toBeInTheDocument();
  });

  it("shows a load failure with Retry instead of an empty list, and the empty state", async () => {
    const user = userEvent.setup();
    const answers: (() => Promise<unknown>)[] = [
      () => Promise.reject(new Error("offline")),
      async () => body(page([])),
    ];
    const api = fakeApi(() => (answers.shift() ?? (async () => body(page([]))))());
    renderDialog(api);
    expect(await screen.findByText("The answers couldn't load. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/No answer was given/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("No answer was given, or this question wasn't played."),
    ).toBeInTheDocument();
  });

  it("pages with the keyboard and moves focus to the list heading", async () => {
    const user = userEvent.setup();
    const api = fakeApi(async (query) =>
      body(
        query["page"] === 2
          ? page([{ ...none, questionIndex: 8, status: "NOT_PLAYED" }], 21, 2)
          : page(ROWS.slice(0, 1), 21, 1),
      ),
    );
    renderDialog(api);
    await screen.findByText("Ibu kota Indonesia?");
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    screen.getByRole("button", { name: "Next page" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Tidak dimainkan")).toBeInTheDocument();
    expect(api.calls.at(-1)?.query["page"]).toBe(2);
    expect(screen.getByRole("heading", { name: "Answers" })).toHaveFocus();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });
});
