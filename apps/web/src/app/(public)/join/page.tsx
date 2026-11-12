/**
 * S14 `/join` (SA §1.2, Design §4.6; TASK-151): the guest join page inside the public shell. Players
 * need no account. A `?pin=` deep link (from the host's QR code or a shared link) is handed to the
 * client flow, which checks it exactly once; the title is localized on the server.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { JoinRoute } from "@/components/player/join-route";
import { PublicShell } from "@/components/ui/public-shell";
import { serverTranslator } from "@/lib/i18n/locale.server";

/** Localized "Join a game · Kabuki Neko" title. */
export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const translator = await serverTranslator(
    {
      cookieHeader: requestHeaders.get("cookie"),
      acceptLanguage: requestHeaders.get("accept-language"),
    },
    ["player"],
  );
  return {
    title: translator?.has("player.join.title")
      ? `${translator.t("player.join.title")} · Kabuki Neko`
      : "Kabuki Neko",
  };
}

/** Search params as Next passes them to pages. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Join page. */
export default async function JoinPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).pin;
  const pin = Array.isArray(raw) ? raw[0] : raw;
  return (
    <PublicShell>
      <div className="py-6">
        <JoinRoute initialPin={typeof pin === "string" && pin.length <= 32 ? pin : null} />
      </div>
    </PublicShell>
  );
}
