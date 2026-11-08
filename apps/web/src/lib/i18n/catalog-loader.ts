/**
 * Loads compiled locale catalogs from the shared build registry (SA §8.1–8.2, US-21; TASK-116).
 *
 * - The registry (`/locales/registry.json`, the same artifact the API serves) is validated with the
 *   shared schema; every namespace URL must sit under `/locales/<buildId>/<tag>/`.
 * - `load(tag, namespaces)` fetches only the requested namespaces plus `common`, for the requested
 *   locale and for `en` (the minimal fallback), deduplicating concurrent requests. Each file's bytes
 *   must hash to the registry SHA-256 (Web Crypto when available; a pure-JS SHA-256 otherwise,
 *   because `crypto.subtle` is missing on plain-HTTP LAN origins). A load is all-or-nothing: any
 *   failure rejects with a {@link CatalogLoadError} and the caller keeps its previous locale.
 * - Catalog files are data, never code: each value must be a compiled ICU AST of known element
 *   types within the SA nesting/size limits. Markup (tag elements) is rejected, and the AST is
 *   rebuilt with null-prototype option maps so no inherited property can be selected.
 */
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import {
  LOCALE_NAMESPACES,
  localeRegistrySchema,
  type LocaleEntry,
  type LocaleNamespace,
  type LocaleRegistry,
} from "@kabuki-neko/shared/schemas/locale.schema";
import { FALLBACK_LOCALE } from "./resolve";

/** A compiled message: an ICU MessageFormat AST. */
export type MessageAst = MessageFormatElement[];
/** Messages of one namespace, keyed by the key inside the namespace (`actions.apply`). */
export type NamespaceMessages = ReadonlyMap<string, MessageAst>;

/** A loaded locale: the requested namespaces plus the matching `en` fallback namespaces. */
export interface LocaleCatalog {
  tag: string;
  direction: "ltr" | "rtl";
  buildId: string;
  namespaces: ReadonlyMap<LocaleNamespace, NamespaceMessages>;
  fallback: ReadonlyMap<LocaleNamespace, NamespaceMessages>;
}

/** Why a catalog could not be loaded. */
export type CatalogErrorCode =
  | "INVALID_REGISTRY"
  | "LOCALE_NOT_INSTALLED"
  | "NAMESPACE_FETCH_FAILED"
  | "HASH_MISMATCH"
  | "INVALID_CATALOG";

/** Typed load failure; `locale`/`namespace` identify the failing asset when known. */
export class CatalogLoadError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    readonly locale: string | null = null,
    readonly namespace: LocaleNamespace | null = null,
  ) {
    super(`${code}${locale ? ` ${locale}` : ""}${namespace ? `/${namespace}` : ""}`);
    this.name = "CatalogLoadError";
  }
}

