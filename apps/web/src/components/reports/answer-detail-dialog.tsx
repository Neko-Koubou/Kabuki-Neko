"use client";
/**
 * M12 player answer detail (Design §4.9 M12, §4.4; SA §4.5; US-14/US-18/US-21; TASK-162).
 *
 * - Loads one player's answers page by page (`GET /reports/:sessionId/players/:playerId/answers`,
 *   20 per page, by question order). Each answer is shown against the immutable question snapshot
 *   from the report, never against the current quiz.
 * - Submitted payloads become readable text instead of raw JSON:
 *   - chosen option texts for single choice, true/false, multiple select and polls;
 *   - the typed text;
 *   - the submitted order as a numbered list for order puzzles.
 *   The correct answer is shown the same way: correct options, accepted texts, or the solution
 *   order. Polls have none.
 * - Each row shows result, response time, base points, streak bonus and total points:
 *   - "Partly correct" for partial multiple-select credit;
 *   - "No points" for zero-point questions;
 *   - `0` stays a value and "—" means not available.
 *   NOT_PLAYED ("This question wasn't played."), NOT_ELIGIBLE (joined late) and UNANSWERED
 *   ("No answer") are kept apart.
 * - Historical media: a question's media is shown when the parent provides the asset, otherwise
 *   (or when it fails to load) "This media is no longer available.".
 * - Pagination moves focus to the answer list heading, so keyboard users continue at the top of
 *   the new page. Errors show "The answers couldn't load." with Retry, never an empty list.
 * States:
 * - loading: "Loading answers…";
 * - empty: no answer rows;
 * - ideal: answered questions;
 * - partial: partial credit or unavailable media;
 * - error: load failure with Retry.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Answer } from "@kabuki-neko/shared/schemas/question.schema";
import {
  answerReportsPageSchema,
  type PlayerReport,
  type QuestionReport,
} from "@kabuki-neko/shared/schemas/report.schema";
import { ActionButton } from "@/components/ui/action-button";
import { MediaPreview, type MediaAsset } from "@/components/ui/media-preview";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, createLatestRequest, type ApiClient } from "@/lib/api-client";
import { useLocale } from "@/providers/locale-provider";

/** Answers per page (SA §4.5). */
export const ANSWERS_PAGE_SIZE = 20;

/** One answer row as returned by the API. */
type AnswerRow = ReturnType<typeof answerReportsPageSchema.parse>["items"][number];
/** Snapshot question of a report. */
type SnapshotQuestion = QuestionReport["question"];

/** Option texts of `indexes` in the snapshot (by option index, in the given order). */
function optionTexts(question: SnapshotQuestion, indexes: readonly number[]): string[] {
  return indexes.map(
    (index) => question.options.find((option) => option.optionIndex === index)?.optionText ?? "—",
  );
}

/** A submitted answer as readable texts (one entry, or one per chosen/ordered option). */
export function readableAnswer(question: SnapshotQuestion, answer: Answer): string[] {
  if (typeof answer === "string") return [answer];
  if (typeof answer === "number") return optionTexts(question, [answer]);
  return optionTexts(question, answer);
}

/** The correct answer as readable texts; empty for polls. */
export function readableSolution(question: SnapshotQuestion): string[] {
  if (question.type === "POLL") return [];
  if (question.type === "ORDER_PUZZLE")
    return [...question.options]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((option) => option.optionText);
  return question.options.filter((option) => option.isCorrect).map((option) => option.optionText);
}

/** Message key and badge tone of a row's outcome. */
function outcome(row: AnswerRow): {
  key: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  if (row.status === "NOT_PLAYED") return { key: "reports.answer.notPlayed", tone: "neutral" };
  if (row.status === "NOT_ELIGIBLE") return { key: "reports.answer.notEligible", tone: "neutral" };
  switch (row.result) {
    case "CORRECT":
      return { key: "reports.table.correct", tone: "success" };
    case "PARTIAL":
      return { key: "reports.answer.partial", tone: "warning" };
    case "INCORRECT":
      return { key: "player.result.incorrect", tone: "danger" };
    case "POLL":
      return {
        key: row.status === "ANSWERED" ? "reports.answer.answered" : "reports.answer.unanswered",
        tone: "neutral",
      };
    default:
      return { key: "reports.answer.unanswered", tone: "neutral" };
  }
}

