# 06 — Code Review: Kabuki Neko (Fase 1–3)

> **Verdict**: **CHANGES REQUESTED** — 1 `[CRITICAL]`, 13 `[MAJOR]`, 24 `[MINOR]` terbuka.

Tanggal review: **2026-11-08 (Asia/Jakarta)**, pada commit `3c960cc` (branch `main-nv6b09`). Ini review pertama pipeline, sehingga cakupannya seluruh task `[x]` di Fase 1–3.

## 1. Metode dan cakupan

- Dibandingkan terhadap [00-project-context.md](00-project-context.md) §5, [01-prd.md](01-prd.md), [03-system-analysis.md](03-system-analysis.md) (§2 ERD, §4 REST, §5 Socket/engine, §6 state & finalisasi, §7 media/import/CSV, §8 lokalisasi, §9–§10 keamanan & operasi, ADR-01–ADR-12) dan log [05-implementation-log.md](05-implementation-log.md). Fase 1–3 belum memiliki UI, jadi pilar "5 UI states" belum relevan (web masih scaffold).
- Audit statis dibagi lima area dan dikerjakan paralel: (a) boundary HTTP/auth/users, (b) kuis/import-export/media/storage, (c) game engine & state store (memory + Redis Lua), (d) finalisasi/worker/laporan/CSV, (e) system/settings/health, tooling lokalisasi, skema & migrasi DB, fondasi shared. Setiap temuan berbasis kutipan kode; seluruh temuan `[CRITICAL]`/`[MAJOR]` diverifikasi ulang langsung terhadap kode sebelum dicatat.
- Bukti runtime terakhir (container cloud, Node 26.13.0, Docker dijalankan manual): build/typecheck/lint PASS; API Jest 31 suite/226 test PASS; integration 17/19 PASS (2 gagal karena lingkungan, lihat 00 §6.3 butir 6); contract laporan PASS di SQLite/PostgreSQL/MySQL.
- Severity: `[CRITICAL]` = celah keamanan yang dapat dieksploitasi atau kehilangan/korupsi data; `[MAJOR]` = pelanggaran spesifikasi atau bug berdampak nyata; `[MINOR]` = deviasi kecil/hardening. Status awal semua temuan `[OPEN]`.

## 2. Reviewed Tasks

TASK-001, TASK-001A, TASK-001B, TASK-001C, TASK-002 – TASK-006, TASK-007A, TASK-007B, TASK-007, TASK-008 – TASK-014, TASK-014A, TASK-015, TASK-016, TASK-016A, TASK-016B, TASK-016C, TASK-017 – TASK-022, TASK-022A, TASK-023, TASK-023A, TASK-024 – TASK-030, TASK-030A, TASK-031 – TASK-047, TASK-048A, TASK-048, TASK-049, TASK-049B, TASK-050A, TASK-050, TASK-051, TASK-052, TASK-053A, TASK-053, TASK-054A, TASK-054, TASK-055A, TASK-055, TASK-056A, TASK-056, TASK-057, TASK-058, TASK-059A, TASK-059, TASK-060, TASK-061, TASK-062A, TASK-062, TASK-063, TASK-064, TASK-064A, TASK-064B, TASK-065, TASK-066, TASK-067A, TASK-067, TASK-068, TASK-069, TASK-069A, TASK-070 – TASK-077, TASK-078A, TASK-078, TASK-079A, TASK-079, TASK-080, TASK-081A, TASK-081, TASK-082A, TASK-082, TASK-083, TASK-084, TASK-085A, TASK-085, TASK-086 (116 task).

## 3. Temuan

### 3.1. [CRITICAL]

