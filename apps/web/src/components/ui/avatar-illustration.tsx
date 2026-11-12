"use client";
/**
 * B12 `AvatarIllustration` (Design §5.1, §6.3; SA §8.3; US-08/US-18; TASK-123): a player's
 * DiceBear avatar or the Kabuki Neko mascot, always the same for the same style+seed.
 *
 * - Input avatars are validated (`parseAvatar`); an invalid style/seed falls back to the
 *   deterministic default for the nickname, and a missing avatar uses that default too.
 * - While the style chunk loads, a fixed-size silhouette keeps the layout stable; if generation
 *   fails, initials (monogram) replace the image. The nickname is never lost and joining is never
 *   blocked by the avatar.
 * - Accessible modes: `decorative` hides the image (empty alt, `aria-hidden`) when the nickname is
 *   shown next to it; otherwise the image is named by `label`, else the nickname, else "Avatar".
 * - The mascot (`variant="mascot"`) uses the bundled brand artwork with an optional expression.
 * - Only locally generated SVG data URIs or the bundled mascot are rendered — never remote or
 *   user-supplied SVG.
 */
import { clsx } from "clsx";
import { useEffect, useState } from "react";
import {
  avatarDataUri,
  cachedAvatarUri,
  defaultAvatar,
  monogram,
  parseAvatar,
  type Avatar,
  type AvatarStyleLoader,
} from "@/lib/avatar";
import { useLocale } from "@/providers/locale-provider";

/** Mascot expressions (subtle pose changes of the same artwork). */
export type MascotExpression = "neutral" | "happy" | "surprised" | "thinking";

/** Props of {@link AvatarIllustration}. */
export interface AvatarIllustrationProps {
  /** Unvalidated avatar from the API or the customizer. */
  avatar?: unknown;
  nickname?: string;
  /** Rendered size in CSS pixels (square). */
  size?: number;
  /** Hide from assistive technology (the nickname is shown beside it). */
  decorative?: boolean;
  /** Accessible name when informative (default: the nickname). */
  label?: string;
  variant?: "dicebear" | "mascot";
  expression?: MascotExpression;
  /** Style loader (tests); defaults to the lazy collection import. */
  loader?: AvatarStyleLoader;
}

/** Transform per mascot expression. */
const EXPRESSIONS: Record<MascotExpression, string> = {
  neutral: "",
  happy: "-rotate-6",
  surprised: "scale-110",
  thinking: "rotate-6",
};

/** Deterministic avatar or mascot with silhouette, default and monogram fallbacks. */
export function AvatarIllustration({
  avatar,
  nickname = "",
  size = 64,
  decorative = false,
  label,
  variant = "dicebear",
  expression = "neutral",
  loader,
}: AvatarIllustrationProps) {
  const { t } = useLocale();
  const parsed = avatar === undefined || avatar === null ? null : parseAvatar(avatar);
  const effective: Avatar = parsed ?? defaultAvatar(nickname);
  const fellBack = avatar !== undefined && avatar !== null && parsed === null;
  const key = `${effective.style}:${effective.seed}`;
  const [result, setResult] = useState<{ key: string; uri: string | null }>(() => ({
    key,
    uri: cachedAvatarUri(effective) ?? null,
  }));
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (variant === "mascot") return;
    let cancelled = false;
    avatarDataUri(effective, loader).then(
      (uri) => {
        if (!cancelled) setResult({ key, uri });
      },
      () => {
        if (!cancelled) setFailedKey(key);
      },
    );
    return () => {
      cancelled = true;
    };
    // `effective` is derived from `key`; re-run only when the avatar or loader changes.
  }, [key, variant, loader]);

  const name = label ?? (nickname || t("common.inventory.b12.ideal"));
  const box = { width: size, height: size };
  const a11y = decorative ? { alt: "", "aria-hidden": true as const } : { alt: name };

  if (variant === "mascot")
    return (
      <img
        src="/brand/mascot.svg"
        width={size}
        height={size}
        {...a11y}
        data-expression={expression}
        className={clsx("shrink-0 motion-safe:transition-transform", EXPRESSIONS[expression])}
      />
    );

  if (failedKey === key)
    return (
      <span
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
        title={t("common.inventory.b12.error")}
        style={{ ...box, fontSize: Math.max(12, Math.round(size * 0.4)) }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-crimson font-semibold text-primary-foreground"
      >
        {monogram(nickname)}
      </span>
    );

  const uri = result.key === key ? result.uri : (cachedAvatarUri(effective) ?? null);
  if (uri === null)
    return (
      <span
        style={box}
        aria-busy="true"
        className="relative inline-block shrink-0 rounded-full bg-subtle motion-safe:animate-pulse"
      >
        {!decorative && <span className="sr-only">{t("common.inventory.b12.loading")}</span>}
      </span>
    );

  return (
    <img
      src={uri}
      width={size}
      height={size}
      {...a11y}
      data-avatar-style={effective.style}
      data-fallback={fellBack || undefined}
      title={fellBack ? t("common.inventory.b12.partial") : undefined}
      className="shrink-0 rounded-full bg-subtle"
    />
  );
}
