/**
 * S07 `/studio/[quizId]` (SA §1.2, Design §4.3; TASK-146): the quiz studio inside the protected
 * dashboard shell (session check before any content). The server only validates the id (anything but a lowercase UUID is a 404). Loading,
 * access, editing and saving happen in the client studio with the user's session.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { StudioRoute } from "@/components/studio/studio-editor";
import { DashboardShell } from "@/components/ui/dashboard-shell";
import { serverTranslator } from "@/lib/i18n/locale.server";

/** Localized "Quiz studio · Kabuki Neko" title. */
export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const translator = await serverTranslator(
    {
      cookieHeader: requestHeaders.get("cookie"),
      acceptLanguage: requestHeaders.get("accept-language"),
    },
    ["studio"],
  );
  return {
    title: translator?.has("studio.editor.title")
      ? `${translator.t("studio.editor.title")} · Kabuki Neko`
      : "Kabuki Neko",
  };
}

/** Studio page. */
export default async function StudioPage({ params }: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await params;
  if (!uuidSchema.safeParse(quizId).success) notFound();
  return (
    <DashboardShell>
      <StudioRoute quizId={quizId} />
    </DashboardShell>
  );
}
