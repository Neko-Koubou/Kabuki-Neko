# 07 — QA Report: Kabuki Neko

> **Status**: COMPLETE

Run QA `/vibe-test` (seluruh scope, US-01–US-21) pada **2026-11-12**, branch `main-nv6b09`.
- **Commit awal**: `ce720f9` (setelah review `06-code-review.md` menyatakan 0 CRITICAL/MAJOR terbuka).
- **Commit akhir**: `ed0541d`.
- **Lingkungan**: container cloud Linux x64 (Intel Xeon 2,1 GHz, 4 core, 15,7 GiB).
  - Node **26.13.0** (diunduh ke scratchpad; Node bawaan container v22 ditolak `engineStrict`) dan pnpm 10.34.9 via corepack.
  - Docker 29.9.2 aktif.
  - Chromium Playwright prainstal (`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`).
  - MinIO memakai image prabangun `kabuki-neko/minio-test:local-ca` (`KABUKI_TEST_MINIO_IMAGE`), karena build MinIO dari source gagal di container ini.

## 1. Ringkasan eksekusi test

Status final setelah semua perbaikan di §3. Kolom "Run pertama" mencatat temuan sebelum perbaikan.

| Suite | Perintah | Run pertama | Final | Durasi |
| --- | --- | --- | --- | --- |
| Lint | `pnpm lint` | PASS 6/6 | **PASS** | 5 s |
| Typecheck | `pnpm typecheck` | PASS 6/6 | **PASS** | 16 s |
| Unit shared (Vitest) | `pnpm test` | 99/99 | **99/99 PASS** (11 file) | 1 s |
| Unit web (Vitest + jsdom) | `pnpm test` | 452/452 | **453/453 PASS** (51 file; +1 spec regresi) | 48 s |
| Unit API (Jest) | `pnpm test` | 253/253 | **253/253 PASS** (37 suite) | 9 s |
| Unit database (Jest + Testcontainers) | `pnpm test` | 4/4 | **4/4 PASS** | 17 s |
| Performance unit (Vitest) | `pnpm test:performance` | 17/17 | **17/17 PASS** | <1 s |
| Audio pipeline (node:test) | `pnpm test:audio` | 11/11 | **11/11 PASS** | 55 s |
| Katalog locale | `pnpm locales:validate` | 0 error, 0 warning | **PASS** | — |
| Contract (Jest + Testcontainers) | `pnpm test:contracts` | 23/25 suite; 146 pass, 11 fail, 3 skip | **25/25 suite; 157 pass, 3 skip** | 4 m + 3,8 m |
| Integration (Jest + Docker) | `pnpm test:integration` | 18/20 suite; 146/148 | **19/20 suite; 147/148** (1 FAIL lingkungan) | 7,7 m |
| E2E (Playwright, Chromium) | `pnpm test:e2e` | 45 pass, 3 fail, 6 tidak jalan (run 2) | **54/54 PASS** | 9,9 m |
| Benchmark game, memory | `pnpm benchmark:game --clients 200 --transitions 100 --mode memory` | — | **PASS** (transport p95 20,59 ms) | 7 m |
| Benchmark game, Redis 2 node | `pnpm benchmark:game --clients 200 --transitions 100 --mode redis` | — | **FAIL** (transport p95 282,57 ms; 26,96% kehilangan; 100 pemain node B terputus) | 18 m |

**Catatan per suite:**
- **Contract**: 11 kegagalan run pertama berasal dari dua sebab lingkungan.
  - Build image MinIO dari source gagal di container ini.
  - `apps/api/dist` dibangun ulang oleh E2E yang saya jalankan paralel, sehingga `driver-matrix` kehilangan `dist/main.js`.
  - Run ulang `driver-matrix` + `storage` dengan image MinIO prabangun: semua PASS.
  - 3 test di-skip: smoke test R2/S3/Spaces (`cloud-storage.spec.ts`), yang hanya jalan bila kredensial `KABUKI_CLOUD_*` disediakan.
