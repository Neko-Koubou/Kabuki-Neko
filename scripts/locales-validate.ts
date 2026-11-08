/**
 * `pnpm locales:validate` — validates built-in and external locale packages (SA §8.1).
 *
 * Usage:
 *   pnpm locales:validate [--locale <tag>[,<tag>]] [--namespaces <ns>[,<ns>]] [--json]
 *                         [--builtin-root <dir>] [--external-root <dir>] [--contracts <file>]
 *
 * Without filters every registered package and all twelve namespaces are checked; `--locale` and
 * `--namespaces` allow atomic per-catalog verification. Path flags exist so tests and operators can
 * point at isolated copies. Exit code 1 when any error is reported (built-in warnings are errors).
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  LOCALE_NAMESPACES,
  localeNamespaceSchema,
  type LocaleNamespace,
} from "../packages/shared/src/schemas/locale.schema";
import { validateLocalePackages, validationPassed } from "./lib/locale-packages";

const ROOT = path.resolve(__dirname, "..");

/**
 * Canonical absolute path (symlinked temp dirs such as macOS `/var` → `/private/var` would
 * otherwise produce `../..` diagnostics); a missing path is returned resolved but unchanged.
 */
async function canonical(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}
/** Splits repeatable/comma-separated flag values. */
function list(values: string[] | undefined): string[] | undefined {
  const items = values?.flatMap((value) => value.split(",")).map((value) => value.trim());
  return items?.filter(Boolean).length ? items.filter(Boolean) : undefined;
}

/** Parses flags, runs validation and prints human-readable or JSON diagnostics. */
async function main() {
  const { values } = parseArgs({
    options: {
      locale: { type: "string", multiple: true },
      namespaces: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      "builtin-root": { type: "string" },
      "external-root": { type: "string" },
      contracts: { type: "string" },
      "allow-pseudo": { type: "boolean", default: false },
    },
    strict: true,
  });
  const namespaces = list(values.namespaces)?.map((name) => {
    const parsed = localeNamespaceSchema.safeParse(name);
    if (!parsed.success)
      throw new Error(`Unknown namespace "${name}" (expected: ${LOCALE_NAMESPACES.join(", ")})`);
    return parsed.data;
  }) satisfies LocaleNamespace[] | undefined;
  const result = await validateLocalePackages({
    builtinRoot: await canonical(
      values["builtin-root"] ?? path.join(ROOT, "packages/shared/locales"),
    ),
    externalRoot: await canonical(values["external-root"] ?? path.join(ROOT, "extensions/locales")),
    contractsFile: await canonical(
      values.contracts ?? path.join(ROOT, "packages/shared/locales/message-contracts.json"),
    ),
    locales: list(values.locale),
    namespaces,
    allowPseudo: values["allow-pseudo"],
  });
  const passed = validationPassed(result);
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({
        passed,
        packages: result.packages.map((item) => ({
          locale: item.manifest.locale,
          kind: item.kind,
          direction: item.manifest.direction,
          coverage: item.coverage,
          valid: item.valid,
        })),
        diagnostics: result.diagnostics,
      })}\n`,
    );
  } else {
    for (const item of result.diagnostics) {
      const where = item.line ? `${item.file}:${item.line}:${item.column}` : item.file;
      const key = item.namespace && item.key ? ` ${item.namespace}.${item.key}` : "";
      process.stdout.write(`${where} ${item.severity} ${item.code}${key}: ${item.message}\n`);
    }
    for (const item of result.packages)
      process.stdout.write(
        `${item.manifest.locale} (${item.kind}) coverage ${(item.coverage * 100).toFixed(1)}%\n`,
      );
    const errors = result.diagnostics.filter((item) => item.severity === "error").length;
    const warnings = result.diagnostics.length - errors;
    process.stdout.write(`${errors} error(s), ${warnings} warning(s)\n`);
  }
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `locales:validate failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 2;
});
