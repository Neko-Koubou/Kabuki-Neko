/**
 * TASK-134 coverage for F01 against a scripted fake API: the five states of each mode (setup,
 * sign in, registration), registration policy (SINGLE_ADMIN closed, PUBLIC without invite code,
 * INVITE_ONLY with a required code and a used-code conflict), the setup race and uncertain
 * outcomes reconciled through setup-status, a single setup request after two local steps, safe
 * returnTo, field + summary errors with the shared password policy, kept non-secret inputs,
 * password-manager autocomplete hints and paste, idempotency keys reused only for uncertain
 * retries, and no browser storage writes.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import {
  PublicAuthForms,
  issueMessageKey,
  validateFields,
  type AuthMode,
} from "./public-auth-forms";
import { loginRequestSchema } from "@kabuki-neko/shared/schemas/auth.schema";

vi.mock("next/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const NAMESPACES = ["common", "accessibility", "auth", "validation"] as const;
const USER = {
  id: "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f",
  email: "ayu@example.com",
  name: "Ayu",
  role: "CREATOR",
  avatar: { style: "bottts", seed: "ayu" },
  isActive: true,
  revision: 1,
  createdAt: 1,
};
const PASSWORD = "correct horse battery";
const INVITE = "A".repeat(43);

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
/** Error envelope response. */
function failure(status: number, errorCode: string, details: unknown[] = []) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params: {},
    details,
    correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
  });
}
/** Successful auth response. */
const signedIn = () => json(200, { user: USER, accessToken: "access-1", expiresIn: 900 });

/** One recorded request. */
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}

/** Scripted fake API: queued responses per `METHOD /path`, then setup-status defaults. */
function fakeServer(status: { isInitialized?: boolean; registrationMode?: string } | "fail" = {}) {
  const calls: Call[] = [];
  const queues = new Map<string, (() => Response | Promise<Response>)[]>();
  let current = status;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      headers: new Headers(init?.headers),
    });
    const next = queues.get(`${method} ${path}`)?.shift();
    if (next) return next();
    if (path === "/auth/setup-status")
      return current === "fail"
        ? failure(503, "DEPENDENCY_UNAVAILABLE")
        : json(200, {
            isInitialized: current.isInitialized ?? true,
            registrationMode: current.registrationMode ?? "INVITE_ONLY",
            instanceName: "Contoh",
            license: "Apache-2.0-with-Commons-Clause",
            defaultLocale: "en",
          });
    return failure(404, "NOT_FOUND");
  });
  return {
    fetchMock,
    calls,
    posts: (path: string) => calls.filter((call) => call.method === "POST" && call.path === path),
    respond(key: string, ...responses: (() => Response | Promise<Response>)[]) {
      queues.set(key, [...(queues.get(key) ?? []), ...responses]);
    },
    setStatus(next: typeof status) {
      current = next;
    },
  };
}

