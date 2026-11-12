/**
 * TASK-183A: the gateway coalesces publishes per room (one diff in flight plus one queued, however
 * many callers), keeps `forget` after the publishes queued before it, and answers
 * `player:submit_answer` without waiting for the room's publish queue.
 * TASK-185C: a diff reads the state without a copy, projects the full host view only for phase
 * events, and builds per-player reveal/podium pushes without a room snapshot per player.
 */
import type { RuntimeRepository } from "@kabuki-neko/database";
import type { JwtGuard } from "../../common/guards/jwt.guard";
import { RateLimitService } from "../../common/rate-limit.service";
import type { ConfigService } from "../../config/config.service";
import type { ActiveRoomState, IGameStateStore } from "../../providers/state/game-state.interface";
import type { StateConnections } from "../../providers/state/state.module";
import { GameGateway } from "./game.gateway";
import type { GameService, PlayerBinding } from "./game.service";
import type { RecoveryService } from "./recovery.service";
import type { RoomRegistryService } from "./room-registry.service";
import * as projector from "./room-projector";

const identity = { pin: "123456", sessionId: "8f0e7a52-3c1d-4b6e-9a7f-2d5c4b3a1e09" };
const binding: PlayerBinding = {
  ...identity,
  playerId: "3c9d1e2f-4a5b-4c6d-8e7f-901a2b3c4d5e",
  generation: 1,
};

/** A promise with its resolver, to hold a diff's state read open. */
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Gateway over a store whose state reads are recorded and wait for `hold`, with a
 * recording Socket.io server double and a game service whose admission succeeds at once.
 */
function gateway(hold: () => Promise<void> = async () => undefined) {
  const log: string[] = [];
  const store = {
    readPrivateSnapshot: async () => {
      log.push("read");
      await hold();
      return null;
    },
  };
  const server = {
    to: () => ({
      emit: (event: string) => {
        log.push(`emit:${event}`);
        return true;
      },
    }),
  };
  const game = {
    submitAnswer: async () => ({
      accepted: true as const,
      submissionId: "s",
      questionIndex: 0,
      receivedAt: 1,
    }),
  };
  const unused = {} as never;
  const instance = new GameGateway(
    { get: () => [] } as unknown as ConfigService,
    unused as JwtGuard,
    new RateLimitService(),
    store as unknown as IGameStateStore,
    unused as StateConnections,
    game as unknown as GameService,
    unused as RecoveryService,
    unused as RoomRegistryService,
    unused as RuntimeRepository,
  );
  Reflect.set(instance, "server", server);
  const queues = () => Reflect.get(instance, "queues") as Map<string, Promise<void>>;
  const pending = () => Reflect.get(instance, "pendingPublishes") as Map<string, Promise<void>>;
  const execute = (event: string, socket: unknown, request: Record<string, unknown>) =>
    (
      Reflect.get(instance, "execute") as (
        event: string,
        socket: unknown,
        request: Record<string, unknown>,
      ) => Promise<unknown>
    ).call(instance, event, socket, request);
  return { instance, log, queues, pending, execute };
}

it("runs one diff in flight plus one queued for a burst of 50 publishes", async () => {
  const first = gate();
  let reads = 0;
  const { instance, log, queues, pending } = gateway(async () => {
    reads += 1;
    if (reads === 1) await first.promise;
  });
  const started = instance.publish(identity);
  await new Promise((resolve) => setImmediate(resolve));
  // The first diff holds its read open; the 49 calls made meanwhile share one queued diff.
  const burst = [started, ...Array.from({ length: 49 }, () => instance.publish(identity))];
  expect(log).toEqual(["read"]);
  expect(pending().size).toBe(1);
  first.open();
  await Promise.all(burst);
  expect(log).toEqual(["read", "read"]);
  // Nothing is left behind once the work settles (code review MJ-05).
  expect(queues().size).toBe(0);
  expect(pending().size).toBe(0);
  // A later publish starts a fresh diff.
  await instance.publish(identity);
  expect(log).toEqual(["read", "read", "read"]);
});

it("keeps room:expired after the publishes queued before forget", async () => {
  const first = gate();
  let reads = 0;
  const { instance, log } = gateway(async () => {
    reads += 1;
    if (reads === 1) await first.promise;
  });
  const running = instance.publish(identity);
  await new Promise((resolve) => setImmediate(resolve));
  const published = [running, instance.publish(identity), instance.publish(identity)];
  const forgotten = instance.forget(identity, "ROOM_EXPIRED");
  first.open();
  await Promise.all([...published, forgotten]);
  expect(log).toEqual(["read", "read", "emit:room:expired"]);
});

