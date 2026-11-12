/**
 * `pnpm benchmark:game --clients 200 --transitions 100 [--mode memory|redis] [--out file]` —
 * broadcast and report-load benchmark for one game room (TASK-179; SA §11.2; US-16, US-20).
 *
 * Harness (isolated, never touching a real instance):
 * - `memory`: one built API process with SQLite and in-memory game state.
 * - `redis`: two API processes on PostgreSQL 16 + Redis 7 (containers). The host is on node A and
 *   the players alternate between A and B, so half the broadcasts cross nodes through Redis.
 * - A quiz of single-choice questions is hosted. `--clients` players join from distinct simulated
 *   client addresses (`X-Forwarded-For`, trusted only from loopback). Each device is subject to
 *   the production join, answer and time limits; no limit is raised for the benchmark.
 * - Per question:
 *   1. the server moves preview → answering on its own;
 *   2. every player answers after a random 0–1.5 s think time, so the question closes when the
 *      last answer is admitted;
 *   3. the host sends Next twice (leaderboard, next question), paced to stay inside the host
 *      command limit (30/min).
 *   That is four phase transitions per question, until `--transitions` is reached. The game then
 *   ends on the podium.
 *
 * Measurements:
 * - Transport latency: from the server's committed timestamp of each push (`serverTime`, taken
 *   when the state change is committed and enqueued) to the client's receipt. The client's clock is
 *   corrected by its offset from `room:time` (NTP-style midpoint of the lowest-RTT sample); the
 *   clock error bound is half that RTT.
 * - Admission latency: player `submit_answer` ACK round trip (state-store admission).
 * - State latency: host command ACK round trip (phase commit).
 * - Delivery: every connected player must observe every phase version. Missing (client, phase)
 *   pairs count as packet loss.
 * - Report queue age: from the game's end to its report being durable (`status: ready`), with
 *   every answer of every player written.
 * - Environment: CPU, RAM, load, Node/runtime, drivers and engine versions, network path, and
 *   duration.
 *
 * Output: a JSON record (default `test-results/benchmark/<mode>.json`) and a Markdown summary.
 * Exit code 0 only when transport p95 < 50 ms and no delivery was lost. A missed target is
 * reported as a failure, never extrapolated or retried away. Loopback on one host is a
 * controlled baseline, not a real LAN; more than 200 clients needs a separate run.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { io, type Socket } from "socket.io-client";

/** Target from SA §11.2: broadcast p95 under 50 ms with 200 clients on a controlled network. */
export const P95_TARGET_MS = 50;

/** One `room:time` exchange: client send/receive (local clock) and server receive/send. */
export interface ClockSample {
  clientSentAt: number;
  serverReceivedAt: number;
  serverSentAt: number;
  clientReceivedAt: number;
}

/** Clock offset (server − client, ms) and its error bound from the lowest-RTT sample. */
export interface ClockEstimate {
  offsetMs: number;
  errorBoundMs: number;
  rttMs: number;
}

/**
 * NTP-style estimate: for each sample, RTT = (t3 − t0) − (t2 − t1) and offset =
 * ((t1 − t0) + (t2 − t3)) / 2. The sample with the lowest RTT wins; its error bound is RTT / 2.
 */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate {
  if (samples.length === 0) throw new Error("no clock samples");
  let best: ClockEstimate | null = null;
  for (const sample of samples) {
    const processing = Math.max(0, sample.serverSentAt - sample.serverReceivedAt);
    const rttMs = Math.max(0, sample.clientReceivedAt - sample.clientSentAt - processing);
    const offsetMs =
      (sample.serverReceivedAt -
        sample.clientSentAt +
        (sample.serverSentAt - sample.clientReceivedAt)) /
      2;
    if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs, errorBoundMs: rttMs / 2 };
  }
  return best as ClockEstimate;
}

/** Latency of one push: client receipt corrected to server time minus the server timestamp. */
export function transportLatency(
  serverTime: number,
  clientReceivedAt: number,
  offsetMs: number,
): number {
  return clientReceivedAt + offsetMs - serverTime;
}

/** Nearest-rank percentile (p in 0–100) of a non-empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("no values");
  if (p < 0 || p > 100) throw new Error("percentile out of range");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** Summary statistics of a latency sample (ms, rounded to 0.01). */