/** Minimal fetch signature, so tests and the server can inject their own. */
export type CatalogFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Loader configuration. */
export interface CatalogLoaderOptions {
  /** Raw registry JSON (validated here). */
  registry: unknown;
  /** Fetch implementation (default: global fetch). */
  fetch?: CatalogFetch;
  /** Origin prefixed to the relative asset URLs, for server-side fetches (default: none). */
  baseUrl?: string;
  /** Per-file timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
}

/** Catalog loader bound to one registry/build. */
export interface CatalogLoader {
  readonly registry: LocaleRegistry;
  /** Installed tags in registry order. */
  readonly installed: readonly string[];
  /** Registry entry for an installed tag. */
  entry(tag: string): LocaleEntry | undefined;
  /** Loads `namespaces` (+ `common`) for `tag` and the `en` fallback; all-or-nothing. */
  load(tag: string, namespaces: readonly LocaleNamespace[]): Promise<LocaleCatalog>;
}

/** Compiled namespace files are capped well above the 256 KiB source limit (ASTs are larger). */
const MAX_CATALOG_BYTES = 1024 * 1024;
/** SA §8.1 limits: plural/select nesting and AST nodes per message. */
const MAX_AST_DEPTH = 5;
const MAX_AST_NODES = 200;
/** Same key/placeholder grammar as the shared schemas. */
const MESSAGE_KEY = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/u;
const PLACEHOLDER = /^[A-Za-z][A-Za-z0-9]*$/u;
const RESERVED_NAMES = new Set(["constructor", "prototype", "__proto__"]);

/** SHA-256 round constants. */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 32-bit right rotation. */
function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Pure-JS SHA-256 (FIPS 180-4) as lowercase hex; used where Web Crypto is unavailable. */
export function sha256HexSync(bytes: Uint8Array): string {
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);
  const hash = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = Array.from(hash) as [
      number, number, number, number, number, number, number, number,
    ]; // prettier-ignore
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          (K[i] ?? 0) +
          (w[i] ?? 0)) >>>
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = ((hash[index] ?? 0) + value) >>> 0;
    });
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 hex via Web Crypto when present (secure contexts), else the pure-JS implementation. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return sha256HexSync(bytes);
  // Copy into a plain ArrayBuffer-backed view, as Web Crypto requires (no SharedArrayBuffer).
  const digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a usable placeholder name. */
function isPlaceholder(value: unknown): value is string {
  return typeof value === "string" && PLACEHOLDER.test(value) && !RESERVED_NAMES.has(value);
}

/** Copies a number/date/time style: null, a named style or a plain parsed-skeleton object. */
function copyStyle(style: unknown): unknown {
  if (style === undefined || style === null) return null;
  if (typeof style === "string" && style.length <= 100) return style;
  if (isRecord(style)) return JSON.parse(JSON.stringify(style)) as unknown;
  throw new Error("invalid style");
}

/**
 * Validates and rebuilds one AST: known element types only, no markup, `other` branches present,
 * nesting ≤ 5 and ≤ 200 nodes. Throws on anything else.
 */
function copyAst(value: unknown, depth: number, budget: { nodes: number }): MessageAst {
  if (!Array.isArray(value) || depth > MAX_AST_DEPTH) throw new Error("invalid AST");
  return value.map((element: unknown): MessageFormatElement => {
    budget.nodes -= 1;
    if (budget.nodes < 0 || !isRecord(element)) throw new Error("invalid AST element");
    const type = element.type;
    if (type === 0) {
      if (typeof element.value !== "string") throw new Error("invalid literal");
      return { type: 0, value: element.value } as MessageFormatElement;
    }
    if (type === 7) return { type: 7 } as MessageFormatElement;
    if (!isPlaceholder(element.value)) throw new Error("invalid placeholder");
    if (type === 1) return { type: 1, value: element.value } as MessageFormatElement;
    if (type === 2 || type === 3 || type === 4)
      return {
        type,
        value: element.value,
        style: copyStyle(element.style),
      } as MessageFormatElement;
    if (type === 5 || type === 6) {
      if (!isRecord(element.options) || !Object.hasOwn(element.options, "other"))
        throw new Error("select/plural without other");
      const options = Object.create(null) as Record<string, { value: MessageAst }>;
      for (const [key, option] of Object.entries(element.options)) {
        if (key.length === 0 || key.length > 100 || !isRecord(option))
          throw new Error("invalid option");
        options[key] = { value: copyAst(option.value, depth + 1, budget) };
      }
      if (type === 5) return { type, value: element.value, options } as MessageFormatElement;
      const offset = element.offset ?? 0;
      const pluralType = element.pluralType ?? "cardinal";
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 1000)
        throw new Error("invalid plural offset");
      if (pluralType !== "cardinal" && pluralType !== "ordinal")
        throw new Error("invalid plural type");
      return { type, value: element.value, options, offset, pluralType } as MessageFormatElement;
    }
    // Type 8 (tags/markup) and anything unknown are rejected: catalogs carry plain text only.
    throw new Error("unsupported AST element");
  });
}