#### CR-01 [CRITICAL] [OPEN] Hash SHA-256 tanpa salt dari password tersimpan di `request_dedup`
- **File:Line**: `apps/api/src/modules/auth/setup.service.ts:81` dan `:123` (`body` berisi `password` dimasukkan ke `HttpOperation`), `apps/api/src/common/idempotency.service.ts:57`, `packages/database/src/repositories/operations.repository.ts:61` (`createHash("sha256").update(canonical(input))`) dan `:128` (`request_hash`).
- **Masalah**: request hash untuk `auth.setup`/`auth.register` dihitung dari body yang memuat password plaintext. Input lain (email, nama, instance name, method, path) sudah ada di DB, sehingga siapa pun yang dapat membaca DB/backup bisa melakukan brute-force password SUPERADMIN dan registrant PUBLIC dengan kecepatan SHA-256 GPU — melewati Argon2id. Baris dedup juga tidak pernah dipurge (lihat MJ-01). Melanggar SA §4.2 (password hanya Argon2id), §2.3 `request_dedup` ("does not store credentials"), §10.1.
- **Perbaikan**: untuk operasi `auth.*`, hitung `request_hash` sebagai HMAC-SHA256 dengan kunci server (mis. HKDF dari refresh secret) atau keluarkan `password` dari body kanonik; tambah test bahwa hash tidak dapat direproduksi dari body tanpa kunci; migrasi/purge baris `auth.*` yang sudah ada.

### 3.2. [MAJOR]

#### MJ-01 [MAJOR] [OPEN] Retensi refresh token dan dedup tidak pernah dijalankan; purge audit tidak mampu mengejar
- **File:Line**: `packages/database/src/repositories/auth.repository.ts:206` (`purgeExpired`) dan `operations.repository.ts:187` (`purge`) tanpa pemanggil; `apps/api/src/common/audit.service.ts:106` (sekali per hari) + `audit.repository.ts:90` (`take(1000)`).
- **Masalah**: `refresh_tokens` bertambah tiap rotasi dan `request_dedup` hanya dihapus saat key yang sama dipakai ulang; audit login gagal anonim (≈14.400 baris/hari/IP) melampaui purge 1000 baris/hari. Melanggar SA §2.3, §4.1 (dedup 24 jam), §10.1 (purge harian per batch 1000).
- **Perbaikan**: service retensi terjadwal (timer `unref`) yang memanggil ketiga purge dalam loop batch 1000 sampai batch terakhir pendek, dengan time budget.

#### MJ-02 [MAJOR] [OPEN] Perubahan role/status, undangan, dan reuse refresh token tidak diaudit
- **File:Line**: `apps/api/src/common/audit.service.ts:12-17` (action terdefinisi), `apps/api/src/modules/users/users.service.ts:33`, `invitations.service.ts`, `packages/database/src/repositories/auth.repository.ts:186-188`.
- **Masalah**: `user.role.change`, `user.status.change`, `invitation.create`, `auth.refresh.reuse` tidak pernah dicatat. Melanggar SA §10.1 dan PRD US-20 AC-20-01.
- **Perbaikan**: catat SUCCESS/DENIED (termasuk LAST_SUPERADMIN) setelah PATCH user, saat create/revoke undangan, dan kembalikan flag reuse dari `rotate` untuk dicatat.

#### MJ-03 [MAJOR] [OPEN] Store Redis tidak menutup soal saat pemain wajib terakhir di-kick
- **File:Line**: `apps/api/src/providers/state/lua/mutate-room.lua:126-139` vs `apps/api/src/providers/state/memory-state.store.ts:532-538`.
- **Masalah**: memory store melakukan `freeze("ALL_ANSWERED")` setelah kick; Lua hanya memfilter `requiredPlayerIds`. Pada profile `scale`, semua pemain menunggu timer + grace. Melanggar SA §5.5 dan paritas adapter §6.1.
- **Perbaikan**: di cabang kick Lua, jalankan freeze ALL_ANSWERED yang sama (bagikan logika dengan `close-question.lua`); tambah kasus ke `tests/contracts/state-parity.spec.ts`.

