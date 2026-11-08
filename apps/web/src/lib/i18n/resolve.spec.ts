/**
 * TASK-116 coverage for the locale runtime: the full SA §8.2 browser match table (including no
 * false Simplified match when zh-Hant is absent and script-safe external variants), Accept-Language
 * weighting, preference precedence with malformed/removed locales, the kn_locale cookie, the catalog
 * loader (hash verification, failed/retried namespaces, removed locale, markup rejection, request
 * deduplication, pure-JS SHA-256 fallback) and ICU formatting with the real en/fr catalogs
 * (plural, numbers, dates in a fixed time zone, en fallback and the safe unknown-key text).
 */
import { parse } from "@formatjs/icu-messageformat-parser";
import { LOCALE_NAMESPACES, type LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import { describe, expect, it, vi } from "vitest";
import {
  CatalogLoadError,
  createCatalogLoader,
  sha256Hex,
  sha256HexSync,
  type CatalogFetch,
} from "./catalog-loader";
import { createTranslator, LAST_RESORT_TEXT, type I18nDiagnostic } from "./format";
import {
  canonicalTag,
  matchLocale,
  parseAcceptLanguage,
  readLocaleCookie,
  resolveLocale,
  serializeLocaleCookie,
} from "./resolve";

const nodeCrypto = process.getBuiltinModule("node:crypto");
const nodeFs = process.getBuiltinModule("node:fs");
/** Repository locale sources (Vitest runs in apps/web). */
const LOCALES_DIR = `${process.cwd()}/../../packages/shared/locales`;
const BUILTINS = ["en", "id", "ja", "zh-Hans", "es", "fr"];
const BUILD_ID = "a".repeat(64);

/** Compiles flat ICU messages exactly like the locale build (no markup, `other` required). */
function compile(messages: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      parse(value, { requiresOtherClause: true, ignoreTag: false }),
    ]),
  );
}

/** Reads one real namespace source file of the repository. */
function source(tag: string, namespace: LocaleNamespace): Record<string, string> {
  return JSON.parse(
    nodeFs.readFileSync(`${LOCALES_DIR}/${tag}/${namespace}.json`, "utf8"),
  ) as Record<string, string>;
}

/** A served registry plus its files, with the same hashing/URL layout as `pnpm locales:build`. */
function bundle(
  locales: Record<string, Partial<Record<LocaleNamespace, Record<string, unknown>>>>,
  directions: Record<string, "ltr" | "rtl"> = {},
) {
  const files = new Map<string, string>();
  const registry = {
    buildId: BUILD_ID,
    catalogVersion: "1",
    locales: Object.entries(locales).map(([tag, namespaces]) => ({
      tag,
      nativeName: tag,
      direction: directions[tag] ?? "ltr",
      packageVersion: "1.0.0",
      coverage: 1,
      catalogVersion: "1",
      namespaces: LOCALE_NAMESPACES.map((name) => {
        const content = JSON.stringify(namespaces[name] ?? {});
        const url = `/locales/${BUILD_ID}/${tag}/${name}.json`;
        files.set(url, content);
        return {
          name,
          url,
          sha256: nodeCrypto.createHash("sha256").update(content, "utf8").digest("hex"),
        };
      }),
    })),
  };
  const fetch = vi.fn<CatalogFetch>(async (url) => {
    const body = files.get(url);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  });
  return { registry, files, fetch };
}

describe("matchLocale — SA §8.2 browser table with the six built-ins", () => {
  it.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["id-ID", "id"],
    ["ja-JP", "ja"],
    ["es-MX", "es"],
    ["fr-CA", "fr"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-Hans-CN", "zh-Hans"],
    ["zh-Hans-HK", "zh-Hans"],
    ["zh", "zh-Hans"],
    ["ZH-hans", "zh-Hans"],
    ["en-US-u-ca-buddhist", "en"],
  ])("%s → %s", (requested, expected) => {
    expect(matchLocale(requested, BUILTINS)).toBe(expected);
  });

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-CN"])(
    "%s never falls back to Simplified when zh-Hant is not installed",
    (requested) => {
      expect(matchLocale(requested, BUILTINS)).toBeNull();
    },
  );

  it("uses an installed zh-Hant for Traditional regions and keeps Simplified separate", () => {
    const installed = [...BUILTINS, "zh-Hant"];
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW"])
      expect(matchLocale(tag, installed)).toBe("zh-Hant");
    for (const tag of ["zh-CN", "zh-SG", "zh"]) expect(matchLocale(tag, installed)).toBe("zh-Hans");
  });

  it.each(["xx", "en_US", "@@", "", "e".repeat(64), "en-US/../fr", "tlh-QQ-x"])(
    "rejects unknown or malformed %j",
    (requested) => {
      expect(matchLocale(requested, BUILTINS)).toBeNull();
    },
  );

  it("matches external script variants without crossing an explicit or implied script", () => {
    expect(matchLocale("sr-Latn-RS", ["en", "sr-Latn"])).toBe("sr-Latn");
    expect(matchLocale("sr-RS", ["en", "sr-Latn"])).toBeNull(); // sr implies Cyrillic
    expect(matchLocale("sr-Latn", ["en", "sr"])).toBeNull(); // base sr is Cyrillic
    expect(matchLocale("sr-Cyrl-RS", ["en", "sr"])).toBe("sr"); // base agrees with the script
    expect(matchLocale("uz-Cyrl", ["en", "uz"])).toBeNull();
    expect(matchLocale("pa-Arab-PK", ["en", "pa", "pa-Arab"])).toBe("pa-Arab");
  });

  it("prefers same region, then language-script, then base, then another region", () => {
    expect(matchLocale("es-MX", ["en", "es-419", "es"])).toBe("es");
    expect(matchLocale("es-MX", ["en", "es-MX", "es"])).toBe("es-MX");
    expect(matchLocale("en-AU", ["en", "en-GB"])).toBe("en");
    expect(matchLocale("pt-BR", ["en", "pt-PT"])).toBe("pt-PT");
    expect(matchLocale("zh-CN", ["en", "zh", "zh-Hans"])).toBe("zh-Hans");
  });
});

