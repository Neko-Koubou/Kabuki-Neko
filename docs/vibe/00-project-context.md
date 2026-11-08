# 00 — Project Context: Kabuki Neko

> **Status**: COMPLETE

Tanggal inspeksi ulang: **2026-11-08 (Asia/Jakarta)**, diperbarui di tempat setelah sesi dipindah ke container cloud (Linux). Jenis workspace: **Brownfield** — Stage 5 (`/vibe-code`) sedang berjalan; commit terakhir `d612fe1` (TASK-083) di branch `main-nv6b09`. Revisi sebelumnya dokumen ini (commit `77eb8b2`, TASK-064A) dan versi awal 2026-10-28 (greenfield/spec-only) digantikan oleh isi di bawah, berdasarkan kode yang benar-benar ada.

## 1. Identitas, visi, dan sumber kebenaran

Kabuki Neko adalah platform kuis web real-time untuk penggunaan pribadi, pendidikan, komunitas, dan internal perusahaan. Prinsip produk: **Zero-Config Default, Enterprise Scalable** — satu instance SQLite/memory/local storage tanpa konfigurasi, dapat diskalakan ke PostgreSQL/MySQL + Redis + S3-compatible melalui profile `scale`.

- **Gaya arsitektur**: full-stack TypeScript **monorepo** (pnpm workspaces + Turborepo, namespace `@kabuki-neko/*`). Backend adalah **modular monolith NestJS** yang melayani REST `/api/v1` dan Socket.io namespace `/game`; frontend Next.js App Router tidak pernah mengakses database. Antrean kerja durable memakai SQL + worker di proses API (tanpa broker eksternal).
- **Lisensi**: source-available Apache 2.0 with Commons Clause (`LICENSE`, `THIRD-PARTY-NOTICES.md`); dokumen pipeline tidak menyusun teks lisensi baru.
- **Sumber kebenaran pipeline** (urutan prioritas jika bertentangan: dokumen yang lebih hilir hanya memperinci, tidak membatalkan hulu):
  - [01-prd.md](01-prd.md) v1.3.0 — 21 user stories, BR-01–BR-20, NFR-01–NFR-08, PRD §19/US-21 multibahasa.
  - [02-design-spec.md](02-design-spec.md) v1.0 — token, komponen B01–B12/F01–F20, matriks 5 state UI (L/E/I/P/X).
  - [03-system-analysis.md](03-system-analysis.md) v1.0 — arsitektur, ERD, kontrak REST/Socket, ADR-01–ADR-12.
  - [audio-engine-revision.md](audio-engine-revision.md) — addendum normatif audio (2026-10-31) yang menggantikan baseline audio lama.
  - [04-tasks.md](04-tasks.md) — DAG task atomik; [05-implementation-log.md](05-implementation-log.md) — bukti verifikasi per task.
  - [reviews/](reviews/) — review terpisah (mis. revisi audio 2026-10-29).
  - [../import-format.md](../import-format.md) — panduan format import/export kuis (TASK-064).
- Tidak ada `prd.md`, `PRD.md`, atau `docs/prd.md` alternatif di workspace; PRD kanonis hanya `docs/vibe/01-prd.md`.

## 2. Tech stack matrix

Versi di bawah dibaca dari manifest dan lockfile yang terpasang (semua dipin exact, `saveExact: true`). Jangan menaikkan versi atau mengganti library tanpa task eksplisit.

