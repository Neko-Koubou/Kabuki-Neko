# 00 — Project Context: Kabuki Neko

> **Status**: COMPLETE

Tanggal inspeksi ulang: **2026-11-08 (Asia/Jakarta)**. Jenis workspace: **Brownfield** — Stage 5 (`/vibe-code`) sedang berjalan; commit terakhir `77eb8b2` (TASK-064A). Versi sebelumnya dokumen ini (2026-10-28) ditulis saat workspace masih greenfield/spec-only; isi di bawah menggantikannya berdasarkan kode yang benar-benar ada.

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
| Runtime | Node.js **26.13.0** (`.node-version`; **diputuskan pengguna 2026-11-08** sebagai baseline). Penyelarasan manifest masih Pending: `engines.node >=24.22.1`, `@types/node` 24.19.2, dan SA §1.1 masih menyebut Node 24 — diperbaiki TASK-001A–001C (lihat §6.3). |
| Package manager / monorepo | pnpm **10.34.9** (`packageManager`, `engineStrict`, `strictPeerDependencies`), Turborepo **2.11.10** (`envMode: strict`) |
| Bahasa | TypeScript **5.9.3** strict penuh (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `skipLibCheck: false`) |
| Frontend | Next.js **16.4.3** App Router (`output: "standalone"`), React/React DOM **19.3.1** |
| UI & styling | Tailwind CSS **4.3.3** (`@tailwindcss/postcss`), Radix UI 1.8.1 + class-variance-authority + clsx + tailwind-merge (pola Shadcn source components), lucide-react, Framer Motion 14.9.0 |
| State & form (web) | Zustand 5.0.16, React Hook Form 7.91.0 + `@hookform/resolvers`, Zod 4.6.7 |
| Interaksi & media (web) | socket.io-client 4.8.4, Howler.js 2.2.4, DiceBear 9.4.3, dnd-kit, canvas-confetti, `qrcode`, `@zxing/browser` (scanner lazy) |
| i18n | `intl-messageformat` 12.1.4 + `@formatjs/icu-messageformat-parser` (katalog ICU JSON build-time, provider React milik proyek, tanpa locale routing); bahasa awal `en`, `id`, `ja`, `zh-Hans`, `es`, `fr` |
| Backend | NestJS **11.2.8** (Express 5.3.0 adapter), `@nestjs/websockets` + `@nestjs/platform-socket.io` (Socket.io 4.8.4), `@nestjs/jwt`, `@nestjs/passport` + passport-jwt, `@nestjs/throttler`, helmet, cors, cookie-parser |
| API protocol | REST JSON `/api/v1` (global prefix di `apps/api/src/main.ts`, ETag/`If-Match` revisi, idempotency key + operation receipts); WebSocket Socket.io `/game` (belum diimplementasikan) |
| Auth & keamanan | JWT access di memori + rotating refresh cookie (ADR-05), password **Argon2** (`argon2` 0.45.1), guards `jwt/roles/ownership/origin` |
| Database & ORM | **TypeORM 0.3.31** EntitySchema factory per dialek (ADR-01), `synchronize=false`, migrasi per dialek. Driver: `better-sqlite3` (default), `pg` 8.23.1, `mysql2` 3.24.6 via `DB_DRIVER` |
| State aktif / cache | In-memory store (default) atau Redis via ioredis 5.11.1 + `@socket.io/redis-adapter` 8.3.0; atomisitas Redis lewat skrip Lua (`providers/state/lua/*.lua`) |
| Message broker | Tidak ada broker terpisah; antrean finalisasi durable di SQL (ADR-08), Redis PubSub/adapter untuk fan-out antar-instance |
| Media storage | Local directory (default) atau S3-compatible (`@aws-sdk/client-s3` + presigner 3.1160.0) untuk MinIO/R2/S3/Spaces; Sharp 0.35.5 + `file-type` untuk validasi magic bytes |
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
    src/app.module.ts       # RuntimeConfigModule (global) + Database/Storage/State/Auth/Users/Quizzes
    src/config/             # env.schema (Zod), config.service, secrets.service
    src/common/             # guards/{jwt,roles,ownership,origin}, audit, idempotency, rate-limit,
                            # metrics, operations.controller, error.filter, zod-validation.pipe,
                            # request-context.middleware
    src/providers/          # database/, storage/{local,s3,registry}, state/{memory,redis,lua/*.lua}
    src/modules/            # auth/, users/, quizzes/ (CRUD + import/export + snapshot + validator),
                            # game-engine/ (baru question-shuffler)
  web/                      # @kabuki-neko/web — Next.js App Router; saat ini hanya scaffold
    src/app/                # layout.tsx, page.tsx, globals.css
    src/test/setup.ts       # setup Vitest + jest-dom
