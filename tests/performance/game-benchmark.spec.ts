/**
 * TASK-179 unit tests of the game benchmark's measuring tools (scripts/benchmark-game.ts): clock
 * calibration, latency correction, percentiles, delivery loss and the pass/fail verdict. The
 * benchmark's numbers are only as good as these.
 */
import { describe, expect, it } from "vitest";
import {
  P95_TARGET_MS,
  deliveryLoss,
  estimateClock,
  percentile,
  summarize,
  transportLatency,
  verdict,
  type ClockSample,
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
});