| Lapisan | Implementasi aktual |
| --- | --- |
| Runtime | Node.js **26.13.0** (`.node-version`; diputuskan pengguna 2026-11-08). `engines.node >=26.13.0` (root + `packages/tsconfig`), `@types/node` **26.6.6** di semua paket — selaras sejak TASK-001A–001C. |
| Package manager / monorepo | pnpm **10.34.9** (`packageManager`, `engineStrict`, `strictPeerDependencies`), Turborepo **2.11.10** (`envMode: strict`) |
| Bahasa | TypeScript **5.9.3** strict penuh (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `skipLibCheck: false`) |
| Frontend | Next.js **16.4.3** App Router (`output: "standalone"`), React/React DOM **19.3.1** |
| UI & styling | Tailwind CSS **4.3.3** (`@tailwindcss/postcss`), Radix UI 1.8.1 + class-variance-authority + clsx + tailwind-merge (pola Shadcn source components), lucide-react, Framer Motion 14.9.0 |
| State & form (web) | Zustand 5.0.16, React Hook Form 7.91.0 + `@hookform/resolvers`, Zod 4.6.7 |
| Interaksi & media (web) | socket.io-client 4.8.4, Howler.js 2.2.4, DiceBear 9.4.3, dnd-kit, canvas-confetti, `qrcode`, `@zxing/browser` (scanner lazy) |
| i18n | `intl-messageformat` 12.1.4 + `@formatjs/icu-messageformat-parser` (katalog ICU JSON build-time, provider React milik proyek, tanpa locale routing); bahasa awal `en`, `id`, `ja`, `zh-Hans`, `es`, `fr` |
| Backend | NestJS **11.2.8** (Express 5.3.0 adapter), `@nestjs/websockets` + `@nestjs/platform-socket.io` (Socket.io 4.8.4), `@nestjs/jwt`, `@nestjs/passport` + passport-jwt, `@nestjs/throttler`, helmet, cors, cookie-parser |
| API protocol | REST JSON `/api/v1` (global prefix di `apps/api/src/main.ts`, ETag/`If-Match` revisi, idempotency key + operation receipts); WebSocket Socket.io `/game` (`game.gateway.ts`, TASK-082 — 16 jenis event, snapshot per role) |
| Auth & keamanan | JWT access di memori + rotating refresh cookie (ADR-05), password **Argon2** (`argon2` 0.45.1), guards `jwt/roles/ownership/origin` |
| Database & ORM | **TypeORM 0.3.31** EntitySchema factory per dialek (ADR-01), `synchronize=false`, migrasi per dialek. Driver: `better-sqlite3` (default), `pg` 8.23.1, `mysql2` 3.24.6 via `DB_DRIVER` |
| State aktif / cache | In-memory store (default) atau Redis via ioredis 5.11.1 + `@socket.io/redis-adapter` 8.3.0; atomisitas Redis lewat skrip Lua (`providers/state/lua/*.lua`) |
| Message broker | Tidak ada broker terpisah; antrean finalisasi durable di SQL (ADR-08), Redis PubSub/adapter untuk fan-out antar-instance |
| Media storage | Local directory (default) atau S3-compatible (`@aws-sdk/client-s3` + presigner 3.1160.0) untuk MinIO/R2/S3/Spaces; Sharp 0.35.5 untuk metadata/re-encode; validasi magic bytes memakai tabel signature internal (`media-processor.ts`) karena `file-type` 22.3.0 ESM-only tidak dapat di-`require` dari API CommonJS (dependensinya masih tercantum) |
| Unit test | **Vitest 5.0.5** (shared: node; web: jsdom + Testing Library), **Jest 30.5.2 + ts-jest** (API, `src/**/*.spec.ts`) |
| Contract / integration test | Jest root config + **Testcontainers 12.2.1** (PostgreSQL, MySQL, Redis, MinIO) + SQLite; Supertest 7.3.1; butuh Docker daemon |
| E2E | **Playwright 1.64.1** (Chromium, workers 1) + `@axe-core/playwright`; menjalankan API build + Next dev pada port 43101/43100 dengan runtime terisolasi |
| Lint & format | ESLint **10.13.0** flat config + `typescript-eslint` 8.72.1 `strict` + `eslint-config-prettier`; Prettier **3.9.10** |
| Tooling script | `tsx` 4.23.15 untuk `scripts/*.ts` |
| Deploy (target) | Docker Compose default `web`/`api`; profile `scale` menambah PostgreSQL, Redis, MinIO + bucket init (belum dibuat — lihat §4) |

## 3. Struktur direktori dan konvensi

### 3.1. Peta workspace (status aktual)

