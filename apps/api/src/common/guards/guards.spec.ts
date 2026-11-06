import { randomBytes, randomUUID } from "node:crypto";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import {
  AuthRepository,
  UsersRepository,
  QuizzesRepository,
  ReportsRepository,
  createDataSource,
  domainSchemas,
  migrateDatabase,
  writeTransaction,
  insertAccount,
  type UserRow,
} from "@kabuki-neko/database";
import { ConfigService } from "../../config/config.service";
import { parseEnvironment } from "../../config/env.schema";
import { RefreshService } from "../../modules/auth/refresh.service";
import { configureHttpBoundary } from "../request-context.middleware";
import { JwtGuard, type VerifiedPrincipal } from "./jwt.guard";
import { RolesGuard, RequireRoles } from "./roles.guard";
import { OwnershipGuard, RequireOwnership } from "./ownership.guard";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: randomBytes(64).toString("hex"),
  refreshSecret: randomBytes(64).toString("hex"),
});
const refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
const jwt = new JwtGuard(refresh),
  reflector = new Reflector(),
  quizzes = new QuizzesRepository(db);
const roles = new RolesGuard(jwt, reflector),
  ownership = new OwnershipGuard(jwt, quizzes, new ReportsRepository(db), reflector);
let admin: UserRow, owner: UserRow, stranger: UserRow;
let adminPrincipal: VerifiedPrincipal,
  ownerPrincipal: VerifiedPrincipal,
  strangerPrincipal: VerifiedPrincipal;
let publicQuiz: string, privateQuiz: string, reportId: string, ownerToken: string;
beforeAll(async () => {
  await db.initialize();
  await migrateDatabase(db, true);
  const create = (role: UserRow["role"], email: string) =>
    writeTransaction(db, (manager) =>
      insertAccount(
        manager,
        { id: randomUUID(), email, name: "User", passwordHash: "unused" },
        role,
        Date.now(),
      ),
    );
  admin = await create("SUPERADMIN", "admin@example.org");
  owner = await create("CREATOR", "owner@example.org");
  stranger = await create("CREATOR", "stranger@example.org");
  ownerToken = refresh.issue(owner).accessToken;
  adminPrincipal = await jwt.authenticate(refresh.issue(admin).accessToken);
  ownerPrincipal = await jwt.authenticate(ownerToken);
  strangerPrincipal = await jwt.authenticate(refresh.issue(stranger).accessToken);
  publicQuiz = await quizzes.create(
    owner.id,
    { title: "Public", visibility: "PUBLIC" },
    Date.now(),
  );
  privateQuiz = await quizzes.create(
    owner.id,
    { title: "PRIVATE-TITLE-CANARY", visibility: "PRIVATE" },
    Date.now(),
  );
  reportId = randomUUID();
  await db.manager.insert("game_sessions", {
    id: reportId,
    quiz_id: null,
    quiz_title_snapshot: "REPORT-TITLE-CANARY",
    quiz_revision: 1,
    host_id: owner.id,
    pin_code: "123456",
    display_mode: "PROJECTOR",
    end_reason: "COMPLETED",
    total_players: 0,
    total_questions: 1,
    played_questions: 1,
    started_at: null,
    ended_at: Date.now(),
    created_at: Date.now(),
    schema_version: 1,
    snapshot: {},
  });
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.manager.update("users", owner.id, { is_active: true, auth_version: 1, role: "CREATOR" });
});

it("rejects fabricated identities and ignores role claims in correctly signed tokens", async () => {
  await expect(jwt.current({ user: admin })).rejects.toMatchObject({ errorCode: "AUTH_REQUIRED" });
  await expect(jwt.authenticate(ownerToken + "forged")).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  const token = new JwtService().sign(
    { sub: owner.id, jti: randomUUID(), ver: 1, role: "SUPERADMIN" },
    {
      algorithm: "HS256",
      secret: config.secrets.accessSecret,
      issuer: "kabuki-neko",
      audience: "kabuki-neko-web",
      expiresIn: 900,
    },
  );
  await expect(roles.assert(await jwt.authenticate(token), ["SUPERADMIN"])).rejects.toMatchObject({
    errorCode: "FORBIDDEN",
    status: 403,
  });
  await expect(roles.assert(adminPrincipal, ["SUPERADMIN"])).resolves.toMatchObject({
    id: admin.id,
  });
});

