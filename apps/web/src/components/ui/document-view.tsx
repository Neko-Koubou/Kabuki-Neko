"use client";
/**
 * F20 readable document view for About (public S13 and dashboard) and the public language-package
 * guide (Design §4.5; SA §8.2; US-19/21; TASK-149).
 *
 * - `DocumentView`: a shared, readable layout (prose width, wraps at 320 px and at 140 % text
 *   size, landmarks and headings) with the five states.
 * - `AboutDocument`:
 *   - shows the real build version from `GET /system/about`; "Version unknown" when it can't load,
 *     and never a made-up one;
 *   - links the official license and third-party notices at the URLs the server publishes;
 *   - shows the official license text in its original language (`lang="en"`), with a translated
 *     label stating that the original applies;
 *   - includes the music and sound credits (packaged CREDITS via the shared CreditsModal) and the
 *     note that code and audio are licensed separately;
 *   - never restates legal terms more broadly than the official text.
 * - `LanguageGuide`: the documented steps (template, validate, install, build, restart, rollback),
 *   the real `/locales/template-v1.zip` download, and the installed languages with their coverage
 *   from `/locales/registry.json`. A missing registry says so instead of inventing a list.
 * States:
 * - loading;
 * - empty: version unknown;
 * - ideal;
 * - partial: original text in another language;
 * - error: source unavailable, with retry and the official link kept.
 */
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { localeRegistrySchema } from "@kabuki-neko/shared/schemas/locale.schema";
import { aboutSchema } from "@kabuki-neko/shared/schemas/system.schema";
import { CreditsButton } from "@/components/common/CreditsModal";
import { ActionButton } from "@/components/ui/action-button";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Official documents published with the app (same paths `/system/about` returns). */
export const LEGAL_LICENSE_URL = "/legal/LICENSE.txt";
export const LEGAL_NOTICES_URL = "/legal/THIRD-PARTY-NOTICES.txt";
/** Translation template package served by the web app. */
export const LOCALE_TEMPLATE_URL = "/locales/template-v1.zip";
/** Installed locale registry served by the web app. */
export const LOCALE_REGISTRY_URL = "/locales/registry.json";

/** Load state of one source. */
type Source<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