/** Renders the forms with the root providers. */
function renderForms(
  mode: AuthMode,
  server: ReturnType<typeof fakeServer>,
  props: { returnTo?: string } = {},
) {
  const onAuthenticated = vi.fn();
  const onStepChange = vi.fn();
  renderWithLocale(
    <ThemeProvider store={createThemePreferenceStore({ storage: () => null })}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={server.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        <PublicAuthForms
          mode={mode}
          returnTo={props.returnTo ?? null}
          onAuthenticated={onAuthenticated}
          onStepChange={onStepChange}
        />
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
  return { onAuthenticated, onStepChange };
}

/** Deferred response helper. */
function deferred() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("sign in", () => {
  it("signs in with password-manager hints and paste, then returns to a safe path", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ registrationMode: "INVITE_ONLY" });
    const pending = deferred();
    server.respond("POST /auth/login", () => pending.promise);
    const { onAuthenticated } = renderForms("login", server, { returnTo: "/dashboard/reports/7" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to Kabuki Neko");
    expect(screen.getByText("Enter your email and password to sign in.")).toBeInTheDocument();
    const email = screen.getByLabelText(/^Email/u);
    const password = screen.getByLabelText(/^Password/u);
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(email);
    await user.paste("ayu@example.com");
    await user.click(password);
    await user.paste(PASSWORD);
    expect(email).toHaveValue("ayu@example.com");
    expect(password).toHaveValue(PASSWORD);
    expect(
      await screen.findByRole("link", { name: "Don't have an account? Create one" }),
    ).toHaveAttribute("href", "/register");

    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    expect(screen.getByText("Signing in…")).toBeInTheDocument();
    // Pending: a second press sends nothing.
    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    expect(server.posts("/auth/login")).toHaveLength(1);
    await act(async () => pending.resolve(signedIn()));
    expect(onAuthenticated).toHaveBeenCalledWith("/dashboard/reports/7");
    expect(screen.getByText("You're signed in.")).toBeInTheDocument();
    expect(server.posts("/auth/login")[0]?.body).toEqual({
      email: "ayu@example.com",
      password: PASSWORD,
    });
    // No idempotency key on login and nothing in browser storage.
    expect(server.posts("/auth/login")[0]?.headers.get("Idempotency-Key")).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("falls back to the dashboard for unsafe returnTo values", async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    server.respond("POST /auth/login", signedIn);
    const { onAuthenticated } = renderForms("login", server, { returnTo: "https://evil.example/" });
    await user.type(screen.getByLabelText(/^Email/u), "ayu@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("/dashboard"));
  });

  it("shows a focused summary for invalid fields, clears only the password on rejected credentials and keeps entries on network errors", async () => {
    const user = userEvent.setup();
    const server = fakeServer();
    server.respond(
      "POST /auth/login",
      () => failure(401, "INVALID_CREDENTIALS"),
      () => {
        throw new TypeError("Failed to fetch");
      },
    );
    renderForms("login", server);
    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Please fix the highlighted fields and try again.");
    await waitFor(() => expect(summary).toHaveFocus());
    const links = within(summary).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Email: This field is required.",
      "Password: This field is required.",
    ]);
    await user.click(links[1] as HTMLElement);
    expect(screen.getByLabelText(/^Password/u)).toHaveFocus();
    expect(screen.getByLabelText(/^Email/u)).toHaveAttribute("aria-invalid", "true");
    expect(server.posts("/auth/login")).toHaveLength(0);

    await user.type(screen.getByLabelText(/^Email/u), "ayu@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    expect(await screen.findByText("The email or password is incorrect.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/u)).toHaveValue("ayu@example.com");
    expect(screen.getByLabelText(/^Password/u)).toHaveValue("");

    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Sign in/u }));
    expect(await screen.findByText("Couldn't sign in. Please try again.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/u)).toHaveValue("ayu@example.com");
    expect(screen.getByLabelText(/^Password/u)).toHaveValue(PASSWORD);
  });

  it("points to setup when the instance is not initialized", async () => {
    renderForms("login", fakeServer({ isInitialized: false }));
    expect(await screen.findByText("This instance hasn't been set up yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up your instance" })).toHaveAttribute(
      "href",
      "/setup",
    );
    expect(screen.queryByRole("link", { name: /Create one/u })).not.toBeInTheDocument();
  });
});