it("rechecks stale and inactive users for protected actions and every host command", async () => {
  await ownership.host(ownerPrincipal, owner.id);
  await db.manager.update("users", owner.id, { auth_version: 2, role: "SUPERADMIN" });
  await expect(ownership.host(ownerPrincipal, owner.id)).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await expect(roles.assert(ownerPrincipal, ["SUPERADMIN"])).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
  await db.manager.update("users", owner.id, { auth_version: 1, is_active: false });
  await expect(ownership.quiz(ownerPrincipal, privateQuiz, "write")).rejects.toMatchObject({
    errorCode: "TOKEN_REVOKED",
  });
});

it("allows PUBLIC reuse but enforces owner-only mutation with no administrator bypass", async () => {
  for (const principal of [adminPrincipal, strangerPrincipal]) {
    expect((await ownership.quiz(principal, publicQuiz, "read")).capabilities.canHost).toBe(true);
    await expect(ownership.quiz(principal, publicQuiz, "write")).rejects.toMatchObject({
      errorCode: "FORBIDDEN",
      status: 403,
    });
    await expect(ownership.quiz(principal, privateQuiz, "read")).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
      status: 404,
    });
    await expect(ownership.quiz(principal, privateQuiz, "write")).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
      status: 404,
    });
  }
  expect((await ownership.quiz(ownerPrincipal, privateQuiz, "write")).row.id).toBe(privateQuiz);
  await expect(ownership.quiz(ownerPrincipal, randomUUID(), "read")).rejects.toMatchObject({
    errorCode: "NOT_FOUND",
  });
});

it("keeps reports and host commands scoped to the actual host", async () => {
  expect((await ownership.report(ownerPrincipal, reportId)).id).toBe(reportId);
  for (const principal of [adminPrincipal, strangerPrincipal]) {
    await expect(ownership.report(principal, reportId)).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
      status: 404,
    });
    await expect(ownership.host(principal, owner.id)).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
      status: 404,
    });
  }
});

@Controller("guard-test")
@UseGuards(JwtGuard)
class GuardTestController {
  @Get("admin")
  @UseGuards(RolesGuard)
  @RequireRoles("SUPERADMIN")
  admin() {
    return { success: true };
  }
  @Get("quiz/:id")
  @UseGuards(OwnershipGuard)
  @RequireOwnership({ kind: "quiz", action: "write" })
  quiz() {
    return { success: true };
  }
}
it("enforces guard metadata at HTTP boundaries without leaking private titles", async () => {
  const module = await Test.createTestingModule({
    controllers: [GuardTestController],
    providers: [
      { provide: JwtGuard, useValue: jwt },
      { provide: RolesGuard, useValue: roles },
      { provide: OwnershipGuard, useValue: ownership },
      { provide: RefreshService, useValue: refresh },
      { provide: QuizzesRepository, useValue: quizzes },
      { provide: ReportsRepository, useValue: new ReportsRepository(db) },
    ],
  }).compile();
  const app = module.createNestApplication({ bodyParser: false });
  configureHttpBoundary(app);
  await app.init();
  try {
    await request(app.getHttpServer()).get("/guard-test/admin").expect(401);
    await request(app.getHttpServer())
      .get("/guard-test/admin")
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/guard-test/quiz/${privateQuiz}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    const denied = await request(app.getHttpServer())
      .get(`/guard-test/quiz/${privateQuiz}`)
      .set("Authorization", `Bearer ${refresh.issue(admin).accessToken}`)
      .expect(404);
    expect(JSON.stringify(denied.body)).not.toContain("PRIVATE-TITLE-CANARY");
    await request(app.getHttpServer())
      .get(`/guard-test/quiz/${publicQuiz}`)
      .query({ playerId: owner.id })
      .set("Authorization", `Bearer ${refresh.issue(stranger).accessToken}`)
      .expect(403);
  } finally {
    await app.close();
  }
});
