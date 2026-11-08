/**
 * TASK-123 coverage for B12 AvatarIllustration and `lib/avatar`: the six pinned styles generate
 * deterministic local SVG data URIs per seed (different seeds/styles differ), styles load lazily,
 * invalid seeds/styles fall back to the nickname's deterministic default, a failing generator
 * shows initials with the nickname kept, the loading silhouette, decorative vs informative
 * accessibility, the mascot with expressions, and local crypto rerolls within the schema.
 */
import { createAvatar } from "@dicebear/core";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AVATAR_STYLES } from "@kabuki-neko/shared/constants/game";
import {
  avatarDataUri,
  defaultAvatar,
  loadAvatarStyle,
  monogram,
  parseAvatar,
  randomAvatarSeed,
  type AvatarStyleLoader,
} from "@/lib/avatar";
import { renderWithLocale } from "@/test/locale";
import { AvatarIllustration } from "./avatar-illustration";

describe("lib/avatar", () => {
  it("generates the six styles deterministically as local SVG data URIs", async () => {
    const uris = new Set<string>();
    for (const style of AVATAR_STYLES) {
      const first = await avatarDataUri({ style, seed: "neko_1" });
      // Independent, cache-free generation proves determinism (not just a cache hit).
      const again = createAvatar(await loadAvatarStyle(style), { seed: "neko_1" }).toDataUri();
      const other = await avatarDataUri({ style, seed: "neko_2" });
      expect(first.startsWith("data:image/svg+xml")).toBe(true);
      expect(again).toBe(first);
      expect(other).not.toBe(first);
      expect(decodeURIComponent(first)).not.toMatch(/<script|href=["']https?:/iu);
      uris.add(first);
    }
    expect(uris.size).toBe(6);
  });

  it("validates style and seed with the shared schema and rerolls locally", () => {
    expect(parseAvatar({ style: "lorelei", seed: "abc_DEF-9" })).toEqual({
      style: "lorelei",
      seed: "abc_DEF-9",
    });
    for (const bad of [
      { style: "cyberpunk", seed: "x" },
      { style: "bottts", seed: "has space" },
      { style: "bottts", seed: "https://evil.example/a.svg" },
      { style: "bottts", seed: "" },
      { style: "bottts", seed: "x".repeat(101) },
      { style: "bottts", seed: "x", extra: true },
      "bottts",
    ])
      expect(parseAvatar(bad)).toBeNull();
    const seeds = new Set(Array.from({ length: 20 }, () => randomAvatarSeed()));
    expect(seeds.size).toBe(20);
    for (const seed of seeds) expect(parseAvatar({ style: "bottts", seed })).not.toBeNull();
    expect(defaultAvatar("Ayu")).toEqual(defaultAvatar("Ayu"));
    expect(defaultAvatar("Ayu")).not.toEqual(defaultAvatar("Budi"));
    expect(monogram("neko kabuki")).toBe("NK");
    expect(monogram("éclair")).toBe("É");
    expect(monogram("  ")).toBe("?");
    expect(monogram("👩🏽‍🚀 astro")).toBe("👩🏽‍🚀A");
  });
});

describe("B12 AvatarIllustration", () => {
  it("renders an informative avatar named by the nickname, or decorative when beside it", async () => {
    const { rerender } = renderWithLocale(
      <AvatarIllustration
        avatar={{ style: "adventurer", seed: "neko_1" }}
        nickname="Ayu"
        size={48}
      />,
    );
    const image = await screen.findByRole("img", { name: "Ayu" });
    expect(image.getAttribute("src")).toBe(
      await avatarDataUri({ style: "adventurer", seed: "neko_1" }),
    );
    expect(image).toHaveAttribute("width", "48");
    rerender(
      <AvatarIllustration
        avatar={{ style: "adventurer", seed: "neko_1" }}
        nickname="Ayu"
        decorative
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("alt", "");
    rerender(
      <AvatarIllustration avatar={{ style: "pixel-art", seed: "p1" }} label="Your avatar" />,
    );
    expect(await screen.findByRole("img", { name: "Your avatar" })).toHaveAttribute(
      "data-avatar-style",
      "pixel-art",
    );
  });

  it("falls back to the nickname's default for invalid or missing avatars", async () => {
    const expected = await avatarDataUri(defaultAvatar("Budi"));
    const { rerender } = renderWithLocale(
      <AvatarIllustration avatar={{ style: "cyberpunk", seed: "x" }} nickname="Budi" />,
    );
    const image = await screen.findByRole("img", { name: "Budi" });
    expect(image.getAttribute("src")).toBe(expected);
    expect(image).toHaveAttribute("data-fallback", "true");
    expect(image).toHaveAttribute(
      "title",
      "That avatar style isn't available, so a default one is shown.",
    );
    rerender(
      <AvatarIllustration avatar={{ style: "bottts", seed: "<svg onload=1>" }} nickname="Budi" />,
    );
    expect((await screen.findByRole("img", { name: "Budi" })).getAttribute("src")).toBe(expected);
    rerender(<AvatarIllustration nickname="Budi" />);
    expect((await screen.findByRole("img", { name: "Budi" })).getAttribute("src")).toBe(expected);
  });

  it("shows a stable silhouette while loading and initials when generation fails", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const slow: AvatarStyleLoader = (style) =>
      new Promise((resolve) => {
        gate.release = () => void loadAvatarStyle(style).then(resolve);
      });
    const { container, unmount } = renderWithLocale(
      <AvatarIllustration
        avatar={{ style: "lorelei", seed: "slow-1" }}
        nickname="Citra"
        size={40}
        loader={slow}
      />,
    );
    const silhouette = container.querySelector("[aria-busy='true']") as HTMLElement;
    expect(silhouette.style.width).toBe("40px");
    expect(silhouette).toHaveTextContent("Loading avatar…");
    await waitFor(() => expect(gate.release).not.toBeNull());
    gate.release?.();
    expect(await screen.findByRole("img", { name: "Citra" })).toBeInTheDocument();
    unmount();

    const broken: AvatarStyleLoader = vi.fn(async () => {
      throw new Error("chunk failed");
    });
    renderWithLocale(
      <AvatarIllustration
        avatar={{ style: "fun-emoji", seed: "broken-1" }}
        nickname="neko kabuki"
        loader={broken}
      />,
    );
    const initials = await screen.findByRole("img", { name: "neko kabuki" });
    expect(initials).toHaveTextContent("NK");
    expect(initials).toHaveAttribute(
      "title",
      "The avatar couldn't be shown. Initials are shown instead.",
    );
  });

  it("renders the bundled mascot with an expression, decorative or labelled", () => {
    const { rerender } = renderWithLocale(
      <AvatarIllustration variant="mascot" decorative expression="happy" />,
    );
    const mascot = document.querySelector("img") as HTMLImageElement;
    expect(mascot).toHaveAttribute("src", "/brand/mascot.svg");
    expect(mascot).toHaveAttribute("alt", "");
    expect(mascot).toHaveAttribute("data-expression", "happy");
    rerender(<AvatarIllustration variant="mascot" label="Kabuki Neko mascot" />);
    expect(screen.getByRole("img", { name: "Kabuki Neko mascot" })).toHaveAttribute(
      "data-expression",
      "neutral",
    );
  });
});
