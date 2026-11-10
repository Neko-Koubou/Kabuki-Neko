/**
 * S03 `/login` (SA §4.2, Design §4.1; TASK-135): the public shell with the sign-in form. The title
 * is localized on the server; signed-in visitors go straight to their (sanitized) `returnTo`.
 */
import type { Metadata } from "next";
import { PublicShell } from "@/components/ui/public-shell";
import { authMetadata, returnToFrom, type AuthSearchParams } from "../auth-metadata";
import { AuthRoute } from "../auth-route";

/** Localized "Sign in · Kabuki Neko" title, noindex. */
export function generateMetadata(): Promise<Metadata> {
  return authMetadata("auth.inventory.s03.title");
}

/** Sign-in page. */
export default async function LoginPage({ searchParams }: { searchParams: AuthSearchParams }) {
  return (
    <PublicShell>
      <AuthRoute mode="login" returnTo={await returnToFrom(searchParams)} />
    </PublicShell>
  );
}