#### MJ-04 [MAJOR] [OPEN] Pemain tidak bisa recover saat PODIUM/FINISHED
- **File:Line**: `apps/api/src/modules/game-engine/recovery.service.ts:126` (`allocation.status !== "ACTIVE"`).
- **Masalah**: scheduler memindahkan allocation ke FINALIZING saat laporan dibekukan, sehingga refresh di layar podium/finished menghasilkan 404 dan pemain kehilangan hasil akhirnya. Melanggar SA §6.2(4) (retensi 1 jam untuk recovery) dan BR-12.
- **Perbaikan**: izinkan `ACTIVE` atau `FINALIZING` untuk recovery dengan session token; tetap `ACTIVE` untuk check_pin, friendly name, dan join baru.

#### MJ-05 [MAJOR] [OPEN] Map gateway bocor dan klien room yang dilepas tidak menerima `room:expired`
- **File:Line**: `apps/api/src/modules/game-engine/game.gateway.ts:168-169`, `:463-468` (`queues.set` tanpa delete), `:479`, `:632-643` (heartbeat); `room-scheduler.ts` release/LOST; `recovery.service.ts:113,185` (`outstanding`).
- **Masalah**: summary/queue tetap tersimpan selamanya setelah room dilepas, heartbeat `room:version` tetap dikirim setiap 5 detik (PUBLISH Redis per room), dan klien room LOST (lobby idle) tidak diberi `room:expired` (SA §5.4).
- **Perbaikan**: `forget(sessionId)` di gateway (hapus summary + queue, emit `room:expired`) dipanggil scheduler saat release/LOST melalui notifier; prune kunci `outstanding` yang kosong.

#### MJ-06 [MAJOR] [OPEN] Batas umur 8 jam di luar fase ANSWERING membuang game yang sudah dimainkan
- **File:Line**: `apps/api/src/modules/game-engine/room-scheduler.ts:193-208`.
- **Masalah**: pada ANSWER_REVEAL/LEADERBOARD/QUESTION_PREVIEW room dilepas dan ditandai LOST tanpa laporan, padahal `host:end_game` sudah bisa membawa fase-fase ini ke PODIUM. Melanggar SA §5.5 ("hard TTL expiry with state available → PODIUM EXPIRED"), BR-18, AC-14-02. Tercatat sebagai keterbatasan di log TASK-081, tetapi tetap bertentangan dengan SA.
- **Perbaikan**: operasi store atomik `expireToPodium(expectedPhaseVersion)` (memory + Lua) untuk fase pra-PODIUM non-LOBBY, lalu `game.finalize`; LOST hanya untuk LOBBY atau state hilang.

#### MJ-07 [MAJOR] [OPEN] Correct/unanswered count pemain ikut menghitung soal POLL dan ×0
- **File:Line**: `apps/api/src/modules/game-engine/score-calculator.ts:273` (`correctCount` untuk semua `isCorrect === true`), `apps/api/src/modules/game-engine/game.service.ts:110-111` (`unansweredCount` untuk semua UNANSWERED termasuk POLL/×0).
- **Masalah**: SA §4.5 menghitung keduanya hanya pada soal berpoin (non-POLL, multiplier > 0). Dampak: tie-break ranking, kolom laporan dan CSV salah. Ditemukan saat TASK-085.
- **Perbaikan**: hitung hanya bila `type !== "POLL" && pointsMultiplier > 0`; perbarui `scoring.spec.ts`, `game.service.spec.ts`, dan ekspektasi `annCorrect` di `reports.service.spec.ts`.

#### MJ-08 [MAJOR] [OPEN] Baca kuis memakai write transaction + `FOR UPDATE`, dan daftar kuis N+1
- **File:Line**: `packages/database/src/repositories/quizzes.repository.ts:62-67` (`setLock("pessimistic_write")` juga saat `mutate=false`), `:235` (`writeTransaction`), `:274-276`; `apps/api/src/modules/quizzes/quizzes.service.ts:328-335` (loop `await this.detail(...)` per item).
- **Masalah**: `GET /quizzes?limit=100` menjalankan 100 write transaction serial; viewer kuis PUBLIC memblokir PUT/room creation pemilik; item yang terhapus di antara page query dan detail membuat seluruh daftar 404. SA §2.6/§9.2 hanya mewajibkan lock untuk mutasi.
- **Perbaikan**: jalur `read()` read-only tanpa lock; summary dibangun dengan query batch (jumlah soal, cover, nama creator, playable); lewati baris yang hilang.