```text
apps/
  api/                      # @kabuki-neko/api — NestJS (CommonJS), nest build → dist/
    src/main.ts             # bootstrap: prefix api/v1, HTTP boundary, guards, uploads
    src/app.module.ts       # RuntimeConfigModule (global) + Database/Storage/State + modul domain
    src/config/             # env.schema (Zod), config.service, secrets.service
    src/common/             # guards/{jwt,roles,ownership,origin}, audit, idempotency, rate-limit,
                            # metrics, operations.controller, error.filter, zod-validation.pipe,
                            # request-context.middleware
    src/providers/          # database/, storage/{local,s3,registry}, state/{memory,redis,lua/*.lua}
    src/modules/            # auth/, users/ (+ invitations), quizzes/ (CRUD + import/export + snapshot
                            # + validator), media/ (processor, reference pin, GC janitor, REST),
                            # system/ (settings, health, locale & audio registry, REST),
                            # game-engine/ (scoring/ranking, projector per role, capacity, registry,
                            # recovery, scheduler/timer lease, game.service, game.gateway Socket.io),
                            # reports/ (report-finalizer: freeze-to-queue + history writer)
  web/                      # @kabuki-neko/web — Next.js App Router; saat ini hanya scaffold
    src/app/                # layout.tsx, page.tsx, globals.css
    src/test/setup.ts       # setup Vitest + jest-dom
packages/
  shared/                   # @kabuki-neko/shared — Zod schemas, constants, socket-events, errors, unicode
    src/schemas/*.schema.ts # auth, users, quiz, question, media, report, system, import, locale, game, audio
    locales/                # message-contracts.json (katalog per-bahasa `en/`, `id/`, … belum dibuat — TASK-088 dst.)
  database/                 # @kabuki-neko/database — TypeORM EntitySchema, repositories, migrasi
    src/schema/             # *.schema.ts per domain + column-types.ts (tipe kolom per driver)
    src/repositories/       # *.repository.ts per domain
    src/migrations/{sqlite,postgres,mysql}/0001-initial.ts + migration-runner.ts
  tsconfig/                 # base.json, nestjs.json, nextjs.json
scripts/                    # migrate.ts, locales-{validate,build,template}.ts, lib/
tests/
  contracts/                # driver/adapter contract tests (SQLite/PG/MySQL/Redis/S3, state parity, locale)
  integration/              # HTTP + Socket.io integration terhadap API yang dibuild
                            # (users, quizzes, quiz-transfer, media, storage-serving, system, game-gateway)
  (e2e/ belum ada)          # Playwright — dibuat oleh task E2E
  helpers/runtime.ts        # runtime terisolasi + katalog sintetis + global teardown
audio-assets/kabuki-neko-audio/  # sumber audio (20 MP3 + CREDITS.md)
docs/vibe/                  # artefak pipeline 00–07
data/, uploads/             # data runtime lokal — di-gitignore, jangan di-commit
```

Belum ada (direncanakan oleh task berikutnya): worker antrean/retry finalisasi (TASK-084), analitik + CSV + REST laporan (TASK-085–086), seluruh UI web (`(public)`, `(auth)`, `(dashboard)`, `(host)`, `(player)`), katalog locale per bahasa, `docker/`, `.github/workflows/ci.yml`, `tests/performance/`, `tests/e2e/`, dan script `benchmark-game`, `start-profile`. Lihat SA §1.2 untuk peta file target lengkap.

### 3.2. Konvensi penamaan