export interface LatencySummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Summarizes a sample; an empty sample is reported as count 0 with nulls avoided by zeros. */
export function summarize(values: readonly number[]): LatencySummary {
  const round = (value: number) => Math.round(value * 100) / 100;
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  return {
    count: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

/** Delivery loss: missing (client, phase) observations over the expected count. */
export function deliveryLoss(expectedPhases: readonly number[], observed: readonly Set<number>[]) {
  const expected = expectedPhases.length * observed.length;
  let missing = 0;
  for (const seen of observed) for (const phase of expectedPhases) if (!seen.has(phase)) missing++;
  return { expected, missing, ratio: expected === 0 ? 0 : missing / expected };
}

/** Outcomes besides latency that also fail a run (code review MN-43). */
export interface VerdictExtras {
  /** Answers without a successful ACK (refused, timed out or lost with a dropped connection). */
  rejectedAnswers?: number;
  /** False when the game's report never became durable (`ready`) within the wait. */
  reportReady?: boolean;
  /** Why the run stopped early (a host command failed after its retries), if it did. */
  abortReason?: string | null;
}

/**
 * Pass/fail verdict: p95 under the target, nothing lost, no player connection dropped, every
 * answer admitted and the report durable. Each miss is a stated reason, never a silent pass.
 */
export function verdict(
  transport: LatencySummary,
  lossRatio: number,
  disconnects = 0,
  extras: VerdictExtras = {},
) {
  const reasons: string[] = [];
  if (disconnects > 0) reasons.push(`${disconnects} player connection(s) dropped`);
  if (transport.count === 0) reasons.push("no transport samples");
  if (transport.p95 >= P95_TARGET_MS)
    reasons.push(`transport p95 ${transport.p95} ms ≥ ${P95_TARGET_MS} ms`);
  if (lossRatio > 0) reasons.push(`delivery loss ${(lossRatio * 100).toFixed(3)}%`);
  if ((extras.rejectedAnswers ?? 0) > 0)
    reasons.push(`${extras.rejectedAnswers} answer(s) not admitted`);
  if (extras.reportReady === false) reasons.push("report not durable");
  if (extras.abortReason) reasons.push(`run aborted: ${extras.abortReason}`);
  return { pass: reasons.length === 0, reasons };
}

/** Line prefix written by `scripts/lib/event-loop-probe.cjs`. */
export const PROBE_PREFIX = "KN_PROBE ";

/** One probe interval of a process: event-loop delay, CPU (% of one core) and heap. */
export interface ProbeSample {
  t: number;
  lagP50Ms: number;
  lagP99Ms: number;
  lagMaxMs: number;
  cpuPercent: number;
  heapMiB: number;
}

/**
 * Probe samples from a process's output, kept when `from <= t <= to` (the measured run). Lines
 * that are not well-formed probe samples are ignored.
 */
export function parseProbeLines(output: string, from = 0, to = Infinity): ProbeSample[] {
  const samples: ProbeSample[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const start = line.indexOf(PROBE_PREFIX);
    if (start === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(start + PROBE_PREFIX.length));
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const fields = value as Record<string, unknown>;
    const keys = ["t", "lagP50Ms", "lagP99Ms", "lagMaxMs", "cpuPercent", "heapMiB"] as const;
    if (!keys.every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key])))
      continue;
    const sample = Object.fromEntries(
      keys.map((key) => [key, fields[key]]),
    ) as unknown as ProbeSample;
    if (sample.t >= from && sample.t <= to) samples.push(sample);
  }
  return samples;
}

/** Per-process diagnostics over the measured run. */
export interface ProcessDiagnostics {
  samples: number;
  /** Distribution of the per-interval p99 event-loop delay. */
  lagP99Ms: LatencySummary;
  /** Largest single event-loop delay observed. */
  lagMaxMs: number;
  cpuPercentMean: number;
  cpuPercentMax: number;
  heapMaxMiB: number;
}