- **Integration**:
  - Image `kabuki-neko-{api,web}:local` dibangun ulang dari commit QA, karena image lama mendahului perbaikan MJ-17/19/21.
  - `game-gateway.spec.ts` diperbarui (§3, QA-04): 3/3 PASS.
  - Satu kegagalan tersisa, `system.spec.ts`, berasal dari lingkungan (lihat §4).

## 2. Requirement Traceability Matrix (RTM)

Pemetaan memakai peta `TRACE` di `tests/e2e/journeys.spec.ts`. Test "traces every user story and the five PRD §9 scenarios to verifications" memaksa setiap AC-xx-yy di PRD punya minimal satu test yang benar-benar ada. Status = hasil run final.

| US | Acceptance criteria | Test file & case | Status |
| --- | --- | --- | --- |
| US-01 Setup & auth | AC-01-01, AC-01-02 | `tests/e2e/auth.spec.ts` › first run: two tabs race the setup and exactly one SUPERADMIN exists; `tests/integration/auth-races.spec.ts` › creates exactly one SUPERADMIN when five setups race; `tests/e2e/journeys.spec.ts` › AC-01/02 …; `apps/api/src/modules/auth/setup.service.spec.ts`, `refresh.service.spec.ts` | **PASS** |
| US-02 Kebijakan registrasi | AC-02-01, AC-02-02 | `tests/e2e/auth.spec.ts` › registration follows the SINGLE_ADMIN, INVITE_ONLY and PUBLIC policies; `tests/integration/auth-races.spec.ts` › consumes one invitation once under racing registrations and enforces every mode; `tests/integration/users.spec.ts` | **PASS** |
| US-03 CRUD, visibility, reuse | AC-03-01, AC-03-02 | `tests/integration/content-races.spec.ts` › duplicates concurrently into complete, independent copies; `tests/integration/authorization.spec.ts` › hides private quizzes, protects public ones and never bypasses for SUPERADMIN; `tests/integration/quizzes.spec.ts`; `tests/e2e/ui-states.spec.ts` › S06, S10 and S17 fall back safely … | **PASS** |
| US-04 Quiz Studio, 6 tipe | AC-04-01, AC-04-02 | `tests/e2e/studio.spec.ts` › builds all six types, reorders, duplicates, deletes, saves and keeps them after a refresh / keeps the draft on a conflict from another tab … / saves a zero-slide draft …; `apps/web/src/stores/studio.store.spec.ts`; `apps/api/src/modules/quizzes/quiz-domain.spec.ts` | **PASS** |
| US-05 Import/export | AC-05-01, AC-05-02 | `tests/integration/quiz-transfer.spec.ts` › imports both templates and roundtrips all six types through export / rejects missing media without creating partial rows or receipts / maps malformed, oversized and unsupported uploads to stable errors; `apps/web/src/components/studio/import-export.spec.tsx` | **PASS** |
| US-06 Upload & asset library | AC-06-01, AC-06-02 | `tests/integration/media.spec.ts` › uploads, guards and deletes media on the local origin / stores and deletes an uploaded image through a MinIO origin; `tests/integration/media-failures.spec.ts` (7 kasus); `apps/api/src/modules/media/media-processor.spec.ts` › downscales to 1920 px WebP and never enlarges small images | **PASS** |
| US-07 Lobi & moderasi | AC-07-01, AC-07-02 | `tests/e2e/host.spec.ts` › runs a full game with duplicate-safe Next, reconnect and the ready report; `tests/integration/authorization.spec.ts` › refuses host commands from anyone but the room's host; `apps/web/src/stores/game.store.spec.ts` › derives host capabilities from applied pushes without a full room:sync (baru, QA-01/02) | **PASS** (sempat FAIL, diperbaiki QA-01/02) |
| US-08 Join PIN/QR | AC-08-01, AC-08-02 | `tests/e2e/join.spec.ts` (6 kasus, termasuk checks a deep-linked PIN once … / explains a locked room (partial) / falls back to manual entry when the camera is denied …); `apps/web/src/components/player/pin-join-scanner.spec.tsx` | **PASS** |
| US-09 Gamepad & display mode | AC-09-01, AC-09-02 | `tests/e2e/player.spec.ts` › shows shapes first in a Projector room …; `tests/integration/payload-privacy.spec.ts` › never sends keys before the reveal, secrets ever, or other players' results; `apps/web/src/components/player/choice-answer-pad.spec.tsx`, `text-puzzle.spec.tsx` | **PASS** |
| US-10 Timer, grace, anti-cheat | AC-10-01, AC-10-02 | `tests/integration/recovery.spec.ts` › scores by server receive time and honours the 1500 ms grace exactly; `tests/integration/realtime-races.spec.ts` › counts an answer racing Skip exactly when its ACK was accepted; `tests/integration/game-gateway.spec.ts` › disconnects oversize events and enforces per-socket rate limits (diperbarui QA-04) | **PASS** |
| US-11 Skor & streak | AC-11-01, AC-11-02 | `apps/api/src/modules/game-engine/scoring.spec.ts` › scores partial multiple-select with a streak bonus (375 + 100 = 475) / applies POLL, multiplier-0, wrong, unanswered and not-eligible streak rules | **PASS** |
| US-12 Pemulihan sesi | AC-12-01, AC-12-02 | `tests/e2e/player.spec.ts` › plays all six input types in a Streamer room with refresh, reconnect, grace and podium; `tests/integration/realtime-races.spec.ts` › refuses the old socket after a player reconnects on the other node; `apps/web/src/hooks/use-session-recovery.spec.tsx` | **PASS** |
| US-13 Reveal, leaderboard, podium | AC-13-01, AC-13-02 | `scoring.spec.ts` › builds top five, biggest climber and empty/one/two winner podia; `tests/integration/recovery.spec.ts` › never invents podium winners …; `tests/e2e/journeys.spec.ts` › AC-04/07–13 …; `apps/web/src/components/host/podium.spec.tsx` | **PASS** (sempat FAIL, diperbaiki QA-01) |
| US-14 Laporan & CSV | AC-14-01, AC-14-02 | `tests/e2e/reports.spec.ts` (4 kasus); `tests/integration/finalization-failures.spec.ts` (4 kasus); `tests/integration/reports.spec.ts`; `tests/integration/authorization.spec.ts` › serves reports only to their host | **PASS** |
| US-15 Settings & cleanup | AC-15-01, AC-15-02 | `tests/integration/content-races.spec.ts` › cleans only unreferenced uploads with truthful counters, one run at a time; `tests/integration/media-failures.spec.ts` › reports a cleanup outage as a failure …; `tests/e2e/journeys.spec.ts` › AC-15/17/19 …; `tests/integration/system.spec.ts` › cleans orphans with partial failures … | **PASS** (AC-15-02 sisi injeksi chmod: FAIL lingkungan, lihat §4) |
| US-16 Driver & scaling | AC-16-01, AC-16-02 | `tests/contracts/driver-matrix.spec.ts` (12 kombinasi + 2 topologi multi-node); `tests/contracts/state-parity.spec.ts`; `tests/integration/realtime-races.spec.ts` › plays one authoritative game with the host and players on different nodes; `tests/integration/media-failures.spec.ts` › refuses to start with an incomplete S3 origin … | **PASS** |
| US-17 Self-host Docker | AC-17-01, AC-17-02 | `tests/integration/deployment.spec.ts` (profile default & scale); `tests/integration/backup-restore.spec.ts`; `tests/integration/catalog-deployment.spec.ts`; `tests/integration/room-retention.spec.ts` › treats in-memory rooms as LOST after a restart | **PASS** |
| US-18 Visual & aksesibilitas | AC-18-01, AC-18-02 | `tests/e2e/accessibility.spec.ts` (3 kasus axe + keyboard-only game); `tests/e2e/responsive.spec.ts` (5 kasus); `tests/e2e/audio.spec.ts` (3 kasus); `apps/web/src/components/host/AudioController.spec.tsx` | **PASS** (sempat FAIL, diperbaiki QA-01/03) |
| US-19 Distribusi & atribusi | AC-19-01, AC-19-02 | `tests/contracts/distribution.spec.ts`; `tests/e2e/journeys.spec.ts` › AC-15/17/19 … the About page shows the license; `apps/web/src/components/ui/document-view.spec.tsx` | **PASS** |
| US-20 Kinerja & audit | AC-20-01, AC-20-02 | `tests/integration/auth-races.spec.ts` › never writes passwords, tokens, cookies or invite codes to the API output; `tests/integration/room-retention.spec.ts` › never evicts a report that is not durable and raises one 24 h alarm; `apps/api/src/common/audit.service.spec.ts`; `tests/performance/*.spec.ts`; `pnpm benchmark:game` mode memory dan Redis | **FAIL (sebagian)** — audit, AC-20-02 dan benchmark memory PASS (p95 20,59 ms); benchmark Redis 2 node FAIL (lihat catatan) |
| US-21 Multibahasa | AC-21-01 – AC-21-04 | `tests/e2e/localization.spec.ts` (5 kasus); `tests/contracts/locale-coverage.spec.ts`, `locale-build.spec.ts`, `locale-packages.spec.ts`, `localization-roundtrip.spec.ts`; `tests/e2e/responsive.spec.ts` › Japanese and Simplified Chinese wrap at 320 px; `pnpm locales:validate` | **PASS** |