| Objek | Konvensi | Contoh nyata |
| --- | --- | --- |
| File & folder | `kebab-case` + sufiks peran bertitik | `quiz-validator.ts`, `refresh.service.ts`, `jwt.guard.ts`, `users.schema.ts`, `0001-initial.ts` |
| Test | `*.spec.ts(x)` berdampingan dengan source (unit); `tests/{contracts,integration,e2e}/*.spec.ts` (lintas paket) | `quizzes.service.spec.ts`, `tests/contracts/redis-room.spec.ts` |
| Class, komponen React, tipe | `PascalCase` | `ConfigService`, `RuntimeConfigModule`, `HomePage` |
| Variabel, fungsi, method | `camelCase` | `parseEnvironment`, `createDataSource`, `migrateDatabase` |
| Tabel & kolom DB | `snake_case` | `users.password_hash`, `auth_version`, `created_at` |
| Enum/konstanta kontrak | Sesuai PRD/SA (umumnya `UPPER_SNAKE_CASE`) | role `CREATOR`/`SUPERADMIN`, visibilitas `PRIVATE`/`PUBLIC` |
| Package | `@kabuki-neko/<nama>` | `@kabuki-neko/shared` |
| Commit | `TASK-XXX[A]: <ringkasan imperatif bahasa Inggris>` | `TASK-064A: Persist imported quiz graphs atomically …` |

Format kode dipaksa Prettier: double quote, semicolon, trailing comma `all`, `printWidth` 100, indent 2 spasi, LF.

### 3.3. Batas modul dan layer

- **web → shared saja.** ESLint `no-restricted-imports`/`no-restricted-syntax` melarang `apps/web/src` dan `packages/shared/src` mengimpor `@kabuki-neko/{api,database}`, `@nestjs/*`, `@aws-sdk/*`, `typeorm`, driver DB, `ioredis`, `sharp`, serta builtin Node (`node:*`), termasuk via dynamic import non-literal.
- **shared tidak bergantung pada siapa pun** selain `zod` (juga dilarang mengimpor `@kabuki-neko/web`). Shared adalah satu-satunya tempat kontrak DTO, Zod schema, socket event, error code, dan konstanta lintas runtime.
- **database** bergantung pada shared + TypeORM/driver; tidak mengenal NestJS. API mengonsumsinya melalui `providers/database`.
- **api**: controller hanya validasi boundary (Zod pipe), auth, dan mapping response; logika di service; persistensi lewat repository; driver DB/storage/state diisolasi melalui adapter + NestJS DI (`providers/*`). Logika kuis, skor, timer, otorisasi, dan transisi state hanya di server.
- Paket `shared`/`database` dikonsumsi dari `dist/` (Jest `moduleNameMapper`, Turbo `dependsOn: ["^build"]`) — **build paket hulu sebelum typecheck/test paket hilir**. Web Vitest memetakan `@kabuki-neko/shared` ke `src` langsung; Next memakai `transpilePackages`.
- UUID dibuat aplikasi; timestamp disimpan sebagai epoch milidetik (`long`); migrasi dan serialisasi harus setara di SQLite/PostgreSQL/MySQL (tidak memakai `synchronize` atau asumsi JSON native).
- Disiplin pipeline: setiap `/vibe-code` mengerjakan satu TASK, hanya mengubah Target Files task itu, lalu memperbarui checklist `04-tasks.md` dan log `05-implementation-log.md`.

## 4. Verification commands

Jalankan dari root workspace. Hasil terakhir dicatat pada §4.3.

### 4.1. Perintah yang tersedia

| Tujuan | Perintah |
| --- | --- |
| Install (lokal) | `pnpm install` |
| Install (CI / reproducible) | `pnpm install --frozen-lockfile` |
| Build semua paket | `pnpm build` (turbo; urutan shared → database → api/web) |
| Typecheck semua | `pnpm typecheck` |
| Lint semua | `pnpm lint` (ESLint `--max-warnings 0` per paket) |
| Format check | `pnpm exec prettier --check <path>` (belum ada script `format`; periksa file yang diubah) |
| Unit test semua | `pnpm test` (turbo; **perhatian**: target `test` paket database menjalankan contract suite database via Testcontainers → butuh Docker; target web gagal selama belum ada spec — lihat §4.3) |
| Unit test tanpa Docker | `pnpm --filter @kabuki-neko/shared --filter @kabuki-neko/web --filter @kabuki-neko/api test` |
| Contract test (driver/adapter) | `pnpm test:contracts` (filter: `pnpm test:contracts --runInBand --testPathPatterns=<pola>`) — Docker wajib |
| Integration test HTTP | `pnpm test:integration` — butuh build API + Docker untuk fixture tertentu |
| E2E | `pnpm test:e2e` (Playwright Chromium; direktori `tests/e2e/` belum ada) |
| Migrasi DB manual | `pnpm db:migrate` (membaca env; default SQLite) |
| Dev API / web | `pnpm --filter @kabuki-neko/api dev` (port 3001) · `pnpm --filter @kabuki-neko/web dev` (port 3000) |

