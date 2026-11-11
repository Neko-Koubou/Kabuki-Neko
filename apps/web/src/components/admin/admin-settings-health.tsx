"use client";
/**
 * S11 administration page (F08): instance settings, storage with orphan cleanup, and system health
 * (Design §4.5; SA §4.4, §7.1; US-02/15/16/20/21; TASK-147).
 *
 * - Superadmins only: other roles see a notice and no request is made (the API enforces it too).
 * - Each panel loads, fails and retries on its own; one failing panel never blocks the others.
 * - Settings (`GET`/`PATCH /system/settings` with If-Match):
 *   - instance name, registration policy, per-type upload limits (MiB), players per game, blocked
 *     nickname words (one per line) and the default language (installed locales only);
 *   - only fields the admin actually changed are sent, so a default shown in the form is never
 *     saved by accident; nothing is sent when nothing changed;
 *   - a revision conflict keeps every entry and offers a reload, so nothing is silently merged.
 * - Storage: file count and total size from the server, with "may be out of date" (stale) and
 *   "not available" kept distinct from a real zero.
 *   - Cleanup asks first (M09). Each batch gets a new Idempotency-Key.
 *   - The result reports deleted, freed and failed counts, a partial batch and "more remain"
 *     with Run again. A failed batch reports that nothing was deleted.
 * - Health (`GET /system/health`): the overall state plus database, storage and game state, each
 *   with its own status and the server's check time. Drivers are shown read-only. 200 (all up)
 *   and 503 (degraded, same body) are both shown as results; only other failures are errors.
 * States per panel:
 * - loading;
 * - empty: no files / not checked;
 * - ideal;
 * - partial: stale metrics, a degraded service, partial cleanup;
 * - error: retry, with unsaved settings kept.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { REGISTRATION_MODES } from "@kabuki-neko/shared/constants/game";
import { SETTINGS_LIMITS } from "@kabuki-neko/shared/constants/limits";
import { localeRegistrySchema } from "@kabuki-neko/shared/schemas/locale.schema";
import {
  cleanupResultSchema,
  healthSchema,
  settingsPatchSchema,
  settingsResponseSchema,
  settingsSchema,
  type Health,
  type Settings,
} from "@kabuki-neko/shared/schemas/system.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, CLIENT_HEADER, apiErrorMessageKey } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Editable settings as typed in the form (numbers as text). */
export interface SettingsForm {
  instanceName: string;
  registrationMode: Settings["registrationMode"];
  maxImageSizeMb: string;
  maxAudioSizeMb: string;
  maxVideoSizeMb: string;
  maxPlayersPerRoom: string;
  profanityWords: string;
  defaultLocale: string;
}

/** Form values for saved settings. */
export function formOf(settings: Settings): SettingsForm {
  return {
    instanceName: settings.instanceName,
    registrationMode: settings.registrationMode,
    maxImageSizeMb: String(settings.maxImageSizeMb),
    maxAudioSizeMb: String(settings.maxAudioSizeMb),
    maxVideoSizeMb: String(settings.maxVideoSizeMb),
    maxPlayersPerRoom: String(settings.maxPlayersPerRoom),
    profanityWords: settings.profanityWords.join("\n"),
    defaultLocale: settings.defaultLocale,
  };
}

/**
 * The PATCH body: only fields that differ from the saved settings (never untouched defaults).
 * Returns null when nothing changed.
 */
export function changedFields(saved: Settings, form: SettingsForm): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const number = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));
  if (form.instanceName !== saved.instanceName) patch.instanceName = form.instanceName;
  if (form.registrationMode !== saved.registrationMode)
    patch.registrationMode = form.registrationMode;
  for (const key of [
    "maxImageSizeMb",
    "maxAudioSizeMb",
    "maxVideoSizeMb",
    "maxPlayersPerRoom",
  ] as const)
    if (form[key] !== String(saved[key])) patch[key] = number(form[key]);
  const words = form.profanityWords
    .split("\n")
    .map((word) => word.trim())
    .filter((word) => word !== "");
  if (words.join("\n") !== saved.profanityWords.join("\n")) patch.profanityWords = words;
  if (form.defaultLocale !== saved.defaultLocale) patch.defaultLocale = form.defaultLocale;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Fetches health accepting both 200 (ok) and 503 (degraded) bodies. */
export type HealthLoader = () => Promise<Health>;

