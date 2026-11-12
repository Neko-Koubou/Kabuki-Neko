/**
 * TASK-168 timing boundaries and crash recovery across two API nodes on one Redis and a real SQL
 * database (PostgreSQL 16, MySQL 8.4), in the `multi` topology (SA §5.3–5.5, §6.3; BR-08;
 * US-10–13/16).
 *
 * All timing is the server's: answers carry no client time. The test reads the server's own
 * `serverStartTime`/`inputClosesAt`/`acceptanceClosesAt` and aligns sends with a `room:time`
 * offset. Margins stay well inside each window; the exact millisecond edges (499/500, +1500/+1501)
 * are covered by the scoring and state unit tests.
 *
 * Covered per database:
 * - Speed points: an answer received under 500 ms earns the full 1000 base points; one received
 *   seconds later earns less.
 * - Grace: an answer received after `inputClosesAt` but before `acceptanceClosesAt` (+1500 ms)
 *   counts; one after it is refused (TIME_EXPIRED) and scores nothing.
 * - Required, optional and kicked sets:
 *   - a player disconnected when the question started is optional, and NOT_ELIGIBLE when it
 *     returns without answering;
 *   - a removed (kicked) player no longer holds the question open;
 *   - it closes as soon as every remaining required player answered.
 * - Crash: the node running the host and the timers is killed mid-question. The other node takes
 *   over the room's timers; the host recovers on it in the same question; the answer given before
 *   the crash counts exactly once; the reveal follows.
 * - Podium: a single silent player is the only entry (rank 1, score 0) and nobody is invented;
 *   a room emptied by removals ends with an empty podium.
 */
import { randomUUID } from "node:crypto";
import {
  GameClient,
  answeringQuestion,
  createRoom,
  join,
  quizWith,
  serverOffset,
  startScaledApis,
  untilServerTime,
  type ScaledApis,
} from "../helpers/game";
import { httpClient, startApi } from "../helpers/runtime";

jest.setTimeout(300_000);

