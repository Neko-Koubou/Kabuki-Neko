"use client";
/**
 * F01 public auth forms: setup, sign in and registration (US-01/02/18/21; SA §4.2; Design §4.1;
 * TASK-134).
 *
 * - Setup is two local steps (instance name, then the administrator account). Nothing is sent
 *   until the last step, and the request is sent once (pending ignores repeated presses) with an
 *   `Idempotency-Key` that is kept for retries of the same attempt. Losing the race to another tab
 *   (`SETUP_COMPLETE`), a replayed completed setup (`OPERATION_COMPLETED_REAUTH_REQUIRED`) or an
 *   uncertain outcome that `/auth/setup-status` shows as initialized all lead to Sign in.
 * - Sign in returns to a sanitized `returnTo` (allowlisted app paths only).
 * - Registration follows the instance policy: PUBLIC (no invite code; never sent), INVITE_ONLY
 *   (invite code required) and SINGLE_ADMIN (closed: explanation + Sign in, no doomed form).
 *   An uncertain register outcome asks the user to check the status (sign in) before retrying.
 * - Validation uses the shared request schemas (same password policy as the server: 12–128
 *   characters), shows per-field errors plus a focused summary whose links move to the fields,
 *   and maps server `details` the same way. Non-secret inputs (instance name, name, email,
 *   invite code) are always kept; the password is cleared only after rejected credentials.
 *   Nothing is written to browser storage, paste and password managers work (autocomplete hints),
 *   and there is no password reset feature.
 * States per mode: loading (status check / submitting), empty (instructions, or registration
 * closed), ideal (signed in → navigate), partial (race, invite/email conflict, wrong credentials)
 * and error (network/service: entries kept, retry possible).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ZodType } from "zod";
import { ERROR_CODES, type ErrorCode } from "@kabuki-neko/shared/errors";
import { TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";
import {
  authResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
  setupRequestSchema,
  setupStatusSchema,
} from "@kabuki-neko/shared/schemas/auth.schema";
import { instanceNameSchema } from "@kabuki-neko/shared/schemas/system.schema";
import type { z } from "zod";
import { ActionButton } from "@/components/ui/action-button";
import { FormField } from "@/components/ui/form-field";
import { ApiError, apiErrorMessageKey } from "@/lib/api-client";
import { safeReturnTo, useAuth } from "@/providers/auth-provider";
import { useLocale, type LocaleContextValue } from "@/providers/locale-provider";

/** Which form to show. */
export type AuthMode = "setup" | "login" | "register";
/** `/auth/setup-status` response. */
export type SetupStatus = z.infer<typeof setupStatusSchema>;
/** Load state of the setup status. */
export type SetupStatusState =
  { status: "loading" } | { status: "ready"; data: SetupStatus } | { status: "error" };

/** Field errors keyed by field name (message keys). */
export type FieldErrors = Partial<Record<string, string>>;

/** Known server error codes. */
const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Message key for a client (zod) or server issue code. */
export function issueMessageKey(code: string): string {
  if (KNOWN_CODES.has(code)) return apiErrorMessageKey(code as ErrorCode);
  switch (code) {
    case "too_small":
      return "validation.errors.outOfRange";
    case "too_big":
      return "validation.errors.tooLong";
    default:
      return "validation.errors.invalidFormat";
  }
}

/**
 * Validates `values` against a shared request schema and returns message keys per field.
 * Empty required fields report "required" first.
 */
export function validateFields(
  schema: ZodType,
  values: Record<string, string>,
  required: readonly string[],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of required)
    if ((values[field] ?? "").trim() === "") errors[field] = "validation.errors.required";
  const result = schema.safeParse(values);
  if (!result.success)
    for (const issue of result.error.issues) {
      const field = String(issue.path[0] ?? "");
      if (!field || errors[field]) continue;
      errors[field] = issueMessageKey(issue.code === "custom" ? issue.message : issue.code);
    }
  return errors;
}

