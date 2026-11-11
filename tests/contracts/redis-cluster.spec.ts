/**
 * TASK-167 Redis Cluster contracts on a real six-node Redis 7 Cluster (SA §6.1; US-10/12/16).
 *
 * The cluster comes from `docker/docker-compose.test-cluster.yml` (three masters, three replicas,
 * AOF). Clients are the production ones (`StateConnections` with `REDIS_CLUSTER_NODES`).
 *
 * Covered:
 * - Slot routing: every key of a PIN hashes to one slot. Rooms placed on all three masters run
 *   create, join, command, snapshot and release with no CROSSSLOT error.
 * - NOSCRIPT: after `SCRIPT FLUSH` on every node, the store reloads its scripts.
 * - Two API instances answering for the same player at once admit exactly one answer; a
 *   different later answer is ALREADY_ANSWERED; an old connection generation and a stale phase
 *   version are refused without changing the room.
 * - Pub/Sub: Socket.io server events cross nodes between two instances' adapters.
 * - Failover: killing the master of a room's slot promotes its replica. Commands are refused
 *   while no master serves the slot (fail closed, never a memory fallback). Afterwards the client
 *   follows the new topology (MOVED). The surviving room is one complete committed state: its
 *   revision and lock flag agree. Async replication may lose the newest acknowledged write, and
 *   the test makes no zero-RPO claim.
 * - Lost AOF: writes acknowledged by a master after its AOF stopped (and with no replica left)
 *   are gone after its restart; the room reads as absent (null → ROOM_LOST upstream), never as
 *   fabricated state, and is refused while the slot has no master.
 */
import { createHash } from "node:crypto";
import { Server } from "../../apps/api/node_modules/socket.io";
import { emptyAccessibility } from "@kabuki-neko/shared/schemas/media.schema";
import { playerRoomSyncSchema } from "@kabuki-neko/shared/schemas/game.schema";
import { ConfigService } from "../../apps/api/src/config/config.service";
import type {
  ApplyCommandInput,
  RoomProjector,
} from "../../apps/api/src/providers/state/game-state.interface";
import {
  activePlayerSchema,
  activeRoomStateSchema,
} from "../../apps/api/src/providers/state/private-state.schema";
import { RedisStateStore } from "../../apps/api/src/providers/state/redis-state.store";
import { StateConnections } from "../../apps/api/src/providers/state/state.module";
import type { ClusterNode, RedisClusterFixture } from "../helpers/redis-cluster";
import { CLUSTER_NODES } from "../helpers/redis-cluster";
import { createTestRuntime, type TestRuntime } from "../helpers/runtime";

jest.setTimeout(300_000);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NAMESPACE = "cluster";

/** A one-question TYPE_ANSWER room for `pin`. */
function room(pin: string) {
  const now = Date.now();
  return activeRoomStateSchema.parse({
    schemaVersion: 1,
    sessionId: uuid(1),
    pinCode: pin,
    hostId: uuid(5),
    quiz: {
      schemaVersion: 1,
      quizId: uuid(4),
      revision: 1,
      title: "Cats",
      description: null,
      bgmTrack: "random",
      coverMedia: null,
      questions: [
        {
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
        },
      ],
    },
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
      phaseStartedAt: now,
      phaseEndsAt: null,
      questionStartedAt: null,
      inputClosesAt: null,
      acceptanceClosesAt: null,
    },
    createdAt: now,
    hardExpiresAt: now + 28_800_000,
    lobbyActiveAt: now,
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
  });
}

/** A connected player `n`. */
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

/** The room in QUESTION_ANSWERING with players 6 and 7 required. */
function answering(pin: string) {
  const state = room(pin);
  const now = Date.now();
  // Player 7 reconnected once: its current connection generation is 2.
  state.players = {
    [uuid(6)]: player(6),
    [uuid(7)]: { ...player(7), connectionGeneration: 2 },
  };
  state.phase = "QUESTION_ANSWERING";
  state.questionIndex = 0;
  state.accepting = true;
  state.requiredPlayerIds = [uuid(6), uuid(7)];
  state.eligiblePlayerIds = [uuid(6), uuid(7)];
  state.timing = {
    phaseStartedAt: now - 100,
    phaseEndsAt: now + 19_900,
    questionStartedAt: now - 100,
    inputClosesAt: now + 19_900,
    acceptanceClosesAt: now + 21_400,
  };
  return state;
}

