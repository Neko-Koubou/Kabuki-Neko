import { Test } from "@nestjs/testing";
import request from "supertest";
import { OperationsController, OperationsAccess } from "./operations.controller";
import { configureHttpBoundary } from "./request-context.middleware";
import { randomUUID } from "node:crypto";
import {
  createDataSource,
  domainSchemas,
  migrateDatabase,
  OperationsRepository,
  OPERATION_TIMING,
} from "@kabuki-neko/database";
import { IdempotencyService, type HttpOperation } from "./idempotency.service";
import { ApiError } from "./error.filter";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const service = new IdempotencyService(new OperationsRepository(db));
const allowed = async () => {};
const input = (): HttpOperation => ({
  actorScope: randomUUID(),
  operation: "quiz.create",
  key: randomUUID(),
  method: "POST",
  path: "/api/v1/quizzes",
  query: {},
  body: { title: "Quiz", visibility: "PRIVATE" },
});
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.manager.clear("request_dedup");
});

it("recovers a lost response once and rechecks current access on every replay", async () => {
  const request = input(),
    id = randomUUID();
  const mutate = jest.fn(async () => ({ httpStatus: 201, resourceId: id, response: { id } }));
  const replay = jest.fn(async (resourceId) => ({ id: resourceId as string }));
  const authorize = jest.fn(allowed);
  const first = await service.execute(request, mutate, replay, authorize);
  expect(
    await service.execute(
      { ...request, body: { visibility: "PRIVATE", title: "Quiz" } },
      mutate,
      replay,
      authorize,
    ),
  ).toEqual(first);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(1);
  await expect(
    service.execute(request, mutate, replay, async () => {
      throw new ApiError("NOT_FOUND", 404);
    }),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  expect(replay).toHaveBeenCalledTimes(1);
  await expect(
    service.execute({ ...request, body: { title: "Different" } }, mutate, replay, allowed),
  ).rejects.toMatchObject({ errorCode: "IDEMPOTENCY_CONFLICT", status: 409 });
});

it("isolates actors and validates operation lookup without exposing stored payloads", async () => {
  const request = input(),
    id = randomUUID();
  await service.execute(
    request,
    async () => ({ httpStatus: 201, resourceId: id, response: id }),
    async () => id,
    allowed,
  );
  expect(
    await service.lookup(
      request.actorScope,
      request.key,
      { operation: request.operation },
      allowed,
    ),
  ).toEqual({ key: request.key, operation: request.operation, status: "done", resourceId: id });
  await expect(
    service.lookup(randomUUID(), request.key, { operation: request.operation }, allowed),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
  await expect(
    service.lookup(request.actorScope, request.key, { operation: "auth.setup" }, allowed),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  await expect(
    service.lookup(
      request.actorScope,
      request.key,
      { operation: request.operation, actorScope: randomUUID() },
      allowed,
    ),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
});

it.each(["auth.setup", "auth.register", "invitation.create"] as const)(
  "never replays %s credentials",
  async (operation) => {
    const request = { ...input(), operation },
      id = randomUUID();
    const mutate = jest.fn(async () => ({
      httpStatus: 201,
      resourceId: id,
      response: "CREDENTIAL-CANARY",
    }));
    const replay = jest.fn(async () => "CREDENTIAL-CANARY");
    expect((await service.execute(request, mutate, replay, allowed)).response).toBe(
      "CREDENTIAL-CANARY",
    );
    await expect(service.execute(request, mutate, replay, allowed)).rejects.toMatchObject({
      errorCode:
        operation === "invitation.create"
          ? "INVITE_CODE_ALREADY_ISSUED"
          : "OPERATION_COMPLETED_REAUTH_REQUIRED",
      status: 409,
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
    expect(JSON.stringify(await db.manager.find("request_dedup"))).not.toContain(
      "CREDENTIAL-CANARY",
    );
  },
);

it("reconciles an expired lease from its resource instead of repeating side effects", async () => {
  const request = { ...input(), operation: "media.upload" as const },
    id = randomUUID();
  const reserve = jest.fn(async () => ({ pendingResourceId: id }));
  const reconcile = jest.fn(async () => ({ httpStatus: 201, resourceId: id }));
  const row = await service.reserve(request, reserve, reconcile, allowed);
  expect(row.state).toBe("PENDING");
  expect(await service.renew(row.id)).toBe(true);
  await expect(service.reserve(request, reserve, reconcile, allowed)).rejects.toMatchObject({
    errorCode: "OPERATION_PENDING",
  });
  await db.manager.update("request_dedup", row.id, { lease_until: Date.now() - 1 });
  expect(await service.renew(row.id)).toBe(false);
  const recovered = await service.reserve(request, reserve, reconcile, allowed);
  expect(recovered.state).toBe("DONE");
  expect(recovered.resource_id).toBe(id);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(row.expires_at - row.created_at).toBe(OPERATION_TIMING.retentionMs);
});

it("rolls back failed SQL mutations so the same key can retry safely", async () => {
  const request = input(),
    id = randomUUID();
  await expect(
    service.execute(
      request,
      async () => {
        throw new ApiError("INVALID_REFERENCE", 422);
      },
      async () => id,
      allowed,
    ),
  ).rejects.toMatchObject({ errorCode: "INVALID_REFERENCE" });
  expect(await db.manager.count("request_dedup")).toBe(0);
  await service.execute(
    request,
    async () => ({ httpStatus: 201, resourceId: id, response: id }),
    async () => id,
    allowed,
  );
  expect(await db.manager.count("request_dedup")).toBe(1);
});

it("hashes multipart content and includes the digest in conflict detection", async () => {
  async function* chunks(text: string) {
    yield Buffer.from(text);
  }
  const digest = await service.fileHash(chunks("abc"));
  expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const request = { ...input(), fileSha256: digest },
    id = randomUUID();
  const mutate = async () => ({ httpStatus: 201, resourceId: id, response: id });
  await service.execute(request, mutate, async () => id, allowed);
  await expect(
    service.execute(
      { ...request, fileSha256: await service.fileHash(chunks("changed")) },
      mutate,
      async () => id,
      allowed,
    ),
  ).rejects.toMatchObject({ errorCode: "IDEMPOTENCY_CONFLICT" });
});

it("renews long work at 30 seconds and refuses success after lease loss", async () => {
  jest.useFakeTimers();
  const repository = new OperationsRepository(db);
  const leased = new IdempotencyService(repository);
  const renew = jest
    .spyOn(repository, "renew")
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  let finish: (() => void) | undefined;
  const running = leased.withLease(
    randomUUID(),
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(running).rejects.toMatchObject({ errorCode: "OPERATION_PENDING" });
  try {
    await jest.advanceTimersByTimeAsync(60000);
    expect(renew).toHaveBeenCalledTimes(2);
    finish?.();
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it("exposes a strict HTTP lookup using only the authenticated actor", async () => {
  const operation = input(),
    id = randomUUID();
  await service.execute(
    operation,
    async () => ({ httpStatus: 201, resourceId: id, response: id }),
    async () => id,
    allowed,
  );
  const access = {
    authenticate: jest.fn(async () => operation.actorScope),
    authorize: jest.fn(allowed),
  };
  const module = await Test.createTestingModule({
    controllers: [OperationsController],
    providers: [
      { provide: IdempotencyService, useValue: service },
      { provide: OperationsAccess, useValue: access },
    ],
  }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  configureHttpBoundary(app);
  app.setGlobalPrefix("api/v1");
  await app.init();
  try {
    const url = `/api/v1/operations/${operation.key}`;
    await request(app.getHttpServer())
      .get(url)
      .query({ operation: "quiz.create" })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ status: "done", resourceId: id });
      });
    await request(app.getHttpServer())
      .get(url)
      .query({ operation: "quiz.create", actorScope: operation.actorScope })
      .expect(422);
    access.authenticate.mockResolvedValueOnce(randomUUID());
    await request(app.getHttpServer()).get(url).query({ operation: "quiz.create" }).expect(404);
    access.authenticate.mockRejectedValueOnce(new ApiError("AUTH_REQUIRED", 401));
    await request(app.getHttpServer()).get(url).query({ operation: "quiz.create" }).expect(401);
  } finally {
    await app.close();
  }
});