describe.each(["postgres", "mysql"] as const)(
  "timing and recovery across two nodes on %s",
  (driver) => {
    let apis: ScaledApis | undefined;
    const clients: GameClient[] = [];

    /** A recorded client on node `index`. */
    const on = async (index: 0 | 1, token?: string) => {
      if (!apis) throw new Error("apis missing");
      const client = await GameClient.connect(apis.nodes[index].url, token);
      clients.push(client);
      return client;
    };
    /** Public option index of the option with `text`. */
    const pick = (question: { options: { index: number; text: string }[] }, text: string) =>
      question.options.find((option) => option.text === text)?.index ?? -1;
    /** Personal result of a player's reveal. */
    const resultOf = async (client: GameClient) =>
      (
        (await client.waitFor("game:answer_reveal"))["data"] as {
          result: { result: string; basePoints: number; pointsAwarded: number };
        }
      ).result;

    beforeAll(async () => {
      apis = await startScaledApis(driver);
    });

    afterAll(async () => {
      for (const client of clients) client.close();
      await apis?.nodes[0].stop();
      await apis?.nodes[1].stop();
      await apis?.runtime.cleanup();
    });

    it("scores by server receive time and honours the 1500 ms grace exactly", async () => {
      if (!apis) throw new Error("apis missing");
      const quiz = await quizWith(apis.call, apis.host, "Batas Waktu", [
        {
          type: "SINGLE_CHOICE",
          prompt: "Cepat?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 10,
        },
        {
          type: "SINGLE_CHOICE",
          prompt: "Telat?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 5,
        },
      ]);
      const host = await on(0, apis.host);
      const room = await createRoom(host, quiz);
      const fast = await on(1);
      const slow = await on(1);
      const late = await on(0);
      const tooLate = await on(1);
      for (const [client, name] of [
        [fast, "Kilat"],
        [slow, "Siput"],
        [late, "Telat"],
        [tooLate, "Lewat"],
      ] as const)
        await join(client, room, name);
      const offset = await serverOffset(fast, room);
      expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );

      // Question 0: full points under 500 ms, fewer seconds later.
      const first = await answeringQuestion(fast, 0);
      const answer = (client: GameClient, question: typeof first) =>
        client.emit("player:submit_answer", {
          ...room,
          questionIndex: question.question.questionIndex,
          questionId: question.question.id,
          submissionId: randomUUID(),
          answer: pick(question.question, "Ya"),
        });
      await untilServerTime(first.serverStartTime + 150, offset);
      const quick = await answer(fast, first);
      expect(quick.ok).toBe(true);
      expect(Number(quick.data?.["receivedAt"]) - first.serverStartTime).toBeLessThan(500);
      await untilServerTime(first.serverStartTime + 3000, offset);
      expect((await answer(slow, first)).ok).toBe(true);
      for (const client of [late, tooLate]) expect((await answer(client, first)).ok).toBe(true);
      expect((await resultOf(fast)).basePoints).toBe(1000);
      expect((await resultOf(slow)).basePoints).toBeLessThan(1000);
      await host.waitFor("game:answer_reveal");

      // Question 1: one answer inside the grace window, one after it.
      const synced = await host.emit("room:sync", room);
      const reveal = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
      expect(
        (await host.emit("host:next_step", { ...room, expectedPhaseVersion: reveal })).ok,
      ).toBe(true);
      expect(
        (await host.emit("host:next_step", { ...room, expectedPhaseVersion: reveal + 1 })).ok,
      ).toBe(true);
      const second = await answeringQuestion(late, 1);
      // Fast and Slow answer at once, so only Late and TooLate keep the question open.
      for (const client of [fast, slow]) expect((await answer(client, second)).ok).toBe(true);
      await untilServerTime(second.inputClosesAt + 700, offset);
      const inGrace = await answer(late, second);
      expect(inGrace.ok).toBe(true);
      expect(Number(inGrace.data?.["receivedAt"])).toBeGreaterThan(second.inputClosesAt);
      expect(Number(inGrace.data?.["receivedAt"])).toBeLessThanOrEqual(second.acceptanceClosesAt);
      await untilServerTime(second.acceptanceClosesAt + 300, offset);
      const pastGrace = await answer(tooLate, second);
      expect(pastGrace.ok).toBe(false);
      expect(["TIME_EXPIRED", "INVALID_PHASE", "QUESTION_CLOSED"]).toContain(
        pastGrace.error?.errorCode,
      );
      const lateResult = (
        (
          await late.waitFor(
            "game:answer_reveal",
            (data) => (data["reveal"] as { questionIndex?: number })?.questionIndex === 1,
          )
        )["data"] as { result: { result: string } }
      ).result;
      const tooLateResult = (
        (
          await tooLate.waitFor(
            "game:answer_reveal",
            (data) => (data["reveal"] as { questionIndex?: number })?.questionIndex === 1,
          )
        )["data"] as { result: { result: string; pointsAwarded: number } }
      ).result;
      expect(lateResult.result).toBe("CORRECT");
      expect(tooLateResult.result).toBe("UNANSWERED");
      expect(tooLateResult.pointsAwarded).toBe(0);
    });

    it("closes once every remaining required player answered; absent players are optional", async () => {
      if (!apis) throw new Error("apis missing");
      const quiz = await quizWith(apis.call, apis.host, "Himpunan", [
        {
          type: "SINGLE_CHOICE",
          prompt: "Siapa?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 30,
        },
      ]);
      const host = await on(0, apis.host);
      const room = await createRoom(host, quiz);
      const stay = await on(1);
      const kicked = await on(1);
      const away = await on(0);
      await join(stay, room, "Tetap");
      const removed = await join(kicked, room, "Keluar");
      const absent = await join(away, room, "Pergi");
      // "Pergi" is disconnected when the question starts, so it is optional, not required.
      away.close();
      await host.waitFor(
        "room:presence_changed",
        (data) => data["playerId"] === absent.playerId && data["connected"] === false,
      );
      expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );
      const open = await answeringQuestion(stay, 0);
      // It comes back mid-question on the other node but does not answer.
      const back = await on(1);
      expect(
        (
          await back.emit("player:join_room", {
            pinCode: room.pinCode,
            sessionId: room.sessionId,
            sessionToken: absent.sessionToken,
          })
        ).ok,
      ).toBe(true);
      // Removing a required player releases the question for the others.
      expect(
        (await host.emit("host:kick_player", { ...room, playerId: removed.playerId })).ok,
      ).toBe(true);
      await kicked.waitFor("player:kicked");
      const started = Date.now();
      expect(
        (
          await stay.emit("player:submit_answer", {
            ...room,
            questionIndex: 0,
            questionId: open.question.id,
            submissionId: randomUUID(),
            answer: pick(open.question, "Ya"),
          })
        ).ok,
      ).toBe(true);
      await host.waitFor("game:answer_reveal");
      // Closed by the last required answer, long before the 30 s timer.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((await resultOf(stay)).result).toBe("CORRECT");
      expect((await resultOf(back)).result).toBe("NOT_ELIGIBLE");
    });

    it("resumes a question on the other node after the host's node crashes", async () => {
      if (!apis) throw new Error("apis missing");
      const quiz = await quizWith(apis.call, apis.host, "Pemulihan", [
        {
          type: "SINGLE_CHOICE",
          prompt: "Bertahan?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 10,
        },
      ]);
      const host = await on(0, apis.host);
      const room = await createRoom(host, quiz);
      const answered = await on(1);
      const waiting = await on(1);
      await join(answered, room, "Sudah");
      await join(waiting, room, "Belum");
      expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );
      const open = await answeringQuestion(answered, 0);
      expect(
        (
          await answered.emit("player:submit_answer", {
            ...room,
            questionIndex: 0,
            questionId: open.question.id,
            submissionId: randomUUID(),
            answer: pick(open.question, "Ya"),
          })
        ).ok,
      ).toBe(true);
      // Node 0 (host + any timers it owned) crashes mid-question.
      await apis.nodes[0].kill();
      const survivor = await on(1, apis.host);
      const recovered = await survivor.emit("host:recover_room", { sessionId: room.sessionId });
      expect(recovered.ok).toBe(true);
      const snapshot = recovered.data?.["snapshot"] as {
        phase: string;
        question: { id: string } | null;
      };
      expect(snapshot.question?.id).toBe(open.question.id);
      // The timer still closes the question on the surviving node; the answer counts once.
      const result = await resultOf(answered);
      expect(result.result).toBe("CORRECT");
      expect((await resultOf(waiting)).result).toBe("UNANSWERED");
      const hostReveal = await survivor.waitFor("game:answer_reveal");
      expect((hostReveal["data"] as { reveal: { correctCount: number } }).reveal.correctCount).toBe(
        1,
      );
      // Restart node 0 for the following tests (REST goes to the new process).
      apis.nodes[0] = await startApi(apis.runtime, apis.env);
      apis.call = httpClient(apis.nodes[0].base);
    });

    it("never invents podium winners: one silent player is the only entry, an emptied room has none", async () => {
      if (!apis) throw new Error("apis missing");
      const quiz = await quizWith(apis.call, apis.host, "Sunyi", [
        {
          type: "SINGLE_CHOICE",
          prompt: "Ada?",
          options: [["Ya", true], ["Tidak"]],
          timeLimitSec: 5,
        },
      ]);
      // One player who never answers: ranked (score 0) but alone on the podium.
      const host = await on(0, apis.host);
      const room = await createRoom(host, quiz);
      const silent = await on(1);
      const quiet = await join(silent, room, "Diam");
      expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );
      await host.waitFor("game:answer_reveal", () => true, 30_000);
      const synced = await host.emit("room:sync", room);
      const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
      expect(
        (await host.emit("host:next_step", { ...room, expectedPhaseVersion: version })).ok,
      ).toBe(true);
      const podium = (await host.waitFor("game:podium"))["data"] as {
        podium: { playerId: string; rank: number; score: number }[];
      };
      expect(podium.podium.map((entry) => [entry.playerId, entry.rank, entry.score])).toEqual([
        [quiet.playerId, 1, 0],
      ]);
      // Everyone removed before the end: an empty podium.
      const emptied = await createRoom(host, quiz);
      const leaving = await on(1);
      const gone = await join(leaving, emptied, "Pergi");
      expect(
        (await host.emit("host:kick_player", { ...emptied, playerId: gone.playerId })).ok,
      ).toBe(true);
      expect((await host.emit("host:end_game", { ...emptied, expectedPhaseVersion: 1 })).ok).toBe(
        true,
      );
      const empty = await host.waitFor(
        "game:podium",
        (_data, envelope) => envelope["sessionId"] === emptied.sessionId,
      );
      expect((empty["data"] as { podium: unknown[] }).podium).toEqual([]);
    });
  },
);