/** Parses a namespace file's bytes into validated messages; throws on any invalid content. */
export function parseCatalog(bytes: Uint8Array): Map<string, MessageAst> {
  const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isRecord(json)) throw new Error("catalog is not an object");
  const messages = new Map<string, MessageAst>();
  for (const [key, value] of Object.entries(json)) {
    if (!MESSAGE_KEY.test(key)) throw new Error("invalid message key");
    messages.set(key, copyAst(value, 0, { nodes: MAX_AST_NODES }));
  }
  return messages;
}

/** Joins a relative asset URL with an optional origin. */
function assetUrl(baseUrl: string | undefined, url: string): string {
  return baseUrl ? new URL(url, baseUrl).toString() : url;
}

/** Creates a loader for one registry; throws {@link CatalogLoadError} INVALID_REGISTRY. */
export function createCatalogLoader(options: CatalogLoaderOptions): CatalogLoader {
  const parsed = localeRegistrySchema.safeParse(options.registry);
  if (!parsed.success) throw new CatalogLoadError("INVALID_REGISTRY");
  const registry = parsed.data;
  const fetchImpl: CatalogFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const entries = new Map(registry.locales.map((locale) => [locale.tag, locale]));
  /** In-flight or completed namespace loads by URL; failed loads are evicted for retry. */
  const cache = new Map<string, Promise<Map<string, MessageAst>>>();

  /** Fetches, hashes and parses one namespace asset. */
  async function fetchNamespace(entry: LocaleEntry, name: LocaleNamespace) {
    const asset = entry.namespaces.find((item) => item.name === name);
    if (asset === undefined || !asset.url.startsWith(`/locales/${registry.buildId}/${entry.tag}/`))
      throw new CatalogLoadError("INVALID_REGISTRY", entry.tag, name);
    let bytes: Uint8Array;
    try {
      const response = await fetchImpl(assetUrl(options.baseUrl, asset.url), {
        credentials: "same-origin",
        cache: "force-cache",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new CatalogLoadError("NAMESPACE_FETCH_FAILED", entry.tag, name);
    }
    if (bytes.length > MAX_CATALOG_BYTES || (await sha256Hex(bytes)) !== asset.sha256)
      throw new CatalogLoadError("HASH_MISMATCH", entry.tag, name);
    try {
      return parseCatalog(bytes);
    } catch {
      throw new CatalogLoadError("INVALID_CATALOG", entry.tag, name);
    }
  }

  /** Cached namespace load (deduplicates concurrent requests; evicts failures). */
  function namespace(entry: LocaleEntry, name: LocaleNamespace) {
    const key = `${entry.tag}/${name}`;
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = fetchNamespace(entry, name);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  }

  /** Loads a set of namespaces for one entry into a map. */
  async function loadAll(entry: LocaleEntry, names: readonly LocaleNamespace[]) {
    const loaded = await Promise.all(names.map((name) => namespace(entry, name)));
    return new Map(names.map((name, index) => [name, loaded[index] ?? new Map()] as const));
  }

  return {
    registry,
    installed: registry.locales.map((locale) => locale.tag),
    entry: (tag) => entries.get(tag),
    async load(tag, namespaces) {
      const entry = entries.get(tag);
      const english = entries.get(FALLBACK_LOCALE);
      if (entry === undefined) throw new CatalogLoadError("LOCALE_NOT_INSTALLED", tag);
      if (english === undefined) throw new CatalogLoadError("INVALID_REGISTRY", FALLBACK_LOCALE);
      const names = LOCALE_NAMESPACES.filter(
        (name) => name === "common" || namespaces.includes(name),
      );
      const [messages, fallback] = await Promise.all([
        loadAll(entry, names),
        entry === english ? null : loadAll(english, names),
      ]);
      return {
        tag: entry.tag,
        direction: entry.direction,
        buildId: registry.buildId,
        namespaces: messages,
        fallback: fallback ?? messages,
      };
    },
  };
}
