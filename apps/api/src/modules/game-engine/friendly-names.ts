/**
 * Server-generated friendly nicknames (SA §5.2 `player:request_friendly_name`).
 *
 * Names combine one adjective and one animal from fixed, reviewed, family-safe lists, so they need
 * no profanity filtering and never contain user input. Every combination fits the 15-grapheme
 * nickname limit (longest adjective 6 + space + longest noun 7 = 14). Selection uses a
 * cryptographically secure random source; uniqueness is enforced atomically by the state store.
 */
import { randomInt } from "node:crypto";
import { TEXT_LIMITS } from "@kabuki-neko/shared/constants/limits";

/** Short, positive adjectives (≤ 6 characters). */
export const FRIENDLY_ADJECTIVES = [
  "Brave",
  "Calm",
  "Clever",
  "Cosmic",
  "Cozy",
  "Daring",
  "Eager",
  "Fluffy",
  "Gentle",
  "Happy",
  "Jolly",
  "Kind",
  "Lucky",
  "Mighty",
  "Nimble",
  "Noble",
  "Plucky",
  "Proud",
  "Quick",
  "Quiet",
  "Shiny",
  "Silly",
  "Snappy",
  "Sunny",
  "Swift",
  "Witty",
  "Zesty",
] as const;
/** Friendly animals (≤ 7 characters). */
export const FRIENDLY_NOUNS = [
  "Badger",
  "Beaver",
  "Bunny",
  "Cat",
  "Crane",
  "Dolphin",
  "Falcon",
  "Ferret",
  "Fox",
  "Gecko",
  "Heron",
  "Koala",
  "Lemur",
  "Lynx",
  "Marten",
  "Otter",
  "Owl",
  "Panda",
  "Penguin",
  "Puffin",
  "Quokka",
  "Rabbit",
  "Raven",
  "Seal",
  "Tanuki",
  "Tiger",
  "Walrus",
] as const;

/** One random "Adjective Noun" candidate; `draw(n)` returns an integer in [0, n). */
export function friendlyName(draw: (max: number) => number = randomInt): string {
  const adjective = FRIENDLY_ADJECTIVES[draw(FRIENDLY_ADJECTIVES.length)] ?? FRIENDLY_ADJECTIVES[0];
  const noun = FRIENDLY_NOUNS[draw(FRIENDLY_NOUNS.length)] ?? FRIENDLY_NOUNS[0];
  const name = `${adjective} ${noun}`;
  if (name.length > TEXT_LIMITS.nickname) throw new Error("Friendly name exceeds nickname limit");
  return name;
}
