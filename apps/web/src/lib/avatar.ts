/**
 * Deterministic DiceBear avatars (B12; Design §5.1, SA §8.3, US-08; TASK-123).
 *
 * - Only the six styles in `AVATAR_STYLES` exist, each loaded lazily from
 *   `@dicebear/collection/async` (one code-split chunk per style, fetched when first needed), so
 *   no page boots with all collections.
 * - Style and seed are validated with the shared `avatarSchema` (`[A-Za-z0-9_-]{1,100}`) before
 *   anything is generated; invalid input falls back to a default derived from the nickname.
 * - The SVG is generated locally by DiceBear from the seed alone (no artwork options, matching the
 *   "no modification" statement in THIRD-PARTY-NOTICES) and returned as a `data:image/svg+xml`
 *   URI for an `<img>`: SVG inside an image cannot run scripts, and no user-supplied or remote SVG
 *   is ever rendered. Results are cached per style+seed.
 * - `randomAvatarSeed` rerolls locally with crypto randomness; `monogram` gives initials for the
 *   last-resort fallback.
 */
import type { Style } from "@dicebear/core";
import { AVATAR_STYLES } from "@kabuki-neko/shared/constants/game";
import { avatarSchema } from "@kabuki-neko/shared/schemas/users.schema";

/** One of the six offered avatar styles. */
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

/** A validated avatar. */
export interface Avatar {
  style: AvatarStyle;
  seed: string;
}

/** Loads a DiceBear style module. */
export type AvatarStyleLoader = (style: AvatarStyle) => Promise<Style<object>>;

/** Default style for missing or invalid avatars. */
export const DEFAULT_AVATAR_STYLE: AvatarStyle = "bottts";
/** Seed alphabet (also the schema's). */
const SEED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Lazily imports one of the six pinned styles (each its own chunk). */
export const loadAvatarStyle: AvatarStyleLoader = async (style) => {
  const collection = await import("@dicebear/collection/async");
  const loaders: Record<AvatarStyle, () => Promise<Style<object>>> = {
    bottts: collection.bottts,
    adventurer: collection.adventurer,
    "fun-emoji": collection.funEmoji,
    "pixel-art": collection.pixelArt,
    lorelei: collection.lorelei,
    avataaars: collection.avataaars,
  };
  return loaders[style]();
};

/** Validated avatar, or null for any invalid style/seed (never throws). */
export function parseAvatar(input: unknown): Avatar | null {
  const parsed = avatarSchema.safeParse(input);
  return parsed.success ? (parsed.data as Avatar) : null;
}

/** True when `style` is one of the six offered styles. */
export function isAvatarStyle(style: unknown): style is AvatarStyle {
  return typeof style === "string" && (AVATAR_STYLES as readonly string[]).includes(style);
}

/** Deterministic seed for a nickname (schema-safe): hex of a 32-bit FNV-1a hash. */
export function seedFromText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `kn-${hash.toString(16).padStart(8, "0")}`;
}

/** Default avatar for a nickname (deterministic, so every screen shows the same one). */
export function defaultAvatar(nickname = ""): Avatar {
  return { style: DEFAULT_AVATAR_STYLE, seed: seedFromText(nickname || "kabuki-neko") };
}

/** A new random seed (16 characters from the schema alphabet, crypto randomness). */
export function randomAvatarSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SEED_ALPHABET[byte % SEED_ALPHABET.length]).join("");
}

/** Up to two initials (grapheme-aware) for the monogram fallback. */
export function monogram(nickname: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const words = nickname.trim().split(/\s+/u).filter(Boolean);
  const first = (word: string) =>
    segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? "";
  const initials =
    words.length > 1 ? first(words[0] ?? "") + first(words[1] ?? "") : first(words[0] ?? "");
  return initials.toLocaleUpperCase() || "?";
}

/** Cache of generated data URIs by `style:seed` (bounded). */
const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

/** Cached data URI for an avatar, if already generated. */
export function cachedAvatarUri(avatar: Avatar): string | undefined {
  return cache.get(`${avatar.style}:${avatar.seed}`);
}

/** Generates (or returns the cached) `data:image/svg+xml` URI for a validated avatar. */
export async function avatarDataUri(
  avatar: Avatar,
  loader: AvatarStyleLoader = loadAvatarStyle,
): Promise<string> {
  const key = `${avatar.style}:${avatar.seed}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const [{ createAvatar }, style] = await Promise.all([
    import("@dicebear/core"),
    loader(avatar.style),
  ]);
  const uri = createAvatar(style, { seed: avatar.seed }).toDataUri();
  if (!uri.startsWith("data:image/svg+xml")) throw new Error("unexpected avatar output");
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? key);
  cache.set(key, uri);
  return uri;
}
