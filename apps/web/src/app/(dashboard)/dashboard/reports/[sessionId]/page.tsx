/**
 * S10 `/dashboard/reports/[sessionId]` (SA §1.2, §4.5; Design §4.4, §6.1; US-14; TASK-163): one
 * report inside the protected dashboard shell. The server only validates the id (anything but a
 * UUID is a 404); the report, its finalization gate, players, answers and CSV load in the client
 * with the host's session, scoped by the API to reports this host owns.
 */
import { notFound } from "next/navigation";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { ReportAnalytics } from "@/components/reports/report-analytics";

/** Route params as Next passes them to pages. */
type Params = Promise<{ sessionId: string }>;

/** Report detail page. */
export default async function ReportPage({ params }: { params: Params }) {
  const { sessionId } = await params;
  if (!uuidSchema.safeParse(sessionId).success) notFound();
  return <ReportAnalytics sessionId={sessionId} />;
}
