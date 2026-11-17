/**
 * Gateway room bookkeeping (code review MJ-05): the per-room publish queue is dropped once it
 * settles, and a room the scheduler drops is forgotten after `room:expired` carrying the real
 * reason reaches its host and players, which also stops the room's heartbeat.
 */
import type { RuntimeRepository } from "@kabuki-neko/database";
import type { JwtGuard } from "../../common/guards/jwt.guard";
import { RateLimitService } from "../../common/rate-limit.service";
import type { ConfigService } from "../../config/config.service";
import type { IGameStateStore } from "../../providers/state/game-state.interface";
import type { StateConnections } from "../../providers/state/state.module";
import { GameGateway } from "./game.gateway";
import type { GameService } from "./game.service";
import type { RecoveryService } from "./recovery.service";
import type { RoomRegistryService } from "./room-registry.service";

const identity = { pin: "123456", sessionId: "8f0e7a52-3c1d-4b6e-9a7f-2d5c4b3a1e09" };

/** Gateway over a store that knows no room, with a recording Socket.io server double. */
function gateway() {
  const emitted: { rooms: string[]; event: string; data: unknown }[] = [];
  const server = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, data: unknown) => {
        emitted.push({ rooms: ([] as string[]).concat(rooms), event, data });
        return true;
      },
    }),
  };
  const unused = {} as never;
  const instance = new GameGateway(
    { get: () => [] } as unknown as ConfigService,
    unused as JwtGuard,
    new RateLimitService(),
    { getPrivateSnapshot: async () => null } as unknown as IGameStateStore,
    unused as StateConnections,
    unused as GameService,
    unused as RecoveryService,
    unused as RoomRegistryService,
    unused as RuntimeRepository,
  );
  Reflect.set(instance, "server", server);
  const queues = () => Reflect.get(instance, "queues") as Map<string, Promise<void>>;
  const summaries = () => Reflect.get(instance, "summaries") as Map<string, unknown>;
  const beat = () => (Reflect.get(instance, "beat") as () => void).call(instance);
  return { instance, emitted, queues, summaries, beat };
}

it("drops a room's publish queue once its work settles", async () => {
  const { instance, queues } = gateway();
  await Promise.all([instance.publish(identity), instance.publish(identity)]);
  expect(queues().size).toBe(0);
});

it("sends room:expired with the scheduler's reason and stops the heartbeat", async () => {
  const { instance, emitted, queues, summaries, beat } = gateway();
  summaries().set(identity.sessionId, {
    pin: identity.pin,
    revision: 4,
    publicRevision: 3,
    phaseVersion: 2,
  });
  beat();
  expect(emitted.map((item) => item.event)).toEqual(["room:version"]);
  await instance.forget(identity, "ROOM_EXPIRED");
  expect(emitted[1]).toMatchObject({
    rooms: [`host:${identity.sessionId}`, `players:${identity.sessionId}`],
    event: "room:expired",
    data: { sessionId: identity.sessionId, data: { reason: "ROOM_EXPIRED" } },
  });
  expect(summaries().size).toBe(0);
  expect(queues().size).toBe(0);
  beat();
  expect(emitted).toHaveLength(2);
});

it("forgets a room released after retention without a push", async () => {
  const { instance, emitted, summaries } = gateway();
  summaries().set(identity.sessionId, { pin: identity.pin, revision: 1 });
  await instance.forget(identity, null);
  expect(emitted).toEqual([]);
  expect(summaries().size).toBe(0);
});
