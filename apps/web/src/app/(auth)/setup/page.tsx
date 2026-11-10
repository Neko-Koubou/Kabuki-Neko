/**
 * S02 `/setup` (SA §4.2, Design §4.1; TASK-135). The server asks `/auth/setup-status` without
 * caching: an initialized instance redirects to `/login` before anything renders. Otherwise (or
 * when the API cannot be reached, which the form then reports itself) the public shell renders the
 * two-step setup form; a tab that loses the setup race ends on "Sign in".
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PublicShell } from "@/components/ui/public-shell";
import { authMetadata, fetchSetupStatus } from "../auth-metadata";
import { AuthRoute } from "../auth-route";

/** Localized "Set up Kabuki Neko" title, noindex. */
export function generateMetadata(): Promise<Metadata> {
  return authMetadata("auth.inventory.s02.title");
}

/** Setup page (redirects once the instance is initialized). */
export default async function SetupPage() {
  const status = await fetchSetupStatus();
  if (status?.isInitialized) redirect("/login");
  return (
    <PublicShell>
      <AuthRoute mode="setup" returnTo="/dashboard" />
    </PublicShell>
  );
}