/** Default health loader (public endpoint, raw fetch so a 503 body is still read). */
function defaultHealthLoader(): HealthLoader {
  return async () => {
    const base = new URL("/api/v1", process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001");
    const response = await fetch(`${base.toString().replace(/\/$/u, "")}/system/health`, {
      headers: { Accept: "application/json", "X-Kabuki-Client": CLIENT_HEADER },
      cache: "no-store",
    });
    if (response.status !== 200 && response.status !== 503)
      throw new ApiError(response.status, "DEPENDENCY_UNAVAILABLE");
    const parsed = healthSchema.safeParse(await response.json());
    if (!parsed.success) throw new ApiError(response.status, "INVALID_RESPONSE");
    return parsed.data;
  };
}

/** Props of {@link AdminSettingsHealth}. */
export interface AdminSettingsHealthProps {
  /** Health loader (tests). */
  loadHealth?: HealthLoader;
}

/** S11: settings, storage and health. */
export function AdminSettingsHealth({ loadHealth }: AdminSettingsHealthProps) {
  const { t, ensureNamespaces } = useLocale();
  const { user } = useAuth();

  useEffect(() => {
    void ensureNamespaces(["admin", "validation"]);
  }, [ensureNamespaces]);

  if (user && user.role !== "SUPERADMIN")
    return (
      <p role="alert" className="text-body">
        {t("validation.errors.forbidden")}
      </p>
    );
  if (!user)
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("admin.inventory.s11.loading")}
      </p>
    );

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-title font-bold">{t("admin.inventory.f08.title")}</h1>
      <SettingsPanel />
      <HealthPanel loadHealth={loadHealth ?? defaultHealthLoader()} />
    </div>
  );
}

/** Settings + storage panel state. */
type PanelState<T> =
  { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; value: T };