**Catatan US-20 (mode Redis 2 node): FAIL, terkonfirmasi ulang dari commit QA.**
- **Hasil**: 200 klien, 102 transisi, 1.057 s, PostgreSQL + Redis 7.4.12 + 2 node API, loopback pada satu host 4 core.
  - Transport p50 13,97 ms, **p95 282,57 ms**, p99 656,72 ms, max 2.484 ms.
  - Kehilangan pengiriman 5.500/20.400 (26,96%).
  - **100 pemain di node B terputus** (`transport close`).
  - 2.568 jawaban ditolak; antrean laporan 9.857 ms untuk 1.132 jawaban.
  - Record: `test-results/benchmark/redis.json`.
- **Perbandingan**: hasil ini sama polanya dengan TASK-179 (p95 310 ms, kehilangan 28,9%, node B memutus 100 pemain). Masalahnya belum diperbaiki dan tidak tercatat di `06-code-review.md`.
- **Akar masalah**: belum ditemukan. Kandidat:
  - saturasi CPU: dua node API, PostgreSQL, Redis, dan 200 klien berbagi 4 core, sehingga ping Socket.io atau adapter Redis tertunda;
  - jalur fan-out `@socket.io/redis-adapter` ke node kedua.
  Diagnosis butuh profiling per node dan run di host terpisah, di luar batas 3 percobaan terfokus run QA ini.