#### MJ-09 [MAJOR] [OPEN] `pnpm db:migrate` menolak migrasi ketika `DB_AUTO_MIGRATE=false` dan menyembunyikan penyebab
- **File:Line**: `scripts/migrate.ts:16` (`migrateDatabase(db, env.DB_AUTO_MIGRATE)`), `:21-24` (`console.error("Database migration failed")`); `packages/database/src/migrations/migration-runner.ts:43`.
- **Masalah**: perintah migrasi manual tidak pernah bisa membuat skema justru saat auto-migrate dimatikan; pesan runner yang aman (migration required, checksum mismatch, lock timeout) disembunyikan. Melanggar PRD AC-16-01/AC-16-02.
- **Perbaikan**: perintah manual memanggil `migrateDatabase(db, true)` (opsi `--check` untuk `false`) dan mencetak pesan runner melalui allow-list, tetap meredaksi error driver/URL.

#### MJ-10 [MAJOR] [OPEN] `/system/health` tidak dapat melaporkan Redis down
- **File:Line**: `apps/api/src/modules/system/system.controller.ts:53-55` dan `:93` (rate limit PUBLIC sebelum `health.check()`), `apps/api/src/common/rate-limit.service.ts` (fail-closed `DEPENDENCY_UNAVAILABLE`).
- **Masalah**: saat Redis mati, limiter gagal lebih dulu sehingga endpoint mengembalikan envelope error generik, bukan body Health 503 dengan `state.status="down"`. Melanggar SA §4.4 dan AC-16-02; SA §4.1 hanya mewajibkan fail-closed untuk auth/mutasi.
- **Perbaikan**: pada `getHealth`, tangkap `DEPENDENCY_UNAVAILABLE` dari limiter dan lanjutkan (atau limiter in-process untuk route ini).

#### MJ-11 [MAJOR] [OPEN] Endpoint laporan berhalaman memuat seluruh jawaban sesi
- **File:Line**: `apps/api/src/modules/reports/reports.service.ts:326-330` (detail), `:363-367` (players page), `:391-395` (CSV); `packages/database/src/repositories/reports.repository.ts:492-500` (`allAnswers().getMany()` termasuk `submitted_payload`).
- **Masalah**: hingga 5000 pemain × 200 soal = 1 juta baris dihidrasi per request hanya untuk akurasi 20 pemain; tier READ 120/menit → risiko DoS memori/CPU. Melanggar SA §4.5 (respons bounded) dan batas kapasitas §10.3.
- **Perbaikan**: hitung tally di SQL (`GROUP BY player_id` untuk pemain di halaman, `GROUP BY question_index, result` untuk statistik soal), baca payload hanya untuk option count soal pilihan/poll; atau simpan numerator/denominator per pemain dan per soal saat finalisasi.

#### MJ-12 [MAJOR] [OPEN] Query string laporan yang tidak valid menghasilkan 500
- **File:Line**: `packages/database/src/repositories/reports.repository.ts:405,431,464` (`*.parse(input)`), `apps/api/src/modules/reports/reports.service.ts:362`; `apps/api/src/common/error.filter.ts` hanya menangani `HttpException` dan error ber-`type`.
- **Masalah**: `?limit=abc` atau `search` terlalu panjang memicu `ZodError` → INTERNAL_ERROR 500. Melanggar SA §4.1 (400/422 untuk input) dan 00 §5 (validasi Zod di boundary).
- **Perbaikan**: validasi query di controller/service dengan `ZodValidationPipe(schema).transform(query)` sebelum gate, seperti `quizzes.service.ts:324`; tambah kasus 422 di `tests/integration/reports.spec.ts`.

