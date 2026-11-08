/**
 * Declarative locale package discovery and validation (SA §8.1, US-21).
 *
 * A package is a directory `<tag>/` holding `manifest.json` plus `<namespace>.json` files with flat
 * `{ "stable.key": "ICU message" }` objects. Packages are data only: files are read as UTF-8 JSON,
 * never imported or evaluated; symlinks, unexpected files and oversize inputs are rejected before
 * parsing. JSON is parsed by a strict position-aware reader that also rejects duplicate object keys
 * (which `JSON.parse` would silently overwrite). Every ICU message is parsed to an AST, bounded by
 * nesting/node limits, checked for markup and compared with `message-contracts.json` placeholders.
 *
 * Built-in packages must be complete with zero diagnostics; external packages may be partial (each
 * missing key is a warning and falls back to `en`). The result keeps compiled ASTs so the bundle
 * builder never re-parses unvalidated input.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  TYPE,
  parse as parseIcu,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { LOCALE_LIMITS } from "../../packages/shared/src/constants/limits";
import {
  CATALOG_VERSION,
  LOCALE_NAMESPACES,
  localeManifestSchema,
  messageContractsSchema,
  messageKeySchema,
  messageValueSchema,
  pseudoLocaleManifestSchema,
  type LocaleDiagnostic,
  type LocaleManifest,
  type LocaleNamespace,
  type MessageContracts,
} from "../../packages/shared/src/schemas/locale.schema";

export type PackageKind = "builtin" | "external";
/** 1-based source position of a JSON token. */
export interface Position {
  line: number;
  column: number;
}
/** One validated message: original text plus its compiled ICU AST. */
export interface CompiledMessage {
  value: string;
  ast: MessageFormatElement[];
}
/** A package that passed structural validation (it may still carry key-level diagnostics). */
export interface ValidatedPackage {
  kind: PackageKind;
  directory: string;
  manifest: LocaleManifest;
  /** Valid messages only, keyed by namespace then by namespace-relative key. */
  messages: Partial<Record<LocaleNamespace, Record<string, CompiledMessage>>>;
  /** Fraction of selected required contract keys with a valid message (0..1). */
  coverage: number;
  /** True when the package has no error diagnostics. */
  valid: boolean;
}
export interface ValidationOptions {
  builtinRoot: string;
  externalRoot?: string | undefined;
  contractsFile: string;
  /** Only validate these locale tags (default: every discovered package). */
  locales?: readonly string[] | undefined;
  /** Only validate these namespaces (default: all twelve). */
  namespaces?: readonly LocaleNamespace[] | undefined;
  /** Accept reserved pseudo-locales (`en-XA`, `ar-XB`) for test builds only. */
  allowPseudo?: boolean | undefined;
}
export interface ValidationResult {
  contracts: MessageContracts;
  packages: ValidatedPackage[];
  diagnostics: LocaleDiagnostic[];
}

/** Thrown by the strict JSON reader with the offending position. */
export class JsonSourceError extends Error {
  constructor(
    message: string,
    readonly position: Position,
  ) {
    super(message);
  }
}
/** Parsed JSON value plus the source position of every top-level object key. */
export interface JsonDocument {
  value: unknown;
  keys: Map<string, Position>;
}
const MAX_JSON_DEPTH = 32;

/**
 * Strict JSON reader (RFC 8259) that reports 1-based line/column positions, rejects duplicate keys
 * at any depth and bounds nesting. Objects are created without prototypes so keys such as
 * `__proto__` are plain data.
 */