- **Tindak lanjut**: [04-tasks.md](04-tasks.md) Phase 7 — `TASK-183` (admission tanpa full-state settle), `TASK-184` (diagnostik per node + verdict jujur), `TASK-185` (ukur ulang dan tetapkan akar masalah). Target PRD p95 < 50 ms **belum terbukti** untuk topologi multi-instance.

## 3. Bug dan perbaikan dalam run ini

Setiap perbaikan satu commit, dengan bukti merah→hijau.

**QA-01 [MAJOR] — regresi dari MJ-25: "Start game" tidak pernah aktif** (`b331318`)
- **Gejala**: "Start game" host tetap disabled walau pemain sudah bergabung. Lima E2E gagal: keyboard-only game, audio role matrix, host full game, friendly-nickname join, journey AC-04/07–13.
- **Akar masalah**:
  - Push tidak membawa `capabilities`.
  - Sebelum MJ-25, `publicRevision` yang tertinggal memaksa `room:sync` penuh setelah setiap perubahan, dan sync itulah yang ikut menyegarkan kapabilitas.
  - Setelah MJ-25 tidak ada sync lagi, sehingga `canStart` tetap `false`. `canNext`/`canSkip` juga hanya ikut fase berkat sync tersebut.
- **Perbaikan**: `applyEvent` di `apps/web/src/stores/game.store.ts` menurunkan kapabilitas host dari roster dan fase hasil reduce, dengan aturan yang sama dengan `room-projector.ts`.
  - `canSkip` bernilai `true` saat fase menjawab dibuka.
  - Selama fase tetap, `canSkip` mempertahankan nilai snapshot terakhir.
