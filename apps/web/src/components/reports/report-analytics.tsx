"use client";
/**
 * S10 / F10 report detail and analytics (Design §4.4, §6.1; SA §4.5; US-14/US-21; TASK-163).
 *
 * - Status gate: the detail (`GET /reports/:sessionId`) opens only for a ready report.
 *   - 409 FINALIZATION_PENDING / 503 REPORT_SAVE_FAILED switch to the finalization status:
 *     - pending is re-read every few seconds and opens the report once ready;
 *     - failed offers "Try saving again" (Idempotency-Key; uncertain outcomes are reconciled,
 *       never re-sent blindly);
 *     - lost explains that no report exists.
 *   - 404 (unknown session, or another host's) shows a safe "not found". It never reveals whether
 *     the session exists.
 * - Everything shown comes from the frozen snapshot:
 *   - KPIs: players, played/total questions, accuracy with the server's numerator and denominator;
 *   - players: 20 per page from the report, then `GET /reports/:id/players`;
 *   - per-question metrics and the hardest questions.
 *   `0` is a value and "—" means not available (no denominator, no rank for removed players).
 *   Polls and zero-point questions do not count toward accuracy, and the definition is stated.
 * - "Answers" opens M12 for one player against the question snapshots.
 * - CSV: "Download CSV" streams the server file through the authenticated client into a download
 *   with the server's safe filename. Export failures have their own message, separate from
 *   loading or finalization errors. Players never reach this page: it is inside the protected
 *   dashboard and every request is scoped to the host.
 * States:
 * - loading;
 * - empty: no players or no answers;
 * - ideal;
 * - partial: partial/no-point metrics, early end, unplayed questions;
 * - error: gate, not found, load failure or export failure.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  finalizeStatusSchema,
  fullReportSchema,
  playerReportsPageSchema,
  type FinalizeStatus,
  type Metric,
  type PlayerReport,
  type QuestionReport,
} from "@kabuki-neko/shared/schemas/report.schema";
import { ActionButton } from "@/components/ui/action-button";
import { AvatarIllustration } from "@/components/ui/avatar-illustration";
import { DataCollection, type CollectionColumn } from "@/components/ui/data-collection";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, createLatestRequest, saveBlob, type ApiClient } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";
import { AnswerDetailDialog } from "./answer-detail-dialog";

/** How often a report still being saved is re-checked. */
export const REPORT_STATUS_POLL_MS = 5_000;
/** Players per page (SA §4.5). */
export const REPORT_PLAYERS_PAGE_SIZE = 20;

/** The full report as validated by the shared contract. */
export type FullReport = ReturnType<typeof fullReportSchema.parse>;

/** Message key of each end reason. */
const END_REASON_KEY = {
  COMPLETED: "reports.detail.completed",
  HOST_ENDED: "reports.detail.earlyEnd",
  EXPIRED: "reports.detail.expired",
} as const;

/** Message key of each question type. */
const TYPE_KEY: Record<string, string> = {
  SINGLE_CHOICE: "studio.types.singleChoice",
  TRUE_FALSE: "studio.types.trueFalse",
  MULTIPLE_SELECT: "studio.types.multipleSelect",
  TYPE_ANSWER: "studio.types.typeAnswer",
  ORDER_PUZZLE: "studio.types.orderPuzzle",
  POLL: "studio.types.poll",
};

/** What the page shows. */
type View =
  | { kind: "loading" }
  | { kind: "ready"; report: FullReport }
  | { kind: "gate" }
  | { kind: "notFound" }
  | { kind: "error"; error: unknown };

/** Loads the full report; the gate statuses become a `gate` view instead of an error. */
async function loadReport(api: ApiClient, sessionId: string, signal: AbortSignal): Promise<View> {
  try {
    const { data } = await api.request({
      path: `/reports/${sessionId}`,
      schema: fullReportSchema,
      signal,
    });
    return { kind: "ready", report: data };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "FINALIZATION_PENDING" || error.code === "REPORT_SAVE_FAILED")
        return { kind: "gate" };
      if (error.code === "NOT_FOUND") return { kind: "notFound" };
    }
    throw error;
  }
}

/** Props of {@link ReportAnalytics}. */
export interface ReportAnalyticsProps {
  sessionId: string;
  /** Status re-check interval (tests). */
  pollMs?: number;
}