/** Settings form and storage metrics/cleanup. */
function SettingsPanel() {
  const { t, formatNumber } = useLocale();
  const { api } = useAuth();
  const base = useId();
  const [state, setState] = useState<PanelState<{ settings: Settings; metrics: SettingsMetrics }>>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [locales, setLocales] = useState<{ tag: string; nativeName: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "warning";
    text: string;
    conflict?: boolean;
  } | null>(null);
  const [cleanup, setCleanup] = useState<{
    deleted: number;
    bytes: number;
    failed: number;
    hasMore: boolean;
  } | null>(null);
  const [cleanupFailed, setCleanupFailed] = useState(false);

  // Load settings and metrics; a reload keeps unsaved entries unless asked to replace them.
  const load = useCallback(
    async (replaceForm: boolean, signal?: AbortSignal) => {
      setState((current) => (current.status === "ready" ? current : { status: "loading" }));
      try {
        const { data } = await api.request({
          path: "/system/settings",
          schema: settingsResponseSchema,
          ...(signal ? { signal } : {}),
        });
        setState({ status: "ready", value: data });
        setForm((current) => (current === null || replaceForm ? formOf(data.settings) : current));
      } catch (error) {
        if (signal?.aborted) return;
        setState((current) => (current.status === "ready" ? current : { status: "error", error }));
      }
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    api
      .request({ path: "/system/locales", schema: localeRegistrySchema, signal: controller.signal })
      .then(
        ({ data }) =>
          setLocales(
            data.locales.map((locale) => ({ tag: locale.tag, nativeName: locale.nativeName })),
          ),
        () => setLocales([]),
      );
    return () => controller.abort();
  }, [api, load, attempt]);

  const confirmCleanup = useConfirmAction({
    run: async () => {
      setCleanupFailed(false);
      try {
        const { data } = await api.request({
          method: "POST",
          path: "/system/storage/cleanup-orphans",
          body: {},
          idempotencyKey: crypto.randomUUID(),
          schema: cleanupResultSchema,
        });
        setCleanup({
          deleted: data.deletedCount,
          bytes: data.freedBytes,
          failed: data.failedCount,
          hasMore: data.hasMore,
        });
        void load(false);
      } catch (error) {
        setCleanupFailed(true);
        throw error;
      }
    },
  });

  if (state.status === "loading" || (state.status === "ready" && form === null))
    return <SkeletonBlock layout="rows" count={4} label={t("admin.inventory.s11.loading")} />;
  if (state.status === "error")
    return (
      <StatusNotice
        tone="error"
        message={t("admin.inventory.s11.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: () => setAttempt((n) => n + 1) }}
      />
    );
  if (!form) return null;

  const { settings, metrics } = state.value;
  const patch = changedFields(settings, form);
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  /** Sends only the changed fields with If-Match. */
  const save = async () => {
    if (!patch || saving) return;
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) {
      setNotice({ tone: "error", text: t("validation.errors.validationFailed") });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const { data } = await api.request({
        method: "PATCH",
        path: "/system/settings",
        body: parsed.data,
        ifMatch: settings.revision,
        schema: settingsSchema,
      });
      setState({ status: "ready", value: { settings: data, metrics } });
      setForm(formOf(data));
      setNotice({ tone: "success", text: t("admin.settings.success") });
    } catch (error) {
      const conflict = error instanceof ApiError && error.code === "REVISION_CONFLICT";
      setNotice({
        tone: conflict ? "warning" : "error",
        text: conflict
          ? t("admin.settings.revisionConflict")
          : error instanceof ApiError
            ? t(apiErrorMessageKey(error.code))
            : t("admin.inventory.s11.error"),
        conflict,
      });
    } finally {
      setSaving(false);
    }
  };

  const numberField = (
    key: "maxImageSizeMb" | "maxAudioSizeMb" | "maxVideoSizeMb" | "maxPlayersPerRoom",
    label: string,
    min: number,
    max: number,
  ) => (
    <FormField
      kind="number"
      label={label}
      value={form[key]}
      min={min}
      max={max}
      step={1}
      onChange={(value) => set(key, value)}
      help={`${formatNumber(min)}–${formatNumber(max)}`}
    />
  );

  return (
    <>
      <section aria-labelledby={`${base}-settings`} className="flex flex-col gap-4">
        <h2 id={`${base}-settings`} className="text-title-sm font-semibold">
          {t("admin.settings.title")}
        </h2>
        {notice && (
          <div className="flex flex-col items-start gap-2">
            <StatusNotice
              tone={notice.tone}
              message={notice.text}
              onDismiss={() => setNotice(null)}
            />
            {notice.conflict && (
              <ActionButton
                variant="secondary"
                label={t("common.actions.retry")}
                onPress={() => {
                  setNotice(null);
                  void load(true);
                }}
              />
            )}
          </div>
        )}
        <FormField
          label={t("admin.settings.instanceName")}
          value={form.instanceName}
          required
          limit={100}
          onChange={(value) => set("instanceName", value)}
        />
        <ChoiceGroup
          mode="radio"
          name={`${base}-registration`}
          label={t("admin.settings.registrationMode")}
          items={REGISTRATION_MODES.map((mode) => ({
            id: mode,
            label:
              mode === "SINGLE_ADMIN"
                ? t("admin.settings.singleAdmin")
                : mode === "INVITE_ONLY"
                  ? t("admin.settings.inviteOnly")
                  : t("admin.settings.public"),
          }))}
          selected={form.registrationMode}
          onSelect={(id) => {
            const mode = REGISTRATION_MODES.find((value) => value === id);
            if (mode) set("registrationMode", mode);
          }}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField(
            "maxImageSizeMb",
            t("admin.settings.maxImageSize"),
            SETTINGS_LIMITS.uploadMinMiB,
            SETTINGS_LIMITS.imageMaxMiB,
          )}
          {numberField(
            "maxAudioSizeMb",
            t("admin.settings.maxAudioSize"),
            SETTINGS_LIMITS.uploadMinMiB,
            SETTINGS_LIMITS.audioMaxMiB,
          )}
          {numberField(
            "maxVideoSizeMb",
            t("admin.settings.maxVideoSize"),
            SETTINGS_LIMITS.uploadMinMiB,
            SETTINGS_LIMITS.videoMaxMiB,
          )}
          {numberField(
            "maxPlayersPerRoom",
            t("admin.settings.maxPlayers"),
            SETTINGS_LIMITS.minPlayers,
            SETTINGS_LIMITS.maxPlayers,
          )}
        </div>
        <FormField
          kind="textarea"
          rows={4}
          label={t("admin.settings.profanityWords")}
          value={form.profanityWords}
          onChange={(value) => set("profanityWords", value)}
        />
        <FormField
          kind="select"
          label={t("admin.settings.defaultLocale")}
          value={form.defaultLocale}
          pending={locales.length === 0}
          options={locales.map((locale) => ({ value: locale.tag, label: locale.nativeName }))}
          onChange={(value) => set("defaultLocale", value)}
        />
        <ActionButton
          label={t("admin.settings.save")}
          pending={saving}
          disabled={!patch}
          onPress={() => void save()}
          className="self-start"
        />
      </section>
      <section aria-labelledby={`${base}-storage`} className="flex flex-col gap-3">
        <h2 id={`${base}-storage`} className="text-title-sm font-semibold">
          {t("admin.storage.title")}
        </h2>
        {metrics.status === "unavailable" ? (
          <p role="status" className="text-small text-danger">
            {t("admin.storage.unavailable")}
          </p>
        ) : (
          <>
            {metrics.status === "stale" && (
              <p role="status" className="text-small text-warning">
                {t("admin.storage.stale")}
              </p>
            )}
            {metrics.fileCount === 0 ? (
              <p className="text-small text-muted-foreground">{t("admin.storage.empty")}</p>
            ) : (
              <dl className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border p-2">
                  <dt className="text-small text-muted-foreground">
                    {t("admin.storage.fileCount")}
                  </dt>
                  <dd className="text-title font-bold tabular-nums">
                    {formatNumber(metrics.fileCount)}
                  </dd>
                </div>
                <div className="rounded-md border border-border p-2">
                  <dt className="text-small text-muted-foreground">
                    {t("admin.storage.totalBytes")}
                  </dt>
                  <dd className="text-title font-bold tabular-nums">
                    {formatNumber(metrics.totalBytes / 1_000_000, {
                      style: "unit",
                      unit: "megabyte",
                      maximumFractionDigits: 1,
                    })}
                  </dd>
                </div>
              </dl>
            )}
            <p className="text-small text-muted-foreground">
              {t("admin.health.lastChecked", { checkedAt: metrics.checkedAt })}
            </p>
          </>
        )}
        {cleanup && (
          <div role="status" className="flex flex-col items-start gap-2 text-small">
            <p>
              {t("admin.storage.cleanupResult", {
                deleted: cleanup.deleted,
                bytes: cleanup.bytes,
                failed: cleanup.failed,
              })}
            </p>
            {cleanup.failed > 0 && (
              <p className="text-warning">{t("admin.storage.cleanupPartial")}</p>
            )}
            {cleanup.hasMore && <p>{t("admin.storage.cleanupMore")}</p>}
          </div>
        )}
        {cleanupFailed && (
          <p role="alert" className="text-small text-danger">
            {t("admin.storage.cleanupFailed")}
          </p>
        )}
        <ActionButton
          variant="secondary"
          label={t("admin.storage.cleanup")}
          disabled={metrics.status === "unavailable"}
          onPress={confirmCleanup.request}
          className="self-start"
        />
      </section>
      <ConfirmDialog
        controller={confirmCleanup}
        impact={t("admin.storage.confirmCleanup")}
        targetName={t("admin.storage.title")}
        confirmLabel={t("admin.storage.cleanup")}
      />
    </>
  );
}

