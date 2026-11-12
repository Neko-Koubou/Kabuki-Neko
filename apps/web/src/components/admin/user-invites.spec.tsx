/**
 * TASK-148 coverage for S12 users/invitations and M11 against a scripted API.
 * - L/E/I/P/X:
 *   - loading;
 *   - empty: no users / invitations;
 *   - ideal lists;
 *   - partial: used/expired invitations, last-admin protection;
 *   - error: rejected change with a refreshed list.
 * - Admin guard: creators get a permission notice and no request.
 * - Access changes go through M09 with If-Match. The last administrator answer (409) is blocked,
 *   never a success, and a 403 reloads the principal.
 * - Invitations:
 *   - status filter;
 *   - revoke for active codes only;
 *   - M11 one-time code with copy, clipboard unavailable or failing (manual copy), and an unknown
 *     outcome after a lost response.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import { UserInvites, type ClipboardWriter } from "./user-invites";

const NAMESPACES = [
  "common",
  "accessibility",
  "admin",
  "validation",
  "auth",
  "media",
  "reports",
] as const;
const ME = "5b0c2f7e-3d1a-4c6b-8e9f-0a1b2c3d4e5f";
const NOW = 1_790_000_000_000;
const CODE = "A".repeat(43);

/** User fixture. */
function account(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: n === 0 ? ME : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    email: `user${n}@example.com`,
    name: n === 0 ? "Ayu" : `Pengguna ${n}`,
    role: n === 0 ? "SUPERADMIN" : "CREATOR",
    avatar: { style: "bottts", seed: `u${n}` },
    isActive: true,
    revision: 2,
    createdAt: NOW,
    ...overrides,
  };
}

/** Invitation fixture. */
function invite(n: number, status: string) {
  return {
    id: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    status,
    createdAt: NOW + n,
    expiresAt: NOW + 86_400_000,
    usedAt: status === "USED" ? NOW + 10 : null,
    revokedAt: status === "REVOKED" ? NOW + 10 : null,
  };
}

/** JSON response. */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Page response. */
function page(items: unknown[]) {
  return json(200, {
    items,
    meta: { page: 1, limit: 20, total: items.length, totalPages: Math.ceil(items.length / 20) },
  });
}

/** Error envelope. */
function failure(status: number, errorCode: string) {
  return json(status, {
    statusCode: status,
    errorCode,
    message: "x",
    params: {},
    details: [],
    correlationId: "0b8f2a8e-1c1b-4a8e-9d3f-2b6c8e1a5f41",
  });
}

/** One recorded request. */
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** Scripted API; `route` answers everything except the session. */
function fakeApi(
  role: "CREATOR" | "SUPERADMIN",
  route: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    if (call.path === "/auth/refresh")
      return json(200, { accessToken: "access-1", expiresIn: 900 });
    if (call.path === "/auth/me") return json(200, account(0, { role }));
    return route(call);
  });
  return { calls, fetchMock };
}

/** Starts the session like the dashboard shell does. */
function Session({ children }: { children: ReactNode }) {
  const { ensureSession } = useAuth();
  useEffect(() => {
    void ensureSession();
  }, [ensureSession]);
  return <>{children}</>;
}

