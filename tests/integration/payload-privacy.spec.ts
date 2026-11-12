/**
 * TASK-168 payload privacy across two API nodes on one Redis and PostgreSQL 16 (SA §5.2, §10.1;
 * US-09–12). Privacy does not depend on the SQL dialect; the two-node path does, so PostgreSQL
 * represents both dialects here.
 *
 * A Streamer game covers single choice, multiple select, typed answer, order puzzle and poll. The
 * host is on node A and two players are on node B, one of them answering. Every server event and
 * ACK each role receives is recorded and scanned recursively.
 *
 * Covered:
 * - Before a question's reveal, no role (host included) receives:
 *   - a key: isCorrect, acceptedTexts, correctOptionIds or correctOrderIds;
 *   - the typed answer's accepted text;
 *   - the puzzle's private sortOrder.
 *   This includes pushes, ACKs and a recovery snapshot taken mid-question.
 * - Never, in any phase: token hashes, other players' session tokens, frozen reports, private
 *   answer maps or eligibility sets. Players never get host-only finalization or report data.
 * - A player's reveal carries only their own personal result.
 * The rendered pages' HTML (SSR) is covered by the browser suites (player.spec, host.spec): they
 * hold no quiz content, and the stage loads everything over these sockets.
 */
import { randomUUID } from "node:crypto";
import {
  GameClient,
  answeringQuestion,
  createRoom,
  join,
  quizWith,
  startScaledApis,
  type ScaledApis,
} from "../helpers/game";

jest.setTimeout(300_000);

/** Keys that reveal the answer key. */
const KEY_FIELDS = new Set(["isCorrect", "acceptedTexts", "correctOptionIds", "correctOrderIds"]);
/** Keys that must never reach any client. */
const SECRET_FIELDS = new Set([
  "tokenHash",
  "frozenReport",
  "answers",
  "eligiblePlayerIds",
  "requiredPlayerIds",
  "closedQuestions",
  "commands",
  "tickets",
  "sortOrder",
]);
/** Keys only the host may receive. */
const HOST_ONLY = new Set(["finalization", "reportId", "answeredCount", "eligibleCount"]);
/** The typed answer's accepted text (never sent before its reveal). */
const SECRET_TEXT = "Kucingku Manis";

/** Every key path in `value` (recursively). */
function keys(value: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => keys(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) {
      out.push(`${path}.${key}`);
      keys(inner, `${path}.${key}`, out);
    }
  return out;
}
/** Last segment of a key path. */
const leaf = (path: string) =>
  path
    .split(".")
    .at(-1)
    ?.replace(/\[\d+\]$/u, "") ?? "";

