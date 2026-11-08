/**
 * TASK-078 coverage on SQLite + the memory state store: one ACTIVE room per create request across
 * retries and two concurrent "instances", quiz authorization/revision/playability, 32-attempt PIN
 * collisions, the active-room cap, and a crash at every boundary (before state, after state,
 * stale CREATING with and without state, allocation lost before activation).
 */
import { randomUUID } from "node:crypto";
import {
  AuthRepository,
  QuizzesRepository,
  RuntimeRepository,
  SettingsRepository,
  UsersRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
} from "@kabuki-neko/database";
import { quizWriteSchema } from "@kabuki-neko/shared/schemas/quiz.schema";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { JwtGuard, type VerifiedPrincipal } from "../../common/guards/jwt.guard";
import { MemoryStateStore } from "../../providers/state/memory-state.store";
import { RefreshService } from "../auth/refresh.service";
import { projectRoom } from "./room-projector";
import { RoomRegistryService, type CreateRoomRequest } from "./room-registry.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
let refresh: RefreshService;
let jwt: JwtGuard;

/** Config with an overridable active-room cap. */
function config(maxRooms = "20") {
  return new ConfigService(parseEnvironment({ NODE_ENV: "test", MAX_ACTIVE_ROOMS: maxRooms }), {
    accessSecret: "a".repeat(64),
    refreshSecret: "b".repeat(64),
  });
}
/** A registry bound to a given runtime repository/store (one simulated API instance). */
function registry(runtime: RuntimeRepository, store: MemoryStateStore, maxRooms = "20") {
  return new RoomRegistryService(runtime, quizzes, settings, store, config(maxRooms), jwt);
}
/** Creates a user and returns its verified principal. */
async function identity(): Promise<VerifiedPrincipal> {
  const id = randomUUID();
  await db.manager.insert("users", {
    id,
    name: "Host",
    email: `${id}@example.org`,
    password_hash: "fixture",
    created_at: 1,
    updated_at: 1,
  });
  return jwt.authenticate(refresh.issue({ id, auth_version: 1 }).accessToken);
}
/** Creates a quiz; playable unless `draft`, PUBLIC when requested. Returns id and revision. */
async function quiz(
  owner: VerifiedPrincipal,
  options: { draft?: boolean; visibility?: "PUBLIC" | "PRIVATE" } = {},
) {
  const id = await quizzes.create(
    owner.user.id,
    { title: "Quiz", visibility: options.visibility ?? "PRIVATE" },
    1,
  );
  if (options.draft) return { id, revision: 1 };
  const source = await quizzes.read(owner.user.id, id);
  const write = quizWriteSchema.parse({
    ...source.content,
    questions: source.content.questions.map((question) => ({
      ...question,
      promptText: "Which is right?",
      options: question.options.map((option, index) => ({
        ...option,
        optionText: index === 0 ? "Right" : "Wrong",
      })),
    })),
  });
  return { id, revision: await quizzes.save(owner.user.id, id, 1, write, 2) };
}
/** A create request for `quizId`. */
function request(
  quizId: string,
  revision: number,
  extra: Partial<CreateRoomRequest> = {},
): CreateRoomRequest {
  return {
    requestId: randomUUID(),
    quizId,
    quizRevision: revision,
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
    ...extra,
  };
}
/** Allocation rows. */
function allocations() {
  return db
    .getRepository<{ id: string; status: string; pin_code: string }>("room_allocations")
    .find();
}

beforeAll(async () => {
  const cfg = config();
  refresh = new RefreshService(cfg, new AuthRepository(db), new UsersRepository(db));
  jwt = new JwtGuard(refresh);
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  for (const table of [
    "request_dedup",
    "room_media",
    "room_allocations",
    "question_options",
    "questions",
    "quizzes",
    "users",
  ])
    await db.manager.clear(table);
});

it("creates exactly one ACTIVE room per request across retries and concurrent instances", async () => {
  const host = await identity();
  const { id, revision } = await quiz(host);
  const store = new MemoryStateStore(projectRoom);
  const runtime = new RuntimeRepository(db);
  const first = registry(runtime, store),
    second = registry(new RuntimeRepository(db), store);
  const req = request(id, revision);
  const [a, b] = await Promise.all([first.createRoom(host, req), second.createRoom(host, req)]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ phaseVersion: 1, pinCode: expect.stringMatching(/^\d{6}$/u) });
  expect(await allocations()).toEqual([
    expect.objectContaining({ id: a.sessionId, status: "ACTIVE" }),
  ]);
  expect(await first.createRoom(host, req)).toEqual(a);
  const snapshot = await store.getRoleSnapshot(
    { pin: a.pinCode, sessionId: a.sessionId },
    { role: "host", hostId: host.user.id },
  );
  expect(snapshot).toMatchObject({
    phase: "LOBBY",
    phaseVersion: 1,
    quizTitle: "Quiz",
    totalQuestions: 1,
  });
  expect(snapshot?.maxPlayers).toBeGreaterThan(0);
  await expect(first.createRoom(host, { ...req, displayMode: "STREAMER" })).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
  });
});

