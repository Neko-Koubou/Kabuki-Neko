/**
 * Socket rate-limit keys (code review MJ-15): anonymous sockets from one client must not mint a
 * limiter key per connection. Before the fix, sync/time/answer/avatar requests from unbound
 * sockets were keyed on `socket.id` and charged before validation, so one client opening sockets
 * could fill the in-memory limiter's 100 000-key cap and turn every new principal into a 503.
 */
import { RateLimitService, type RateTier } from "../../common/rate-limit.service";
import type { ConfigService } from "../../config/config.service";
import type { JwtGuard } from "../../common/guards/jwt.guard";
import type { IGameStateStore } from "../../providers/state/game-state.interface";
import type { StateConnections } from "../../providers/state/state.module";
import type { GameService } from "./game.service";
import type { RecoveryService } from "./recovery.service";
import type { RoomRegistryService } from "./room-registry.service";
import type { RuntimeRepository } from "@kabuki-neko/database";
import { GameGateway } from "./game.gateway";

/** Handler registered by the gateway for one client event. */
type Handler = (payload: unknown, ack: (response: unknown) => void) => void;

/** Minimal socket double: records handlers, carries the gateway's per-socket data. */
function fakeSocket(id: string) {
  const handlers = new Map<string, Handler>();
  const socket = {
    id,
    data: { ip: "203.0.113.7", host: null, player: null, expiry: null },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    disconnect() {},
  };
  /** Sends one event and resolves with the ACK envelope. */
  const send = (event: string, payload: unknown) =>
    new Promise<{ ok: boolean; error?: { errorCode: string } }>((resolve) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler for ${event}`);
      handler(payload, (response) =>
        resolve(response as { ok: boolean; error?: { errorCode: string } }),
      );
    });
  return { socket, send };
}

/** Gateway wired to a memory limiter whose charged keys are recorded. */
function gateway() {
  const limiter = new RateLimitService();
  const charged = new Set<string>();
  const consume = limiter.consume.bind(limiter);
  jest.spyOn(limiter, "consume").mockImplementation(async (tier: RateTier, principal: string) => {
    charged.add(`${tier}:${principal}`);
    return consume(tier, principal);
  });
  const config = { get: () => [] } as unknown as ConfigService;
  const unused = {} as never;
  const instance = new GameGateway(
    config,
    unused as JwtGuard,
    limiter,
    unused as IGameStateStore,
    unused as StateConnections,
    unused as GameService,
    unused as RecoveryService,
    unused as RoomRegistryService,
    unused as RuntimeRepository,
  );
  return { instance, charged };
}

// The gateway arms a 120 s join deadline per anonymous socket; keep it off the real clock.
beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] }));
afterEach(() => jest.useRealTimers());

const identity = {
  sessionId: "8f0e7a52-3c1d-4b6e-9a7f-2d5c4b3a1e09",
  pinCode: "123456",
};

it("keeps the limiter key count constant for many anonymous sockets from one client", async () => {
  const { instance, charged } = gateway();
  const sockets = Array.from({ length: 40 }, (_, index) => fakeSocket(`socket-${index}`));
  for (const { socket, send } of sockets) {
    instance.handleConnection(socket as never);
    const answers = await Promise.all([
      send("room:time", { requestId: crypto.randomUUID(), ...identity, clientSentAt: 1 }),
      send("room:sync", { requestId: crypto.randomUUID(), ...identity }),
      send("player:submit_answer", { requestId: crypto.randomUUID(), junk: true }),
      send("player:update_avatar", { requestId: crypto.randomUUID(), junk: true }),
    ]);
    expect(answers.map((answer) => answer.error?.errorCode)).toEqual([
      "AUTH_REQUIRED",
      "AUTH_REQUIRED",
      "INVALID_SESSION_TOKEN",
      "INVALID_SESSION_TOKEN",
    ]);
    await instance.handleDisconnect(socket as never);
  }
  // No request that needs a binding reaches the limiter, so no per-socket keys exist.
  expect(charged.size).toBe(0);
});

it("keys IP-tier events by client IP, not by connection", async () => {
  const { instance, charged } = gateway();
  for (let index = 0; index < 20; index += 1) {
    const { socket, send } = fakeSocket(`socket-${index}`);
    instance.handleConnection(socket as never);
    await send("host:lock_room", { requestId: crypto.randomUUID(), junk: true });
    await instance.handleDisconnect(socket as never);
  }
  expect([...charged]).toEqual(["HOST:ip:203.0.113.7"]);
});

it("keys sync and time of a bound player on the player, shared across reconnects", async () => {
  const { instance, charged } = gateway();
  for (let index = 0; index < 5; index += 1) {
    const { socket, send } = fakeSocket(`socket-${index}`);
    instance.handleConnection(socket as never);
    socket.data.player = {
      pin: identity.pinCode,
      sessionId: identity.sessionId,
      playerId: "player-1",
      generation: index + 1,
    } as never;
    const time = await send("room:time", {
      requestId: crypto.randomUUID(),
      ...identity,
      clientSentAt: Date.now(),
    });
    expect(time.ok).toBe(true);
    socket.data.player = null;
    await instance.handleDisconnect(socket as never);
  }
  expect([...charged]).toEqual(["TIME:player:player-1"]);
});