#### MJ-13 [MAJOR] [OPEN] Sync finalisasi memvalidasi dan meng-hash ulang seluruh FrozenReport setiap 5 detik
- **File:Line**: `apps/api/src/modules/game-engine/room-scheduler.ts:219-226` → `apps/api/src/modules/reports/report-worker.ts:414` (`frozenReportSchema.parse`) → `packages/database/src/repositories/jobs.repository.ts:46` (`frozen()` stringify + parse + SHA-256 hingga 64 MiB).
- **Masalah**: berulang selama status belum `ready`, termasuk tanpa batas saat job FAILED menunggu retry manual; memblokir event loop semua room di instance (target p95 < 50 ms).
- **Perbaikan**: baca status job berdasarkan `session_id` lebih dulu (method ringan di `JobsRepository`), enqueue ulang hanya bila job belum ada, dan cache hash per sesi.

### 3.3. [MINOR]

| ID | Status | File:Line | Temuan | Perbaikan |
| --- | --- | --- | --- | --- |
| MN-01 | [OPEN] | `apps/api/src/common/guards/origin.guard.ts:106-114` | Limit PUBLIC `/auth/setup-status` dapat dilewati dengan trailing slash/huruf besar (Express 5 case/slash-insensitive). | Charge PUBLIC di `AuthController.status()`; hapus daftar path. |
| MN-02 | [OPEN] | `packages/database/src/repositories/operations.repository.ts:89,149,160` | Semua operasi idempoten mengambil lock global `system_settings` (serialisasi semua penulisan di PG/MySQL). | Serialisasi per key (insert-on-conflict atau lock per key). |
| MN-03 | [OPEN] | `apps/api/src/common/error.filter.ts:54-89` | Error 500 tak terduga tidak dilog; correlationId tidak dapat ditelusuri. | Log satu baris stderr terstruktur (correlationId, nama error, stack) tanpa pesan/input. |
| MN-04 | [OPEN] | `apps/api/src/modules/users/users.controller.ts:26`, `roles.guard.ts:23`, `users.service.ts:22,28` | Setiap request users melakukan 3× verifikasi JWT + `SELECT users`. | Cache hasil re-check per request. |
| MN-05 | [OPEN] | `apps/api/src/modules/quizzes/quizzes.service.ts:390-391` | PUT mengembalikan detail yang dibaca setelah commit; bisa berisi revisi milik penyimpanan lain sehingga If-Match berikutnya menimpa tanpa 409. | Bangun detail di dalam transaksi save atau assert revisi = revisi tersimpan. |
| MN-06 | [OPEN] | `quizzes.service.ts:279`, `media/media.service.ts:68` | 409 REVISION_CONFLICT tanpa `expectedRevision`/`currentRevision` (SA §9.2, §3.2 SafeParams). | Sertakan params revisi. |
| MN-07 | [OPEN] | `quizzes.service.ts:281-285` | Referensi media tidak valid dipetakan ke VALIDATION_FAILED tanpa detail, bukan 422 INVALID_REFERENCE berpath (SA §4.3). | Error bertipe berisi path → Issue INVALID_REFERENCE. |
| MN-08 | [OPEN] | `quizzes/quizzes.controller.ts:128` | Import tidak menerapkan batas 2 concurrent tier UPLOAD (SA §4.1). | `limiter.acquire("UPLOAD")` seperti upload media. |
| MN-09 | [OPEN] | `packages/database/src/repositories/media.repository.ts:153,167` | Cleanup orphan dapat terjebak pada ≥100 aset tertua yang selalu gagal dihapus (`hasMore` tidak pernah maju, SA §7.1). | Lewati baris yang baru gagal (cursor atau `last_cleanup_error_at`). |
| MN-10 | [OPEN] | `apps/api/src/providers/storage/storage.module.ts:76-78` | `/uploads` hanya melayani lokasi storage aktif; aset READY di lokasi lokal lama menjadi 404 (ADR-10, §7.1). | Layani semua lokasi lokal terdaftar. |
| MN-11 | [OPEN] | `media/media-gc.service.ts:144`; `quizzes/quiz-export.ts:45` | Replay cleanup dengan key sama → IDEMPOTENCY_CONFLICT (SA reserve untuk hash berbeda); nama file export `<id>.kabukineko.json` vs SA §7.2 `quiz-<id>.kabukineko.json` (cocok dengan `docs/import-format.md`). | Selaraskan kode atau dokumen (keputusan dokumentasi). |
| MN-12 | [OPEN] | `apps/api/src/modules/game-engine/game.gateway.ts:314-321` | `attachHost` (room:sync, host:recover_room) tidak memeriksa ulang akun (`jwt.current`), host yang dinonaktifkan tetap menerima push host-only (SA §5.1). | `await this.jwt.current(principal)`; keluarkan socket dari room host bila gagal. |
| MN-13 | [OPEN] | `game.gateway.ts:426-434` | `room:time` dari host tidak memperbarui lobby idle (SA §6.2(4)). | Operasi store atomik `touchLobby` untuk host terikat di LOBBY. |
| MN-14 | [OPEN] | `game.gateway.ts:513-517,560` | Push duplikat dengan eventId baru setelah restart/multi-instance (summary per proses kosong). | Seed summary tanpa emit, atau emit hanya oleh pemegang lease. |
| MN-15 | [OPEN] | `game.gateway.ts:383-385`, `:254-262` | Socket yang di-rebind ke pemain lain meninggalkan pemain lama `connected=true` (masuk required set). | Tandai binding lama disconnected dan keluar dari room-nya. |
| MN-16 | [OPEN] | `apps/api/src/providers/state/memory-state.store.ts:519` | Kick pemain tak dikenal: memory → INVALID_SESSION_TOKEN 401, Lua → NOT_FOUND 404 (SA §5.2 "404 player"). | Lookup eksplisit → NOT_FOUND. |
| MN-17 | [OPEN] | `apps/api/src/modules/game-engine/game.service.ts:129-135,161` | `openedAt`/`startedAt` laporan ditebak dari jawaban pertama; soal PLAYED tanpa jawaban → null. | Simpan `questionStartedAt` di ClosedQuestion saat freeze. |
| MN-18 | [OPEN] | `packages/database/src/repositories/jobs.repository.ts:41-42,94-99`, `report-worker.ts:366` | Lease hilang/crash tidak dihitung sebagai attempt; job "poison" diklaim ulang setiap 30 detik tanpa backoff (SA §6.3). | Saat mengklaim ulang lease RUNNING yang kedaluwarsa, attempts+1 dan terapkan backoff. |
| MN-19 | [OPEN] | `room-scheduler.ts:239`, `runtime.repository.ts:268-271` | PIN, pin media, dan job READY dilepas ±1 jam lebih lambat dari SA §6.2(6). | `runtime.release` langsung setelah `releaseRoom` untuk CLOSED+READY. |
| MN-20 | [OPEN] | `packages/shared/src/constants/limits.ts:137` (`pendingAlarmMs`) | Alarm 24 jam untuk frozen report pending / job FAILED tidak ada (SA §6.2(4),(6)). | Log/metric alarm dari scheduler atau worker. |
| MN-21 | [OPEN] | `apps/api/src/modules/reports/reports.controller.ts` (loop `once(response, "drain")`) | Unduhan CSV menggantung bila klien memutus koneksi (`close`, bukan `drain`). | `pipeline(Readable.from(chunks), response)`. |
| MN-22 | [OPEN] | `reports.controller.ts` retry catch/replay | Retry gagal (409/503) ditandai DONE lalu replay mengembalikan 200 tanpa eksekusi ulang (SA §4.1). | Jangan tandai DONE untuk kegagalan yang di-rollback, atau replay status tersimpan. |
| MN-23 | [OPEN] | `scripts/lib/locale-packages.ts:604-612`; migrasi `0001-initial.ts` (`session_questions.close_reason`, `questions.video_*`); `migration-runner.ts:60-66` | Validator hanya mewajibkan built-in `en` (bukan enam); CHECK enum/range SA §2.1 tidak ada; runner tanpa preflight tabel asing & gerbang MySQL ≥ 8.0.16. | Konstanta `BUILTIN_LOCALES`; migrasi 0002 + dukungan multi-versi runner; preflight. |
| MN-24 | [OPEN] | `system.controller.ts:132,136`; `reports` (minor quality) | CLEANUP rate limit per user (SA: per instance); `retryable` pending tidak konsisten (`report-finalizer.ts` false vs worker/service true); Redis `acknowledgeDurableReport` tidak mengembalikan TTL setelah `PERSIST` (SA §6.2(4)). | Key konstan `"instance"`; seragamkan `retryable`; set TTL retensi setelah ack durable. |