/** Player projection only (enough for snapshot routing checks). */
const project: RoomProjector = (s, principal, now) => {
  if (principal.role !== "player") throw new Error("player fixture only");
  return playerRoomSyncSchema.parse({
    role: "player",
    sessionId: s.sessionId,
    pinCode: s.pinCode,
    phase: s.phase,
    revision: s.revision,
    publicRevision: s.publicRevision,
    phaseVersion: s.phaseVersion,
    serverTime: now,
    quizTitle: s.quiz.title,
    totalQuestions: s.quiz.questions.length,
    displayMode: s.displayMode,
    friendlyNicknames: s.friendlyNicknames,
    isLocked: s.isLocked,
    maxPlayers: s.maxPlayers,
    players: Object.values(s.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      connected: p.connected,
      joinOrder: p.joinOrder,
    })),
    timing: s.timing,
    question: null,
    reveal: null,
    leaderboard: null,
    podium: [],
    endReason: null,
    self: {
      playerId: principal.playerId,
      score: 0,
      streak: 0,
      rank: null,
      acceptedAnswer: null,
      result: null,
    },
  });
};

/** A lock/unlock command with its own request id. */
function lock(pin: string, isLocked: boolean, n: number): ApplyCommandInput {
  return {
    pin,
    sessionId: uuid(1),
    hostId: uuid(5),
    requestId: uuid(100 + n),
    payloadHash: createHash("sha256").update(`${pin}:${n}`).digest("hex"),
    expectedPhaseVersion: 1,
    command: {
      event: "host:lock_room",
      request: { pinCode: pin, sessionId: uuid(1), requestId: uuid(100 + n), isLocked },
    },
  } as ApplyCommandInput;
}

/** Room keys of `pin` (as the store names them). */
const keysOf = (pin: string) =>
  ["meta", "join-receipts", "lease"].map(
    (suffix) => `kabukineko:${NAMESPACE}:room:{${pin}}:${suffix}`,
  );

