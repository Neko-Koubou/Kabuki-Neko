import { Injectable, Module } from "@nestjs/common";
import Redis, { Cluster } from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Server } from "socket.io";
import { ConfigService } from "../../config/config.service";
import { projectRoom } from "../../modules/game-engine/room-projector";
import { GAME_STATE_STORE, StateDomainError } from "./game-state.interface";
import type { RoomProjector } from "./game-state.interface";
import { MemoryStateStore } from "./memory-state.store";
import { RedisStateStore } from "./redis-state.store";

/** The domain projector registers during module initialization. No private state
 * is ever used as a temporary public projection before that registration. */
@Injectable()
export class StateProjection {
  private projector: RoomProjector | undefined;
  register(projector: RoomProjector): void {
    this.projector = projector;
  }
  readonly project: RoomProjector = (state, principal, now) => {
    if (!this.projector) throw new StateDomainError("STATE_UNAVAILABLE");
    return this.projector(state, principal, now);
  };
}

/** Owns independent command/publish/subscribe connections. The future game
 * gateway installs this adapter on its Socket.io server before accepting traffic. */
export class StateConnections {
  private clients: (Redis | Cluster)[] = [];
  command: Redis | Cluster | null = null;
  private adapter: ReturnType<typeof createAdapter> | null = null;
  private constructor(private readonly config: ConfigService) {}
  static async open(config: ConfigService): Promise<StateConnections> {
    const connections = new StateConnections(config);
    if (config.get("STATE_DRIVER") === "memory") return connections;
    try {
      for (let i = 0; i < 3; i++) {
        const client = connections.makeClient();
        // ioredis emits connection errors; callers receive a redacted domain error.
        client.on("error", () => undefined);
        connections.clients.push(client);
      }
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            connections.clients.map(
              (client) =>
                new Promise<void>((resolve, reject) => {
                  // Cluster may reconnect during its initial readiness check. Its
                  // first connect() promise need not resolve on that later attempt.
                  client.once("ready", resolve);
                  void client.connect().catch(reject);
                }),
            ),
          ),
          new Promise<never>((_resolve, reject) => {
            startupTimer = setTimeout(() => reject(new Error("State startup timeout")), 5000);
          }),
        ]);
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
      }
      const [command, pub, sub] = connections.clients;
      if (!command || !pub || !sub) throw new Error("Missing state connections");
      await Promise.all(connections.clients.map((client) => client.ping()));
      connections.command = command;
      connections.adapter = createAdapter(pub, sub, {
        key: `kabukineko:${config.get("STATE_NAMESPACE")}:socket.io`,
        requestsTimeout: 2000,
        publishOnSpecificResponseChannel: true,
      });
      return connections;
    } catch {
      await connections.onModuleDestroy();
      throw new StateDomainError("STATE_UNAVAILABLE");
    }
  }
  private makeClient(): Redis | Cluster {
    const redisOptions = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
      autoResendUnfulfilledCommands: false,
    };
    const nodes = this.config.get("REDIS_CLUSTER_NODES");
    if (nodes.length > 0) {
      const urls = nodes.map((node) => new URL(node));
      const first = urls[0];
      if (
        !first ||
        urls.some(
          (u) =>
            u.protocol !== first.protocol ||
            u.username !== first.username ||
            u.password !== first.password ||
            (u.pathname !== "" && u.pathname !== "/" && u.pathname !== "/0"),
        )
      )
        throw new Error("Inconsistent Redis cluster configuration");
      return new Cluster(
        urls.map((url) => ({ host: url.hostname, port: Number(url.port || 6379) })),
        {
          lazyConnect: true,
          enableOfflineQueue: false,
          redisOptions: {
            ...redisOptions,
            ...(first.username ? { username: decodeURIComponent(first.username) } : {}),
            ...(first.password ? { password: decodeURIComponent(first.password) } : {}),
            ...(first.protocol === "rediss:" ? { tls: {} } : {}),
          },
        },
      );
    }
    const url = this.config.get("REDIS_URL");
    if (!url) throw new Error("Missing Redis configuration");
    return new Redis(url, redisOptions);
  }
  install(server: Server): void {
    if (this.adapter) {
      if (this.clients.some((client) => client.status !== "ready"))
        throw new StateDomainError("STATE_UNAVAILABLE");
      server.adapter(this.adapter);
    }
  }
  onModuleDestroy(): void {
    const clients = this.clients;
    this.clients = [];
    this.command = null;
    this.adapter = null;
    // disconnect cancels reconnect timers and closes sockets synchronously.
    // Cluster does not consistently emit end after an empty pool reset.
    for (const client of clients) client.disconnect();
  }
}

/**
 * Installs the allowlist role projector (TASK-076) into the shared projection holder. The projector
 * is a pure function, so both stores receive it without a circular Nest module dependency.
 */
function createProjection(): StateProjection {
  const projection = new StateProjection();
  projection.register(projectRoom);
  return projection;
}

@Module({
  providers: [
    { provide: StateProjection, useFactory: createProjection },
    {
      provide: StateConnections,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => StateConnections.open(config),
    },
    {
      provide: GAME_STATE_STORE,
      inject: [StateConnections, StateProjection, ConfigService],
      useFactory: (
        connections: StateConnections,
        projection: StateProjection,
        config: ConfigService,
      ) =>
        connections.command
          ? new RedisStateStore(
              connections.command,
              projection.project,
              config.get("STATE_NAMESPACE"),
            )
          : new MemoryStateStore(projection.project),
    },
  ],
  exports: [GAME_STATE_STORE, StateProjection, StateConnections],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class StateModule {}
