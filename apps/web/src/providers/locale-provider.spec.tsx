/**
 * TASK-117 coverage: the locale provider hydrates with the server catalog, switches atomically
 * after a deferred catalog load (the old language stays usable meanwhile), keeps the old language
 * and offers a retry when a fetch fails, ignores superseded switches, persists choices to the
 * cookie and storage (memory fallback when storage is denied), applies a storage-only preference
 * after hydration (reload persistence) while an explicit cookie wins, updates <html lang/dir>
 * including RTL, and never remounts children. The picker lists the registry locales with native,
 * localized and tag search, partial-coverage hints, Escape/focus handling and the guide link.
 */
import { parse } from "@formatjs/icu-messageformat-parser";
import { LOCALE_NAMESPACES, type LocaleNamespace } from "@kabuki-neko/shared/schemas/locale.schema";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LocalePicker } from "@/components/ui/locale-picker";
import {
  SHELL_NAMESPACES,
  createCatalogLoader,
  serializeCatalog,
  type CatalogFetch,
} from "@/lib/i18n/catalog-loader";
import type { LocaleSource } from "@/lib/i18n/resolve";
import type { InitialLocale } from "@/lib/i18n/locale.server";
import type { PreferenceStorage } from "@/lib/preferences";
import {
  LocaleProvider,
  createLocalePreferences,
  useLocale,
  type LocalePreferences,
} from "./locale-provider";

const nodeCrypto = process.getBuiltinModule("node:crypto");
const nodeFs = process.getBuiltinModule("node:fs");
const LOCALES_DIR = `${process.cwd()}/../../packages/shared/locales`;
const BUILD_ID = "b".repeat(64);

/** Real namespace sources compiled like the locale build. */
function realNamespace(tag: string, name: LocaleNamespace): Record<string, unknown> {
  const messages = JSON.parse(
    nodeFs.readFileSync(`${LOCALES_DIR}/${tag}/${name}.json`, "utf8"),
  ) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      parse(value, { requiresOtherClause: true, ignoreTag: false }),
    ]),
  );
}