/** Field errors from a server error's `details` (`path` = field name). */
export function serverFieldErrors(error: ApiError, fields: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.details) {
    const field = issue.path.split(".")[0] ?? "";
    if (fields.includes(field) && !errors[field]) errors[field] = issueMessageKey(issue.code);
  }
  return errors;
}

/** Loads `/auth/setup-status` (with retry). */
export function useSetupStatus() {
  const { api } = useAuth();
  const [state, setState] = useState<SetupStatusState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api
      .request({ path: "/auth/setup-status", schema: setupStatusSchema, signal: controller.signal })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted) setState({ status: "ready", data });
        },
        () => {
          if (!controller.signal.aborted) setState({ status: "error" });
        },
      );
    return () => controller.abort();
  }, [api, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
}

/** New idempotency key (UUID v4). */
function newKey(): string {
  return crypto.randomUUID();
}

/** Form-level outcome message. */
type Notice = {
  tone: "error" | "warning";
  text: string;
  signIn?: boolean;
  setupLink?: boolean;
} | null;

/** Error summary: focused on failed submit; each entry moves focus to its field. */
function ErrorSummary({
  errors,
  labels,
  ids,
  summaryRef,
}: {
  errors: FieldErrors;
  labels: Record<string, string>;
  ids: Record<string, string>;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useLocale();
  const entries = Object.entries(errors).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) return null;
  return (
    <div
      ref={summaryRef}
      tabIndex={-1}
      role="alert"
      aria-labelledby={`${ids.form}-summary`}
      className="flex flex-col gap-2 rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
    >
      <p id={`${ids.form}-summary`} className="font-semibold">
        {t("auth.inventory.f01.error")}
      </p>
      <ul className="list-disc ps-5">
        {entries.map(([field, key]) => (
          <li key={field}>
            <a
              href={`#${ids[field]}`}
              className="underline"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(ids[field] ?? "")?.focus();
              }}
            >
              {`${labels[field] ?? field}: ${t(key)}`}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Form-level notice with optional Sign in / Set up links. */
function FormNotice({ notice }: { notice: Notice }) {
  const { t } = useLocale();
  if (!notice) return null;
  return (
    <div
      role="alert"
      className={`flex flex-col gap-2 rounded-md border p-3 text-small ${
        notice.tone === "error"
          ? "border-danger bg-danger-surface text-danger"
          : "border-warning bg-warning-surface text-warning"
      }`}
    >
      <p>{notice.text}</p>
      {notice.signIn && (
        <Link
          href="/login"
          className="inline-flex min-h-11 items-center self-start text-label font-semibold underline"
        >
          {t("auth.login.submit")}
        </Link>
      )}
      {notice.setupLink && (
        <Link
          href="/setup"
          className="inline-flex min-h-11 items-center self-start text-label font-semibold underline"
        >
          {t("auth.setup.title")}
        </Link>
      )}
    </div>
  );
}

/**
 * Focus request for the error summary: focusing happens in an effect right after the summary is
 * committed (not in a later animation frame that could steal focus from the user's next field).
 */
function useSummaryFocus() {
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tick > 0) summaryRef.current?.focus();
  }, [tick]);
  const focusSummary = useCallback(() => setTick((n) => n + 1), []);
  return { summaryRef, focusSummary };
}

/** Ids for every field of a form plus the form itself. */
function useFieldIds<F extends string>(fields: readonly F[]): Record<F | "form", string> {
  const base = useId();
  const ids = { form: `${base}form` } as Record<F | "form", string>;
  for (const field of fields) ids[field] = `${base}${field}`;
  return ids;
}

/** Message for a failed request that is not a field error. */
function requestFailureText(t: LocaleContextValue["t"], error: unknown): string {
  if (error instanceof ApiError && error.code === "RATE_LIMITED")
    return t("validation.errors.rateLimited", { retryAfterMs: error.retryAfterMs ?? 0 });
  if (error instanceof ApiError && !error.uncertain && error.code !== "INTERNAL_ERROR")
    return t(apiErrorMessageKey(error.code));
  return "";
}

