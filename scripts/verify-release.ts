/**
 * `pnpm exec tsx scripts/verify-release.ts [--report] [--out file]` — release evidence gate
 * (TASK-181; SA §11.2; US-01–US-21).
 *
 * Checks docs/release-checklist.md against the PRD and the repository:
 * 1. Coverage: every US-xx story, AC-xx-yy scenario, BR-xx rule and NFR-xx requirement of
 *    docs/vibe/01-prd.md has exactly one row; unknown IDs are errors.
 * 2. Evidence:
 *    - every backtick-quoted evidence path exists;
 *    - a VERIFIED row cites at least one automated test (`*.spec.ts(x)`) or measuring script
 *      (`scripts/…`);
 *    - status is VERIFIED, PENDING or GAP.
 * 3. Catalog pair: the API bundle (`locales-built/registry.json`) and the web copy
 *    (`apps/web/public/locales/registry.json`) exist and are byte-identical (same buildId).
 * 4. Measured budgets:
 *    - docs/performance-results.md records both the broadcast benchmark and the player bundle
 *      budgets;
 *    - any recorded measurement verdict (`test-results/benchmark/*.json`, when present) that
 *      failed must not back a VERIFIED NFR-01/NFR-02 row;
 *    - a FAIL recorded in the document must not either.
 * 5. Audio rights: while docs/audio-provenance.json says `release-unverified`, US-19 and AC-19-02
 *    must not be VERIFIED.
 *
 * Result:
 * - structural errors (1–5) always fail;
 * - PENDING and GAP rows are release gaps: the default gate mode fails on them, and `--report`
 *   lists them but exits 0 (CI on ordinary pushes).
 * A JSON record goes to `test-results/release/verify-release.json`. The script never publishes or
 * deploys anything.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(__dirname, "..");
/** Allowed row statuses. */
export const STATUSES = ["VERIFIED", "PENDING", "GAP"] as const;
export type Status = (typeof STATUSES)[number];

/** One checklist row. */
export interface ChecklistRow {
  id: string;
  evidence: string[];
  status: string;
  notes: string;
}

/** Every requirement ID the PRD defines (stories, acceptance scenarios, rules, NFRs). */
export function requirementIds(prd: string): string[] {
  const ids = new Set<string>();
  for (const match of prd.matchAll(/^### (US-\d{2}) — /gmu)) ids.add(match[1] as string);
  for (const match of prd.matchAll(/Scenario: (AC-\d{2}-\d{2})\b/gu)) ids.add(match[1] as string);
  for (const match of prd.matchAll(/^\| ((?:BR|NFR)-\d{2})\b/gmu)) ids.add(match[1] as string);
  return [...ids].sort();
}

/** Parses the requirement rows of the checklist table. */
export function parseChecklist(markdown: string): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    // A row is `| ID | Requirement | Evidence | Status | Notes |` (leading/trailing empty cells).
    if (cells.length < 7 || !/^(US|AC|BR|NFR)-[\d-]+$/u.test(cells[1] ?? "")) continue;
    rows.push({
      id: cells[1] as string,
      evidence: [...(cells[3] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] as string),
      status: cells[4] ?? "",
      notes: cells[5] ?? "",
    });
  }
  return rows;
}

/** Structural problems of the rows against the required IDs and the file system. */
export function checkRows(
  rows: readonly ChecklistRow[],
  required: readonly string[],
  exists: (file: string) => boolean,
): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  for (const id of required) if (!seen.has(id)) errors.push(`${id}: no checklist row`);
  for (const [id, count] of seen) {
    if (count > 1) errors.push(`${id}: ${count} rows (expected one)`);
    if (!required.includes(id)) errors.push(`${id}: not a requirement of the PRD`);
  }
  for (const row of rows) {
    if (!(STATUSES as readonly string[]).includes(row.status))
      errors.push(`${row.id}: unknown status "${row.status}"`);
    if (row.evidence.length === 0) errors.push(`${row.id}: no evidence`);
    for (const file of row.evidence)
      if (!exists(file)) errors.push(`${row.id}: evidence ${file} does not exist`);
    if (
      row.status === "VERIFIED" &&
      !row.evidence.some((file) => /\.spec\.tsx?$/u.test(file) || file.startsWith("scripts/"))
    )
      errors.push(`${row.id}: VERIFIED without an automated test or measuring script`);
    if (row.status !== "VERIFIED" && row.notes.length === 0)
      errors.push(`${row.id}: ${row.status} needs a note saying what is missing`);
  }
  return errors;
}

/** Release gaps: every PENDING or GAP row. */
export function releaseGaps(rows: readonly ChecklistRow[]): string[] {
  return rows
    .filter((row) => row.status !== "VERIFIED")
    .map((row) => `${row.id} ${row.status}: ${row.notes}`);
}

