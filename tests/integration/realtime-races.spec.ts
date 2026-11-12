/**
 * TASK-168 realtime races across two API nodes on one Redis and a real SQL database (PostgreSQL 16,
 * MySQL 8.4) in the `multi` topology (SA §5, §11.2; US-07–13/16).
 *
 * Covered per database:
 * - Host on node A, players on node B: joins, phases, answers and reveals cross nodes, and both
 *   roles see one authoritative game.
 * - Two Next commands with one phase version advance exactly once: one is accepted, the other
 *   refused, and no question is skipped.
 * - Submit racing Skip: the answer is either counted (accepted ACK and a scored result) or refused
 *   (and the result is UNANSWERED), never both.
 * - Submit racing End: the report holds the answer exactly when its ACK was accepted.
 * - An old socket generation is refused after the player reconnects on the other node.
 * - A lost join ACK replayed with the same requestId on the other node returns the same slot and
 *   token, never a second player.
 * Server receive time decides everything: no client timestamp is sent or trusted.
 */
import { randomUUID } from "node:crypto";
import {
  GameClient,
  answeringQuestion,
  createRoom,
  join,
  phaseVersion,
  quizWith,
  startScaledApis,
  type Room,
  type ScaledApis,
} from "../helpers/game";

jest.setTimeout(300_000);

