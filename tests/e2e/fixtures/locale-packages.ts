/**
 * TASK-172 test-only locale packages (SA §8.1–8.2; US-21). Never shipped: tests write them into
 * temporary directories and build bundles there, never into `packages/shared/locales`,
 * `extensions/locales` or `apps/web/public/locales`.
 *
 * - `de` (Deutsch) and `ar` (العربية) are genuine extra languages as *partial* external packages.
 *   They carry real translations for the shell, language picker and join/answer texts; everything
 *   else falls back to English.
 *   - German is a long-text language, so it checks expansion in real layouts.
 *   - Arabic is right-to-left.
 * - `en-XA` and `ar-XB` are the reserved pseudo-locales, generated from the English sources:
 *   - `en-XA` accents every letter and pads each message by at least 40% (bracketed, so truncation
 *     is visible);
 *   - `ar-XB` is the same text with a right-to-left manifest.
 *   They pass validation only with `allowPseudo`, and the production registry schema refuses them,
 *   so they can never be part of a bundle the app loads.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** English sources (tests run from the repository root). */
export const EN_SOURCES = path.resolve(process.cwd(), "packages/shared/locales/en");

/** Flat messages per namespace (`{ namespace: { key: message } }`). */
export type PackageMessages = Record<string, Record<string, string>>;

/** A test package: its manifest fields and messages. */
export interface TestPackage {
  tag: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  messages: PackageMessages;
}

/** German translations (real, partial). */
export const GERMAN: TestPackage = {
  tag: "de",
  nativeName: "Deutsch",
  direction: "ltr",
  messages: {
    common: {
      "actions.close": "Schließen",
      "actions.retry": "Erneut versuchen",
      "language.label": "Sprache",
      "language.search": "Sprachen durchsuchen",
      "language.current": "Aktuelle Sprache",
      "language.fallback": "Auf Englisch angezeigt",
      "language.switchFailed": "Die Sprache konnte nicht geändert werden.",
      "language.addLanguage": "Eine Sprache hinzufügen",
    },
    player: {
      "join.title": "Einem Spiel beitreten",
      "join.pin": "Spiel-PIN",
      "join.pinHelp": "Gib die sechsstellige PIN ein, die die Spielleitung anzeigt.",
      "join.join": "Beitreten",
      "join.scanQr": "QR-Code scannen",
      "answer.accepted": "Antwort erhalten",
      "answer.locked": "Deine Antwort ist gespeichert und kann nicht mehr geändert werden.",
    },
  },
};

/** Arabic translations (real, partial, right-to-left). */
export const ARABIC: TestPackage = {
  tag: "ar",
  nativeName: "العربية",
  direction: "rtl",
  messages: {
    common: {
      "actions.close": "إغلاق",
      "actions.retry": "إعادة المحاولة",
      "language.label": "اللغة",
      "language.search": "البحث في اللغات",
      "language.current": "اللغة الحالية",
      "language.fallback": "معروضة بالإنجليزية",
      "language.switchFailed": "تعذّر تغيير اللغة.",
      "language.addLanguage": "إضافة لغة",
    },
    player: {
      "join.title": "الانضمام إلى لعبة",
      "join.pin": "رمز اللعبة",
      "join.pinHelp": "أدخل الرمز المكوّن من ستة أرقام الذي يعرضه المضيف.",
      "join.join": "انضمام",
      "join.scanQr": "مسح رمز QR",
      "answer.accepted": "تم استلام الإجابة",
      "answer.locked": "تم تثبيت إجابتك.",
    },
  },
};

/** Minimum pseudo-locale expansion (+40%). */
export const PSEUDO_EXPANSION = 0.4;

/** Accented look-alikes for ASCII letters (en-XA). */
const ACCENTS: Record<string, string> = Object.fromEntries(
  [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter, index) => [
    letter,
    [..."åƀçđéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇĐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ"][index] ?? letter,
  ]),
);

/**
 * Pseudo-localizes one ICU message. Only literal text outside `{…}` and outside apostrophe-quoted
 * runs is accented, so arguments, plural/select syntax and `#` stay exactly as they are. The
 * result is wrapped in `⟦…⟧` and padded so it is at least 40% longer than the source.
 */
export function pseudoMessage(message: string): string {
  let depth = 0;
  let quoted = false;
  let out = "";
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index] ?? "";
    if (char === "'" && depth === 0) {
      // `''` is a literal apostrophe; a lone `'` before `{`/`}` starts or ends a quoted run.
      const next = message[index + 1];
      if (next === "'") {
        out += "''";
        index += 1;
        continue;
      }
      if (quoted || next === "{" || next === "}") quoted = !quoted;
      out += char;
      continue;
    }
    if (!quoted && char === "{") depth += 1;
    if (!quoted && char === "}") depth -= 1;
    out += depth === 0 && !quoted ? (ACCENTS[char] ?? char) : char;
  }
  const padding = Math.max(1, Math.ceil([...message].length * PSEUDO_EXPANSION));
  return `⟦${out} ${"·".repeat(padding)}⟧`;
}

/** The English source messages of every namespace (`manifest.json` excluded). */
export async function englishMessages(namespaces: readonly string[]): Promise<PackageMessages> {
  const messages: PackageMessages = {};
  for (const namespace of namespaces)
    messages[namespace] = JSON.parse(
      await readFile(path.join(EN_SOURCES, `${namespace}.json`), "utf8"),
    ) as Record<string, string>;
  return messages;
}

/** A pseudo-locale package generated from the English sources. */
export async function pseudoPackage(
  tag: "en-XA" | "ar-XB",
  namespaces: readonly string[],
): Promise<TestPackage> {
  const source = await englishMessages(namespaces);
  const messages: PackageMessages = {};
  for (const [namespace, entries] of Object.entries(source))
    messages[namespace] = Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, pseudoMessage(value)]),
    );
  return {
    tag,
    nativeName: tag === "en-XA" ? "Pseudo English (expanded)" : "Pseudo RTL",
    direction: tag === "ar-XB" ? "rtl" : "ltr",
    messages,
  };
}

/** Writes `item` as a declarative package directory `<root>/<tag>/`. */
export async function writePackage(root: string, item: TestPackage): Promise<string> {
  const directory = path.join(root, item.tag);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        locale: item.tag,
        nativeName: item.nativeName,
        direction: item.direction,
        packageVersion: "0.1.0-test",
        catalogVersion: "1",
        credits: [{ name: "Kabuki Neko test fixtures", url: null }],
      },
      null,
      2,
    )}\n`,
  );
  for (const [namespace, entries] of Object.entries(item.messages))
    await writeFile(
      path.join(directory, `${namespace}.json`),
      `${JSON.stringify(entries, null, 2)}\n`,
    );
  return directory;
}
