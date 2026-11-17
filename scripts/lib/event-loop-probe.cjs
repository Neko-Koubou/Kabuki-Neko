/**
 * Event-loop and CPU probe for API nodes started by `scripts/benchmark-game.ts` (TASK-184).
 *
 * Loaded only through `NODE_OPTIONS=--require <this file>` in the benchmark's own child
 * processes; production images never load it. Every second it writes one line to stdout:
 *
 *   KN_PROBE {"t":…,"lagP50Ms":…,"lagP99Ms":…,"lagMaxMs":…,"cpuPercent":…,"heapMiB":…}
 *
 * - lag*: `perf_hooks.monitorEventLoopDelay` over the last interval, reset after each line. The
 *   histogram's 10 ms sampling resolution is subtracted, so an idle loop reads about 0;
 * - cpuPercent: user + system CPU time of this process over the interval, as a percentage of one
 *   core (above 100 means more than one core);
 * - heapMiB: V8 heap in use.
 * The timer is unref'd, so the probe never keeps a process alive.
 */
"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");
const { setInterval } = require("node:timers");

const INTERVAL_MS = 1000;
const RESOLUTION_MS = 10;
const PREFIX = "KN_PROBE ";
const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
histogram.enable();
let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();

/** Event-loop delay beyond the sampling resolution, nanoseconds to milliseconds (0.01). */
function ms(nanoseconds) {
  return Math.max(0, Math.round((nanoseconds / 1e6 - RESOLUTION_MS) * 100) / 100);
}

const timer = setInterval(() => {
  const at = process.hrtime.bigint();
  const cpu = process.cpuUsage(lastCpu);
  const elapsedUs = Number(at - lastAt) / 1000;
  const sample = {
    t: Date.now(),
    lagP50Ms: ms(histogram.percentile(50)),
    lagP99Ms: ms(histogram.percentile(99)),
    lagMaxMs: ms(histogram.max),
    cpuPercent: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0,
    heapMiB: Math.round((process.memoryUsage().heapUsed / 2 ** 20) * 10) / 10,
  };
  histogram.reset();
  lastCpu = process.cpuUsage();
  lastAt = at;
  process.stdout.write(`${PREFIX}${JSON.stringify(sample)}\n`);
}, INTERVAL_MS);
timer.unref();
