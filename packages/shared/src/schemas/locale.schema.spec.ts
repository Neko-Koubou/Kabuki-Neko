import { describe, expect, it } from "vitest";
import {
  fullMessageKeySchema,
  LOCALE_NAMESPACES,
  localeEntrySchema,
  localeManifestSchema,
  localeRegistrySchema,
  messageContractsSchema,
  namespaceMessagesSchema,
  packageVersionSchema,
  pseudoLocaleManifestSchema,
} from "./locale.schema";
const manifest = {
  schemaVersion: 1,
  locale: "ar",
  nativeName: "العربية",
  direction: "rtl",
  packageVersion: "1.2.3-beta.1+build.001",
  catalogVersion: "1",
  credits: [{ name: "Translator", url: "https://example.org/credits" }],
};
const hash = "a".repeat(64);
function entry(tag: string, coverage = 1) {
  return {
    tag,
    nativeName: tag,
    direction: tag === "ar" ? "rtl" : "ltr",
    packageVersion: "1.0.0",
    catalogVersion: "1",
    coverage,
    namespaces: LOCALE_NAMESPACES.map((name) => ({
      name,
      url: `/locales/${hash}/${tag}/${name}.json`,
      sha256: hash,
    })),
  };
}

describe("extensible locale manifests", () => {
  it("accepts RTL/seventh-language packages with canonical BCP47 and strict semver", () => {
    expect(localeManifestSchema.parse(manifest).direction).toBe("rtl");
    expect(
      localeManifestSchema.parse({ ...manifest, locale: "de-de", direction: "ltr" }).locale,
    ).toBe("de-DE");
    for (const version of ["1.0.0", "0.0.1", "2.3.4-alpha-beta.0+001"])
      expect(packageVersionSchema.parse(version)).toBe(version);
    for (const version of ["1.0", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "latest", "v1.2.3"])
      expect(packageVersionSchema.safeParse(version).success).toBe(false);
  });
  it("rejects path/script/version/credential injection and reserved production pseudolocales", () => {
    for (const locale of ["../en", "en/../../x", "en<script>", "en_XA", "en-XA", "ar-XB"])
      expect(localeManifestSchema.safeParse({ ...manifest, locale }).success).toBe(false);
    expect(pseudoLocaleManifestSchema.parse({ ...manifest, locale: "en-XA" }).locale).toBe("en-XA");
    expect(localeManifestSchema.safeParse({ ...manifest, catalogVersion: "2" }).success).toBe(
      false,
    );
    expect(localeManifestSchema.safeParse({ ...manifest, executable: "index.js" }).success).toBe(
      false,
    );
    for (const url of [
      "javascript:alert(1)",
      "http://example.com/",
      "https://user:secret@example.com/",
    ])
      expect(
        localeManifestSchema.safeParse({ ...manifest, credits: [{ name: "Translator", url }] })
          .success,
      ).toBe(false);
  });
});
describe("message contracts and data-only catalogs", () => {
  it("requires descriptions, exact namespaces and typed named placeholders", () => {
    const contracts = {
      "player.answer.remaining": {
        description: "Remaining input seconds.",
        placeholders: { seconds: "number" },
        required: true,
      },
      "reports.endedAt": {
        description: "Session end date.",
        placeholders: { endedAt: "date" },
        required: true,
      },
    };
    expect(messageContractsSchema.parse(contracts)).toEqual(contracts);
    for (const value of [
      { placeholders: {}, required: true },
      { description: "", placeholders: {}, required: true },
      { description: "x", placeholders: { count: "object" }, required: true },
      { description: "x", placeholders: { constructor: "string" }, required: true },
    ])
      expect(messageContractsSchema.safeParse({ "common.test": value }).success).toBe(false);
    for (const key of [
      "unknown.test",
      "Common.test",
      "common",
      "common.bad-key",
      "../common.title",
    ])
      expect(fullMessageKeySchema.safeParse(key).success).toBe(false);
  });
  it("rejects HTML/script values, malformed Unicode, oversized namespaces and nested objects", () => {
    expect(
      namespaceMessagesSchema.parse({ greeting: "مرحبا", countdown: "{seconds, number}" }),
    ).toEqual({ greeting: "مرحبا", countdown: "{seconds, number}" });
    for (const value of [
      "<script>alert(1)</script>",
      "<b>text</b>",
      "\uD800",
      "",
      "a".repeat(4001),
    ])
      expect(namespaceMessagesSchema.safeParse({ test: value }).success).toBe(false);
    expect(namespaceMessagesSchema.safeParse({ nested: { test: "text" } }).success).toBe(false);
    const oversized = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`key${i}`, "界".repeat(1000)]),
    );
    expect(namespaceMessagesSchema.safeParse(oversized).success).toBe(false);
  });
});
describe("built locale registry", () => {
  it("requires complete en fallback and unique locale/namespace identities", () => {
    const registry = {
      buildId: hash,
      catalogVersion: "1",
      locales: [entry("en"), entry("ar", 0.5)],
    };
    expect(localeRegistrySchema.parse(registry).locales).toHaveLength(2);
    expect(localeRegistrySchema.safeParse({ ...registry, locales: [entry("ar")] }).success).toBe(
      false,
    );
    expect(
      localeRegistrySchema.safeParse({ ...registry, locales: [entry("en", 0.5)] }).success,
    ).toBe(false);
    expect(
      localeRegistrySchema.safeParse({ ...registry, locales: [entry("en"), entry("en")] }).success,
    ).toBe(false);
    const en = entry("en");
    expect(
      localeEntrySchema.safeParse({
        ...en,
        namespaces: [...en.namespaces.slice(1), en.namespaces[1]],
      }).success,
    ).toBe(false);
  });
  it("validates generated same-origin paths, build hash and exact tag/namespace matching", () => {
    const en = entry("en");
    for (const url of [
      "https://evil.test/messages.json",
      `/locales/${hash}/../en/common.json`,
      `/locales/${hash}/id/common.json`,
      `/locales/${hash}/en/common.json?x=1`,
    ])
      expect(
        localeEntrySchema.safeParse({
          ...en,
          namespaces: en.namespaces.map((asset, i) => (i === 0 ? { ...asset, url } : asset)),
        }).success,
      ).toBe(false);
    expect(
      localeRegistrySchema.safeParse({
        buildId: "b".repeat(64),
        catalogVersion: "1",
        locales: [en],
      }).success,
    ).toBe(false);
  });
});
