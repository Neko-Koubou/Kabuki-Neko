/**
 * TASK-133 coverage for S01 and S17: the landing (instance name, Join/Sign in, registration link by
 * mode, loading/error with static content, missing mascot → monogram), every S17 variant with safe
 * fixed text and its next step (404 → Home, no access → Back, expired sign-in → safe returnTo, room
 * expired/kicked → Join a game with no automatic rejoin, replaced, service retry with busy state,
 * repeated failure and a safe reference ID), error-code mapping, the error boundary page, shell
 * text before route namespaces load, and the inline connection banner.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import HomePage from "@/app/page";
import { ApiError } from "@/lib/api-client";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import {
  ConnectionBanner,
  FALLBACK_VARIANTS,
  SessionFallback,
  describeError,
  fallbackForError,
  isTerminalVariant,
  safeReference,
} from "./session-fallback";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

const ALL = ["common", "accessibility", "validation", "auth", "player", "about"] as const;
/**
 * Lobby tracks from the committed, already optimized audio manifest (a valid public-config
 * fixture); read from the repository so the test needs no prior `pnpm build:assets`.
 */
const LOBBY_TRACKS: unknown = JSON.parse(
  process
    .getBuiltinModule("node:fs")
    .readFileSync(
      `${process.cwd()}/../../audio-assets/kabuki-neko-audio/audio-manifest.json`,
      "utf8",
    ),
).lobby;

/** Renders with the root providers (theme + auth with a scripted fetch). */
function renderApp(ui: ReactElement, fetchImpl: typeof fetch, namespaces = [...ALL]) {
  return renderWithLocale(
    <ThemeProvider store={createThemePreferenceStore({ storage: () => null })}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={fetchImpl}
        locks={null}
        channel={null}
        storage={null}
      >
        {ui}
      </AuthProvider>
    </ThemeProvider>,
    { namespaces },
  );
}

/** Public config response for the landing. */
function configResponse(instanceName: string, registrationMode: string) {
  return new Response(
    JSON.stringify({
      instanceName,
      defaultLocale: "en",
      registrationMode,
      limits: { imageMb: 5, audioMb: 10, videoMb: 50 },
      catalogVersion: "1",
      audioTracks: LOBBY_TRACKS,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("S01 landing", () => {
  it("shows the shell at once, then the instance name, CTAs and registration by mode", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    renderApp(<HomePage />, fetchImpl as unknown as typeof fetch);
    const main = screen.getByRole("main");
    // Loading: product name and both CTAs are usable immediately.
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("Kabuki Neko");
    expect(within(main).getByRole("link", { name: "Join a game" })).toHaveAttribute(
      "href",
      "/join",
    );
    expect(within(main).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(within(main).queryByRole("link", { name: /Create one/u })).not.toBeInTheDocument();
    expect(within(main).getByText("Enter the 6-digit PIN shown by the host.")).toBeInTheDocument();
    await act(async () => answer(configResponse("SMA Negeri 1 Contoh", "INVITE_ONLY")));
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent(
      "SMA Negeri 1 Contoh",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(main).getByRole("link", { name: "Don't have an account? Create one" }),
    ).toHaveAttribute("href", "/register");
  });

  it("hides registration for single-admin instances", async () => {
    const fetchImpl = vi.fn(async () => configResponse("Satu Admin", "SINGLE_ADMIN"));
    renderApp(<HomePage />, fetchImpl as unknown as typeof fetch);
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { name: "Satu Admin" })).toBeInTheDocument();
    expect(within(main).queryByRole("link", { name: /Create one/u })).not.toBeInTheDocument();
  });

  it("keeps static content with the service banner and replaces a missing mascot", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }),
    );
    renderApp(<HomePage />, fetchImpl as unknown as typeof fetch);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service is unavailable right now. Please try again shortly.",
    );
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1 })).toHaveTextContent("Kabuki Neko");
    expect(within(main).getByRole("link", { name: "Join a game" })).toBeInTheDocument();
    const mascot = main.querySelector('img[src="/brand/mascot.svg"]') as HTMLImageElement;
    expect(mascot).toHaveAttribute("alt", "");
    fireEvent.error(mascot);
    expect(await within(main).findByTestId("mascot-monogram")).toHaveTextContent("KN");
  });
});

