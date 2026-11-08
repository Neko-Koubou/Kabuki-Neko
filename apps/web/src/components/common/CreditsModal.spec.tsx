/**
 * TASK-130C coverage for the credits dialog: the real packaged CREDITS.md renders composers,
 * tables and safe OpenTracks source links (new tab, noopener noreferrer) with the code/audio
 * license separation and the footer links; script/HTML/`javascript:`/`data:`/`http:` injection
 * never becomes markup or a link; loading, empty, partial and error (with retry) states; keyboard
 * use (open from the trigger, focus trap, Escape returns focus) and the mobile sheet layout.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { CreditsButton, CreditsModal, safeHref } from "./CreditsModal";

const NAMESPACES = ["common", "accessibility", "about"] as const;
const REAL_CREDITS = process
  .getBuiltinModule("node:fs")
  .readFileSync(`${process.cwd()}/../../audio-assets/kabuki-neko-audio/CREDITS.md`, "utf8");

/** Deferred promise helper. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("CreditsModal", () => {
  it("renders the real credits with composers, source links and license separation", async () => {
    renderWithLocale(
      <CreditsModal open onClose={() => {}} loadCredits={async () => REAL_CREDITS} />,
      { namespaces: [...NAMESPACES] },
    );
    const dialog = await screen.findByRole("dialog", { name: "Music and sound credits" });
    expect(dialog).toHaveAccessibleDescription(
      "The app's code and its music and sound effects are licensed separately.",
    );
    expect(within(dialog).getAllByRole("table").length).toBeGreaterThanOrEqual(4);
    expect(within(dialog).getByText("GT-K")).toBeInTheDocument();
    expect(within(dialog).getByText("Hupple")).toBeInTheDocument();
    const sources = within(dialog).getAllByRole("link", { name: /^OpenTracks #/u });
    expect(sources.length).toBe(10);
    for (const link of sources) {
      expect(link.getAttribute("href")).toMatch(
        /^https:\/\/opentracks\.com\/en\/bgm\/detail\/\d+$/u,
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(
      within(dialog).getByText(/Apache License 2\.0 dengan Commons Clause/u),
    ).toBeInTheDocument();
    // The credits flag unverified items, so the partial note is shown.
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "Some audio credit details are missing.",
    );
    const footer = within(dialog).getByRole("navigation", { name: "License" });
    expect(within(footer).getByRole("link", { name: "Download credits" })).toHaveAttribute(
      "href",
      "/audio/CREDITS.md",
    );
    expect(within(footer).getByRole("link", { name: "Third-party notices" })).toHaveAttribute(
      "href",
      "/legal/THIRD-PARTY-NOTICES.txt",
    );
    expect(within(footer).getByRole("link", { name: "Code license" })).toHaveAttribute(
      "href",
      "/legal/LICENSE.txt",
    );
  });

  it("never turns injected markup or unsafe link targets into elements", async () => {
    const hostile = [
      "# Credits <script>alert(1)</script>",
      "<img src=x onerror=alert(2)>",
      "| Name | Link |",
      "| --- | --- |",
      "| Evil | [run](javascript:alert(3)) |",
      "| Data | [open](data:text/html,<b>x</b>) |",
      "| Plain | [http](http://example.com/a) |",
      "| Ok | [safe](https://opentracks.com/en/se) |",
      "- **bold** and `<iframe>` code",
    ].join("\n");
    const { container } = renderWithLocale(
      <CreditsModal open onClose={() => {}} loadCredits={async () => hostile} />,
      { namespaces: [...NAMESPACES] },
    );
    const dialog = await screen.findByRole("dialog");
    expect(document.querySelector("script, img, iframe")).toBeNull();
    expect(within(dialog).getByText(/<script>alert\(1\)<\/script>/u)).toBeInTheDocument();
    expect(within(dialog).getByText("<img src=x onerror=alert(2)>")).toBeInTheDocument();
    const links = within(dialog)
      .getAllByRole("link")
      .filter((link) => !link.closest("nav"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://opentracks.com/en/se",
    ]);
    expect(within(dialog).getByText("run").tagName).toBe("SPAN");
    expect(within(dialog).getByText("<iframe>").tagName).toBe("CODE");
    expect(container.innerHTML).not.toMatch(/href="(javascript|data|http):/u);
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("/legal/LICENSE.txt")).toEqual({ href: "/legal/LICENSE.txt", external: false });
    expect(safeHref("https://user:pw@example.com")).toBeNull();
  });

  it("shows the loading and empty states", async () => {
    const first = deferred<string>();
    const loader = vi.fn().mockReturnValueOnce(first.promise);
    renderWithLocale(<CreditsModal open onClose={() => {}} loadCredits={loader} />, {
      namespaces: [...NAMESPACES],
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading content…");
    await act(async () => first.resolve("   "));
    expect(within(dialog).getByText("No audio credits available.")).toBeInTheDocument();
  });

  it("recovers from a load error", async () => {
    const user = userEvent.setup();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce("Plain credits.");
    renderWithLocale(<CreditsModal open onClose={() => {}} loadCredits={loader} />, {
      namespaces: [...NAMESPACES],
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The audio credits couldn't load.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Plain credits.")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("opens from the trigger, traps focus, closes on Escape and uses the mobile sheet width", async () => {
    const user = userEvent.setup();
    renderWithLocale(
      <CreditsButton
        loadCredits={async () => "Short credits with [a link](https://opentracks.com/en/se)."}
      />,
      { namespaces: [...NAMESPACES] },
    );
    const trigger = screen.getByRole("button", { name: "Music and sound credits" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await screen.findByText(/Short credits/u);
    expect(dialog.className).toMatch(/w-\[calc\(100vw-32px\)\]/u);
    const close = within(dialog).getByRole("button", { name: "Close dialog" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    close.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
