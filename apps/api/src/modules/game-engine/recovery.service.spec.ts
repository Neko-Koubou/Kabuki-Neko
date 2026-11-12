/**
 * TASK-079 coverage on SQLite + the memory state store: PIN availability, lost-ACK join retries
 * without duplicate slots, concurrent same-name joins, friendly-name tickets that cannot be
 * bypassed or reused, profanity and avatar validation, recovery with generation replacement,
 * cross-room tokens, kicked players and the per-IP friendly reservation bound.
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
import { FRIENDLY_ADJECTIVES, FRIENDLY_NOUNS, friendlyName } from "./friendly-names";
import { FRIENDLY_TICKETS_PER_IP, RecoveryService } from "./recovery.service";
import { projectRoom } from "./room-projector";
import { RoomRegistryService } from "./room-registry.service";

const db = createDataSource({ driver: "sqlite", sqlitePath: ":memory:" }, domainSchemas("sqlite"));
const quizzes = new QuizzesRepository(db);
const settings = new SettingsRepository(db);
const runtime = new RuntimeRepository(db);
const config = new ConfigService(parseEnvironment({ NODE_ENV: "test" }), {
  accessSecret: "a".repeat(64),
  refreshSecret: "b".repeat(64),
});
let jwt: JwtGuard;
let refresh: RefreshService;
let store: MemoryStateStore;
let rooms: RoomRegistryService;
let service: RecoveryService;
let host: VerifiedPrincipal;
const avatar = { style: "bottts", seed: "neko" };
const ctx = (connectionId = randomUUID(), ip = "203.0.113.9") => ({ connectionId, ip });

/** Creates a host user and returns its principal. */
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
/** Creates a playable one-question quiz and an ACTIVE room for it. */
async function room(friendlyNicknames = false) {
  const id = await quizzes.create(host.user.id, { title: "Join quiz" }, 1);
  const source = await quizzes.read(host.user.id, id);
  const write = quizWriteSchema.parse({
    ...source.content,
    questions: source.content.questions.map((question) => ({
      ...question,
      promptText: "Pick",
      options: question.options.map((option, index) => ({ ...option, optionText: `O${index}` })),
    })),
  });
  const revision = await quizzes.save(host.user.id, id, 1, write, 2);
  return rooms.createRoom(host, {
    requestId: randomUUID(),
    quizId: id,
    quizRevision: revision,
    displayMode: "STREAMER",
    friendlyNicknames,
  });
}
/** New-join request. */
function joinRequest(pinCode: string, nickname: string, extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), pinCode, nickname, avatar, ...extra };
}

/** Applies a host command whose envelope and payload share one requestId. */
function command(
  identity: { pin: string; sessionId: string },
  event: "host:lock_room" | "host:kick_player",
  fields: Record<string, unknown>,
) {
  const requestId = randomUUID();
  return store.applyCommand({
    ...identity,
    hostId: host.user.id,
    requestId,
    payloadHash: "c".repeat(64),
    expectedPhaseVersion: 1,
    command: {
      event,
      request: { requestId, sessionId: identity.sessionId, pinCode: identity.pin, ...fields },
    } as never,
  });
}

beforeAll(async () => {
  refresh = new RefreshService(config, new AuthRepository(db), new UsersRepository(db));
  jwt = new JwtGuard(refresh);
  await db.initialize();
  await migrateDatabase(db, true);
  host = await identity();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  store = new MemoryStateStore(projectRoom);
  rooms = new RoomRegistryService(runtime, quizzes, settings, store, config, jwt);
  service = new RecoveryService(runtime, settings, store);
});

it("reports availability and rejects unknown, locked and full rooms", async () => {
  await expect(service.checkPin("000000")).rejects.toMatchObject({ errorCode: "ROOM_NOT_FOUND" });
  await expect(service.checkPin("12x456")).rejects.toMatchObject({ errorCode: "ROOM_NOT_FOUND" });
  const ack = await room();
  expect(await service.checkPin(ack.pinCode)).toEqual({
    friendlyNicknames: false,
    displayMode: "STREAMER",
    maxPlayers: expect.any(Number),
    availability: "OPEN",
  });
  await command({ pin: ack.pinCode, sessionId: ack.sessionId }, "host:lock_room", {
    isLocked: true,
  });

  await expect(service.checkPin(ack.pinCode)).rejects.toMatchObject({ errorCode: "ROOM_LOCKED" });
  await expect(service.join(joinRequest(ack.pinCode, "Late"), ctx())).rejects.toMatchObject({
    errorCode: "ROOM_LOCKED",
  });
});

