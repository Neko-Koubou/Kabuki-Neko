/**
 * TASK-179 unit tests of the game benchmark's measuring tools (scripts/benchmark-game.ts): clock
 * calibration, latency correction, percentiles, delivery loss, the pass/fail verdict and the
 * per-process diagnostics (TASK-184: probe parsing, aggregation, disconnect reasons, external
 * origins). The benchmark's numbers are only as good as these.
 */
import { describe, expect, it } from "vitest";
import {
  P95_TARGET_MS,
  PROBE_PREFIX,
  deliveryLoss,
  disconnectsByReason,
  estimateClock,
  parseApiUrls,
  parseProbeLines,
  percentile,
  summarize,
  summarizeProbe,
  transportLatency,
  verdict,
  type ClockSample,
  type ProbeSample,
} from "../../scripts/benchmark-game";

/** A sample for a client whose clock is `skew` ms behind the server, with symmetric paths. */
function sample(sentAt: number, oneWay: number, processing: number, skew: number): ClockSample {
  const serverReceivedAt = sentAt + skew + oneWay;
  const serverSentAt = serverReceivedAt + processing;
  return {
    clientSentAt: sentAt,
    serverReceivedAt,
    serverSentAt,
    clientReceivedAt: serverSentAt - skew + oneWay,
  };
}

describe("clock calibration", () => {
  it("recovers the offset exactly for symmetric paths and excludes server processing from the RTT", () => {
    const estimate = estimateClock([sample(1_000, 4, 3, 250)]);
    expect(estimate.offsetMs).toBe(250);
    expect(estimate.rttMs).toBe(8);
    expect(estimate.errorBoundMs).toBe(4);
  });

  it("prefers the lowest-RTT sample and bounds the error by half of it", () => {
    const estimate = estimateClock([
      sample(0, 40, 1, -120),
      sample(100, 2, 1, -120),
      sample(200, 15, 1, -120),
    ]);
    expect(estimate.offsetMs).toBe(-120);
    expect(estimate.rttMs).toBe(4);
    expect(estimate.errorBoundMs).toBe(2);
  });

  it("keeps the true offset within the error bound for asymmetric paths", () => {
    // Uplink 1 ms, downlink 9 ms: the midpoint estimate is off by (9 − 1) / 2 = 4 ms ≤ RTT / 2.
    const skew = 30;
    const t0 = 0;
    const t1 = t0 + skew + 1;
    const t2 = t1;
    const t3 = t2 - skew + 9;
    const estimate = estimateClock([
      { clientSentAt: t0, serverReceivedAt: t1, serverSentAt: t2, clientReceivedAt: t3 },
    ]);
    expect(Math.abs(estimate.offsetMs - skew)).toBeLessThanOrEqual(estimate.errorBoundMs);
  });

  it("refuses to estimate without samples", () => {
    expect(() => estimateClock([])).toThrow("no clock samples");
  });
});

describe("latency correction", () => {
  it("converts the client receipt to server time before subtracting the commit timestamp", () => {
    // Server commits at 10_000; the client (250 ms behind) receives at 9_762 local = 10_012 server.
    expect(transportLatency(10_000, 9_762, 250)).toBe(12);
    expect(transportLatency(10_000, 10_012, 0)).toBe(12);
  });
});

describe("statistics", () => {
  it("uses nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(() => percentile([], 50)).toThrow("no values");
    expect(() => percentile([1], 101)).toThrow("percentile out of range");
  });

  it("summarizes without mutating the input and reports an empty sample as zero counts", () => {
    const values = [5, 1, 9, 3];
    expect(summarize(values)).toEqual({
      count: 4,
      min: 1,
      p50: 3,
      p95: 9,
      p99: 9,
      max: 9,
      mean: 4.5,
    });
    expect(values).toEqual([5, 1, 9, 3]);
    expect(summarize([]).count).toBe(0);
  });

  it("counts every missing (client, phase) observation as loss", () => {
    const phases = [2, 3, 4, 5];
    const complete = deliveryLoss(phases, [new Set(phases), new Set(phases)]);
    expect(complete).toEqual({ expected: 8, missing: 0, ratio: 0 });
    const partial = deliveryLoss(phases, [new Set([2, 3, 4, 5]), new Set([2, 4])]);
    expect(partial).toEqual({ expected: 8, missing: 2, ratio: 0.25 });
  });
});