export function parseJsonDocument(text: string): JsonDocument {
  let index = 0;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const position = (at: number): Position => {
    let low = 0,
      high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= at) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: at - (lineStarts[low] ?? 0) + 1 };
  };
  const fail = (message: string, at = index): never => {
    throw new JsonSourceError(message, position(at));
  };
  const whitespace = () => {
    while (index < text.length && " \t\n\r".includes(text[index] ?? "")) index++;
  };
  const string = (): string => {
    const start = index;
    if (text[index] !== '"') fail("Expected string");
    index++;
    let out = "";
    while (index < text.length) {
      const char = text[index] ?? "";
      if (char === '"') {
        index++;
        return out;
      }
      if (char === "\\") {
        const escape = text[index + 1] ?? "";
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape in simple) {
          out += simple[escape];
          index += 2;
        } else if (escape === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("Invalid unicode escape", index);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
        } else fail("Invalid escape", index);
      } else {
        if (char.charCodeAt(0) < 0x20) fail("Control character in string", index);
        out += char;
        index++;
      }
    }
    return fail("Unterminated string", start);
  };
  const value = (depth: number, keys?: Map<string, Position>): unknown => {
    if (depth > MAX_JSON_DEPTH) fail("JSON nesting too deep");
    whitespace();
    const char = text[index];
    if (char === "{") {
      index++;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      whitespace();
      if (text[index] === "}") {
        index++;
        return object;
      }
      for (;;) {
        whitespace();
        const at = index;
        const key = string();
        if (seen.has(key)) fail(`Duplicate key "${key}"`, at);
        seen.add(key);
        keys?.set(key, position(at));
        whitespace();
        if (text[index] !== ":") fail("Expected ':'");
        index++;
        object[key] = value(depth + 1);
        whitespace();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "}") {
          index++;
          return object;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (char === "[") {
      index++;
      const array: unknown[] = [];
      whitespace();
      if (text[index] === "]") {
        index++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        whitespace();
        if (text[index] === ",") {
          index++;
          continue;
        }
        if (text[index] === "]") {
          index++;
          return array;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (char === '"') return string();
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return result;
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      return Number(number[0]);
    }
    return fail("Unexpected token");
  };
  const keys = new Map<string, Position>();
  const root = value(0, keys);
  whitespace();
  if (index !== text.length) fail("Unexpected trailing content");
  return { value: root, keys };
}

/** Collects diagnostics with a stable shape (SA §8.1 diagnostic schema). */
class Diagnostics {
  readonly items: LocaleDiagnostic[] = [];
  constructor(private readonly cwd: string) {}
  add(
    file: string,
    code: LocaleDiagnostic["code"],
    message: string,
    options: {
      namespace?: LocaleNamespace | null;
      key?: string | null;
      severity?: LocaleDiagnostic["severity"];
      position?: Position | null;
    } = {},
  ) {
    this.items.push({
      file: path.relative(this.cwd, file) || file,
      namespace: options.namespace ?? null,
      key: options.key ?? null,
      severity: options.severity ?? "error",
      code,
      line: options.position?.line ?? null,
      column: options.position?.column ?? null,
      message,
    });
  }
}

/** Placeholder kind implied by one ICU argument element. */
function argumentKind(element: MessageFormatElement): "string" | "number" | "date" | null {
  switch (element.type) {
    case TYPE.argument:
    case TYPE.select:
      return "string";
    case TYPE.number:
    case TYPE.plural:
      return "number";
    case TYPE.date:
    case TYPE.time:
      return "date";
    default:
      return null;
  }
}
/** Walks an ICU AST: counts nodes, measures plural/select nesting and gathers placeholders. */
export function inspectAst(ast: MessageFormatElement[]) {
  let nodes = 0,
    depth = 0,
    markup = false;
  const placeholders = new Map<string, Set<"string" | "number" | "date">>();
  const walk = (elements: MessageFormatElement[], level: number) => {
    depth = Math.max(depth, level);
    for (const element of elements) {
      nodes++;
      if (element.type === TYPE.tag) {
        markup = true;
        walk(element.children, level);
        continue;
      }
      const kind = argumentKind(element);
      if (kind && "value" in element) {
        const kinds = placeholders.get(element.value) ?? new Set();
        kinds.add(kind);
        placeholders.set(element.value, kinds);
      }
      if (element.type === TYPE.select || element.type === TYPE.plural)
        for (const option of Object.values(element.options)) walk(option.value, level + 1);
    }
  };
  walk(ast, 0);
  return { nodes, depth, markup, placeholders };
}

/** Validates one ICU message against its contract; returns the AST or records a diagnostic. */
function compileMessage(
  value: unknown,
  contract: MessageContracts[string],
  report: (code: LocaleDiagnostic["code"], message: string) => void,
): CompiledMessage | null {
  if (typeof value !== "string") {
    report("INVALID_MANIFEST", "Message values must be JSON strings");
    return null;
  }
  const checked = messageValueSchema.safeParse(value);
  if (!checked.success) {
    const codes = new Set(checked.error.issues.map((issue) => issue.message));
    if (codes.has("FORBIDDEN_MARKUP")) report("FORBIDDEN_MARKUP", "HTML/XML markup is not allowed");
    else if (codes.has("TOO_LONG"))
      report(
        "PACKAGE_TOO_LARGE",
        `Message must be 1-${LOCALE_LIMITS.messageCodePoints} code points`,
      );
    else report("INVALID_ICU", "Message contains forbidden control or surrogate characters");
    return null;
  }
  let ast: MessageFormatElement[];
  try {
    ast = parseIcu(value, { requiresOtherClause: true, ignoreTag: false });
  } catch (error) {
    report(
      "INVALID_ICU",
      `ICU syntax error: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return null;
  }
  const shape = inspectAst(ast);
  if (shape.markup) {
    report("FORBIDDEN_MARKUP", "ICU rich-text tags are not allowed");
    return null;
  }
  if (shape.depth > LOCALE_LIMITS.icuNesting || shape.nodes > LOCALE_LIMITS.icuNodes) {
    report(
      "INVALID_ICU",
      `ICU message exceeds nesting ${LOCALE_LIMITS.icuNesting} or ${LOCALE_LIMITS.icuNodes} nodes`,
    );
    return null;
  }
  const expected = new Map(Object.entries(contract.placeholders));
  const problems: string[] = [];
  for (const [name, kinds] of shape.placeholders) {
    const wanted = expected.get(name);
    if (!wanted) problems.push(`unknown placeholder {${name}}`);
    else if (kinds.size !== 1 || !kinds.has(wanted))
      problems.push(`{${name}} must be used as ${wanted}`);
  }
  for (const name of expected.keys())
    if (!shape.placeholders.has(name)) problems.push(`missing placeholder {${name}}`);
  if (problems.length) {
    report("PLACEHOLDER_MISMATCH", problems.join("; "));
    return null;
  }
  return { value, ast };
}

/** Reads a regular, non-symlink file within a byte cap; returns null after reporting. */
async function readBounded(
  file: string,
  limit: number,
  diagnostics: Diagnostics,
  namespace: LocaleNamespace | null,
): Promise<string | null> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    diagnostics.add(file, "INVALID_MANIFEST", "Package files must be regular files, not links", {
      namespace,
    });
    return null;
  }
  if (info.size > limit) {
    diagnostics.add(file, "PACKAGE_TOO_LARGE", `File exceeds ${limit} bytes`, { namespace });
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  } catch {
    diagnostics.add(file, "INVALID_MANIFEST", "File is not valid UTF-8", { namespace });
    return null;
  }
}
/** Lists package directories under a root, reporting symlinks and unsafe names. */
async function discover(root: string, kind: PackageKind, diagnostics: Diagnostics) {
  let entries: string[];
  try {
    entries = (await readdir(root)).sort();
  } catch (error) {
    if (kind === "external" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const packages: { kind: PackageKind; directory: string; name: string }[] = [];
  for (const name of entries) {
    const directory = path.join(root, name);
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      diagnostics.add(directory, "INVALID_MANIFEST", "Locale packages cannot be symbolic links");
      continue;
    }
    if (!info.isDirectory()) continue;
    if (!/^[A-Za-z0-9-]{1,63}$/u.test(name)) {
      diagnostics.add(directory, "INVALID_MANIFEST", "Package directory name is not a locale tag");
      continue;
    }
    packages.push({ kind, directory, name });
  }
  return packages;
}

/** Loads and validates the message contracts file. */
export async function loadContracts(file: string): Promise<MessageContracts> {
  const document = parseJsonDocument(await readFile(file, "utf8"));
  return messageContractsSchema.parse(JSON.parse(JSON.stringify(document.value)));
}

/**
 * Validates every discovered (or selected) package. Structural problems exclude a package;
 * key-level problems drop only the offending message. Built-in diagnostics are always errors.
 */
export async function validateLocalePackages(
  options: ValidationOptions,
  cwd: string = process.cwd(),
): Promise<ValidationResult> {
  const diagnostics = new Diagnostics(cwd);
  const contracts = await loadContracts(options.contractsFile);
  const namespaces = options.namespaces ?? LOCALE_NAMESPACES;
  const allowed = new Set<string>([
    "manifest.json",
    ...LOCALE_NAMESPACES.map((name) => `${name}.json`),
  ]);
  const sources = [
    ...(await discover(options.builtinRoot, "builtin", diagnostics)),
    ...(options.externalRoot ? await discover(options.externalRoot, "external", diagnostics) : []),
  ].filter((source) => !options.locales || options.locales.includes(source.name));
  const seen = new Map<string, string>();
  const packages: ValidatedPackage[] = [];
  for (const source of sources) {
    const before = diagnostics.items.length;
    const severity = source.kind === "builtin" ? "error" : "warning";
    let total = 0;
    let structural = true;
    for (const entry of (await readdir(source.directory)).sort()) {
      const file = path.join(source.directory, entry);
      const info = await lstat(file);
      if (!allowed.has(entry) || info.isSymbolicLink() || !info.isFile()) {
        // Never read or evaluate anything that is not a declarative package file.
        diagnostics.add(file, "INVALID_MANIFEST", "Unexpected file in locale package");
        if (entry === "manifest.json") structural = false;
        continue;
      }
      total += info.size;
    }
    if (total > LOCALE_LIMITS.packageBytes) {
      diagnostics.add(source.directory, "PACKAGE_TOO_LARGE", "Package exceeds 2 MiB");
      continue;
    }
    const manifestFile = path.join(source.directory, "manifest.json");
    const manifestText = structural
      ? await readBounded(manifestFile, 64 * 1024, diagnostics, null).catch(() => {
          diagnostics.add(manifestFile, "INVALID_MANIFEST", "manifest.json is missing");
          return null;
        })
      : null;
    if (manifestText === null) continue;
    let manifestValue: unknown;
    try {
      manifestValue = parseJsonDocument(manifestText).value;
    } catch (error) {
      if (!(error instanceof JsonSourceError)) throw error;
      diagnostics.add(manifestFile, "INVALID_MANIFEST", error.message, {
        position: error.position,
      });
      continue;
    }
    if (
      typeof manifestValue === "object" &&
      manifestValue !== null &&
      "catalogVersion" in manifestValue &&
      manifestValue.catalogVersion !== CATALOG_VERSION
    ) {
      diagnostics.add(manifestFile, "INCOMPATIBLE_VERSION", `catalogVersion must be "1"`);
      continue;
    }
    const parsedManifest = (
      options.allowPseudo ? pseudoLocaleManifestSchema : localeManifestSchema
    ).safeParse(JSON.parse(JSON.stringify(manifestValue)));
    if (!parsedManifest.success) {
      const fields = parsedManifest.error.issues.map((issue) => issue.path.join(".") || "manifest");
      diagnostics.add(manifestFile, "INVALID_MANIFEST", `Invalid fields: ${fields.join(", ")}`);
      continue;
    }
    const manifest = parsedManifest.data;
    if (manifest.locale !== source.name) {
      diagnostics.add(manifestFile, "INVALID_MANIFEST", "locale must equal the directory name");
      continue;
    }
    const previous = seen.get(manifest.locale);
    if (previous) {
      diagnostics.add(manifestFile, "DUPLICATE_LOCALE", `Locale already provided by ${previous}`);
      continue;
    }
    seen.set(manifest.locale, path.relative(cwd, source.directory) || source.directory);

    const messages: ValidatedPackage["messages"] = {};
    let required = 0,
      present = 0;
    for (const namespace of namespaces) {
      const file = path.join(source.directory, `${namespace}.json`);
      const contractKeys = Object.keys(contracts)
        .filter((key) => key.startsWith(`${namespace}.`))
        .sort();
      const compiled: Record<string, CompiledMessage> = Object.create(null) as Record<
        string,
        CompiledMessage
      >;
      let document: JsonDocument | null = null;
      const text = await readBounded(
        file,
        LOCALE_LIMITS.namespaceBytes,
        diagnostics,
        namespace,
      ).catch(() => null);
      if (text !== null) {
        try {
          document = parseJsonDocument(text);
        } catch (error) {
          if (!(error instanceof JsonSourceError)) throw error;
          diagnostics.add(file, "INVALID_MANIFEST", error.message, {
            namespace,
            position: error.position,
          });
        }
      }
      const value = document?.value;
      if (document && (typeof value !== "object" || value === null || Array.isArray(value))) {
        diagnostics.add(file, "INVALID_MANIFEST", "Namespace file must be a flat JSON object", {
          namespace,
          position: { line: 1, column: 1 },
        });
        document = null;
      }
      if (document && typeof value === "object" && value !== null) {
        for (const [key, message] of Object.entries(value)) {
          const position = document.keys.get(key) ?? null;
          const fullKey = `${namespace}.${key}`;
          const contract = contracts[fullKey];
          if (!messageKeySchema.safeParse(key).success || !contract) {
            diagnostics.add(file, "UNKNOWN_KEY", `Key is not declared in message contracts`, {
              namespace,
              key,
              position,
            });
            continue;
          }
          const result = compileMessage(message, contract, (code, text) =>
            diagnostics.add(file, code, text, { namespace, key, position }),
          );
          if (result) compiled[key] = result;
        }
      }
      for (const fullKey of contractKeys) {
        const key = fullKey.slice(namespace.length + 1);
        if (!contracts[fullKey]?.required) continue;
        required++;
        if (compiled[key]) present++;
        else if (
          !(key in compiled) &&
          !diagnostics.items.some((d) => d.file === path.relative(cwd, file) && d.key === key)
        )
          diagnostics.add(file, "MISSING_KEY", "Required message is missing (falls back to en)", {
            namespace,
            key,
            severity,
          });
      }
      messages[namespace] = compiled;
    }
    const own = diagnostics.items.slice(before);
    packages.push({
      kind: source.kind,
      directory: source.directory,
      manifest,
      messages,
      coverage: required === 0 ? 1 : present / required,
      valid: !own.some((item) => item.severity === "error"),
    });
  }
  if (
    !options.locales &&
    !packages.some((item) => item.kind === "builtin" && item.manifest.locale === "en")
  )
    diagnostics.add(
      path.join(options.builtinRoot, "en"),
      "INVALID_MANIFEST",
      "The built-in en package is required as the complete fallback",
    );
  return { contracts, packages, diagnostics: diagnostics.items };
}

/** True when the selected result is acceptable: no errors and no warnings on built-ins. */
export function validationPassed(result: ValidationResult): boolean {
  return !result.diagnostics.some((item) => item.severity === "error");
}
