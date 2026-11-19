# Performance results: game broadcast and report load

Recorded results of `pnpm benchmark:game` (scripts/benchmark-game.ts; SA §11.2; US-16, US-20).

**Target:** broadcast p95 < 50 ms with 200 clients in one room, on a controlled network.

Results are reported as measured. A missed target stays a failure, and nothing here is
extrapolated beyond what was run.

## Method

- **Harness.** An isolated harness starts the built API with:
  - memory mode: one process, SQLite, in-memory state;
  - redis mode: two processes, PostgreSQL 16 and Redis 7 in containers. The host is on node A
    and the players alternate between nodes A and B, so half of the broadcasts cross nodes.
- **Load.**
  - A single-choice quiz.
  - Every player is a separate simulated device with its own client address, so the
    production join, answer and time limits apply unchanged.
  - Per question:
    1. preview, then answering, entered by the server;
    2. all players answer within 0–1.5 s, which closes the question;
    3. the host sends Next twice, paced under the 30/min host limit.

    That is four transitions per question, until at least 100 transitions.
- **Transport latency.** From the push's `serverTime` (taken when the state change is committed
  and enqueued) to client receipt. Each client clock is corrected with its NTP-style `room:time`
  offset (lowest-RTT sample of three), with error bound RTT/2.
- **Admission.** The answer ACK round trip, measured separately.
- **State commit.** The host command ACK round trip.
- **Delivery.** Every player must observe every phase version.
- **Report queue age.** From the end of the game to a durable report, with all answers written.
- **Verified tooling.** `pnpm test:performance -- tests/performance/game-benchmark.spec.ts`
  covers the clock calibration, the latency correction, the percentiles, the delivery loss and
  the verdict.

## Environment (all runs)

| Item    | Value                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| Date    | 2026-11-11                                                                                                        |
| Host    | Intel Xeon @ 2.10 GHz, 4 cores, 15.7 GiB RAM, Linux 6.18 x64 (a shared CI-class VM)                               |
| Runtime | Node.js v26.13.0; PostgreSQL 16.15 and Redis 7.4.12 (containers) in redis mode                                    |
| Network | Loopback on one host: no NIC, Wi-Fi or WAN. The clients, both API nodes and the databases share the same 4 cores. |
| Clients | All simulated in one Node.js process                                                                              |

Loopback on one host is a controlled baseline, not a real LAN. It also puts the load generator
and the servers on the same CPUs, so CPU contention affects every number below.

## Results

### Memory mode, one API node, 200 clients: **PASS**

102 phase transitions in 406 s. Delivery loss 0 of 20,400 (client, phase) observations; no
player disconnects were observed (every client received every phase). Clock error bound p95
17.1 ms.

| Measure (ms)                 | n      | p50      | p95       | p99       | max       |
| ---------------------------- | ------ | -------- | --------- | --------- | --------- |
| Transport (commit → receipt) | 52,127 | 4.37     | **18.97** | 27.73     | 33.79     |
| Admission (answer ACK RTT)   | 5,000  | 2,014.30 | 8,333.17  | 10,422.20 | 13,263.19 |
| State commit (host ACK RTT)  | 52     | 67.52    | 149.73    | 791.56    | 791.56    |

Report queue age: 976 ms for 5,000 answers of 200 players (0 rejected).

### Redis mode, two API nodes, 200 clients: **FAIL**

102 phase transitions in 1,041 s.

- **Node B dropped all 100 of its players** mid-run (`transport close`, every odd-numbered
  client). The 100 players on node A stayed connected.
- Delivery loss 5,900 of 20,400 (28.9%).
- 2,512 answers rejected (dropped connections and timeouts); 1,088 admitted.
- Clock error bound p95 30.3 ms.

| Measure (ms)                 | n       | p50      | p95        | p99       | max       |
| ---------------------------- | ------- | -------- | ---------- | --------- | --------- |
| Transport (commit → receipt) | 101,084 | 16.49    | **310.45** | 531.65    | 1,494.14  |
| Admission (answer ACK RTT)   | 1,088   | 6,933.49 | 9,364.21   | 10,058.23 | 10,797.81 |
| State commit (host ACK RTT)  | 52      | 781.13   | 1,538.89   | 4,292.08  | 4,292.08  |