/** Shared props of the three forms. */
interface FormProps {
  status: SetupStatusState;
  returnTo: string | null;
  onAuthenticated: (destination: string) => void;
}

/** S03 sign in. */
function LoginForm({ status, returnTo, onAuthenticated }: FormProps) {
  const { t } = useLocale();
  const { api, acceptSession } = useAuth();
  const fields = ["email", "password"] as const;
  const ids = useFieldIds(fields);
  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const { summaryRef, focusSummary } = useSummaryFocus();
  const labels = { email: t("auth.fields.email"), password: t("auth.fields.password") };

  /** Validates, signs in and hands over the session. */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found = validateFields(loginRequestSchema, values, fields);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) {
      focusSummary();
      return;
    }
    setPending(true);
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/auth/login",
        body: loginRequestSchema.parse(values),
        schema: authResponseSchema,
      });
      acceptSession(data);
      setDone(true);
      onAuthenticated(safeReturnTo(returnTo));
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS") {
        // Rejected credentials: keep the email, clear the secret.
        setValues((current) => ({ ...current, password: "" }));
        setNotice({ tone: "warning", text: t("auth.login.invalidCredentials") });
      } else if (error instanceof ApiError && error.code === "SETUP_REQUIRED")
        setNotice({ tone: "warning", text: t("auth.recovery.setupRequired"), setupLink: true });
      else
        setNotice({
          tone: "error",
          text: requestFailureText(t, error) || t("auth.inventory.s03.error"),
        });
    } finally {
      setPending(false);
    }
  };

  const notInitialized = status.status === "ready" && !status.data.isInitialized;
  const canRegister =
    status.status === "ready" &&
    status.data.isInitialized &&
    status.data.registrationMode !== "SINGLE_ADMIN";

  return (
    <form
      id={ids.form}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <h1 className="text-title font-bold break-words">{t("auth.login.title")}</h1>
      <p className="text-small text-muted-foreground">{t("auth.inventory.s03.empty")}</p>
      {notInitialized && (
        <FormNotice
          notice={{ tone: "warning", text: t("auth.recovery.setupRequired"), setupLink: true }}
        />
      )}
      <ErrorSummary errors={errors} labels={labels} ids={ids} summaryRef={summaryRef} />
      <FormNotice notice={notice} />
      <FormField
        id={ids.email}
        name="email"
        kind="email"
        label={labels.email}
        required
        autoComplete="username"
        value={values.email}
        onChange={(email) => setValues((current) => ({ ...current, email }))}
        error={errors.email ? t(errors.email) : undefined}
      />
      <FormField
        id={ids.password}
        name="password"
        kind="password"
        label={labels.password}
        required
        autoComplete="current-password"
        value={values.password}
        onChange={(password) => setValues((current) => ({ ...current, password }))}
        error={errors.password ? t(errors.password) : undefined}
      />
      <ActionButton type="submit" size="lg" pending={pending} label={t("auth.login.submit")} />
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {pending ? t("auth.inventory.s03.loading") : done ? t("auth.inventory.s03.ideal") : ""}
      </p>
      {canRegister && (
        <Link
          href="/register"
          className="inline-flex min-h-11 items-center self-start text-label text-primary-text underline"
        >
          {t("auth.login.registrationLink")}
        </Link>
      )}
    </form>
  );
}

