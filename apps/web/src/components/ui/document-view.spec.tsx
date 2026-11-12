/**
 * TASK-149 coverage for the About document and the language guide (F20).
 * - About:
 *   - real version, or "Version unknown" without a made-up value;
 *   - official legal links;
 *   - the official license text in its original language;
 *   - source failure with retry and the official link kept;
 *   - the audio credits trigger with the separate-licenses note.
 * - Language guide:
 *   - documented steps;
 *   - the real template ZIP link;
 *   - installed languages with coverage;
 *   - an unavailable registry reported, never invented.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createThemePreferenceStore } from "@/lib/preferences";
import { AuthProvider } from "@/providers/auth-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { renderWithLocale } from "@/test/locale";
import { AboutDocument, LanguageGuide, type AboutDocumentProps } from "./document-view";

const NAMESPACES = ["common", "accessibility", "about"] as const;
const LICENSE =
  "Kabuki Neko\n“Commons Clause” License Condition v1.0\nLicense: Apache License, Version 2.0";

/** Renders inside the providers. */
function renderAbout(props: AboutDocumentProps) {
  const store = createThemePreferenceStore({ storage: () => null });
  return renderWithLocale(
    <ThemeProvider store={store}>
      <AuthProvider
        apiBaseUrl="http://api.test/api/v1"
        fetch={vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch}
        locks={null}
        channel={null}
        storage={null}
      >
        <AboutDocument loadCredits={async () => "# Credits"} {...props} />
      </AuthProvider>
    </ThemeProvider>,
    { namespaces: [...NAMESPACES] },
  );
}

describe("AboutDocument", () => {
  it("shows the real version, the official links and license text, and the audio credits", async () => {
    renderAbout({ loadVersion: async () => "1.4.2", loadLicense: async () => LICENSE });
    expect(
      screen.getByRole("heading", { level: 1, name: "About Kabuki Neko" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Version 1.4.2")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Code license" })[0]).toHaveAttribute(
      "href",
      "/legal/LICENSE.txt",
    );
    expect(screen.getByRole("link", { name: "Third-party notices" })).toHaveAttribute(
      "href",
      "/legal/THIRD-PARTY-NOTICES.txt",
    );
    const text = await screen.findByLabelText("Original license text");
    expect(text).toHaveAttribute("lang", "en");
    expect(text).toHaveTextContent("Commons Clause");
    expect(
      screen.getByText("The app's code and its music and sound effects are licensed separately."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Music and sound credits" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a language" })).toHaveAttribute(
      "href",
      "/help/languages",
    );
  });

  it("says the version is unknown and keeps the official link when the sources fail", async () => {
    const user = userEvent.setup();
    const license = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(LICENSE);
    renderAbout({
      loadVersion: async () => Promise.reject(new Error("down")),
      loadLicense: license,
    });
    expect(
      await screen.findByText("Version unknown. The guides below are still available."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Version \d/u)).not.toBeInTheDocument();
    expect(
      await screen.findByText("The original document isn't available right now."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Official source" })).toHaveAttribute(
      "href",
      "/legal/LICENSE.txt",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Original license text")).toHaveTextContent(
      "Commons Clause",
    );
  });
});

describe("LanguageGuide", () => {
  it("lists the steps, the real template and installed languages with coverage", async () => {
    renderWithLocale(
      <LanguageGuide
        loadLanguages={async () => [
          { tag: "en", nativeName: "English", coverage: 1 },
          { tag: "de", nativeName: "Deutsch", coverage: 0.875 },
        ]}
      />,
      { namespaces: [...NAMESPACES] },
    );
    expect(screen.getByRole("heading", { level: 1, name: "Add a language" })).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.textContent)
        .slice(0, 6),
    ).toEqual([
      "Download translation template",
      "Validate the package",
      "Install the package",
      "Build the language catalogs",
      "Restart the app",
      "Roll back to the previous catalogs",
    ]);
    const template = screen.getByRole("link", { name: "Download translation template" });
    expect(template).toHaveAttribute("href", "/locales/template-v1.zip");
    expect(template).toHaveAttribute("download");
    expect(await screen.findByText("Deutsch: 88% translated")).toHaveAttribute("lang", "de");
    expect(screen.getByText("English: 100% translated")).toBeInTheDocument();
  });

  it("reports an unavailable registry instead of inventing languages", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<{ tag: string; nativeName: string; coverage: number }[]>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([{ tag: "id", nativeName: "Bahasa Indonesia", coverage: 1 }]);
    renderWithLocale(<LanguageGuide loadLanguages={load} />, { namespaces: [...NAMESPACES] });
    expect(
      await screen.findByText("The translation guide isn't available right now."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Bahasa Indonesia: 100% translated")).toBeInTheDocument();
  });
});
