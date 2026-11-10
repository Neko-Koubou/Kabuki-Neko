/**
 * S06 `/dashboard/quizzes/[quizId]` (SA §1.2, Design §4.2; TASK-139): quiz detail and export in the
 * dashboard shell. Only syntactically valid UUIDs reach the client view; anything else is the safe
 * not-found page, so malformed ids never become API requests.
 */
import { notFound } from "next/navigation";
import { QuizDetailRoute } from "@/components/studio/quiz-detail";

/** Canonical UUID shape (any version). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Quiz detail page. */
export default async function QuizDetailPage({ params }: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await params;
  if (!UUID.test(quizId)) notFound();
  return <QuizDetailRoute quizId={quizId.toLowerCase()} />;
}