packages/
  shared/                   # @kabuki-neko/shared — Zod schemas, constants, socket-events, errors, unicode
    src/schemas/*.schema.ts # auth, users, quiz, question, media, report, system, import, locale, game, audio
    locales/                # message-contracts.json (katalog per-bahasa belum dibuat)
  database/                 # @kabuki-neko/database — TypeORM EntitySchema, repositories, migrasi
    src/schema/             # *.schema.ts per domain + column-types.ts (tipe kolom per driver)
    src/repositories/       # *.repository.ts per domain
    src/migrations/{sqlite,postgres,mysql}/0001-initial.ts + migration-runner.ts
  tsconfig/                 # base.json, nestjs.json, nextjs.json
scripts/migrate.ts          # satu-satunya script yang sudah ada
tests/
  contracts/                # driver/adapter contract tests (SQLite/PG/MySQL/Redis/S3)
  integration/              # HTTP integration terhadap API yang dibuild
  e2e/                      # Playwright (masih kosong)
  helpers/runtime.ts        # runtime terisolasi + katalog sintetis + global teardown
audio-assets/kabuki-neko-audio/  # sumber audio (20 MP3 + CREDITS.md)
docs/vibe/                  # artefak pipeline 00–07
data/, uploads/             # data runtime lokal — di-gitignore, jangan di-commit
```

Belum ada (direncanakan oleh task berikutnya): `apps/api/src/modules/{media,reports,system}`, gateway/engine Socket.io, seluruh UI web (`(public)`, `(auth)`, `(dashboard)`, `(host)`, `(player)`), katalog locale per bahasa, `docker/`, `.github/workflows/ci.yml`, `tests/performance/`, dan script `locales-*`, `benchmark-game`, `start-profile`. Lihat SA §1.2 untuk peta file target lengkap.

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
| E2E | `pnpm test:e2e` (Playwright Chromium; `tests/e2e/` masih kosong) |
| Migrasi DB manual | `pnpm db:migrate` (membaca env; default SQLite) |
| Dev API / web | `pnpm --filter @kabuki-neko/api dev` (port 3001) · `pnpm --filter @kabuki-neko/web dev` (port 3000) |

Verifikasi per task (sesuai aturan `04-tasks.md`): `pnpm --filter @kabuki-neko/<paket> lint`, `pnpm --filter @kabuki-neko/<paket> typecheck`, test relevan, dan `build` bila menyentuh entrypoint/config/export paket.

### 4.2. Perintah yang sudah dideklarasikan tetapi targetnya belum ada

Jangan mengklaim lulus untuk perintah ini sampai task pembuatnya selesai:

| Perintah | Kondisi saat ini |
| --- | --- |
| `pnpm locales:validate`, `pnpm locales:build`, `pnpm locales:template` | `scripts/locales-*.ts` belum dibuat |
| `pnpm benchmark:game` | `scripts/benchmark-game.ts` belum dibuat |
| `pnpm deploy:scale` | `scripts/start-profile.ts` belum dibuat |
| `pnpm test:performance` | `tests/performance/` belum ada |
| `docker compose -f docker/docker-compose.yml config --quiet` / `up -d` / `--profile scale up -d` | direktori `docker/` belum ada (TASK-176 dst.) |

### 4.3. Hasil verifikasi saat inspeksi

Dijalankan 2026-11-08 di macOS dengan Node v26.13.0, pnpm 10.34.9, Docker 29.8.2, tanpa mengubah kode atau `node_modules`.

| Perintah | Hasil |
| --- | --- |
| `pnpm build` | **PASS** — 4/4 task turbo (shared, database, api, web; Next build static) |
| `pnpm typecheck` | **PASS** — 6/6 task |
| `pnpm lint` | **PASS** — 6/6 task, 0 warning |
| `pnpm exec prettier --check .` | **WARN** — seluruh source TS lulus; 12 file non-source tidak terformat (`apps/api/nest-cli.json`, `pnpm-lock.yaml`, `docs/vibe/*.md`, `audio-assets/**`). Belum ada `.prettierignore`; gunakan `prettier --check` pada file yang diubah saja. |
| `@kabuki-neko/shared test` (Vitest) | **PASS** — 11 file, 99 test |
| `@kabuki-neko/web test` (Vitest) | **FAIL (exit 1)** — `No test files found`; belum ada `*.spec.tsx` di web, dan script tidak memakai `--passWithNoTests`. Akibatnya `pnpm test` (turbo) gagal sampai web punya test pertama. |
| `@kabuki-neko/api test` (Jest) | Run pertama **FAIL** — 46/119 test gagal karena `better_sqlite3.node` dikompilasi untuk `NODE_MODULE_VERSION 137` (Node 24) sedangkan runtime butuh `147` (Node 26). Setelah `pnpm rebuild better-sqlite3` (mengunduh prebuild `v12.11.1-node-v147-darwin-arm64`): **PASS** — 15 suite, 119 test. |
| `pnpm test:contracts --runInBand --testPathPatterns='migration-sqlite\|migration-runner\|database-types'` | **PASS** (setelah rebuild) — 3 suite, 8 test |
| Contract PG/MySQL/Redis/S3, `pnpm test:integration`, `pnpm test:e2e` | **not run** — butuh Docker dan waktu panjang; E2E belum punya spec. |

> Jika `node_modules` dipasang dengan Node lain lalu runtime berganti, jalankan `pnpm rebuild better-sqlite3` sebelum test. TASK-001A menaikkan `engines.node` ke `>=26.13.0` agar ini tidak terulang.

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
| 0 Init | `00-project-context.md` | Diperbarui 2026-11-08 (dokumen ini) |
| 1 PRD | `01-prd.md` v1.3.0 | Selesai |
| 2 Design | `02-design-spec.md` v1.0 | Selesai |
| 3 SA | `03-system-analysis.md` v1.0 + `audio-engine-revision.md` | Selesai |
| 4 Tasks | `04-tasks.md` v1.1 | Selesai; dieksekusi bertahap |
| 5 Code | `05-implementation-log.md` | Berjalan — **83 task `[x]`, 125 `[ ]`, 0 `[~]`, 0 `[!]`**. Selesai sampai TASK-064A (bootstrap, shared contracts, DB + migrasi 3 dialek, storage/state adapters, auth, users, quizzes CRUD + import/export). Task Pending berikutnya: **TASK-001A** (baseline Node 26), lalu TASK-001B/001C, kemudian **TASK-065** (transaksi import + download templates) dan TASK-066–069 (media). |
| 6 Review | `06-code-review.md` | Belum ada |
| 7 QA | `07-qa-report.md` | Belum ada |

### 6.3. Drift dan risiko yang terdeteksi saat inspeksi

Dicatat untuk ditangani melalui task/korektif; jangan diperbaiki di luar scope task aktif.

1. **Versi Node — DIPUTUSKAN 2026-11-08: tetap Node 26.13.0.** Commit `bcab1f4` (2026-11-05) mengubah `.node-version` 24.22.1 → 26.13.0 dan `f5c4b61` melonggarkan `engines`, tetapi `node_modules` masih dibangun di Node 24 sehingga `better-sqlite3` gagal dimuat (ABI 137 vs 147). Binding lokal sudah dibangun ulang (`pnpm rebuild better-sqlite3`) dan test SQLite lulus. Sisa penyelarasan (engines, `@types/node` 26.x di semua paket, SA §1.1/§10.2) dijadwalkan sebagai **TASK-001A → TASK-001B/TASK-001C** di `04-tasks.md`.
2. **Duplikasi `better-sqlite3`**: root devDependency 13.0.3 vs `packages/database` 12.11.1. TypeORM 0.3.31 hanya menerima peer `^8 … ^12` dan tidak ada import langsung dari root, jadi root diturunkan ke 12.11.1 (mendukung `26.x`) di TASK-001A.
3. **Script deklaratif tanpa target** (§4.2) dan direktori `docker/`, `.github/`, `tests/performance/` belum ada — diharapkan, karena dijadwalkan task berikutnya.
4. **Contract/integration test butuh akses socket Docker**; log TASK-064A mencatat run pertama gagal karena izin socket dan lulus setelah dijalankan ulang dengan akses yang benar.
5. Ringkasan `04-tasks.md` menyebut total task berbeda di beberapa tempat (202 vs 195+); hitungan aktual heading: 205 (83 selesai + 122 pending).
