/**
 * TASK-145 coverage for the question properties panel with a stateful parent.
 * - Five states:
 *   - loading;
 *   - empty (no media, with Choose media and effects unavailable);
 *   - ideal edits;
 *   - partial (missing alternatives, incompatible effect);
 *   - error (invalid clip range).
 * - Exact time values, points with the poll rule, and image-only reveal effects with a one-click
 *   fix.
 * - Question-context alternatives that are never prefilled from the file name, with missing
 *   warnings focusing their field.
 * - Unresolvable media kept by ID; Remove media clears everything together.
 * - Every edit keeps a schema-valid draft (persistence).
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TIME_LIMITS_SEC } from "@kabuki-neko/shared/constants/game";
import { questionSchema, type Question } from "@kabuki-neko/shared/schemas/question.schema";
import { blankQuestion } from "@/stores/studio.store";
import { renderWithLocale } from "@/test/locale";
import { QuestionProperties, type QuestionPropertiesProps } from "./question-properties";

const NAMESPACES = ["common", "accessibility", "studio", "media", "validation"] as const;
const MEDIA_ID = "00000000-0000-4000-8000-000000000042";

/** Parent holding the question; `latest` exposes the current value. */
function renderProperties(initial: Question | null, props: Partial<QuestionPropertiesProps> = {}) {
  const latest: { current: Question | null } = { current: initial };
  const onChooseMedia = vi.fn();
  function Harness() {
    const [question, setQuestion] = useState(initial);
    latest.current = question;
    return (
      <QuestionProperties
        question={question}
        onChange={(update) => setQuestion((current) => (current ? update(current) : current))}
        onChooseMedia={onChooseMedia}
        {...props}
      />
    );
  }
  const view = renderWithLocale(<Harness />, { namespaces: [...NAMESPACES] });
  return { ...view, latest, onChooseMedia };
}

/** A question with an attachment. */
function withMedia(fields: Partial<Question>): Question {
  return {
    ...blankQuestion("SINGLE_CHOICE"),
    promptText: "Gambar apa ini?",
    ...fields,
  } as Question;
}

/** True when the draft is still schema-valid. */
const valid = (question: Question | null) =>
  question !== null && questionSchema.safeParse(question).success;

describe("QuestionProperties", () => {
  it("shows loading, then an empty media state with exact time values and points", async () => {
    const user = userEvent.setup();
    const loading = renderProperties(null);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the question…");
    loading.unmount();
    const { latest, onChooseMedia } = renderProperties(blankQuestion("SINGLE_CHOICE"));
    expect(screen.getByText("No media yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose media" }));
    expect(onChooseMedia).toHaveBeenCalled();
    const time = screen.getByLabelText(/^Time limit/u);
    expect(
      Array.from((time as HTMLSelectElement).options).map((option) => Number(option.value)),
    ).toEqual([...TIME_LIMITS_SEC]);
    await user.selectOptions(time, "30");
    expect(latest.current?.timeLimitSec).toBe(30);
    await user.click(screen.getByRole("radio", { name: "Double points" }));
    expect(latest.current?.pointsMultiplier).toBe(2);
    const reveal = screen.getByLabelText(/^Image reveal/u) as HTMLSelectElement;
    expect(
      Array.from(reveal.options)
        .filter((option) => option.disabled)
        .map((option) => option.value),
    ).toEqual(["GRID_3X3", "GRID_5X5", "BLUR"]);
    expect(
      screen.getByText("Image reveal effects need an image attached to the question."),
    ).toBeInTheDocument();
    expect(valid(latest.current)).toBe(true);
  });

  it("fixes polls at no points with the reason", () => {
    renderProperties({ ...blankQuestion("POLL"), promptText: "Warna?" } as Question);
    expect(screen.getByRole("radio", { name: "No points" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^Double points/u })).toBeDisabled();
    expect(screen.getAllByText("Polls don't award points.").length).toBeGreaterThan(0);
  });

  it("enables image effects and edits question-context alternatives without using the file name", async () => {
    const user = userEvent.setup();
    const { latest } = renderProperties(withMedia({ mediaId: MEDIA_ID }), {
      media: { mimeType: "image/png", originalName: "kucing-tidur.png" },
    });
    expect(screen.getByText("Images: kucing-tidur.png")).toBeInTheDocument();
    const alt = screen.getByLabelText(/^Alternative text/u);
    expect(alt).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Alternative text is missing." }));
    expect(alt).toHaveFocus();
    await user.type(alt, "Kucing tidur di sofa");
    await user.type(screen.getByLabelText(/^Visual description/u), "Kucing oranye");
    expect(screen.queryByText("Alternative text is missing.")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Image reveal/u), "GRID_5X5");
    expect(latest.current).toMatchObject({
      mediaRevealMode: "GRID_5X5",
      accessibility: { altText: "Kucing tidur di sofa", visualDescription: "Kucing oranye" },
    });
    expect(valid(latest.current)).toBe(true);
  });

  it("flags an effect on a video with a one-click fix and validates the clip range", async () => {
    const user = userEvent.setup();
    const { latest } = renderProperties(
      withMedia({
        externalVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mediaRevealMode: "BLUR",
        videoStartSec: 10,
        videoEndSec: 5,
      }),
    );
    expect(screen.getByText("The end time must be after the start time.")).toBeInTheDocument();
    expect(
      screen.getAllByText("Image reveal effects need an image attached to the question.").length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Show immediately" }));
    expect(latest.current?.mediaRevealMode).toBe("NONE");
    const end = screen.getByLabelText(/^End at/u);
    await user.clear(end);
    await user.type(end, "25");
    expect(
      screen.queryByText("The end time must be after the start time."),
    ).not.toBeInTheDocument();
    expect(latest.current).toMatchObject({ videoStartSec: 10, videoEndSec: 25 });
    expect(screen.getByText("A transcript is missing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add caption" }));
    expect(latest.current?.accessibility.captions).toEqual([{ startMs: 0, endMs: 2000, text: "" }]);
    await user.type(screen.getByLabelText(/^Caption text/u), "Halo");
    expect(valid(latest.current)).toBe(true);
  });

  it("keeps an unresolvable media ID and clears everything on Remove media", async () => {
    const user = userEvent.setup();
    const { latest } = renderProperties(
      withMedia({
        mediaId: MEDIA_ID,
        mediaRevealMode: "GRID_3X3",
        accessibility: { altText: "Alt", transcript: null, captions: [], visualDescription: null },
      }),
    );
    expect(screen.getByText("File missing")).toBeInTheDocument();
    expect(latest.current?.mediaId).toBe(MEDIA_ID);
    await user.click(screen.getByRole("button", { name: "Remove media" }));
    expect(latest.current).toMatchObject({
      mediaId: null,
      externalVideoUrl: null,
      videoStartSec: 0,
      videoEndSec: null,
      mediaRevealMode: "NONE",
      accessibility: { altText: null, transcript: null, captions: [], visualDescription: null },
    });
    expect(screen.getByText("No media yet")).toBeInTheDocument();
    expect(valid(latest.current)).toBe(true);
  });

  it("focuses a field from outside", () => {
    renderProperties(withMedia({ mediaId: MEDIA_ID }), {
      media: { mimeType: "image/webp", originalName: "a.webp" },
      focusPath: "accessibility.altText",
    });
    expect(screen.getByLabelText(/^Alternative text/u)).toHaveFocus();
  });
});