/** Consistency rules between measured or recorded facts and row statuses. */
export function checkConsistency(
  rows: readonly ChecklistRow[],
  facts: {
    failedMeasurements: string[];
    performanceDoc: string;
    audioReleaseStatus: string | null;
  },
): string[] {
  const errors: string[] = [];
  const status = (id: string) => rows.find((row) => row.id === id)?.status;
  if (!/# Player bundle and cold-load budgets/u.test(facts.performanceDoc))
    errors.push("docs/performance-results.md: player bundle budgets not recorded");
  if (
    !/### Memory mode/u.test(facts.performanceDoc) ||
    !/### Redis mode/u.test(facts.performanceDoc)
  )
    errors.push("docs/performance-results.md: broadcast results for both topologies not recorded");
  const recordedFail = /\*\*FAIL\*\*/u.test(facts.performanceDoc);
  for (const id of ["NFR-01", "NFR-02"])
    if (status(id) === "VERIFIED" && (recordedFail || facts.failedMeasurements.length > 0))
      errors.push(
        `${id}: VERIFIED although a measurement failed (${facts.failedMeasurements.join(", ") || "docs/performance-results.md"})`,
      );
  if (facts.audioReleaseStatus !== "cleared")
    for (const id of ["US-19", "AC-19-02"])
      if (status(id) === "VERIFIED")
        errors.push(
          `${id}: VERIFIED although the audio is ${facts.audioReleaseStatus ?? "without a release status"}`,
        );
  return errors;
}

/** Catalog pair check: both registries present and identical. */
export function checkCatalogPair(api: string | null, web: string | null): string[] {
  if (api === null || web === null)
    return [
      "catalog pair: locales-built/registry.json or apps/web/public/locales/registry.json missing (run pnpm build)",
    ];
  return api === web
    ? []
    : ["catalog pair: API and web locale registries differ (unmatched buildId)"];
}

/** Reads a file or null. */
const readOrNull = (file: string) => readFile(file, "utf8").catch(() => null);

/** Runs the gate; returns the record. */
export async function verifyRelease(root = ROOT) {
  const prd = await readFile(path.join(root, "docs/vibe/01-prd.md"), "utf8");
  const checklist = await readFile(path.join(root, "docs/release-checklist.md"), "utf8");
  const rows = parseChecklist(checklist);
  const required = requirementIds(prd);
  const errors = checkRows(rows, required, (file) => existsSync(path.join(root, file)));
  errors.push(
    ...checkCatalogPair(
      await readOrNull(path.join(root, "locales-built/registry.json")),
      await readOrNull(path.join(root, "apps/web/public/locales/registry.json")),
    ),
  );
  const failedMeasurements: string[] = [];
  const benchmarks = path.join(root, "test-results/benchmark");
  for (const file of await readdir(benchmarks).catch(() => [] as string[])) {
    if (!file.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(path.join(benchmarks, file), "utf8")) as {
      target?: { pass?: boolean };
      verdict?: { pass?: boolean };
    };
    const pass = record.target?.pass ?? record.verdict?.pass;
    if (pass === false) failedMeasurements.push(file);
  }
  const provenance = JSON.parse(
    await readFile(path.join(root, "docs/audio-provenance.json"), "utf8"),
  ) as { releaseStatus?: string };
  errors.push(
    ...checkConsistency(rows, {
      failedMeasurements,
      performanceDoc: (await readOrNull(path.join(root, "docs/performance-results.md"))) ?? "",
      audioReleaseStatus: provenance.releaseStatus ?? null,
    }),
  );
  const gaps = releaseGaps(rows);
  return {
    checkedAt: new Date().toISOString(),
    requirements: required.length,
    rows: rows.length,
    verified: rows.filter((row) => row.status === "VERIFIED").length,
    errors,
    gaps,
    failedMeasurements,
  };
}

/** CLI entry: errors always fail; gaps fail unless --report. */
async function main() {
  const { values } = parseArgs({
    options: { report: { type: "boolean", default: false }, out: { type: "string" } },
  });
  const record = await verifyRelease();
  const out = path.resolve(
    values.out ?? path.join(ROOT, "test-results/release/verify-release.json"),
  );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `Release evidence: ${record.verified}/${record.rows} rows verified for ${record.requirements} requirements.\n`,
  );
  for (const error of record.errors) process.stdout.write(`ERROR ${error}\n`);
  for (const gap of record.gaps) process.stdout.write(`GAP   ${gap}\n`);
  const blocked = record.errors.length > 0 || (!values.report && record.gaps.length > 0);
  process.stdout.write(
    blocked
      ? `Release gate: BLOCKED (${record.errors.length} error(s), ${record.gaps.length} gap(s))${values.report ? "" : "; use --report to list without failing"}\n`
      : `Release gate: ${record.gaps.length > 0 ? `report only, ${record.gaps.length} gap(s) remain` : "PASS"}\n`,
  );
  if (blocked) process.exitCode = 1;
}

if (typeof require !== "undefined" && require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `verify-release failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
