"use client";
/**
 * S01 public landing (Design §4.1, §6 S01; SA §1.2; US-08/12/19/21; TASK-133).
 *
 * Inside the public shell (header with Join/Sign in/language/theme, legal footer): the instance
 * name from `/system/public-config` (long names wrap; "Kabuki Neko" while loading or unknown), the
 * lead text, "Join a game" (players need no account, only the host's PIN) and "Sign in" for
 * creators, plus "Create one" when registration is open (PUBLIC or INVITE_ONLY; hidden for
 * SINGLE_ADMIN or when unknown). The mascot is decorative; if it fails a monogram takes its place.
 * When the API is unavailable the shell shows the banner with Try again and this static content
 * stays usable.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PublicShell, monogramOf, usePublicShell } from "@/components/ui/public-shell";
import { useLocale } from "@/providers/locale-provider";

/** Decorative mascot with a monogram fallback (also when it failed before hydration). */
function Mascot({ name }: { name: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && img.currentSrc) setFailed(true);
  }, []);
  if (failed)
    return (
      <span
        aria-hidden="true"
        data-testid="mascot-monogram"
        className="mx-auto inline-flex size-40 items-center justify-center rounded-pill bg-primary text-display font-bold text-primary-foreground md:size-64"
      >
        {monogramOf(name)}
      </span>
    );
  return (
    // Plain <img>: a static self-hosted SVG, no optimizer needed.
    <img
      ref={ref}
      src="/brand/mascot.svg"
      alt=""
      width={320}
      height={320}
      className="mx-auto size-40 md:size-64"
      onError={() => setFailed(true)}
    />
  );
}

/** Landing content (reads the shell's public configuration). */
function Landing() {
  const { t } = useLocale();
  const { state, name } = usePublicShell();
  const registration = state.status === "ready" ? state.config.registrationMode : null;
  const canRegister = registration === "PUBLIC" || registration === "INVITE_ONLY";
  return (
    <section
      aria-labelledby="landing-title"
      aria-busy={state.status === "loading" || undefined}
      className="grid items-center gap-8 py-6 md:grid-cols-[minmax(0,1fr)_auto] md:py-12"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <h1
          id="landing-title"
          className="text-title font-bold break-words hyphens-auto [overflow-wrap:anywhere] md:text-display"
        >
          {name}
        </h1>
        <p className="text-title-sm text-muted-foreground">{t("common.inventory.s01.ideal")}</p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/join"
            className="inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-6 text-label font-semibold text-primary-foreground hover:bg-primary/90"
          >
            {t("player.join.title")}
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-12 items-center justify-center rounded-md border border-border bg-panel px-6 text-label font-semibold hover:bg-subtle"
          >
            {t("auth.login.submit")}
          </Link>
        </div>
        <p className="text-small text-muted-foreground">{t("player.join.pinHelp")}</p>
        {canRegister && (
          <Link
            href="/register"
            className="inline-flex min-h-11 items-center self-start text-label text-primary-text underline"
          >
            {t("auth.login.registrationLink")}
          </Link>
        )}
      </div>
      <Mascot name={name} />
    </section>
  );
}

/** `/` page. */
export default function HomePage() {
  return (
    <PublicShell>
      <Landing />
    </PublicShell>
  );
}
