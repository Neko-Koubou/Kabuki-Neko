"use client";
/**
 * F05 question editor fields for the six question types (S07; Design §4.3, §5 F05, §7.1;
 * SA §3.1; US-04/18/21; TASK-144).
 *
 * - Common fields: type, prompt (500), media button (opens the M05 picker through
 *   `onChooseMedia`) and explanation (1,000, optional). Counters count graphemes (emoji, CJK,
 *   combining marks), and IME input passes through unchanged.
 * - Per type, with option IDs kept stable across every edit:
 *   - SINGLE_CHOICE: 2–4 options and one radio key;
 *   - TRUE_FALSE: two options and one radio key, no add/remove;
 *   - MULTIPLE_SELECT: 2–4 options with checkbox keys;
 *   - POLL: 2–4 options with no key control;
 *   - TYPE_ANSWER: 1–20 accepted answers (all correct);
 *   - ORDER_PUZZLE: exactly four items in the correct order, reordered with Move up/down.
 *   A new TRUE_FALSE starts from the creator's localized "Correct"/"Incorrect" labels. They are
 *   stored as creator content and are not translated during play.
 * - Changing the type converts the question (`convertQuestionType`) and keeps whatever fits
 *   (texts, IDs, keys). If anything would be removed, M09 asks first, and Cancel keeps
 *   everything.
 * - Problems come from the shared `questionPlayabilityIssues` (draft mode) plus local length
 *   checks:
 *   - incomplete fields are warnings: the draft can be saved but not hosted;
 *   - structural errors (duplicates, too long, poll scoring) must be fixed.
 *   Each problem is listed with a button that focuses its field (`focusPath` does the same from
 *   outside).
 * - Correct-answer controls exist only inside this editor; nothing here leaks keys elsewhere.
 * States:
 * - loading: no question yet;
 * - empty: blank fields with guidance;
 * - ideal: complete;
 * - partial: limits reached / incomplete warnings;
 * - error: structural problems listed.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Issue } from "@kabuki-neko/shared/errors";
import { QUESTION_TYPES, type QuestionType } from "@kabuki-neko/shared/constants/game";
import { ANSWER_GEOMETRY } from "@kabuki-neko/shared/constants/geometry";
import { QUIZ_LIMITS, TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import {
  questionPlayabilityIssues,
  type Option,
  type Question,
} from "@kabuki-neko/shared/schemas/question.schema";
import { graphemeLength } from "@kabuki-neko/shared/unicode";
import { AnswerShape, COLOR_CLASS } from "@/components/player/choice-answer-pad";
import { ActionButton } from "@/components/ui/action-button";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { apiErrorMessageKey } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";
import { TYPE_KEY } from "./slide-navigator";

/** Labels used when a TRUE_FALSE question is created from another type. */
export interface TrueFalseLabels {
  correct: string;
  incorrect: string;
}

/** A blank option at `index`. */
function blankOption(index: number, text: boolean): Option {
  return {
    id: crypto.randomUUID(),
    optionIndex: index,
    colorIndex: text ? 0 : index % 4,
    optionText: "",
    isCorrect: false,
    sortOrder: index,
  };
}

/** Renumbers options contiguously (index, color and, for non-puzzles, sort order). */
function renumber(options: readonly Option[], type: QuestionType): Option[] {
  return options.map((option, index) => ({
    ...option,
    optionIndex: index,
    colorIndex: type === "TYPE_ANSWER" ? 0 : index % 4,
    sortOrder: type === "ORDER_PUZZLE" ? option.sortOrder : index,
  }));
}

/**
 * Converts a question to another type, keeping every text, ID and key that fits the new type.
 * Scored types get a multiplier of 1 when coming from a poll; polls always get 0.
 */
