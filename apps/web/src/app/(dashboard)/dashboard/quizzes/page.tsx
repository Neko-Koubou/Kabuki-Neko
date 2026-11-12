/**
 * S05 `/dashboard/quizzes` (SA §1.2, Design §4.2; TASK-138): the quiz library inside the dashboard
 * shell. The URL search parameters (`scope`, `search`, `sort`, `page`) are handed to the client
 * library as plain strings, which parses and clamps them, so the list state survives back/forward
 * navigation and reloads.
 */
import { QuizLibraryRoute } from "@/components/studio/quiz-library-detail";

/** Search params as Next passes them to pages. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value of a search parameter. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Quiz library page. */
export default async function QuizzesPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = Object.fromEntries(
    (["scope", "page", "search", "sort"] as const).flatMap((name) => {
      const value = first(raw[name]);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return <QuizLibraryRoute params={params} />;
}
