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

/** Pass/fail verdict: p95 under the target, nothing lost and no player connection dropped. */
export function verdict(transport: LatencySummary, lossRatio: number, disconnects = 0) {
  const reasons: string[] = [];
  if (disconnects > 0) reasons.push(`${disconnects} player connection(s) dropped`);
  if (transport.count === 0) reasons.push("no transport samples");
  if (transport.p95 >= P95_TARGET_MS)
    reasons.push(`transport p95 ${transport.p95} ms ≥ ${P95_TARGET_MS} ms`);
  if (lossRatio > 0) reasons.push(`delivery loss ${(lossRatio * 100).toFixed(3)}%`);
  return { pass: reasons.length === 0, reasons };
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

/** Runs one benchmark; returns the JSON record. */
export async function runBenchmark(options: {
  clients: number;
  transitions: number;
  mode: "memory" | "redis";
}) {
  const { PASSWORD, startScaledApis, startSingleApi, quizWith } =
    await import("../tests/helpers/game");
  const { TEST_ORIGIN } = await import("../tests/helpers/runtime");
  const started = Date.now();
  const cluster =
    options.mode === "redis"
      ? await startScaledApis("postgres")
      : await (async () => {
          const single = await startSingleApi("sqlite", "memory");
          return {
            runtime: single.runtime,
            nodes: [single.api, single.api] as const,
            env: single.env,
            call: single.call,
            host: single.host,
          };
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
    const host = await connect(nodeA.url, TEST_ORIGIN, "10.200.0.1", cluster.host);
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
    let finished = false;
    // Players join in batches from distinct addresses (each device has its own join budget).
    const clients: Client[] = [];
    for (let batch = 0; batch < options.clients; batch += 20) {
      await Promise.all(
        Array.from({ length: Math.min(20, options.clients - batch) }, async (_, offset) => {
          const index = batch + offset;
          const node = index % 2 === 0 ? nodeA : nodeB;
          const socket = await connect(
            node.url,
            TEST_ORIGIN,
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
            if (!finished) disconnects.push(`client ${index}: ${reason}`);
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
        const result = await command(host, event, { ...room, expectedPhaseVersion: phaseVersion });
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
            body: { email: "host@example.org", password: PASSWORD },
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
    const startVersion = phaseVersion;
    await step("host:start_game");
    let transitions = 0;
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
    // Finish: skip through the last question to the podium; the server finishes the game.
    await sleep(2_100);
    const endVersion = phaseVersion;
    await step("host:end_game");
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
    const transport = summarize(clients.flatMap((client) => client.latencies));
    const loss = deliveryLoss(
      expectedPhases,
      clients.map((client) => client.phases),
    );
    const clock = summarize(clients.map((client) => client.offset.errorBoundMs));
    const result = verdict(transport, loss.ratio, disconnects.length);
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
        drivers:
          options.mode === "redis"
            ? "postgres + redis, 2 API nodes, local shared uploads"
            : "sqlite + memory state, 1 API node",
        versions: await engineVersions(cluster.env),
        network: "loopback on one host (controlled baseline; no NIC, Wi-Fi or WAN)",
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
      questionsClosedBySkip: unclosed,
      target: { p95Ms: P95_TARGET_MS, ...result },
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (options.mode === "redis") {
      await cluster.nodes[0].stop();
      await cluster.nodes[1].stop();
    } else await cluster.nodes[0].stop();
    await cluster.runtime.cleanup();
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
  ].join("\n");
}

/** CLI entry. */
async function main() {
  const { values } = parseArgs({
    options: {
      clients: { type: "string", default: "200" },
      transitions: { type: "string", default: "100" },
      mode: { type: "string", default: "memory" },
      out: { type: "string" },
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
      "usage: --clients 1..200 --transitions ≥4 --mode memory|redis (more than 200 clients needs a separate harness)",
    );
  const record = await runBenchmark({ clients, transitions, mode });
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