- **Bukti**: spec baru di `game.store.spec.ts` gagal tanpa perbaikan dan lulus dengan perbaikan.

**QA-02 [MAJOR] — regresi dari MJ-25: host menampilkan "0 of 0 answered"** (`552cb24`)
- **Gejala**: penghitung jawaban host menampilkan "0 of 0 answered" sepanjang soal (`tests/e2e/host.spec.ts`).
- **Akar masalah**: `eligibleCount` sama-sama hanya diisi oleh `room:sync`.
- **Perbaikan**:
  - Reducer kini mengambil `totalPlayers` dari `game:answer_count_updated`. Server mengirimnya ke host saat fase menjawab dibuka dan pada setiap jawaban, nilainya = pemain wajib yang tidak di-kick.
  - `QUESTION_PREVIEW` mereset `eligibleCount` ke 0, sama seperti proyeksi server.
- **Bukti**: spec diperluas; gagal tanpa perbaikan, lulus dengan perbaikan.

**QA-03 [MINOR, test] — asumsi waktu di `tests/e2e/audio.spec.ts`** (`c25c4c2`)
- **Gejala**: hanya 1 dari 5 cue `revealBar` yang terekam.
- **Akar masalah**:
  - Host menekan "Show leaderboard" ±150 ms setelah gong, sedangkan `revealBar` dijadwalkan 450 ms setelah gong di dalam ANSWER_REVEAL.
  - Engine audio membatalkan cue tertunda saat fase berganti, dan itu benar menurut `audio-engine-revision.md`.
  - Dulu test lolos hanya karena kontrol host menunggu heartbeat sync.
- **Perbaikan**: test menunggu tiap `revealBar` sebelum lanjut. Kode aplikasi tidak diubah.

**QA-04 [MINOR, test] — test integrasi rate limit belum mengikuti MJ-15** (`ed0541d`)
- **Gejala**: flood `room:time` dari socket anonim tidak pernah sampai `RATE_LIMITED`.
- **Akar masalah**: sejak MJ-15, socket tak terikat ditolak `AUTH_REQUIRED` sebelum limiter (disengaja, agar tidak membuat kunci limiter per koneksi).
- **Perbaikan**: test kini memeriksa kedua sisi kontrak:
  - flood dari socket anonim selalu dijawab `AUTH_REQUIRED`;
  - host yang login dibatasi setelah 12 request TIME per menit.

**QA-05 [MINOR, test] — inventaris UI-state memakai judul lama** (`837b1ed`)
- **Gejala**: sel F17.X di inventaris UI-state gagal, dan sisa `ui-states.spec.ts` tidak dijalankan.
- **Akar masalah**: sel itu merujuk judul spec `connection-recovery` sebelum diganti oleh MJ-28.
- **Perbaikan**: judul diperbarui. Ke-305 sel inventaris diverifikasi dengan skrip terpisah dan semuanya merujuk test yang ada.

Tindak lanjut QA-01/02 juga dicatat di bawah MJ-25 pada [06-code-review.md](06-code-review.md).

## 4. Edge case terverifikasi dan sisa pemeriksaan manual

**Edge case yang dibuktikan otomatis (pilihan):**
- **Race setup**: 5 setup paralel menghasilkan tepat 1 SUPERADMIN.
- **Undangan**: dipakai sekali di bawah race.
- **Rotasi refresh token**: berjalan sekali; pemakaian ulang mencabut seluruh family token.
- **Akun admin**: tidak pernah 0 SUPERADMIN aktif.
- **Kuis**:
  - tidak terbelah saat dua simpan berebut satu revisi;
  - room dibuat dari revisi yang disebut;
  - attach media diserialkan terhadap delete.