describe("registration", () => {
  it("shows the loading state, then the closed state for single-admin instances", async () => {
    const server = fakeServer({ registrationMode: "SINGLE_ADMIN" });
    const gate = deferred();
    server.respond("GET /auth/setup-status", () => gate.promise);
    renderForms("register", server);
    expect(screen.getByRole("status")).toHaveTextContent("Checking registration settings…");
    await act(async () =>
      gate.resolve(
        json(200, {
          isInitialized: true,
          registrationMode: "SINGLE_ADMIN",
          instanceName: "Contoh",
          license: "Apache-2.0-with-Commons-Clause",
          defaultLocale: "en",
        }),
      ),
    );
    expect(
      screen.getByText(
        "Registration is closed on this instance. Sign in if you already have an account.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("requires an invite code on INVITE_ONLY, keeps entries when the code is used and succeeds with a new key", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ registrationMode: "INVITE_ONLY" });
    server.respond("POST /auth/register", () => failure(409, "INVITE_UNAVAILABLE"), signedIn);
    const { onAuthenticated } = renderForms("register", server, { returnTo: "/dashboard/quizzes" });
    const invite = await screen.findByLabelText(/^Invite code/u);
    expect(
      screen.getByText("An invite code is required to create an account."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/u)).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText(/^Email/u)).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText(/^Password/u)).toHaveAttribute("autocomplete", "new-password");
    expect(invite).toHaveAttribute("autocomplete", "one-time-code");

    await user.type(screen.getByLabelText(/^Name/u), "Ayu");
    await user.type(screen.getByLabelText(/^Email/u), "ayu@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Invite code: This field is required.");
    expect(server.posts("/auth/register")).toHaveLength(0);

    await user.click(invite);
    await user.paste(` ${INVITE} `);
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    expect(
      await screen.findByText("Check the invite code or email address and try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Invite code/u)).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getAllByText(/This invite code is invalid, expired or already used\./u).length,
    ).toBeGreaterThan(0);
    // Non-secret entries are kept.
    expect(screen.getByLabelText(/^Name/u)).toHaveValue("Ayu");
    expect(screen.getByLabelText(/^Email/u)).toHaveValue("ayu@example.com");

    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("/dashboard/quizzes"));
    const [first, second] = server.posts("/auth/register");
    expect(first?.body).toEqual({
      name: "Ayu",
      email: "ayu@example.com",
      password: PASSWORD,
      inviteCode: INVITE,
    });
    const firstKey = first?.headers.get("Idempotency-Key") ?? "";
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/u);
    // A definitive failure starts a new attempt.
    expect(second?.headers.get("Idempotency-Key")).not.toBe(firstKey);
  });

  it("never sends an invite code on PUBLIC and reuses the key after an uncertain outcome", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ registrationMode: "PUBLIC" });
    server.respond(
      "POST /auth/register",
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => failure(409, "OPERATION_COMPLETED_REAUTH_REQUIRED"),
    );
    renderForms("register", server);
    await screen.findByLabelText(/^Name/u);
    expect(screen.queryByLabelText(/^Invite code/u)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/u), "Ayu");
    await user.type(screen.getByLabelText(/^Email/u), "ayu@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    const uncertain = await screen.findByRole("alert");
    expect(uncertain).toHaveTextContent(
      "We couldn't confirm whether your last request went through. Check the current status before trying again.",
    );
    expect(within(uncertain).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    expect(
      await screen.findByText("This was already completed. Please sign in to continue."),
    ).toBeInTheDocument();
    const [first, second] = server.posts("/auth/register");
    expect(first?.body).not.toHaveProperty("inviteCode");
    expect(second?.headers.get("Idempotency-Key")).toBe(first?.headers.get("Idempotency-Key"));
  });

  it("applies the shared password policy and maps server field details", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ registrationMode: "PUBLIC" });
    server.respond("POST /auth/register", () =>
      failure(422, "VALIDATION_FAILED", [
        { path: "email", code: "INVALID_FORMAT", params: {}, severity: "error" },
      ]),
    );
    renderForms("register", server);
    await user.type(await screen.findByLabelText(/^Name/u), "Ayu");
    await user.type(screen.getByLabelText(/^Email/u), "ayu@example.com");
    await user.type(screen.getByLabelText(/^Password/u), "short");
    expect(screen.getByText("12–128")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    expect(
      await screen.findByText("This value is outside the allowed range. (12–128)"),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Password/u));
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Create account/u }));
    expect(
      await screen.findByText("Email: This value isn't in the expected format."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/u)).toHaveAttribute("aria-invalid", "true");
  });
});