Report queue age: 1,789 ms.

### Redis mode, two API nodes, 60 clients (characterization): **FAIL**

102 phase transitions in 461 s. Delivery loss 0 of 6,120, no disconnects, 39 answers rejected.

| Measure (ms)                 | n      | p50      | p95        | p99      | max      |
| ---------------------------- | ------ | -------- | ---------- | -------- | -------- |
| Transport (commit → receipt) | 24,043 | 9.73     | **180.78** | 286.89   | 583.19   |
| Admission (answer ACK RTT)   | 1,461  | 3,520.05 | 7,180.12   | 7,934.46 | 8,437.58 |
| State commit (host ACK RTT)  | 52     | 213.16   | 677.12     | 954.53   | 954.53   |

Report queue age: 830 ms.

## Findings

1. **The broadcast target is met only by a single node with memory state.** The multi-node Redis
   topology misses the 50 ms p95 target at 60 and at 200 clients on this host. At 200 clients it
   also lost every connection on one node. Do not advertise 200-player multi-node rooms as
   verified.
2. **Answer admission is slow under a burst.** When all players answer within about 1.5 s,
   answer ACKs take seconds (memory p50 2.0 s; Redis p50 3.5–6.9 s), even where broadcast
   latency is low. The likely cause, from the code path:
   - every admitted answer calls `GameService.settle()`;
   - `settle()` reads the full private room state (`getPrivateSnapshot`): a deep copy in memory
     mode, and a full fetch and parse in Redis mode;
   - this happens even while the question is still accepting, so admissions serialize on
     whole-state copies that grow with the number of players and questions.
     Calling `settle()` only when an admission closes the question (and otherwise relying on the
     scheduler tick) is the first change to try. Re-measure after any change.
3. **Node B's disconnects are consistent with a starved event loop.** Socket.IO drops a
   connection that misses its ping within 25 s + 20 s, and this happened on a 4-core host that
   was also running the load generator, the other node and both databases. Repeat the run on
   separate machines before deciding whether this is a server defect or a harness limit.
4. **Report finalization keeps up.** Writing 5,000 answers became durable within about one
   second of the game's end in both topologies.

## Re-measurement and root cause (2026-11-12, TASK-185)

Same host and harness as above. The commit includes TASK-183/183A:

- settles are coalesced per room;
- gateway publishes are coalesced per room;
- answer ACKs no longer wait for the publish.

The benchmark now records a per-process table (TASK-184): event-loop delay above the 10 ms
sampling resolution, CPU as % of one core, heap, disconnects per node, and the exit code and last
output of a node that dies mid-run. The verdict also fails on answers not admitted, a report that
is not durable, or a run that aborted.

### Memory mode, 200 clients: **FAIL** (10 answers not admitted)

Record `test-results/benchmark/memory.json`. 102 transitions in 459 s; delivery loss 0/20,400;
transport p95 **14.36 ms**; report durable after 1,239 ms.

| Measure (ms)                 | n      | p50      | p95       | p99       | max       |
| ---------------------------- | ------ | -------- | --------- | --------- | --------- |
| Transport (commit → receipt) | 53,286 | 4.34     | 14.36     | 37.18     | 43.65     |
| Admission (answer ACK RTT)   | 4,990  | 2,800.06 | 10,973.34 | 13,139.65 | 14,926.40 |
| State commit (host ACK RTT)  | 52     | 73.22    | 172.07    | 1,063.82  | 1,063.82  |

| Process        | Loop lag p99 per 1 s, median / p95 / max (ms) | CPU mean / max (% of one core) |
| -------------- | --------------------------------------------- | ------------------------------ |
| API node       | 0.68 / 925.85 / 4,905.72                      | 32.3 / 112                     |
| Load generator | 0.84 / 2.21 / 4.30                            | 1.5 / 9.1                      |