/** Aggregates probe samples; null when the process was not measured. */
export function summarizeProbe(samples: readonly ProbeSample[]): ProcessDiagnostics | null {
  if (samples.length === 0) return null;
  const round = (value: number) => Math.round(value * 10) / 10;
  const cpu = samples.map((sample) => sample.cpuPercent);
  return {
    samples: samples.length,
    lagP99Ms: summarize(samples.map((sample) => sample.lagP99Ms)),
    lagMaxMs: Math.max(...samples.map((sample) => sample.lagMaxMs)),
    cpuPercentMean: round(cpu.reduce((sum, value) => sum + value, 0) / cpu.length),
    cpuPercentMax: round(Math.max(...cpu)),
    heapMaxMiB: Math.max(...samples.map((sample) => sample.heapMiB)),
  };
}

/** One dropped player connection: the API node it was on and Socket.io's reason. */
export interface DisconnectEvent {
  node: string;
  reason: string;
  /** Milliseconds after the measured run started. */
  atMs: number;
}

/** Counts dropped connections per node and reason (e.g. `{ B: { "transport close": 100 } }`). */
export function disconnectsByReason(
  events: readonly DisconnectEvent[],
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const { node, reason } of events) {
    const perNode = (counts[node] ??= {});
    perNode[reason] = (perNode[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * `--api-urls a[,b]`: one or two running API origins (http/https, no path). One origin serves as
 * both nodes. Returns null when absent; throws on anything else.
 */
export function parseApiUrls(value: string | undefined): [string, string] | null {
  if (value === undefined || value.trim() === "") return null;
  const urls = value.split(",").map((item) => item.trim());
  if (urls.length > 2) throw new Error("--api-urls takes one or two origins");
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--api-urls: not a URL: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search)
      throw new Error(`--api-urls: expected an http(s) origin without a path: ${url}`);
  }
  const [first, second] = urls.map((url) => new URL(url).origin) as [string, string?];
  return [first, second ?? first];
}

/** High-resolution wall clock (ms since the epoch). */
const now = () => performance.timeOrigin + performance.now();
/** Sleeps `ms` milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Socket ACK shape. */
interface Ack {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: unknown;
}

/** One connected benchmark client. */
interface Client {
  socket: Socket;
  offset: ClockEstimate;
  phases: Set<number>;
  latencies: number[];
  questions: Map<number, { id: string; options: { index: number; text: string }[] }>;
}

/** Connects a socket to `url` as one simulated device. */
async function connect(
  url: string,
  origin: string,
  address: string,
  token?: string,
): Promise<Socket> {
  const socket = io(`${url}/game`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: token ? { protocolVersion: 1, accessToken: token } : { protocolVersion: 1 },
    extraHeaders: { origin, "x-forwarded-for": address },
    reconnection: false,
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

/** Sends a command and returns its ACK and round-trip time. */
async function command(socket: Socket, event: string, fields: Record<string, unknown>) {
  const started = now();
  const ack = (await socket
    .timeout(15_000)
    .emitWithAck(event, { requestId: randomUUID(), ...fields })) as Ack;
  return { ack, rttMs: now() - started };
}

/** Three `room:time` samples (well inside the per-socket TIME limit) → clock estimate. */
async function calibrate(socket: Socket, room: { sessionId: string; pinCode: string }) {
  const samples: ClockSample[] = [];
  for (let index = 0; index < 3; index++) {
    const clientSentAt = now();
    const { ack } = await command(socket, "room:time", {
      ...room,
      clientSentAt: Math.round(clientSentAt),
    });
    const clientReceivedAt = now();
    const data = ack.data as { serverReceivedAt: number; serverSentAt: number } | undefined;
    if (ack.ok && data)
      samples.push({
        clientSentAt,
        serverReceivedAt: data.serverReceivedAt,
        serverSentAt: data.serverSentAt,
        clientReceivedAt,
      });
  }
  return estimateClock(samples);
}

/** Records phase versions and latencies of every push a socket receives. */
function record(
  client: Omit<Client, "offset"> & { offset: ClockEstimate | null },
  sessionId: string,
) {
  client.socket.onAny(
    (
      event: string,
      envelope?: {
        sessionId?: string;
        phaseVersion?: number;
        serverTime?: number;
        data?: Record<string, unknown>;
      },
    ) => {
      const receivedAt = now();
      if (
        !envelope ||
        envelope.sessionId !== sessionId ||
        typeof envelope.phaseVersion !== "number"
      )
        return;
      client.phases.add(envelope.phaseVersion);
      if (typeof envelope.serverTime === "number" && client.offset)
        client.latencies.push(
          transportLatency(envelope.serverTime, receivedAt, client.offset.offsetMs),
        );
      const question = envelope.data?.["question"] as
        | { questionIndex?: number; id?: string; options?: { index: number; text: string }[] }
        | undefined;
      if (
        event === "game:question_answering" &&
        question?.id &&
        typeof question.questionIndex === "number"
      )
        client.questions.set(question.questionIndex, {
          id: question.id,
          options: question.options ?? [],
        });
    },
  );
}

/** Engine and runtime versions for the record. */
async function engineVersions(env: Record<string, string>): Promise<Record<string, string>> {
  const versions: Record<string, string> = { node: process.version };
  if (env["REDIS_URL"]) {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(env["REDIS_URL"]);
    try {
      versions["redis"] = /redis_version:(\S+)/u.exec(await redis.info("server"))?.[1] ?? "unknown";
    } finally {
      redis.disconnect();
    }
  }
  return versions;
}

/**
 * Samples this process (the load generator) like the API probe does, so a busy harness can be
 * told apart from a busy server. `stop` returns the samples.
 */
function startSelfProbe(): { stop: () => ProbeSample[] } {
  const samples: ProbeSample[] = [];
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  // Same units as the API probe: delay beyond the 10 ms sampling resolution, in ms.
  const ms = (nanoseconds: number) => Math.max(0, Math.round((nanoseconds / 1e6 - 10) * 100) / 100);
  const timer = setInterval(() => {
    const at = process.hrtime.bigint();
    const cpu = process.cpuUsage(lastCpu);
    const elapsedUs = Number(at - lastAt) / 1000;
    samples.push({
      t: Date.now(),
      lagP50Ms: ms(histogram.percentile(50)),
      lagP99Ms: ms(histogram.percentile(99)),
      lagMaxMs: ms(histogram.max),
      cpuPercent: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0,
      heapMiB: Math.round((process.memoryUsage().heapUsed / 2 ** 20) * 10) / 10,
    });
    histogram.reset();
    lastCpu = process.cpuUsage();
    lastAt = at;
  }, 1000);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
      return samples;
    },
  };
}

/** An API node the benchmark talks to; `logs` is null for an external node (not measured). */
interface BenchNode {
  label: "A" | "B";
  url: string;
  logs: (() => string) | null;
}

/** Benchmark options (see the CLI usage). */
export interface BenchmarkOptions {
  clients: number;
  transitions: number;
  mode: "memory" | "redis";
  /** Running API origins to use instead of starting a local harness (`--api-urls`). */
  apiUrls?: [string, string] | null;
  /** Browser origin the API accepts (`--origin`); defaults to the test harness origin. */
  origin?: string;
  /** Existing CREATOR account on external nodes (`KN_BENCH_HOST_EMAIL`/`_PASSWORD`). */
  credentials?: { email: string; password: string };
}

/** Runs one benchmark; returns the JSON record. */
export async function runBenchmark(options: BenchmarkOptions) {
  const { PASSWORD, startScaledApis, startSingleApi, quizWith } =
    await import("../tests/helpers/game");
  const { TEST_ORIGIN, httpClient } = await import("../tests/helpers/runtime");
  const origin = options.origin ?? TEST_ORIGIN;
  const credentials = options.credentials ?? { email: "host@example.org", password: PASSWORD };
  const started = Date.now();
  const cluster = options.apiUrls
    ? await (async () => {
        const [first, second] = options.apiUrls as [string, string];
        const direct = httpClient(`${first}/api/v1`);
        const call: typeof direct = (route, request = {}) =>
          direct(route, { ...request, headers: { Origin: origin, ...request.headers } });
        const login = await call("/auth/login", {
          method: "POST",
          ip: "10.200.0.9",
          body: credentials,
        });
        const host = (login.json as { accessToken?: string } | null)?.accessToken;
        if (login.status !== 200 || !host)
          throw new Error(`host sign-in on ${first} failed with HTTP ${login.status}`);
        const nodeA: BenchNode = { label: "A", url: first, logs: null };
        const nodeB: BenchNode = second === first ? nodeA : { label: "B", url: second, logs: null };
        return {
          nodes: [nodeA, nodeB] as const,
          env: {} as Record<string, string>,
          call,
          host,
          drivers: `external API node(s) ${[...new Set([first, second])].join(", ")} (not measured)`,
          stop: async () => undefined,
        };
      })()
    : await (async () => {
        // Each local API node loads the event-loop probe (TASK-184); startApi passes this
        // process's environment to its children. Restored once the nodes are up.
        const probe = path.resolve("scripts", "lib", "event-loop-probe.cjs");
        const previous = process.env["NODE_OPTIONS"];
        process.env["NODE_OPTIONS"] = [previous, `--require ${JSON.stringify(probe)}`]
          .filter(Boolean)
          .join(" ");
        try {
          if (options.mode === "redis") {
            const scaled = await startScaledApis("postgres");
            const [a, b] = scaled.nodes;
            return {
              nodes: [
                { label: "A", url: a.url, logs: a.logs },
                { label: "B", url: b.url, logs: b.logs },
              ] as const satisfies readonly BenchNode[],
              env: scaled.env,
              call: scaled.call,
              host: scaled.host,
              drivers: "postgres + redis, 2 API nodes, local shared uploads",
              stop: async () => {
                await a.stop();
                await b.stop();
                await scaled.runtime.cleanup();
              },
            };
          }
          const single = await startSingleApi("sqlite", "memory");
          const node: BenchNode = { label: "A", url: single.api.url, logs: single.api.logs };
          return {
            nodes: [node, node] as const,
            env: single.env,
            call: single.call,
            host: single.host,
            drivers: "sqlite + memory state, 1 API node",
            stop: async () => {
              await single.api.stop();
              await single.runtime.cleanup();
            },
          };
        } finally {
          if (previous === undefined) delete process.env["NODE_OPTIONS"];
          else process.env["NODE_OPTIONS"] = previous;
        }
      })();
  const sockets: Socket[] = [];
  try {
    const questions = Math.ceil(options.transitions / 4) + 1;
    const quiz = await quizWith(
      cluster.call,
      cluster.host,
      "Benchmark",
      Array.from({ length: questions }, (_, index) => ({
        type: "SINGLE_CHOICE" as const,
        prompt: `Soal ${index + 1}?`,
        options: [["Benar", true], ["Salah"]] as [string, boolean?][],
        timeLimitSec: 30 as const,
      })),
    );
    const [nodeA, nodeB] = cluster.nodes;
    const host = await connect(nodeA.url, origin, "10.200.0.1", cluster.host);
    sockets.push(host);
    const created = await command(host, "host:create_room", {
      quizId: quiz.id,
      quizRevision: quiz.revision,
      displayMode: "PROJECTOR",
      friendlyNicknames: false,
    });
    if (!created.ack.ok)
      throw new Error(`create_room failed: ${JSON.stringify(created.ack.error)}`);
    const room = {
      sessionId: String(created.ack.data?.["sessionId"]),
      pinCode: String(created.ack.data?.["pinCode"]),
    };
    let phaseVersion = Number(created.ack.data?.["phaseVersion"] ?? 1);
    /** Question indexes the host has seen revealed. */
    const revealed = new Set<number>();
    host.onAny(
      (
        event: string,
        envelope?: { phaseVersion?: number; data?: { reveal?: { questionIndex?: number } } },
      ) => {
        if (typeof envelope?.phaseVersion === "number")
          phaseVersion = Math.max(phaseVersion, envelope.phaseVersion);
        const index = envelope?.data?.reveal?.questionIndex;
        if (event === "game:answer_reveal" && typeof index === "number") revealed.add(index);
      },
    );

    /** Player disconnects during the measured run (each one is a failure). */
    const disconnects: string[] = [];
    const disconnectEvents: DisconnectEvent[] = [];
    const clientsPerNode = new Map<BenchNode, number>();
    let finished = false;
    // Players join in batches from distinct addresses (each device has its own join budget).
    const clients: Client[] = [];
    for (let batch = 0; batch < options.clients; batch += 20) {
      await Promise.all(
        Array.from({ length: Math.min(20, options.clients - batch) }, async (_, offset) => {
          const index = batch + offset;
          const node = index % 2 === 0 ? nodeA : nodeB;
          clientsPerNode.set(node, (clientsPerNode.get(node) ?? 0) + 1);
          const socket = await connect(
            node.url,
            origin,
            `10.201.${Math.floor(index / 200)}.${(index % 200) + 1}`,
          );
          sockets.push(socket);
          const joined = await command(socket, "player:join_room", {
            pinCode: room.pinCode,
            nickname: `Bench${index}`,
            avatar: { style: "bottts", seed: `b${index}` },
          });
          if (!joined.ack.ok)
            throw new Error(`join ${index} failed: ${JSON.stringify(joined.ack.error)}`);
          socket.on("disconnect", (reason: string) => {
            if (finished) return;
            disconnects.push(`client ${index}: ${reason}`);
            disconnectEvents.push({ node: node.label, reason, atMs: Date.now() - started });
          });
          const client = {
            socket,
            offset: null as ClockEstimate | null,
            phases: new Set<number>(),
            latencies: [] as number[],
            questions: new Map(),
          };
          record(client, room.sessionId);
          client.offset = await calibrate(socket, room);
          clients.push(client as Client);
        }),
      );
    }

    const admission: number[] = [];
    const stateLatency: number[] = [];
    const expectedPhases: number[] = [];
    const refusals: string[] = [];
    /** Sends a host phase command with the latest phase version, retrying on a stale one. */
    const step = async (event: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let result: Awaited<ReturnType<typeof command>>;
        try {
          result = await command(host, event, { ...room, expectedPhaseVersion: phaseVersion });
        } catch (error) {
          // No ACK within the timeout (or the connection dropped): an observed failure, retried.
          refusals.push(`${event}: no ACK (${error instanceof Error ? error.message : "error"})`);
          await sleep(300);
          continue;
        }
        if (result.ack.ok) {
          stateLatency.push(result.rttMs);
          phaseVersion = Number(result.ack.data?.["phaseVersion"] ?? phaseVersion);
          return;
        }
        refusals.push(`${event}: ${JSON.stringify(result.ack.error)}`);
        // A long run outlives the 15-minute access token: renew it like the web client does
        // (sign in again, then `auth:update` on the same socket) and retry.
        if (
          (result.ack.error as { errorCode?: string } | undefined)?.errorCode === "TOKEN_EXPIRED"
        ) {
          const login = await cluster.call("/auth/login", {
            method: "POST",
            ip: "10.200.0.9",
            body: credentials,
          });
          const accessToken = (login.json as { accessToken?: string } | null)?.accessToken;
          if (accessToken) {
            cluster.host = accessToken;
            await command(host, "auth:update", { accessToken });
          }
        }
        await sleep(300);
      }
      throw new Error(`${event} refused: ${refusals.slice(-1).join("")}`);
    };
    let rejectedAnswers = 0;
    let unclosed = 0;
    const benchmarkStart = Date.now();
    const selfProbe = startSelfProbe();
    const startVersion = phaseVersion;
    /**
     * Set when a host command still fails after its retries. The run then stops early but still
     * ends the game and writes its record with the failure, instead of losing every measurement.
     */
    let abortReason: string | null = null;
    let transitions = 0;
    try {
      await step("host:start_game");
      for (
        let question = 0;
        transitions < options.transitions && question < questions - 1;
        question++
      ) {
        // Wait for the server's preview → answering transition.
        const deadline = Date.now() + 20_000;
        while (clients.some((client) => !client.questions.has(question)) && Date.now() < deadline)
          await sleep(20);
        await Promise.all(
          clients.map(async (client) => {
            const open = client.questions.get(question);
            if (!open) return;
            await sleep(Math.random() * 1500);
            try {
              const answered = await command(client.socket, "player:submit_answer", {
                ...room,
                questionIndex: question,
                questionId: open.id,
                submissionId: randomUUID(),
                answer: open.options[0]?.index ?? 0,
              });
              if (answered.ack.ok) admission.push(answered.rttMs);
              else rejectedAnswers++;
            } catch {
              // No ACK (timeout or dropped connection): an observed failure, kept in the record.
              rejectedAnswers++;
            }
          }),
        );
        // The question closes once every answer is admitted. If any answer was not admitted (it
        // then stays a failure in the admission count), the host skips the remaining time instead.
        const closing = Date.now() + 30_000;
        while (!revealed.has(question) && Date.now() < closing) await sleep(20);
        if (!revealed.has(question)) {
          unclosed++;
          await step("host:skip_timer");
        }
        await sleep(2_100);
        await step("host:next_step"); // reveal → leaderboard
        await sleep(2_100);
        await step("host:next_step"); // leaderboard → next question (preview)
        transitions += 4;
      }
    } catch (error) {
      abortReason = error instanceof Error ? error.message : String(error);
    }
    // Finish: skip through the last question to the podium; the server finishes the game.
    await sleep(2_100);
    const endVersion = phaseVersion;
    try {
      await step("host:end_game");
    } catch (error) {
      abortReason ??= error instanceof Error ? error.message : String(error);
    }
    const ended = Date.now();
    for (let version = startVersion + 1; version <= endVersion; version++)
      expectedPhases.push(version);

    // Report queue age: end → durable report.
    let reportReadyMs: number | null = null;
    while (Date.now() - ended < 120_000) {
      const status = (
        await cluster.call(`/reports/${room.sessionId}/status`, { token: cluster.host })
      ).json as { status?: string } | null;
      if (status?.status === "ready") {
        reportReadyMs = Date.now() - ended;
        break;
      }
      await sleep(100);
    }

    finished = true;
    const finishedAt = Date.now();
    const loadGenerator = summarizeProbe(selfProbe.stop());
    const byReason = disconnectsByReason(disconnectEvents);
    const nodes = [...new Set(cluster.nodes)].map((node) => ({
      node: node.label,
      url: node.url,
      clients: clientsPerNode.get(node) ?? 0,
      measured: node.logs !== null,
      process: node.logs
        ? summarizeProbe(parseProbeLines(node.logs(), benchmarkStart, finishedAt))
        : null,
      disconnects: byReason[node.label] ?? {},
    }));
    const transport = summarize(clients.flatMap((client) => client.latencies));
    const loss = deliveryLoss(
      expectedPhases,
      clients.map((client) => client.phases),
    );
    const clock = summarize(clients.map((client) => client.offset.errorBoundMs));
    const result = verdict(transport, loss.ratio, disconnects.length, {
      rejectedAnswers,
      reportReady: reportReadyMs !== null,
      abortReason,
    });
    return {
      mode: options.mode,
      recordedAt: new Date(started).toISOString(),
      durationMs: Date.now() - benchmarkStart,
      clients: clients.length,
      transitionsRequested: options.transitions,
      phaseTransitionsObserved: expectedPhases.length,
      environment: {
        cpu: os.cpus()[0]?.model ?? "unknown",
        cores: os.cpus().length,
        memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
        loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        drivers: cluster.drivers,
        versions: await engineVersions(cluster.env),
        network: options.apiUrls
          ? "load generator to external API node(s); describe the network path with the record"
          : "loopback on one host (controlled baseline; no NIC, Wi-Fi or WAN)",
      },
      clockErrorBoundMs: clock,
      transportLatencyMs: transport,
      admissionLatencyMs: summarize(admission),
      stateCommitLatencyMs: summarize(stateLatency),
      delivery: loss,
      reportQueueAgeMs: reportReadyMs,
      answersWritten: admission.length,
      answersRejected: rejectedAnswers,
      disconnects,
      disconnectsFirstAtMs: disconnectEvents[0]?.atMs ?? null,
      questionsClosedBySkip: unclosed,
      abortReason,
      hostCommandFailures: refusals,
      diagnostics: { nodes, loadGenerator },
      target: { p95Ms: P95_TARGET_MS, ...result },
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
    await cluster.stop();
  }
}

/** Markdown summary of one record. */
export function markdownSummary(record: Awaited<ReturnType<typeof runBenchmark>>): string {
  const row = (label: string, s: LatencySummary) =>
    `| ${label} | ${s.count} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} |`;
  return [
    `### ${record.mode} (${record.environment.drivers})`,
    "",
    `- ${record.clients} clients, ${record.phaseTransitionsObserved} phase transitions, ${Math.round(record.durationMs / 1000)} s, ${record.environment.network}`,
    `- ${record.environment.cpu}, ${record.environment.cores} cores, ${record.environment.memoryGiB} GiB, ${record.environment.platform}, versions ${JSON.stringify(record.environment.versions)}`,
    `- Clock error bound p95 ${record.clockErrorBoundMs.p95} ms; delivery loss ${record.delivery.missing}/${record.delivery.expected}; report queue age ${record.reportQueueAgeMs ?? "not ready"} ms for ${record.answersWritten} answers (${record.answersRejected} rejected; ${record.questionsClosedBySkip} questions closed by Skip; ${record.disconnects.length} player disconnects${record.disconnects.length ? `: ${[...new Set(record.disconnects.map((item) => item.split(": ")[1]))].join(", ")}` : ""})`,
    `- Target p95 < ${record.target.p95Ms} ms: **${record.target.pass ? "PASS" : `FAIL (${record.target.reasons.join("; ")})`}**`,
    "",
    "| Measure (ms) | n | p50 | p95 | p99 | max |",
    "| --- | --- | --- | --- | --- | --- |",
    row("Transport (commit → receipt)", record.transportLatencyMs),
    row("Admission (answer ACK RTT)", record.admissionLatencyMs),
    row("State commit (host ACK RTT)", record.stateCommitLatencyMs),
    "",
    ...diagnosticsTable(record),
    "",
  ].join("\n");
}

/** Per-process table: each API node and the load generator (TASK-184). */
function diagnosticsTable(record: Awaited<ReturnType<typeof runBenchmark>>): string[] {
  const cells = (process: ProcessDiagnostics | null) =>
    process
      ? `${process.lagP99Ms.p50} / ${process.lagP99Ms.max} | ${process.lagMaxMs} | ${process.cpuPercentMean} / ${process.cpuPercentMax} | ${process.heapMaxMiB}`
      : "not measured | not measured | not measured | not measured";
  const reasons = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ") || "0";
  return [
    "| Process | Clients | Loop lag p99 per 1 s, median / max (ms) | Max loop lag (ms) | CPU mean / max (% of one core) | Heap max (MiB) | Disconnects |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...record.diagnostics.nodes.map(
      (node) =>
        `| API node ${node.node} | ${node.clients} | ${cells(node.process)} | ${reasons(node.disconnects)} |`,
    ),
    `| Load generator | ${record.clients} | ${cells(record.diagnostics.loadGenerator)} | — |`,
    ...(record.disconnectsFirstAtMs === null
      ? []
      : ["", `First disconnect ${Math.round(record.disconnectsFirstAtMs / 1000)} s after start.`]),
  ];
}

