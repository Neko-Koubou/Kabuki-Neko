import { randomBytes, randomUUID } from "node:crypto";
import {
  AuthRepository,
  UsersRepository,
  OperationsRepository,
  QuizzesRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import type { QuizDetail, QuizWrite } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { IdempotencyService } from "../../common/idempotency.service";
import { JwtGuard } from "../../common/guards/jwt.guard";
import { RefreshService } from "../auth/refresh.service";
import { QuizzesService } from "./quizzes.service";
import { createQuizSnapshot } from "./quiz-snapshot";
const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: randomBytes(64).toString("hex"),
  refreshSecret: randomBytes(64).toString("hex"),
});
const refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
const jwt = new JwtGuard(refresh),
  repo = new QuizzesRepository(db);
const service = new QuizzesService(repo, jwt, new IdempotencyService(new OperationsRepository(db)));
async function identity(role: "SUPERADMIN" | "CREATOR" = "CREATOR") {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "Creator",
    email: `${id}@example.org`,
    password_hash: "fixture",
    role,
    created_at: 1,
    updated_at: 1,
  });
  return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
}
function content(detail: QuizDetail): QuizWrite {
  return {
    title: detail.title,
    description: detail.description,
    visibility: detail.visibility,
    coverMediaId: detail.coverMedia?.id ?? null,
    bgmTrack: detail.bgmTrack,
    questions: detail.questions,
  };
}
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of [
    "request_dedup",
    "question_options",
    "questions",
    "quizzes",
    "media_assets",
    "users",
  ])
    await db.manager.clear(table);
});
it("enforces own/public permissions with no administrator bypass and safe capabilities", async () => {
  const owner = await identity(),
    guest = await identity(),
    admin = await identity("SUPERADMIN");
  const privateQuiz = (await service.create(owner, { title: "Private" }, randomUUID())).response;
  for (const outsider of [guest, admin]) {
    await expect(service.read(outsider, privateQuiz.id)).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
    });
    await expect(service.delete(outsider, privateQuiz.id, 1)).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
    });
  }
  const publicQuiz = (
    await service.create(owner, { title: "Public%_", visibility: "PUBLIC" }, randomUUID())
  ).response;
  for (const outsider of [guest, admin]) {
    expect((await service.read(outsider, publicQuiz.id)).capabilities).toMatchObject({
      canEdit: false,
      canDelete: false,
      canDuplicate: true,
    });
    await expect(
      service.save(outsider, publicQuiz.id, 1, content(publicQuiz)),
    ).rejects.toMatchObject({ errorCode: "FORBIDDEN" });
    await expect(service.delete(outsider, publicQuiz.id, 1)).rejects.toMatchObject({
      errorCode: "FORBIDDEN",
    });
  }
  expect(
    (await service.list(guest, { scope: "public", search: "%_" })).items.map((q) => q.id),
  ).toEqual([publicQuiz.id]);
  expect((await service.list(guest, {})).items).toEqual([]);
  const duplicate = (await service.duplicate(guest, publicQuiz.id, randomUUID())).response;
  expect(duplicate.visibility).toBe("PRIVATE");
  expect(duplicate.creatorId).toBe(guest.user.id);
  expect(duplicate.questions[0]?.id).not.toBe(publicQuiz.questions[0]?.id);
  expect(duplicate.questions[0]?.options[0]?.id).not.toBe(publicQuiz.questions[0]?.options[0]?.id);
});
it("commits one create/duplicate per key and rechecks deleted resources on replay", async () => {
  const owner = await identity(),
    key = randomUUID();
  const result = await Promise.all([
    service.create(owner, { title: "Once" }, key),
    service.create(owner, { title: "Once" }, key),
  ]);
  expect(result[0]?.response.id).toBe(result[1]?.response.id);
  expect(await db.manager.count("quizzes")).toBe(1);
  const original = result[0]?.response;
  if (!original) throw new Error("Missing quiz fixture");
  await expect(service.create(owner, { title: "Changed" }, key)).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
  });
  const copyKey = randomUUID();
  const copies = await Promise.all([
    service.duplicate(owner, original.id, copyKey),
    service.duplicate(owner, original.id, copyKey),
  ]);
  expect(copies[0]?.response.id).toBe(copies[1]?.response.id);
  expect(await db.manager.count("quizzes")).toBe(2);
  await service.delete(owner, original.id, 1);
  await expect(service.create(owner, { title: "Once" }, key)).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
});
it("saves incomplete drafts, rejects stale revisions and leaves active snapshots independent", async () => {
  const owner = await identity();
  const draft = (await service.create(owner, { title: "Draft" }, randomUUID())).response;
  expect(draft.isPlayable).toBe(false);
  expect(draft.questions).toHaveLength(1);
  expect(
    draft.validationIssues.some((i) => i.code === "EMPTY_PROMPT" && i.severity === "warning"),
  ).toBe(true);
  const body = content(draft);
  const q = body.questions[0];
  if (!q) throw new Error("Missing question");
  q.promptText = "Select one";
  q.options.forEach((o, i) => {
    o.optionText = `Option ${i}`;
  });
  const saved = await service.save(owner, draft.id, 1, body);
  expect(saved.isPlayable).toBe(true);
  const snapshot = createQuizSnapshot(saved.id, saved.revision, body, new Map(), {
    actorId: owner.user.id,
    retainedMediaIds: new Set(),
  });
  const before = JSON.stringify(snapshot);
  await expect(service.save(owner, saved.id, 1, body)).rejects.toMatchObject({
    errorCode: "REVISION_CONFLICT",
  });
  await service.save(owner, saved.id, 2, { ...body, title: "Changed" });
  await service.delete(owner, saved.id, 3);
  expect(JSON.stringify(snapshot)).toBe(before);
});
it("retains duplicated foreign media without allowing new foreign attachments", async () => {
  const owner = await identity(),
    guest = await identity();
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids)
    await db.manager.insert("media_assets", {
      id,
      uploader_id: owner.user.id,
      storage_driver: "local",
      storage_location_id: "active",
      storage_key: id,
      public_url: `/uploads/${id}.webp`,
      original_name: "image.webp",
      mime_type: "image/webp",
      size_bytes: 1,
      state: "READY",
      accessibility: emptyAccessibility(),
      created_at: 1,
      updated_at: 1,
    });
  const source = (
    await service.create(
      owner,
      { title: "Shared", visibility: "PUBLIC", coverMediaId: ids[0] },
      randomUUID(),
    )
  ).response;
  const copy = (await service.duplicate(guest, source.id, randomUUID())).response;
  expect(copy.coverMedia?.id).toBe(ids[0]);
  expect(copy.coverMedia?.canDelete).toBe(false);
  await service.save(guest, copy.id, 1, content(copy));
  await expect(
    service.save(guest, copy.id, 2, { ...content(copy), coverMediaId: ids[1] }),
  ).rejects.toMatchObject({ status: 422 });
  await service.delete(owner, source.id, 1);
  expect((await service.read(guest, copy.id)).coverMedia?.id).toBe(ids[0]);
});