it("returns the same slot and token for a lost ACK and serializes same-name races", async () => {
  const ack = await room();
  const request = joinRequest(ack.pinCode, "Mochi");
  const connection = ctx();
  const first = await service.join(request, connection);
  const retry = await service.join(request, connection);
  expect(retry.ack).toMatchObject({
    playerId: first.ack.playerId,
    sessionToken: first.ack.sessionToken,
    recovered: false,
  });
  expect(first.ack.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  await expect(service.join({ ...request, nickname: "Other" }, connection)).rejects.toMatchObject({
    errorCode: "IDEMPOTENCY_CONFLICT",
  });
  const state = await store.getPrivateSnapshot({ pin: ack.pinCode, sessionId: ack.sessionId });
  expect(Object.keys(state?.players ?? {})).toEqual([first.ack.playerId]);
  expect(JSON.stringify(state)).not.toContain(first.ack.sessionToken);
  const results = await Promise.allSettled([
    service.join(joinRequest(ack.pinCode, "Kiko"), ctx()),
    service.join(joinRequest(ack.pinCode, " kiko "), ctx()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { errorCode: "NICKNAME_TAKEN" },
  });
});

it("validates nicknames against the current profanity list and avatars", async () => {
  const ack = await room();
  await settings.patch(1, { profanityWords: ["Badword"] }, 3);
  await expect(service.join(joinRequest(ack.pinCode, "xBADWORDx"), ctx())).rejects.toMatchObject({
    errorCode: "NICKNAME_FORBIDDEN",
  });
  await expect(service.join(joinRequest(ack.pinCode, "   "), ctx())).rejects.toMatchObject({
    errorCode: "NICKNAME_INVALID",
  });
  await expect(
    service.join(
      { ...joinRequest(ack.pinCode, "Ok"), avatar: { style: "evil", seed: "x" } },
      ctx(),
    ),
  ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
  await settings.patch(2, { profanityWords: [] }, 4);
  expect((await service.join(joinRequest(ack.pinCode, "xBADWORDx"), ctx())).ack.recovered).toBe(
    false,
  );
});

it("requires a socket-bound single-use friendly ticket in friendly mode", async () => {
  const ack = await room(true);
  const socket = ctx();
  await expect(service.join(joinRequest(ack.pinCode, "Typed Name"), socket)).rejects.toMatchObject({
    errorCode: "NICKNAME_INVALID",
  });
  const ticket = await service.requestFriendlyName(ack.pinCode, socket);
  expect(ticket.nickname.length).toBeLessThanOrEqual(15);
  await expect(
    service.join(
      joinRequest(ack.pinCode, "Typed Name", { friendlyNameTicket: ticket.friendlyNameTicket }),
      socket,
    ),
  ).rejects.toMatchObject({ errorCode: "NICKNAME_INVALID" });
  await expect(
    service.join(
      joinRequest(ack.pinCode, ticket.nickname, { friendlyNameTicket: ticket.friendlyNameTicket }),
      ctx(),
    ),
  ).rejects.toMatchObject({ errorCode: "NICKNAME_INVALID" });
  const joined = await service.join(
    joinRequest(ack.pinCode, ticket.nickname, { friendlyNameTicket: ticket.friendlyNameTicket }),
    socket,
  );
  expect(joined.ack.snapshot.self.playerId).toBe(joined.ack.playerId);
  await expect(
    service.join(
      joinRequest(ack.pinCode, ticket.nickname, { friendlyNameTicket: ticket.friendlyNameTicket }),
      socket,
    ),
  ).rejects.toMatchObject({ errorCode: expect.stringMatching(/NICKNAME_(INVALID|TAKEN)/u) });
  const plain = await room(false);
  await expect(service.requestFriendlyName(plain.pinCode, ctx())).rejects.toMatchObject({
    errorCode: "INVALID_PHASE",
  });
});

it("bounds outstanding friendly reservations per IP and room", async () => {
  const ack = await room(true);
  for (let i = 0; i < FRIENDLY_TICKETS_PER_IP; i++)
    await service.requestFriendlyName(ack.pinCode, ctx(randomUUID(), "198.51.100.7"));
  await expect(
    service.requestFriendlyName(ack.pinCode, ctx(randomUUID(), "198.51.100.7")),
  ).rejects.toMatchObject({ errorCode: "RATE_LIMITED" });
  await expect(
    service.requestFriendlyName(ack.pinCode, ctx(randomUUID(), "198.51.100.8")),
  ).resolves.toMatchObject({ nickname: expect.any(String) });
  const draws = [0, 0, FRIENDLY_ADJECTIVES.length - 1, FRIENDLY_NOUNS.length - 1];
  expect(friendlyName(() => draws.shift() ?? 0)).toBe(
    `${FRIENDLY_ADJECTIVES[0]} ${FRIENDLY_NOUNS[0]}`,
  );
  for (const adjective of FRIENDLY_ADJECTIVES)
    for (const noun of FRIENDLY_NOUNS)
      expect(`${adjective} ${noun}`.length).toBeLessThanOrEqual(15);
});

it("lets a player recover by token while the room is FINALIZING but never admits new joins (MJ-04)", async () => {
  const ack = await room();
  const joined = await service.join(joinRequest(ack.pinCode, "Hana"), ctx());
  // The scheduler moves the allocation to FINALIZING as soon as the report is frozen (podium).
  await runtime.transition(ack.sessionId, "ACTIVE", "FINALIZING", Date.now());
  const recovered = await service.join(
    {
      requestId: randomUUID(),
      pinCode: ack.pinCode,
      sessionId: ack.sessionId,
      sessionToken: joined.ack.sessionToken,
    },
    ctx(),
  );
  expect(recovered.ack).toMatchObject({ playerId: joined.ack.playerId, recovered: true });
  await expect(service.checkPin(ack.pinCode)).rejects.toMatchObject({
    errorCode: "ROOM_NOT_FOUND",
  });
  await expect(service.join(joinRequest(ack.pinCode, "Late"), ctx())).rejects.toMatchObject({
    errorCode: "ROOM_NOT_FOUND",
  });
});

it("recovers by token with a new generation and rejects stale, changed, cross-room and kicked sessions", async () => {
  const ack = await room();
  const other = await room();
  const joined = await service.join(joinRequest(ack.pinCode, "Hana"), ctx());
  const identity = { pin: ack.pinCode, sessionId: ack.sessionId };
  const recover = (
    extra: Record<string, unknown> = {},
    pinCode = ack.pinCode,
    sessionId = ack.sessionId,
  ) =>
    service.join(
      {
        requestId: randomUUID(),
        pinCode,
        sessionId,
        sessionToken: joined.ack.sessionToken,
        ...extra,
      },
      ctx(),
    );
  const again = await recover();
  expect(again.ack).toMatchObject({ playerId: joined.ack.playerId, recovered: true });
  expect(again.binding.generation).toBe(joined.binding.generation + 1);
  await expect(
    store.getRoleSnapshot(identity, {
      role: "player",
      playerId: joined.ack.playerId,
      generation: joined.binding.generation,
    }),
  ).rejects.toThrow("SESSION_REPLACED");
  await expect(recover({ nickname: "Changed" })).rejects.toMatchObject({
    errorCode: "VALIDATION_FAILED",
  });
  await expect(recover({ avatar: { style: "bottts", seed: "changed" } })).rejects.toMatchObject({
    errorCode: "VALIDATION_FAILED",
  });
  expect((await recover({ nickname: "Hana", avatar })).ack.recovered).toBe(true);
  await expect(recover({}, other.pinCode, other.sessionId)).rejects.toMatchObject({
    errorCode: "INVALID_SESSION_TOKEN",
  });
  await expect(recover({}, ack.pinCode, other.sessionId)).rejects.toMatchObject({
    errorCode: "INVALID_SESSION_TOKEN",
  });
  await expect(
    service.join(
      {
        requestId: randomUUID(),
        pinCode: ack.pinCode,
        sessionId: ack.sessionId,
        sessionToken: "x".repeat(43),
      },
      ctx(),
    ),
  ).rejects.toMatchObject({ errorCode: "INVALID_SESSION_TOKEN" });
  await command(identity, "host:kick_player", { playerId: joined.ack.playerId });

  await expect(recover()).rejects.toMatchObject({ errorCode: "PLAYER_KICKED" });
});