describe("S17 SessionFallback", () => {
  it("maps error codes and marks terminal variants", () => {
    expect(fallbackForError("NOT_FOUND")).toBe("notFound");
    expect(fallbackForError("FORBIDDEN")).toBe("forbidden");
    expect(fallbackForError("TOKEN_REVOKED")).toBe("authExpired");
    expect(fallbackForError("ROOM_LOST")).toBe("roomExpired");
    expect(fallbackForError("ROOM_NOT_FOUND")).toBe("roomExpired");
    expect(fallbackForError("PLAYER_KICKED")).toBe("kicked");
    expect(fallbackForError("SESSION_REPLACED")).toBe("replaced");
    expect(fallbackForError("INTERNAL_ERROR")).toBe("service");
    expect(fallbackForError(undefined)).toBe("service");
    expect(FALLBACK_VARIANTS.filter(isTerminalVariant)).toEqual([
      "roomExpired",
      "kicked",
      "replaced",
    ]);
    expect(safeReference("0b8f2a8e-1c1b-4a8e")).toBe("0b8f2a8e-1c1b-4a8e");
    expect(safeReference("<img src=x>")).toBeNull();
    expect(describeError(new ApiError(404, "NOT_FOUND", {}, [], "abc-123"))).toEqual({
      code: "NOT_FOUND",
      reference: "abc-123",
    });
    expect(describeError(Object.assign(new Error("secret title"), { digest: "123456" }))).toEqual({
      code: null,
      reference: "123456",
    });
  });

  it("renders each variant with fixed text and its next step only", () => {
    const expected: Record<string, { message: string; links: [string, string][] }> = {
      notFound: {
        message: "This couldn't be found. It may have been deleted, or you may not have access.",
        links: [["Go to home", "/"]],
      },
      authExpired: {
        message: "Your session has expired. Please sign in again.",
        links: [
          ["Sign in again", "/login?returnTo=%2Fdashboard%2Freports%2F42"],
          ["Go to home", "/"],
        ],
      },
      roomExpired: {
        message: "This game has ended or expired.",
        links: [
          ["Join a game", "/join"],
          ["Go to home", "/"],
        ],
      },
      kicked: {
        message: "The host removed you from this game.",
        links: [
          ["Join a game", "/join"],
          ["Go to home", "/"],
        ],
      },
      replaced: {
        message: "This game was opened on another tab or device, so this one was disconnected.",
        links: [
          ["Go to home", "/"],
          ["Join a game", "/join"],
        ],
      },
    };
    for (const [variant, want] of Object.entries(expected)) {
      const view = renderWithLocale(
        <SessionFallback variant={variant as "notFound"} returnTo="/dashboard/reports/42" />,
        { namespaces: [...ALL] },
      );
      const section = screen.getByRole("region");
      expect(within(section).getByRole("heading", { level: 1 })).toHaveTextContent(
        "We couldn't open this page.",
      );
      expect(section).toHaveTextContent(want.message);
      expect(
        within(section)
          .getAllByRole("link")
          .map((link) => [link.textContent, link.getAttribute("href")]),
      ).toEqual(want.links);
      // No button that could retry or rejoin automatically.
      expect(within(section).queryByRole("button")).not.toBeInTheDocument();
      view.unmount();
    }
    // An unsafe returnTo falls back to the dashboard.
    renderWithLocale(<SessionFallback variant="authExpired" returnTo="//evil.example" />, {
      namespaces: [...ALL],
    });
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fdashboard",
    );
  });

  it("goes back from a forbidden page and shows the logo + language header", async () => {
    const user = userEvent.setup();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.history.pushState({}, "", "/somewhere");
    renderWithLocale(<SessionFallback variant="forbidden" />, { namespaces: [...ALL] });
    expect(screen.getByText("You don't have permission to do this.")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toContainElement(
      screen.getByRole("button", { name: /^Language/u }),
    );
    expect(screen.getByRole("link", { name: "Kabuki Neko" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("retries a service failure once at a time, keeps the reason and shows a safe reference", async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithLocale(
      <SessionFallback variant="service" correlationId="0b8f2a8e-1c1b-4a8e" onRetry={onRetry} />,
      { namespaces: [...ALL] },
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong");
    const reason = "Something went wrong on our side. Please try again.";
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(
      screen.getByText("If you contact support, include the reference ID below."),
    ).toBeInTheDocument();
    expect(screen.getByText("Reference ID: 0b8f2a8e-1c1b-4a8e")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(retry).toHaveTextContent("Trying again…");
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(reason)).toBeInTheDocument();
    await act(async () => finish(false));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still not working. Check your connection and try again.",
    );
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(retry).toHaveTextContent("Try again");
  });

  it("hides unsafe references and shows shell text before route namespaces load", () => {
    renderWithLocale(
      <SessionFallback variant="kicked" correlationId={'<script>alert("x")</script>'} />,
      { namespaces: ["common", "accessibility"] },
    );
    expect(screen.queryByText(/Reference ID/u)).not.toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(
      screen.getByText("Something went wrong. Go back to the home page to continue."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/join");
  });

  it("renders the error boundary page from an API error without the raw message", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const view = renderWithLocale(
      <ErrorPage error={new ApiError(403, "FORBIDDEN", {}, [], "ref-1")} retry={retry} />,
      { namespaces: [...ALL] },
    );
    expect(screen.getByText("You don't have permission to do this.")).toBeInTheDocument();
    expect(screen.queryByText("FORBIDDEN")).not.toBeInTheDocument();
    view.unmount();
    renderWithLocale(<ErrorPage error={new Error("Quiz 'Secret plans' failed")} retry={retry} />, {
      namespaces: [...ALL],
    });
    expect(screen.queryByText(/Secret plans/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionBanner", () => {
  it("stays inline for temporary states and offers Retry only once lost", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderWithLocale(
      <ConnectionBanner state="reconnecting" onRetry={onRetry} />,
      {
        namespaces: [...ALL],
      },
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<ConnectionBanner state="offline" onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("You're offline.");
    rerender(<ConnectionBanner state="lost" onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connection lost.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