/** Props of {@link AnswerDetailDialog}. */
export interface AnswerDetailDialogProps {
  open: boolean;
  onClose: () => void;
  api: Pick<ApiClient, "request">;
  sessionId: string;
  player: Pick<PlayerReport, "id" | "nickname">;
  /** Question snapshots of the report, indexed by question index. */
  questions: readonly QuestionReport[];
  /** Historical media assets by id, when the parent has them. */
  media?: ReadonlyMap<string, MediaAsset>;
}

/** M12: one player's answers against the report's question snapshots. */
export function AnswerDetailDialog({
  open,
  onClose,
  api,
  sessionId,
  player,
  questions,
  media,
}: AnswerDetailDialogProps) {
  const { t, ensureNamespaces } = useLocale();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: unknown }
    | { status: "ready"; items: AnswerRow[]; totalPages: number }
  >({ status: "loading" });
  const latest = useMemo(() => createLatestRequest(), []);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    void ensureNamespaces(["reports", "player", "studio", "validation"]);
  }, [ensureNamespaces]);

  // A different player starts on page 1.
  useEffect(() => setPage(1), [player.id]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setState({ status: "loading" });
    latest
      .run((signal) =>
        api.request({
          path: `/reports/${sessionId}/players/${player.id}/answers`,
          query: { page, limit: ANSWERS_PAGE_SIZE, sort: "question_asc" },
          schema: answerReportsPageSchema,
          signal,
        }),
      )
      .then(
        (result) => {
          if (!active || result.stale) return;
          setState({
            status: "ready",
            items: result.value.data.items,
            totalPages: Math.max(1, result.value.data.meta.totalPages),
          });
        },
        (error: unknown) => {
          if (active) setState({ status: "error", error });
        },
      );
    return () => {
      active = false;
    };
  }, [open, api, latest, sessionId, player.id, page, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  // After a page change, continue at the top of the new page.
  useEffect(() => {
    if (state.status === "ready" && moved.current) {
      moved.current = false;
      headingRef.current?.focus();
    }
  }, [state]);

  const goTo = useCallback((next: number) => {
    moved.current = true;
    setPage(next);
  }, []);

  let body;
  if (state.status === "loading")
    body = (
      <p role="status" aria-live="polite" className="text-body text-muted-foreground">
        {t("reports.inventory.m12.loading")}
      </p>
    );
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("reports.inventory.m12.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: () => setVersion((n) => n + 1) }}
      />
    );
  else if (state.items.length === 0)
    body = <StatusNotice variant="empty" message={t("reports.inventory.m12.empty")} />;
  else
    body = (
      <ol className="flex flex-col gap-4">
        {state.items.map((row) => (
          <AnswerItem
            key={row.questionIndex}
            row={row}
            question={questions[row.questionIndex]?.question ?? null}
            media={media}
          />
        ))}
      </ol>
    );

  const totalPages = state.status === "ready" ? state.totalPages : 1;
  return (
    <ModalSheet
      open={open}
      title={t("reports.inventory.m12.title")}
      description={<bdi>{player.nickname}</bdi>}
      size="detail"
      fullHeight
      onCloseRequest={onClose}
    >
      <section className="flex flex-col gap-4" aria-busy={state.status === "loading"}>
        <h3 ref={headingRef} tabIndex={-1} className="text-label font-semibold outline-none">
          {t("reports.answer.title")}
        </h3>
        {body}
        {totalPages > 1 && (
          <nav
            aria-label={t("common.pagination.label")}
            className="flex flex-wrap items-center gap-2"
          >
            <ActionButton
              variant="secondary"
              label={t("common.pagination.previous")}
              disabled={page <= 1 || state.status === "loading"}
              onPress={() => goTo(page - 1)}
            />
            <p className="text-small">{t("common.pagination.pageOf", { page, totalPages })}</p>
            <ActionButton
              variant="secondary"
              label={t("common.pagination.next")}
              disabled={page >= totalPages || state.status === "loading"}
              onPress={() => goTo(page + 1)}
            />
          </nav>
        )}
      </section>
    </ModalSheet>
  );
}