/** S04 registration (policy-aware). */
function RegisterForm({ status, returnTo, onAuthenticated }: FormProps) {
  const { t } = useLocale();
  const { api, acceptSession } = useAuth();
  const mode = status.status === "ready" ? status.data.registrationMode : null;
  const inviteOnly = mode === "INVITE_ONLY";
  const fields = inviteOnly
    ? (["name", "email", "password", "inviteCode"] as const)
    : (["name", "email", "password"] as const);
  const ids = useFieldIds(["name", "email", "password", "inviteCode"]);
  const [values, setValues] = useState({ name: "", email: "", password: "", inviteCode: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const [closed, setClosed] = useState(false);
  const [done, setDone] = useState(false);
  const keyRef = useRef(newKey());
  const { summaryRef, focusSummary } = useSummaryFocus();
  const labels = {
    name: t("auth.fields.name"),
    email: t("auth.fields.email"),
    password: t("auth.fields.password"),
    inviteCode: t("auth.fields.inviteCode"),
  };

  /** Updates one field; values live only in component state (never in storage). */
  const set = (field: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  /** Validates, registers and hands over the session. */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const body = inviteOnly
      ? {
          name: values.name,
          email: values.email,
          password: values.password,
          inviteCode: values.inviteCode.trim(),
        }
      : { name: values.name, email: values.email, password: values.password };
    const found = validateFields(registerRequestSchema, body, fields);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) {
      focusSummary();
      return;
    }
    setPending(true);
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/auth/register",
        body: registerRequestSchema.parse(body),
        schema: authResponseSchema,
        idempotencyKey: keyRef.current,
      });
      acceptSession(data);
      setDone(true);
      onAuthenticated(safeReturnTo(returnTo));
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.uncertain || !apiError) {
        // Unknown outcome: keep the key so a retry cannot create a second account.
        setNotice({ tone: "error", text: t("auth.recovery.uncertainRequest"), signIn: true });
        return;
      }
      keyRef.current = newKey();
      switch (apiError.code) {
        case "REGISTRATION_CLOSED":
          setClosed(true);
          break;
        case "SETUP_REQUIRED":
          setNotice({ tone: "warning", text: t("auth.recovery.setupRequired"), setupLink: true });
          break;
        case "OPERATION_COMPLETED_REAUTH_REQUIRED":
          setNotice({
            tone: "warning",
            text: t("validation.errors.operationCompletedReauthRequired"),
            signIn: true,
          });
          break;
        case "EMAIL_EXISTS":
          setErrors({ email: "validation.errors.emailExists" });
          setNotice({ tone: "warning", text: t("auth.inventory.s04.partial") });
          break;
        case "INVITE_UNAVAILABLE":
          setErrors({ inviteCode: "validation.errors.inviteUnavailable" });
          setNotice({ tone: "warning", text: t("auth.inventory.s04.partial") });
          break;
        default: {
          const fieldErrors = serverFieldErrors(apiError, fields);
          if (Object.keys(fieldErrors).length > 0) {
            setErrors(fieldErrors);
            focusSummary();
          } else
            setNotice({
              tone: "error",
              text: requestFailureText(t, apiError) || t("auth.inventory.s04.error"),
            });
        }
      }
    } finally {
      setPending(false);
    }
  };

  if (status.status === "loading")
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("auth.inventory.s04.loading")}
      </p>
    );
  if (status.status === "ready" && !status.data.isInitialized)
    return (
      <FormNotice
        notice={{ tone: "warning", text: t("auth.recovery.setupRequired"), setupLink: true }}
      />
    );
  if (closed || mode === "SINGLE_ADMIN")
    return (
      <section aria-labelledby={`${ids.form}-title`} className="flex flex-col gap-4">
        <h1 id={`${ids.form}-title`} className="text-title font-bold break-words">
          {t("auth.register.title")}
        </h1>
        <p role="status">{t("auth.inventory.s04.empty")}</p>
        <Link
          href="/login"
          className="inline-flex min-h-12 items-center justify-center self-start rounded-md bg-primary px-6 text-label font-semibold text-primary-foreground"
        >
          {t("auth.login.submit")}
        </Link>
      </section>
    );

  return (
    <form
      id={ids.form}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <h1 className="text-title font-bold break-words">{t("auth.register.title")}</h1>
      {inviteOnly && (
        <p className="text-small text-muted-foreground">{t("auth.register.invitationRequired")}</p>
      )}
      <ErrorSummary errors={errors} labels={labels} ids={ids} summaryRef={summaryRef} />
      <FormNotice notice={notice} />
      <FormField
        id={ids.name}
        name="name"
        label={labels.name}
        required
        autoComplete="name"
        limit={TEXT_LIMITS.name}
        value={values.name}
        onChange={set("name")}
        error={errors.name ? t(errors.name) : undefined}
      />
      <FormField
        id={ids.email}
        name="email"
        kind="email"
        label={labels.email}
        required
        autoComplete="email"
        value={values.email}
        onChange={set("email")}
        error={errors.email ? t(errors.email) : undefined}
      />
      <PasswordField
        id={ids.password}
        label={labels.password}
        value={values.password}
        onChange={set("password")}
        errorKey={errors.password}
      />
      {inviteOnly && (
        <FormField
          id={ids.inviteCode}
          name="inviteCode"
          label={labels.inviteCode}
          required
          autoComplete="one-time-code"
          value={values.inviteCode}
          onChange={set("inviteCode")}
          error={errors.inviteCode ? t(errors.inviteCode) : undefined}
        />
      )}
      <ActionButton type="submit" size="lg" pending={pending} label={t("auth.register.submit")} />
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {pending ? t("auth.inventory.f01.loading") : done ? t("auth.inventory.s04.ideal") : ""}
      </p>
      <Link
        href="/login"
        className="inline-flex min-h-11 items-center self-start text-label text-primary-text underline"
      >
        {t("auth.register.signInLink")}
      </Link>
    </form>
  );
}

