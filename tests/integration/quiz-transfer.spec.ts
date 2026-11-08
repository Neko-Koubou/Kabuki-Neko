/**
 * TASK-065 integration coverage for quiz transfer routes against the built API (`apps/api/dist`)
 * on an isolated SQLite runtime: import templates, multipart JSON/CSV import of all six question
 * types, export roundtrips, atomic failure without partial rows, idempotent replay/lookup after a
 * lost acknowledgement, and the owner / PUBLIC / foreign export and import matrix.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import { userSchema } from "@kabuki-neko/shared/schemas/users.schema";
import { quizDetailSchema, type QuizDetail } from "@kabuki-neko/shared/schemas/quiz.schema";
import {
  QUIZ_CSV_HEADERS,
  quizExportV1Schema,
  type QuizExportV1,
} from "@kabuki-neko/shared/schemas/import.schema";
import { createTestRuntime } from "../helpers/runtime";

const SIX_TYPES = [
  "SINGLE_CHOICE",
  "TRUE_FALSE",
  "MULTIPLE_SELECT",
  "TYPE_ANSWER",
  "ORDER_PUZZLE",
  "POLL",
] as const;
const credentialsSchema = z.object({ user: userSchema, accessToken: z.string() });
const errorSchema = z.object({
  errorCode: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })),
});
type Credentials = z.infer<typeof credentialsSchema>;

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let child: ChildProcess;
let base: string;
let admin: Credentials;
let owner: Credentials;
let other: Credentials;
let errors: Credentials;

/** Reserves a free loopback port for the spawned API process. */
async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
/** Sends a JSON (or bodiless) API request with the web client and Origin headers. */
function request(
  path: string,
  method = "GET",
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
/** Posts a multipart import with one `file` part and an optional `mediaMap` JSON field. */
function importFile(
  token: string,
  name: string,
  content: string | Uint8Array<ArrayBuffer>,
  type: string,
  key: string = randomUUID(),
  mediaMap?: Record<string, string>,
) {
  const form = new FormData();
  if (mediaMap) form.append("mediaMap", JSON.stringify(mediaMap));
  form.append("file", new Blob([content], { type }), name);
  return fetch(`${base}/quizzes/import`, {
    method: "POST",
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: form,
  });
}
/** Downloads one of the server import templates as text. */
async function template(format: "json" | "csv") {
  const response = await request(
    `/quizzes/import-template?format=${format}`,
    "GET",
    owner.accessToken,
  );
  expect(response.status).toBe(200);
  return { response, text: await response.text() };
}
/** Exports a quiz and returns the parsed QuizExportV1 document plus the raw response. */
async function exportDocument(token: string, id: string) {
  const response = await request(`/quizzes/${id}/export`, "GET", token);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { response, text, document: quizExportV1Schema.parse(JSON.parse(text)) };
}
/** Imports a file that must succeed and returns the created quiz detail. */
async function imported(token: string, name: string, content: string, type: string) {
  const response = await importFile(token, name, content, type);
  expect(response.status).toBe(201);
  return quizDetailSchema.parse(await response.json());
}
/** Counts quiz graph rows and quiz.import receipts directly in the runtime SQLite file. */
function rowCounts() {
  const db = new Database(runtime.env.SQLITE_PATH ?? "", { readonly: true, fileMustExist: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      quizzes: count("SELECT COUNT(*) AS n FROM quizzes"),
      questions: count("SELECT COUNT(*) AS n FROM questions"),
      options: count("SELECT COUNT(*) AS n FROM question_options"),
      receipts: count("SELECT COUNT(*) AS n FROM request_dedup WHERE operation = 'quiz.import'"),
    };
  } finally {
    db.close();
  }
}
/** Builds a JSON export document whose first question references an unavailable media asset. */
function withMissingMedia(document: QuizExportV1, ref: string): QuizExportV1 {
  const [first, ...rest] = document.questions;
  if (!first) throw new Error("Template has no questions");
  return {
    ...document,
    media: [
      {
        ref,
        mimeType: "image/png",
        originalName: "cover.png",
        publicUrl: "https://attacker.invalid/cover.png",
        accessibility: first.accessibility,
      },
    ],
    questions: [{ ...first, mediaRef: ref }, ...rest],
  };
}
/** Registers a CREATOR account through the public registration flow. */
async function register(name: string, email: string) {
  const response = await request(
    "/auth/register",
    "POST",
    undefined,
    { name, email, password: "Correct-password-123!" },
    { "Idempotency-Key": randomUUID() },
  );
  expect(response.status).toBe(201);
  return credentialsSchema.parse(await response.json());
}

beforeAll(async () => {
  runtime = await createTestRuntime();
  const port = await freePort();
  child = spawn(process.execPath, [join(process.cwd(), "apps/api/dist/main.js")], {
    cwd: runtime.directory,
    env: { ...process.env, ...runtime.env, API_PORT: String(port), PORT: String(port) },
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}/api/v1`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error("API exited during startup");
    try {
      ready = (await fetch(`${base}/auth/setup-status`)).status === 200;
    } catch {
      /* Wait for server startup. */
    }
    if (!ready) await delay(100);
  }
  expect(ready).toBe(true);
  const setup = await request(
    "/auth/setup",
    "POST",
    undefined,
    {
      instanceName: "Transfer integration",
      name: "Admin",
      email: "admin@example.org",
      password: "Correct-password-123!",
    },
    { "Idempotency-Key": randomUUID() },
  );
  expect(setup.status).toBe(201);
  admin = credentialsSchema.parse(await setup.json());
  owner = await register("Owner", "owner@example.org");
  other = await register("Other", "other@example.org");
  errors = await register("Errors", "errors@example.org");
});

afterAll(async () => {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await runtime.cleanup();
});

it("serves six-type JSON and exact-header CSV import templates", async () => {
  expect((await request("/quizzes/import-template")).status).toBe(401);
  const json = await template("json");
  expect(json.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(json.response.headers.get("content-disposition")).toBe(
    'attachment; filename="kabukineko-import-template.json"',
  );
  const document = quizExportV1Schema.parse(JSON.parse(json.text));
  expect(document.questions.map((q) => q.type)).toEqual(SIX_TYPES);
  expect(
    document.questions.find((q) => q.type === "ORDER_PUZZLE")?.options.map((o) => o.sortOrder),
  ).toEqual([2, 0, 3, 1]);
  expect(document.questions.find((q) => q.type === "TYPE_ANSWER")?.options).toHaveLength(2);
  const csv = await template("csv");
  expect(csv.response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(csv.response.headers.get("content-disposition")).toBe(
    'attachment; filename="kabukineko-import-template.csv"',
  );
  const lines = csv.text.split("\r\n");
  expect(lines[0]).toBe(QUIZ_CSV_HEADERS.join(","));
  expect(lines.filter(Boolean)).toHaveLength(7);
  expect(
    (await request("/quizzes/import-template?format=xml", "GET", owner.accessToken)).status,
  ).toBe(422);
  expect((await request("/quizzes/import-template?extra=1", "GET", owner.accessToken)).status).toBe(
    422,
  );
});

it("imports both templates and roundtrips all six types through export", async () => {
  const jsonTemplate = quizExportV1Schema.parse(JSON.parse((await template("json")).text));
  const fromJson = await imported(
    owner.accessToken,
    "template.json",
    JSON.stringify(jsonTemplate),
    "application/json",
  );
  expect(fromJson).toMatchObject({
    visibility: "PRIVATE",
    creatorId: owner.user.id,
    isPlayable: true,
  });
  expect(fromJson.questions.map((q) => q.type)).toEqual(SIX_TYPES);
  const fromCsv = await imported(
    owner.accessToken,
    "template.CSV",
    (await template("csv")).text,
    "text/csv",
  );
  expect(fromCsv.isPlayable).toBe(true);
  expect(fromCsv.id).not.toBe(fromJson.id);

  const exported = await exportDocument(owner.accessToken, fromJson.id);
  expect(exported.response.headers.get("content-disposition")).toBe(
    `attachment; filename="${fromJson.id}.kabukineko.json"`,
  );
  expect(exported.document.quiz).toEqual(jsonTemplate.quiz);
  expect(exported.document.questions).toEqual(jsonTemplate.questions);
  expect(exported.text).not.toContain(owner.user.id);
  expect(exported.text).not.toContain(fromJson.questions[0]?.id ?? "missing");
  expect((await exportDocument(owner.accessToken, fromCsv.id)).document.questions).toEqual(
    jsonTemplate.questions,
  );
  const again = await imported(
    owner.accessToken,
    "roundtrip.json",
    exported.text,
    "application/json",
  );
  expect((await exportDocument(owner.accessToken, again.id)).document).toEqual(exported.document);
  expect(
    (await request(`/quizzes/${fromJson.id}/export?format=csv`, "GET", owner.accessToken)).status,
  ).toBe(422);
});

it("rejects missing media without creating partial rows or receipts", async () => {
  const document = quizExportV1Schema.parse(JSON.parse((await template("json")).text));
  const before = rowCounts();
  const ref = randomUUID();
  const key = randomUUID();
  const missing = await importFile(
    other.accessToken,
    "missing.json",
    JSON.stringify(withMissingMedia(document, ref)),
    "application/json",
    key,
  );
  expect(missing.status).toBe(422);
  const issue = errorSchema.parse(await missing.json());
  expect(issue.errorCode).toBe("IMPORT_VALIDATION_FAILED");
  expect(issue.details).toContainEqual(
    expect.objectContaining({ path: "questions.0.mediaRef", code: "INVALID_REFERENCE" }),
  );
  const mapped = await importFile(
    other.accessToken,
    "mapped.json",
    JSON.stringify(withMissingMedia(document, ref)),
    "application/json",
    randomUUID(),
    { [ref]: randomUUID() },
  );
  expect(mapped.status).toBe(422);
  const csvRows = (await template("csv")).text.split("\r\n");
  csvRows[1] = (csvRows[1] ?? "").replace(",20,1,,,0,", `,20,1,${randomUUID()},,0,`);
  const csvMissing = await importFile(
    other.accessToken,
    "missing.csv",
    csvRows.join("\r\n"),
    "text/csv",
  );
  expect(csvMissing.status).toBe(422);
  expect(errorSchema.parse(await csvMissing.json()).details).toContainEqual(
    expect.objectContaining({ path: "rows.2.media_ref", code: "INVALID_REFERENCE" }),
  );
  expect(rowCounts()).toEqual(before);
  // The failed attempt rolled back its receipt, so the same key is free for a corrected file.
  const corrected = await importFile(
    other.accessToken,
    "fixed.json",
    JSON.stringify(document),
    "application/json",
    key,
  );
  expect(corrected.status).toBe(201);
  const after = rowCounts();
  expect(after.quizzes).toBe(before.quizzes + 1);
  expect(after.receipts).toBe(before.receipts + 1);
});

it("maps malformed, oversized and unsupported uploads to stable errors", async () => {
  const token = errors.accessToken;
  const code = async (response: Response) => [
    response.status,
    errorSchema.parse(await response.json()).errorCode,
  ];
  expect(await code(await importFile(token, "bad.json", "{", "application/json"))).toEqual([
    400,
    "MALFORMED_JSON",
  ]);
  expect(await code(await importFile(token, "bad.csv", "a,b\r\n1,2\r\n", "text/csv"))).toEqual([
    400,
    "MALFORMED_CSV",
  ]);
  expect(
    await code(
      await importFile(
        token,
        "v2.json",
        JSON.stringify({ format: "kabukineko.quiz", schemaVersion: 2 }),
        "application/json",
      ),
    ),
  ).toEqual([422, "UNSUPPORTED_IMPORT_VERSION"]);
  expect(await code(await importFile(token, "quiz.txt", "{}", "text/plain"))).toEqual([
    415,
    "UNSUPPORTED_CONTENT_TYPE",
  ]);
  expect(await code(await importFile(token, "quiz.json", "{}", "image/png"))).toEqual([
    415,
    "UNSUPPORTED_CONTENT_TYPE",
  ]);
  expect(
    await code(
      await request("/quizzes/import", "POST", token, {}, { "Idempotency-Key": randomUUID() }),
    ),
  ).toEqual([415, "UNSUPPORTED_CONTENT_TYPE"]);
  const map = new FormData();
  map.append("mediaMap", "{}");
  const noFile = await fetch(`${base}/quizzes/import`, {
    method: "POST",
    headers: {
      "X-Kabuki-Client": "web-v1",
      Origin: "http://localhost:3000",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": randomUUID(),
    },
    body: map,
  });
  expect(await code(noFile)).toEqual([422, "VALIDATION_FAILED"]);
  const badMap = await importFile(token, "quiz.json", "{}", "application/json", randomUUID(), {
    "not-a-uuid": "x",
  });
  expect(await code(badMap)).toEqual([422, "VALIDATION_FAILED"]);
  const huge = await importFile(
    token,
    "huge.json",
    new Uint8Array(5 * 1024 * 1024 + 1).fill(32),
    "application/json",
  );
  expect(await code(huge)).toEqual([413, "PAYLOAD_TOO_LARGE"]);
  expect(rowCounts().quizzes).toBeGreaterThan(0);
});

it("replays a lost acknowledgement by key and exposes it through operation lookup", async () => {
  const text = (await template("json")).text;
  const key = randomUUID();
  const first = await importFile(owner.accessToken, "ack.json", text, "application/json", key);
  expect(first.status).toBe(201);
  const created = quizDetailSchema.parse(await first.json());
  // The client never saw the response above; it reconciles by lookup, then retries the same key.
  const lookup = await request(
    `/operations/${key}?operation=quiz.import`,
    "GET",
    owner.accessToken,
  );
  expect(lookup.status).toBe(200);
  expect(await lookup.json()).toEqual({
    key,
    operation: "quiz.import",
    status: "done",
    resourceId: created.id,
  });
  expect(
    (await request(`/operations/${key}?operation=quiz.import`, "GET", other.accessToken)).status,
  ).toBe(404);
  expect(
    (await request(`/operations/${randomUUID()}?operation=quiz.import`, "GET", owner.accessToken))
      .status,
  ).toBe(404);
  const before = rowCounts();
  const retry = await importFile(owner.accessToken, "ack.json", text, "application/json", key);
  expect(retry.status).toBe(201);
  expect(quizDetailSchema.parse(await retry.json()).id).toBe(created.id);
  expect(rowCounts()).toEqual(before);
  const conflict = await importFile(
    owner.accessToken,
    "ack.json",
    `${text} `,
    "application/json",
    key,
  );
  expect(conflict.status).toBe(409);
  expect(errorSchema.parse(await conflict.json()).errorCode).toBe("IDEMPOTENCY_CONFLICT");
  const deleted = await request(`/quizzes/${created.id}`, "DELETE", owner.accessToken, undefined, {
    "If-Match": `"${created.revision}"`,
  });
  expect(deleted.status).toBe(200);
  expect(
    (await importFile(owner.accessToken, "ack.json", text, "application/json", key)).status,
  ).toBe(404);
});

it("enforces the owner, PUBLIC and foreign source matrix for export and import", async () => {
  const source: QuizDetail = await imported(
    owner.accessToken,
    "source.json",
    (await template("json")).text,
    "application/json",
  );
  expect((await request(`/quizzes/${source.id}/export`, "GET", other.accessToken)).status).toBe(
    404,
  );
  expect((await request(`/quizzes/${source.id}/export`, "GET", admin.accessToken)).status).toBe(
    404,
  );
  expect((await request(`/quizzes/${source.id}/export`)).status).toBe(401);
  const published = await request(
    `/quizzes/${source.id}`,
    "PUT",
    owner.accessToken,
    {
      title: 'Public "quiz"é',
      description: source.description,
      visibility: "PUBLIC",
      coverMediaId: null,
      bgmTrack: source.bgmTrack,
      questions: source.questions,
    },
    { "If-Match": `"${source.revision}"` },
  );
  expect(published.status).toBe(200);
  const shared = await exportDocument(other.accessToken, source.id);
  expect(shared.response.headers.get("content-disposition")).toBe(
    `attachment; filename="${source.id}.kabukineko.json"`,
  );
  expect(shared.document.quiz.visibility).toBe("PUBLIC");
  const copy = await imported(other.accessToken, "shared.json", shared.text, "application/json");
  expect(copy).toMatchObject({ creatorId: other.user.id, visibility: "PRIVATE", isPlayable: true });
  expect(copy.validationIssues).toContainEqual(
    expect.objectContaining({ code: "IMPORTED_AS_PRIVATE", severity: "warning" }),
  );
  expect((await request(`/quizzes/${copy.id}/export`, "GET", owner.accessToken)).status).toBe(404);
  expect((await request(`/quizzes/${copy.id}`, "GET", other.accessToken)).status).toBe(200);
});
