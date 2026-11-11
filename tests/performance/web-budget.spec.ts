/**
 * TASK-180 unit tests of the web budget measurement (scripts/measure-web-budget.ts):
 * - resource classification and gzip accounting (each URL counted once, framework included);
 * - medians;
 * - refusal of development builds;
 * - explicit failure of every budget threshold.
 */
import { describe, expect, it } from "vitest";
import {
  BUDGETS,
  accountResources,
  budgetVerdict,
  classifyResource,
  gzipSize,
  isDevelopmentBuild,
  median,
  type Resource,
} from "../../scripts/measure-web-budget";

const ORIGIN = "http://127.0.0.1:3000";
const BUILD = "a".repeat(64);

describe("resource accounting", () => {
  it("classifies scripts, catalogs, fonts, media, styles and API traffic", () => {
    expect(classifyResource(`${ORIGIN}/_next/static/chunks/abc.js`, "script")).toBe("js");
    expect(classifyResource(`${ORIGIN}/locales/${BUILD}/ja/player.json`, "fetch")).toBe("locale");
    expect(classifyResource(`${ORIGIN}/locales/registry.json`, "fetch")).toBe("other");
    expect(classifyResource(`${ORIGIN}/fonts/noto-sans-latin.woff2`, "font")).toBe("font");
    expect(classifyResource(`${ORIGIN}/brand/logo.svg`, "image")).toBe("media");
    expect(classifyResource(`${ORIGIN}/audio/01-lobby/a.webm`, "media")).toBe("media");
    expect(classifyResource(`${ORIGIN}/_next/static/css/app.css`, "stylesheet")).toBe("css");
    expect(classifyResource("http://127.0.0.1:3001/api/v1/system/public-config", "fetch")).toBe(
      "api",
    );
    expect(classifyResource(`${ORIGIN}/join`, "document")).toBe("document");
  });

  it("gzips at level 9 and shrinks repetitive code", () => {
    const code = "function hello(){return 'world'}\n".repeat(200);
    expect(gzipSize(code)).toBeLessThan(code.length / 10);
    expect(gzipSize(Buffer.from(code))).toBe(gzipSize(code));
  });

  it("sums each URL once per kind and lists the JS manifest by gzip size", () => {
    const resources: Resource[] = [
      {
        url: `${ORIGIN}/_next/static/chunks/framework.js`,
        kind: "js",
        rawBytes: 300_000,
        gzipBytes: 90_000,
      },
      {
        url: `${ORIGIN}/_next/static/chunks/page.js`,
        kind: "js",
        rawBytes: 40_000,
        gzipBytes: 12_000,
      },
      // The same chunk seen twice (e.g. preload + script) counts once.
      {
        url: `${ORIGIN}/_next/static/chunks/page.js`,
        kind: "js",
        rawBytes: 40_000,
        gzipBytes: 12_000,
      },
      { url: `${ORIGIN}/fonts/noto.woff2`, kind: "font", rawBytes: 50_000, gzipBytes: 50_000 },
      { url: `${ORIGIN}/brand/logo.svg`, kind: "media", rawBytes: 2_000, gzipBytes: 2_000 },
      {
        url: `${ORIGIN}/locales/${BUILD}/en/player.json`,
        kind: "locale",
        rawBytes: 9_000,
        gzipBytes: 3_000,
      },
    ];
    const account = accountResources(resources);
    expect(account.js).toEqual({ count: 2, rawBytes: 340_000, gzipBytes: 102_000 });
    expect(account.font.rawBytes).toBe(50_000);
    expect(account.media.rawBytes).toBe(2_000);
    expect(account.locale.gzipBytes).toBe(3_000);
    expect(account.manifest.map((item) => item.file)).toEqual([
      "/_next/static/chunks/framework.js",
      "/_next/static/chunks/page.js",
    ]);
  });

  it("takes the median of odd and even samples", () => {
    expect(median([3_100, 2_900, 4_500, 3_000, 3_200])).toBe(3_100);
    expect(median([1, 4])).toBe(2.5);
    expect(() => median([])).toThrow("no values");
  });

  it("recognizes development builds so their numbers are never reported", () => {
    expect(isDevelopmentBuild('<script src="/_next/static/chunks/main.js"></script>')).toBe(false);
    expect(isDevelopmentBuild('<script src="/_next/webpack-hmr"></script>')).toBe(true);
    expect(isDevelopmentBuild("self.$RefreshReg$ = react-refresh")).toBe(true);
    expect(
      isDevelopmentBuild('<script src="/_next/static/development/_buildManifest.js"></script>'),
    ).toBe(true);
  });
});

describe("budget verdict", () => {
  const passing = {
    initialJsGzipBytes: BUDGETS.initialJsGzipBytes,
    localeGzipBytes: { en: BUDGETS.initialLocaleGzipBytes, ja: 10_000 },
    lcpMedianMs: { "join en": BUDGETS.lcpMs },
    clsMedian: { "join en": BUDGETS.cls },
    lazyViolations: [],
  };

  it("passes exactly at every threshold", () => {
    expect(budgetVerdict(passing)).toEqual({ pass: true, failures: [] });
  });

  it("fails every exceeded threshold explicitly", () => {
    const verdict = budgetVerdict({
      initialJsGzipBytes: BUDGETS.initialJsGzipBytes + 1,
      localeGzipBytes: { ar: BUDGETS.initialLocaleGzipBytes + 1 },
      lcpMedianMs: { "join en": BUDGETS.lcpMs + 1 },
      clsMedian: { "join de": 0.25 },
      lazyViolations: ["QR decoder (ZXing) is in the /join boot"],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toEqual([
      "initial JS 300.0 KiB gzip > 300.0 KiB",
      "locale ar 50.0 KiB gzip > 50.0 KiB",
      "join en median LCP 4001 ms > 4000 ms",
      "join de median CLS 0.250 > 0.1",
      "not lazy: QR decoder (ZXing) is in the /join boot",
    ]);
  });
});
