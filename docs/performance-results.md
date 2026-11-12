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
