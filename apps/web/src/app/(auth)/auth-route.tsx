"use client";
/**
 * Client part of the auth routes (TASK-135). Inside the public shell it first checks for an
 * existing session (silent refresh); while that runs only a loading status is shown, so the form
 * never flashes for signed-in users. An active session is sent to the sanitized `returnTo`
 * (allowlisted app paths, otherwise the dashboard). Anonymous visitors, or a lost session, get
 * the shared F01 form for the mode. Only the `returnTo` string crosses from the server; tokens
 * stay in the auth provider's memory.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PublicAuthForms, type AuthMode } from "@/components/auth/public-auth-forms";
import { safeReturnTo, useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Props of {@link AuthRoute}. */
export interface AuthRouteProps {
  mode: AuthMode;
  returnTo: string | null;
}

/** Session-aware mount of the setup / sign-in / registration form. */
export function AuthRoute({ mode, returnTo }: AuthRouteProps) {
  const { t } = useLocale();
  const { status, ensureSession } = useAuth();
  const router = useRouter();
  const destination = safeReturnTo(returnTo);

  useEffect(() => {
    if (status === "unknown") void ensureSession();
  }, [status, ensureSession]);

  useEffect(() => {
    if (status === "authenticated") router.replace(destination);
  }, [status, destination, router]);

  if (status === "unknown" || status === "checking" || status === "authenticated")
    return (
      <p
        role="status"
        className="mx-auto w-full max-w-[440px] py-6 text-small text-muted-foreground"
      >
        {t("common.status.loading")}
      </p>
    );
  return (
    <div className="py-6">
      <PublicAuthForms
        mode={mode}
        returnTo={returnTo}
        onAuthenticated={(next) => router.replace(next)}
      />
    </div>
  );
}
