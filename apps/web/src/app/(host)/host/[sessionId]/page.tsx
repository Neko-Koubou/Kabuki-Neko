/**
 * S16 `/host/[sessionId]` (SA §1.2, Design §4.7, §6.1; US-07/10/12/13/14/21; TASK-160): the
 * signed-in host's game stage.
 *
 * - The server only validates the session id (anything but a UUID is a 404) and localizes the
 *   title. No quiz content, PIN or key is rendered or passed as props from the server: the stage
 *   recovers the room over the host's authenticated socket (`host:recover_room`), and the server
 *   decides whether this user hosts that session.
 * - HostStageRoute checks the session first: anonymous visitors are sent to sign-in with this page
 *   as returnTo, and a lost session keeps the stage inert behind "Sign in again".
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { uuidSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { HostStageRoute } from "@/components/host/host-stage";
import { SkipLink } from "@/components/ui/public-shell";
import { serverTranslator } from "@/lib/i18n/locale.server";

/** Localized "Host · Kabuki Neko" title. */
export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const translator = await serverTranslator(
    {
      cookieHeader: requestHeaders.get("cookie"),
      acceptLanguage: requestHeaders.get("accept-language"),
    },
    ["host"],
  );
  return {
    title: translator?.has("host.inventory.s16.title")
      ? `${translator.t("host.inventory.s16.title")} · Kabuki Neko`
      : "Kabuki Neko",
  };
}

/** Route params as Next passes them to pages. */
type Params = Promise<{ sessionId: string }>;

/** Host stage page. */
export default async function HostPage({ params }: { params: Params }) {
  const { sessionId } = await params;
  if (!uuidSchema.safeParse(sessionId).success) notFound();
  return (
    <>
      <SkipLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-dvh w-full flex-col pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
      >
        <HostStageRoute sessionId={sessionId} />
      </main>
    </>
  );
}
