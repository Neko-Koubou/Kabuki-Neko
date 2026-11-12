# 06 — Code Review: Kabuki Neko (seluruh Fase 1–6)

> **Verdict**: **CHANGES REQUESTED** — 2 `[CRITICAL]`, 30 `[MAJOR]`, 50 `[MINOR]` terbuka.

Tanggal review: **2026-11-12 (Asia/Jakarta)**, commit `a8651cc` (branch `main-nv6b09`). Ini review ulang dari awal yang menggantikan review 2026-11-08 (commit `3c960cc`, Fase 1–3). Setiap temuan lama diverifikasi ulang terhadap kode saat ini dan tetap memakai ID lamanya.

## 1. Metode dan cakupan

**Dasar pembanding:**
- [00-project-context.md](00-project-context.md) §5;
- [01-prd.md](01-prd.md);
- [02-design-spec.md](02-design-spec.md) (lima state UI L/E/I/P/X per layar, aksesibilitas, katalog);
- [03-system-analysis.md](03-system-analysis.md) (§2–§10, ADR);
- log [05-implementation-log.md](05-implementation-log.md).

**Lima reviewer statis bekerja paralel, masing-masing dengan cakupan eksklusif:**
- (a) verifikasi ulang CR-01 dan MJ-01–MJ-13;
- (b) verifikasi ulang MN-01–MN-24;
- (c) perubahan API dan shared sejak `3c960cc`;
- (d) aplikasi web `apps/web` (TASK-087–TASK-164);
- (e) infra, scripts, CI, dan dokumentasi operasional (TASK-112–TASK-182).

Setiap temuan `[CRITICAL]`/`[MAJOR]` diverifikasi dua kali terhadap kode sebelum dicatat.

**Hasil audit keamanan** (`security-audit` run-1) digabungkan ke dokumen ini:
- profil quick, 5 temuan terkonfirmasi;
- reproduksi lokal di sandbox tanpa jaringan;
- laporan lengkap di scratchpad sesi: `security-audit/kabuki-neko/run-1/REPORT.md`.

Pemetaannya:
- *high* → CR-02;
- *medium* → MJ-15;
- *low* → CR-01 (rubrik review tetap CRITICAL karena kredensial), MN-12, dan MN-01.

**Bukti runtime terakhir (TASK-181):**
- lint, typecheck, unit (web 436/436), build, Compose config, dan E2E 54/54 PASS;
- contracts dan integration PASS dengan image MinIO lokal; satu kasus `system.spec` gagal karena keterbatasan container root.

**Severity:**
- `[CRITICAL]`: celah keamanan yang dapat dieksploitasi, atau kehilangan/korupsi data;
- `[MAJOR]`: pelanggaran spesifikasi atau bug berdampak nyata;
- `[MINOR]`: deviasi kecil atau hardening.

Status `[OPEN]` → `[RESOLVED]` diperbarui per perbaikan.

## 2. Reviewed Tasks

Seluruh 218 task `[x]` di [04-tasks.md](04-tasks.md):
- **TASK-001 – TASK-182**, termasuk semua sub-task A/B/C (27 A, 6 B, 3 C);
- **Fase 1–3** (116 task) direview 2026-11-08, lalu diverifikasi ulang di sini;
- **Fase 4–6** (TASK-087A – TASK-182, 102 task) direview pertama kali di sini.

## 3. Temuan

### 3.1. [CRITICAL]

#### CR-01 [CRITICAL] [RESOLVED] Hash SHA-256 tanpa salt dari password tersimpan di `request_dedup`
- **File:Line**:
  - `apps/api/src/modules/auth/setup.service.ts:73-82`, `:115-124`;
  - `apps/api/src/common/idempotency.service.ts:49-60`;
  - `packages/database/src/repositories/operations.repository.ts:44-62`, `:128`.
- **Masalah**:
  - Body setup/register yang berisi `password` di-hash dengan SHA-256 tanpa kunci, lalu disimpan di `request_dedup.request_hash`.
  - Field lain bisa direkonstruksi dari DB, jadi salinan DB memungkinkan tebakan password sekitar 37.000–126.000× lebih murah daripada Argon2id. Ini terbukti lokal oleh audit keamanan.
  - Baris tidak pernah dipurge (MJ-01).
  - Melanggar SA §2.3, §4.2, §10.1.
- **Perbaikan**:
  - Ganti `password` di body yang di-hash dengan HMAC-SHA256 berkunci server (diturunkan dari refresh secret). Dengan begitu, konflik key sama + password berbeda tetap terdeteksi.
  - Lakukan hal yang sama untuk `inviteCode`.
  - Tambahkan migrasi atau purge yang menghapus baris `auth.setup`/`auth.register` lama.
  - Test: `request_hash` ≠ SHA-256 body plaintext, dan password berbeda dengan key sama → 409.
- **Resolusi**:
  - `RefreshService.credentialFingerprint` menghitung HMAC-SHA256 dengan kunci HKDF dari refresh secret, yang tidak pernah masuk DB.
  - `SetupService` meng-hash body setup/register dengan `passwordFingerprint` (dan `inviteFingerprint`) sebagai pengganti plaintext.
  - Spec baru di `setup.service.spec.ts` membuktikan `request_hash` ≠ hash body plaintext dan ≠ tebakan SHA-256 tanpa kunci, serta bahwa key sama dengan password berbeda tetap `IDEMPOTENCY_CONFLICT`.
  - Receipt lama (DONE, kedaluwarsa 24 jam) dihapus oleh purge retensi MJ-01.