/** One question with the player's answer, outcome and points. */
function AnswerItem({
  row,
  question,
  media,
}: {
  row: AnswerRow;
  question: SnapshotQuestion | null;
  media: ReadonlyMap<string, MediaAsset> | undefined;
}) {
  const { t, formatNumber } = useLocale();
  const [mediaFailed, setMediaFailed] = useState(false);
  const result = outcome(row);
  const played = row.status !== "NOT_PLAYED" && row.status !== "NOT_ELIGIBLE";
  const asset = question?.mediaId ? (media?.get(question.mediaId) ?? null) : null;
  const ordered = question?.type === "ORDER_PUZZLE";
  const submitted =
    question && row.submittedPayload !== null ? readableAnswer(question, row.submittedPayload) : [];
  const solution = question ? readableSolution(question) : [];
  const dash = t("reports.detail.noMetric");

  /** Texts as a list (numbered for orders). */
  const texts = (items: readonly string[]) =>
    ordered ? (
      <ol className="list-decimal ps-5">
        {items.map((text, index) => (
          <li key={index} dir="auto" className="break-words">
            {text}
          </li>
        ))}
      </ol>
    ) : (
      <ul className="flex flex-col gap-1">
        {items.map((text, index) => (
          <li key={index} dir="auto" className="break-words">
            {text}
          </li>
        ))}
      </ul>
    );

  return (
    <li
      data-status={row.status}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        <h4 className="min-w-0 flex-1 font-semibold">
          <span className="text-small text-muted-foreground">
            {t("reports.answer.question")} {formatNumber(row.questionIndex + 1)}
          </span>{" "}
          <span dir="auto" className="block whitespace-pre-line break-words">
            {question?.promptText ?? dash}
          </span>
        </h4>
        <StatusBadge tone={result.tone} label={t(result.key)} />
        {question?.pointsMultiplier === 0 && (
          <StatusBadge tone="neutral" label={t("reports.answer.noPoints")} />
        )}
      </div>
      {question?.mediaId &&
        (asset && !mediaFailed ? (
          <MediaPreview asset={asset} onError={() => setMediaFailed(true)} />
        ) : (
          <p className="text-small text-muted-foreground">{t("reports.detail.unavailableMedia")}</p>
        ))}
      {played && (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-small text-muted-foreground">
              {t("reports.answer.submittedAnswer")}
            </dt>
            <dd>{submitted.length > 0 ? texts(submitted) : t("reports.answer.unanswered")}</dd>
          </div>
          {solution.length > 0 && (
            <div>
              <dt className="text-small text-muted-foreground">
                {t("reports.answer.correctAnswer")}
              </dt>
              <dd>{texts(solution)}</dd>
            </div>
          )}
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.table.responseTime")}</dt>
            <dd className="tabular-nums">
              {row.responseTimeMs === null
                ? dash
                : t("reports.detail.responseMilliseconds", { milliseconds: row.responseTimeMs })}
            </dd>
          </div>
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.detail.basePoints")}</dt>
            <dd className="tabular-nums">{formatNumber(row.basePoints)}</dd>
          </div>
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.detail.streakBonus")}</dt>
            <dd className="tabular-nums">{formatNumber(row.streakBonus)}</dd>
          </div>
          <div>
            <dt className="text-small text-muted-foreground">{t("reports.detail.points")}</dt>
            <dd className="font-semibold tabular-nums">{formatNumber(row.pointsAwarded)}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}
