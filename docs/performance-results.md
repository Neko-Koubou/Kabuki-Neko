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