it("authorizes own or PUBLIC playable quizzes at the exact revision", async () => {
  const owner = await identity(),
    guest = await identity();
  const store = new MemoryStateStore(projectRoom);
  const service = registry(new RuntimeRepository(db), store);
  const privateQuiz = await quiz(owner);
  await expect(
    service.createRoom(guest, request(privateQuiz.id, privateQuiz.revision)),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  await expect(
    service.createRoom(owner, request(privateQuiz.id, privateQuiz.revision + 1)),
  ).rejects.toMatchObject({ errorCode: "REVISION_CONFLICT" });
  const draft = await quiz(owner, { draft: true });
  await expect(service.createRoom(owner, request(draft.id, draft.revision))).rejects.toMatchObject({
    errorCode: "QUIZ_NOT_PLAYABLE",
  });
  expect(await allocations()).toEqual([]);
  const shared = await quiz(owner, { visibility: "PUBLIC" });
  const ack = await service.createRoom(guest, request(shared.id, shared.revision));
  const state = await store.getPrivateSnapshot({ pin: ack.pinCode, sessionId: ack.sessionId });
  expect(state?.hostId).toBe(guest.user.id);
});

it("retries PIN collisions up to 32 attempts and enforces the active-room cap", async () => {
  const host = await identity();
  const { id, revision } = await quiz(host);
  const store = new MemoryStateStore(projectRoom);
  const pins = ["111111", ...Array.from({ length: 31 }, () => "111111"), "222222"];
  const runtime = new RuntimeRepository(db, () => pins.shift() ?? "111111");
  const service = registry(runtime, store);
  expect((await service.createRoom(host, request(id, revision))).pinCode).toBe("111111");
  expect((await service.createRoom(host, request(id, revision))).pinCode).toBe("222222");
  await expect(service.createRoom(host, request(id, revision))).rejects.toMatchObject({
    errorCode: "PIN_EXHAUSTED",
  });
  const capped = registry(new RuntimeRepository(db), store, "2");
  await expect(capped.createRoom(host, request(id, revision))).rejects.toMatchObject({
    errorCode: "CAPACITY_REACHED",
  });
  expect(await allocations()).toHaveLength(2);
});

it("recovers from a crash at every create boundary without duplicate or dead rooms", async () => {
  const host = await identity();
  const { id, revision } = await quiz(host);
  const store = new MemoryStateStore(projectRoom);
  const runtime = new RuntimeRepository(db);
  const service = registry(runtime, store);

  // Crash after the SQL reservation, before state creation: the retry builds the same room.
  const beforeState = request(id, revision);
  const create = jest.spyOn(store, "createRoom").mockRejectedValueOnce(new Error("process died"));
  await expect(service.createRoom(host, beforeState)).rejects.toThrow("process died");
  expect((await allocations())[0]?.status).toBe("CREATING");
  create.mockRestore();
  const recovered = await service.createRoom(host, beforeState);
  expect(await allocations()).toEqual([
    expect.objectContaining({ id: recovered.sessionId, status: "ACTIVE" }),
  ]);

  // Crash after state creation, before activation: same session after retry.
  const afterState = request(id, revision);
  const activate = jest.spyOn(runtime, "activate").mockRejectedValueOnce(new Error("db hiccup"));
  await expect(service.createRoom(host, afterState)).rejects.toMatchObject({
    errorCode: "ROOM_LOST",
  });
  activate.mockRestore();
  const retried = await service.createRoom(host, afterState);
  expect((await runtime.find(retried.sessionId))?.status).toBe("ACTIVE");
  expect(
    await store.getPrivateSnapshot({ pin: retried.pinCode, sessionId: retried.sessionId }),
  ).not.toBeNull();

  // Stale CREATING rows: with state → activated, without state → released after 120 s.
  const withState = request(id, revision);
  jest.spyOn(runtime, "activate").mockRejectedValueOnce(new Error("crash"));
  const storeRelease = jest.spyOn(store, "releaseRoom").mockResolvedValueOnce(true);
  await expect(service.createRoom(host, withState)).rejects.toMatchObject({
    errorCode: "ROOM_LOST",
  });
  storeRelease.mockRestore();
  const withoutState = request(id, revision);
  jest.spyOn(store, "createRoom").mockRejectedValueOnce(new Error("crash"));
  await expect(service.createRoom(host, withoutState)).rejects.toThrow("crash");
  jest.restoreAllMocks();
  const pending = (await allocations()).filter((row) => row.status === "CREATING");
  expect(pending).toHaveLength(2);
  expect(await service.reconcileCreating(Date.now())).toEqual({ activated: 0, released: 0 });
  expect(await service.reconcileCreating(Date.now() + 121_000)).toEqual({
    activated: 1,
    released: 1,
  });
  expect((await allocations()).filter((row) => row.status === "CREATING")).toEqual([]);

  // Allocation released before activation: the creator removes its state and never ACKs.
  const lost = request(id, revision);
  const original = runtime.activate.bind(runtime);
  jest.spyOn(runtime, "activate").mockImplementationOnce(async (sessionId, now) => {
    const row = await runtime.find(sessionId);
    if (row) await runtime.release(row.id, row.pin_code, now);
    return original(sessionId, now);
  });
  await expect(service.createRoom(host, lost)).rejects.toMatchObject({ errorCode: "ROOM_LOST" });
  const rows = await allocations();
  expect(rows.every((row) => row.status === "ACTIVE")).toBe(true);
  for (const row of rows)
    expect(await store.getPrivateSnapshot({ pin: row.pin_code, sessionId: row.id })).not.toBeNull();
});
