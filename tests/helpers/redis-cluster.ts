/**
 * Real Redis 7 Cluster fixture for contract tests (SA §6.1; TASK-167).
 *
 * It starts `docker/docker-compose.test-cluster.yml` under a unique Compose project with six free
 * loopback ports: three masters and three replicas, AOF on, and host networking so the cluster's
 * announced addresses work from the test process. `stop()` removes exactly that project (its
 * containers and volumes), never anything else.
 *
 * Failure injection:
 * - `kill(node)` crashes one node (SIGKILL);
 * - `start(node)` brings it back with its own AOF;
 * - `wipe(node)` recreates it without data, i.e. lost AOF.
 * `cli(node, ...)` runs `redis-cli` inside that node, and `masterFor(key)` names the node that
 * currently owns a key's slot.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const COMPOSE_FILE = path.join(process.cwd(), "docker/docker-compose.test-cluster.yml");
/** Node service names in the Compose file. */
export const CLUSTER_NODES = ["node-0", "node-1", "node-2", "node-3", "node-4", "node-5"] as const;
/** One node service name. */
export type ClusterNode = (typeof CLUSTER_NODES)[number];

/** True when nothing listens on loopback `port`. */
async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Six consecutive free ports below the cluster-bus offset (port + 10000 must also be free). */
async function freePorts(): Promise<number[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 9000);
    const ports = Array.from({ length: 6 }, (_, index) => base + index);
    const candidates = [...ports, ...ports.map((port) => port + 10000)];
    if ((await Promise.all(candidates.map(portFree))).every(Boolean)) return ports;
  }
  throw new Error("No free port range for the Redis Cluster fixture");
}

/** A running cluster. */
export interface RedisClusterFixture {
  /** `redis://127.0.0.1:<port>` seed URLs of all six nodes. */
  urls: string[];
  /** Port of each node service. */
  ports: Record<ClusterNode, number>;
  /** Runs `redis-cli -p <port> ...args` inside the node; returns trimmed stdout. */
  cli: (node: ClusterNode, ...args: string[]) => Promise<string>;
  /** The node currently serving `key`'s slot as master. */
  masterFor: (key: string) => Promise<ClusterNode>;
  /** Waits until every slot is served and `cluster_state:ok` (after a failover, too). */
  waitHealthy: (timeoutMs?: number) => Promise<void>;
  kill: (node: ClusterNode) => Promise<void>;
  start: (node: ClusterNode) => Promise<void>;
  /** Recreates a node from scratch: its AOF and cluster config are gone. */
  wipe: (node: ClusterNode) => Promise<void>;
  /** Removes this project's containers and volumes. */
  stop: () => Promise<void>;
}

/** Starts the six-node cluster and waits until it serves all slots. */
export async function startRedisCluster(): Promise<RedisClusterFixture> {
  const portList = await freePorts();
  const project = `kabuki-test-cluster-${randomBytes(4).toString("hex")}`;
  const env = {
    ...process.env,
    ...Object.fromEntries(
      portList.map((port, index) => [`KN_CLUSTER_PORT_${index}`, String(port)]),
    ),
  };
  const compose = (...args: string[]) =>
    run("docker", ["compose", "-p", project, "-f", COMPOSE_FILE, ...args], {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  const ports = Object.fromEntries(
    CLUSTER_NODES.map((node, index) => [node, portList[index] ?? 0]),
  ) as Record<ClusterNode, number>;
  const cli = async (node: ClusterNode, ...args: string[]) =>
    (
      await compose("exec", "-T", node, "redis-cli", "-p", String(ports[node]), ...args)
    ).stdout.trim();
  /** Runs a command on the first node that answers (some may be killed by a test). */
  const anyCli = async (...args: string[]) => {
    for (const node of CLUSTER_NODES) {
      try {
        return await cli(node, ...args);
      } catch {
        // Down; try the next one.
      }
    }
    throw new Error("No cluster node answered");
  };
  const nodeOfPort = (port: number) =>
    CLUSTER_NODES.find((node) => ports[node] === port) ?? CLUSTER_NODES[0];

  const fixture: RedisClusterFixture = {
    urls: portList.map((port) => `redis://127.0.0.1:${port}`),
    ports,
    cli,
    async masterFor(key) {
      const slot = Number(await anyCli("CLUSTER", "KEYSLOT", key));
      for (const line of (await anyCli("CLUSTER", "NODES")).split("\n")) {
        const parts = line.split(" ");
        if (!parts[2]?.includes("master") || parts[2]?.includes("fail")) continue;
        const port = Number(parts[1]?.split(":")[1]?.split("@")[0]);
        for (const range of parts.slice(8)) {
          const [from, to = from] = range.split("-").map(Number);
          if (from !== undefined && to !== undefined && slot >= from && slot <= to)
            return nodeOfPort(port);
        }
      }
      throw new Error(`No master for slot ${slot}`);
    },
    async waitHealthy(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const node of CLUSTER_NODES) {
          try {
            const info = await cli(node, "CLUSTER", "INFO");
            if (info.includes("cluster_state:ok") && info.includes("cluster_slots_ok:16384"))
              return;
          } catch {
            // Node down: ask another one.
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Redis Cluster did not become healthy");
    },
    async kill(node) {
      await compose("kill", "-s", "SIGKILL", node);
    },
    async start(node) {
      await compose("start", node);
    },
    async wipe(node) {
      await compose("rm", "-f", "-s", "-v", node);
      await compose("up", "-d", "--no-deps", node);
    },
    async stop() {
      await compose("down", "-v", "--remove-orphans", "--timeout", "1");
    },
  };

  try {
    await compose("up", "-d", "--wait", ...CLUSTER_NODES);
    await compose("run", "--rm", "init");
    await fixture.waitHealthy();
    // Every master has a replica attached and in sync before tests rely on failover.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const nodes = await anyCli("CLUSTER", "NODES");
      const replicas = nodes.split("\n").filter((line) => line.includes(" slave ")).length;
      if (replicas === 3) {
        // Attached is not enough: a replica only fails over once its initial sync finished.
        const links = await Promise.all(
          CLUSTER_NODES.map(async (node) => {
            const info = await cli(node, "INFO", "replication");
            return !info.includes("role:slave") || info.includes("master_link_status:up");
          }),
        );
        if (links.every(Boolean)) break;
      }
      if (Date.now() > deadline) throw new Error("Replicas did not attach and sync");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return fixture;
  } catch (error) {
    await fixture.stop().catch(() => undefined);
    throw error;
  }
}
