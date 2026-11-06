import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import Redis from "ioredis";
import { z } from "zod";
import { emptyAccessibility } from "../../packages/shared/src/schemas/media.schema";
import {
  activePlayerSchema,
  activeRoomStateSchema,
} from "../../apps/api/src/providers/state/private-state.schema";
import { createTestRuntime } from "../helpers/runtime";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function question() {
  return {
    id: uuid(2),
    orderIndex: 0,
    type: "TYPE_ANSWER",
    promptText: "Name a cat",
    mediaId: null,
    externalVideoUrl: null,
    videoStartSec: 0,
    videoEndSec: null,
    mediaRevealMode: "NONE",
    timeLimitSec: 20,
    pointsMultiplier: 1,
    explanationText: null,
    accessibility: emptyAccessibility(),
    options: [
      {
        id: uuid(3),
        optionIndex: 0,
        colorIndex: 0,
        optionText: "Neko",
        isCorrect: true,
        sortOrder: 0,
      },
    ],
    publicOptions: [],
    publicToPrivateOptionIds: [],
    mediaSnapshot: null,
  };
}
function quiz() {
  return {
    schemaVersion: 1,
    quizId: uuid(4),
    revision: 1,
    title: "Cats",
    description: null,
    bgmTrack: "random",
    coverMedia: null,
    questions: [question()],
  };
}
function room() {
  return {
    schemaVersion: 1,
    sessionId: uuid(1),
    pinCode: "000123",
    hostId: uuid(5),
    quiz: quiz(),
    displayMode: "PROJECTOR",
    friendlyNicknames: false,
    isLocked: false,
    maxPlayers: 200,
    phase: "LOBBY",
    phaseVersion: 1,
    revision: 1,
    publicRevision: 1,
    questionIndex: null,
    timing: {
      phaseStartedAt: 0,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    createdAt: 0,
    hardExpiresAt: 28800000,
    lobbyActiveAt: 0,
    accepting: false,
    requiredPlayerIds: [],
    eligiblePlayerIds: [],
    players: {},
    answers: {},
    closedQuestions: {},
    results: {},
    commands: {},
    tickets: {},
    frozenReport: null,
    finalization: null,
    endReason: null,
    reservations: { baseBytes: 4096, perPlayerBytes: 51074, maxPublicQuestionBytes: 1024 },
  };
}

function player(n = 6) {
  return activePlayerSchema.parse({
    id: uuid(n),
    nickname: `Cat${n}`,
    nicknameKey: `cat${n}`,
    avatar: { style: "bottts", seed: "cat" },
    joinOrder: n - 6,
    joinedAt: 0,
    kickedAt: null,
    tokenHash: createHash("sha256").update("a".repeat(43)).digest("hex"),
    connectionGeneration: 1,
    connected: true,
    connectionId: `socket${n}`,
    lastSeenAt: 0,
    score: 0,
    streak: 0,
    maxStreak: 0,
    correctCount: 0,
    responseSumMs: 0,
    responseCount: 0,
    rank: null,
    previousRank: null,
  });
}

const session = uuid(1);
const keys = [
  "kabukineko:room:{000123}:meta",
  "kabukineko:room:{000123}:join-receipts",
  "kabukineko:room:{000123}:lease",
];
const response = z.record(z.string(), z.unknown());
describe("Redis room atomic scripts", () => {
  let rt: Awaited<ReturnType<typeof createTestRuntime>>;
  let redis: Redis;
  let scripts: Record<string, string>;
  beforeAll(async () => {
    rt = await createTestRuntime();
    const container = await rt.redis();
    redis = new Redis(container.getConnectionUrl());
    scripts = Object.fromEntries(
      await Promise.all(
        ["mutate-room", "bind-player", "release-room"].map(async (name) => [
          name,
          await readFile(
            path.join(process.cwd(), `apps/api/src/providers/state/lua/${name}.lua`),
            "utf8",
          ),
        ]),
      ),
    );
  });
  afterAll(async () => {
    if (redis) await redis.quit();
    if (rt) await rt.cleanup();
  });
  beforeEach(async () => {
    await redis.del(...keys);
  });
  async function run(name: string, op: object, sessionId = session, scriptKeys = keys) {
    const script = scripts[name];
    if (!script) throw new Error("Missing Lua source");
    return response.parse(
      JSON.parse(
        z
          .string()
          .parse(
            await redis.eval(
              script,
              scriptKeys.length,
              ...scriptKeys,
              sessionId,
              JSON.stringify(op),
            ),
          ),
      ),
    );
  }
  async function create(patch: Partial<ReturnType<typeof activeRoomStateSchema.parse>> = {}) {
    const now = Date.now();
    const state = activeRoomStateSchema.parse({
      ...room(),
      createdAt: now,
      lobbyActiveAt: now,
      hardExpiresAt: now + 28800000,
      ...patch,
    });
    return run("mutate-room", { kind: "create", state, ttlMs: 28800000 }, state.sessionId);
  }
  function join(n = 6) {
    return {
      kind: "join",
      requestId: uuid(n + 20),
      payloadHash: "a".repeat(64),
      connectionId: `socket${n}`,
      player: player(n),
      sessionToken: "a".repeat(43),
      friendlyTicketHash: "b".repeat(64),
    };
  }
  function command(event = "host:lock_room", extra: object = {}) {
    return {
      kind: "command",
      event,
      requestId: uuid(40),
      payloadHash: "a".repeat(64),
      hostId: uuid(5),
      expectedPhaseVersion: 1,
      isLocked: true,
      ...extra,
    };
  }
  it("serializes concurrent create and rejects cross-slot and stale-session access", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => create()));
    expect(results.filter((r) => r.result === "CREATED")).toHaveLength(1);
    expect(results.filter((r) => r.result === "EXISTS")).toHaveLength(11);
    expect(await run("mutate-room", command(), uuid(99))).toMatchObject({
      error: "ROOM_NOT_FOUND",
    });
    expect(
      await run("mutate-room", command(), session, [
        keys[0] ?? "",
        "kabukineko:room:{000124}:join-receipts",
        keys[2] ?? "",
      ]),
    ).toMatchObject({ error: "INVALID_REFERENCE" });
    // Check every sidecar identity, not only the primary key.
    await redis.hset(keys[2] ?? "", "sessionId", uuid(99));
    expect(await run("bind-player", join())).toMatchObject({ error: "ROOM_NOT_FOUND" });
  });
  it("deduplicates concurrent commands, rejects changed hashes and checks host ownership", async () => {
    await create();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => run("mutate-room", command())),
    );
    expect(results.filter((r) => r.committed === true)).toHaveLength(1);
    for (const result of results) expect(result.ack).toEqual(results[0]?.ack);
    expect(
      await run("mutate-room", command("host:lock_room", { payloadHash: "b".repeat(64) })),
    ).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });
    expect(await run("mutate-room", command("host:lock_room", { hostId: uuid(90) }))).toMatchObject(
      { error: "FORBIDDEN" },
    );
  });
  it("allocates one slot for retries and fences old generations", async () => {
    await create();
    const results = await Promise.all(Array.from({ length: 10 }, () => run("bind-player", join())));
    expect(results.map((r) => r.generation).sort((a, b) => Number(a) - Number(b))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(results.every((r) => r.token === "a".repeat(43))).toBe(true);
    expect(
      await run("mutate-room", {
        kind: "presence",
        playerId: uuid(6),
        generation: 1,
        connected: false,
      }),
    ).toMatchObject({ result: false });
    expect(
      await run("mutate-room", {
        kind: "presence",
        playerId: uuid(6),
        generation: 10,
        connected: false,
      }),
    ).toMatchObject({ result: true });
    expect(await run("bind-player", { ...join(), payloadHash: "b".repeat(64) })).toMatchObject({
      error: "IDEMPOTENCY_CONFLICT",
    });
    const ttl = await redis.pttl(keys[1] ?? "");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120000);
    expect(
      await run("bind-player", {
        kind: "recover",
        playerId: uuid(6),
        tokenHash: player().tokenHash,
        connectionId: "replacement",
      }),
    ).toMatchObject({ generation: 11, token: null });
  });
  it("reserves unique nicknames and capacity under concurrent joins", async () => {
    await create({ maxPlayers: 1 });
    const results = await Promise.all([run("bind-player", join()), run("bind-player", join(7))]);
    expect(results.filter((r) => r.error === "ROOM_FULL")).toHaveLength(1);
    await redis.del(...keys);
    await create();
    await run("bind-player", join());
    expect(
      await run("bind-player", {
        ...join(7),
        player: { ...player(7), nicknameKey: player().nicknameKey },
      }),
    ).toMatchObject({ error: "NICKNAME_TAKEN" });
  });
  it("consumes socket-bound friendly tickets only after successful validation", async () => {
    await create({ friendlyNicknames: true });
    expect(
      await run("mutate-room", {
        kind: "ticket",
        ticket: {
          nickname: "Cat6",
          tokenHash: "b".repeat(64),
          socketId: "socket6",
          expiresAt: Date.now() + 119000,
          consumed: false,
        },
      }),
    ).toMatchObject({ result: true });
    expect(await run("bind-player", { ...join(), connectionId: "attacker" })).toMatchObject({
      error: "NICKNAME_INVALID",
    });
    expect(await run("bind-player", join())).toMatchObject({ generation: 1 });
    expect(await run("bind-player", join(7))).toMatchObject({ error: "NICKNAME_INVALID" });
  });
  it("fences commands by phase version, kicks revoke recovery and timed CAS uses Redis TIME", async () => {
    await create();
    await run("bind-player", join());
    expect(await run("mutate-room", command("host:start_game"))).toMatchObject({
      committed: true,
      phaseVersion: 2,
    });
    expect(
      await run("mutate-room", command("host:start_game", { requestId: uuid(41) })),
    ).toMatchObject({ error: "STALE_PHASE" });
    expect(
      await run("mutate-room", {
        kind: "transition",
        expectedPhaseVersion: 2,
        phase: "QUESTION_PREVIEW",
        questionIndex: 0,
      }),
    ).toMatchObject({ result: false });
    expect(
      await run(
        "mutate-room",
        command("host:kick_player", {
          requestId: uuid(42),
          expectedPhaseVersion: 2,
          playerId: uuid(6),
        }),
      ),
    ).toMatchObject({ committed: true });
    expect(
      await run("bind-player", {
        kind: "recover",
        playerId: uuid(6),
        tokenHash: player().tokenHash,
        connectionId: "new",
      }),
    ).toMatchObject({ error: "PLAYER_KICKED" });
  });
  it("commits one timed transition and preserves the frozen connected set", async () => {
    const now = Date.now();
    await create({
      phase: "QUESTION_PREVIEW",
      questionIndex: 0,
      players: { [uuid(6)]: player(), [uuid(7)]: { ...player(7), connected: false } },
      timing: {
        phaseStartedAt: now - 5000,
        phaseEndsAt: now - 1000,
        questionStartedAt: null,
        inputClosesAt: null,
        acceptanceClosesAt: null,
      },
    });
    const op = {
      kind: "transition",
      expectedPhaseVersion: 1,
      phase: "QUESTION_ANSWERING",
      questionIndex: 0,
    };
    const results = await Promise.all([run("mutate-room", op), run("mutate-room", op)]);
    expect(results.filter((r) => r.result === true)).toHaveLength(1);
    const timing = z
      .object({
        questionStartedAt: z.number(),
        inputClosesAt: z.number(),
        acceptanceClosesAt: z.number(),
      })
      .parse(results.find((r) => r.result === true)?.timing);
    expect(timing.inputClosesAt - timing.questionStartedAt).toBe(20000);
    expect(timing.acceptanceClosesAt - timing.inputClosesAt).toBe(1500);
    await run("mutate-room", {
      kind: "presence",
      playerId: uuid(6),
      generation: 1,
      connected: false,
    });
    const state = response.parse(
      JSON.parse(z.string().parse(await redis.hget(keys[0] ?? "", "state"))),
    );
    expect(state.requiredPlayerIds).toEqual([uuid(6)]);
  });
  it("enforces logical receipt expiry and room lifetime independently of physical TTL", async () => {
    await create();
    await run("bind-player", join());
    const receiptKey = keys[1] ?? "",
      requestId = join().requestId;
    const receipt = response.parse(
      JSON.parse(z.string().parse(await redis.hget(receiptKey, requestId))),
    );
    receipt.expiresAt = Date.now() - 1;
    await redis.hset(receiptKey, requestId, JSON.stringify(receipt));
    expect(await run("bind-player", join())).toMatchObject({ error: "NICKNAME_TAKEN" });
    await redis.hset(keys[0] ?? "", "expiresAt", Date.now() - 1);
    expect(
      await run("bind-player", {
        kind: "recover",
        playerId: uuid(6),
        tokenHash: player().tokenHash,
        connectionId: "new",
      }),
    ).toMatchObject({ error: "ROOM_EXPIRED" });
    expect(await run("mutate-room", command())).toMatchObject({ error: "ROOM_EXPIRED" });
  });
  it("uses conditional lease owner/epoch and session-safe release", async () => {
    await create();
    const results = await Promise.all(
      [6, 7].map((n) =>
        run("release-room", { kind: "acquireLease", ownerId: uuid(n), ttlMs: 3000 }),
      ),
    );
    expect(results.filter((r) => r.result === null)).toHaveLength(1);
    const lease = z
      .object({ ownerId: z.string(), epoch: z.number() })
      .parse(results.find((r) => r.result !== null)?.result);
    expect(
      await run("release-room", {
        kind: "renewLease",
        ...lease,
        epoch: lease.epoch + 1,
        ttlMs: 3000,
      }),
    ).toMatchObject({ result: false });
    expect(await run("release-room", { kind: "renewLease", ...lease, ttlMs: 3000 })).toMatchObject({
      result: true,
    });
    expect(await run("release-room", { kind: "releaseLease", ...lease })).toMatchObject({
      result: true,
    });
    expect(
      await run("release-room", { kind: "acquireLease", ownerId: uuid(8), ttlMs: 3000 }),
    ).toMatchObject({ result: { epoch: lease.epoch + 1 } });
    expect(await run("release-room", { kind: "releaseLease", ...lease })).toMatchObject({
      result: false,
    });
    expect(await run("release-room", { kind: "releaseRoom" })).toMatchObject({ result: true });
    await create({ sessionId: uuid(99) });
    expect(await run("release-room", { kind: "releaseRoom" })).toMatchObject({ result: false });
    expect(await redis.exists(keys[0] ?? "")).toBe(1);
  });
  it("retains pending frozen payloads and releases only after durable ready", async () => {
    await create();
    // Persistence fixture bypasses the future report producer, never the script guards.
    const key = keys[0] ?? "";
    const state = response.parse(JSON.parse(z.string().parse(await redis.hget(key, "state"))));
    state.frozenReport = { session: { id: session } };
    state.finalization = { status: "pending" };
    await redis.hset(key, "state", JSON.stringify(state));
    await redis.persist(key);
    expect(await run("release-room", { kind: "releaseRoom" })).toMatchObject({ result: false });
    await redis.hset(key, "durable", "1");
    expect(await run("release-room", { kind: "releaseRoom" })).toMatchObject({ result: false });
    state.finalization = { status: "ready" };
    await redis.hset(key, "state", JSON.stringify(state));
    expect(await run("release-room", { kind: "releaseRoom" })).toMatchObject({ result: true });
  });
});
