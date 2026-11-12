/**
 * S04 `/register` (SA §4.2, Design §4.1; TASK-135): the public shell with the policy-aware
 * registration form (PUBLIC, INVITE_ONLY or closed for SINGLE_ADMIN, read live by the form).
 */
import type { Metadata } from "next";
import { PublicShell } from "@/components/ui/public-shell";
import { authMetadata, returnToFrom, type AuthSearchParams } from "../auth-metadata";
import { AuthRoute } from "../auth-route";

/** Localized "Create an account · Kabuki Neko" title, noindex. */
export function generateMetadata(): Promise<Metadata> {
  return authMetadata("auth.inventory.s04.title");
}

/** Registration page. */
export default async function RegisterPage({ searchParams }: { searchParams: AuthSearchParams }) {
  return (
    <PublicShell>
      <AuthRoute mode="register" returnTo={await returnToFrom(searchParams)} />
    </PublicShell>
  );
}
