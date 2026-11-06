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
const record = z.record(z.string(), z.unknown());
describe("Redis atomic answer admission and scoring commit", () => {
  let rt: Awaited<ReturnType<typeof createTestRuntime>>;
  let redis: Redis;
  let scripts: Record<string, string>;
  beforeAll(async () => {
    rt = await createTestRuntime();
    const container = await rt.redis();
    redis = new Redis(container.getConnectionUrl());
    scripts = Object.fromEntries(
      await Promise.all(
        ["mutate-room", "admit-answer", "close-question"].map(async (name) => [
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
  async function run(name: string, op: object, controlledNow?: number) {
    let script = scripts[name];
    if (!script) throw new Error("Missing Lua source");
    if (controlledNow !== undefined) {
      // Test-only server-clock substitution. Production script has no timestamp input.
      const original = "local now = tonumber(time[1])*1000 + math.floor(tonumber(time[2])/1000)";
      if (!script.includes(original))
        throw new Error("Clock fixture no longer matches production source");
      script = script.replace(original, `local now = ${controlledNow}`);
    }
    return record.parse(
      JSON.parse(
        z
          .string()
          .parse(await redis.eval(script, keys.length, ...keys, session, JSON.stringify(op))),
      ),
    );
  }
  async function seed(required = [uuid(6)], startedAt = Date.now()) {
    const s = activeRoomStateSchema.parse({
      ...room(),
      players: { [uuid(6)]: player(), [uuid(7)]: player(7) },
      phase: "QUESTION_ANSWERING",
      questionIndex: 0,
      accepting: true,
      requiredPlayerIds: required,
      eligiblePlayerIds: required,
      createdAt: startedAt,
      lobbyActiveAt: startedAt,
      hardExpiresAt: startedAt + 28800000,
      timing: {
        phaseStartedAt: startedAt,
        phaseEndsAt: startedAt + 20000,
        questionStartedAt: startedAt,
        inputClosesAt: startedAt + 20000,
        acceptanceClosesAt: startedAt + 21500,
      },
    });
    await run("mutate-room", { kind: "create", state: s, ttlMs: 28800000 });
    return s;
  }
  function answer(n = 6) {
    return {
      playerId: uuid(n),
      generation: 1,
      submissionId: uuid(n + 10),
      questionIndex: 0,
      questionId: uuid(2),
      answer: "Neko",
    };
  }
  async function state() {
    return record.parse(JSON.parse(z.string().parse(await redis.hget(keys[0] ?? "", "state"))));
  }
  async function commit() {
    const s = await state();
    const closed = record.parse(record.parse(s.closedQuestions)["0"]);
    return {
      kind: "commit",
      expectedRevision: s.revision,
      closedQuestionHash: closed.hash,
      result: {
        questionIndex: 0,
        reveal: {
          type: "TYPE_ANSWER",
          questionIndex: 0,
          correctOptionIds: [],
          acceptedTexts: ["Neko"],
          correctOrderIds: [],
          optionCounts: [],
          correctCount: 1,
          partialCount: 0,
          incorrectCount: 0,
          unansweredCount: 0,
          explanationText: null,
        },
        personal: {},
        leaderboard: { topPlayers: [], biggestClimber: null },
        playerTotals: Object.fromEntries(
          [6, 7].map((n) => [
            uuid(n),
            {
              score: 1000,
              streak: 1,
              maxStreak: 1,
              correctCount: 1,
              responseSumMs: 100,
              responseCount: 1,
              rank: n - 5,
              previousRank: null,
            },
          ]),
        ),
      },
    };
  }
  it.each([0, 1500, 1501])(
    "enforces authoritative input deadline +%i milliseconds",
    async (offset) => {
      const start = Date.now();
      await seed([uuid(6), uuid(7)], start);
      const at = start + 20000 + offset;
      const response = await run("admit-answer", answer(), at);
      if (offset <= 1500) {
        expect(response).toMatchObject({
          answer: { receivedAt: at, responseTimeMs: 20000 + offset },
        });
        expect(
          await run(
            "close-question",
            { kind: "close", reason: "TIMER", expectedPhaseVersion: 1 },
            at,
          ),
        ).toMatchObject({ error: "TIME_EXPIRED" });
      } else {
        expect(response).toMatchObject({ error: "TIME_EXPIRED" });
        expect(
          await run(
            "close-question",
            { kind: "close", reason: "TIMER", expectedPhaseVersion: 1 },
            at,
          ),
        ).toMatchObject({ closed: { reason: "TIMER" } });
      }
    },
  );
  it("deduplicates concurrent submissions and preserves original ACK after reveal", async () => {
    await seed();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => run("admit-answer", answer())),
    );
    for (const r of results) expect(r.answer).toEqual(results[0]?.answer);
    expect(await state()).toMatchObject({ accepting: false, phase: "QUESTION_ANSWERING" });
    const input = await commit();
    const commits = await Promise.all([run("close-question", input), run("close-question", input)]);
    expect(commits.map((r) => r.result).sort()).toEqual(["COMMITTED", "RETRY"]);
    expect((await run("admit-answer", answer())).answer).toEqual(results[0]?.answer);
    expect(await run("admit-answer", { ...answer(), answer: "Dog" })).toMatchObject({
      error: "ALREADY_ANSWERED",
    });
    expect(await run("admit-answer", { ...answer(), submissionId: uuid(99) })).toMatchObject({
      error: "ALREADY_ANSWERED",
    });
    expect(record.parse((await state()).players)[uuid(6)]).toMatchObject({
      score: 1000,
      streak: 1,
    });
  });
  it.each(["HOST_SKIP", "HOST_END"])(
    "freezes without grace for %s, then resumes scoring after worker loss",
    async (reason) => {
      await seed([uuid(6), uuid(7)]);
      const response = await run("close-question", {
        kind: "close",
        expectedPhaseVersion: 1,
        reason,
      });
      expect(response).toMatchObject({ closed: { reason } });
      expect(await run("admit-answer", answer())).toMatchObject({ error: "INVALID_PHASE" });
      expect(
        await run("close-question", { kind: "close", expectedPhaseVersion: 1, reason }),
      ).toMatchObject({ result: "ALREADY_CLOSED" });
      // A fresh worker reads the persisted immutable freeze; no process-local state needed.
      expect(await run("close-question", await commit())).toMatchObject({ result: "COMMITTED" });
      expect(await state()).toMatchObject({
        phase: reason === "HOST_END" ? "PODIUM" : "ANSWER_REVEAL",
      });
    },
  );
  it("serializes submit/skip races and only scores persisted accepted answers", async () => {
    await seed([uuid(6), uuid(7)]);
    const results = await Promise.all([
      run("admit-answer", answer()),
      run("close-question", { kind: "close", reason: "HOST_SKIP", expectedPhaseVersion: 1 }),
      run("admit-answer", answer(7)),
    ]);
    const frozen = record.parse(record.parse((await state()).closedQuestions)["0"]);
    const accepted = results.filter((r) => r.answer).map((r) => r.answer);
    expect(frozen.answers).toEqual(accepted.length ? accepted : {});
    expect(await run("close-question", await commit())).toMatchObject({ result: "COMMITTED" });
  });
  it("never vacuously closes an empty required set", async () => {
    await seed([]);
    await run("admit-answer", answer());
    expect(await state()).toMatchObject({ accepting: true });
    expect(
      await run("close-question", {
        kind: "close",
        reason: "ALL_ANSWERED",
        expectedPhaseVersion: 1,
      }),
    ).toMatchObject({ error: "INVALID_PHASE" });
  });
  it("fences stale generations, invalid question/type and stale result revisions", async () => {
    await seed();
    expect(await run("admit-answer", { ...answer(), generation: 0 })).toMatchObject({
      error: "SESSION_REPLACED",
    });
    expect(await run("admit-answer", { ...answer(), questionId: uuid(99) })).toMatchObject({
      error: "QUESTION_MISMATCH",
    });
    expect(await run("admit-answer", { ...answer(), answer: 1 })).toMatchObject({
      error: "INVALID_ANSWER",
    });
    await run("admit-answer", answer());
    const input = await commit();
    expect(await run("close-question", { ...input, expectedRevision: 0 })).toMatchObject({
      result: "RETRY",
    });
    expect(
      await run("close-question", { ...input, closedQuestionHash: "0".repeat(64) }),
    ).toMatchObject({ result: "RETRY" });
    expect(await state()).toMatchObject({ phase: "QUESTION_ANSWERING" });
    expect(await run("close-question", input)).toMatchObject({ result: "COMMITTED" });
  });
  it("matches SHA-256 test vectors in both production scripts", async () => {
    for (const name of ["admit-answer", "close-question"]) {
      const script = scripts[name];
      if (!script) throw new Error("Missing script");
      const fn = script.slice(
        script.indexOf("local function sha256"),
        script.indexOf("local function freeze"),
      );
      for (const value of ["", "abc", "a".repeat(1000), "猫/🐱"]) {
        expect(await redis.eval(fn + "return sha256(ARGV[1])", 0, value)).toBe(
          createHash("sha256").update(value).digest("hex"),
        );
      }
    }
  });
});