/** S10: report detail behind the finalization gate. */
export function ReportAnalytics({
  sessionId,
  pollMs = REPORT_STATUS_POLL_MS,
}: ReportAnalyticsProps) {
  const { t, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  const latest = useMemo(() => createLatestRequest(), []);

  useEffect(() => {
    void ensureNamespaces(["reports", "player", "studio", "host", "validation"]);
  }, [ensureNamespaces]);

  useEffect(() => {
    let active = true;
    setView((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    latest
      .run((signal) => loadReport(api, sessionId, signal))
      .then(
        (result) => {
          if (active && !result.stale) setView(result.value);
        },
        (error: unknown) => {
          if (active) setView({ kind: "error", error });
        },
      );
    return () => {
      active = false;
    };
  }, [api, latest, sessionId, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);

  const back = (
    <Link
      href="/dashboard/reports"
      className="inline-flex min-h-11 items-center self-start rounded-md border border-border px-4 text-label font-semibold"
    >
      {t("common.actions.back")}
    </Link>
  );

  if (view.kind === "ready") return <ReportView report={view.report} api={api} back={back} />;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="report-title">
      {back}
      <h1 id="report-title" className="text-title font-bold">
        {t("reports.detail.title")}
      </h1>
      {view.kind === "loading" && (
        <p role="status" aria-live="polite" className="text-body text-muted-foreground">
          {t("reports.inventory.s10.loading")}
        </p>
      )}
      {view.kind === "gate" && (
        <FinalizationGate sessionId={sessionId} api={api} pollMs={pollMs} onReady={reload} />
      )}
      {view.kind === "notFound" && (
        <StatusNotice tone="error" message={t("validation.errors.notFound")} />
      )}
      {view.kind === "error" && (
        <StatusNotice
          tone="error"
          message={t("reports.inventory.s10.error")}
          correlationId={view.error instanceof ApiError ? view.error.correlationId : null}
          action={{ label: t("common.actions.retry"), onAction: reload }}
        />
      )}
    </section>
  );
}

/** Pending / failed / lost report: polls the status and offers the retry. */
function FinalizationGate({
  sessionId,
  api,
  pollMs,
  onReady,
}: {
  sessionId: string;
  api: ApiClient;
  pollMs: number;
  onReady: () => void;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<FinalizeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);

  /** Reads the status; ready opens the report. */
  const check = useCallback(async () => {
    try {
      const { data } = await api.request({
        path: `/reports/${sessionId}/status`,
        schema: finalizeStatusSchema,
      });
      setFailed(false);
      setStatus(data);
      if (data.status === "ready") onReady();
    } catch {
      setFailed(true);
    }
  }, [api, sessionId, onReady]);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (status && status.status !== "pending") return;
    const timer = setInterval(() => void check(), pollMs);
    return () => clearInterval(timer);
  }, [status, pollMs, check]);

  /** One retry per press; uncertain outcomes re-read the status. */
  const retry = async () => {
    if (running.current) return;
    running.current = true;
    setRetrying(true);
    setProblem(null);
    try {
      const result = await api.mutate("report.retry", {
        method: "POST",
        path: `/reports/${sessionId}/retry-finalize`,
        body: {},
        schema: finalizeStatusSchema,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.outcome === "done") {
        setStatus(result.response.data);
        if (result.response.data.status === "ready") onReady();
      } else await check();
    } catch (error) {
      if (error instanceof ApiError && error.code === "FINALIZATION_PENDING") await check();
      else setProblem(t("reports.detail.finalizeFailed"));
    } finally {
      running.current = false;
      setRetrying(false);
    }
  };

  if (failed && !status)
    return (
      <StatusNotice
        tone="error"
        message={t("reports.inventory.s10.error")}
        action={{ label: t("common.actions.retry"), onAction: () => void check() }}
      />
    );
  if (status?.status === "lost")
    return <StatusNotice tone="error" message={t("host.finalization.lost")} />;
  if (status?.status === "failed")
    return (
      <div className="flex flex-col items-start gap-3">
        <StatusNotice tone="error" message={t("reports.detail.finalizeFailed")} />
        {status.retryable && (
          <ActionButton
            label={t("reports.detail.retryFinalize")}
            pending={retrying}
            onPress={() => void retry()}
          />
        )}
        {problem && (
          <p role="alert" className="text-small text-danger">
            {problem}
          </p>
        )}
      </div>
    );
  return (
    <p role="status" aria-live="polite" className="text-body text-muted-foreground">
      {t("reports.detail.finalizePending")}
    </p>
  );
}

/** Formats a metric as a percentage, or the "—" marker when it has no denominator. */
function useMetric() {
  const { t, formatNumber } = useLocale();
  return useCallback(
    (metric: Metric) =>
      metric.value === null
        ? t("reports.detail.noMetric")
        : formatNumber(metric.value, { style: "percent", maximumFractionDigits: 1 }),
    [t, formatNumber],
  );
}

/** The ready report: header, KPIs, players / questions, hardest questions and CSV. */
function ReportView({
  report,
  api,
  back,
}: {
  report: FullReport;
  api: ApiClient;
  back: ReactNode;
}) {
  const { t, formatNumber, timeZoneLabel } = useLocale();
  const metric = useMetric();
  const [tab, setTab] = useState<"players" | "questions">("players");
  const [exporting, setExporting] = useState(false);
  const [exportProblem, setExportProblem] = useState<string | null>(null);
  const [answersFor, setAnswersFor] = useState<PlayerReport | null>(null);
  const session = report.session;
  const answered = report.questions.reduce((sum, question) => sum + question.acceptedCount, 0);

  /** Downloads the server CSV with its safe filename. */
  const download = async () => {
    if (exporting) return;
    setExporting(true);
    setExportProblem(null);
    try {
      const { blob, filename } = await api.download(
        `/reports/${session.id}/export-csv`,
        `kabuki-neko-report-${session.id}.csv`,
      );
      saveBlob(blob, filename);
    } catch {
      setExportProblem(t("reports.detail.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="flex flex-col gap-6" aria-labelledby="report-title">
      <div className="flex flex-wrap items-start gap-3">
        {back}
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h1 id="report-title" dir="auto" className="text-title font-bold break-words">
            {session.quizTitle}
          </h1>
          <p className="text-small text-muted-foreground">
            {t("reports.detail.sessionEndedAt", {
              endedAt: session.endedAt,
              timezone: timeZoneLabel(session.endedAt),
            })}
          </p>
          <div>
            <StatusBadge
              tone={session.endReason === "COMPLETED" ? "success" : "warning"}
              label={t(END_REASON_KEY[session.endReason])}
            />
          </div>
        </div>
        <ActionButton
          variant="secondary"
          label={t("reports.detail.downloadCsv")}
          pending={exporting}
          onPress={() => void download()}
        />
      </div>
      {exportProblem && (
        <StatusNotice
          tone="error"
          message={exportProblem}
          onDismiss={() => setExportProblem(null)}
        />
      )}

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t("reports.detail.participants")} value={formatNumber(session.totalPlayers)} />
        <Kpi
          label={t("reports.detail.questions")}
          value={`${formatNumber(report.playedQuestions)} / ${formatNumber(report.totalQuestions)}`}
          hint={t("reports.table.played")}
        />
        <Kpi
          label={t("reports.detail.accuracy")}
          value={metric(report.accuracy)}
          hint={
            report.accuracy.denominator > 0
              ? t("reports.detail.accuracyRatio", {
                  numerator: report.accuracy.numerator,
                  denominator: report.accuracy.denominator,
                })
              : undefined
          }
        />
        <Kpi
          label={t("reports.detail.unansweredCount")}
          value={formatNumber(
            report.questions.reduce((sum, question) => sum + question.unansweredCount, 0),
          )}
        />
      </dl>
      <p className="text-small text-muted-foreground">{t("reports.inventory.s10.partial")}</p>
      {session.totalPlayers > 0 && answered === 0 && (
        <StatusNotice variant="empty" message={t("reports.inventory.s10.empty")} />
      )}

      <div role="tablist" aria-label={t("reports.detail.title")} className="flex gap-2">
        {(["players", "questions"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`report-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`report-panel-${id}`}
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-md border px-4 text-label font-semibold ${
              tab === id ? "border-primary bg-primary text-primary-foreground" : "border-border"
            }`}
          >
            {t(id === "players" ? "reports.detail.participants" : "reports.detail.questions")}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`report-panel-${tab}`}
        aria-labelledby={`report-tab-${tab}`}
        className="flex flex-col gap-4"
      >
        {tab === "players" ? (
          <PlayersPanel report={report} api={api} onAnswers={setAnswersFor} />
        ) : (
          <QuestionsPanel questions={report.questions} />
        )}
      </div>

      <HardestQuestions report={report} />

      {answersFor && (
        <AnswerDetailDialog
          open
          onClose={() => setAnswersFor(null)}
          api={api}
          sessionId={session.id}
          player={answersFor}
          questions={report.questions}
        />
      )}
    </section>
  );
}

/** One KPI tile. */
function Kpi({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <dt className="text-small text-muted-foreground">{label}</dt>
      <dd className="text-title font-bold tabular-nums">{value}</dd>
      {hint && <dd className="text-small text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** Players ranked by the snapshot, 20 per page. */
function PlayersPanel({
  report,
  api,
  onAnswers,
}: {
  report: FullReport;
  api: ApiClient;
  onAnswers: (player: PlayerReport) => void;
}) {
  const { t, formatNumber } = useLocale();
  const metric = useMetric();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    items: readonly PlayerReport[] | null;
    totalPages: number;
    pending: boolean;
    error: unknown;
  }>({
    items: report.players.items,
    totalPages: Math.max(1, report.players.meta.totalPages),
    pending: false,
    error: null,
  });
  const latest = useMemo(() => createLatestRequest(), []);
  const dash = t("reports.detail.noMetric");

  useEffect(() => {
    if (page === 1 && version === 0) {
      setState({
        items: report.players.items,
        totalPages: Math.max(1, report.players.meta.totalPages),
        pending: false,
        error: null,
      });
      return;
    }
    setState((current) => ({ ...current, pending: true, error: null }));
    latest
      .run((signal) =>
        api.request({
          path: `/reports/${report.session.id}/players`,
          query: { page, limit: REPORT_PLAYERS_PAGE_SIZE, sort: "rank_asc" },
          schema: playerReportsPageSchema,
          signal,
        }),
      )
      .then(
        (result) => {
          if (result.stale) return;
          setState({
            items: result.value.data.items,
            totalPages: Math.max(1, result.value.data.meta.totalPages),
            pending: false,
            error: null,
          });
        },
        (error: unknown) => setState((current) => ({ ...current, pending: false, error })),
      );
  }, [api, latest, page, report, version]);
  useEffect(() => () => latest.cancel(), [latest]);

  if (report.session.totalPlayers === 0)
    return <StatusNotice variant="empty" message={t("reports.detail.noParticipants")} />;

  const columns: CollectionColumn<PlayerReport>[] = [
    {
      id: "rank",
      header: t("reports.table.rank"),
      cell: (player) => (player.finalRank === null ? dash : formatNumber(player.finalRank)),
    },
    {
      id: "nickname",
      header: t("reports.table.nickname"),
      primary: true,
      cell: (player) => (
        <span className="flex items-center gap-2">
          <AvatarIllustration
            avatar={player.avatar}
            nickname={player.nickname}
            size={32}
            decorative
          />
          <bdi className="break-words">{player.nickname}</bdi>
        </span>
      ),
    },
    {
      id: "score",
      header: t("reports.table.score"),
      align: "end",
      cell: (p) => formatNumber(p.finalScore),
    },
    {
      id: "correct",
      header: t("reports.table.correct"),
      align: "end",
      cell: (p) => formatNumber(p.correctCount),
    },
    {
      id: "unanswered",
      header: t("reports.table.unanswered"),
      align: "end",
      cell: (p) => formatNumber(p.unansweredCount),
    },
    {
      id: "streak",
      header: t("reports.detail.maxStreak"),
      align: "end",
      cell: (p) => formatNumber(p.maxStreak),
    },
    {
      id: "response",
      header: t("reports.detail.responseTime"),
      align: "end",
      cell: (p) =>
        p.avgResponseTimeMs === null
          ? dash
          : t("reports.detail.responseMilliseconds", {
              milliseconds: Math.round(p.avgResponseTimeMs),
            }),
    },
    {
      id: "accuracy",
      header: t("reports.table.accuracy"),
      align: "end",
      cell: (p) => metric(p.accuracy),
    },
    {
      id: "answers",
      header: t("reports.answer.title"),
      cell: (player) => (
        <ActionButton
          variant="secondary"
          label={`${t("reports.answer.title")}: ${player.nickname}`}
          onPress={() => onAnswers(player)}
        />
      ),
    },
  ];
  return (
    <DataCollection
      caption={t("reports.detail.participants")}
      hideCaption
      items={state.items}
      columns={columns}
      rowKey={(player) => player.id}
      page={page}
      pageCount={state.totalPages}
      totalCount={report.session.totalPlayers}
      onPage={setPage}
      pending={state.pending}
      error={state.error}
      onRetry={() => setVersion((n) => n + 1)}
    />
  );
}

/** Per-question results from the snapshot (played and unplayed). */
function QuestionsPanel({ questions }: { questions: readonly QuestionReport[] }) {
  const { t, formatNumber } = useLocale();
  const metric = useMetric();
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((report) => {
        const question = report.question;
        const scored = report.accuracy.denominator > 0;
        return (
          <li
            key={report.questionIndex}
            data-question-status={report.status}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-start gap-2">
              <h3 className="min-w-0 flex-1 font-semibold">
                <span className="text-small text-muted-foreground">
                  {t("reports.answer.question")} {formatNumber(report.questionIndex + 1)} ·{" "}
                  {t(TYPE_KEY[question.type] ?? "studio.types.singleChoice")}
                </span>{" "}
                <span dir="auto" className="block whitespace-pre-line break-words">
                  {question.promptText}
                </span>
              </h3>
              <StatusBadge
                tone={report.status === "PLAYED" ? "info" : "neutral"}
                label={t(
                  report.status === "PLAYED" ? "reports.table.played" : "reports.table.unplayed",
                )}
              />
              {question.pointsMultiplier === 0 && (
                <StatusBadge tone="neutral" label={t("reports.answer.noPoints")} />
              )}
            </div>
            {report.status === "PLAYED" && (
              <dl className="grid gap-x-6 gap-y-1 text-small sm:grid-cols-3 lg:grid-cols-6">
                <QuestionStat
                  label={t("reports.answer.answered")}
                  value={formatNumber(report.acceptedCount)}
                />
                <QuestionStat
                  label={t("reports.table.correct")}
                  value={formatNumber(report.correctCount)}
                />
                <QuestionStat
                  label={t("reports.answer.partial")}
                  value={formatNumber(report.partialCount)}
                />
                <QuestionStat
                  label={t("player.result.incorrect")}
                  value={formatNumber(report.incorrectCount)}
                />
                <QuestionStat
                  label={t("reports.table.unanswered")}
                  value={formatNumber(report.unansweredCount)}
                />
                <QuestionStat
                  label={t("reports.table.accuracy")}
                  value={metric(report.accuracy)}
                  hint={
                    scored
                      ? t("reports.detail.accuracyRatio", {
                          numerator: report.accuracy.numerator,
                          denominator: report.accuracy.denominator,
                        })
                      : undefined
                  }
                />
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** One labelled number of a question. */
function QuestionStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** The server's hardest questions (lowest accuracy among scored, played questions). */
function HardestQuestions({ report }: { report: FullReport }) {
  const { t, formatNumber } = useLocale();
  const metric = useMetric();
  const hardest = report.hardestQuestionIndexes
    .map((index) => report.questions[index])
    .filter((question): question is QuestionReport => question !== undefined);
  return (
    <section aria-labelledby="hardest-title" className="flex flex-col gap-2">
      <h2 id="hardest-title" className="text-label font-semibold">
        {t("reports.detail.hardestQuestions")}
      </h2>
      {hardest.length === 0 ? (
        <p className="text-small text-muted-foreground">{t("reports.detail.noMetric")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {hardest.map((question) => (
            <li
              key={question.questionIndex}
              className="flex flex-wrap items-baseline gap-2 rounded-md border border-border p-3"
            >
              <span className="text-small text-muted-foreground">
                {t("reports.answer.question")} {formatNumber(question.questionIndex + 1)}
              </span>
              <span dir="auto" className="min-w-0 flex-1 break-words">
                {question.question.promptText}
              </span>
              <span className="font-semibold tabular-nums">
                {t("reports.table.accuracy")}: {metric(question.accuracy)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
