/**
 * TASK-169 room lifetime and retention on SQLite, PostgreSQL 16 and MySQL 8.4 with Redis game
 * state, plus in-memory state across a restart (SA §6.2–6.3 "Recovery/retention"; US-12/14/16).
 *
 * Elapsed server time is simulated by aging the live room's own timestamps in Redis (lobby
 * activity, hard expiry, FINISHED start, game end). The real scheduler (1 s scans) and worker then
 * act on them exactly as hours later. Nothing in the API is stubbed.
 *
 * Covered per database:
 * - Lobby idle 2 h: the room becomes LOST, its state is released, and the host can no longer
 *   recover it.
 * - Hard 8 h during a question: the question closes as EXPIRED, the game reaches the podium, the
 *   report becomes durable (end reason EXPIRED), and the room state is released at once (allocation
 *   CLOSED).
 * - FINISHED retention 1 h: a durable room is kept, then its state is released after the hour
 *   (allocation CLOSED); the report stays readable.
 * - An hour after closing, the allocation, its READY job and its media pins are deleted together,
 *   with an audit event.
 * - A report that is not durable is never evicted, even past retention and the hard lifetime, and
 *   24 h after the game a single alarm is logged.
 * - A stale cleanup for an old session cannot remove the live room that now uses that PIN.
 * - In-memory state: after a restart the room is LOST, never fabricated.
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { RedisV2StateStore } from "../../apps/api/src/providers/state/redis-v2-state.store";
import {
  GameClient,
  allocationStatus,
  ageRoomState,
  answeringQuestion,
  createRoom,
  join,
  openDatabase,
  quizWith,
  startSingleApi,
  until,
  uploadImage,
  type Room,
  type SingleApi,
} from "../helpers/game";
import { startApi } from "../helpers/runtime";

jest.setTimeout(300_000);

const HOUR = 3_600_000;

describe.each(["sqlite", "postgres", "mysql"] as const)("room retention on %s", (driver) => {
  let single: SingleApi | undefined;
  const clients: GameClient[] = [];
  let quiz: { id: string; revision: number };
  let mediaId = "";

  /** A recorded client (optionally as the host). */
  const connect = async (token?: string) => {
    if (!single) throw new Error("api missing");
    const client = await GameClient.connect(single.api.url, token);
    clients.push(client);
    return client;
  };
  /** Number of media pins a room holds. */
  const pins = async (sessionId: string) => {
    if (!single) throw new Error("api missing");
    const db = await openDatabase(single.runtime, single.env);
    try {
      return await db.manager.countBy("room_media", { session_id: sessionId });
    } finally {
      await db.destroy();
    }
  };
  /** True while the room's Redis state exists. */
  const stateExists = async (room: Room) => {
    if (!single?.redisUrl) throw new Error("redis missing");
    const redis = new Redis(single.redisUrl);
    try {
      return (await redis.exists(`kabukineko:default:v2:room:{${room.pinCode}}:meta`)) === 1;
    } finally {
      redis.disconnect();
    }
  };
  /** Ages the allocation's heartbeat by an hour and waits for the release (row, job, pins gone). */
  const released = async (sessionId: string) => {
    if (!single) throw new Error("api missing");
    const db = await openDatabase(single.runtime, single.env);
    try {
      await db.manager
        .createQueryBuilder()
        .update("room_allocations")
        .set({ last_heartbeat_at: () => `last_heartbeat_at - ${HOUR + 1_000}` })
        .where("id = :id", { id: sessionId })
        .execute();
    } finally {
      await db.destroy();
    }
    const runtime = single.runtime;
    const env = single.env;
    expect(await until(() => allocationStatus(runtime, env, sessionId), null)).toBeNull();
    expect(await pins(sessionId)).toBe(0);
    const check = await openDatabase(runtime, env);
    try {
      expect(await check.manager.countBy("finalization_jobs", { session_id: sessionId })).toBe(0);
      expect(
        await check.manager.countBy("audit_events", {
          resource_id: sessionId,
          action: "room.release.closed",
        }),
      ).toBe(1);
    } finally {
      await check.destroy();
    }
  };
  /** Report status for the host. */
  const reportStatus = async (sessionId: string) => {
    if (!single) throw new Error("api missing");
    const response = await single.call(`/reports/${sessionId}/status`, { token: single.host });
    return (response.json as { status?: string } | null)?.status ?? null;
  };
  /** A started room with one player waiting on question 0. */
  const startedRoom = async () => {
    const host = await connect(single?.host);
    const room = await createRoom(host, quiz);
    const player = await connect();
    await join(player, room, "Pemain");
    expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );
    const open = await answeringQuestion(player, 0);
    return { host, room, player, open };
  };

  beforeAll(async () => {
    single = await startSingleApi(driver, "redis");
    mediaId = (await uploadImage(single.api, single.host)).id;
    quiz = await quizWith(single.call, single.host, "Retensi", [
      {
        type: "SINGLE_CHOICE",
        prompt: "Tahan?",
        options: [["Ya", true], ["Tidak"]],
        timeLimitSec: 30,
        mediaId,
      },
    ]);
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await single?.api.stop();
    await single?.runtime.cleanup();
  });

  it("marks a lobby idle for 2 h LOST and releases it", async () => {
    const s = single;
    if (!s?.redisUrl) throw new Error("setup missing");
    const host = await connect(s.host);
    const room = await createRoom(host, quiz);
    expect(await allocationStatus(s.runtime, s.env, room.sessionId)).toBe("ACTIVE");
    await ageRoomState(s.redisUrl, room, (state) => {
      state["lobbyActiveAt"] = Number(state["lobbyActiveAt"]) - 2 * HOUR - 1_000;
    });
    expect(await until(() => allocationStatus(s.runtime, s.env, room.sessionId), "LOST")).toBe(
      "LOST",
    );
    expect(await until(() => stateExists(room), false)).toBe(false);
    const recover = await (
      await connect(s.host)
    ).emit("host:recover_room", {
      sessionId: room.sessionId,
    });
    expect(recover.ok).toBe(false);
  });

  it("closes a question at the 8 h hard limit, keeps the report and then releases the room", async () => {
    const s = single;
    if (!s?.redisUrl) throw new Error("setup missing");
    const { host, room } = await startedRoom();
    expect(await pins(room.sessionId)).toBeGreaterThan(0);
    await ageRoomState(s.redisUrl, room, (state) => {
      state["hardExpiresAt"] = Date.now() - 1;
    });
    await host.waitFor("game:podium");
    expect(await until(() => reportStatus(room.sessionId), "ready")).toBe("ready");
    const report = await s.call(`/reports/${room.sessionId}`, { token: s.host });
    expect((report.json as { session: { endReason: string } }).session.endReason).toBe("EXPIRED");
    // Hard-expired and durable: released at once (allocation CLOSED, pins dropped).
    expect(await until(() => allocationStatus(s.runtime, s.env, room.sessionId), "CLOSED")).toBe(
      "CLOSED",
    );
    // Pins and the allocation go with the release an hour after closing.
    expect(await pins(room.sessionId)).toBeGreaterThan(0);
    await released(room.sessionId);
  });

  it("keeps a FINISHED room for 1 h, then releases it with the report still readable", async () => {
    const s = single;
    if (!s?.redisUrl) throw new Error("setup missing");
    const { host, room } = await startedRoom();
    const synced = await host.emit("room:sync", room);
    const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
    expect((await host.emit("host:end_game", { ...room, expectedPhaseVersion: version })).ok).toBe(
      true,
    );
    await host.waitFor("game:finished", () => true, 30_000);
    expect(await until(() => reportStatus(room.sessionId), "ready")).toBe("ready");
    // Still within the hour: kept for recovery, pins held.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await stateExists(room)).toBe(true);
    expect(await pins(room.sessionId)).toBeGreaterThan(0);
    await ageRoomState(s.redisUrl, room, (state) => {
      const timing = state["timing"] as { phaseStartedAt: number };
      timing.phaseStartedAt -= HOUR + 1_000;
    });
    expect(await until(() => allocationStatus(s.runtime, s.env, room.sessionId), "CLOSED")).toBe(
      "CLOSED",
    );
    expect(await stateExists(room)).toBe(false);
    await released(room.sessionId);
    expect((await s.call(`/reports/${room.sessionId}`, { token: s.host })).status).toBe(200);
  });

  it("never evicts a report that is not durable and raises one 24 h alarm", async () => {
    const s = single;
    if (!s?.redisUrl) throw new Error("setup missing");
    const { host, room } = await startedRoom();
    const synced = await host.emit("room:sync", room);
    const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
    expect((await host.emit("host:end_game", { ...room, expectedPhaseVersion: version })).ok).toBe(
      true,
    );
    await host.waitFor("game:finished", () => true, 30_000);
    expect(await until(() => reportStatus(room.sessionId), "ready")).toBe("ready");
    // Make the report non-durable again: no history, a queued job not due for a day.
    await s.api.stop();
    const db = await openDatabase(s.runtime, s.env);
    try {
      await db.manager.delete("game_sessions", { id: room.sessionId });
      await db.manager.update("finalization_jobs", room.sessionId, {
        state: "PENDING",
        attempts: 0,
        next_attempt_at: Date.now() + 24 * HOUR,
        completed_at: null,
      });
    } finally {
      await db.destroy();
    }
    const redis = new Redis(s.redisUrl);
    try {
      await redis.hset(`kabukineko:default:v2:room:{${room.pinCode}}:meta`, "durable", "0");
    } finally {
      redis.disconnect();
    }
    await ageRoomState(s.redisUrl, room, (state) => {
      const timing = state["timing"] as { phaseStartedAt: number };
      timing.phaseStartedAt -= 2 * HOUR;
      state["hardExpiresAt"] = Date.now() - 1;
      const report = state["frozenReport"] as { session: { endedAt: number } };
      report.session.endedAt -= 24 * HOUR + 1_000;
      state["finalization"] = {
        sessionId: room.sessionId,
        status: "pending",
        reportId: null,
        retryable: true,
        errorCode: null,
        updatedAt: Date.now(),
      };
    });
    s.api = await startApi(s.runtime, s.env);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(await allocationStatus(s.runtime, s.env, room.sessionId)).toBe("FINALIZING");
    expect(await stateExists(room)).toBe(true);
    expect(await pins(room.sessionId)).toBeGreaterThan(0);
    const alarms = s.api
      .logs()
      .split("\n")
      .filter((line) =>
        line.includes(`finalization pending for more than 24 h for session ${room.sessionId}`),
      );
    expect(alarms).toHaveLength(1);
  });

  it("cannot remove a live room through a stale cleanup of an old session on its PIN", async () => {
    const s = single;
    if (!s?.redisUrl) throw new Error("setup missing");
    const host = await connect(s.host);
    const room = await createRoom(host, quiz);
    const redis = new Redis(s.redisUrl);
    try {
      const stale = new RedisV2StateStore(
        redis,
        () => {
          throw new Error("not used");
        },
        "default",
      );
      expect(await stale.releaseRoom({ pin: room.pinCode, sessionId: randomUUID() })).toBe(false);
      stale.onModuleDestroy();
    } finally {
      redis.disconnect();
    }
    expect(await stateExists(room)).toBe(true);
    expect(
      (await (await connect(s.host)).emit("host:recover_room", { sessionId: room.sessionId })).ok,
    ).toBe(true);
  });

  it("treats in-memory rooms as LOST after a restart", async () => {
    const s = single;
    if (!s) throw new Error("setup missing");
    // Same database, the memory state driver this time.
    await s.api.stop();
    const memoryEnv = { ...s.env, STATE_DRIVER: "memory" };
    delete (memoryEnv as Record<string, string | undefined>)["REDIS_URL"];
    let api = await startApi(s.runtime, memoryEnv);
    const host = await GameClient.connect(api.url, s.host);
    clients.push(host);
    const room = await createRoom(host, quiz);
    expect(await allocationStatus(s.runtime, memoryEnv, room.sessionId)).toBe("ACTIVE");
    await api.stop();
    api = await startApi(s.runtime, memoryEnv);
    s.api = api;
    expect(await until(() => allocationStatus(s.runtime, memoryEnv, room.sessionId), "LOST")).toBe(
      "LOST",
    );
    const again = await GameClient.connect(api.url, s.host);
    clients.push(again);
    expect((await again.emit("host:recover_room", { sessionId: room.sessionId })).ok).toBe(false);
  });
});