describe("parseAcceptLanguage", () => {
  it("orders by quality, keeps header order for ties and drops q=0, * and malformed entries", () => {
    expect(
      parseAcceptLanguage(
        "fr-CA;q=0.8, ja , *;q=0.5, en_US, zh-TW;q=0.8, de;q=0, es;q=2, id;q=0.9",
      ),
    ).toEqual(["ja", "id", "fr-CA", "zh-TW"]);
    expect(parseAcceptLanguage(" en-GB ; level=1 ; q=0.7 ,fr;q=1.000")).toEqual(["fr", "en-GB"]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });

  it("bounds hostile headers", () => {
    const many = Array.from({ length: 100 }, (_, index) => `x${index % 10}`).join(",");
    expect(parseAcceptLanguage(`${many},ja`)).not.toContain("ja");
    expect(parseAcceptLanguage(`${"a".repeat(5000)},en`)).toEqual([]);
  });
});

describe("resolveLocale precedence", () => {
  const installed = BUILTINS;

  it("cookie → storage → Accept-Language → instance default → en", () => {
    const base = { installed, acceptLanguage: "ja-JP,fr;q=0.5", instanceDefault: "id" };
    expect(resolveLocale({ ...base, cookie: "es", stored: "fr" })).toEqual({
      locale: "es",
      source: "cookie",
    });
    expect(resolveLocale({ ...base, stored: "fr-CA" })).toEqual({
      locale: "fr",
      source: "storage",
    });
    expect(resolveLocale(base)).toEqual({ locale: "ja", source: "accept-language" });
    expect(resolveLocale({ ...base, acceptLanguage: "de-DE" })).toEqual({
      locale: "id",
      source: "default",
    });
    expect(resolveLocale({ installed, instanceDefault: "de" })).toEqual({
      locale: "en",
      source: "fallback",
    });
  });

  it("skips removed or malformed preferences and the absent zh-Hant", () => {
    expect(
      resolveLocale({ installed, cookie: "de", stored: "en_US", acceptLanguage: "zh-TW,fr;q=0.4" }),
    ).toEqual({ locale: "fr", source: "accept-language" });
    expect(resolveLocale({ installed, cookie: "zh-Hant", acceptLanguage: "zh-HK" })).toEqual({
      locale: "en",
      source: "fallback",
    });
    expect(
      resolveLocale({ installed, acceptLanguage: "zh-TW", instanceDefault: "zh-Hans" }),
    ).toEqual({ locale: "zh-Hans", source: "default" });
  });
});

describe("kn_locale cookie", () => {
  it("reads the canonical value among other cookies and rejects malformed values", () => {
    expect(readLocaleCookie("theme=dark; kn_locale=zh-hans; other=1")).toBe("zh-Hans");
    expect(readLocaleCookie("kn_locale=fr%2DCA")).toBe("fr-CA");
    expect(readLocaleCookie("kn_locale=%E0%A4%A")).toBeNull();
    expect(readLocaleCookie("kn_locale=en;US")).toBe("en");
    expect(readLocaleCookie("xkn_locale=fr")).toBeNull();
    expect(readLocaleCookie(undefined)).toBeNull();
  });

  it("serializes Path=/, one-year Max-Age, SameSite=Lax and Secure on HTTPS", () => {
    expect(serializeLocaleCookie("zh-hans", { secure: true })).toBe(
      "kn_locale=zh-Hans; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(serializeLocaleCookie("id", { secure: false })).toBe(
      "kn_locale=id; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(() => serializeLocaleCookie("en; Domain=evil", { secure: true })).toThrow(
      "INVALID_LOCALE",
    );
    expect(canonicalTag(" fr-ca ")).toBe("fr-CA");
  });
});

describe("catalog loader", () => {
  const sample = {
    en: { common: compile({ "status.unavailable": "Unavailable", "actions.close": "Close" }) },
    fr: { common: compile({ "status.unavailable": "Indisponible" }) },
    ar: { common: compile({ "status.unavailable": "غير متاح" }) },
  };

  it("loads only the needed namespaces plus common for the locale and the en fallback", async () => {
    const { registry, fetch } = bundle(sample, { ar: "rtl" });
    const loader = createCatalogLoader({ registry, fetch });
    expect(loader.installed).toEqual(["en", "fr", "ar"]);
    const catalog = await loader.load("ar", ["player"]);
    expect(catalog).toMatchObject({ tag: "ar", direction: "rtl", buildId: BUILD_ID });
    expect([...catalog.namespaces.keys()]).toEqual(["common", "player"]);
    expect([...catalog.fallback.keys()]).toEqual(["common", "player"]);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(
      [
        `/locales/${BUILD_ID}/ar/common.json`,
        `/locales/${BUILD_ID}/ar/player.json`,
        `/locales/${BUILD_ID}/en/common.json`,
        `/locales/${BUILD_ID}/en/player.json`,
      ].sort(),
    );
    // Concurrent and repeated loads reuse the same requests.
    await Promise.all([loader.load("ar", ["player"]), loader.load("en", ["player"])]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects a removed locale, an invalid registry and a tampered file", async () => {
    const { registry, files, fetch } = bundle(sample);
    const loader = createCatalogLoader({ registry, fetch });
    await expect(loader.load("de", [])).rejects.toMatchObject({ code: "LOCALE_NOT_INSTALLED" });
    expect(() => createCatalogLoader({ registry: { ...registry, buildId: "x" }, fetch })).toThrow(
      CatalogLoadError,
    );
    expect(() =>
      createCatalogLoader({
        registry: { ...registry, locales: registry.locales.filter((item) => item.tag !== "en") },
        fetch,
      }),
    ).toThrow("INVALID_REGISTRY");
    files.set(`/locales/${BUILD_ID}/fr/common.json`, JSON.stringify(sample.en.common));
    await expect(loader.load("fr", [])).rejects.toMatchObject({
      code: "HASH_MISMATCH",
      locale: "fr",
      namespace: "common",
    });
  });

  it("fails a namespace atomically and retries it on the next load", async () => {
    const { registry, fetch } = bundle(sample);
    const loader = createCatalogLoader({ registry, fetch });
    fetch.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    await expect(loader.load("fr", ["host"])).rejects.toMatchObject({
      code: "NAMESPACE_FETCH_FAILED",
    });
    fetch.mockImplementationOnce(async () => {
      throw new TypeError("network");
    });
    await expect(loader.load("fr", ["host"])).rejects.toMatchObject({
      code: "NAMESPACE_FETCH_FAILED",
    });
    const catalog = await loader.load("fr", ["host"]);
    expect(catalog.namespaces.get("common")?.has("status.unavailable")).toBe(true);
  });

  it("rejects markup, unknown element types, missing other branches and hostile keys", async () => {
    const tag = [{ type: 8, value: "b", children: [{ type: 0, value: "x" }] }];
    const noOther = [{ type: 5, value: "kind", options: { a: { value: [] } } }];
    for (const bad of [
      { "status.unavailable": tag },
      { "status.unavailable": [{ type: 42, value: "x" }] },
      { "status.unavailable": noOther },
      { "status.unavailable": [{ type: 1, value: "__proto__" }] },
      { "Bad Key": [{ type: 0, value: "x" }] },
      { "status.unavailable": "<b>plain string</b>" },
    ]) {
      const { registry, fetch } = bundle({ en: { common: bad } });
      await expect(createCatalogLoader({ registry, fetch }).load("en", [])).rejects.toMatchObject({
        code: "INVALID_CATALOG",
      });
    }
  });

  it("hashes with a pure-JS SHA-256 when Web Crypto is unavailable (plain-HTTP LAN)", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
      const bytes = nodeCrypto.randomBytes(length);
      const expected = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
      expect(sha256HexSync(new Uint8Array(bytes))).toBe(expected);
      expect(await sha256Hex(new Uint8Array(bytes))).toBe(expected);
    }
    vi.stubGlobal("crypto", {});
    const { registry, fetch } = bundle(sample);
    await expect(createCatalogLoader({ registry, fetch }).load("fr", [])).resolves.toMatchObject({
      tag: "fr",
    });
  });
});