/** Renders the page inside the providers. */
function renderPage(api: ReturnType<typeof fakeApi>, clipboard?: ClipboardWriter) {
  const store = createThemePreferenceStore({ storage: () => null });
  return renderWithLocale(
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={api.fetchMock as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        <Session>
          <UserInvites {...(clipboard !== undefined ? { clipboard } : {})} />
        </Session>
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
}

describe("UserInvites", () => {
  it("keeps creators out without requesting users", async () => {
    const api = fakeApi("CREATOR", () => page([]));
    renderPage(api);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You don't have permission to do this.",
    );
    expect(api.calls.some((call) => call.path.startsWith("/users"))).toBe(false);
  });

  it("lists, searches and filters users, and shows empty and error states", async () => {
    const user = userEvent.setup();
    const answers = [
      page([account(0), account(1)]),
      page([]),
      failure(503, "DEPENDENCY_UNAVAILABLE"),
      page([account(1)]),
    ];
    const api = fakeApi("SUPERADMIN", () => answers.shift() ?? page([]));
    renderPage(api);
    expect(await screen.findByText("Pengguna 1")).toBeInTheDocument();
    expect(api.calls.find((call) => call.path === "/users")?.query.get("limit")).toBe("20");
    await user.type(screen.getByLabelText(/^Search users/u), "zzz");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText(
        "No invitations yet, or no users match your search. Create an invitation or clear the filters.",
      ),
    ).toBeInTheDocument();
    expect(
      api.calls
        .filter((call) => call.path === "/users")
        .at(-1)
        ?.query.get("search"),
    ).toBe("zzz");
    await user.selectOptions(screen.getByLabelText(/^Role/u), "CREATOR");
    expect(
      await screen.findByText(
        "That change was rejected and nothing was changed. Your permissions have been reloaded.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Pengguna 1")).toBeInTheDocument();
    expect(
      api.calls
        .filter((call) => call.path === "/users")
        .at(-1)
        ?.query.get("role"),
    ).toBe("CREATOR");
  });

  it("blocks demoting the last administrator and reloads the principal after a 403", async () => {
    const user = userEvent.setup();
    let patches = 0;
    const api = fakeApi("SUPERADMIN", (call) => {
      if (call.method === "PATCH") {
        patches += 1;
        return patches === 1 ? failure(409, "LAST_SUPERADMIN") : failure(403, "FORBIDDEN");
      }
      return page([account(0), account(1)]);
    });
    renderPage(api);
    await user.click(await screen.findByRole("button", { name: "Change role: Ayu" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Change role: Creator")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(
      await within(dialog).findByText("The last administrator can't be demoted or deactivated."),
    ).toBeInTheDocument();
    const patch = api.calls.find((call) => call.method === "PATCH");
    expect(patch?.headers.get("If-Match")).toBe('"2"');
    expect(patch?.body).toEqual({ role: "CREATOR" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    const meCalls = api.calls.filter((call) => call.path === "/auth/me").length;
    await user.click(screen.getByRole("button", { name: /^Deactivate: Pengguna 1/u }));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Deactivate this account? The user will be signed out and can't sign in until reactivated.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.path === "/auth/me").length).toBeGreaterThan(meCalls),
    );
    expect(api.calls.filter((call) => call.method === "PATCH")[1]?.body).toEqual({
      isActive: false,
    });
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }),
    );
    // The signed-in admin can't deactivate themselves.
    expect(screen.getByRole("button", { name: /^Deactivate: Ayu/u })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("lists invitation statuses, filters them and revokes only active codes", async () => {
    const user = userEvent.setup();
    let revoked = false;
    const api = fakeApi("SUPERADMIN", (call) => {
      if (call.path === "/users") return page([account(0)]);
      if (call.method === "DELETE") {
        revoked = true;
        return json(200, { revoked: true });
      }
      if (call.query.get("status") === "EXPIRED") return page([]);
      return page([
        invite(1, revoked ? "REVOKED" : "ACTIVE"),
        invite(2, "USED"),
        invite(3, "EXPIRED"),
      ]);
    });
    renderPage(api);
    await user.click(await screen.findByRole("tab", { name: "Invitations" }));
    await waitFor(() =>
      expect(document.querySelector('[data-invite-status="USED"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-invite-status="EXPIRED"]')).toHaveTextContent("Expired");
    expect(
      screen.getByText(
        "Some invitations are used or expired, and the last administrator can't be demoted or deactivated.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Revoke/u })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /^Revoke/u }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Revoke this invite code? It will stop working immediately."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Revoke/u })).not.toBeInTheDocument(),
    );
    expect(document.querySelector('[data-invite-status="REVOKED"]')).toHaveTextContent("Revoked");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "EXPIRED");
    expect(
      await screen.findByText("No invitations yet. Create one to invite a creator."),
    ).toBeInTheDocument();
  });

  it("shows the one-time code with copy, manual copy when the clipboard fails, and forgets it on close", async () => {
    const user = userEvent.setup();
    const clipboard = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    const api = fakeApi("SUPERADMIN", (call) => {
      if (call.method === "POST" && call.path === "/users/invitations")
        return json(201, { invitation: invite(9, "ACTIVE"), inviteCode: CODE });
      return call.path === "/users" ? page([account(0)]) : page([]);
    });
    renderPage(api, clipboard);
    await user.click(await screen.findByRole("tab", { name: "Invitations" }));
    await user.click(await screen.findByRole("button", { name: "Create invitation" }));
    let dialog = await screen.findByRole("dialog", { name: "Invite a creator" });
    const hours = within(dialog).getByLabelText(/^Expires in \(hours\)/u);
    await user.clear(hours);
    await user.type(hours, "24");
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(await within(dialog).findByDisplayValue(CODE)).toHaveAttribute("readonly");
    expect(
      within(dialog).getByText("This code works only once and is shown only now."),
    ).toBeInTheDocument();
    const post = api.calls.find(
      (call) => call.method === "POST" && call.path === "/users/invitations",
    );
    expect(post?.body).toEqual({ expiresInHours: 24 });
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);
    await user.click(within(dialog).getByRole("button", { name: "Copy code" }));
    expect(clipboard).toHaveBeenCalledWith(CODE);
    expect(await within(dialog).findByText("Code copied")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy code" }));
    expect(
      await within(dialog).findByText(
        "The code couldn't be copied. Select it and copy it manually.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    dialog = await screen.findByRole("dialog", { name: "Invite a creator" });
    expect(within(dialog).queryByDisplayValue(CODE)).not.toBeInTheDocument();
  });

  it("reports an unknown outcome after a lost create and without a clipboard", async () => {
    const user = userEvent.setup();
    const api = fakeApi("SUPERADMIN", (call) => {
      if (call.method === "POST" && call.path === "/users/invitations")
        return failure(409, "INVITE_CODE_ALREADY_ISSUED");
      return call.path === "/users" ? page([account(0)]) : page([]);
    });
    renderPage(api, null);
    await user.click(await screen.findByRole("tab", { name: "Invitations" }));
    await user.click(await screen.findByRole("button", { name: "Create invitation" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a creator" });
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(
      await within(dialog).findByText(
        "We couldn't confirm whether the invitation was created. Check the list before creating another.",
      ),
    ).toBeInTheDocument();
  });
});