export function convertQuestionType(
  question: Question,
  type: QuestionType,
  labels: TrueFalseLabels,
): Question {
  if (question.type === type) return question;
  const texts = question.options.filter((option) => option.optionText.trim() !== "");
  let options: Option[];
  switch (type) {
    case "TRUE_FALSE": {
      const kept = question.options.slice(0, 2);
      options =
        kept.length === 2 && kept.every((option) => option.optionText.trim() !== "")
          ? kept.map((option) => ({ ...option }))
          : [
              { ...(kept[0] ?? blankOption(0, false)), optionText: labels.correct },
              { ...(kept[1] ?? blankOption(1, false)), optionText: labels.incorrect },
            ];
      let keyed = false;
      options = options.map((option) => {
        const isCorrect = option.isCorrect && !keyed && question.type !== "POLL";
        if (isCorrect) keyed = true;
        return { ...option, isCorrect };
      });
      break;
    }
    case "SINGLE_CHOICE":
    case "MULTIPLE_SELECT":
    case "POLL": {
      const source =
        question.type === "TYPE_ANSWER" ? texts : question.options.slice(0, QUIZ_LIMITS.options);
      options = source.slice(0, QUIZ_LIMITS.options).map((option) => ({ ...option }));
      while (options.length < 2) options.push(blankOption(options.length, false));
      let keyed = false;
      options = options.map((option) => {
        let isCorrect =
          type !== "POLL" && question.type !== "POLL" && question.type !== "ORDER_PUZZLE"
            ? option.isCorrect
            : false;
        if (question.type === "TYPE_ANSWER") isCorrect = false;
        if (type === "SINGLE_CHOICE") {
          if (isCorrect && keyed) isCorrect = false;
          if (isCorrect) keyed = true;
        }
        return { ...option, isCorrect };
      });
      break;
    }
    case "TYPE_ANSWER": {
      const accepted =
        question.type === "ORDER_PUZZLE" || question.type === "POLL"
          ? []
          : texts.filter((option) => option.isCorrect);
      options = (accepted.length > 0 ? accepted : [blankOption(0, true)])
        .slice(0, QUIZ_LIMITS.textKeys)
        .map((option) => ({ ...option, isCorrect: true }));
      break;
    }
    case "ORDER_PUZZLE": {
      options = question.options.slice(0, 4).map((option) => ({ ...option, isCorrect: false }));
      while (options.length < 4) options.push(blankOption(options.length, false));
      options = options.map((option, index) => ({ ...option, sortOrder: index }));
      break;
    }
  }
  const pointsMultiplier =
    type === "POLL" ? 0 : question.type === "POLL" ? 1 : question.pointsMultiplier;
  return {
    ...question,
    type,
    pointsMultiplier,
    options: renumber(options, type),
  } as Question;
}

/** True when converting to `type` would drop any entered text or change any key. */
export function typeChangeLosesData(
  question: Question,
  type: QuestionType,
  labels: TrueFalseLabels,
): boolean {
  const converted = convertQuestionType(question, type, labels);
  const after = new Map(converted.options.map((option) => [option.id, option]));
  return question.options.some((option) => {
    const kept = after.get(option.id);
    if (!kept) return option.optionText.trim() !== "" || option.isCorrect;
    return kept.optionText !== option.optionText || kept.isCorrect !== option.isCorrect;
  });
}

/** Local length problems (structural errors that block saving). */
export function lengthIssues(question: Question): Issue[] {
  const issues: Issue[] = [];
  const tooLong = (path: string) =>
    issues.push({ path, code: "TOO_LONG", params: {}, severity: "error" });
  if (graphemeLength(question.promptText) > TEXT_LIMITS.prompt) tooLong("promptText");
  if (
    question.explanationText &&
    graphemeLength(question.explanationText) > TEXT_LIMITS.explanation
  )
    tooLong("explanationText");
  question.options.forEach((option, index) => {
    if (graphemeLength(option.optionText) > TEXT_LIMITS.option)
      tooLong(`options.${index}.optionText`);
  });
  return issues;
}