The API node's probe wrote only 268 one-second samples in 459 s: its event loop was blocked for
the rest. The load generator stayed idle. **The admission latency is caused by the server
blocking its own event loop, not by the harness or by CPU saturation** (mean 32% of one core).

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`. 102 transitions in 1,061 s.

- Transport p95 **300.87 ms**.
- Delivery loss 5,900/20,400 (28.9%).
- 2,469 answers not admitted.
- **Node B lost all 100 players** (`transport close`) 412 s after start.

| Measure (ms)                 | n       | p50      | p95      | p99      | max      |
| ---------------------------- | ------- | -------- | -------- | -------- | -------- |
| Transport (commit → receipt) | 102,066 | 11.17    | 300.87   | 693.44   | 2,187.57 |
| Admission (answer ACK RTT)   | 1,131   | 4,232.18 | 5,506.54 | 5,814.11 | 6,019.19 |
| State commit (host ACK RTT)  | 52      | 928.79   | 1,852.78 | 4,826.66 | 4,826.66 |

| Process        | Loop lag p99 per 1 s, median / p95 / max (ms) | CPU mean / max (% of one core) | Probe samples |
| -------------- | --------------------------------------------- | ------------------------------ | ------------- |
| API node A     | 161.31 / 320.30 / 1,027.04                    | 66.9 / 163                     | 1,016         |
| API node B     | 43.38 / 242.05 / 909.60                       | 42.4 / 133.4                   | 389           |
| Load generator | 1.67 / 4.57 / 10.53                           | 1.0 / 10.4                     | 1,060         |

Node B's probe stopped after 389 samples, shortly before its players disconnected. Two other
Redis runs on this commit did not finish: one aborted on a host command without an ACK, one on a
REST call to a node that was gone. A shorter run (60 transitions) that kept the dead node's output
showed why.

### Root cause

1. **A node crashes on a failed Redis publish (server defect).** `@socket.io/redis-adapter`
   8.3.0 calls `pubClient.publish(...)` without awaiting or catching it. The pub client is
   created with `commandTimeout: 2000` (`apps/api/src/providers/state/state.module.ts`). When the
   event loop stalls past 2 s, a publish times out, the rejection is unhandled, and Node exits:

   ```text
   Error: Command timed out
       at Timeout.<anonymous> (ioredis/built/Command.js:195:33)
   ```

   A Redis outage would do the same. Every player on that node is disconnected, which is
   finding 3 above. That finding had attributed it only to a starved event loop.

2. **The publish path blocks the event loop for seconds (server defect).** A CPU profile of the
   API node (memory mode, 200 clients) puts almost all busy time in the gateway's `diff`:
   - `structuredClone` of the whole private room state in `getPrivateSnapshot` on every diff and
     every settle round (≈2.4 s of a 33 s profile). The state grows with every played question,
     because it keeps all answers and per-player results, so the cost rises during the game.
   - `projectHost` on every diff, even when only the answer count changed, with Zod validation
     that checks the grapheme length of all 200 nicknames (≈0.6 s).
   - At reveal and podium, `projectPlayer` once per player, each validating a snapshot that
     lists all 200 players: O(n²) (≈0.6 s).
3. Finding 2 above (the full-state settle on every admission) was not the main cause. Coalescing
   it (TASK-183) and the publishes (TASK-183A) changed admission latency very little.

These are server defects, not harness limits. Fixes are planned in TASK-185A (crash), TASK-185B–D
(read-only state reads, an O(n) publish path, the settle read) and TASK-185E (re-measure).

## After the publish-path fixes (2026-11-12, TASK-185E)

The commit includes TASK-185A–D:

- a failed Redis adapter publish no longer crashes a node;
- private state is read without a copy;
- the gateway publish path is O(n);
- settle uses the copy-free read.

Same host and harness.

### Memory mode, 200 clients: **PASS**

Record `test-results/benchmark/memory.json`. 102 transitions in 253 s (459 s before).

- Delivery loss 0/20,400.
- All 5,000 answers admitted.
- Report durable after 806 ms.

| Measure (ms)                 | n      | p50   | p95   | p99   | max    | Before (p50 / p95) |
| ---------------------------- | ------ | ----- | ----- | ----- | ------ | ------------------ |
| Transport (commit → receipt) | 49,387 | 3.39  | 12.44 | 14.00 | 20.39  | 4.34 / 14.36       |
| Admission (answer ACK RTT)   | 5,000  | 1.10  | 35.87 | 90.69 | 169.35 | 2,800 / 10,973     |
| State commit (host ACK RTT)  | 52     | 27.73 | 55.86 | 413.7 | 413.7  | 73 / 172           |

API node:

- loop lag p99 per second, median 1.44 ms, max 629.63 ms (was 4,905 ms);
- CPU mean 10.6% of one core (was 32.3%).

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`. 102 transitions in 1,052 s.