Verifikasi per task (sesuai aturan `04-tasks.md`): `pnpm --filter @kabuki-neko/<paket> lint`, `pnpm --filter @kabuki-neko/<paket> typecheck`, test relevan, dan `build` bila menyentuh entrypoint/config/export paket.

### 4.2. Perintah yang sudah dideklarasikan tetapi targetnya belum ada

Jangan mengklaim lulus untuk perintah ini sampai task pembuatnya selesai:

| Perintah | Kondisi saat ini |
| --- | --- |
| `pnpm locales:validate`, `pnpm locales:build` | Script ada (TASK-070/071), tetapi gagal `INVALID_MANIFEST` karena paket fallback `packages/shared/locales/en` belum ada (dibuat TASK-088 dst.). Diharapkan sampai katalog `en` lengkap. |
| `pnpm benchmark:game` | `scripts/benchmark-game.ts` belum dibuat |
| `pnpm deploy:scale` | `scripts/start-profile.ts` belum dibuat |
| `pnpm test:performance` | `tests/performance/` belum ada |
| `docker compose -f docker/docker-compose.yml config --quiet` / `up -d` / `--profile scale up -d` | direktori `docker/` belum ada (TASK-176 dst.) |

### 4.3. Hasil verifikasi saat inspeksi

Dijalankan 2026-11-08 di container cloud Linux x64 pada commit `d612fe1`, dengan Node v26.13.0 (diunduh ke scratchpad; Node bawaan container v22.23.4 ditolak `engineStrict`), pnpm 10.34.9 via corepack, `pnpm install --frozen-lockfile` bersih. **Tidak ada Docker daemon** (`/var/run/docker.sock` tidak ada), jadi semua suite Testcontainers gagal di lingkungan ini.

| Perintah | Hasil |
| --- | --- |
| `pnpm build` | **PASS** — 4/4 task turbo |
| `pnpm typecheck` | **PASS** — 6/6 task |
| `pnpm lint` | **PASS** — 6/6 task, 0 warning |
| `@kabuki-neko/shared test` (Vitest) | **PASS** — 11 file, 99 test |
| `@kabuki-neko/web test` (Vitest) | **FAIL (exit 1)** — `No test files found` (belum ada spec web; script tanpa `--passWithNoTests`). Akibatnya `pnpm test` (turbo) gagal sampai web punya test pertama. |
| `@kabuki-neko/api test` (Jest) | 28/29 suite, 201/212 test **PASS**. 11 test di `src/common/rate-limit.service.spec.ts` **FAIL — lingkungan**: `Could not find a working container runtime strategy` (spec memakai Redis Testcontainers). Lulus di macOS dengan Docker menurut log TASK-082/083. |
| `pnpm test:contracts --runInBand --testPathPatterns='migration-sqlite\|migration-runner\|database-types\|locale'` | 3/5 suite, 12/16 test **PASS** (SQLite + locale). 4 test PostgreSQL/MySQL **FAIL — lingkungan** (tanpa Docker). |
| `pnpm locales:validate` | **FAIL (diharapkan)** — `INVALID_MANIFEST`: katalog `en` belum ada (lihat §4.2). |
| Contract Redis/S3/state-parity, `pnpm test:integration`, `pnpm test:e2e` | **not run** — butuh Docker; E2E belum punya spec. |

> Build script `argon2` diabaikan pnpm (hanya `better-sqlite3`/`esbuild` di `onlyBuiltDependencies`); argon2 tetap memakai prebuild bawaan paket dan test auth lulus. Jika `node_modules` dipasang dengan Node lain lalu runtime berganti, jalankan `pnpm rebuild better-sqlite3` sebelum test.