## 4. Area yang dinyatakan sesuai

- **Auth/boundary**: 12 route auth/users sesuai SA §4.2 (status, ETag/If-Match, kode replay); JWT HS256 dipin, secret/audience terpisah, `ver`/`is_active` dicek tiap request; rotasi refresh dengan lock, deteksi reuse mencabut family, expiry absolut 7 hari; cookie HttpOnly/SameSite=Lax/Path; Argon2id m=65536 t=3 p=1 dengan antrean terbatas; Origin + `X-Kabuki-Client` wajib untuk non-GET; tier rate limit sesuai SA dan fail-closed; setup/register/last-SUPERADMIN atomik; DTO allowlist dan kolom rahasia `select:false`.
- **Kuis/media**: route, tier, status, idempotency key, If-Match sesuai §4.3–§4.4; IDOR ditolak (PRIVATE 404, mutasi PUBLIC milik lain 403, media milik sendiri saja); bulk save dengan urutan lock §2.6; race penghapusan media §9.6 tertangani; storage key ketat dengan realpath/`O_NOFOLLOW`; validasi upload (cap byte, sniff MIME, tanpa SVG/animasi, Sharp/ffprobe dibatasi); import dibatasi ukuran/kedalaman/issue; export allowlist dan nama file ASCII; tidak ada SSRF.
- **Game engine**: rumus skor, ambang 500 ms, kredit parsial C/K, bonus streak, aturan POLL/×0, grace window, ranking dengan cross-product; proyeksi per role berbasis allowlist (ADR-04); paritas admission jawaban memory/Lua; freeze/commit dua tahap dengan CAS tanpa skor ganda; perintah host diotorisasi ulang; binding pemain berbasis generasi; batas payload socket.
- **Laporan**: gate 404/409/503 dan host-only; analitik akurasi berbobot, null untuk denominator 0, urutan hardest; CSV 18 kolom, BOM, CRLF, guard formula; lease 30 s/renew 10 s/konkurensi 2/backoff 1/5/30/120/600; persist satu transaksi dan reportId hanya setelah commit; retry idempoten per user.
- **Sistem/DB**: paritas 17 tabel ERD di tiga dialek (kolom, tipe, default, index, FK, cascade); runner migrasi dengan lock per dialek dan checksum; data-source (WAL, `BEGIN IMMEDIATE`, READ COMMITTED, retry deadlock); settings SUPERADMIN-only dengan If-Match; health dengan timeout/cache tanpa kebocoran internal; validator lokalisasi ketat (UTF-8, ICU, placeholder, batas byte/AST); konfigurasi TS/ESLint ketat.

## 5. Rekomendasi

1. Prioritaskan CR-01 (keamanan kredensial) lalu MJ-07, MJ-12, MJ-03, MJ-04, MJ-06 (kebenaran data/game) sebelum UI Fase 5 bergantung pada perilaku ini.
2. Kerjakan perbaikan lewat `/vibe-review --fix` (memperbarui status di dokumen ini) atau sebagai task korektif kecil di `04-tasks.md` agar tetap 1–4 file per task.
3. Temuan `[MINOR]` dapat dijadwalkan bersama task Fase 6 (hardening) yang menyentuh file yang sama.