/** New-password field showing the shared policy range (12–128) with a live counter; length errors repeat the range. */
function PasswordField({
  id,
  label,
  value,
  onChange,
  errorKey,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  errorKey: string | undefined;
}) {
  const { t, formatNumber } = useLocale();
  const range = `${formatNumber(TEXT_LIMITS.passwordMinCodePoints)}–${formatNumber(TEXT_LIMITS.passwordMaxCodePoints)}`;
  return (
    <FormField
      id={id}
      name="password"
      kind="password"
      label={label}
      required
      autoComplete="new-password"
      help={<bdi>{range}</bdi>}
      limit={TEXT_LIMITS.passwordMaxCodePoints}
      value={value}
      onChange={onChange}
      error={
        errorKey
          ? errorKey === "validation.errors.outOfRange"
            ? `${t(errorKey)} (${range})`
            : t(errorKey)
          : undefined
      }
    />
  );
}

/** S02 two-step setup (one request at the end). */
function SetupForm({
  status,
  returnTo,
  onAuthenticated,
  onStepChange,
}: FormProps & { onStepChange?: (step: 1 | 2) => void }) {
  const { t, formatNumber } = useLocale();
  const { api, acceptSession } = useAuth();
  const ids = useFieldIds(["instanceName", "name", "email", "password"]);
  const [step, setStep] = useState<1 | 2>(1);
  const [values, setValues] = useState({ instanceName: "", name: "", email: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const [raced, setRaced] = useState(false);
  const [done, setDone] = useState(false);
  const keyRef = useRef(newKey());
  const { summaryRef, focusSummary } = useSummaryFocus();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const labels = {
    instanceName: t("auth.fields.instanceName"),
    name: t("auth.fields.name"),
    email: t("auth.fields.email"),
    password: t("auth.fields.password"),
  };
  /** Updates one field; values live only in component state (never in storage). */
  const set = (field: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const stepMoved = useRef(false);
  // After a step change, focus the new step heading (not on the first render).
  useEffect(() => {
    if (stepMoved.current) headingRef.current?.focus();
  }, [step]);

  /** Moves between the local steps (focus goes to the step heading). */
  const goTo = (next: 1 | 2) => {
    stepMoved.current = true;
    setStep(next);
    setErrors({});
    onStepChange?.(next);
  };

  /** Step 1 → 2 after validating the instance name only. */
  const next = (event: FormEvent) => {
    event.preventDefault();
    const found = validateInstanceName(values.instanceName);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusSummary();
      return;
    }
    goTo(2);
  };

  /** Final step: one setup request; uncertain outcomes are reconciled through setup-status. */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found = validateFields(setupRequestSchema, values, [
      "instanceName",
      "name",
      "email",
      "password",
    ]);
    setErrors(found);
    setNotice(null);
    if (Object.keys(found).length > 0) {
      if (found.instanceName) goTo(1);
      focusSummary();
      return;
    }
    setPending(true);
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/auth/setup",
        body: setupRequestSchema.parse(values),
        schema: authResponseSchema,
        idempotencyKey: keyRef.current,
      });
      acceptSession(data);
      setDone(true);
      onAuthenticated(safeReturnTo(returnTo));
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (!apiError || apiError.uncertain) {
        // Did it land? Ask the status instead of sending again.
        const initialized = await api
          .request({ path: "/auth/setup-status", schema: setupStatusSchema })
          .then(
            ({ data }) => data.isInitialized,
            () => null,
          );
        if (initialized) setRaced(true);
        else setNotice({ tone: "error", text: t("auth.inventory.s02.error") });
        return;
      }
      keyRef.current = newKey();
      if (
        apiError.code === "SETUP_COMPLETE" ||
        apiError.code === "OPERATION_COMPLETED_REAUTH_REQUIRED"
      )
        setRaced(true);
      else if (apiError.code === "EMAIL_EXISTS")
        setErrors({ email: "validation.errors.emailExists" });
      else {
        const fieldErrors = serverFieldErrors(apiError, [
          "instanceName",
          "name",
          "email",
          "password",
        ]);
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          if (fieldErrors.instanceName) goTo(1);
          focusSummary();
        } else
          setNotice({
            tone: "error",
            text: requestFailureText(t, apiError) || t("auth.inventory.s02.error"),
          });
      }
    } finally {
      setPending(false);
    }
  };

  if (status.status === "loading")
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("auth.inventory.s02.loading")}
      </p>
    );
  if (raced || (status.status === "ready" && status.data.isInitialized))
    return (
      <section aria-labelledby={`${ids.form}-title`} className="flex flex-col gap-4">
        <h1 id={`${ids.form}-title`} className="text-title font-bold break-words">
          {t("auth.setup.title")}
        </h1>
        <p role="status">
          {raced ? t("auth.inventory.s02.partial") : t("auth.setup.alreadyInitialized")}
        </p>
        <Link
          href="/login"
          className="inline-flex min-h-12 items-center justify-center self-start rounded-md bg-primary px-6 text-label font-semibold text-primary-foreground"
        >
          {t("auth.login.submit")}
        </Link>
      </section>
    );

  const stepLabel = `${formatNumber(step)} / ${formatNumber(2)}`;
  return (
    <form
      id={ids.form}
      noValidate
      onSubmit={(event) => (step === 1 ? next(event) : void submit(event))}
      className="flex flex-col gap-4"
    >
      <h1 className="text-title font-bold break-words">{t("auth.setup.title")}</h1>
      <p className="text-small text-muted-foreground">{t("auth.setup.introduction")}</p>
      <ol className="flex flex-wrap gap-2 text-small" aria-label={t("auth.inventory.s02.ideal")}>
        {([1, 2] as const).map((n) => (
          <li
            key={n}
            aria-current={step === n ? "step" : undefined}
            className={`rounded-pill border px-3 py-1 ${step === n ? "border-primary font-semibold" : "border-border text-muted-foreground"}`}
          >
            {`${formatNumber(n)}. ${n === 1 ? t("auth.setup.instanceStep") : t("auth.setup.accountStep")}`}
          </li>
        ))}
      </ol>
      <h2 ref={headingRef} tabIndex={-1} className="text-title-sm font-semibold outline-none">
        <span className="me-2 tabular-nums text-muted-foreground">{stepLabel}</span>
        {step === 1 ? t("auth.setup.instanceStep") : t("auth.setup.accountStep")}
      </h2>
      <ErrorSummary errors={errors} labels={labels} ids={ids} summaryRef={summaryRef} />
      <FormNotice notice={notice} />
      {step === 1 ? (
        <FormField
          id={ids.instanceName}
          name="instanceName"
          label={labels.instanceName}
          required
          autoComplete="organization"
          limit={TEXT_LIMITS.instanceName}
          value={values.instanceName}
          onChange={set("instanceName")}
          error={errors.instanceName ? t(errors.instanceName) : undefined}
        />
      ) : (
        <>
          <FormField
            id={ids.name}
            name="name"
            label={labels.name}
            required
            autoComplete="name"
            limit={TEXT_LIMITS.name}
            value={values.name}
            onChange={set("name")}
            error={errors.name ? t(errors.name) : undefined}
          />
          <FormField
            id={ids.email}
            name="email"
            kind="email"
            label={labels.email}
            required
            autoComplete="email"
            value={values.email}
            onChange={set("email")}
            error={errors.email ? t(errors.email) : undefined}
          />
          <PasswordField
            id={ids.password}
            label={labels.password}
            value={values.password}
            onChange={set("password")}
            errorKey={errors.password}
          />
        </>
      )}
      <div className="flex flex-wrap gap-3">
        {step === 2 && (
          <ActionButton
            variant="secondary"
            size="lg"
            label={t("common.actions.back")}
            onPress={() => goTo(1)}
          />
        )}
        <ActionButton
          type="submit"
          size="lg"
          pending={pending}
          label={step === 1 ? t("common.actions.continue") : t("auth.setup.submit")}
        />
      </div>
      <p role="status" aria-live="polite" className="text-small empty:hidden">
        {pending ? t("auth.inventory.f01.loading") : done ? t("auth.setup.success") : ""}
      </p>
    </form>
  );
}