/** Deferred promise helper. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Registry + files for en/fr/ja (real catalogs) and a partial RTL `ar` package. */
function fixture() {
  const sources: Record<string, Partial<Record<LocaleNamespace, Record<string, unknown>>>> = {};
  for (const tag of ["en", "fr", "ja"])
    sources[tag] = Object.fromEntries(
      (["common", "accessibility", "player"] as const).map((name) => [
        name,
        realNamespace(tag, name),
      ]),
    );
  sources.ar = {
    common: Object.fromEntries(
      Object.entries({ "language.label": "اللغة", "status.unavailable": "غير متاح" }).map(
        ([key, value]) => [key, parse(value)],
      ),
    ),
  };
  const meta: Record<string, { nativeName: string; direction: "ltr" | "rtl"; coverage: number }> = {
    en: { nativeName: "English", direction: "ltr", coverage: 1 },
    fr: { nativeName: "Français", direction: "ltr", coverage: 1 },
    ja: { nativeName: "日本語", direction: "ltr", coverage: 1 },
    ar: { nativeName: "العربية", direction: "rtl", coverage: 0.4 },
  };
  const files = new Map<string, string>();
  const registry = {
    buildId: BUILD_ID,
    catalogVersion: "1",
    locales: Object.entries(sources).map(([tag, namespaces]) => ({
      tag,
      nativeName: meta[tag]?.nativeName ?? tag,
      direction: meta[tag]?.direction ?? "ltr",
      packageVersion: "1.0.0",
      coverage: meta[tag]?.coverage ?? 1,
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
  /** Per-URL gates: tests hold or fail specific files. */
  const gates = new Map<string, Promise<"ok" | "fail">>();
  const fetch = vi.fn<CatalogFetch>(async (url) => {
    const gate = gates.get(url);
    if (gate && (await gate) === "fail") return new Response("down", { status: 503 });
    const body = files.get(url);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  });
  /** Server snapshot for `tag` rendered with the given resolution source. */
  async function initial(tag: string, source: LocaleSource): Promise<InitialLocale> {
    const server = createCatalogLoader({
      registry,
      fetch: async (url) => new Response(files.get(url)),
    });
    return {
      registry,
      catalog: serializeCatalog(await server.load(tag, SHELL_NAMESPACES)),
      source,
    };
  }
  return { registry, gates, fetch, initial };
}

/** Preferences backed by a map, recording cookie writes. */
function memoryPreferences(stored: string | null = null) {
  const data = new Map<string, string>();
  if (stored) data.set("kabuki:locale", stored);
  const cookies: string[] = [];
  const storage: PreferenceStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
  const preferences = createLocalePreferences({
    storage: () => storage,
    writeCookie: (tag) => void cookies.push(tag),
  });
  return { preferences, data, cookies };
}

/** Child with local state and a mount counter, to prove switches never remount it. */
let mounts = 0;
function Probe() {
  const { t, locale, direction, pending } = useLocale();
  const [draft, setDraft] = useState(() => {
    mounts += 1;
    return "";
  });
  return (
    <div>
      <output aria-label="state">{`${locale}/${direction}/${pending ?? "-"}`}</output>
      <p data-testid="label">{t("common.language.label")}</p>
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </div>
  );
}

/** Renders the provider with the probe and the picker. */
function renderApp(
  initial: InitialLocale | null,
  preferences: LocalePreferences,
  fetch?: CatalogFetch,
) {
  const loader =
    initial && fetch ? createCatalogLoader({ registry: initial.registry, fetch }) : undefined;
  return render(
    <LocaleProvider
      initial={initial}
      preferences={preferences}
      timeZone="UTC"
      {...(loader ? { loader } : {})}
    >
      <Probe />
      <LocalePicker />
    </LocaleProvider>,
  );
}

/** Captures the latest context value of a rendered provider for imperative test calls. */
function captureLocale() {
  const holder: { value: ReturnType<typeof useLocale> | null } = { value: null };
  /** Current captured value; throws if the provider has not rendered yet. */
  const current = () => {
    if (holder.value === null) throw new Error("provider not rendered");
    return holder.value;
  };
  return { holder, current };
}

describe("LocaleProvider", () => {
  it("hydrates with the server catalog and switches atomically after a deferred load", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const { fetch, gates, initial } = fixture();
    const { preferences, data, cookies } = memoryPreferences();
    renderApp(await initial("en", "cookie"), preferences, fetch);
    expect(screen.getByTestId("label")).toHaveTextContent("Language");
    expect(document.documentElement.lang).toBe("en");
    expect(fetch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("draft"), "kept");
    const trigger = screen.getByRole("button", { name: "Language English" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Language" })).toBeInTheDocument();
    const gate = deferred<"ok" | "fail">();
    gates.set(`/locales/${BUILD_ID}/fr/common.json`, gate.promise);
    await user.click(screen.getByRole("button", { name: /^Français/u }));

    // While loading, the old language stays fully active and the option says so.
    expect(screen.getByLabelText("state")).toHaveTextContent("en/ltr/fr");
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(
      "Loading language…",
    );
    expect(screen.getByTestId("label")).toHaveTextContent("Language");
    expect(document.documentElement.lang).toBe("en");

    await act(async () => gate.resolve("ok"));
    await waitFor(() => expect(screen.getByLabelText("state")).toHaveTextContent("fr/ltr/-"));
    expect(screen.getByTestId("label")).toHaveTextContent("Langue");
    expect(document.documentElement.lang).toBe("fr");
    expect(document.documentElement.dir).toBe("ltr");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Langue Français" })).toHaveFocus();
    expect(screen.getByLabelText("draft")).toHaveValue("kept");
    expect(mounts).toBe(1);
    expect(data.get("kabuki:locale")).toBe("fr");
    expect(cookies).toEqual(["fr"]);
  });

  it("keeps the old language on a failed fetch, then retries into an RTL locale", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const { fetch, gates, initial } = fixture();
    const { preferences, cookies } = memoryPreferences();
    renderApp(await initial("en", "cookie"), preferences, fetch);
    await user.click(screen.getByRole("button", { name: "Language English" }));
    gates.set(`/locales/${BUILD_ID}/ar/common.json`, Promise.resolve("fail"));
    await user.click(screen.getByRole("button", { name: /^العربية/u }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The language couldn't be changed.");
    expect(screen.getByLabelText("state")).toHaveTextContent("en/ltr/-");
    expect(document.documentElement.dir).toBe("ltr");
    expect(cookies).toEqual([]);

    gates.delete(`/locales/${BUILD_ID}/ar/common.json`);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("state")).toHaveTextContent("ar/rtl/-"));
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    // Partial package: untranslated keys fall back to English.
    expect(screen.getByTestId("label")).toHaveTextContent("اللغة");
    expect(cookies).toEqual(["ar"]);
    expect(mounts).toBe(1);
  });

  it("ignores a superseded switch that finishes later", async () => {
    const { fetch, gates, initial } = fixture();
    const { preferences } = memoryPreferences();
    const { holder, current } = captureLocale();
    function Capture() {
      holder.value = useLocale();
      return null;
    }
    const start = await initial("en", "cookie");
    render(
      <LocaleProvider
        initial={start}
        preferences={preferences}
        loader={createCatalogLoader({ registry: start.registry, fetch })}
      >
        <Capture />
      </LocaleProvider>,
    );
    const slow = deferred<"ok" | "fail">();
    gates.set(`/locales/${BUILD_ID}/fr/common.json`, slow.promise);
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      first = current().setLocale("fr");
      second = current().setLocale("ja");
      expect(await second).toBe(true);
    });
    await act(async () => slow.resolve("ok"));
    expect(await first).toBe(false);
    expect(current().locale).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("applies a storage-only preference after hydration and writes the cookie (reload)", async () => {
    mounts = 0;
    const { fetch, initial } = fixture();
    const { preferences, cookies } = memoryPreferences("fr-CA");
    renderApp(await initial("en", "accept-language"), preferences, fetch);
    await waitFor(() => expect(screen.getByLabelText("state")).toHaveTextContent("fr/ltr/-"));
    expect(cookies).toEqual(["fr"]);
    expect(mounts).toBe(1);
  });

  it("lets an explicit cookie win over storage and survives denied storage", async () => {
    const { fetch, initial } = fixture();
    const { preferences } = memoryPreferences("ja");
    renderApp(await initial("fr", "cookie"), preferences, fetch);
    await act(async () => {});
    expect(screen.getByLabelText("state")).toHaveTextContent("fr/ltr/-");
    expect(fetch).not.toHaveBeenCalled();

    const denied = createLocalePreferences({
      storage: () => ({
        getItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      }),
      writeCookie: () => {
        throw new Error("cookies blocked");
      },
    });
    expect(denied.readStored()).toBeNull();
    expect(() => denied.save("ja")).not.toThrow();
    expect(denied.readStored()).toBe("ja");
  });

  it("loads route namespaces on demand and renders safely without a bundle", async () => {
    const { fetch, initial } = fixture();
    const { holder, current } = captureLocale();
    function Capture() {
      const api = useLocale();
      holder.value = api;
      return <p data-testid="seconds">{api.t("player.answer.secondsRemaining", { seconds: 2 })}</p>;
    }
    const start = await initial("fr", "cookie");
    const { unmount } = render(
      <LocaleProvider
        initial={start}
        preferences={memoryPreferences().preferences}
        loader={createCatalogLoader({ registry: start.registry, fetch })}
      >
        <Capture />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("seconds")).toHaveTextContent("Indisponible");
    await act(async () => {
      expect(await current().ensureNamespaces(["player"])).toBe(true);
    });
    expect(screen.getByTestId("seconds")).toHaveTextContent("2 secondes restantes");
    unmount();

    render(
      <LocaleProvider initial={null} preferences={memoryPreferences().preferences}>
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("label")).toHaveTextContent("…");
    expect(() => render(<Probe />)).toThrow("useLocale must be used inside LocaleProvider");
  });
});

describe("server snapshot", () => {
  it("serializes to plain objects only (React Server Components reject null prototypes)", async () => {
    const { initial } = fixture();
    const snapshot = await initial("fr", "cookie");
    const offenders: string[] = [];
    const visit = (value: unknown, where: string) => {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${where}[${index}]`));
      else if (value !== null && typeof value === "object") {
        if (Object.getPrototypeOf(value) !== Object.prototype) offenders.push(where);
        for (const [key, item] of Object.entries(value)) visit(item, `${where}.${key}`);
      }
    };
    visit(snapshot.catalog, "catalog");
    expect(offenders).toEqual([]);
    expect(JSON.stringify(snapshot.catalog)).toContain('"pluralType":"cardinal"');
  });
});

describe("LocalePicker", () => {
  it("lists registry locales with native, localized and tag search and the guide link", async () => {
    const user = userEvent.setup();
    const { fetch, initial } = fixture();
    renderApp(await initial("fr", "cookie"), memoryPreferences().preferences, fetch);
    const trigger = screen.getByRole("button", { name: "Langue Français" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Langue / Language" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Langue" });
    expect(list.querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /^Français/u })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const arabic = screen.getByRole("button", { name: /^العربية/u });
    expect(arabic).toHaveTextContent("arabe · ar · Affiché en anglais");
    expect(arabic.querySelector("[lang='ar']")).toHaveAttribute("dir", "rtl");

    const search = screen.getByLabelText("Rechercher une langue");
    expect(search).toHaveFocus();
    await user.type(search, "japon");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^日本語/u })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "FRANCAIS");
    expect(screen.getByRole("button", { name: /^Français/u })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zz-none");
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(
      "Aucune langue ne correspond",
    );
    expect(screen.getByRole("link", { name: "Ajouter une langue" })).toHaveAttribute(
      "href",
      "/help/languages",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