describe.each(["postgres", "mysql"] as const)("realtime races across two nodes on %s", (driver) => {
  let apis: ScaledApis | undefined;
  const clients: GameClient[] = [];
  let quiz: { id: string; revision: number };

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

  beforeAll(async () => {
    apis = await startScaledApis(driver);
    quiz = await quizWith(apis.call, apis.host, "Balapan Realtime", [
      { type: "SINGLE_CHOICE", prompt: "Ibu kota?", options: [["Jakarta", true], ["Bandung"]] },
      { type: "SINGLE_CHOICE", prompt: "Gunung?", options: [["Semeru", true], ["Merapi"]] },
      { type: "SINGLE_CHOICE", prompt: "Pulau?", options: [["Kalimantan", true], ["Papua"]] },
    ]);
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await apis?.nodes[0].stop();
    await apis?.nodes[1].stop();
    await apis?.runtime.cleanup();
  });

  /** Host on node 0 and two players on node 1, game started at question 0. */
  const startedGame = async () => {
    if (!apis) throw new Error("apis missing");
    const host = await on(0, apis.host);
    const room = await createRoom(host, quiz);
    const ani = await on(1);
    const budi = await on(1);
    const aniId = (await join(ani, room, "Ani")).playerId;
    const budiId = (await join(budi, room, "Budi")).playerId;
    await host.waitFor(
      "room:player_joined",
      (data) => (data["player"] as { id?: string })?.id === budiId,
    );
    const started = await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 });
    expect(started.ok).toBe(true);
    return { host, room, ani, budi, aniId, budiId };
  };

  it("plays one authoritative game with the host and players on different nodes", async () => {
    const { host, room, ani, budi } = await startedGame();
    const [forAni, forBudi, forHost] = await Promise.all([
      answeringQuestion(ani, 0),
      answeringQuestion(budi, 0),
      answeringQuestion(host, 0),
    ]);
    expect(forBudi.question.id).toBe(forAni.question.id);
    expect(forHost.question.id).toBe(forAni.question.id);
    expect(forBudi.inputClosesAt).toBe(forAni.inputClosesAt);
    const submit = (client: GameClient, text: string) =>
      client.emit("player:submit_answer", {
        ...room,
        questionIndex: 0,
        questionId: forAni.question.id,
        submissionId: randomUUID(),
        answer: pick(forAni.question, text),
      });
    expect((await submit(ani, "Jakarta")).ok).toBe(true);
    expect((await submit(budi, "Bandung")).ok).toBe(true);
    const [aniReveal, budiReveal, hostReveal] = await Promise.all([
      ani.waitFor("game:answer_reveal"),
      budi.waitFor("game:answer_reveal"),
      host.waitFor("game:answer_reveal"),
    ]);
    expect((aniReveal["data"] as { result: { result: string } }).result.result).toBe("CORRECT");
    expect((budiReveal["data"] as { result: { result: string } }).result.result).toBe("INCORRECT");
    const reveal = (
      hostReveal["data"] as { reveal: { correctCount: number; incorrectCount: number } }
    ).reveal;
    expect([reveal.correctCount, reveal.incorrectCount]).toEqual([1, 1]);

    // Two Next commands with the same phase version: exactly one advances.
    const version = await phaseVersion(host, room);
    const [first, second] = await Promise.all([
      host.emit("host:next_step", { ...room, expectedPhaseVersion: version }),
      host.emit("host:next_step", { ...room, expectedPhaseVersion: version }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const refused = first.ok ? second : first;
    expect(["STALE_PHASE", "PHASE_VERSION_MISMATCH", "INVALID_PHASE"]).toContain(
      refused.error?.errorCode,
    );
    await host.waitFor("game:leaderboard");
    const next = await host.emit("host:next_step", { ...room, expectedPhaseVersion: version + 1 });
    expect(next.ok).toBe(true);
    // The next question is question 1, and question 2 is never announced.
    await ani.waitFor(
      "game:question_preview",
      (data) => (data["question"] as { questionIndex?: number })?.questionIndex === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      ani.events.filter(
        (event) =>
          event.name === "game:question_preview" &&
          (
            (event.payload as { data?: { question?: { questionIndex?: number } } }).data
              ?.question ?? {}
          ).questionIndex === 2,
      ),
    ).toHaveLength(0);
  });

  it("counts an answer racing Skip exactly when its ACK was accepted", async () => {
    const { host, room, ani, aniId } = await startedGame();
    const open = await answeringQuestion(ani, 0);
    const [submitted, skipped] = await Promise.all([
      ani.emit("player:submit_answer", {
        ...room,
        questionIndex: 0,
        questionId: open.question.id,
        submissionId: randomUUID(),
        answer: pick(open.question, "Jakarta"),
      }),
      host.emit("host:skip_timer", { ...room, expectedPhaseVersion: open.phaseVersion }),
    ]);
    expect(skipped.ok).toBe(true);
    const reveal = await ani.waitFor("game:answer_reveal");
    const result = (reveal["data"] as { result: { result: string } }).result.result;
    if (submitted.ok) expect(result).toBe("CORRECT");
    else {
      expect(["TIME_EXPIRED", "INVALID_PHASE", "QUESTION_CLOSED"]).toContain(
        submitted.error?.errorCode,
      );
      expect(result).toBe("UNANSWERED");
    }
    expect(aniId).toBeTruthy();
  });

  it("keeps an answer racing End in the report exactly when its ACK was accepted", async () => {
    if (!apis) throw new Error("apis missing");
    const { host, room, ani, aniId } = await startedGame();
    const open = await answeringQuestion(ani, 0);
    const [submitted, ended] = await Promise.all([
      ani.emit("player:submit_answer", {
        ...room,
        questionIndex: 0,
        questionId: open.question.id,
        submissionId: randomUUID(),
        answer: pick(open.question, "Jakarta"),
      }),
      host.emit("host:end_game", { ...room, expectedPhaseVersion: open.phaseVersion }),
    ]);
    expect(ended.ok).toBe(true);
    // Wait for the durable report.
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt++) {
      const status = await apis.call(`/reports/${room.sessionId}/status`, { token: apis.host });
      ready = (status.json as { status?: string } | null)?.status === "ready";
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const answers = await apis.call(
      `/reports/${room.sessionId}/players/${aniId}/answers?limit=20`,
      {
        token: apis.host,
      },
    );
    expect(answers.status).toBe(200);
    const first = (
      answers.json as { items: { questionIndex: number; status: string }[] }
    ).items.find((item) => item.questionIndex === 0);
    expect(first?.status).toBe(submitted.ok ? "ANSWERED" : "UNANSWERED");
  });

  it("refuses the old socket after a player reconnects on the other node", async () => {
    if (!apis) throw new Error("apis missing");
    const host = await on(0, apis.host);
    const room: Room = await createRoom(host, quiz);
    const oldSocket = await on(0);
    const joined = await join(oldSocket, room, "Cici");
    const newSocket = await on(1);
    const recovered = await newSocket.emit("player:join_room", {
      pinCode: room.pinCode,
      sessionId: room.sessionId,
      sessionToken: joined.sessionToken,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.data?.["playerId"]).toBe(joined.playerId);
    await oldSocket.waitFor("player:session_replaced");
    // The old socket is cut off: either disconnected by the server, or every command refused.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (oldSocket.socket.connected) {
      const stale = await oldSocket.emit("player:update_avatar", {
        ...room,
        avatar: { style: "bottts", seed: "lama" },
      });
      expect(stale.ok).toBe(false);
      expect(["SESSION_REPLACED", "INVALID_SESSION_TOKEN", "AUTH_REQUIRED", "FORBIDDEN"]).toContain(
        stale.error?.errorCode,
      );
    } else expect(oldSocket.socket.disconnected).toBe(true);
    const fresh = await newSocket.emit("player:update_avatar", {
      ...room,
      avatar: { style: "bottts", seed: "baru" },
    });
    expect(fresh.ok).toBe(true);
  });

  it("replays a lost join ACK on the other node as the same slot and token", async () => {
    if (!apis) throw new Error("apis missing");
    const host = await on(0, apis.host);
    const room = await createRoom(host, quiz);
    const requestId = randomUUID();
    const first = await on(0);
    const original = await join(first, room, "Dodi", requestId);
    first.close(); // the ACK was "lost": the client retries elsewhere with the same request
    const second = await on(1);
    const replay = await join(second, room, "Dodi", requestId);
    expect(replay.playerId).toBe(original.playerId);
    expect(replay.sessionToken).toBe(original.sessionToken);
    const snapshot = await host.emit("room:sync", room);
    const players = (snapshot.data?.["snapshot"] as { players: { id: string }[] }).players;
    expect(players.map((player) => player.id)).toEqual([original.playerId]);
  });
});