it("acknowledges an admitted answer without waiting for a slow publish", async () => {
  const held = gate();
  const { execute, log } = gateway(() => held.promise);
  const socket = { data: { player: binding } };
  const ack = await execute("player:submit_answer", socket, {
    requestId: "r",
    sessionId: identity.sessionId,
    pinCode: identity.pin,
    questionIndex: 0,
    questionId: "q",
    submissionId: "s",
    answer: 0,
  });
  expect(ack).toMatchObject({ accepted: true, submissionId: "s" });
  // The publish was started, and is still waiting on its state read.
  expect(log).toEqual(["read"]);
  held.open();
});

describe("diff work per publish (TASK-185C)", () => {
  afterEach(() => jest.restoreAllMocks());

  /** A minimal private room in `phase` with `players` connected players (fields `diff` reads). */
  function state(
    phase: ActiveRoomState["phase"],
    phaseVersion: number,
    answered: number,
    players = 200,
  ) {
    const ids = Array.from({ length: players }, (_, i) => `p${i}`);
    return {
      sessionId: identity.sessionId,
      pinCode: identity.pin,
      hostId: "h",
      phase,
      phaseVersion,
      revision: phaseVersion * 1000 + answered,
      publicRevision: phaseVersion * 1000 + answered,
      isLocked: true,
      finalization: null,
      endReason: null,
      questionIndex: 0,
      timing: {
        phaseStartedAt: 1,
        phaseEndsAt: null,
        questionStartedAt: 1,
        inputClosesAt: 2,
        acceptanceClosesAt: 3,
      },
      quiz: { title: "Q", questions: [{}] },
      requiredPlayerIds: ids,
      eligiblePlayerIds: ids,
      answers: Object.fromEntries(ids.slice(0, answered).map((id) => [`0:${id}`, {}])),
      players: Object.fromEntries(
        ids.map((id, i) => [
          id,
          {
            id,
            nickname: id,
            avatar: { style: "bottts", seed: id },
            connected: true,
            joinOrder: i,
            kickedAt: null,
            connectionGeneration: 1,
            rank: null,
          },
        ]),
      ),
    } as unknown as ActiveRoomState;
  }

  /** A gateway whose store serves `current()` and whose server counts emits per event. */
  function withRoom(current: () => ActiveRoomState) {
    const emits = new Map<string, number>();
    const server = {
      to: () => ({
        emit: (event: string) => {
          emits.set(event, (emits.get(event) ?? 0) + 1);
          return true;
        },
      }),
      in: () => ({ disconnectSockets: () => undefined }),
    };
    const unused = {} as never;
    const instance = new GameGateway(
      { get: () => [] } as unknown as ConfigService,
      unused as JwtGuard,
      new RateLimitService(),
      {
        readPrivateSnapshot: async () => current(),
        getPrivateSnapshot: async () => {
          throw new Error("diff must not copy the state");
        },
      } as unknown as IGameStateStore,
      unused as StateConnections,
      unused as GameService,
      unused as RecoveryService,
      unused as RoomRegistryService,
      unused as RuntimeRepository,
    );
    Reflect.set(instance, "server", server);
    return { instance, emits };
  }

  it("projects the host view only for phase events, not for answer counts", async () => {
    let current = state("QUESTION_ANSWERING", 5, 0);
    const host = jest
      .spyOn(projector, "projectHost")
      .mockReturnValue({ question: null } as unknown as ReturnType<typeof projector.projectHost>);
    const { instance, emits } = withRoom(() => current);
    await instance.publish(identity); // first publish: phase event
    expect(host).toHaveBeenCalledTimes(1);
    for (let answered = 1; answered <= 50; answered++) {
      current = state("QUESTION_ANSWERING", 5, answered);
      await instance.publish(identity);
    }
    expect(host).toHaveBeenCalledTimes(1);
    expect(emits.get("game:answer_count_updated")).toBe(51);
  });

  it("builds a 200-player reveal without a room snapshot per player", async () => {
    let current = state("QUESTION_ANSWERING", 5, 200);
    jest
      .spyOn(projector, "projectHost")
      .mockReturnValue({ question: null, reveal: { type: "POLL" } } as unknown as ReturnType<
        typeof projector.projectHost
      >);
    const perPlayer = jest
      .spyOn(projector, "projectPlayerReveal")
      .mockReturnValue({} as ReturnType<typeof projector.projectPlayerReveal>);
    const snapshot = jest.spyOn(projector, "projectPlayer");
    const { instance, emits } = withRoom(() => current);
    await instance.publish(identity);
    current = state("ANSWER_REVEAL", 6, 200);
    await instance.publish(identity);
    expect(perPlayer).toHaveBeenCalledTimes(200);
    expect(snapshot).not.toHaveBeenCalled();
    // One host reveal plus one per player.
    expect(emits.get("game:answer_reveal")).toBe(201);
  });
});