/** Retries `work` until it succeeds or `timeoutMs` passes (cluster topology settling). */
async function eventually<T>(work: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let runtime: TestRuntime;
let cluster: RedisClusterFixture;
let first: StateConnections;
let second: StateConnections;
let storeA: RedisStateStore;
let storeB: RedisStateStore;
/** PIN → the master that serves it at the start. */
const placed = new Map<string, ClusterNode>();

/** Opens a production state client against the cluster. */
async function connections(): Promise<StateConnections> {
  const config = await ConfigService.load({
    ...runtime.env,
    STATE_DRIVER: "redis",
    STATE_NAMESPACE: NAMESPACE,
    REDIS_CLUSTER_NODES: JSON.stringify(cluster.urls),
  });
  return StateConnections.open(config);
}

beforeAll(async () => {
  runtime = await createTestRuntime();
  cluster = await runtime.redisCluster();
  first = await connections();
  second = await connections();
  if (!first.command || !second.command) throw new Error("state clients missing");
  storeA = new RedisStateStore(first.command, project, NAMESPACE);
  storeB = new RedisStateStore(second.command, project, NAMESPACE);
  // One PIN per master.
  for (let n = 0; placed.size < 3 && n < 1000; n++) {
    const pin = String(100000 + n * 7919).slice(-6);
    const master = await cluster.masterFor(keysOf(pin)[0] ?? "");
    if (![...placed.values()].includes(master)) placed.set(pin, master);
  }
  expect(placed.size).toBe(3);
});

afterAll(async () => {
  storeA?.onModuleDestroy();
  storeB?.onModuleDestroy();
  first?.onModuleDestroy();
  second?.onModuleDestroy();
  await runtime?.cleanup();
});

it("routes every key of a PIN to one slot and runs room operations on all three masters", async () => {
  for (const pin of placed.keys()) {
    const slots = await Promise.all(
      keysOf(pin).map((key) => cluster.cli("node-0", "CLUSTER", "KEYSLOT", key)),
    );
    expect(new Set(slots).size).toBe(1);
    const identity = { pin, sessionId: uuid(1) };
    expect(await storeA.createRoom(pin, room(pin), 28_800_000)).toBe("CREATED");
    const joined = await storeA.bindPlayer({
      ...identity,
      requestId: uuid(30),
      payloadHash: "a".repeat(64),
      connectionId: "join",
      binding: {
        kind: "join",
        player: player(),
        sessionToken: "a".repeat(43),
        friendlyTicketHash: null,
      },
    });
    expect(joined.generation).toBe(1);
    expect((await storeA.applyCommand(lock(pin, true, 1))).committed).toBe(true);
    const snapshot = await storeB.getRoleSnapshot(identity, {
      role: "player",
      playerId: uuid(6),
      generation: 1,
    });
    expect(snapshot?.isLocked).toBe(true);
    expect(await storeB.releaseRoom(identity)).toBe(true);
    expect(await storeA.getPrivateSnapshot(identity)).toBeNull();
  }
});

it("reloads its scripts on every node after SCRIPT FLUSH (NOSCRIPT)", async () => {
  const [pin] = [...placed.keys()];
  if (!pin) throw new Error("pin missing");
  expect(await storeA.createRoom(pin, room(pin), 28_800_000)).toBe("CREATED");
  for (const node of CLUSTER_NODES) expect(await cluster.cli(node, "SCRIPT", "FLUSH")).toBe("OK");
  expect((await storeA.applyCommand(lock(pin, true, 2))).committed).toBe(true);
  expect((await storeB.getPrivateSnapshot({ pin, sessionId: uuid(1) }))?.isLocked).toBe(true);
  expect(await storeA.releaseRoom({ pin, sessionId: uuid(1) })).toBe(true);
});

it("admits one answer from two instances and refuses old generations and stale phases", async () => {
  const pin = [...placed.keys()][1];
  if (!pin) throw new Error("pin missing");
  const identity = { pin, sessionId: uuid(1) };
  expect(await storeA.createRoom(pin, answering(pin), 28_800_000)).toBe("CREATED");
  const submission = {
    ...identity,
    playerId: uuid(6),
    generation: 1,
    submissionId: uuid(16),
    questionId: uuid(2),
    questionIndex: 0,
    answer: "Neko",
  };
  const [a, b] = await Promise.all([
    storeA.admitAnswer(submission),
    storeB.admitAnswer(submission),
  ]);
  expect(a).toEqual(b);
  await expect(
    storeB.admitAnswer({ ...submission, submissionId: uuid(26), answer: "Tora" }),
  ).rejects.toMatchObject({ code: "ALREADY_ANSWERED" });
  const stored = await storeA.getPrivateSnapshot(identity);
  expect(Object.keys(stored?.answers ?? {})).toHaveLength(1);

  // Player 7 has reconnected (generation 2): an answer from its old connection is refused.
  await expect(
    storeA.admitAnswer({ ...submission, playerId: uuid(7), submissionId: uuid(17), generation: 1 }),
  ).rejects.toMatchObject({ code: "SESSION_REPLACED" });
  // A command for an older phase version changes nothing.
  const before = await storeA.getPrivateSnapshot(identity);
  await expect(
    storeB.applyCommand({
      ...identity,
      hostId: uuid(5),
      requestId: uuid(140),
      payloadHash: "c".repeat(64),
      expectedPhaseVersion: 99,
      command: {
        event: "host:skip_timer",
        request: {
          pinCode: pin,
          sessionId: uuid(1),
          requestId: uuid(140),
          expectedPhaseVersion: 99,
        },
      },
    } as ApplyCommandInput),
  ).rejects.toMatchObject({ code: "STALE_PHASE" });
  const after = await storeA.getPrivateSnapshot(identity);
  expect(after?.revision).toBe(before?.revision);
  expect(after?.isLocked).toBe(before?.isLocked);
  expect(await storeA.releaseRoom(identity)).toBe(true);
});

it("delivers Socket.io server events across nodes between two instances", async () => {
  const a = new Server();
  const b = new Server();
  first.install(a);
  second.install(b);
  try {
    const received = new Promise<unknown>((resolve) =>
      b.on("cluster-contract", (payload: unknown) => resolve(payload)),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    a.serverSideEmit("cluster-contract", { hop: "node" });
    expect(await received).toEqual({ hop: "node" });
  } finally {
    await Promise.all([a.of("/").adapter.close(), b.of("/").adapter.close()]);
  }
});

it("fails closed during a master failover, then follows it and keeps a committed state", async () => {
  const pin = [...placed.keys()][2];
  if (!pin) throw new Error("pin missing");
  const identity = { pin, sessionId: uuid(1) };
  expect(await storeA.createRoom(pin, room(pin), 28_800_000)).toBe("CREATED");
  // Committed toggles: odd revisions are unlocked, even ones locked.
  for (let n = 0; n < 6; n++)
    expect((await storeA.applyCommand(lock(pin, n % 2 === 0, 10 + n))).committed).toBe(true);
  const acknowledged = await storeA.getPrivateSnapshot(identity);
  const master = await cluster.masterFor(keysOf(pin)[0] ?? "");
  await cluster.kill(master);
  // While no master serves the slot, operations are refused (no memory fallback).
  await expect(storeA.applyCommand(lock(pin, false, 30))).rejects.toBeDefined();
  // The replica takes over once the node timeout marks the old master failed.
  await eventually(async () => {
    if ((await cluster.masterFor(keysOf(pin)[0] ?? "")) === master) throw new Error("not yet");
  });
  await cluster.waitHealthy(60_000);
  // The client follows the new master; the surviving state is one complete committed state.
  const survived = await eventually(async () => {
    const state = await storeA.getPrivateSnapshot(identity);
    if (!state) throw new Error("no state yet");
    return state;
  });
  expect(survived.revision).toBeLessThanOrEqual(acknowledged?.revision ?? 0);
  expect(survived.isLocked).toBe((survived.revision - 1) % 2 === 1);
  const next = await eventually(() => storeB.applyCommand(lock(pin, !survived.isLocked, 40)));
  expect(next.committed).toBe(true);
  // The old master comes back as a replica of the new one.
  await cluster.start(master);
  await cluster.waitHealthy(60_000);
  expect(await storeA.releaseRoom(identity)).toBe(true);
});

it("treats a room whose writes never reached the AOF as LOST after a restart, never fabricated", async () => {
  const pin = [...placed.keys()][0];
  if (!pin) throw new Error("pin missing");
  const identity = { pin, sessionId: uuid(1) };
  const key = keysOf(pin)[0] ?? "";
  const master = await cluster.masterFor(key);
  const masterId = (await cluster.cli(master, "CLUSTER", "MYID")).trim();
  const replicaLine = (await cluster.cli(master, "CLUSTER", "NODES"))
    .split("\n")
    .find((line) => line.split(" ")[3] === masterId);
  const replicaPort = Number(replicaLine?.split(" ")[1]?.split(":")[1]?.split("@")[0]);
  const replica = CLUSTER_NODES.find((node) => cluster.ports[node] === replicaPort);
  if (!replica) throw new Error("replica missing");
  // No replica can take over, and the next writes stay out of the AOF (lost AOF tail).
  await cluster.kill(replica);
  expect(await cluster.cli(master, "CONFIG", "SET", "appendonly", "no")).toBe("OK");
  expect(await eventually(() => storeA.createRoom(pin, room(pin), 28_800_000))).toBe("CREATED");
  expect((await storeA.getPrivateSnapshot(identity))?.pinCode).toBe(pin);
  await cluster.kill(master);
  // The slot has no master: refused, never answered from memory.
  await expect(storeA.getPrivateSnapshot(identity)).rejects.toBeDefined();
  // The master restarts from its AOF, which never saw the room.
  await cluster.start(master);
  await cluster.waitHealthy(60_000);
  expect(
    await eventually(async () => {
      const state = await storeA.getPrivateSnapshot(identity);
      return state;
    }),
  ).toBeNull();
  // Back to full redundancy.
  await cluster.start(replica);
  await cluster.waitHealthy(60_000);
});