- **Jawaban**:
  - skor memakai waktu terima server;
  - grace 1.500 ms tepat;
  - jawaban yang berebut dengan Skip/End dihitung tepat bila ACK diterima;
  - retry tidak memberi poin dua kali.
- **Payload privacy**: tidak ada kunci jawaban sebelum reveal, tidak ada secret, dan tidak ada hasil pemain lain, termasuk lintas dua node PostgreSQL + Redis.
- **Rate limit**:
  - socket anonim tidak membuat kunci limiter (MJ-15);
  - event > 16 KiB memutus socket;
  - batas per socket untuk host.
- **Media**:
  - unggahan malformed, terlalu besar, atau tidak didukung ditolak tanpa baris atau receipt;
  - import yang terputus tidak menyisakan apa pun;
  - crash saat tulis blob atau delete pulih dengan benar.
- **Laporan**:
  - tepat satu laporan durable setelah crash;
  - backoff dengan 503 + retry manual;
  - hash payload yang tidak cocok tidak menimpa histori;
  - laporan non-durable tidak di-evict.
- **Retensi room**:
  - LOST setelah lobi idle 2 jam;
  - hard limit 8 jam;
  - FINISHED bertahan 1 jam;
  - room memory LOST setelah restart.
- **UI**:
  - 5 state (L/E/I/P/X) untuk 61 item dan 305 sel;
  - axe light/dark;
  - reflow 320–1280 px dan zoom 200%;
  - reduced motion;
  - RTL Arab;
  - CSP nonce dan anti-framing;
  - bundle publik tanpa nama secret.
- **Lokalisasi**:
  - katalog gagal dimuat → bahasa lama dan PIN yang diketik dipertahankan;
  - ganti bahasa saat game atau studio kotor tidak mengirim ulang data.

**FAIL lingkungan dan yang belum dijalankan:**

| Item | Status | Alasan / tindakan |
| --- | --- | --- |
| `tests/integration/system.spec.ts` › cleans orphans with partial failures … | **FAIL (lingkungan)** | Injeksi gagal-hapus memakai `chmod 0555`, yang diabaikan oleh root di container. Hasilnya `deletedCount 2 / failedCount 0`, bukan `1 / 1`. Sama dengan catatan `00-project-context.md` §6.3 butir 6. Perlu dijalankan sebagai non-root (CI GitHub Actions). Tindak lanjut: `TASK-186`. |
| `tests/contracts/cloud-storage.spec.ts` (R2/S3/Spaces) | **not run (skip)** | Butuh kredensial `KABUKI_CLOUD_*` asli. |
| Build image MinIO dari source | **not run** | Gagal di container ini. Diganti image prabangun dari source yang sama (`KABUKI_TEST_MINIO_IMAGE`). Akar masalah: stage build tidak mengenal CA proxy TLS. Tindak lanjut: `TASK-187`. |
| Budget web pemain (`scripts/measure-web-budget.ts`, TASK-180) | **not run** dalam run QA ini; hasil terakhir tercatat **FAIL** | `docs/performance-results.md` (2026-11-11): initial JS 353,8 KiB gzip (budget ≤ 300 KiB) dan LCP langkah identitas 4.280 ms (budget ≤ 4 s). Belum ada task perbaikan; tidak tercakup oleh RTM §2, yang hanya memuat test fungsional. |

**Pemeriksaan manual yang tersisa:**
- Screen reader nyata (NVDA/VoiceOver) untuk alur host dan pemain. Axe dan keyboard-only sudah otomatis.
- Pemindaian QR dengan kamera fisik di ponsel. E2E memakai kamera palsu/ditolak.
- Kualitas audio dan autoplay di Safari iOS serta perangkat Android nyata.
- Benchmark di jaringan nyata (Wi-Fi/WAN, beberapa host), karena baseline di sini loopback.
- Benchmark mode Redis di hardware terpisah setelah task korektif (lihat US-20).
- Deploy Docker di host non-root dengan volume nyata, termasuk restore backup oleh operator.