- No player disconnects (100 before).
- Delivery loss 0/20,400 (28.9% before).
- Transport p95 **327 ms**.
- 3,899 of 5,000 answers not admitted.

Both nodes logged Redis adapter publish timeouts and survived them (TASK-185A). A first attempt of
this run ended without a record because the benchmark spread more than 100,000 samples into
`Math.max`. That was fixed in the benchmark, with a spec.

| Measure (ms)                 | n       | p50      | p95      | p99      | max      |
| ---------------------------- | ------- | -------- | -------- | -------- | -------- |
| Transport (commit → receipt) | 152,226 | 15.28    | 327.00   | 940.06   | 2,303.90 |
| Admission (answer ACK RTT)   | 1,101   | 4,325.33 | 5,837.29 | 6,028.27 | 6,401.26 |
| State commit (host ACK RTT)  | 52      | 785.19   | 2,280.82 | 5,341.54 | 5,341.54 |

| Process        | Loop lag p99 per 1 s, median / max (ms) | CPU mean / max (% of one core) |
| -------------- | --------------------------------------- | ------------------------------ |
| API node A     | 59.47 / 563.05                          | 54.0 / 134.6                   |
| API node B     | 9.91 / 503.80                           | 47.7 / 142.9                   |
| Load generator | 2.21 / 11.23                            | 1.2 / 10.1                     |

### Next bottleneck (Redis mode)

A shorter profiled run (200 clients, 24 transitions) rejected 527 answers:

- 339 `STATE_UNAVAILABLE`;
- 188 `DEPENDENCY_UNAVAILABLE`.

These are Redis commands timing out while the node's event loop is busy. The benchmark now records
these codes. In the CPU profile of the busier node, **83% of the busy time (79 of 95 s) is `decode`
in `RedisStateStore.read`**: every read validates the whole private room state with
`activeRoomStateSchema`. That includes grapheme-length checks of every nickname and UUID patterns,
and the state grows with every played question. This is the Redis-mode counterpart of the memory
clone removed by TASK-185B. The fix is planned in TASK-185F, with a re-measure in TASK-185G.

## After the read-only Redis decode (2026-11-12, TASK-185G)

The commit includes TASK-185F: the read-only Redis read uses no full schema validation.

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`. 102 transitions.

- No disconnects; delivery loss 0/20,400.
- Transport p95 **250.9 ms** (327 ms before).
- 3,809 answers not admitted: 2,366 `STATE_UNAVAILABLE`, 1,443 `DEPENDENCY_UNAVAILABLE`.

| Measure (ms)                 | n       | p50      | p95      | p99      | max      |
| ---------------------------- | ------- | -------- | -------- | -------- | -------- |
| Transport (commit → receipt) | 149,342 | 10.72    | 250.90   | 810.93   | 3,857.69 |
| Admission (answer ACK RTT)   | 1,191   | 3,847.47 | 5,417.37 | 5,808.63 | 6,078.40 |
| State commit (host ACK RTT)  | 52      | 487.23   | 1,246.53 | 3,173.70 | 3,173.70 |

| Process        | Loop lag p99 per 1 s, median / max (ms) | CPU mean / max (% of one core) |
| -------------- | --------------------------------------- | ------------------------------ |
| API node A     | 12.12 / 502.75                          | 43.9 / 118.2                   |
| API node B     | 22.29 / 380.07                          | 45.4 / 127.8                   |
| Load generator | 1.98 / 15.72                            | 1.3 / 10.0                     |

The memory run on the same commit (regression check) passed:

- transport p95 15.17 ms;
- admission p50 1.1 ms / p95 25.26 ms;
- 0 rejected answers.

### Next bottleneck: the Redis server

The nodes' event loops are now mostly free (median p99 lag 12–22 ms), yet the rejections barely
changed. A diagnostic run (200 clients, 40 transitions) sampled the Redis container every ~3 s
and kept its `SLOWLOG` (commands over 5 ms):

- **Redis CPU**: median 11%, p90 71%, max 100%. Redis saturates during answer bursts, so client
  commands wait past their 2 s timeout.
- **`read` script** (`e1dcbecf2d4e`): 95 slow calls, mean 14.5 ms. It returns
  `cjson.encode({state=raw, …})`, which re-escapes the whole multi-megabyte state string on every
  read.
- **`release-room.lua`** (`b3d091d9136a`): 28 slow calls, mean 25 ms. The scheduler's lease
  operations (acquire/renew/release) decode the whole state with `cjson.decode` only to compare
  its `sessionId`, which the script has already checked with `HGET`.
- `close-question.lua` and `mutate-room.lua`: a few calls at 57–117 ms (once per question).
- `admit-answer.lua` stayed under 5 ms.

Fixes are planned in TASK-185H (read reply without re-encoding; lease operations without the
state decode), with a re-measure in TASK-185I.

## After the Redis script fixes (2026-11-12, TASK-185I)

The commit includes TASK-185H:

- the read script returns the state as a bulk reply;
- lease operations no longer decode the state.

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`.