/** Instance-name check for step 1 (shared schema). */
function validateInstanceName(value: string): FieldErrors {
  if (value.trim() === "") return { instanceName: "validation.errors.required" };
  const result = instanceNameSchema.safeParse(value);
  if (result.success) return {};
  const issue = result.error.issues[0];
  return {
    instanceName: issueMessageKey(issue?.code === "custom" ? issue.message : (issue?.code ?? "")),
  };
}

/** Props of {@link PublicAuthForms}. */
export interface PublicAuthFormsProps {
  mode: AuthMode;
  /** Requested destination after signing in (sanitized; unsafe values → dashboard). */
  returnTo?: string | null;
  /** Navigation after success; defaults to replacing the URL with the destination. */
  onAuthenticated?: (destination: string) => void;
  /** Setup step changes (1 = instance, 2 = administrator). */
  onStepChange?: (step: 1 | 2) => void;
}

/** F01: the setup, sign-in or registration form for `mode`. */
export function PublicAuthForms({
  mode,
  returnTo = null,
  onAuthenticated,
  onStepChange,
}: PublicAuthFormsProps) {
  const { t, ensureNamespaces } = useLocale();
  const router = useRouter();
  const { state, retry } = useSetupStatus();
  const navigate = useCallback(
    (destination: string) =>
      onAuthenticated ? onAuthenticated(destination) : router.replace(destination),
    [onAuthenticated, router],
  );

  useEffect(() => {
    void ensureNamespaces(["auth", "validation"]);
  }, [ensureNamespaces]);

  const props: FormProps = { status: state, returnTo, onAuthenticated: navigate };
  let body: ReactNode;
  if (mode === "login") body = <LoginForm {...props} />;
  else if (mode === "register") body = <RegisterForm {...props} />;
  else body = <SetupForm {...props} {...(onStepChange ? { onStepChange } : {})} />;

  return (
    <div
      className={`mx-auto flex w-full flex-col gap-4 ${mode === "setup" ? "max-w-[560px]" : "max-w-[440px]"}`}
    >
      {state.status === "error" && mode !== "login" && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-danger bg-danger-surface p-3 text-small text-danger"
        >
          <p>{t("common.inventory.s01.error")}</p>
          <ActionButton variant="secondary" label={t("common.actions.retry")} onPress={retry} />
        </div>
      )}
      {state.status === "error" && mode !== "login" ? null : body}
    </div>
  );
}