/** CLI entry. */
async function main() {
  const { values } = parseArgs({
    options: {
      clients: { type: "string", default: "200" },
      transitions: { type: "string", default: "100" },
      mode: { type: "string", default: "memory" },
      out: { type: "string" },
      "api-urls": { type: "string" },
      origin: { type: "string" },
    },
  });
  const clients = Number(values.clients);
  const transitions = Number(values.transitions);
  const mode = values.mode === "redis" ? "redis" : values.mode === "memory" ? "memory" : null;
  if (
    !mode ||
    !Number.isInteger(clients) ||
    clients < 1 ||
    clients > 200 ||
    !Number.isInteger(transitions) ||
    transitions < 4
  )
    throw new Error(
      "usage: --clients 1..200 --transitions ≥4 --mode memory|redis [--api-urls a[,b] --origin url] (more than 200 clients needs a separate harness)",
    );
  const apiUrls = parseApiUrls(values["api-urls"]);
  const email = process.env["KN_BENCH_HOST_EMAIL"];
  const password = process.env["KN_BENCH_HOST_PASSWORD"];
  if (apiUrls && (!email || !password))
    throw new Error(
      "--api-urls needs KN_BENCH_HOST_EMAIL and KN_BENCH_HOST_PASSWORD (an existing CREATOR account)",
    );
  const record = await runBenchmark({
    clients,
    transitions,
    mode,
    apiUrls,
    ...(values.origin ? { origin: values.origin } : {}),
    ...(apiUrls && email && password ? { credentials: { email, password } } : {}),
  });
  const out = path.resolve(values.out ?? path.join("test-results", "benchmark", `${mode}.json`));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${markdownSummary(record)}\nRecord: ${out}\n`);
  if (!record.target.pass) process.exitCode = 1;
}

if (typeof require !== "undefined" && require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