/** DOM id of the field for an issue path. */
function fieldId(base: string, path: string): string {
  if (path.startsWith("options.") && path.endsWith(".optionText"))
    return `${base}-option-${path.split(".")[1] ?? "0"}`;
  if (path === "options") return `${base}-options`;
  if (path === "explanationText") return `${base}-explanation`;
  if (path === "pointsMultiplier") return `${base}-type`;
  return `${base}-prompt`;
}

/** Props of {@link QuestionFields}. */
export interface QuestionFieldsProps {
  /** The question being edited (null while loading). */
  question: Question | null;
  /** Applies an edit to the question (studio store `updateQuestion`). */
  onChange: (update: (question: Question) => Question) => void;
  /** Opens the media picker for this question. */
  onChooseMedia?: () => void;
  /** Field to focus (an issue path such as `options.2.optionText`). */
  focusPath?: string | null;
}

/** F05: the type-specific question fields. */
export function QuestionFields({
  question,
  onChange,
  onChooseMedia,
  focusPath,
}: QuestionFieldsProps) {
  const { t, ensureNamespaces } = useLocale();
  const base = useId();
  const [pendingType, setPendingType] = useState<QuestionType | null>(null);

  useEffect(() => {
    void ensureNamespaces(["studio", "media", "validation", "reports", "player"]);
  }, [ensureNamespaces]);

  // Focus the requested field (problem list, slide indicator).
  useEffect(() => {
    if (!focusPath) return;
    document.getElementById(fieldId(base, focusPath))?.focus();
  }, [focusPath, base]);

  const labels: TrueFalseLabels = {
    correct: t("reports.table.correct"),
    incorrect: t("player.result.incorrect"),
  };

  const confirmType = useConfirmAction({
    run: async () => {
      if (!pendingType) return;
      const type = pendingType;
      onChange((current) => convertQuestionType(current, type, labels));
    },
    onDone: () => setPendingType(null),
  });

  if (!question)
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("studio.inventory.f05.loading")}
      </p>
    );

  const issues = [...lengthIssues(question), ...questionPlayabilityIssues(question, "draft")];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const issueAt = (path: string) => issues.find((issue) => issue.path === path);
  const messageOf = (issue: Issue | undefined) =>
    issue ? t(apiErrorMessageKey(issue.code)) : undefined;
  const type = question.type;
  const isText = type === "TYPE_ANSWER";
  const isPuzzle = type === "ORDER_PUZZLE";
  const hasKeys = type !== "POLL" && !isText && !isPuzzle;
  const max = isText ? QUIZ_LIMITS.textKeys : QUIZ_LIMITS.options;
  const min = isText ? 1 : 2;
  const fixedCount = type === "TRUE_FALSE" || isPuzzle;
  const limitsReached = !fixedCount && question.options.length >= max;

  /** Edits one option by id. */
  const editOption = (id: string, patch: Partial<Option>) =>
    onChange(
      (current) =>
        ({
          ...current,
          options: current.options.map((option) =>
            option.id === id ? { ...option, ...patch } : option,
          ),
        }) as Question,
    );

  /** Marks the key: one for single/true-false, toggles for multiple select. */
  const setKey = (id: string, checked: boolean) =>
    onChange(
      (current) =>
        ({
          ...current,
          options: current.options.map((option) =>
            current.type === "MULTIPLE_SELECT"
              ? option.id === id
                ? { ...option, isCorrect: checked }
                : option
              : { ...option, isCorrect: option.id === id },
          ),
        }) as Question,
    );

  const addOption = () =>
    onChange((current) => {
      if (current.options.length >= max) return current;
      const added = blankOption(current.options.length, current.type === "TYPE_ANSWER");
      return {
        ...current,
        options: renumber(
          [...current.options, { ...added, isCorrect: current.type === "TYPE_ANSWER" }],
          current.type,
        ),
      } as Question;
    });

  const removeOption = (id: string) =>
    onChange((current) => {
      if (current.options.length <= min) return current;
      return {
        ...current,
        options: renumber(
          current.options.filter((option) => option.id !== id),
          current.type,
        ),
      } as Question;
    });

  /** Moves a puzzle item within the correct order. */
  const movePuzzle = (id: string, delta: -1 | 1) =>
    onChange((current) => {
      const ordered = [...current.options].sort((a, b) => a.sortOrder - b.sortOrder);
      const from = ordered.findIndex((option) => option.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ordered.length) return current;
      const [item] = ordered.splice(from, 1);
      if (item) ordered.splice(to, 0, item);
      const order = new Map(ordered.map((option, index) => [option.id, index]));
      return {
        ...current,
        options: current.options.map((option) => ({
          ...option,
          sortOrder: order.get(option.id) ?? 0,
        })),
      } as Question;
    });

  /** Requests a type change (confirmed first when data would be lost). */
  const changeType = (next: string) => {
    const target = QUESTION_TYPES.find((value) => value === next);
    if (!target || target === type) return;
    if (typeChangeLosesData(question, target, labels)) {
      setPendingType(target);
      confirmType.request();
      return;
    }
    onChange((current) => convertQuestionType(current, target, labels));
  };

  const letter = (index: number) => (ANSWER_GEOMETRY[index] ?? ANSWER_GEOMETRY[0]).label;
  const optionLabel = (index: number) =>
    isText
      ? `${t("studio.question.acceptedAnswers")} ${index + 1}`
      : `${t("accessibility.game.answerOption")} ${letter(index)}`;
  const allOptions: readonly Option[] = question.options;
  const ordered = isPuzzle ? [...allOptions].sort((a, b) => a.sortOrder - b.sortOrder) : allOptions;

  return (
    <section aria-labelledby={`${base}-title`} className="flex flex-col gap-4">
      <h2 id={`${base}-title`} className="text-label font-semibold">
        {t("studio.inventory.f05.title")}
      </h2>
      {(errors.length > 0 || warnings.length > 0) && (
        <div
          role={errors.length > 0 ? "alert" : "status"}
          className={`flex flex-col gap-2 rounded-md border p-3 text-small ${
            errors.length > 0
              ? "border-danger bg-danger-surface text-danger"
              : "border-warning bg-warning-surface text-warning"
          }`}
        >
          <p className="font-semibold">
            {errors.length > 0 ? t("studio.inventory.f05.error") : t("studio.editor.incomplete")}
          </p>
          <ul className="flex flex-col gap-1">
            {[...errors, ...warnings].map((issue, index) => (
              <li key={`${issue.path}-${issue.code}-${index}`}>
                <button
                  type="button"
                  onClick={() => document.getElementById(fieldId(base, issue.path))?.focus()}
                  className="text-start underline underline-offset-2"
                >
                  {t(apiErrorMessageKey(issue.code))}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <FormField
        kind="select"
        id={`${base}-type`}
        label={t("studio.question.type")}
        value={type}
        options={QUESTION_TYPES.map((value) => ({ value, label: t(TYPE_KEY[value]) }))}
        onChange={changeType}
      />
      <FormField
        kind="textarea"
        id={`${base}-prompt`}
        label={t("studio.question.prompt")}
        required
        rows={3}
        limit={TEXT_LIMITS.prompt}
        value={question.promptText}
        onChange={(promptText) => onChange((current) => ({ ...current, promptText }))}
        error={messageOf(issueAt("promptText"))}
      />
      {onChooseMedia && (
        <ActionButton
          variant="secondary"
          label={t("media.inventory.m05.title")}
          onPress={onChooseMedia}
          className="self-start"
        />
      )}
      <fieldset id={`${base}-options`} tabIndex={-1} className="flex flex-col gap-3">
        <legend className="mb-2 text-label font-semibold">
          {isText
            ? t("studio.question.acceptedAnswers")
            : isPuzzle
              ? t("studio.question.correctOrder")
              : t("accessibility.game.answerOption")}
        </legend>
        {issueAt("options") && (
          <p className="text-small text-warning">{messageOf(issueAt("options"))}</p>
        )}
        {ordered.map((option, position) => {
          const index = question.options.findIndex((item) => item.id === option.id);
          return (
            <div
              key={option.id}
              data-option-id={option.id}
              className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-start"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                {!isText && (
                  <span
                    aria-hidden="true"
                    className={`mt-7 inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-label font-bold ${
                      COLOR_CLASS[option.optionIndex] ?? COLOR_CLASS[0]
                    }`}
                  >
                    <AnswerShape index={option.optionIndex} className="size-4" />
                    {letter(option.optionIndex)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <FormField
                    id={`${base}-option-${index}`}
                    label={optionLabel(option.optionIndex)}
                    limit={TEXT_LIMITS.option}
                    value={option.optionText}
                    onChange={(optionText) => editOption(option.id, { optionText })}
                    error={messageOf(issueAt(`options.${index}.optionText`))}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:mt-7">
                {hasKeys && (
                  <label className="inline-flex min-h-11 items-center gap-2 text-small font-semibold">
                    <input
                      type={type === "MULTIPLE_SELECT" ? "checkbox" : "radio"}
                      name={`${base}-key`}
                      checked={option.isCorrect}
                      onChange={(event) => setKey(option.id, event.target.checked)}
                      className="size-5"
                    />
                    <span>
                      {`${t("studio.question.correctOption")}: ${letter(option.optionIndex)}`}
                    </span>
                  </label>
                )}
                {isPuzzle && (
                  <>
                    <ActionButton
                      variant="secondary"
                      iconOnly
                      icon={<ArrowUp />}
                      accessibleName={`${t("studio.slides.moveUp")}: ${letter(option.optionIndex)}`}
                      disabled={position === 0}
                      onPress={() => movePuzzle(option.id, -1)}
                    />
                    <ActionButton
                      variant="secondary"
                      iconOnly
                      icon={<ArrowDown />}
                      accessibleName={`${t("studio.slides.moveDown")}: ${letter(option.optionIndex)}`}
                      disabled={position === ordered.length - 1}
                      onPress={() => movePuzzle(option.id, 1)}
                    />
                  </>
                )}
                {!fixedCount && question.options.length > min && (
                  <ActionButton
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 />}
                    accessibleName={`${
                      isText
                        ? t("studio.question.removeAcceptedAnswer")
                        : t("studio.question.removeOption")
                    }: ${optionLabel(option.optionIndex)}`}
                    onPress={() => removeOption(option.id)}
                  />
                )}
              </div>
            </div>
          );
        })}
        {!fixedCount && (
          <ActionButton
            variant="secondary"
            icon={<Plus />}
            label={isText ? t("studio.question.addAcceptedAnswer") : t("studio.question.addOption")}
            disabled={limitsReached}
            {...(limitsReached ? { disabledReason: t("studio.inventory.f05.partial") } : {})}
            onPress={addOption}
            className="self-start"
          />
        )}
        {type === "POLL" && (
          <p className="text-small text-muted-foreground">{t("player.answer.pollNoPoints")}</p>
        )}
      </fieldset>
      <FormField
        kind="textarea"
        id={`${base}-explanation`}
        label={t("studio.question.explanation")}
        rows={3}
        limit={TEXT_LIMITS.explanation}
        value={question.explanationText ?? ""}
        onChange={(explanation) =>
          onChange((current) => ({
            ...current,
            explanationText: explanation === "" ? null : explanation,
          }))
        }
        error={messageOf(issueAt("explanationText"))}
      />
      <ConfirmDialog
        controller={confirmType}
        impact={t("common.confirm.changeQuestionType")}
        targetName={pendingType ? t(TYPE_KEY[pendingType]) : null}
        confirmLabel={t("common.actions.confirm")}
      />
    </section>
  );
}