## 5. Global non-negotiables

**Typing & kualitas**
- TypeScript strict penuh sesuai `packages/tsconfig/base.json`; **tanpa `any`** (`@typescript-eslint/no-explicit-any: error`) — gunakan `unknown` + Zod/narrowing. Tanpa `@ts-ignore`; `eslint-disable` hanya baris tunggal dengan alasan (pola yang ada: `no-extraneous-class` untuk Nest module).
- Lint `--max-warnings 0`; tidak ada variabel tak terpakai kecuali berawalan `_`; tidak ada `debugger`.
- Semua boundary divalidasi Zod dari `@kabuki-neko/shared`: HTTP body/query/params, Socket.io payload, environment (`env.schema.ts`), file import, katalog locale.

**Data & keamanan**
- Tidak ada SQL tak terparameterisasi atau string interpolation ke query; perubahan skema hanya lewat migrasi per dialek (SQLite, PostgreSQL, MySQL) + contract test ketiganya.
- Tidak ada secret hardcoded. Secret JWT digenerate dan dipersist ke `runtime-secrets.json` (mode 0600) bila absen, atau diprovisikan ≥64 karakter dan berbeda; contoh credential di dokumentasi ditolak. `.env*`, data runtime, `uploads/`, dan file DB tidak pernah di-commit.
- Tidak ada password plaintext (Argon2), token/secret di log, atau kunci jawaban dalam payload player sebelum reveal (snapshot privat + proyeksi allowlist per role, ADR-04).
- Otorisasi role **dan** kepemilikan resource di server untuk setiap aksi termasuk host; JWT valid saja tidak cukup. Revisi optimistik (`If-Match`/ETag) dan idempotency receipt untuk mutasi.
- Unggahan dibatasi ukuran, tipe, dan magic bytes; tidak menerima SVG arbitrer. Penghapusan media tidak boleh merusak referensi kuis atau sesi aktif (pin referensi, ADR-10).

**Game engine & skala**
- Server menguasai timer dan skor; input ditutup saat timer habis dengan grace 1.500 ms sebelum reveal; jawaban duplikat tidak menambah skor. Penerimaan jawaban dan transisi state harus atomik di memory maupun Redis (skrip Lua same-slot, ADR-03).
- MULTIPLE_SELECT parsial tanpa opsi salah → skor parsial, menaikkan streak, mendapat bonus streak (ADR-07).
- Profile default harus persisten untuk SQLite, uploads, dan secret. Multi-instance mensyaratkan PostgreSQL/MySQL + Redis + storage bersama.
- Target PRD broadcast p95 <50 ms untuk 200 klien/room harus diukur dengan kondisi jaringan/hardware/beban tercatat; bukan klaim tanpa benchmark.

**UI & aksesibilitas**
- Warna jawaban selalu disertai simbol geometris; seluruh interaksi dapat diakses keyboard dan berlabel untuk teknologi bantu.
- Seluruh copy/aria/title berasal dari katalog i18n (tanpa string hardcoded di UI); layout logical properties/RTL-ready.
- Setiap layar menangani 5 state: Loading, Empty, Ideal, Partial-edge, Error-offline. Error bukan empty; timeout mutasi bukan sukses.

**Proses**
- Test/performance/security yang gagal tidak boleh dilewati untuk menandai `[x]`; buat task korektif bila perbaikan di luar Target Files. Bukti yang tidak dijalankan dicatat **not run/unverified**.
- Tidak ada publikasi, deployment, atau push tanpa permintaan eksplisit pengguna.

## 6. Keputusan, status pipeline, dan drift yang diketahui

### 6.1. Keputusan bisnis (dikonfirmasi 2026-10-28)

1. Input pemain ditutup saat timer habis; penerimaan paket terlambat berlangsung 1.500 ms sebelum reveal.
2. MULTIPLE_SELECT parsial tanpa opsi salah memperoleh skor parsial, menaikkan streak, dan mendapat bonus streak.
3. CREATOR boleh melihat, menduplikasi, dan menjadi host kuis PUBLIC milik kreator lain; edit/hapus hanya oleh pemilik.
4. Seluruh UI web multibahasa dan dapat diperluas melalui paket terjemahan; bahasa awal `en`, `id`, `ja`, `zh-Hans`, `es`, `fr` (PRD §19 / US-21).