/** Storage metrics of the settings response. */
type SettingsMetrics = {
  fileCount: number;
  totalBytes: number;
  checkedAt: number;
  status: "fresh" | "stale" | "unavailable";
};

/** Health panel with per-service status. */
function HealthPanel({ loadHealth }: { loadHealth: HealthLoader }) {
  const { t } = useLocale();
  const base = useId();
  const [state, setState] = useState<PanelState<Health>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    loadHealth().then(
      (health) => active && setState({ status: "ready", value: health }),
      (error: unknown) => active && setState({ status: "error", error }),
    );
    return () => {
      active = false;
    };
  }, [loadHealth, attempt]);

  const statusLabel = (status: "up" | "down" | "unknown") =>
    status === "up"
      ? t("admin.health.up")
      : status === "down"
        ? t("admin.health.down")
        : t("admin.health.unknown");

  let body;
  if (state.status === "loading")
    body = <SkeletonBlock layout="rows" count={3} label={t("admin.inventory.f08.loading")} />;
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("admin.inventory.f08.error")}
        action={{ label: t("admin.health.refresh"), onAction: () => setAttempt((n) => n + 1) }}
      />
    );
  else {
    const health = state.value;
    const parts = [
      { key: "db", label: t("admin.health.database"), part: health.db, driver: health.dbDriver },
      {
        key: "storage",
        label: t("admin.health.storage"),
        part: health.storage,
        driver: health.storageDriver,
      },
      {
        key: "state",
        label: t("admin.health.state"),
        part: health.state,
        driver: health.stateDriver,
      },
    ];
    body = (
      <>
        <p
          role="status"
          className={`text-body font-semibold ${health.status === "ok" ? "text-success" : "text-warning"}`}
        >
          {health.status === "ok" ? t("admin.health.healthy") : t("admin.health.degraded")}
        </p>
        <ul className="flex flex-col gap-2">
          {parts.map(({ key, label, part, driver }) => (
            <li
              key={key}
              data-health={key}
              data-status={part.status}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-3"
            >
              <span className="font-semibold">
                {label}{" "}
                <span className="text-small font-normal text-muted-foreground">({driver})</span>
              </span>
              <span
                className={
                  part.status === "up"
                    ? "text-success"
                    : part.status === "down"
                      ? "text-danger"
                      : "text-muted-foreground"
                }
              >
                {statusLabel(part.status)}
              </span>
              <span className="basis-full text-small text-muted-foreground">
                {part.status === "unknown"
                  ? t("admin.health.unknown")
                  : t("admin.health.lastChecked", { checkedAt: part.checkedAt })}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section aria-labelledby={`${base}-health`} className="flex flex-col gap-3">
      <h2 id={`${base}-health`} className="text-title-sm font-semibold">
        {t("admin.health.title")}
      </h2>
      {body}
      {state.status === "ready" && (
        <ActionButton
          variant="secondary"
          label={t("admin.health.refresh")}
          onPress={() => setAttempt((n) => n + 1)}
          className="self-start"
        />
      )}
    </section>
  );
}