- No disconnects; delivery loss 0/20,400.
- Transport p95 **278.66 ms**.
- 3,545 answers not admitted: 2,653 `STATE_UNAVAILABLE`, 892 `DEPENDENCY_UNAVAILABLE`.

| Measure (ms)                 | n       | p50      | p95      | p99      | max      |
| ---------------------------- | ------- | -------- | -------- | -------- | -------- |
| Transport (commit → receipt) | 150,023 | 11.66    | 278.66   | 488.33   | 1,263.58 |
| Admission (answer ACK RTT)   | 1,455   | 3,988.46 | 5,332.13 | 5,536.73 | 5,920.61 |
| State commit (host ACK RTT)  | 52      | 373.60   | 1,107.02 | 4,005.42 | 4,005.42 |

Redis container CPU, 235 samples: median 5.3%, p90 37.6%, max 99.1% (was 11% / 71% / 100%).

SLOWLOG (commands over 5 ms, last 1,024 kept):

| Script               | Slow calls | Mean (ms) | Max (ms) |
| -------------------- | ---------- | --------- | -------- |
| `read` (multi-bulk)  | 933        | 12.2      | 41.0     |
| `admit-answer.lua`   | 58         | 103.5     | 137.9    |
| `mutate-room.lua`    | 18         | 109.8     | 190.0    |
| `close-question.lua` | 10         | 119.9     | 240.7    |

### Remaining bottleneck: one JSON blob per room

The whole room state is one JSON string in Redis: quiz, players, every answer of every question,
every result. Every gameplay script decodes it with `cjson.decode` and re-encodes it with
`cjson.encode` for a single change, and every read copies it through Lua. The string grows with
each played question, so late in a 25-question, 200-player game:

- one `admit-answer` costs about 100 ms of single-threaded Redis time;
- a burst of 200 answers needs about 20 s of Redis time.

Commands from both nodes then queue past their 2 s timeout. The multi-node target cannot be met
without storing answers and results outside the per-room blob. That is an architectural change
of the Redis state layout (TASK-185K), beyond a script fix. A smaller fix, a plain `HMGET` read
instead of a Lua read, is TASK-185J.

## After the Redis room layout v2 (2026-11-19, TASK-185S)

The commit includes TASK-185L–185R (ADR-13): the room lives in per-room keys of one hash slot
(`core`, players, answers per question, closed and result per question). The scripts decode only
what an operation changes, and the scheduler's routine reads use the window (the current
question and the latest scored question).

### Memory mode, one node, 200 clients: **PASS** (regression check)

Record `test-results/benchmark/memory.json`. 102 transitions in 251 s.

- Delivery loss 0/20,400; 0 rejected answers; 0 disconnects.
- Transport p95 **7.55 ms** (15.17 ms before).

