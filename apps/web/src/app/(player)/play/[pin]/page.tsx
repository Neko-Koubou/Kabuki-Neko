/**
 * S15 `/play/[pin]` (SA §1.2, Design §4.6, §6.1; US-08–13/18/21; TASK-157): the guest game screen.
 * Players need no account.
 *
 * - The server only validates the six-digit PIN (anything else is a 404) and localizes the title.
 *   No quiz content, options or keys are rendered or passed as props from the server: everything
 *   game-related arrives over the player's socket after a join. The RSC payload stays free of keys.
 * - The client game (PlayerGame) reads the room credentials saved at join and handles every phase,
 *   recovery and fallback.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { pinCodeSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { PlayerGame } from "@/components/player/player-game";
import { SkipLink } from "@/components/ui/public-shell";
import { serverTranslator } from "@/lib/i18n/locale.server";

/** Localized "Game · Kabuki Neko" title. */
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
    title: translator?.has("player.inventory.s15.title")
      ? `${translator.t("player.inventory.s15.title")} · Kabuki Neko`
      : "Kabuki Neko",
  };
}

/** Route params as Next passes them to pages. */
type Params = Promise<{ pin: string }>;

/** Player game page. */
export default async function PlayPage({ params }: { params: Params }) {
  const { pin } = await params;
  if (!pinCodeSchema.safeParse(pin).success) notFound();
  return (
    <>
      <SkipLink />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <PlayerGame pinCode={pin} />
      </main>
    </>
  );
}