describe("payload privacy across two nodes on postgres", () => {
  let apis: ScaledApis | undefined;
  const clients: GameClient[] = [];
  /** ACKs each role received, scanned like pushes. */
  const acks: { role: "host" | "player"; questionIndex: number | null; body: unknown }[] = [];

  beforeAll(async () => {
    apis = await startScaledApis("postgres");
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await apis?.nodes[0].stop();
    await apis?.nodes[1].stop();
    await apis?.runtime.cleanup();
  });

  it("never sends keys before the reveal, secrets ever, or other players' results", async () => {
    if (!apis) throw new Error("apis missing");
    const quiz = await quizWith(apis.call, apis.host, "Privasi", [
      { type: "SINGLE_CHOICE", prompt: "Satu?", options: [["Benar", true], ["Salah"]] },
      {
        type: "MULTIPLE_SELECT",
        prompt: "Dua?",
        options: [["A", true], ["B", true], ["C"]],
      },
      { type: "TYPE_ANSWER", prompt: "Nama kucing?", options: [[SECRET_TEXT, true]] },
      {
        type: "ORDER_PUZZLE",
        prompt: "Urutkan",
        options: [["Pertama"], ["Kedua"], ["Ketiga"], ["Keempat"]],
      },
      { type: "POLL", prompt: "Suka?", options: [["Ya"], ["Tidak"]] },
    ]);
    const host = await GameClient.connect(apis.nodes[0].url, apis.host);
    const answering = await GameClient.connect(apis.nodes[1].url);
    const watching = await GameClient.connect(apis.nodes[1].url);
    clients.push(host, answering, watching);
    const room = await createRoom(host, quiz, "STREAMER");
    const self = await join(answering, room, "Penjawab");
    const other = await join(watching, room, "Penonton");
    expect((await host.emit("host:start_game", { ...room, expectedPhaseVersion: 1 })).ok).toBe(
      true,
    );

    for (let index = 0; index < 5; index++) {
      const open = await answeringQuestion(answering, index);
      // A recovery snapshot mid-question (reconnect from another socket on the other node).
      const peek = await GameClient.connect(apis.nodes[0].url);
      clients.push(peek);
      const recovered = await peek.emit("player:join_room", {
        pinCode: room.pinCode,
        sessionId: room.sessionId,
        sessionToken: other.sessionToken,
      });
      expect(recovered.ok).toBe(true);
      acks.push({ role: "player", questionIndex: index, body: recovered });
      acks.push({ role: "host", questionIndex: index, body: await host.emit("room:sync", room) });
      const options = open.question.options;
      const answer =
        index === 2
          ? "salah ketik"
          : index === 1
            ? [options[0]?.index ?? 0]
            : index === 3
              ? options.map((option) => option.index)
              : (options[0]?.index ?? 0);
      const submitted = await answering.emit("player:submit_answer", {
        ...room,
        questionIndex: index,
        questionId: open.question.id,
        submissionId: randomUUID(),
        answer,
      });
      expect(submitted.ok).toBe(true);
      acks.push({ role: "player", questionIndex: index, body: submitted });
      // The watcher reconnected on `peek`, so close the question by Skip.
      expect(
        (await host.emit("host:skip_timer", { ...room, expectedPhaseVersion: open.phaseVersion }))
          .ok,
      ).toBe(true);
      await host.waitFor(
        "game:answer_reveal",
        (data) => (data["reveal"] as { questionIndex?: number })?.questionIndex === index,
      );
      const synced = await host.emit("room:sync", room);
      const version = Number((synced.data?.["snapshot"] as { phaseVersion: number }).phaseVersion);
      expect(
        (await host.emit("host:next_step", { ...room, expectedPhaseVersion: version })).ok,
      ).toBe(true);
      if (index < 4)
        expect(
          (await host.emit("host:next_step", { ...room, expectedPhaseVersion: version + 1 })).ok,
        ).toBe(true);
    }
    await host.waitFor("game:podium");

    /** Recorded pushes of `client` with the question each was sent under. */
    const pushes = (client: GameClient, role: "host" | "player") => {
      let current: number | null = null;
      let revealed = -1;
      return client.events.map((event) => {
        const data = ((event.payload ?? {}) as { data?: Record<string, unknown> }).data ?? {};
        const question = data["question"] as { questionIndex?: number } | undefined;
        if (typeof question?.questionIndex === "number") current = question.questionIndex;
        if (event.name === "game:answer_reveal")
          revealed = (data["reveal"] as { questionIndex: number }).questionIndex;
        return {
          role,
          name: event.name,
          body: event.payload,
          beforeReveal: current !== null && revealed < current,
        };
      });
    };
    const all = [
      ...pushes(host, "host"),
      ...pushes(answering, "player"),
      ...pushes(watching, "player"),
      ...acks.map((ack) => ({ role: ack.role, name: "ack", body: ack.body, beforeReveal: true })),
    ];
    expect(all.length).toBeGreaterThan(30);
    for (const entry of all) {
      const paths = keys(entry.body);
      const text = JSON.stringify(entry.body);
      for (const path of paths) {
        expect({
          where: `${entry.role} ${entry.name}`,
          path,
          secret: SECRET_FIELDS.has(leaf(path)),
        }).toMatchObject({ secret: false });
        if (entry.role === "player")
          expect({ where: entry.name, path, hostOnly: HOST_ONLY.has(leaf(path)) }).toMatchObject({
            hostOnly: false,
          });
      }
      if (entry.beforeReveal) {
        for (const path of paths)
          expect({
            where: `${entry.role} ${entry.name}`,
            path,
            key: KEY_FIELDS.has(leaf(path)),
          }).toMatchObject({ key: false });
        expect(text.includes(SECRET_TEXT)).toBe(false);
      }
      // No push ever carries a session token, and nobody else's token appears anywhere.
      if (entry.name !== "ack") expect(text.includes("sessionToken")).toBe(false);
      if (entry.role === "player" && entry.name !== "ack")
        expect(text.includes(self.sessionToken) || text.includes(other.sessionToken)).toBe(false);
    }
    // A player's reveal carries only their own result.
    for (const [client, mine] of [
      [answering, self.playerId],
      [watching, other.playerId],
    ] as const) {
      for (const event of client.events.filter((item) => item.name === "game:answer_reveal")) {
        const data = (event.payload as { data: Record<string, unknown> }).data;
        expect(Object.keys(data).sort()).toEqual(["result", "reveal"]);
        expect(JSON.stringify(data)).not.toContain(
          mine === self.playerId ? other.playerId : self.playerId,
        );
      }
    }
  });
});
