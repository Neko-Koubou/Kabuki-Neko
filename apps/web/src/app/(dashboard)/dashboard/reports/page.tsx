/**
 * S09 `/dashboard/reports` (SA §1.2, §4.5; Design §4.4; US-14; TASK-161): the host's report history
 * inside the dashboard shell. The URL search parameters (`quizId`, `search`, `page`) are handed to
 * the client list as plain strings, which parses and clamps them, so the list state survives
 * back/forward navigation and reloads. All report data loads in the client with the host's session.
 */
import { ReportListRoute } from "@/components/reports/report-list";

/** Search params as Next passes them to pages. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a search parameter. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Report list page. */
export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = Object.fromEntries(
    (["page", "search", "quizId"] as const).flatMap((name) => {
      const value = first(raw[name]);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return <ReportListRoute params={params} />;
}