#### CR-02 [CRITICAL] [RESOLVED] Rute media MinIO di origin aplikasi → stored XSS dan pencurian sesi (overlay TLS + profil scale)
- **File:Line**:
  - `docker/Caddyfile:60-62` (`handle /kabuki-neko-media/*` → `reverse_proxy minio:9000` tanpa header atau filter);
  - `docker/docker-compose.tls.yml:24` (`S3_PUBLIC_URL` berada di origin aplikasi);
  - `docker/docker-compose.yml:230` (GetObject anonim);
  - `apps/api/src/modules/media/media-processor.ts:159,319` (audio disimpan byte-per-byte).
- **Masalah**:
  - MP3 polyglot yang berisi `<script>` di tag ID3 diterima pipeline upload (ffprobe asli).
  - `GET …/kabuki-neko-media/audio/<id>.mp3?response-content-type=text/html` mengembalikan `200 text/html` tanpa CSP sandbox di origin aplikasi. Ini direproduksi dua kali secara independen.
  - Skrip di halaman itu dapat memanggil `POST /api/v1/auth/refresh` dengan cookie korban dan membaca `accessToken`.
  - Rute ini juga meneruskan PUT/DELETE/POST ke MinIO.
- **Perbaikan**: di blok media Caddyfile:
  - tolak metode selain GET/HEAD (405);
  - `rewrite * {path}?` agar query `response-*` dibuang;
  - `header_down` untuk CSP `default-src 'none'; frame-ancestors 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, dan CORP `same-site`.
  - Verifikasi di sandbox MinIO + Caddy (`caddy validate`, override diabaikan, header ada, 405).
- **Resolusi**: blok `/kabuki-neko-media/*` di `docker/Caddyfile` kini menolak metode selain GET/HEAD (405), membuang query (`rewrite * {path}?`), dan menambahkan CSP sandbox, nosniff, `Content-Disposition: attachment`, serta CORP `same-site`.
  - **Bukti**: `caddy fmt` tidak mengubah apa pun dan `caddy validate` mengembalikan Valid.
  - Di sandbox MinIO (commit dipin) + Caddy dengan Caddyfile repo, GET anonim `?response-content-type=text/html&response-content-disposition=inline` → `200 audio/mpeg` dengan CSP sandbox dan `attachment`.
  - PUT/DELETE/POST → 405, padahal sebelumnya `text/html`/`inline` tanpa CSP dan 403/400 dari MinIO.

### 3.2. [MAJOR]

#### MJ-01 [MAJOR] [RESOLVED] Retensi refresh token dan dedup tidak pernah dijalankan; purge audit tidak mampu mengejar
- **File:Line**:
  - `packages/database/src/repositories/auth.repository.ts:206-213`;
  - `operations.repository.ts:187-201`;
  - `apps/api/src/common/audit.service.ts:85-108`;
  - `audit.repository.ts:74-96`.
- **Masalah**:
  - `purgeExpired` dan `OperationsRepository.purge` tidak pernah dipanggil.
  - Audit dipurge 1000 baris per 24 jam, padahal kegagalan login anonim bisa jauh lebih banyak.
  - Melanggar SA §2.3, §4.1, §10.1.
- **Perbaikan**: `RetentionService` terjadwal (timer `unref`) yang menjalankan ketiga purge dalam batch 1000 sampai batch terakhir pendek, dengan time budget.
- **Resolusi**:
  - `apps/api/src/common/retention.service.ts` (didaftarkan di `CommonModule`) berjalan saat boot lalu tiap jam. Ia mengulang `AuditService.purge`, `OperationsRepository.purge`, dan `AuthRepository.purgeExpired` (kini dibatasi 1000 baris per transaksi) selama batch penuh, dengan budget 30 s.
  - Kegagalan purge ditulis sebagai satu baris JSON stderr tanpa detail internal, dan purge lain tetap berjalan.
  - Jadwal harian lama di `AuditService` dihapus.
  - `retention.service.spec.ts` membuktikan 2500 audit, 1200 receipt, dan 1500 token terhapus dalam satu run, sementara baris aktif/PENDING tetap ada. Spec yang sama mencakup batas budget, isolasi kegagalan, dan siklus jadwal.
  - Jest API 231/231, tsc, dan lint PASS; contract `operations.repository` (3 DB) PASS.

#### MJ-02 [MAJOR] [OPEN] Perubahan role/status, undangan, dan reuse refresh token tidak diaudit
- **File:Line**:
  - `apps/api/src/common/audit.service.ts:12-17`;
  - `apps/api/src/modules/users/users.service.ts:27-42`;
  - `invitations.service.ts:29-76`;
  - `packages/database/src/repositories/auth.repository.ts:186-188`.
- **Masalah**: `user.role.change`, `user.status.change`, `invitation.create`, dan `auth.refresh.reuse` tidak pernah dicatat. Melanggar SA §10.1 dan AC-20-01.
- **Perbaikan**:
  - Inject `AuditService` ke users/invitations dan catat SUCCESS/DENIED (`LAST_SUPERADMIN`).
  - `rotate` membedakan reuse lalu mencatat `auth.refresh.reuse`.
  - Room/quiz/report menjadi tindak lanjut.

#### MJ-03 [MAJOR] [OPEN] Store Redis tidak menutup soal saat pemain wajib terakhir di-kick
- **File:Line**: `apps/api/src/providers/state/lua/mutate-room.lua:126-139` vs `memory-state.store.ts:532-538`.
- **Masalah**:
  - Memory store melakukan freeze `ALL_ANSWERED` setelah kick; Lua tidak.
  - Akibatnya, di profil scale semua pemain menunggu timer.
  - Melanggar paritas SA §5.5/§6.1.
- **Perbaikan**: setelah ACK kick, `GameService` menjalankan `closeQuestion(ALL_ANSWERED)` bila semua pemain wajib sudah menjawab, lalu `settle`.
  - Kasus paritas di `state-parity.spec.ts`.

#### MJ-04 [MAJOR] [OPEN] Pemain tidak bisa recover saat PODIUM/FINISHED
- **File:Line**: `apps/api/src/modules/game-engine/recovery.service.ts:122-131`.
- **Masalah**: allocation berpindah ke FINALIZING saat laporan dibekukan, sehingga recovery dengan token menghasilkan 404. Melanggar SA §6.2(4) dan BR-12.
- **Perbaikan**: recovery dengan `sessionToken` menerima `ACTIVE|FINALIZING`. `check_pin`, friendly name, dan join baru tetap hanya `ACTIVE`.

#### MJ-05 [MAJOR] [OPEN] Map gateway bocor dan klien room yang dilepas tidak menerima `room:expired`
- **File:Line**:
  - `apps/api/src/modules/game-engine/game.gateway.ts:168-169,463-480,631-644`;
  - `room-scheduler.ts:181-186,211-215,248-258`;
  - `recovery.service.ts:113,160-161`.
- **Masalah**:
  - `queues`/`summaries` tidak pernah dihapus, dan heartbeat tetap dikirim.
  - Room LOST atau yang dilepas tidak pernah mengirim `room:expired`.
  - Alasan selalu `ROOM_LOST`.
- **Perbaikan**:
  - `GameGateway.forget(identity, reason)` dipanggil scheduler melalui notifier saat LOST/release.
  - Prune `outstanding`.

#### MJ-06 [MAJOR] [OPEN] Batas umur 8 jam di luar fase ANSWERING membuang game yang sudah dimainkan
- **File:Line**: `apps/api/src/modules/game-engine/room-scheduler.ts:197-216`.
- **Masalah**: hard TTL pada fase PREVIEW/REVEAL/LEADERBOARD/COUNTDOWN berakhir LOST tanpa laporan. Melanggar SA §5.5, BR-18, dan AC-14-02.
- **Perbaikan**:
  - Operasi atomik `expireToPodium` (memory + Lua) untuk fase pra-PODIUM non-LOBBY, lalu `game.finalize`.
  - LOST hanya untuk LOBBY atau state yang hilang.

#### MJ-07 [MAJOR] [OPEN] `correctCount`/`unansweredCount` ikut menghitung soal ×0 (dan POLL untuk unanswered)
- **File:Line**: `apps/api/src/modules/game-engine/score-calculator.ts:273`; `game.service.ts:110-111`.
- **Masalah**:
  - Jawaban benar di soal ×0 menambah `correctCount`, yang dipakai sebagai tie-break.
  - UNANSWERED dihitung juga untuk POLL dan ×0.
  - Melanggar SA §4.5.
- **Perbaikan**: hitung keduanya hanya bila `type !== "POLL" && pointsMultiplier > 0`, lalu perbarui spec skor, game, dan laporan.

#### MJ-08 [MAJOR] [OPEN] Baca kuis memakai write transaction + `FOR UPDATE`, dan daftar kuis N+1
- **File:Line**:
  - `packages/database/src/repositories/quizzes.repository.ts:62-73,231-238,274-289`;
  - `apps/api/src/modules/quizzes/quizzes.service.ts:290-291,322-339`.
- **Masalah**:
  - `GET /quizzes?limit=100` menjalankan 100 write transaction serial.
  - Viewer PUBLIC memblokir PUT milik pemilik.
  - Kuis yang terhapus di tengah proses membuat seluruh daftar menjadi 404.
- **Perbaikan**: jalur `read` tanpa lock/transaksi tulis, dan summary batch yang melewati baris yang hilang.

#### MJ-10 [MAJOR] [OPEN] `/system/health` tidak dapat melaporkan Redis down
- **File:Line**: `apps/api/src/modules/system/system.controller.ts:53-57,91-97`; `apps/api/src/common/rate-limit.service.ts:77-95`.
- **Masalah**: limiter gagal lebih dulu (`DEPENDENCY_UNAVAILABLE`) sehingga body Health 503 tidak pernah dikirim. Melanggar SA §4.4 dan AC-16-02.
- **Perbaikan**: di `getHealth`, abaikan `DEPENDENCY_UNAVAILABLE` dari limiter. 429 tetap diteruskan.

#### MJ-11 [MAJOR] [OPEN] Endpoint laporan berhalaman memuat seluruh jawaban sesi
- **File:Line**: `apps/api/src/modules/reports/reports.service.ts:322-330,359-367,389-395`; `reports.repository.ts:323-333`.
- **Masalah**: hingga 1 juta baris (termasuk payload) dihidrasi per request hanya untuk 20 pemain. Melanggar SA §4.5 dan §10.3.
- **Perbaikan**: tally lewat `GROUP BY` di SQL. Payload hanya dibaca untuk hitungan opsi soal pilihan.

#### MJ-12 [MAJOR] [OPEN] Query string laporan yang tidak valid menghasilkan 500
- **File:Line**: `packages/database/src/repositories/reports.repository.ts:237,263,296`; `reports.service.ts:362`; `error.filter.ts:55-83`.
- **Masalah**: `ZodError` dari `.parse()` menjadi `INTERNAL_ERROR` 500. Melanggar SA §4.1.
- **Perbaikan**: validasi query di service dengan `ZodValidationPipe` (422).

#### MJ-13 [MAJOR] [OPEN] Sync finalisasi memvalidasi dan meng-hash ulang seluruh FrozenReport setiap 5 detik
- **File:Line**: `room-scheduler.ts:226-234` → `report-worker.ts:239-279` → `jobs.repository.ts:20-58`.
- **Masalah**: `parse` + stringify + SHA-256 hingga 64 MiB, dengan event loop terblokir, terus berulang selama status bukan `ready` (termasuk FAILED tanpa batas).
- **Perbaikan**:
  - `JobsRepository.statusOf(sessionId)` yang ringan.
  - Enqueue hanya bila belum ada job.
  - Jalur job yang sudah ada hanya membaca `payload_hash`.

#### MJ-14 [MAJOR] [OPEN] Unduhan CSV menggantung (dan membocorkan memori) bila klien memutus koneksi (eks-MN-21)
- **File:Line**: `apps/api/src/modules/reports/reports.controller.ts:164`; `reports.service.ts:406`.
- **Masalah**:
  - `await once(response, "drain")` tidak pernah selesai setelah `close`.
  - Array CSV penuh beserta request tertahan selamanya, dan bisa dipicu 10×/menit.
- **Perbaikan**: `pipeline(Readable.from(chunks), response)` dari `node:stream/promises`.

#### MJ-15 [MAJOR] [OPEN] Event socket anonim memenuhi map rate-limiter in-memory → 503 global
- **File:Line**: `apps/api/src/modules/game-engine/game.gateway.ts:214,265-272,281`; `apps/api/src/common/rate-limit.service.ts:100`.
- **Masalah**:
  - Tier SYNC/TIME/ANSWER/AVATAR tanpa binding dikunci pada `socket.id`, dan limiter dibebankan sebelum validasi.
  - Satu klien anonim bisa mengisi cap 100.000 key, sehingga login/PIN/REST untuk principal baru → 503.
  - Ini medium di audit keamanan, direproduksi dua kali.
- **Perbaikan**:
  - Kunci tier anonim ke IP, atau ke `playerId` bila sudah terikat.
  - Event yang butuh binding ditolak sebelum limiter.
  - Test: N socket dari satu IP hanya menambah key dalam jumlah konstan.

#### MJ-16 [MAJOR] [OPEN] Kegagalan finalisasi tidak memicu alarm atau metrik
- **File:Line**: `apps/api/src/common/metrics.service.ts:61`; `apps/api/src/modules/reports/report-worker.ts:192-216`; `room-scheduler.ts:244`.
- **Masalah**:
  - `MetricsService.reportJobFailed` tidak pernah dipanggil.
  - Kegagalan job setelah 5 percobaan tidak terlihat oleh operator.
  - Alarm 24 jam hanya berupa teks tanpa struktur.
  - Melanggar SA §10.1.
- **Perbaikan**:
  - Inject `MetricsService` ke `ReportWorker` dan panggil `reportJobFailed(code)` setelah `jobs.fail`.
  - Alarm 24 jam dikirim sebagai event terstruktur.

#### MJ-17 [MAJOR] [OPEN] Gate startup DB/Redis di entrypoint tidak berjalan ketika profil memilih driver
- **File:Line**: `docker/entrypoint.sh:109-114`; `docs/deployment.md:29-30`.
- **Masalah**:
  - Gate hanya membaca `DB_DRIVER`/`STATE_DRIVER` mentah, padahal Compose hanya menyetel `DEPLOYMENT_PROFILE`. Akibatnya gate tidak pernah jalan di profil scale.
  - Dokumen menjanjikan timeout yang tidak terjadi.
- **Perbaikan**:
  - Turunkan driver efektif: default `postgres`/`redis` bila `DEPLOYMENT_PROFILE=scale` dan variabel kosong.
  - Validasi `KN_STARTUP_WAIT_SEC` (MN-32).
  - Koreksi dokumen.

#### MJ-18 [MAJOR] [OPEN] Prosedur restore SQLite di dokumentasi menghasilkan DB yang tidak bisa ditulis API
- **File:Line**: `docs/operations.md:40-50`.
- **Masalah**:
  - `docker compose cp` tanpa `-a` meninggalkan pemilik root/0644, sehingga API (uid 10001) gagal menulis.
  - `backup.sqlite` tertinggal di volume data.
- **Perbaikan**:
  - Restore lewat `compose run` sebagai user image (`cp` dari mount `/backup:ro`, hapus WAL/SHM).
  - Backup ditulis ke `/tmp` lalu dihapus.

#### MJ-19 [MAJOR] [OPEN] Rotasi secret di dokumentasi tidak berlaku untuk profil scale
- **File:Line**: `docs/operations.md:116-117`; `docs/deployment.md:81-84`; `docker/docker-compose.yml:36-58`.
- **Masalah**:
  - Compose tidak meneruskan `JWT_*`/`*_FILE` ke API, dan entrypoint tetap memuat file di volume `kabuki-secrets`.
  - Karena itu, "rotasi" setelah backup bocor tidak mengganti secret.
- **Perbaikan**: dokumentasikan rotasi dengan menghapus `jwt_*_secret` dari volume secrets lalu `up -d` (secrets-init membuat ulang). Untuk profil default, hapus `runtime-secrets.json`.

#### MJ-20 [MAJOR] [OPEN] Job CI `drivers` gagal di runner bersih: `catalog-deployment.spec` butuh image yang tidak pernah dibangun
- **File:Line**: `.github/workflows/ci.yml:114-121`; `tests/integration/catalog-deployment.spec.ts:86-105`.
- **Masalah**: spec memanggil `docker run kabuki-neko-api:local` tanpa build, dan job menjalankan integration paralel.
- **Perbaikan**: langkah CI yang membangun kedua image sebelum Integration.

#### MJ-21 [MAJOR] [OPEN] Build image gagal setelah Debian memperbarui ffmpeg (pin versi apt eksak)
- **File:Line**: `docker/Dockerfile.api:34,42,63`; `docker/Dockerfile.web:28,36`.
- **Masalah**:
  - Mirror bookworm hanya menyimpan versi terkini, sehingga `ffmpeg=7:5.1.9-0+deb12u1` akan "not found".
  - Self-hoster wajib build dari source.
- **Perbaikan**:
  - Pasang ffmpeg tanpa pin versi eksak (paket keamanan terbaru dari repo resmi).
  - Verifikasi `ffprobe -version` saat build.
  - Catat versi aktual di inventaris image.

#### MJ-22 [MAJOR] [RESOLVED] Socket host tidak pernah memperbarui access token (perintah host gagal setelah 15 menit)
- **File:Line**: `apps/web/src/components/host/host-stage.tsx:93-97,176`; `apps/web/src/hooks/use-socket.ts:313-316`; `host-phase-controls.tsx:90`.
- **Masalah**:
  - Server memeriksa ulang token pada tiap perintah host, padahal token berumur 900 s.
  - Klien hanya mengirim `auth:update` saat recovery 401. Setelah 15 menit, Start/Next/Skip/End gagal `TOKEN_EXPIRED`, dan reconnect memakai token kedaluwarsa selamanya.
- **Perbaikan**:
  - Pada `TOKEN_EXPIRED`/`TOKEN_REVOKED`/`AUTH_REQUIRED`: refresh token → `auth:update` → kirim ulang sekali dengan `requestId` yang sama.
  - Handshake reconnect host memakai token terbaru.
- **Resolusi**:
  - `createHostCommands` menerima `renewAuth`. Untuk `TOKEN_EXPIRED`/`TOKEN_REVOKED`/`AUTH_REQUIRED`, perintah memperbarui token (`reloadPrincipal` → refresh REST), mengirim `auth:update`, lalu mengirim ulang sekali dengan `requestId` yang sama. Bila renew gagal, error aslinya dikembalikan.
  - `useGameSocket` mendapat opsi `onAuthError`: `connect_error` berkode auth menunggu refresh token sebelum reconnect, sehingga handshake berikutnya membawa token baru. Host stage memakai keduanya.
  - Spec baru `host-stage.spec.ts` (3 test) dan `use-socket.spec.tsx` (2 test).
  - Web Vitest 51 file / 444 test, tsc, dan lint PASS.

#### MJ-23 [MAJOR] [OPEN] Socket anonim halaman join diputus server setelah 120 s dan tidak pernah tersambung lagi
- **File:Line**: `apps/web/src/components/player/pin-join-scanner.tsx:118-125,141-145`; `apps/web/src/lib/socket-client.ts:106`.
- **Masalah**: `reconnection: false` ditambah batas umur anonim 120 s menyebabkan cek PIN atau join gagal ("unknown") sampai halaman dimuat ulang. Ini skenario umum di kelas.
- **Perbaikan**: sambungkan ulang bila `!socket.connected` sebelum `emit`.

#### MJ-24 [MAJOR] [RESOLVED] Media unggahan tidak pernah tampil: MediaPreview menolak URL absolut dari API
- **File:Line**: `apps/web/src/components/ui/media-preview.tsx:58-71,120` (dipakai di player, projector, picker, library, dan detail jawaban).
- **Masalah**: API mengembalikan `publicUrl` absolut (`${NEXT_PUBLIC_API_URL}/uploads/…` atau URL S3), sementara `allowedOrigins` default `[]`. Akibatnya selalu tampil "media isn't available".
- **Perbaikan**: default `allowedOrigins` berisi origin `NEXT_PUBLIC_API_URL` ditambah origin media publik (`NEXT_PUBLIC_MEDIA_ORIGINS`).
- **Resolusi**:
  - `apps/web/src/lib/media-origins.ts` (`publicMediaOrigins`) menggabungkan origin API dan `NEXT_PUBLIC_MEDIA_ORIGINS` (hanya http(s), path diabaikan). Ini menjadi default `MediaPreview.allowedOrigins`.
  - CSP halaman (`proxy.ts`) memakai daftar yang sama ditambah `CSP_MEDIA_ORIGINS`, sehingga media MinIO profil scale tidak lagi diblokir CSP.
  - `Dockerfile.web` menerima build arg `NEXT_PUBLIC_MEDIA_ORIGINS`. Compose mengisinya dari `KN_MEDIA_PUBLIC_URL`, dan overlay TLS dari `https://KN_DOMAIN/kabuki-neko-media`.
  - Spec baru membuktikan URL `/uploads` absolut dari API dan basis bucket ter-render secara default, sedangkan origin asing tetap ditolak.
  - Web Vitest, tsc, dan lint PASS; E2E `security-headers` 8/8; Compose config default + TLS PASS.

#### MJ-25 [MAJOR] [OPEN] `publicRevision` snapshot tidak ikut maju oleh event → `room:sync` penuh berulang
- **File:Line**: `apps/web/src/stores/game.store.ts:157-161,360-366`; `connection-recovery.tsx:64,200`.
- **Masalah**: heartbeat selalu terlihat lebih baru, sehingga semua klien (hingga 200) meminta snapshot penuh beberapa kali per soal. Selama itu UI menjadi `inert` ("Catching up…").
- **Perbaikan**: event room-scope memajukan `publicRevision`. Event khusus host tidak.

#### MJ-26 [MAJOR] [OPEN] Kegagalan recovery non-terminal diabaikan: tanpa backoff, `retryAfter` diabaikan, tanpa tombol Retry
- **File:Line**: `apps/web/src/hooks/use-session-recovery.ts:239-241,262-268`; `connection-recovery.tsx:140-145`.
- **Masalah**: RATE_LIMITED/DEPENDENCY_UNAVAILABLE membuat pemain macet di "Connecting…" atau mengulang join tiap ±2 s. Melanggar SA §5.1.
- **Perbaikan**:
  - Jadwalkan `recover` single-flight dengan `backoffDelay(attempt, retryAfterMs)`.
  - Tampilkan Retry/Leave.

#### MJ-27 [MAJOR] [OPEN] Reconnect pemain mengirim `room:sync` sebelum rejoin → join ganda
- **File:Line**: `apps/web/src/stores/game.store.ts:407-414`; `use-session-recovery.ts:293-305`; `use-socket.ts:301-304`.
- **Masalah**: socket yang belum terikat mendapat AUTH_REQUIRED lalu `recover()` kedua, sehingga token CHECK_JOIN terpakai dua kali per reconnect.
- **Perbaikan**: `recover` single-flight; `sync` pemain ditunda sampai rebind.

#### MJ-28 [MAJOR] [OPEN] `player:session_replaced` menghapus kredensial yang dipakai tab pengganti
- **File:Line**: `apps/web/src/hooks/use-session-recovery.ts:306-316`; `connection-recovery.tsx:117-122`.
- **Masalah**: kedua tab berbagi key localStorage yang sama. Tab lama menghapus record, sehingga tab baru tidak bisa recover.
- **Perbaikan**: jangan hapus storage untuk `session_replaced`. Tetap hapus untuk `INVALID_SESSION_TOKEN`.

#### MJ-29 [MAJOR] [OPEN] `room:expired` selalu dibuang oleh fence revisi
- **File:Line**: `apps/web/src/stores/game.store.ts:369-391`.
- **Masalah**: server mengirim `room:expired` dengan revision/phaseVersion 1, sehingga event itu dianggap stale dan klien tidak pernah mencapai state terminal.
- **Perbaikan**: tangani `room:expired`, `player:kicked`, dan `player:session_replaced` sebelum fence (cukup cek `sessionId` + dedup `eventId`).

#### MJ-30 [MAJOR] [OPEN] Kegagalan `/auth/me` apa pun (offline, timeout, 5xx) dianggap sign-out
- **File:Line**: `apps/web/src/providers/auth-provider.tsx:240-251`.
- **Masalah**: token valid dibuang dan halaman dilindungi di-unmount, sehingga host stage kehilangan socket. Melanggar "error bukan empty" dan S17.
- **Perbaikan**: status anonim hanya untuk 401 (`AUTH_REQUIRED`/`TOKEN_REVOKED`/`TOKEN_EXPIRED`). Error lain mempertahankan token dan menampilkan error yang bisa di-retry.

#### MJ-31 [MAJOR] [OPEN] "Save and continue" studio bernavigasi saat save sebelumnya masih berjalan
- **File:Line**: `apps/web/src/components/studio/studio-editor.tsx:317`; `apps/web/src/stores/studio.store.ts` (`save`).
- **Masalah**: hasil `"skipped"` (save sedang berjalan) dianggap sukses. Bila PUT kemudian gagal, draft hilang. Melanggar M10 X.
- **Perbaikan**: save single-flight yang mengembalikan promise yang sedang berjalan kepada pemanggil konkuren.

### 3.3. [MINOR]

| ID | Status | File:Line | Temuan | Perbaikan |
| --- | --- | --- | --- | --- |
| MJ-09 | [OPEN] | `scripts/migrate.ts:16,21-24`; `migration-runner.ts:43,60` | (Turun dari MAJOR: paket Docker bermigrasi otomatis.) `pnpm db:migrate` menolak migrasi saat `DB_AUTO_MIGRATE=false` dan menyembunyikan penyebab. | `migrateDatabase(db, !--check)`; pesan runner dari allow-list. |
| MN-01 | [OPEN] | `apps/api/src/common/guards/origin.guard.ts:104-115`; `auth.controller.ts:62-66` | Limit PUBLIC `/auth/setup-status` bisa dilewati dengan variasi huruf atau slash (terkonfirmasi audit). | Charge PUBLIC di handler; hapus daftar path mati. |
| MN-02 | [OPEN] | `operations.repository.ts:89,149,160,189` | Semua operasi idempoten mengambil lock global `system_settings`. | Lock per key; lock global hanya untuk cleanup. |
| MN-03 | [OPEN] | `apps/api/src/common/error.filter.ts:50-89` | Error 500 tak terduga tidak dilog. | Satu baris JSON stderr (correlationId, name, stack tanpa pesan). |
| MN-04 | [OPEN] | `users.controller.ts:26-27`; `roles.guard.ts:22-32`; `users.service.ts:22,28` | Tiga verifikasi JWT dan `SELECT users` per request. | Memo per request untuk principal HTTP. |
| MN-05 | [OPEN] | `quizzes.service.ts:390-391` | PUT mengembalikan detail yang dibaca setelah commit. | Bangun detail di dalam transaksi atau assert revisi. |
| MN-06 | [OPEN] | `quizzes.service.ts:279`; `media.service.ts:68`; `users.service.ts:37-38` | 409 REVISION_CONFLICT tanpa params revisi. | Pola `system.service.ts:141-145`. |
| MN-07 | [OPEN] | `quizzes.service.ts:280-285` | Referensi media tidak valid → VALIDATION_FAILED tanpa path. | Error bertipe → 422 INVALID_REFERENCE + Issue. |
| MN-08 | [OPEN] | `quizzes.controller.ts:126-135` | Import tanpa lease konkurensi UPLOAD. | `limiter.acquire("UPLOAD")`. |
| MN-09 | [OPEN] | `media.repository.ts:157-187` | Cleanup orphan terjebak pada aset tertua yang selalu gagal. | Urutkan berdasarkan `updated_at, id`. |
| MN-10 | [OPEN] | `storage.module.ts:75-85` | `/uploads` hanya melayani lokasi aktif. | Coba semua lokasi lokal terdaftar. |
| MN-11 | [OPEN] | `media-gc.service.ts:121,144`; `quiz-export.ts:45` | Replay cleanup → IDEMPOTENCY_CONFLICT; nama file export ≠ SA §7.2. | Replay receipt tersimpan; selaraskan nama file atau SA. |
| MN-12 | [OPEN] | `game.gateway.ts:314-321` | `attachHost` tanpa `jwt.current` (terkonfirmasi audit, read-only). | Validasi ulang; keluar dari channel `host:*`. |
| MN-13 | [OPEN] | `game.gateway.ts:426-434` | `room:time` host tidak memperbarui lobby idle. | `touchLobby` atomik. |
| MN-14 | [OPEN] | `game.gateway.ts:471,513-560` | Push duplikat setelah restart atau multi-instance. | Seed summary tanpa emit. |
| MN-15 | [OPEN] | `game.gateway.ts:367-387` | Socket yang di-rebind meninggalkan pemain lama `connected`. | Tandai binding lama terputus dan keluar dari room-nya. |
| MN-16 | [OPEN] | `memory-state.store.ts:517-519` | Kick pemain tak dikenal: 401 di memory vs 404 di Lua. | NOT_FOUND eksplisit. |
| MN-17 | [OPEN] | `game.service.ts:129-135,161`; `private-state.schema.ts:147-156` | `openedAt`/`startedAt` ditebak dari jawaban pertama. | Simpan `questionStartedAt` di ClosedQuestion. |
| MN-18 | [OPEN] | `jobs.repository.ts:41-42,89-103` | Lease job kedaluwarsa tidak dihitung sebagai attempt dan tanpa backoff. | attempts+1 dan backoff saat klaim ulang. |
| MN-19 | [OPEN] | `room-scheduler.ts:248-258`; `runtime.repository.ts:268-271` | PIN dan media pin dilepas ±1 jam terlambat. | Release langsung untuk CLOSED+READY. |
| MN-20 | [OPEN] | `report-worker.ts` | (Sebagian diperbaiki TASK-169.) Job FAILED/PENDING tanpa state room tidak pernah memicu alarm 24 jam. | Query alarm di poll worker. |
| MN-22 | [OPEN] | `reports.controller.ts:101,109-114` | Retry gagal ditandai DONE; replay 200 tanpa eksekusi ulang. | Lepaskan reservasi saat gagal. |
| MN-23 | [OPEN] | `scripts/lib/locale-packages.ts:604-612`; migrasi `0001`; `migration-runner.ts:42-66` | (Sebagian.) Validator hanya mewajibkan `en`; CHECK `close_reason`/video belum ada; runner tanpa preflight. | Konstanta bersama; migrasi 0002; preflight. |
| MN-24 | [OPEN] | `system.controller.ts:132,136`; `report-finalizer.ts:123`; `mutate-room.lua:38-42` | CLEANUP per user (bukan per instance); `retryable` tidak konsisten; TTL Redis tidak dipulihkan. | Key `"instance"`; satu aturan; `PEXPIREAT`. |
| MN-25 | [OPEN] | `room-scheduler.ts:137-164,193` | Map/timer scheduler bocor saat instance lain mengambil lease. | `forget` saat `lead()` gagal. |
| MN-26 | [OPEN] | `room-scheduler.ts:20,235-245`; `docs/operations.md:143` | Alarm 24 jam tanpa status/errorCode dan hanya sekali per proses. | Sertakan status; ulangi tiap 24 jam. |
| MN-27 | [OPEN] | `apps/api/src/main.ts:24,56` | `securityHeaders` di modul entry, sehingga tidak bisa diuji unit. | Pindah ke `common/security-headers.middleware.ts`. |
| MN-28 | [OPEN] | `apps/web/src/hooks/use-session-recovery.ts:223,264` | Timer retry `recover()` tidak dibatalkan atau dibatasi. | Bersihkan saat cleanup; skip saat terputus. |
| MN-29 | [OPEN] | `player-game.tsx:95`; `use-socket.ts:305-334` | Halaman player membuka socket anonim walau tanpa kredensial. | Flag `enabled`. |
| MN-30 | [OPEN] | `studio-editor.tsx:348-358,475,480` | Kegagalan resolve konflik senyap dan rejection tidak ditangani. | Notice error + Retry. |
| MN-31 | [OPEN] | `user-invites.tsx:590`; `admin-settings-health.tsx:232` | Idempotency-Key baru per tekan setelah hasil tidak pasti. | Simpan key sampai respons definitif. |
| MN-32 | [OPEN] | `report-finalization-notice.tsx:99-103,157-162`; `admin-settings-health.tsx:219` | Kegagalan status laporan/locale dirender kosong. | Flag `failed` + Retry. |
| MN-33 | [OPEN] | `locale-provider.tsx:256,281-301` | Ganti bahasa bisa membuang namespace yang dimuat bersamaan. | Gabungkan namespace yang hilang setelah load. |
| MN-34 | [OPEN] | `host-stage-lobby.tsx:195`; `connection-recovery.tsx:185`; `slide-navigator.tsx:328-406`; `quiz-library-detail.tsx:413` | Copy/aria hardcoded di luar katalog. | Pesan ICU berplaceholder. |
| MN-35 | [OPEN] | `question-fields.tsx:393-397`; `question-properties.tsx:340-343` | Tombol error-summary < 44 px. | `min-h-11 inline-flex items-center`. |
| MN-36 | [OPEN] | `docker/entrypoint.sh:76-88` | `KN_STARTUP_WAIT_SEC` tidak valid → tunggu tanpa batas. | Validasi integer 1–3600. |
| MN-37 | [OPEN] | `scripts/optimize-audio.mjs:356,409,438-449` | `--concurrency 0` menimpa output dengan direktori kosong. | Validasi 1–16; assert hasil. |
| MN-38 | [OPEN] | `scripts/measure-web-budget.ts:214-245,531-535`; `tests/helpers/game.ts:195-222` | Proses API dan socket bocor. | Stop di `finally`/`catch`. |
| MN-39 | [OPEN] | `scripts/locales-template.ts:116` | Instruksi README template merusak `locales:build`. | Salin hanya `manifest.json` + namespace. |
| MN-40 | [OPEN] | `scripts/selfhost-smoke.sh:95-99,194` | Tidak jalan di bash 3.2/macOS. | Ekspansi array aman; UUID portabel. |
| MN-41 | [OPEN] | `docs/deployment.md:115`; `docs/self-hosting.md:40,200` | Deskripsi healthcheck web salah; `cd kabuki-neko` gagal di FS case-sensitive. | Koreksi dokumen. |
| MN-42 | [OPEN] | `.github/workflows/ci.yml:186-189` | Overlay TLS, Caddyfile, dan smoke test tidak ada di CI. | Langkah config TLS + `caddy validate`. |
| MN-43 | [OPEN] | `scripts/benchmark-game.ts:138-146` | Verdict benchmark mengabaikan jawaban ditolak dan laporan tidak durable. | Tambahkan alasan gagal. |
| MN-44 | [OPEN] | `scripts/migrate.ts:21-24` | `db:migrate` menyembunyikan field konfigurasi dan tanpa doc comment. | Cetak `fields`/kode; header comment. |
| MN-45 | [OPEN] | `docker/Dockerfile.api:48`; `Dockerfile.web:42` | pnpm dipasang tanpa verifikasi integritas. | corepack. |
| MN-46 | [OPEN] | `docker/docker-compose.yml:61-106,141-172` | Tanpa `no-new-privileges`/`cap_drop`/`read_only` pada api, web, dan data. | Hardening per service. |
| MN-47 | [OPEN] | `docker/docker-compose.yml:68-71,250-256` | Named volume vs bind mount di SA §10.2. | Perbarui SA/ADR. |
| MN-48 | [OPEN] | `.github/workflows/ci.yml`; `.dockerignore` | `persist-credentials` default; pola `.dockerignore` tanpa `**/` (hardening audit). | `persist-credentials: false`; prefix `**/`. |
| MN-49 | [OPEN] | `docker/docker-compose.yml:131-134,155-163,180` | API memakai kredensial root MinIO; Redis tanpa password; golang tanpa digest (hardening audit). | User bucket; `requirepass`; pin digest. |
| MN-50 | [OPEN] | `apps/web/src/proxy.ts:136-145`; `auth-provider.tsx:311-323`; `media.schema.ts:173-180` | Respons prefetch tanpa frame policy; token broadcast tanpa cek user; skema URL media longgar (hardening audit). | Header statis `frame-ancestors`; cek `sub`; allowlist origin. |

## 4. Area yang dinyatakan sesuai

- **Auth/boundary**: JWT HS256 dipin (iss/aud, secret terpisah) dan dicek ulang ke DB per request. Rotasi refresh memakai lock dan deteksi reuse. Cookie HttpOnly/SameSite=Lax/Path. Argon2id terbatas. Gate Origin + `X-Kabuki-Client`. Setup/register/last-SUPERADMIN atomik. Isolasi kuis/media/laporan per pemilik teruji lokal dengan tenant dummy.
- **Media**: sniff MIME, tanpa SVG/animasi, Sharp/ffprobe dibatasi (`execFile` tanpa shell, whitelist protokol). Kunci storage ketat dengan realpath/`O_NOFOLLOW`. `/uploads` diberi CSP sandbox, Content-Type tetap, dan nosniff.
- **Game engine**: rumus skor, paritas admission memory/Lua, freeze/commit dua tahap dengan CAS, perintah host diotorisasi ulang, binding pemain berbasis generasi.
- **Laporan**: gate host-only 404/409/503, CSV dengan guard formula, lease/backoff worker, persist satu transaksi.
- **Lokalisasi**: enam katalog bawaan 100% (1102 key) sesuai kontrak ICU. Paket locale diperlakukan sebagai data (symlink ditolak, JSON ketat, AST tanpa markup). Katalog klien diverifikasi SHA-256.
- **Web**: tanpa sink HTML. `safeReturnTo`, QR, dan YouTube teruji. CSP nonce + `strict-dynamic`. Access token hanya di memori, dan refresh single-flight lintas tab. Daftar memakai `createLatestRequest`, dan mutasi tidak pasti direkonsiliasi lewat `/operations`.
- **Infra/CI**: image multi-stage non-root dengan base digest. Secret scale 0400 per konsumen. Port default 127.0.0.1. CI read-only dengan action dipin SHA, frozen lockfile, audit/SBOM, dan gate rilis.

## 5. Rekomendasi

1. Selesaikan CR-02 lalu CR-01 (keamanan), kemudian MAJOR web yang memutus alur inti: MJ-24 media, MJ-22 token host, MJ-23 join, MJ-29 `room:expired`, MJ-28 kredensial, MJ-30 sign-out palsu.
2. Lanjutkan dengan kebenaran data game/laporan (MJ-07, MJ-04, MJ-03, MJ-06, MJ-12, MJ-14) dan ketersediaan (MJ-15, MJ-08, MJ-11, MJ-13).
3. Perbaiki dokumen operasional (MJ-17–MJ-19) dan CI/build (MJ-20, MJ-21).
4. `[MINOR]` dijadwalkan sebagai task hardening yang menyentuh file yang sama.