/** Loads `load` once (and again on retry). */
function useSource<T>(load: () => Promise<T>) {
  const [state, setState] = useState<Source<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    load().then(
      (value) => alive && setState({ status: "ready", value }),
      () => alive && setState({ status: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

/** Fetches a same-origin text document. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Props of {@link DocumentView}. */
export interface DocumentViewProps {
  title: string;
  children: ReactNode;
}

/** Shared readable document layout. */
export function DocumentView({ title, children }: DocumentViewProps) {
  return (
    <article className="mx-auto flex w-full max-w-prose flex-col gap-6 py-6 text-body break-words">
      <h1 className="text-title font-bold">{title}</h1>
      {children}
    </article>
  );
}

/** Props of {@link AboutDocument}. */
export interface AboutDocumentProps {
  /** Version loader (tests); defaults to `GET /system/about`. */
  loadVersion?: () => Promise<string>;
  /** Official license text loader (tests); defaults to the published file. */
  loadLicense?: () => Promise<string>;
  /** Credits loader (tests); defaults to the packaged CREDITS. */
  loadCredits?: () => Promise<string>;
}

/** S13/F20: About with version, official legal links and text, and audio credits. */
export function AboutDocument({ loadVersion, loadLicense, loadCredits }: AboutDocumentProps) {
  const { t, locale, ensureNamespaces } = useLocale();
  const { api } = useAuth();
  const versionLoader = useCallback(
    () =>
      loadVersion
        ? loadVersion()
        : api
            .request({ path: "/system/about", schema: aboutSchema })
            .then(({ data }) => data.version),
    [api, loadVersion],
  );
  const licenseLoader = useCallback(
    () => (loadLicense ? loadLicense() : fetchText(LEGAL_LICENSE_URL)),
    [loadLicense],
  );
  const version = useSource(versionLoader);
  const license = useSource(licenseLoader);

  useEffect(() => {
    void ensureNamespaces(["about"]);
  }, [ensureNamespaces]);

  return (
    <DocumentView title={t("about.document.title")}>
      <section className="flex flex-col gap-2" aria-label={t("about.document.version")}>
        {version.state.status === "loading" ? (
          <p role="status" className="text-muted-foreground">
            {t("about.inventory.f20.loading")}
          </p>
        ) : version.state.status === "ready" ? (
          <p>
            <span className="font-semibold">Kabuki Neko</span>{" "}
            {t("about.document.versionLabel", { version: version.state.value })}
          </p>
        ) : (
          <p role="status">{t("about.inventory.s13.empty")}</p>
        )}
        <p className="text-small text-muted-foreground">{t("about.inventory.s13.ideal")}</p>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="about-legal">
        <h2 id="about-legal" className="text-title-sm font-semibold">
          {t("about.document.codeLicense")}
        </h2>
        <ul className="flex flex-col gap-2">
          <li>
            <a href={LEGAL_LICENSE_URL} className="text-primary underline">
              {t("about.document.codeLicense")}
            </a>
          </li>
          <li>
            <a href={LEGAL_NOTICES_URL} className="text-primary underline">
              {t("about.document.thirdPartyNotices")}
            </a>
          </li>
        </ul>
        {locale !== "en" && (
          <p role="note" className="rounded-md border border-border bg-subtle p-3 text-small">
            {t("about.document.translatedSummary")} {t("about.inventory.s13.partial")}
          </p>
        )}
        <h3 className="text-label font-semibold">{t("about.document.originalLicense")}</h3>
        {license.state.status === "loading" ? (
          <p role="status" className="text-muted-foreground">
            {t("about.inventory.f20.loading")}
          </p>
        ) : license.state.status === "ready" ? (
          <pre
            lang="en"
            dir="ltr"
            tabIndex={0}
            aria-label={t("about.document.originalLicense")}
            className="max-h-[60vh] overflow-auto rounded-md border border-border p-3 font-mono text-small whitespace-pre-wrap"
          >
            {license.state.value}
          </pre>
        ) : (
          <div role="alert" className="flex flex-col items-start gap-2 text-small">
            <p>{t("about.document.sourceUnavailable")}</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton
                variant="secondary"
                label={t("common.actions.retry")}
                onPress={license.retry}
              />
              <a
                href={LEGAL_LICENSE_URL}
                className="inline-flex min-h-11 items-center text-primary underline"
              >
                {t("about.document.officialSource")}
              </a>
            </div>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="about-audio">
        <h2 id="about-audio" className="text-title-sm font-semibold">
          {t("about.audio.title")}
        </h2>
        <p className="text-small">{t("about.audio.codeAndAudioLicenses")}</p>
        <CreditsButton
          {...(loadCredits ? { loadCredits } : {})}
          className="min-h-11 self-start rounded-md border border-border px-4 text-label font-semibold hover:bg-subtle"
        />
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="about-languages">
        <h2 id="about-languages" className="text-title-sm font-semibold">
          {t("about.languages.title")}
        </h2>
        <p className="text-small">{t("about.languages.introduction")}</p>
        <Link href="/help/languages" className="text-primary underline">
          {t("about.languages.title")}
        </Link>
      </section>
    </DocumentView>
  );
}

/** One installed language with its coverage. */
interface InstalledLanguage {
  tag: string;
  nativeName: string;
  coverage: number;
}

/** Props of {@link LanguageGuide}. */
export interface LanguageGuideProps {
  /** Registry loader (tests); defaults to the published registry. */
  loadLanguages?: () => Promise<InstalledLanguage[]>;
}

/** Public guide for adding a language package. */
export function LanguageGuide({ loadLanguages }: LanguageGuideProps) {
  const { t, ensureNamespaces } = useLocale();
  const loader = useCallback(
    async () =>
      loadLanguages
        ? loadLanguages()
        : localeRegistrySchema
            .parse(JSON.parse(await fetchText(LOCALE_REGISTRY_URL)))
            .locales.map(({ tag, nativeName, coverage }) => ({ tag, nativeName, coverage })),
    [loadLanguages],
  );
  const languages = useSource(loader);

  useEffect(() => {
    void ensureNamespaces(["about"]);
  }, [ensureNamespaces]);

  const steps = [
    "about.languages.downloadTemplate",
    "about.languages.validate",
    "about.languages.install",
    "about.languages.build",
    "about.languages.restart",
    "about.languages.rollback",
  ];

  return (
    <DocumentView title={t("about.languages.title")}>
      <p>{t("about.languages.introduction")}</p>
      <p className="text-small text-muted-foreground">{t("about.languages.instructions")}</p>
      <ol className="flex list-decimal flex-col gap-2 ps-6">
        {steps.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
      <a
        href={LOCALE_TEMPLATE_URL}
        download
        className="inline-flex min-h-11 items-center self-start rounded-md bg-primary px-4 text-label font-semibold text-primary-foreground"
      >
        {t("about.languages.downloadTemplate")}
      </a>
      <p className="text-small text-muted-foreground">{t("about.languages.contactMaintainer")}</p>
      <section className="flex flex-col gap-2" aria-labelledby="guide-installed">
        <h2 id="guide-installed" className="text-title-sm font-semibold">
          {t("common.language.label")}
        </h2>
        {languages.state.status === "loading" ? (
          <p role="status" className="text-muted-foreground">
            {t("about.inventory.f20.loading")}
          </p>
        ) : languages.state.status === "error" ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-small">
            <p>{t("about.languages.sourceUnavailable")}</p>
            <ActionButton
              variant="secondary"
              label={t("common.actions.retry")}
              onPress={languages.retry}
            />
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {languages.state.value.map((language) => (
              <li key={language.tag} lang={language.tag}>
                {t("about.languages.coverage", {
                  language: language.nativeName,
                  percent: Math.round(language.coverage * 100),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </DocumentView>
  );
}