describe("formatting with the real en/fr catalogs", () => {
  const namespaces: LocaleNamespace[] = ["common", "player", "host", "reports"];
  const real = Object.fromEntries(
    ["en", "fr"].map((tag) => [
      tag,
      Object.fromEntries(namespaces.map((name) => [name, compile(source(tag, name))])),
    ]),
  );

  /** Loads a translator for `tag` from the real catalogs (optionally minus some fr keys). */
  async function translator(
    tag: string,
    timeZone: string,
    edit?: (fr: Record<string, unknown>) => void,
  ) {
    const fr = { ...(real.fr?.player ?? {}) };
    edit?.(fr);
    const { registry, fetch } = bundle({ en: real.en ?? {}, fr: { ...real.fr, player: fr } });
    const diagnostics: I18nDiagnostic[] = [];
    const catalog = await createCatalogLoader({ registry, fetch }).load(tag, namespaces);
    return {
      i18n: createTranslator(catalog, { timeZone, onDiagnostic: (item) => diagnostics.push(item) }),
      diagnostics,
    };
  }

  it("applies plural rules, locale number formats and pinned time zones", async () => {
    const { i18n } = await translator("fr", "Asia/Jakarta");
    expect(i18n.t("player.answer.secondsRemaining", { seconds: 0 })).toBe("Plus de temps");
    expect(i18n.t("player.answer.secondsRemaining", { seconds: 1 })).toBe("1 seconde restante");
    expect(i18n.t("player.answer.secondsRemaining", { seconds: 5 })).toBe("5 secondes restantes");
    const number = new Intl.NumberFormat("fr");
    expect(i18n.t("host.lobby.playerCount", { count: 1234, capacity: 2000 })).toBe(
      `${number.format(1234)} joueurs sur ${number.format(2000)}`,
    );
    expect(i18n.formatNumber(1234.5)).toMatch(/^1[\u00a0\u202f]234,5$/u);
    const ended = i18n.t("reports.detail.sessionEndedAt", { endedAt: 0, timezone: "WIB" });
    expect(ended).toMatch(/^Terminée le 1 janv\. 1970 à 07:00 \(WIB\)$/u);
    expect(i18n.timeZone).toBe("Asia/Jakarta");
    expect(i18n.timeZoneLabel(0)).toBe("UTC+7");

    const utc = (await translator("en", "UTC")).i18n;
    expect(utc.t("reports.detail.sessionEndedAt", { endedAt: 0, timezone: "UTC" })).toMatch(
      /^Ended Jan 1, 1970 at 12:00\sAM \(UTC\)$/u,
    );
    expect(utc.formatDate(Date.UTC(2026, 10, 8, 23, 30), { dateStyle: "medium" })).toBe(
      "Nov 8, 2026",
    );
    expect((await translator("en", "Not/AZone")).i18n.timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("falls back to en for a missing translation and never shows a raw key", async () => {
    const { i18n, diagnostics } = await translator("fr", "UTC", (fr) => {
      delete fr["answer.secondsRemaining"];
    });
    expect(i18n.t("player.answer.secondsRemaining", { seconds: 1 })).toBe("1 second left");
    expect(i18n.t("player.does.not.exist")).toBe("Indisponible");
    expect(i18n.t("nonsense")).toBe("Indisponible");
    expect(i18n.t("admin.notLoaded.key")).toBe("Indisponible");
    // Missing placeholder value → safe text, not a throw.
    expect(i18n.t("host.lobby.playerCount", { count: 1 })).toBe("Indisponible");
    expect(i18n.has("common.status.unavailable")).toBe(true);
    expect(i18n.has("player.does.not.exist")).toBe(false);
    expect(diagnostics).toEqual([
      { code: "MISSING_TRANSLATION", key: "player.answer.secondsRemaining", locale: "fr" },
      { code: "UNKNOWN_KEY", key: "player.does.not.exist", locale: "fr" },
      { code: "UNKNOWN_KEY", key: "nonsense", locale: "fr" },
      { code: "UNKNOWN_KEY", key: "admin.notLoaded.key", locale: "fr" },
      { code: "FORMAT_ERROR", key: "host.lobby.playerCount", locale: "fr" },
    ]);
  });

  it("returns plain text for markup-looking values and survives a throwing diagnostic sink", async () => {
    const { registry, fetch } = bundle({
      en: { common: compile({ "label.raw": "'<'b>{name}'<'/b>" }) },
    });
    const catalog = await createCatalogLoader({ registry, fetch }).load("en", []);
    const i18n = createTranslator(catalog, {
      onDiagnostic: () => {
        throw new Error("sink failed");
      },
    });
    expect(i18n.t("common.label.raw", { name: "<img src=x onerror=alert(1)>" })).toBe(
      "<b><img src=x onerror=alert(1)></b>",
    );
    expect(i18n.t("common.missing.key")).toBe(LAST_RESORT_TEXT);
  });
});