describe("setup", () => {
  it("collects two local steps and sends one request at the end", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ isInitialized: false, registrationMode: "SINGLE_ADMIN" });
    const pending = deferred();
    server.respond("POST /auth/setup", () => pending.promise);
    const { onAuthenticated, onStepChange } = renderForms("setup", server);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Set up your instance",
    );
    expect(screen.getByText(/Welcome! Name your instance/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Instance name: This field is required.",
    );
    const instance = screen.getByLabelText(/^Instance name/u);
    expect(instance).toHaveAttribute("autocomplete", "organization");
    await user.type(instance, "SMA Negeri 1 Contoh");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onStepChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByRole("heading", { level: 2 })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Administrator account");
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "2. Administrator account",
    );
    await user.type(screen.getByLabelText(/^Name/u), "Admin");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText(/^Instance name/u)).toHaveValue("SMA Negeri 1 Contoh");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText(/^Name/u)).toHaveValue("Admin");
    await user.type(screen.getByLabelText(/^Email/u), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    expect(server.posts("/auth/setup")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /^Finish setup/u }));
    await user.click(screen.getByRole("button", { name: /^Finish setup/u }));
    expect(screen.getByText("Please wait…")).toBeInTheDocument();
    await act(async () =>
      pending.resolve(
        json(201, { user: { ...USER, role: "SUPERADMIN" }, accessToken: "a", expiresIn: 900 }),
      ),
    );
    expect(server.posts("/auth/setup")).toHaveLength(1);
    expect(server.posts("/auth/setup")[0]?.body).toEqual({
      instanceName: "SMA Negeri 1 Contoh",
      name: "Admin",
      email: "admin@example.com",
      password: PASSWORD,
    });
    expect(server.posts("/auth/setup")[0]?.headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(onAuthenticated).toHaveBeenCalledWith("/dashboard");
    expect(
      screen.getByText("Setup complete. You're signed in as the administrator."),
    ).toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("turns a lost race into Sign in and reconciles uncertain outcomes through setup-status", async () => {
    const user = userEvent.setup();
    const server = fakeServer({ isInitialized: false });
    server.respond(
      "POST /auth/setup",
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => {
        throw new TypeError("Failed to fetch");
      },
    );
    renderForms("setup", server);
    await user.type(await screen.findByLabelText(/^Instance name/u), "Contoh");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/^Name/u), "Admin");
    await user.type(screen.getByLabelText(/^Email/u), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    // Uncertain + still not initialized → error, entries kept.
    await user.click(screen.getByRole("button", { name: /^Finish setup/u }));
    expect(
      await screen.findByText(
        "Setup didn't finish. Your entries have been kept. Check the status before trying again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/u)).toHaveValue("admin@example.com");
    // Uncertain again, but now another tab finished setup → Sign in.
    server.setStatus({ isInitialized: true });
    await user.click(screen.getByRole("button", { name: /^Finish setup/u }));
    expect(
      await screen.findByText(
        "Setup was already completed in another tab or by someone else. Sign in to continue.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    const [first, second] = server.posts("/auth/setup");
    expect(second?.headers.get("Idempotency-Key")).toBe(first?.headers.get("Idempotency-Key"));
  });

  it("turns SETUP_COMPLETE into Sign in", async () => {
    const user = userEvent.setup();
    const raced = fakeServer({ isInitialized: false });
    raced.respond("POST /auth/setup", () => failure(409, "SETUP_COMPLETE"));
    renderForms("setup", raced);
    await user.type(await screen.findByLabelText(/^Instance name/u), "Contoh");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/^Name/u), "Admin");
    await user.type(screen.getByLabelText(/^Email/u), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/u), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Finish setup/u }));
    expect(
      await screen.findByText(
        "Setup was already completed in another tab or by someone else. Sign in to continue.",
      ),
    ).toBeInTheDocument();
  });

  it("shows already-initialized and status-failure states", async () => {
    const user = userEvent.setup();
    renderForms("setup", fakeServer({ isInitialized: true }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking setup status…");
    expect(
      await screen.findByText("This instance is already set up. Sign in to continue."),
    ).toBeInTheDocument();
    document.body.innerHTML = "";

    const failing = fakeServer("fail");
    renderForms("setup", failing);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The service is unavailable right now. Please try again shortly.",
    );
    failing.setStatus({ isInitialized: false });
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText(/^Instance name/u)).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("maps client and server issue codes to messages", () => {
    expect(issueMessageKey("EMAIL_EXISTS")).toBe("validation.errors.emailExists");
    expect(issueMessageKey("OUT_OF_RANGE")).toBe("validation.errors.outOfRange");
    expect(issueMessageKey("too_big")).toBe("validation.errors.tooLong");
    expect(issueMessageKey("anything")).toBe("validation.errors.invalidFormat");
    expect(
      validateFields(loginRequestSchema, { email: "not-an-email", password: "" }, [
        "email",
        "password",
      ]),
    ).toEqual({
      email: "validation.errors.invalidFormat",
      password: "validation.errors.required",
    });
  });
});