describe("verdict", () => {
  const summary = (p95: number) => ({
    count: 100,
    min: 1,
    p50: 5,
    p95,
    p99: p95 + 1,
    max: p95 + 2,
    mean: 6,
  });

  it("passes only below the target with nothing lost", () => {
    expect(verdict(summary(P95_TARGET_MS - 0.01), 0)).toEqual({ pass: true, reasons: [] });
  });

  it("keeps every observed failure as a failure", () => {
    expect(verdict(summary(P95_TARGET_MS), 0).pass).toBe(false);
    expect(verdict(summary(10), 0.001).reasons).toEqual(["delivery loss 0.100%"]);
    expect(verdict({ ...summary(0), count: 0 }, 0).reasons).toContain("no transport samples");
    expect(verdict(summary(10), 0, 2).reasons).toEqual(["2 player connection(s) dropped"]);
  });

  it("fails on answers that were not admitted and on a report that never became durable (MN-43)", () => {
    expect(verdict(summary(10), 0, 0, { rejectedAnswers: 0, reportReady: true })).toEqual({
      pass: true,
      reasons: [],
    });
    expect(verdict(summary(10), 0, 0, { rejectedAnswers: 13 }).reasons).toEqual([
      "13 answer(s) not admitted",
    ]);
    expect(verdict(summary(10), 0, 0, { reportReady: false }).reasons).toEqual([
      "report not durable",
    ]);
  });
});

describe("per-process diagnostics (TASK-184)", () => {
  const sample = (t: number, lagP99Ms: number, cpuPercent: number): ProbeSample => ({
    t,
    lagP50Ms: lagP99Ms / 2,
    lagP99Ms,
    lagMaxMs: lagP99Ms * 2,
    cpuPercent,
    heapMiB: 50 + t / 1000,
  });

  it("parses probe lines among other output, inside the measured window only", () => {
    const output = [
      "[Nest] 123 LOG Application started",
      `${PROBE_PREFIX}${JSON.stringify(sample(1_000, 4, 20))}`,
      `${PROBE_PREFIX}{not json`,
      `${PROBE_PREFIX}${JSON.stringify({ t: 2_000, lagP99Ms: "slow" })}`,
      `prefix ${PROBE_PREFIX}${JSON.stringify(sample(3_000, 8, 90))}\r`,
      `${PROBE_PREFIX}${JSON.stringify(sample(9_000, 1, 5))}`,
    ].join("\n");
    expect(parseProbeLines(output)).toEqual([
      sample(1_000, 4, 20),
      sample(3_000, 8, 90),
      sample(9_000, 1, 5),
    ]);
    expect(parseProbeLines(output, 2_000, 5_000)).toEqual([sample(3_000, 8, 90)]);
  });

  it("aggregates lag, CPU and heap per process, and reports an unmeasured one as null", () => {
    expect(summarizeProbe([])).toBeNull();
    const diagnostics = summarizeProbe([
      sample(1_000, 2, 40),
      sample(2_000, 30, 100),
      sample(3_000, 4, 70),
    ]);
    expect(diagnostics).toMatchObject({
      samples: 3,
      lagP99Ms: { count: 3, p50: 4, max: 30 },
      lagMaxMs: 60,
      cpuPercentMean: 70,
      cpuPercentMax: 100,
      heapMaxMiB: 53,
    });
  });

  it("counts dropped connections per node and reason", () => {
    expect(
      disconnectsByReason([
        { node: "B", reason: "transport close", atMs: 10 },
        { node: "B", reason: "transport close", atMs: 11 },
        { node: "B", reason: "ping timeout", atMs: 12 },
        { node: "A", reason: "transport close", atMs: 13 },
      ]),
    ).toEqual({ B: { "transport close": 2, "ping timeout": 1 }, A: { "transport close": 1 } });
    expect(disconnectsByReason([])).toEqual({});
  });

  it("accepts one or two external API origins and rejects anything else", () => {
    expect(parseApiUrls(undefined)).toBeNull();
    expect(parseApiUrls(" ")).toBeNull();
    expect(parseApiUrls("http://10.0.0.5:3001")).toEqual([
      "http://10.0.0.5:3001",
      "http://10.0.0.5:3001",
    ]);
    expect(parseApiUrls("https://a.example.org/, https://b.example.org")).toEqual([
      "https://a.example.org",
      "https://b.example.org",
    ]);
    expect(() => parseApiUrls("a,b,c")).toThrow("one or two");
    expect(() => parseApiUrls("not a url")).toThrow("not a URL");
    expect(() => parseApiUrls("ftp://a.example.org")).toThrow("origin");
    expect(() => parseApiUrls("http://a.example.org/api/v1")).toThrow("origin");
  });
});