| Measure (ms)                 | n      | p50   | p95   | p99    | max    |
| ---------------------------- | ------ | ----- | ----- | ------ | ------ |
| Transport (commit → receipt) | 49,102 | 2.71  | 7.55  | 9.33   | 13.76  |
| Admission (answer ACK RTT)   | 5,000  | 1.61  | 4.17  | 7.93   | 71.17  |
| State commit (host ACK RTT)  | 52     | 25.15 | 53.13 | 200.94 | 200.94 |

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`. 102 transitions in 268 s (1,052 s before).

- Delivery loss 0/20,400; 0 disconnects.
- **0 rejected answers** (3,545 before): every one of the 5,000 answers was admitted.
- Transport p95 **113.38 ms** (278.66 ms before); the target is < 50 ms.

| Measure (ms)                 | n      | p50    | p95    | p99    | max    |
| ---------------------------- | ------ | ------ | ------ | ------ | ------ |
| Transport (commit → receipt) | 97,795 | 4.72   | 113.38 | 147.98 | 234.57 |
| Admission (answer ACK RTT)   | 5,000  | 29.67  | 60.17  | 276.23 | 573.48 |
| State commit (host ACK RTT)  | 52     | 146.86 | 276.94 | 538.53 | 538.53 |

Before (TASK-185I), the admission p50 was 3,988 ms and the state commit p50 was 374 ms.

| Process        | Loop lag p99 per 1 s, median / max (ms) | CPU mean / max (% of one core) |
| -------------- | --------------------------------------- | ------------------------------ |
| API node A     | 1.61 / 97.35                            | 16.4 / 81.2                    |
| API node B     | 2.44 / 265.78                           | 14.9 / 97.4                    |
| Load generator | 0.76 / 6.56                             | 1.7 / 10.2                     |

Redis container CPU, 89 samples (every ~3 s): median 1.9%, p90 49.2%, max 68.6% (was 5.3% / 37.6% /
99.1%). Redis no longer saturates.

SLOWLOG (commands over 5 ms; the whole run fit in the 1,024 kept entries, 128 in total):

| Script and operation                   | Slow calls | Mean (ms) | Max (ms) |
| -------------------------------------- | ---------- | --------- | -------- |
| `v2-answer.lua` `admit` (with freeze)  | 27         | 202.3     | 292.0    |
| `v2-room.lua` `read` (full)            | 54         | 12.0      | 21.9     |
| `v2-room.lua` `read` (window)          | 23         | 6.7       | 10.9     |
| `v2-question.lua` (commit, transition) | 24         | 6.4       | 10.2     |

An ordinary `admit` never reached 5 ms. The contract measured about 0.5 ms per admission, the
same after 20 played questions as on the first (TASK-185O).

### Next bottleneck: the SHA-256 of the freeze in Lua

The 27 slow `admit` calls are the last required answer of each question. That answer freezes the
question in the same script, and the freeze hashes the encoded record (200 answers) with
SHA-256 written in pure Lua. Redis has no native SHA-256 for scripts. This takes about 200 ms
per question, and Redis is single-threaded: every command from both nodes waits behind it. The
broadcasts of that moment land in the transport tail (p95 113 ms, p99 148 ms).

- **This is a server defect, not the shared 4-core host.** Redis CPU stays below 70% and the
  nodes' event loops are mostly free (median p99 lag 1.6–2.4 ms). The tail follows the
  freeze-sized blocking calls.
- Full reads (`read` full, 12 ms on average) come from the readers that still need the complete
  state (finalization, recovery, the gateway's join/resync paths). They are a smaller second
  contributor.

The corrective task is TASK-185T: compute the freeze hash without SHA-256 in pure Lua, then
re-measure.

## After the native freeze token (2026-11-19, TASK-185T)

The freeze token of a closed question is now Redis's native SHA-1 (`redis.sha1hex`), no longer a
pure-Lua SHA-256. In the contract, the last admission of a 200-player question, freeze included,
takes about 3 ms of Redis time (2.9–3.3 ms over three runs; about 200 ms before).

### Redis mode, two nodes, 200 clients: **FAIL**

Record `test-results/benchmark/redis.json`. 102 transitions in 263 s.

- Delivery loss 0/20,400; 0 disconnects; 0 rejected answers.
- Transport p95 **131.36 ms** (113.38 ms in TASK-185S); the target is < 50 ms.

| Measure (ms)                 | n      | p50    | p95    | p99    | max    |
| ---------------------------- | ------ | ------ | ------ | ------ | ------ |
| Transport (commit → receipt) | 98,338 | 5.98   | 131.36 | 165.84 | 317.09 |
| Admission (answer ACK RTT)   | 5,000  | 46.08  | 83.33  | 173.50 | 448.60 |
| State commit (host ACK RTT)  | 52     | 175.50 | 349.61 | 737.51 | 737.51 |

| Process        | Loop lag p99 per 1 s, median / max (ms) | CPU mean / max (% of one core) |
| -------------- | --------------------------------------- | ------------------------------ |
| API node A     | 2.05 / 267.61                           | 18.2 / 90.4                    |
| API node B     | 2.60 / 391.60                           | 17.0 / 105.3                   |
| Load generator | 1.00 / 10.02                            | 2.1 / 12.6                     |

Redis container CPU, 88 samples: median 2.2%, p90 45.5%, max 60.1%.

SLOWLOG (over 5 ms), 145 entries for the whole run:

| Script and operation                   | Slow calls | Mean (ms) | Max (ms) |
| -------------------------------------- | ---------- | --------- | -------- |
| `v2-room.lua` `read` (window)          | 57         | 6.2       | 12.0     |
| `v2-room.lua` `read` (full)            | 56         | 14.8      | 26.2     |
| `v2-question.lua` (commit, transition) | 23         | 8.4       | 11.9     |
| `v2-answer.lua` `admit` (with freeze)  | 8          | 7.5       | 10.8     |
| `v2-player.lua` `join`                 | 1          | 6.7       | 6.7      |

### What this shows

- The freeze stall is gone: no Redis command took more than 26.2 ms (292 ms before).
- The transport tail did not follow it down. Between TASK-185S and this run it moved from
  113 to 131 ms, within the run-to-run noise of this shared host. So the freeze stall was not
  the main cause of the tail.
- The remaining tail is **not Redis-side blocking**. Redis stays below 61% CPU and its longest
  command is 26 ms, while transport p99 is 166 ms. The open suspects are on the API side:
  - the cross-node fan-out through the Socket.io Redis adapter (pub/sub);
  - per-recipient payload building on each node;
  - event-loop stalls (max loop lag 268–392 ms on the nodes);
  - CPU contention: two API nodes, Redis, PostgreSQL and the load generator share four cores.

  Telling a server defect apart from the shared host needs a profile, not another re-run. That
  is TASK-185U.

## Not covered

- More than 200 clients: needs a separate harness and run. The CLI refuses `--clients` above 200.
- Real LAN, Wi-Fi or mobile WAN: client RTT on those networks is not a backend latency and must
  not be reported as one.
- Packet loss on a real network: only delivery completeness on loopback was measured.

## Re-running

```bash
pnpm --filter "@kabuki-neko/api..." build
pnpm benchmark:game --clients 200 --transitions 100 --mode memory
pnpm benchmark:game --clients 200 --transitions 100 --mode redis   # needs Docker
pnpm test:performance -- tests/performance/game-benchmark.spec.ts
```

Each run writes a JSON record to `test-results/benchmark/<mode>.json`. It contains the
environment, versions, duration, clock error, delivery, percentiles and the verdict. The command
exits non-zero when the target is missed.

# Player bundle and cold-load budgets

Recorded result of `pnpm exec tsx scripts/measure-web-budget.ts --runs 5` (TASK-180; Design §9;
SA §8.3; US-18, US-20, US-21). The tooling (classification, gzip accounting, medians, refusal of
development builds, threshold failures) is covered by
`pnpm test:performance -- tests/performance/web-budget.spec.ts`.

## Method

- **Production build only.** The script builds with `next build` and serves with `next start`. It
  refuses HTML with development markers.
- **Real backend.** A real API and room serve the identity step (M01) with a valid PIN.
- **Cold runs.** Five fresh Chromium contexts per scenario, with:
  - a 390×844 mobile viewport;
  - 1.6 Mbps down, 750 kbps up, 150 ms RTT and 4× CPU slowdown (CDP);
  - the cache disabled.
- **Scenarios.** `/join` in en, ja, zh-Hans (CJK), de (long text) and ar (RTL). German and Arabic
  are test packages built into a separate bundle the server reads (`KN_LOCALES_DIR`); they are
  not shipped. Plus the identity step `/join?pin=…` in en.
- **Initial JS.** Every script loaded on `/join` until network idle, framework included, at gzip
  level 9.
- **Initial locale payload.** The namespaces the route fetched plus the SSR shell namespaces
  (common, accessibility), for the locale and its `en` fallback.
- Fonts and media are reported separately.

## Result (2026-11-11, Chromium 153, same 4-core VM as above): **FAIL**

| Budget                       | Result                                                                                                                | Verdict         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| Initial JS ≤ 300 KiB gzip    | **353.8 KiB** gzip (1,310 KiB raw, 16 files)                                                                          | FAIL            |
| Initial locale ≤ 50 KiB gzip | en 10.3, ja 23.2, zh-Hans 22.0, de 10.9, ar 10.9 KiB                                                                  | PASS            |
| Median LCP ≤ 4 s             | `/join` 620–648 ms in every locale; **identity step 4,280 ms**                                                        | FAIL (identity) |
| Median CLS ≤ 0.1             | 0.030–0.069 on `/join`; 0.095 at the identity step                                                                    | PASS            |
| Lazy loading                 | dnd-kit (studio), ZXing (QR decoder) and confetti absent from `/join`; avatar style chunks 1 → 2 at the identity step | PASS            |

| Scenario            | LCP runs (ms)                | Median LCP | Median CLS | JS gzip   | Fonts    | Media   |
| ------------------- | ---------------------------- | ---------- | ---------- | --------- | -------- | ------- |
| join en             | 624, 636, 656, 616, 612      | 624        | 0.030      | 353.8 KiB | 35.0 KiB | 1.0 KiB |
| identity (M01) en   | 4280, 4320, 4148, 4200, 4344 | 4280       | 0.095      | 590.3 KiB | 35.0 KiB | 1.0 KiB |
| join ja (CJK)       | 636, 620, 640, 608, 580      | 620        | 0.069      | 353.8 KiB | 35.0 KiB | 1.0 KiB |
| join zh-Hans (CJK)  | 648, 624, 660, 644, 664      | 648        | 0.056      | 353.8 KiB | 35.0 KiB | 1.0 KiB |
| join de (long text) | 640, 644, 596, 620, 600      | 620        | 0.043      | 353.8 KiB | 35.0 KiB | 1.0 KiB |
| join ar (RTL)       | 632, 592, 656, 664, 644      | 644        | 0.038      | 353.8 KiB | 35.0 KiB | 1.0 KiB |

`/join`'s LCP element is server-rendered text, so it paints before the scripts finish. The JS
budget is still exceeded, and that costs interactivity time on slow phones.

## Findings for follow-up fixes

Each is a separate atomic fix; this measurement task does not change them.

1. **`/_next/static/chunks/43pd1f38gdu5b.js` — 123.8 KiB gzip.** The shared contracts' `zod`
   schemas plus the `intl-messageformat` runtime: `apps/web/src/lib/i18n/format.ts` and
   `catalog-loader.ts`, and the `@kabuki-neko/shared` schema imports on the join path.
   Catalogs already ship precompiled ASTs, so check whether parser code is bundled, and import
   narrower schemas on `/join`.
2. **`/_next/static/chunks/02p86dr4wnlm7.js` — 17.0 KiB gzip.** `socket.io-client`/`engine.io`
   (needed for the PIN check) bundled with the audio manager (`lib/audio-manager.ts`, reached from
   `components/player/avatar-customizer.tsx` for the join pop). Defer the audio manager until the
   player's first gesture.
3. **`/_next/static/chunks/34fq-xudn5cji.js` — 12.4 KiB gzip.** `framer-motion`, DiceBear core
   (`lib/avatar.ts`) and the QR code generator are on the `/join` boot. The QR generator is only
   needed on the host stage and DiceBear core only at the identity step.
4. **Identity step LCP 4.3 s.** M01 renders after the PIN check over the socket, then loads and
   renders the avatar style chunk under 4× CPU. Render the identity form and nickname field first,
   and stream the avatar previews in (`components/player/avatar-customizer.tsx`).

## Re-running

```bash
pnpm --filter "@kabuki-neko/api..." build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium pnpm exec tsx scripts/measure-web-budget.ts --runs 5
```

The record (raw runs, medians, gzip manifest of every initial chunk, verdict) goes to
`test-results/benchmark/web-budget.json`. The command exits non-zero when any budget fails.
