/**
 * TASK-169 report finalization durability on SQLite, PostgreSQL 16 and MySQL 8.4 with Redis game
 * state (SA §6.3; US-12/14/16/20).
 *
 * The real durable queue and worker run inside the API process. Crashes are SIGKILLs. Failure
 * points the worker cannot be stopped at precisely are reproduced as the durable state they leave
 * behind: a RUNNING job whose lease expired and whose history transaction rolled back, a FAILED
 * job waiting for its backoff, or a job whose payload no longer matches the history. The process
 * then restarts on that state.
 *
 * Covered per database:
 * - A crash right after the game ends (before or after the queue commit) still ends with exactly
 *   one durable report holding the game's answer.
 * - A crash inside the history write leaves no partial report. The expired lease is reclaimed and
 *   the report is written once, identical to the original.
 * - Failed attempts:
 *   - nothing is retried before its backoff is due;
 *   - the report routes answer 503 (never partial data);
 *   - the list hides the report and media pins are kept;
 *   - a manual retry resets the attempts and finishes it;
 *   - a due backoff is retried automatically.
 * - A payload hash mismatch raises the invariant alarm and never overwrites history.
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  GameClient,
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
import { httpClient, startApi } from "../helpers/runtime";

jest.setTimeout(300_000);

describe.each(["sqlite", "postgres", "mysql"] as const)(
  "finalization durability on %s",
  (driver) => {
    let single: SingleApi | undefined;
    const clients: GameClient[] = [];
    let quiz: { id: string; revision: number };
    /** The report of the game ended in the first test (reference for later rewrites). */
    const fixture: { room: Room | null; playerId: string; report: unknown } = {
      room: null,
      playerId: "",
      report: null,
    };

    /** A recorded client (optionally as the host). */
    const connect = async (token?: string) => {
      if (!single) throw new Error("api missing");
      const client = await GameClient.connect(single.api.url, token);
      clients.push(client);
      return client;
    };
    /** Report status for the host. */
    const status = async (sessionId: string) => {
      if (!single) throw new Error("api missing");
      const response = await single.call(`/reports/${sessionId}/status`, { token: single.host });
      return (response.json as { status?: string } | null)?.status ?? null;
    };
    /** The full report (JSON) for the host. */
    const report = async (sessionId: string) => {
      if (!single) throw new Error("api missing");
      return single.call(`/reports/${sessionId}`, { token: single.host });
    };
    /** Number of history rows for the session. */
    const sessions = async (sessionId: string) => {
      if (!single) throw new Error("api missing");
      const db = await openDatabase(single.runtime, single.env);
      try {
        return await db.manager.countBy("game_sessions", { id: sessionId });
      } finally {
        await db.destroy();
      }
    };
    /** Starts the API again on the same runtime; the HTTP client follows the new port. */
    const relaunch = async (s: SingleApi) => {
      s.api = await startApi(s.runtime, s.env);
      s.call = httpClient(s.api.base);
    };
    /**
     * Stops the API, rewrites the session's durable state (`job` fields; history deleted when
     * `dropHistory`), marks the room's frozen report non-durable with `finalization`, and restarts.
     */
    const restartWith = async (
      room: Room,
      job: Record<string, unknown>,
      finalization: Record<string, unknown> | null,
      dropHistory: boolean,
    ) => {
      const s = single;
      if (!s?.redisUrl) throw new Error("setup missing");
      await s.api.stop();
      const db = await openDatabase(s.runtime, s.env);
      try {
        if (dropHistory) await db.manager.delete("game_sessions", { id: room.sessionId });
        await db.manager.update("finalization_jobs", room.sessionId, job);
      } finally {
        await db.destroy();
      }
      if (finalization) {
        const redis = new Redis(s.redisUrl);
        try {
          const key = `kabukineko:default:room:{${room.pinCode}}:meta`;
          const state = JSON.parse((await redis.hget(key, "state")) ?? "{}") as Record<
            string,
            unknown
          >;
          state["finalization"] = {
            sessionId: room.sessionId,
            updatedAt: Date.now(),
            ...finalization,
          };
          await redis.hset(key, "state", JSON.stringify(state), "durable", "0");
        } finally {
          redis.disconnect();
        }
      }
      await relaunch(s);
    };

    beforeAll(async () => {
      single = await startSingleApi(driver, "redis");
      const mediaId = (await uploadImage(single.api, single.host)).id;
      quiz = await quizWith(single.call, single.host, "Finalisasi", [
        {
          type: "SINGLE_CHOICE",
          prompt: "Simpan?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 30,
          mediaId,
        },
        {
          type: "SINGLE_CHOICE",
          prompt: "Lagi?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 30,
        },
      ]);
    });

    afterAll(async () => {
      for (const client of clients) client.close();
      await single?.api.stop();
      await single?.runtime.cleanup();
    });

    it("writes exactly one durable report after a crash right after the game ended", async () => {
      const s = single;
      if (!s) throw new Error("setup missing");
      const host = await connect(s.host);
      const room = await createRoom(host, quiz);
      const player = await connect();
      const joined = await join(player, room, "Pemain");
      expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );
      const open = await answeringQuestion(player, 0);
      expect(
        (
          await player.emit("player:submit_answer", {
            ...room,
            questionIndex: 0,
            questionId: open.question.id,
            submissionId: randomUUID(),
            answer: open.question.options.find((option) => option.text === "Ya")?.index,
          })
        ).ok,
      ).toBe(true);
      await host.waitFor("game:answer_reveal");
      const synced = await host.emit("room:sync", room);
      const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
      expect(
        (await host.emit("host:end_game", { ...room, expectedPhaseVersion: version })).ok,
      ).toBe(true);
      // Crash at once: the enqueue/commit may or may not have happened.
      await s.api.kill();
      await relaunch(s);
      expect(await until(() => status(room.sessionId), "ready", 60_000)).toBe("ready");
      expect(await sessions(room.sessionId)).toBe(1);
      const answers = await s.call(
        `/reports/${room.sessionId}/players/${joined.playerId}/answers`,
        {
          token: s.host,
        },
      );
      const items = (answers.json as { items: { questionIndex: number; status: string }[] }).items;
      expect(items.map((item) => [item.questionIndex, item.status])).toEqual([
        [0, "ANSWERED"],
        [1, "NOT_PLAYED"],
      ]);
      fixture.room = room;
      fixture.playerId = joined.playerId;
      fixture.report = (await report(room.sessionId)).json;
    });

    it("rewrites a report once after a crash inside the history transaction", async () => {
      const room = fixture.room;
      if (!room) throw new Error("fixture missing");
      await restartWith(
        room,
        {
          state: "RUNNING",
          attempts: 1,
          lease_owner: randomUUID(),
          lease_until: Date.now() - 1,
          completed_at: null,
          next_attempt_at: Date.now() - 1,
        },
        { status: "pending", reportId: null, retryable: true, errorCode: null },
        true,
      );
      expect(await until(() => status(room.sessionId), "ready", 90_000)).toBe("ready");
      expect(await sessions(room.sessionId)).toBe(1);
      expect((await report(room.sessionId)).json).toEqual(fixture.report);
    });

    it("backs off failed attempts behind 503 gates and retries manually or when due", async () => {
      const s = single;
      const room = fixture.room;
      if (!s || !room) throw new Error("fixture missing");
      const failed = {
        status: "failed",
        reportId: null,
        retryable: true,
        errorCode: "REPORT_SAVE_FAILED",
      };
      await restartWith(
        room,
        {
          state: "FAILED",
          attempts: 2,
          next_attempt_at: Date.now() + 3_600_000,
          last_error_code: "REPORT_SAVE_FAILED",
          lease_owner: null,
          lease_until: null,
          completed_at: null,
        },
        failed,
        true,
      );
      // Not due: no automatic retry, every report route is gated, the list hides it, pins stay.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(await status(room.sessionId)).toBe("failed");
      // The stable reportId is only published once the history committed.
      const gate = await s.call(`/reports/${room.sessionId}/status`, { token: s.host });
      expect((gate.json as { reportId: string | null }).reportId).toBeNull();
      expect(await sessions(room.sessionId)).toBe(0);
      for (const path of [`/reports/${room.sessionId}`, `/reports/${room.sessionId}/export-csv`]) {
        const gated = await s.call(path, { token: s.host });
        expect(gated.status).toBe(503);
        expect((gated.json as { errorCode: string }).errorCode).toBe("REPORT_SAVE_FAILED");
      }
      expect((await s.call("/reports?limit=15", { token: s.host })).text).not.toContain(
        room.sessionId,
      );
      const db = await openDatabase(s.runtime, s.env);
      try {
        expect(
          await db.manager.countBy("room_media", { session_id: room.sessionId }),
        ).toBeGreaterThan(0);
      } finally {
        await db.destroy();
      }
      // A manual retry resets the attempts and finishes the report.
      const retried = await s.call(`/reports/${room.sessionId}/retry-finalize`, {
        method: "POST",
        token: s.host,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(retried.status).toBe(200);
      expect(await until(() => status(room.sessionId), "ready", 60_000)).toBe("ready");
      expect((await report(room.sessionId)).json).toEqual(fixture.report);
      const done = await s.call(`/reports/${room.sessionId}/status`, { token: s.host });
      expect((done.json as { reportId: string | null }).reportId).toBe(room.sessionId);
      const check = await openDatabase(s.runtime, s.env);
      try {
        const job = await check.manager.findOneBy<{ session_id: string; attempts: number }>(
          "finalization_jobs",
          { session_id: room.sessionId },
        );
        expect(job?.attempts ?? 0).toBeLessThanOrEqual(1);
      } finally {
        await check.destroy();
      }
      // A due backoff is retried by the worker on its own.
      await restartWith(
        room,
        {
          state: "FAILED",
          attempts: 1,
          next_attempt_at: Date.now() - 1,
          last_error_code: "REPORT_SAVE_FAILED",
          lease_owner: null,
          lease_until: null,
          completed_at: null,
        },
        failed,
        true,
      );
      expect(await until(() => status(room.sessionId), "ready", 60_000)).toBe("ready");
      expect(await sessions(room.sessionId)).toBe(1);
      expect((await report(room.sessionId)).json).toEqual(fixture.report);
    });

    it("never overwrites history when the queued payload hash does not match", async () => {
      const s = single;
      const room = fixture.room;
      if (!s || !room) throw new Error("fixture missing");
      /** The stored history row of the session (compared before and after). */
      const history = async () => {
        const db = await openDatabase(s.runtime, s.env);
        try {
          return await db.manager.findOneBy<{ id: string }>("game_sessions", {
            id: room.sessionId,
          });
        } finally {
          await db.destroy();
        }
      };
      const before = await history();
      expect(before).not.toBeNull();
      // The queued payload no longer matches the frozen report the room still holds; the scheduler's
      // re-sync (non-durable state) must detect it instead of replacing the job or the history.
      await restartWith(
        room,
        { payload_hash: "f".repeat(64) },
        { status: "pending", reportId: null, retryable: true, errorCode: null },
        false,
      );
      const alarm = `finalization invariant violated for session ${room.sessionId}`;
      expect(await until(async () => s.api.logs().includes(alarm), true, 60_000)).toBe(true);
      expect(await sessions(room.sessionId)).toBe(1);
      expect(await history()).toEqual(before);
      expect((await report(room.sessionId)).json).toEqual(fixture.report);
    });
  },
);