### 6.2. Status pipeline

| Stage | Artefak | Status |
| --- | --- | --- |
| 0 Init | `00-project-context.md` | Diperbarui 2026-11-08 di commit `d612fe1` (dokumen ini) |
| 1 PRD | `01-prd.md` v1.3.0 | Selesai |
| 2 Design | `02-design-spec.md` v1.0 | Selesai |
| 3 SA | `03-system-analysis.md` v1.0 + `audio-engine-revision.md` | Selesai |
| 4 Tasks | `04-tasks.md` v1.1 | Selesai; dieksekusi bertahap |
| 5 Code | `05-implementation-log.md` | Berjalan — **112 task `[x]`, 103 `[ ]`, 0 `[~]`, 0 `[!]`** (215 heading). Selesai sampai TASK-083: bootstrap, shared contracts, DB + migrasi 3 dialek, storage/state adapters, auth, users, quizzes (CRUD, import/export, template), media (TASK-066–069), lokalisasi & system (TASK-070–074), game engine + gateway Socket.io (TASK-075–082), freeze-to-queue laporan (TASK-083), plus korektif 001A–001C, 064B, 067A, 069A, 078A, 079A, 081A, 082A. Task Pending berikutnya: **TASK-084** (worker antrean & retry finalisasi), lalu TASK-085–086 (laporan), TASK-087+ (UI web & katalog). |
| 6 Review | `06-code-review.md` | Belum ada |
| 7 QA | `07-qa-report.md` | Belum ada |

### 6.3. Drift dan risiko yang terdeteksi saat inspeksi

Dicatat untuk ditangani melalui task/korektif; jangan diperbaiki di luar scope task aktif.

1. **Versi Node — SELESAI.** Baseline Node 26.13.0 sudah selaras di `.node-version`, `engines`, dan `@types/node` 26.6.6 (TASK-001A–001C); root `better-sqlite3` diturunkan ke 12.11.1. Lingkungan yang membawa Node lain (mis. container cloud dengan Node 22) wajib memasang Node 26.13.0 dulu karena `engineStrict`.
2. **Stabilitas test gateway (TASK-082)**: sebelum timeout per langkah ditambahkan, 2 dari 4 run `tests/integration/game-gateway.spec.ts` menggantung sampai timeout Jest; setelahnya 10 run berturut-turut lulus. Akar masalah belum ditemukan — pantau sebagai potensi flaky.
3. **Room kedaluwarsa**: room yang kedaluwarsa saat pertanyaan berjalan ditutup dengan laporan; fase lain ditandai LOST tanpa laporan (keterbatasan state store, dicatat di log TASK-081/083).
4. **`file-type` tidak terpakai**: dependensi tercantum di `apps/api/package.json` tetapi validasi memakai tabel signature internal (lihat §2); kandidat pembersihan dependensi.
5. **Script deklaratif tanpa target** (§4.2) dan direktori `docker/`, `.github/`, `tests/performance/`, `tests/e2e/` belum ada — diharapkan, karena dijadwalkan task berikutnya.
6. **Contract/integration test butuh Docker daemon** (Testcontainers). Container cloud tidak menjalankannya otomatis, tetapi `dockerd` terpasang: jalankan `dockerd &` (sebagai root) sebelum test; PostgreSQL/MySQL/Redis lalu dapat ditarik dan dijalankan. Dua kasus tetap gagal khusus di container ini: `tests/integration/system.spec.ts` (injeksi gagal hapus via `chmod 0555` tidak berlaku untuk root) dan kasus MinIO di `tests/integration/media.spec.ts` (build image dari source gagal di sini).
7. Ringkasan `04-tasks.md` menyebut total task berbeda di beberapa tempat; hitungan aktual heading: 215 (112 selesai + 103 pending), termasuk task korektif bersufiks huruf.
