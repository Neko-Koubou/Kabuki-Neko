/**
 * Installed locale registry and About metadata (SA §4.4 /system/locales and /system/about, §8).
 *
 * The registry is the immutable artifact written by `pnpm locales:build` into LOCALE_BUNDLE_PATH:
 * `registry.json` plus `<buildId>/<tag>/<namespace>.json`. At startup it is validated with the
 * shared schema (catalogVersion "1", complete `en`, URLs under its own buildId) and every namespace
 * file must exist and match its SHA-256, so the API never advertises a bundle the web app cannot
 * serve. A present-but-invalid bundle always aborts startup; a missing bundle aborts only in
 * production (development/test report 503 until the catalogs are built). Locales are data: any
 * number of packages, including external ones, register without code or enum changes.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import {
  CATALOG_VERSION,
  localeRegistrySchema,
  type LocaleRegistry,
} from "@kabuki-neko/shared/schemas/locale.schema";
import { aboutSchema } from "@kabuki-neko/shared/schemas/system.schema";
import { ConfigService } from "../../config/config.service";
import { ApiError } from "../../common/error.filter";
import { InstalledLocales } from "./system.service";

/** Why a bundle was rejected; messages contain no file contents. */
export class LocaleBundleError extends Error {}

/**
 * Reads `<dir>/registry.json`, validates it and verifies each namespace asset's presence and
 * SHA-256. Throws ENOENT when the registry file itself is absent.
 */
export async function loadLocaleRegistry(directory: string): Promise<LocaleRegistry> {
  const text = await readFile(path.join(directory, "registry.json"), "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LocaleBundleError("registry.json is not valid JSON");
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    "catalogVersion" in raw &&
    raw.catalogVersion !== CATALOG_VERSION
  )
    throw new LocaleBundleError("Locale bundle catalogVersion is incompatible");
  const parsed = localeRegistrySchema.safeParse(raw);
  if (!parsed.success)
    throw new LocaleBundleError(
      `Locale registry rejected: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
    );
  const registry = parsed.data;
  for (const locale of registry.locales)
    for (const asset of locale.namespaces) {
      const file = path.join(directory, registry.buildId, locale.tag, `${asset.name}.json`);
      let info;
      try {
        info = await lstat(file);
      } catch {
        throw new LocaleBundleError(`Missing catalog ${locale.tag}/${asset.name}`);
      }
      if (!info.isFile() || info.isSymbolicLink())
        throw new LocaleBundleError(`Catalog ${locale.tag}/${asset.name} is not a regular file`);
      const digest = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      if (digest !== asset.sha256)
        throw new LocaleBundleError(`Catalog ${locale.tag}/${asset.name} hash mismatch`);
    }
  return registry;
}

/** About payload: build version from the API package manifest, fixed license/legal URLs. */
export async function readAbout(packageFile = path.resolve(__dirname, "../../../package.json")) {
  const manifest = JSON.parse(await readFile(packageFile, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version)
    throw new Error("Build version unavailable");
  return aboutSchema.parse({
    name: "Kabuki Neko",
    version: manifest.version,
    license: "Apache-2.0-with-Commons-Clause",
    licenseUrl: "/legal/LICENSE.txt",
    noticesUrl: "/legal/THIRD-PARTY-NOTICES.txt",
    languageGuideUrl: "/help/languages",
  });
}

@Injectable()
export class LocaleRegistryService extends InstalledLocales implements OnModuleInit {
  private registry: LocaleRegistry | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    super();
  }

  /** Loads and verifies the bundle at startup (see module comment for failure policy). */
  async onModuleInit(): Promise<void> {
    try {
      this.registry = await loadLocaleRegistry(this.config.values.LOCALE_BUNDLE_PATH);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing || this.config.values.NODE_ENV === "production") throw error;
      this.registry = null;
    }
  }

  /** The verified registry, or 503 when no catalog bundle is installed. */
  current(): LocaleRegistry {
    if (!this.registry) throw new ApiError("DEPENDENCY_UNAVAILABLE", 503);
    return this.registry;
  }

  /** True when `tag` is registered in the installed bundle. */
  isInstalled(tag: string): boolean {
    return this.registry?.locales.some((locale) => locale.tag === tag) ?? false;
  }

  /** The configured default when installed, otherwise the always-complete `en` fallback. */
  effectiveDefault(tag: string): string {
    return this.isInstalled(tag) ? tag : "en";
  }

  /** Strong ETag (the buildId) for `no-cache` registry responses (SA §6.4). */
  etag(): string {
    return `"${this.current().buildId}"`;
  }
}
