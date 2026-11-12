# 05 — Implementation Log: Kabuki Neko

## TASK-001 — Pin runtime dan bootstrap pnpm workspace

- **Selesai:** 2026-10-30 20:34 WIB (Asia/Jakarta).
- **Files:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.node-version`; bookkeeping `docs/vibe/04-tasks.md` dan file log ini.
- **Implementasi:** Node 24.22.1, pnpm 10.34.9, Turbo 2.11.10, TypeScript 5.9.3; seluruh dependency langsung dipin exact. Workspace `apps/*` dan `packages/*`, engine/peer checks strict, dan lifecycle build allowlist untuk better-sqlite3/esbuild. Tooling mencakup ESLint/Prettier, Vitest/Vite, Jest/ts-jest, Playwright/axe, Testcontainers, driver clients, ICU/ZIP/YAML tools. Script menunjuk target sebenarnya yang akan dibuat task berikutnya.
- **Sumber versi/kompatibilitas:** metadata npm registry (engines dan peer dependencies); [Node 24.22.1 security release](https://nodejs.org/en/blog/release/v24.22.1), [pnpm compatibility](https://pnpm.io/installation). ESLint 10 dipilih karena ESLint 9 sudah ditandai unsupported oleh registry; typescript-eslint 8.72.1 mendukung ESLint 10 dan TS 5.9.
- **DoD PASS:** `pnpm install --frozen-lockfile` dua kali; versi Node sesuai `.node-version` dan pnpm sesuai `packageManager`/engines. SHA-256 lockfile sebelum/sesudah install kedua identik: `cb6b3392875619673c195108927cde73d240d56b85776ce8ec5c27e79d017d3a`.
- **Kompatibilitas PASS:** SQLite in-memory menjalankan parameterized query; 17 import tooling/driver berhasil. CLI TypeScript, ESLint, Turbo, Vitest, Jest, Playwright dan tsx dapat dijalankan. `pnpm exec prettier --check package.json pnpm-workspace.yaml` lulus. Ini smoke tooling pada macOS arm64, bukan hasil test fitur/adapter remote.
- **Security review / temuan terbuka:** audit penuh menemukan 1 advisory low, 0 moderate/high/critical: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), `jest > @jest/core > jest-config > deepmerge@4.3.1`; belum ada patched version resmi. Inspeksi penggunaan `jest-config` menunjukkan merge konfigurasi/preset/globals lokal yang dipercaya, bukan input HTTP/player. Bootstrap tetap menggunakan Jest yang dipersyaratkan; audit penuh **tidak diklaim bersih**, advisory tidak dimute dan tidak memakai downgrade untuk menyembunyikannya. Evaluasi ulang dependency/fix pada TASK-181 sebelum release; jangan menerima konfigurasi Jest dari sumber tidak dipercaya. `pnpm audit --prod` bersih pada bootstrap yang belum memiliki dependency produksi.
- **Batas verifikasi:** pnpm memblokir lifecycle scripts di luar allowlist (`@parcel/watcher`, `cpu-features`, `protobufjs`, `ssh2`, `unrs-resolver`); import/CLI di atas berhasil, penggunaan khusus tetap perlu diperiksa pada task konsumennya. Build/lint/typecheck/test aplikasi, browser dan Docker integration belum dijalankan karena konfigurasi, aplikasi dan test belum tersedia.

### Permintaan tambahan pengguna — konfigurasi Git ignore

- Melengkapi `.gitignore` awal (`node_modules`) untuk cache/build, test reports, environment/secrets, database/uploads/runtime data, generated locale/legal artifacts, log dan metadata OS/editor.
- Melepas `.DS_Store` yang sebelumnya tracked dari Git index; file lokal tetap ada. Tidak memasukkan perubahan upstream maupun source audio yang tidak terkait ke commit task.
- **PASS:** `git check-ignore --no-index` atas 28 path generated/private dan 16 path source yang wajib tetap dapat dilacak (termasuk `.env.example`, lockfile, migrasi, locale, brand/audio dan legal source). `git ls-files -ci --exclude-standard` kosong; `git diff --check` lulus.
- TASK-002 tetap Pending; target `.gitignore` menjadi MODIFY karena permintaan tambahan ini. Task berikutnya: **TASK-002**.

## TASK-002 — 2026-10-30 20:40:12 WIB

- Files: `turbo.json`, `eslint.config.mjs`, `.prettierrc.json`, `.gitignore`.
- Implementasi/verifikasi: Pipeline Turbo upstream build dan output dist/.next; lint/typecheck/test tanpa cache. ESLint strict TypeScript dan batas import browser/shared, Prettier konsisten, aturan gitignore dipertahankan. PASS: turbo run build --dry=json (0 paket aplikasi saat bootstrap), Prettier check, lint konfigurasi dan assertion negative/positive aturan lint. Root application lint/typecheck belum dijalankan karena paket belum tersedia. Referensi: https://turborepo.dev/docs/reference/configuration dan https://typescript-eslint.io/users/configs/.

## TASK-003 — 2026-10-30 20:40:43 WIB

- Files: `packages/tsconfig/package.json`, `packages/tsconfig/base.json`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: PASS: frozen install; TypeScript compiler API memvalidasi konfigurasi efektif strict/noUncheckedIndexedAccess, NodeNext dan ES2023 tanpa DOM. Diagnostic no-input 18003 dicatat sebagai kondisi bootstrap yang diizinkan DoD, bukan hasil typecheck aplikasi.

## TASK-004 — 2026-10-30 20:40:44 WIB

- Files: `packages/tsconfig/nextjs.json`, `packages/tsconfig/nestjs.json`.
- Implementasi/verifikasi: PASS: compiler API assertions atas konfigurasi efektif web/API: strict diwariskan, Next Bundler/JSX/noEmit/DOM, Nest NodeNext/decorator metadata/tanpa DOM, declaration/source maps konsisten. Prettier check lulus. Build consumer menyusul saat entrypoint tersedia.

## TASK-005 — 2026-10-30 20:41:47 WIB

- Files: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: Shared package Zod dengan export subpath stabil dan entrypoint valid. PASS: frozen install, tsc --showConfig, lint, typecheck dan build. Script Vitest disediakan; belum ada unit suite sehingga tidak diklaim test fitur lulus.

## TASK-006 — 2026-10-30 20:42:51 WIB

- Files: `packages/database/package.json`, `packages/database/tsconfig.json`, `packages/database/src/index.ts`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: PASS: frozen install, tsc --showConfig, lint/typecheck/build; TypeORM DataSource native SQLite parameterized query. TypeORM 0.3.31 dipasangkan dengan better-sqlite3 12.11.1 sesuai peer support (root test client 13 tetap terpisah). PG/MySQL tersedia; remote contract suite menunggu harness TASK-011.

## TASK-007A — 2026-10-30 20:44:28 WIB

- Files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: Override webpack Nest CLI 5.112.2 memenuhi peer schema-utils tanpa melonggarkan strictPeerDependencies. PASS: baseline frozen install; exact override diperiksa. Install/build API diuji pada TASK-007/TASK-009.

## TASK-007B — 2026-10-30 20:46:12 WIB

- Files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: Pin perbaikan GHSA-q7qp-rjg7-q26m: nested Multer 2.4.0 menjadi 2.5.0. Frozen install baseline PASS. Audit produksi API menjadi gerbang wajib sebelum TASK-007 selesai; advisory tidak diabaikan.

## TASK-007 — 2026-10-30 20:47:12 WIB

- Files: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: PASS: frozen install dengan strict peers, Nest CLI 11.0.24, Argon2 hash/verify native, Sharp WebP native dan audit produksi tanpa advisory. tsc --showConfig menghasilkan 18003 karena entrypoint baru di TASK-009; compiler API memverifikasi opsi strict/decorators. DoD diperjelas agar no-input tidak diklaim typecheck lulus. Build/lint/API tests menunggu src pada TASK-009.

## TASK-008 — 2026-10-31 04:09:56 WIB

- Files: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `pnpm-lock.yaml`.
- Implementasi/verifikasi: PASS: frozen install strict peers, tsc --showConfig, typecheck konfigurasi, ESLint next.config.ts, Prettier dan audit produksi bersih. Next16 standalone/React19, Tailwind4, UI/media/i18n/test dependencies exact; DiceBear core/collection 9.4.3. ES2024 Promise types dan dua alias URLPattern menjembatani deklarasi Next16 dengan TS5.9/Node24 tanpa skipLibCheck. eslint-config-next tidak ditambahkan karena plugin transitif belum mendukung ESLint10; lint memakai konfigurasi strict workspace. Build halaman menunggu TASK-010.

## TASK-009 — 2026-10-31 04:10:58 WIB

- Files: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/jest.config.cjs`.
- Implementasi/verifikasi: PASS: API lint, typecheck, Nest build, boot smoke port terisolasi dengan unknown /api/v1 route 404, graceful SIGTERM tanpa SIGKILL; Jest --listTests memuat config (belum ada unit suite). Prefix API dan port default3001 tersedia, error startup teredaksi. Pengecualian lint lokal hanya untuk class module metadata Nest yang memang kosong.

## TASK-010 — 2026-10-31 04:12:09 WIB

- Files: `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`, `apps/web/next-env.d.ts`.
- Implementasi/verifikasi: PASS: web lint, Next production build (halaman / dan fallback statis), typecheck. Shell semantic main, metadata dan global CSS tersedia; tanpa kontrol fitur palsu. next-env.d.ts dihasilkan/dilengkapi Next. Provider locale/theme dan desain final menunggu task terkait.

## TASK-011 — 2026-10-31 04:24:51 WIB

- Files: `tests/jest.integration.config.cjs`, `tests/jest.contracts.config.cjs`, `playwright.config.ts`, `tests/helpers/runtime.ts`.
- Implementasi/verifikasi: PASS: root lint/typecheck, explicit strict typecheck/lint harness; Jest integration/contracts --listTests loads without generated .next collisions. Playwright --list loads and correctly exits1 for zero tests (no E2E pass claimed), temporary directory cleaned. Native Redis/Postgres16/MySQL8 connection smoke and MinIO bucket creation PASS; owned cleanup/idempotence/outside-directory rejection PASS. MinIO public images no longer available: test image built from official security release commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a with Go1.27.3, nonroot scratch runtime and license, build cache retained; source https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z. Synthetic ICU AST fixtures support string/number/date and are marked separately as non-release data; browser boot generates them once contracts exist in TASK-023. No product translation/feature coverage claimed.

## TASK-012 — 2026-10-31 09:18:38 WIB

- Files: `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts`.
- Implementasi/verifikasi: PASS: web lint/typecheck dan vitest list memuat config React/jsdom. Standalone jest-dom matchers didaftarkan dengan augmentasi Assertion<R,T> Vitest5 karena adapter /vitest bawaan jest-dom7 masih memakai signature lama; tidak mengubah strict/skipLibCheck. Cache tsc lama dipindahkan ke /tmp setelah clean typecheck membuktikan diagnostic cache sudah usang. Mocks matchMedia/ResizeObserver, DOM cleanup, timers, env/global reset per-test tersedia. Belum ada test komponen; tidak diklaim coverage. Vite memberi warning migrasi config native untuk major mendatang, bukan kegagalan konfigurasi saat ini.

## TASK-013 — 2026-10-31 09:21:47 WIB

- Files: `LICENSE`, `THIRD-PARTY-NOTICES.md`.
- Implementasi/verifikasi: PASS: complete official Apache2 text byte-preserved and all substantive Commons Clause paragraphs unchanged (application fields populated); 106 direct package/version entries and 1035 installed transitive entries inventoried. pause0.0.1 MIT verified in Readme despite absent metadata. Source https://www.apache.org/licenses/LICENSE-2.0.txt and https://commonsclause.com/. US-19/release remains UNVERIFIED: Commons Clause does not cover every broad noncommercial/value-added resale prohibition in PRD; owner decision requested asynchronously. Asset credits, target-platform/native license notices and final distribution checks remain TASK-114/115/174/181. No invented legal restrictions or claim of legal certification.

## TASK-014 — 2026-10-31 09:25:33 WIB

- Files: `packages/shared/src/constants/game.ts`, `packages/shared/src/constants/geometry.ts`, `packages/shared/src/constants/limits.ts`, `packages/shared/src/constants/audio.ts`.
- Implementasi/verifikasi: Implemented shared enums, geometry/color pairs, baseline audio URL catalogue and SA validation/runtime limits with explicit units. Shared lint, typecheck and build PASS; compiled-output assertions match all question/phase/time/multiplier enums, grace, four geometries/colors and complete audio catalogue. Audio files/rights remain TASK-114; performance constants are acceptance targets, not certification.

## TASK-014A — 2026-10-31 09:27:35 WIB

- Files: `eslint.config.mjs`.
- Implementasi/verifikasi: Fixed false-positive builtin import patterns by exact module-name matching; dynamic-import restriction now also covers bare Node builtin names. ESLint API probes on shared and web accept relative constants/path imports and reject static/dynamic constants, fs, fs/promises, node:path, database and Nest imports; shared lint PASS. TASK-015 remains pending until this corrective commit.

## TASK-015 — 2026-10-31 09:27:47 WIB

- Files: `packages/shared/src/unicode.ts`, `packages/shared/src/errors.ts`, `packages/shared/src/unicode.spec.ts`.
- Implementasi/verifikasi: Implemented NFC/grapheme/UTF-8 bounds, field-specific control and bidi validation, exact password preservation, locale-independent nickname/answer keys and linear code-point one-edit matching. Closed ErrorCode/Issue/SafeParams schemas include capacity/setup/replay outcomes and generic internal fallback. Shared lint/typecheck PASS; 8 Vitest tests PASS including emoji/CJK/combining abuse, password boundaries and independent edit-distance comparisons. Used Unicode surrogate regex compatible with existing ES2023 target.

## TASK-016 — 2026-10-31 14:32:52 WIB

- Files: `packages/shared/src/schemas/auth.schema.ts`, `packages/shared/src/schemas/users.schema.ts`, `packages/shared/src/schemas/system.schema.ts`, `packages/shared/src/schemas/auth.schema.spec.ts`.
- Implementasi/verifikasi: Added strict auth/user/invitation/settings/health/public-config contracts, canonical v4 UUID vs global singleton, IDNA/lowercase email, unchanged passwords, safe query coercion, nonempty editable patches and extensible locale syntax (installed registry enforced later in service). Shared lint/typecheck PASS; Vitest 24 tests across Unicode/auth PASS including injection, nullable/absent fields, limits and credentials omitted from public responses.

## TASK-016A — 2026-10-31 14:37:43 WIB

- Files: `docs/vibe/audio-engine-revision.md`.
- Implementasi/verifikasi: Revised audio plan from actual20 MP3 files and supplied CREDITS, with per-file SHA256 inventory. Added dual-format conversion, dynamic lobby/default random contracts,8s PODIUM timing, role-specific10SFX choreography, singleton/store/hooks/UI/credits/browser tests and downstream DB/locales/API/packaging dependencies. Validated192 unique task IDs, acyclic dependencies and1–4 target files for every task; no obsolete active raw-audio paths. Existing credits URL/SFX provenance and broader legal wording gaps recorded honestly; audio implementation not yet claimed complete.

## TASK-016B — 2026-10-31 14:39:06 WIB

- Files: `packages/shared/src/constants/audio.ts`, `packages/shared/src/schemas/audio.schema.ts`, `packages/shared/src/schemas/audio.schema.spec.ts`, `packages/shared/src/schemas/system.schema.ts`.
- Implementasi/verifikasi: Replaced four legacy audio URLs with dynamic lobby/dual-source manifest contracts, safe track IDs/default random, exact required6 phase BGM+10SFX descriptors, preference/cue defaults and same-origin WebM→MP3 pair validation. Public config now exposes real lobby descriptors. Shared lint/typecheck PASS; all30 tests PASS including3/4/5 lobby fixtures, unknown safe IDs, missing cues, path injection, duplicate IDs, invalid volume and no-loop SFX.

## TASK-016C — 2026-10-31 14:39:20 WIB

- Files: `packages/shared/src/constants/game.ts`, `packages/shared/src/constants/game.spec.ts`.
- Implementasi/verifikasi: Changed authoritative PODIUM duration to8000ms to accommodate winner cues at1200/3500/6500ms. No added phase or changes to countdown/preview/grace/scoring. Shared lint/typecheck PASS;31 tests PASS, including explicit cue-before-FINISHED invariant. Actual scheduler/UI consumers follow this constant in their pending tasks; no playback implementation claimed.

## TASK-017 — 2026-10-31 14:41:03 WIB

- Files: `packages/shared/src/schemas/media.schema.ts`, `packages/shared/src/schemas/media.schema.spec.ts`.
- Implementasi/verifikasi: Implemented complete Media/Accessibility/Caption contracts, explicit optional-input null/[] defaults,256KiB serialized cap, ordered nonoverlapping cues, attachment exclusivity/range and authorized-media context validator. YouTube canonicalizer accepts only exact HTTPS hosts/routes/11-char IDs, rejects explicit default ports, credentials, fragments, duplicate IDs and path normalization tricks without network fetch. Shared lint/typecheck PASS;54 tests PASS including23 media/accessibility/URL cases.

## TASK-018 — 2026-10-31 14:43:12 WIB

- Files: `packages/shared/src/schemas/question.schema.ts`, `packages/shared/src/schemas/question.schema.spec.ts`.
- Implementasi/verifikasi: Added strict discriminated six-type draft questions/options, structural UUID/index/range/attachment checks, separate draft completeness issues vs host playability, authorized READY-image reveal-effect context checks and type-bound wire answers. Multiple-select canonicalizes ascending indices while puzzle order is preserved; client score/time objects are rejected. Shared lint/typecheck PASS;65 tests PASS including valid/incomplete fixtures for all6 types and exact key/cardinality/puzzle/POLL/20-text-key boundaries.

## TASK-019 — 2026-10-31 14:45:23 WIB

- Files: `packages/shared/src/schemas/quiz.schema.ts`, `packages/shared/src/schemas/import.schema.ts`, `packages/shared/src/schemas/quiz.schema.spec.ts`.
- Implementasi/verifikasi: Added strict QuizCreate/Write/Summary/Detail/capabilities/pages and versioned JSON/CSV interchange contracts. Create defaults PRIVATE/random; safe legacy bgm IDs preserved. Enforced global question/option ID uniqueness, order,200-question/5MiB limits, media reference declarations and201-map cap, bounded JSON nodes/depth and localized issue locations with uncapped actual count. Shared lint/typecheck PASS;72 tests PASS including six-type draft roundtrip, malformed ownership, nullable fields and oversized serialized payload.

## TASK-020 — 2026-10-31 14:49:13 WIB

- Files: `packages/shared/src/schemas/game.schema.ts`, `packages/shared/src/schemas/game.schema.spec.ts`.
- Implementasi/verifikasi: Implemented strict phase-discriminated HostRoomSync/PlayerRoomSync, public questions/media/roster, timing, accepted answers, reveal/leaderboard and personal result contracts. Rejects pre-reveal keys/private fields/player report access, enforces score sum and role/timing boundaries including8s PODIUM. Added host-only bgmTrack from immutable snapshot for audio recovery and shared FinalizeStatus to avoid report/game cycles. Shared lint/typecheck PASS;79 tests PASS including all8 phases, six-type reveal privacy and reportId ready gate.

## TASK-021 — 2026-10-31 14:51:10 WIB

- Files: `packages/shared/src/schemas/report.schema.ts`, `packages/shared/src/schemas/report.schema.spec.ts`.
- Implementasi/verifikasi: Added report/session/player/question/answer/page schemas and shared finalization re-export. Enforced weighted fractional accuracy with denominator0→null, mutually distinct NOT_PLAYED/NOT_ELIGIBLE/UNANSWERED, partial475=375+100, no POLL/no-points weighted opportunities, early-end snapshots, ready report gate and locale-neutral snapshotVersion1/UTC contract. Shared lint/typecheck PASS;85 tests PASS.

## TASK-022 — 2026-10-31 14:52:51 WIB

- Files: `packages/shared/src/socket-events.ts`, `packages/shared/src/socket-events.spec.ts`, `packages/shared/src/index.ts`.
- Implementasi/verifikasi: Defined all16 client requests/typed event callbacks with event-specific ACKs and20 server payload schemas/envelopes, plus role-specific projection maps. Enforced handshake/event byte caps, strict requestId/member/phase fields, join/recovery token shape and authoritative timing; player maps exclude host report/count payloads. Exported ready shared contracts from index. Shared lint/typecheck/build PASS;93 tests PASS; consumer web/API typecheck PASS after rebuilt shared exports.

## TASK-022A — 2026-10-31 19:37:20 WIB

- Files: `packages/shared/vitest.config.ts`.
- Implementasi/verifikasi: Shared build artifacts remain present, but Vitest now discovers only src/**/*.spec.ts. Config ESLint PASS;11 source suites/99 tests PASS, zero dist suites collected. Vite emits a non-failing future-native-config-loader warning; no warnings or failures suppressed. TASK-023 work remains uncommitted until its own verification/commit.

## TASK-023 — 2026-10-31 19:38:11 WIB

- Files: `packages/shared/src/schemas/locale.schema.ts`, `packages/shared/locales/message-contracts.json`, `packages/shared/src/schemas/locale.schema.spec.ts`, `packages/shared/src/index.ts`.
- Implementasi/verifikasi: Implemented strict extensible BCP47/SemVer manifests,12 namespaces, typed message contracts, diagnostics and hash-bound registry with complete English fallback; production rejects pseudo locales/path/markup/credential injection. Added1102 message contracts tracing61 S/M/B/F surfaces across5 states,95 ErrorCodes, controls/aria/date-number placeholders and revised audio/credits controls. Shared lint/typecheck/build PASS;11 source suites/99 tests PASS. Actual JSON inventory assertion PASS; synthetic catalog generated from all1102 contracts validates against registry schema and owned temp runtime cleaned. ICU AST/duplicate-key compiler checks and actual six-language translations remain their dedicated downstream tasks.

## TASK-023A — 2026-10-31 19:42:56 WIB

- Files: `packages/tsconfig/nestjs.json`.
- Implementasi/verifikasi: Enabled isolatedModules for the existing NodeNext Nest compiler configuration as required by ts-jest. API/database typecheck PASS; API Nest build PASS;19 config tests PASS with no TS151002 warnings. Strict, decorator metadata and skipLibCheck=false retained; no diagnostic suppression. TASK-024 feature files remain unstaged until their own completion.

## TASK-024 — 2026-10-31 19:42:56 WIB

- Files: `apps/api/src/config/env.schema.ts`, `apps/api/src/config/config.service.ts`, `apps/api/src/config/secrets.service.ts`, `apps/api/src/config/config.spec.ts`.
- Implementasi/verifikasi: Implemented typed environment/profile/topology validation for PRD+SA variables, audio manifest path, explicit safe local HTTP, Redis cluster/CIDRs, PORT compatibility and fixed JWT lifetimes. Invalid config errors expose field names only; ConfigService serializes an allowlist without credentials/URLs. Runtime secrets use64 random bytes each, distinct env overrides,0600 no-follow file reads, fsynced temporary inode and exclusive hard-link publication; multi-instance refuses missing shared secrets. API lint/typecheck/build PASS;19 Jest tests PASS including12 concurrent initializers, restart persistence, corrupt/permissive/symlink rejection, profile override and redacted URL errors. Providers are not connected in this task.

## TASK-025 — 2026-11-04 20:48:27 WIB

- Files: `.env.example`, `apps/api/src/app.module.ts`, `apps/api/src/main.ts`.
- Implementasi/verifikasi: Wired globally exported ConfigService/SecretsService through async Nest DI and validated API_PORT startup with graceful shutdown. Added complete env example with commented driver overrides, persistent/generated secret guidance, topology, locale/audio artifacts and browser/internal URL separation. API build/lint/typecheck PASS. Real process smoke: default test startup returns expected404 for absent probe route, restart preserves secret hash, file0600, SIGTERM terminates cleanly, invalid driver exits nonzero without exposing supplied value. No provider readiness/health claim before provider tasks.

## TASK-026 — 2026-11-04 20:50:59 WIB

- Files: `packages/database/src/data-source.factory.ts`, `packages/database/src/schema/column-types.ts`, `packages/database/src/index.ts`, `tests/contracts/database-types.spec.ts`.
- Implementasi/verifikasi: Implemented TypeORM factory for better-sqlite3/PostgreSQL/mysql2 with synchronize=false, progressive entity registry, WAL/FK/busy_timeout5000, UTC settings and bounded pools. Added SA column mappings, safe integer/string BIGINT transforms, JSON/Unicode and boolean conversion; write transactions use verified BEGIN IMMEDIATE on serialized SQLite writers or READ COMMITTED plus explicit parent locks on SQL servers, with up to3 transient retries and25–100ms jitter. Database build/typecheck/lint PASS. Real SQLite, PostgreSQL16 and MySQL8.4 contract suite:4 tests PASS covering maximum safe integers/overflow, JSON/Unicode/booleans, rollback, transient retry and actual BEGIN IMMEDIATE statement; owned containers/temp data cleaned.

## TASK-027 — 2026-11-04 20:53:05 WIB

- Files: `packages/database/src/schema/settings.schema.ts`, `packages/database/src/schema/users.schema.ts`, `packages/database/src/schema/auth.schema.ts`, `packages/database/src/index.ts`.
- Implementasi/verifikasi: Model tabel dan registry TypeORM sesuai SA. Typecheck, lint, build lulus. Metadata tiga dialek cocok dengan seluruh nama kolom SA, setiap foreign key memiliki indeks dan ON UPDATE NO ACTION. Sinkronisasi schema uji SQLite in-memory berhasil. Migrasi deployment diverifikasi di task berikutnya.

## TASK-028 — 2026-11-04 20:53:12 WIB

- Files: `packages/database/src/schema/quizzes.schema.ts`, `packages/database/src/schema/media.schema.ts`, `packages/database/src/index.ts`.
- Implementasi/verifikasi: Model tabel dan registry TypeORM sesuai SA. Typecheck, lint, build lulus. Metadata tiga dialek cocok dengan seluruh nama kolom SA, setiap foreign key memiliki indeks dan ON UPDATE NO ACTION. Sinkronisasi schema uji SQLite in-memory berhasil. Migrasi deployment diverifikasi di task berikutnya.

## TASK-029 — 2026-11-04 20:53:16 WIB

- Files: `packages/database/src/schema/runtime.schema.ts`, `packages/database/src/schema/jobs.schema.ts`, `packages/database/src/index.ts`.
- Implementasi/verifikasi: Model tabel dan registry TypeORM sesuai SA. Typecheck, lint, build lulus. Metadata tiga dialek cocok dengan seluruh nama kolom SA, setiap foreign key memiliki indeks dan ON UPDATE NO ACTION. Sinkronisasi schema uji SQLite in-memory berhasil. Migrasi deployment diverifikasi di task berikutnya.

## TASK-030 — 2026-11-04 20:53:21 WIB

- Files: `packages/database/src/schema/reports.schema.ts`, `packages/database/src/index.ts`.
- Implementasi/verifikasi: Model tabel dan registry TypeORM sesuai SA. Typecheck, lint, build lulus. Metadata tiga dialek cocok dengan seluruh nama kolom SA, setiap foreign key memiliki indeks dan ON UPDATE NO ACTION. Sinkronisasi schema uji SQLite in-memory berhasil. Migrasi deployment diverifikasi di task berikutnya.

## TASK-030A — 2026-11-04 20:54:26 WIB

- Files: `packages/database/src/schema/column-types.ts`.
- Implementasi/verifikasi: Typecheck dan lint lulus. Contract migrasi SQLite berhasil menginsert user dengan is_active/auth_version/revision dari default SQL. NULL dan undefined diteruskan tanpa mengubah validasi nilai yang diberikan.

## TASK-031 — 2026-11-04 20:54:31 WIB

- Files: `packages/database/src/migrations/sqlite/0001-initial.ts`, `tests/contracts/migration-sqlite.spec.ts`.
- Implementasi/verifikasi: Migrasi awal sqlite memakai SQL versioned dengan checksum, singleton global dan default BGM random. Typecheck/lint dan contract test pada engine sqlite nyata lulus: 17 tabel, dua kali migrasi mempertahankan perubahan settings, CHECK dan FK menolak mutasi invalid, ID BGM kustom tetap tersimpan.

## TASK-032 — 2026-11-04 20:54:39 WIB

- Files: `packages/database/src/migrations/postgres/0001-initial.ts`, `tests/contracts/migration-postgres.spec.ts`.
- Implementasi/verifikasi: Migrasi awal postgres memakai SQL versioned dengan checksum, singleton global dan default BGM random. Typecheck/lint dan contract test pada engine postgres nyata lulus: 17 tabel, dua kali migrasi mempertahankan perubahan settings, CHECK dan FK menolak mutasi invalid, ID BGM kustom tetap tersimpan.

## TASK-033 — 2026-11-04 20:54:52 WIB

- Files: `packages/database/src/migrations/mysql/0001-initial.ts`, `tests/contracts/migration-mysql.spec.ts`.
- Implementasi/verifikasi: Migrasi awal mysql memakai SQL versioned dengan checksum, singleton global dan default BGM random. Typecheck/lint dan contract test pada engine mysql nyata lulus: 17 tabel, dua kali migrasi mempertahankan perubahan settings, CHECK dan FK menolak mutasi invalid, ID BGM kustom tetap tersimpan.

## TASK-034 — 2026-11-04 21:03:12 WIB

- Files: `packages/database/src/migrations/migration-runner.ts`, `scripts/migrate.ts`, `packages/database/src/index.ts`, `tests/contracts/migration-runner.spec.ts`.
- Implementasi/verifikasi: Migration runner memakai lock koneksi PostgreSQL/MySQL atau lock transaksi eksklusif file SQLite, pengecekan checksum dan readiness read-only ketika auto-migrate dinonaktifkan. Typecheck/lint/build database lulus. Tiga contract test pada database nyata lulus: dua koneksi startup konkuren, checksum berubah ditolak, migrasi yang belum diterapkan ditolak jika auto=false, dan pemulihan setelah kegagalan DDL parsial MySQL.

## TASK-035 — 2026-11-04 21:05:05 WIB

- Files: `packages/database/src/repositories/users.repository.ts`, `packages/database/src/repositories/settings.repository.ts`, `packages/database/src/repositories/auth.repository.ts`, `tests/contracts/accounts.repository.spec.ts`.
- Implementasi/verifikasi: Repository akun memakai transaksi dan lock settings/user/invite/token untuk setup, registrasi dan rotasi. Email dinormalisasi, superadmin aktif terakhir dilindungi, perubahan role/status membatalkan token, replay refresh mencabut family setelah commit, dan expiry family dipertahankan. Typecheck/lint lulus. Tiga contract test engine nyata lulus untuk setup konkuren, undangan sekali pakai, last-admin, rollback gagal insert saat refresh dan revocation setelah replay.

## TASK-036 — 2026-11-04 21:06:40 WIB

- Files: `packages/database/src/repositories/quizzes.repository.ts`, `tests/contracts/quizzes.repository.spec.ts`.
- Implementasi/verifikasi: Repository kuis memeriksa visibilitas, owner, revisi, ID soal/opsi dan READY media di bawah lock. Duplicate PUBLIC menghasilkan PRIVATE dengan ID baru serta mempertahankan referensi media sah. Build typecheck/lint dan tiga pengujian database nyata lulus, termasuk pencarian wildcard literal, dua save satu revisi, rollback setelah insert opsi gagal, ID asing, dan akses media lintas pemilik.

## TASK-037 — 2026-11-04 21:08:45 WIB

- Files: `packages/database/src/repositories/media.repository.ts`, `tests/contracts/media.repository.spec.ts`.
- Implementasi/verifikasi: Reservasi UPLOADING, transisi berbasis revisi, lock referensi cover/question/room_media, klaim cleanup maksimal 100 orphan tertua, kompensasi delete dan metrik READY tersedia. Typecheck/lint lulus. Tiga contract test engine nyata lulus untuk race attach/delete, rollback metadata invalid, stale revision, asal storage, pemulihan READY dan pengecualian upload aktif dari cleanup.

## TASK-038 — 2026-11-04 21:10:04 WIB

- Files: `packages/database/src/repositories/runtime.repository.ts`, `tests/contracts/runtime.repository.spec.ts`.
- Implementasi/verifikasi: Reservasi SQL memeriksa kapasitas di bawah lock singleton, memvalidasi kuis, membuat snapshot dan pin media terurut, lalu menyimpan dedup dan PIN enam digit dalam satu transaksi. Aktivasi dan release memakai sessionId/status. Typecheck/lint lulus. Contract tests pada SQLite, PostgreSQL dan MySQL membuktikan batas kapasitas saat konkurensi, batas collision PIN, replay request tanpa slot tambahan, perlindungan media dan penolakan release dari sessionId lama.

## TASK-039 — 2026-11-04 21:10:59 WIB

- Files: `packages/database/src/repositories/jobs.repository.ts`, `tests/contracts/jobs.repository.spec.ts`.
- Implementasi/verifikasi: Antrean finalisasi menyimpan payload dan SHA256 kanonis per sessionId. Claim CAS menggunakan token lease unik per percobaan, lease 30 detik, retry terjadwal dan reset manual untuk host. Typecheck/lint lulus. Pada SQLite/Postgres/MySQL, dua worker hanya memperoleh satu claim, lease kedaluwarsa dapat diambil alih, worker lama ditolak, hash berbeda ditolak, dan allocation tetap ada setelah gagal.

## TASK-040 — 2026-11-04 21:12:22 WIB

- Files: `packages/database/src/repositories/reports.repository.ts`, `tests/contracts/reports.repository.spec.ts`.
- Implementasi/verifikasi: Penyimpanan laporan menggunakan satu transaksi yang memverifikasi hash dan lease, menetapkan UUIDv5 histori dan menulis semua batch serta status READY. Referensi sumber hilang menjadi NULL. Akses baca memeriksa host aktif, session/player dan pagination deterministik. Typecheck/lint lulus. Contract tests pada tiga engine menyuntikkan kegagalan pada masing-masing dari empat batch dan membuktikan semua tabel laporan tetap kosong, lalu menguji retry idempoten, pemilik asing dan penghapusan kuis sumber.

## TASK-041 — 2026-11-05 (Asia/Jakarta)

- Files: `packages/database/src/repositories/operations.repository.ts`, `packages/database/src/repositories/audit.repository.ts`, `tests/contracts/operations.repository.spec.ts`.
- Implementasi/verifikasi: Typecheck, lint dan build package database lulus. Contract suite operations.repository.spec.ts lulus 3/3 pada SQLite, PostgreSQL dan MySQL. Verifikasi mencakup canonical hash, klaim konkuren satu mutasi, konflik payload, isolasi aktor, rollback mutasi/audit/dedup, renewal 30s dengan lease 120s, rekonsiliasi lease kedaluwarsa tanpa mengulang mutasi, penolakan completion lama, retensi 24h yang mempertahankan pending belum direkonsiliasi, receipt tanpa credential, lookup loss host/session 30 hari, dan purge audit maksimal 1000 baris.
- Integrasi: callback memakai EntityManager transaksi yang sama. Respons replay direkonstruksi dan diotorisasi ulang oleh service dari resource receipt; payload bebas tidak disimpan. Renewal dijadwalkan caller memakai OPERATION_TIMING.renewalMs.
- Handoff: pause sesuai permintaan pengguna, TASK-042 belum dimulai.

## TASK-042 — 2026-11-05 20:36:19 WIB

- Files: `apps/api/src/providers/database/database.module.ts`, `apps/api/src/app.module.ts`, `packages/database/src/index.ts`, `apps/api/src/providers/database/database.module.spec.ts`.
- Implementasi/verifikasi: DatabaseModule mengekspor DataSource dan sepuluh repository lewat DI, memigrasi 17 entity sebelum bootstrap, menutup koneksi saat shutdown maupun kegagalan migrasi, dan meredaksi error tanpa fallback driver. API typecheck, lint, build serta 4 unit test lifecycle/boot/error lulus; database build lulus.

## TASK-043 — 2026-11-05 20:37:49 WIB

- Files: `apps/api/src/providers/storage/storage.interface.ts`, `apps/api/src/providers/storage/local-storage.adapter.ts`, `apps/api/src/providers/storage/local-storage.adapter.spec.ts`.
- Implementasi/verifikasi: Kontrak storage dan LocalStorageAdapter menyediakan upload UUID immutable, publikasi atomic hard-link tanpa overwrite, byte-size verification, readHead, delete idempoten dan health teredaksi. Key/folder/MIME divalidasi; file dan folder symlink ditolak. API typecheck/lint lulus; 3 unit test mencakup exact bytes, collision, missing delete, traversal, symlink dan filesystem failure.

## TASK-044 — 2026-11-05 20:39:42 WIB

- Files: `apps/api/src/providers/storage/s3-storage.adapter.ts`, `apps/api/src/providers/storage/storage-registry.ts`, `tests/contracts/storage.spec.ts`.
- Implementasi/verifikasi: S3 upload memakai conditional put immutable, size verification, path-style/public URL dan timeout; health/errors teredaksi. Registry memakai credential references dan ledger fingerprint persisten untuk menolak perubahan origin ID lintas restart serta mempertahankan historical origin. API typecheck/lint dan 2 contract tests lulus termasuk MinIO nyata, browser fetch exact bytes/header, overwrite refusal, missing delete, origin lookup dan health unavailable. AWS/R2/Spaces belum diklaim terverifikasi.

## TASK-045 — 2026-11-05 20:41:45 WIB

- Files: `apps/api/src/providers/storage/storage.module.ts`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `tests/integration/storage-serving.spec.ts`.
- Implementasi/verifikasi: StorageModule mengikat adapter dan registry dari konfigurasi, mempersistenkan ledger origin dan menutup klien S3 saat shutdown. /uploads memakai confined file handle, MIME allowlist, nosniff, immutable cache, HEAD serta single byte-range. API typecheck/lint/build, seluruh 26 unit test dan integration test API proses nyata lulus untuk exact bytes/header, range, missing object, traversal/symlink dan missing origin.

## TASK-046 — 2026-11-06T09:39:30+07:00

- Files: `apps/api/src/providers/state/game-state.interface.ts`, `apps/api/src/providers/state/private-state.schema.ts`, `apps/api/src/providers/state/private-state.schema.spec.ts`.
- Implementasi/verifikasi: Schema privat strict mencakup room/player, snapshot kuis, jawaban, freeze/result, lease/ticket/receipt terpisah dan reservasi kapasitas. Kontrak operasi atomik melarang read-modify-write gameplay generik. Frozen report menolak credential/socket, memvalidasi referensi dan batas byte; UUIDv5 terbatas pada ID histori yang dihasilkan. Frozen install, build shared/database, API typecheck/lint dan 7 unit test lulus.


## TASK-047 — 2026-11-06T09:50:12+07:00

- Files: `apps/api/src/providers/state/memory-state.store.ts`, `memory-state.store.spec.ts`; task checklist/log.
- Implemented synchronous atomic memory operations, authoritative clock, delayed skip/end ACK until scoring commit, session/generation fences, dedup, logical expiry/sweep, durable-report retention and injected role projection.
- Verification: API lint dan typecheck lulus; 17 unit test memory-state lulus (inclusive deadline, answer/close race, replay/conflict, freeze/CAS once, empty required set, generation, PIN reuse, lease epoch, detached state, retention, join receipt, scheduler CAS dan friendly ticket).


## TASK-048A — 2026-11-06T09:55:09+07:00

- Files: `tests/jest.contracts.config.cjs`; task checklist/log.
- Added compiler mapping for built shared subpath declarations, matching the existing runtime mapper.
- Verification: Compiler contract berhasil memuat private state schema; 8 test Redis dieksekusi (7 lulus, satu assertion urutan key JSON diperbaiki dalam TASK-048). ESLint config dan API typecheck/lint lulus; strict diagnostics tetap aktif.


## TASK-048 — 2026-11-06T09:56:08+07:00

- Files: `apps/api/src/providers/state/lua/{mutate-room,bind-player,release-room}.lua`, `tests/contracts/redis-room.spec.ts`; checklist/log.
- Added bounded same-slot room commands, generation/ticket/receipt binding, logical TTL, conditional lease epochs and frozen-report-safe release. Redis cjson empty array restoration remains the typed adapter responsibility in TASK-050.
- Verification: 10 contract test Redis 7 nyata lulus melalui container terisolasi; API lint/typecheck dan ESLint contract lulus. Test menggunakan sudo untuk akses socket Docker yang tidak tersedia bagi user shell. Tidak ada test skipped.


## TASK-049 — 2026-11-06T09:59:18+07:00

- Files: `apps/api/src/providers/state/lua/admit-answer.lua`, `close-question.lua`, `tests/contracts/redis-answers.spec.ts`; checklist/log.
- Atomic Redis TIME admission, immutable answer/freeze, last-required-answer close, immediate skip/end, complete totals/result/phase CAS. Controlled clock is substituted only in test-loaded source; production has no caller timestamp override.
- Verification: 10 contract test Redis 7 nyata lulus: deadline/+1500/+1501, concurrent submit/skip, duplicate ACK setelah reveal, freeze recovery, result CAS once, empty required set, stale generation/revision dan SHA-256 vectors. API lint/typecheck dan ESLint contract lulus.


## TASK-049B — 2026-11-06T10:01:26+07:00

- Files: `lua/mutate-room.lua`, `lua/close-question.lua`, `tests/contracts/redis-answers.spec.ts`; checklist/log.
- Persisted pending host command receipts through scoring commit and added session-bound finalization maintenance after logical expiry.
- Verification: 23 contract test Redis nyata lulus (room + answers), termasuk delayed host ACK/dedup, freeze report CAS/PERSIST, durable guard dan READY monotonic. API lint/typecheck dan ESLint contract lulus.


## TASK-050A — 2026-11-06T10:02:48+07:00

- Files: `apps/api/nest-cli.json`; checklist/log.
- Nest build/watch now includes Lua runtime assets.
- Verification: API build/lint/typecheck lulus; kelima Lua asset dist byte-identical dengan source.


## TASK-050 — 2026-11-06T13:33:10+07:00

- Files: `apps/api/src/providers/state/redis-state.store.ts`, `state.module.ts`, `apps/api/src/app.module.ts`, `tests/contracts/state-parity.spec.ts`; checklist/log.
- Implementasi: seluruh kontrak state memakai Lua, validasi typed, pemulihan array cjson sesuai schema, namespace/session fencing, Redis TIME dan reload NOSCRIPT pada node pemilik slot. Nest memilih memory/Redis tanpa fallback; koneksi command/pub/sub terpisah, startup dibatasi 5 detik, shutdown membatalkan reconnect. Host skip/end menunggu receipt hasil commit (batas tunggu 5 detik, lalu OPERATION_PENDING untuk rekonsiliasi).
- Verifikasi: API build/typecheck/lint PASS; 50 unit test PASS; ESLint contract PASS; 22 contract test PASS pada memory, Redis 7 nyata dan cluster tiga master. Cakupan: join/recovery/generation, dedup, freeze/result CAS, lease epoch, TTL, PIN reuse, finalization, script flush, reconnect/unavailable, namespace isolation dan distribusi event Socket.io antar dua adapter. Semua container milik run dibersihkan; sudo diperlukan untuk socket Docker.
- Integrasi downstream: `StateProjection.register` menunggu projector domain dan gagal tertutup sebelum registrasi; gateway kelak memanggil `StateConnections.install`. Cluster routing/cache reload terverifikasi; failover/data-loss dan benchmark skala tetap task hardening tersendiri.

- Verifikasi ulang sebelum commit (2026-11-06): API lint/typecheck/build, 50 unit test dan 22 contract test state-parity lulus.

## TASK-051 — 2026-11-06T13:37:16.323074+07:00

- Files: `apps/api/src/common/zod-validation.pipe.ts`, `error.filter.ts`, `request-context.middleware.ts`, `apps/api/src/main.ts`; checklist/log.
- Implementasi: strict schema pipe; trusted application error envelope dan generic fallback; server UUID/no-store; JSON 5MiB dan aggregate multipart limits (chunked juga), allowlist upload/import, GET/DELETE body rejection. Parser route tetap wajib enforce file limits dari settings.
- Verifikasi: API lint/typecheck/build PASS; 10 assertion HTTP dengan Supertest pada controller Nest terisolasi PASS: JSON400, extra body/query422, success201, redacted500, unsupported415, oversized413, missing404, malformed multipart400, correlation/no-store. Script smoke sementara `/tmp/kabuki-http-boundary-smoke.cjs`; endpoint produk belum tersedia.

## TASK-052 — 2026-11-06T13:40:54.289154+07:00

- Files: `apps/api/src/common/rate-limit.service.ts`, `guards/origin.guard.ts`, `rate-limit.service.spec.ts`, `apps/api/src/main.ts`; checklist/log.
- Implementasi: exact HTTP/WS tiers, Redis TIME atomic multi-window limiter, memory parity, fail503, bounded counters; upload2/cleanup1 renewable120s leases. SHA256 principal keys; trusted CIDR XFF parsing; exact Origin/client header, credentialed CORS/Vary. Auth hashing queue tetap terpisah pada TASK-055.
- Verifikasi: API lint/typecheck/build PASS; 11 tests memory/Redis7 PASS, termasuk combined check/join, concurrency, expiry, outage dan spoofed forwarding. Docker memakai sudo; container dibersihkan. Route-specific/WS tiers dipanggil downstream sesudah identitas diverifikasi; public tier/Origin terpasang di bootstrap.

## TASK-053A — 2026-11-06T13:42:56.136298+07:00

- Files: `packages/database/src/repositories/audit.repository.ts`, `tests/contracts/operations.repository.spec.ts`; checklist/log.
- Parameter retensi7–365 hari untuk purge, default30; validasi sebelum query dan batch1000 tetap.
- Verifikasi: database lint/typecheck/build PASS; 3 contract test SQLite/PostgreSQL/MySQL PASS, termasuk batas retensi dan invalid input.

## TASK-053 — 2026-11-06T13:44:50.768602+07:00

- Files: `apps/api/src/common/audit.service.ts`, `metrics.service.ts`, `audit.service.spec.ts`; checklist/log.
- Audit projection allowlist, UTC/stdout/SQL, redacted errors; runtime retention7–365 daily purge1000, scheduler lifecycle. Closed metric names/error-code labels, latency histograms dan throttled failed-job alarm.
- Verifikasi: API lint/typecheck PASS; 6 tests SQLite nyata PASS termasuk canary secret, retention bounds/batch, scheduler shutdown dan metrics. Provider wiring menunggu TASK-058; worker alarm call sites menunggu finalization tasks.


## TASK-054A — 2026-11-06T18:23:45+07:00

- Files: `packages/database/src/repositories/operations.repository.ts`, `tests/contracts/operations.repository.spec.ts`; checklist/log.
- Implementasi: operasi internal auth.setup/auth.register/invitation.create memakai receipt resourceId tanpa menyimpan token atau kode undangan. Contract membuktikan retry concurrent mengeksekusi mutation sekali, receipt DONE konsisten, dan enum query publik menolak ketiga operasi credential. Replay error HTTP khusus tetap tanggung jawab TASK-054.
- Verifikasi: shared/database build, database typecheck/lint, ESLint contract dan Prettier source PASS; 3 contract test SQLite/PostgreSQL/MySQL nyata PASS tanpa skip. Run awal hanya SQLite lulus karena akses Docker; rerun lengkap memakai sudo untuk socket Docker lulus dan runtime membersihkan container uji.

## TASK-054 — 2026-11-06T18:29:43.638784+07:00

- Files: `apps/api/src/common/idempotency.service.ts`, `operations.controller.ts`, `idempotency.service.spec.ts`; checklist/log.
- Canonical HTTP/file hashing, transactional receipts, current-resource authorization on replay/lookup, credential replay exceptions, reservation/reconciliation and 30-second lease renewal. Fresh responses are tied to the committed receipt, including transaction retries. Strict GET operations controller requires an authenticated access provider; production wiring belongs to TASK-058.
- Verification: API lint/typecheck PASS; 10 tests PASS against real SQLite, including HTTP 200/401/404/422, lost response, hash conflict, actor isolation, credential canaries, rollback, expired lease reconciliation and renewal loss.

## TASK-055A — 2026-11-06T18:32:26.237693+07:00

- Files: `packages/database/src/repositories/auth.repository.ts`, `tests/contracts/accounts.repository.spec.ts`; checklist/log.
- Explicit credential-only password hash selection, normalized lookup, locked session insertion with current active/hash/version checks, and actor-scoped idempotent family logout by session identifier.
- Verification: database lint/typecheck/build PASS; all 3 SQLite/PostgreSQL/MySQL account contracts PASS, including stale credentials, rollback, foreign actor isolation, repeated logout and inactive users. Docker contract runner used sudo for socket access.

## TASK-055 — 2026-11-06T18:36:15.346797+07:00

- Files: `apps/api/src/modules/auth/auth.service.ts`, `refresh.service.ts`, `refresh.service.spec.ts`; checklist/log.
- Argon2id m65536/t3/p1/salt16 with shared two-job/twenty-waiter bound, dummy verification and uniform login denial; transactional session insertion. HS256 access900s and separate-secret/audience refresh7d absolute families, SHA256 persistence, locked rotation/reuse revocation, current user/version checks, scoped idempotent logout and narrow cookie options.
- Verification: API lint/typecheck PASS; 10 real SQLite/Argon2/JWT tests PASS. Two concurrent hashes measured 230ms, RSS baseline212017152 bytes, sampled peak352788480 bytes (delta140771328 bytes); local test-run measurement, not a production benchmark. Tests cover consumed/reused/concurrent refresh, expiry, inactive/stale users, wrong audience/algorithm/signature, logout, hash saturation503 and cookie attributes.

## TASK-056A — 2026-11-06T18:37:58.509367+07:00

- Files: `packages/database/src/repositories/auth.repository.ts`, `settings.repository.ts`, `tests/contracts/accounts.repository.spec.ts`; checklist/log.
- Setup/register can share a caller-owned active transaction from the same database; standalone calls retain their own transaction. Added typed current settings lookup.
- Verification: database lint/typecheck/build PASS; all 3 real SQLite/PostgreSQL/MySQL account contracts PASS. Forced composed setup/register failure rolls back account, refresh token, initialized flag, invitation consumption and operation receipt together; nontransactional manager rejected. Docker runner used sudo.

## TASK-056 — 2026-11-06T18:40:31.662399+07:00

- Files: `apps/api/src/modules/auth/setup.service.ts`, `setup.service.spec.ts`; checklist/log.
- Setup/status and registration services validate strict inputs, hash passwords outside SQL locks, and commit account/token/policy/receipt in one transaction. Registration scope uses a hashed canonical email. Credential replay returns409 without new tokens. Status reflects persisted defaultLocale (`id` baseline).
- Verification: API lint/typecheck PASS; 5 real SQLite/Argon2 service tests PASS covering first-admin race, lost-response replay, PUBLIC/SINGLE_ADMIN/INVITE_ONLY, concurrent single-use invitation, duplicate email and forced rollback/retry.

## TASK-057 — 2026-11-06T18:44:13.152593+07:00

- Files: `apps/api/src/common/guards/jwt.guard.ts`, `roles.guard.ts`, `ownership.guard.ts`, `guards.spec.ts`; checklist/log.
- Verified principals use private WeakMaps shared across Nest guard instances; role and ownership checks revalidate JWT/current SQL user on each action. PUBLIC reuse, owner-only mutation, private/report404 and no SUPERADMIN bypass; reusable host checks use server-owned host identity.
- Verification: API lint/typecheck PASS; 5 real SQLite/JWT/service/HTTP tests PASS, covering fabricated principals, forged/stale/inactive tokens, ignored role claims, owner/PUBLIC/private/report matrices, host identity and title non-disclosure.

## TASK-058 — 2026-11-06T18:48:23.002733+07:00

- Files: `apps/api/src/modules/auth/auth.controller.ts`, `auth.module.ts`, `apps/api/src/common/common.module.ts`, `apps/api/src/app.module.ts`; checklist/log.
- Seven auth routes with strict queries/bodies, tiered limits, cookie parsing and scoped HttpOnly/SameSite cookies; secure flag follows configured public API HTTPS. Common providers wire audit/metrics, auth/ownership guards and actor-scoped operation lookup with current resource access.
- Verification: API lint/typecheck/build PASS; 30 auth/guard/idempotency regression tests PASS. Isolated actual Nest app HTTP assertions PASS for setup201/replay409, login200/me200/register201, refresh rotation200, repeated logout200, inactive401, Origin403, strict422 and operations401/404. No credential in response DTO/receipt; runtime cleanup completed.

## TASK-059A — 2026-11-06T23:26:20.949572+07:00

- Files: users/auth repositories, accounts repository contract; task checklist/log.
- Added strict user paging and literal search, explicit missing-resource outcomes, hash-only invitation creation within operation transactions, and locked idempotent revocation with used-invitation protection.
- Verification: database lint/typecheck/build PASS; 3 real SQLite/PostgreSQL/MySQL contracts PASS (Docker through sudo). Covers literal wildcards, filtering/paging, missing IDs, used/repeated revoke and transaction rollback.

## TASK-059 — 2026-11-06T23:29:10.730145+07:00

- Files: users/invitations services and users service test; task checklist/log.
- Current SUPERADMIN checks, strict filters and revision patches, atomic last-admin guard and session revocation, cryptographic one-time invitation generation with hash-only persistence and replay denial, status/revoke rules.
- Verification: API lint/typecheck PASS; 4 real SQLite/JWT service tests PASS including concurrent last-admin changes, stale identity/revision, literal search, DTO secrecy, concurrent invitation replay and status precedence.

## TASK-060 — 2026-11-06T23:31:54.359950+07:00

- Files: users controller/module, app module, users HTTP integration test; task checklist/log.
- Registered all five SUPERADMIN/ADMIN-tier routes with strict queries, quoted If-Match validation, ETag updates, one-time invitation responses and static route ordering.
- Verification: API lint/typecheck/build PASS; real built API HTTP integration PASS across five routes, CREATOR403/no metadata, paging/filter422, absent/stale revisions, last-admin409, access/refresh revocation401, invitation replay409 without plaintext, used revoke409 and repeated unused revoke200. Test uses isolated runtime and cleans up server/database.

## TASK-061 — 2026-11-06T23:34:26.116261+07:00

- Files: quiz validator/snapshot/domain test and question shuffler; task checklist/log.
- Draft warnings versus host rejection, current READY media and authorized retained-reference checks, independent private snapshots with context-specific accessibility and URLs; cryptographic Fisher–Yates with independent public IDs/index/colors and server-only source mapping.
- Verification: API lint/typecheck PASS; 9 domain tests PASS across six question types, strict/foreign/missing media boundaries, source mutation isolation, all 24 puzzle permutations (including identity), public field allowlist and text-answer secrecy.

## TASK-062A — 2026-11-06T23:35:59.297360+07:00

- Files: quizzes repository and contract test; task checklist/log.
- Added same-database active transaction composition for create/duplicate/read, authorized creator/media hydration and internal current-media lookup for validation.
- Verification: database lint/typecheck/build PASS; 3 real SQLite/PostgreSQL/MySQL contracts PASS, including composed create/duplicate rollback with receipts, manager rejection, retained foreign references and ownership/revision regression.

## TASK-062 — 2026-11-06T23:38:10.616024+07:00

- Files: quizzes service and service test; task checklist/log.
- Own/public listing and allowlisted hydrated detail, strict create/save, private duplication with new IDs, revision delete, and atomic resource receipts with current replay authorization. Retained foreign media does not confer edit/delete rights.
- Verification: API lint/typecheck PASS; 4 SQLite/JWT service tests PASS for owner/public/admin permission matrix, same-key concurrent create/duplicate, deleted-resource replay denial, draft warnings, stale revision, snapshot isolation and retained-versus-forged foreign media.

## TASK-063 — 2026-11-06T23:40:26.923758+07:00

- Files: quizzes controller/module, app module and quiz HTTP integration test; task checklist/log.
- Six authenticated READ/WRITE routes, strict query/body checks, quoted If-Match and ETags, shared service export for engine reuse.
- Verification: API lint/typecheck/build PASS; real built-server HTTP integration PASS covering all six routes, default limit12, same-key create/duplicate, private404/public mutation403, absent/stale revisions, 5MiB413, delete and deleted-resource replay denial.

## TASK-064 — 2026-11-06T23:43:56.529462+07:00

- Files: quiz import/export, transfer tests and docs/import-format.md; task checklist/log.
- Strict UTF-8/BOM, bounded JSON and RFC4180 CSV with exact 17 headers; all six types/draft semantics, safe export filenames, new PRIVATE import IDs, owned READY media mapping without URL fetch, bounded diagnostics and format guide.
- Verification: API lint/typecheck PASS; 5 transfer tests PASS including JSON/CSV roundtrips, malformed headers/cells/UTF-8/version/depth/bytes, 600 actual issues capped to 200, foreign/pending media denial and no network requests.

## TASK-064A — 2026-11-07T04:26:59.025848+07:00

- Files: quizzes repository/contract and quiz import parser; task checklist/log.
- Added transactional PRIVATE draft insertion with fresh graph IDs and locked owned READY media checks. Exposed bounded structural parsing for precise media resolution before import validation.
- Verification: database lint/typecheck/build and API lint/typecheck PASS; 3 real SQLite/PostgreSQL/MySQL contracts and 5 transfer unit tests PASS. Initial container run lacked socket access; full rerun through sudo passed. Tests cover graph/receipt rollback, foreign media rejection, active-manager requirement and successful import persistence.

## TASK-001A — 2026-11-08T09:08:52+07:00

- Files: `package.json`, `packages/tsconfig/package.json`, `pnpm-lock.yaml`, `docs/vibe/03-system-analysis.md`; task checklist/log.
- Root and `@kabuki-neko/tsconfig` `engines.node` raised to `>=26.13.0` (`.node-version` stays 26.13.0, pnpm 10.34.9). Root `@types/node` pinned exact to 26.6.6 (latest 26.x, published 2026-10-28). Root `better-sqlite3` 13.0.3 → 12.11.1 to match `packages/database` and the TypeORM 0.3.31 peer range. SA §1.1 runtime row/rationale and SA §10.2 Docker image now state Node 26.
- Verification PASS: `pnpm install` then `pnpm install --frozen-lockfile` (lockfile SHA-256 `63a17582…4192a86` unchanged); `node --version` v26.13.0; `pnpm -r ls better-sqlite3 --depth 0` only 12.11.1; `better-sqlite3` opens `:memory:` from `packages/database` without ABI error; `pnpm build` 4/4, `pnpm typecheck` 6/6, `pnpm lint` 6/6; API Jest 15 suites/119 tests; contracts `migration-sqlite|migration-runner|database-types` 3 suites/8 tests.

## TASK-001C — 2026-11-08T09:13:43+07:00

- Files: `packages/shared/package.json`, `packages/database/package.json`, `pnpm-lock.yaml`; task checklist/log.
- `@types/node` in shared and database pinned exact to 26.6.6 (same as root, TASK-001A); database `better-sqlite3` stays 12.11.1.
- Ordering note: executed before TASK-001B. Both depend only on TASK-001A, but bumping api/web first left `typeorm` resolved under two peer variants (`@types/node` 24 for database, 26 for api), which broke three `database.module.spec.ts` spies (`DataSource` from a different module instance). With database on 26 first, TASK-001B can complete the single-variant state; the workspace-wide "single `@types/node` 26.x" check is therefore asserted at the end of TASK-001B (now: root/shared/database 26.6.6, api/web still 24.19.2).
- Verification PASS: `pnpm install` then `pnpm install --frozen-lockfile` (lockfile SHA-256 `c50f74ab…5a192c9` unchanged); shared typecheck/lint/build and Vitest 11 files/99 tests; shared `tsc --noEmit --incremental false`; database typecheck/lint/build; contracts `migration-sqlite|migration-runner|database-types` 3 suites/8 tests.

## TASK-001B — 2026-11-08T09:16:42+07:00

- Files: `apps/api/package.json`, `apps/web/package.json`, `apps/web/next.config.ts`, `pnpm-lock.yaml`; task checklist/log.
- `@types/node` in api and web pinned exact to 26.6.6 (same as root/shared/database). The workspace now resolves a single `@types/node` 26.6.6 and a single `typeorm` peer variant in the lockfile.
- `apps/web/next.config.ts`: the `declare global` block for `URLPatternInput`/`URLPatternOptions` is still required — Node 26 types expose `URLPattern`, `URLPatternInit` and `URLPatternResult` globally, but the input/options aliases stay scoped to `"node:url"`; Next 16.4 `spec-extension/url-pattern.d.ts` references them globally. Removing the block passed the incremental `tsc` (stale `.tsbuildinfo`) but failed with `--incremental false` (TS2304/TS2552), so the block stays and its comment now names Node 26. `nextConfig` options unchanged.
- Verification PASS: `pnpm install --frozen-lockfile` stable (SHA-256 `5b1fb5eb…dfe550`); `pnpm -r ls @types/node --depth 0` → only 26.6.6 (5 packages); api typecheck/lint/build and Jest 15 suites/119 tests; web typecheck/lint/build plus `tsc --noEmit --incremental false`.

## TASK-065 — 2026-11-08T09:27:25+07:00

- Files: `apps/api/src/modules/quizzes/quizzes.controller.ts`, `quizzes.service.ts`, `quizzes.module.ts`, `tests/integration/quiz-transfer.spec.ts`; task checklist/log.
- Routes: `GET /quizzes/import-template?format=json|csv` (READ; declared before `:id`), `GET /quizzes/:id/export?format=json` (EXPORT; owner or PUBLIC viewer via the authorized read), `POST /quizzes/import` (UPLOAD; multipart `file` + optional `mediaMap`). Downloads use server-generated ASCII filenames (`<uuid>.kabukineko.json`, `kabukineko-import-template.{json,csv}`), never titles or uploaded names.
- Import: in-memory multer parser (1 file ≤5 MiB, 1 field ≤256 KiB, 2 parts); extension selects JSON/CSV and the client MIME must corroborate it (415 otherwise); `mediaMap` JSON validated (422). The document is parsed and bounded first, then one `quiz.import` operation transaction (request hash includes the file SHA-256) looks up only referenced media with the transaction manager, runs full import validation, inserts the PRIVATE draft (`importDraft`) and returns `QuizDetail` plus the `IMPORTED_AS_PRIVATE` notice. Any failure rolls back the receipt and every row.
- Template: one playable quiz covering all six types (puzzle order 2,0,3,1; two TYPE_ANSWER keys; POLL ×0) as pretty JSON or the exact 17-header CRLF CSV produced by a documented RFC4180 serializer.
- Blocker resolved: first integration run showed every multipart import missing its file; fixed by corrective TASK-064B (request stream paused for the route parser).
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/quiz-transfer.spec.ts` 6 tests — templates (401/422/headers), JSON+CSV template import and export roundtrip of all six types, missing media 422 at `questions.0.mediaRef`/`rows.2.media_ref` with unchanged SQLite quiz/question/option/receipt counts and key reuse after rollback, malformed/unsupported/oversize errors (400/415/422/413), lost-ACK lookup + same-key replay without new rows + 409 conflict + deleted-resource replay 404, owner/PUBLIC/foreign export matrix with `IMPORTED_AS_PRIVATE`. Regression: `quizzes.spec.ts` PASS; API lint/typecheck PASS; API Jest 16 suites/122 tests PASS; Prettier/ESLint on the new spec PASS.

## TASK-064B — 2026-11-08T09:26:19+07:00

- Files: `apps/api/src/common/request-context.middleware.ts`, `apps/api/src/common/request-context.middleware.spec.ts`; task checklist (new corrective task inserted before TASK-065, TASK-065 now depends on it)/log.
- Root cause (found by the TASK-065 integration run): the aggregate multipart byte counter attached a `data` listener, switching the request into flowing mode; chunks emitted while async JWT guard + rate limiter ran were lost, so multer saw no file part. The middleware now calls `request.pause()` right after attaching the counter; the route parser's `pipe()` resumes the stream and both consumers observe every chunk. Limits, allowlist, 413/415/400 envelopes unchanged; middleware functions documented.
- Verification PASS: new spec 3 tests (multipart read after a 50 ms async delay receives all 131072 bytes; chunked overflow → server finished 413 `PAYLOAD_TOO_LARGE`; non-allowlisted multipart 415; missing boundary 400). Regression check: with `request.pause()` removed the first test fails (Expected/Received byte count). API lint/typecheck PASS; full API Jest 16 suites/122 tests PASS; Prettier check PASS.

## TASK-066 — 2026-11-08T09:32:37+07:00

- Files: `apps/api/src/modules/media/media-processor.ts`, `apps/api/src/modules/media/media-processor.spec.ts`; task checklist/log.
- Classification: explicit signature table for exactly the eight PRD MIME types (JPEG/PNG/WebP, MP3 ID3 or Layer III frame sync, Ogg, WAV, ISO-BMFF with allowlisted MP4 brands, EBML with `webm` doctype); executables, scripts, SVG/XML, GIF, archives and QuickTime yield no match. Declared MIME (normalized aliases) must equal the sniffed type (415 when not allowlisted, 422 on mismatch); folder compatibility and per-type byte caps (413) checked; `uploadByteCap()` gives the pre-buffer parser cap per folder and `sizeLimitsFromSettings()` converts settings MiB.
- Images: Sharp metadata (animated pages, format match, APNG `acTL` detection) then decode with 40 MP pixel limit, 10 s timeout, auto-orient, `fit: inside` 1920 px without enlargement, WebP q82; metadata stripped (no `withMetadata`). Audio/video: private temp file (0600) probed by `execFile` without shell, fixed args `-protocol_whitelist file -f <forced demuxer> … file:<path>`, 5 s SIGKILL timeout, 1 MiB stdout cap, minimal env; requires audio streams (cover-art pictures ignored) or a real video stream and finite duration ≤ 86 400 s; bytes passed through unchanged. Missing ffprobe → 503 `DEPENDENCY_UNAVAILABLE`.
- Deviation note: `file-type` 22 is ESM-only and cannot be loaded by the CommonJS API Jest runtime (`Must use import to load ES Module` / dynamic import needs `--experimental-vm-modules`), so the dependency is not used by this module; the auditable signature table plus decoder corroboration replaces it. The declared dependency remains for a later dependency review.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/media/media-processor.spec.ts` 11 tests with ffmpeg/Sharp-generated fixtures (all eight formats; hostile signatures; exact byte cap vs cap−1 → 413; 2400×1200 → 1920×960 WebP; 320×200 not enlarged; EXIF tag stripped; 8000×5000 accepted, 8000×5001 rejected; animated WebP/APNG/truncated/disguised rejected; MP3/Ogg/WAV/MP4/WebM durations and dimensions; Xing-patched 56M-second MP3 rejected; fake ffprobe records hardened argv; hanging probe killed after 200 ms; missing binary 503; playlist and ID3-disguised playlist never contact a local HTTP server). API lint/typecheck PASS. Requires ffmpeg/ffprobe on PATH (ffprobe 9.0.2 locally).

## TASK-067 — 2026-11-08T09:40:48+07:00

- Files: `apps/api/src/modules/media/media.service.ts`, `media-reference.service.ts`, `media.service.spec.ts`; task checklist/log. Prerequisite corrective TASK-067A (repository) landed first.
- `MediaService.upload`: metadata (folder/accessibility) validated, bytes processed by TASK-066 with current settings caps (413/415/422 before any state), then `IdempotencyService.reserve` inserts the receipt and an UPLOADING row (immutable `folder/<uuid>.<ext>` key, active origin ID, public URL from the same base as the adapters) in one transaction. Under `withLease` the processed blob is stored at the reserved key and verified via `readHead` (key/public URL/size); `complete` marks READY and records 201 in one transaction. Storage failure → best-effort origin delete, FAILED row + 503 receipt (kept for the janitor if compensation fails). Same key: READY replay 201 (owner only), live lease 409 `OPERATION_PENDING`, expired reservation reconciled to FAILED/503 (blob stays tracked). No DB transaction spans processing or storage I/O. Safe original names (basename, NFC, no control/format chars, ≤255).
- Library/metadata: `list` (owner READY page with truthful `inUse`/`canDelete`), `read`, `updateAccessibility` (owner lookup → 404 for foreign/admin, If-Match revision → 409, READY only). `MediaReferenceService` documents the shared attach/delete lock protocol, computes reference state and DTOs, and resolves library access strictly by uploader (retained PUBLIC-quiz references grant no library access).
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/media/media.service.spec.ts` 4 tests (READY upload + blob on disk + same-key replay + 409 conflict + owner-only listing + 415/422 before state; adapter upload failure → delete called, FAILED, 503 receipt and replay; `readHead` size mismatch removes the blob; failed compensation keeps FAILED; crash after put: blob stored, live lease 409, after lease expiry same key → 503 with FAILED row still tracking the blob, new key 201; accessibility stale revision 409, other/admin 404, invalid body 422, success revision+1; duplicated PUBLIC quiz gives no library access and owner sees inUse/canDelete). API lint/typecheck PASS; API Jest 18 suites/137 tests PASS.

## TASK-067A — 2026-11-08T09:37:02+07:00

- Files: `packages/database/src/repositories/media.repository.ts`, `tests/contracts/media.repository.spec.ts`; task checklist (corrective task inserted before TASK-067, which now depends on it)/log.
- `reserve`/`finishUpload`/`failUpload` accept the caller's active transaction manager of the same database (inactive or foreign managers → `INVALID_REFERENCE`), so an upload reservation and its operation receipt commit or roll back together. Added `find`, `referenced(ids)` (quiz cover, question, room pin), owner-scoped READY `listOwned` (newest first, `image|audio|video` type prefix, literal `!`-escaped name search, `inUse` EXISTS filter, paging meta, per-row `in_use`), owner/revision/READY-checked `updateAccessibility`, bounded `failStaleUploads(before)` and `staleDeletions(before)`. Existing locks/transitions unchanged; module and every exported member documented.
- Verification PASS: database lint/typecheck/build; `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/media.repository.spec.ts` 6 tests (existing attach/delete race + new composition suite) on SQLite/PostgreSQL/MySQL: rolled-back composed reserve leaves no row, non-transactional manager rejected, composed reserve→READY, literal `%`/`_` search, type filter, page 2 meta, inUse true/false after quiz cover attach, referenced set, stale revision 409-path / wrong owner / UPLOADING denial, accessibility persisted with revision+1, stale upload → FAILED only before cutoff, `failUpload` idempotent on READY, crashed DELETING listed only after its timestamp. API typecheck still PASS.

## TASK-068 — 2026-11-08T09:44:20+07:00

- Files: `apps/api/src/modules/media/media-gc.service.ts`, `apps/api/src/modules/media/media-gc.service.spec.ts`; task checklist/log.
- `deleteOwned`: owner lookup (404 otherwise) → row-locked `claimDelete` (in use incl. foreign duplicated quizzes and room pins → 409 `MEDIA_IN_USE`; UPLOADING/DELETING/concurrent change → 409 `RESOURCE_BUSY`) → delete via the asset's **origin** adapter → remove row; origin failure restores READY/FAILED and returns 503 `STORAGE_UNAVAILABLE` (never half-deleted). Unconfigured origin → `STORAGE_UNAVAILABLE`, adapter error → `DELETE_FAILED`.
- `cleanup(actor, key)`: `cleanup` operation receipt reserved only when no other live PENDING cleanup lease exists (checked inside the serialized receipt transaction → 409 `RESOURCE_BUSY`), claim ≤100 oldest unreferenced READY/FAILED rows in one transaction, settle each outside it under the lease; returns validated `CleanupResult` (scanned, deleted, confirmed `freedBytes`, skippedInUse, failures, `hasMore`, `checkedAt`); every attempted delete failing → 503 receipt + 503. Completed key → 409 `IDEMPOTENCY_CONFLICT` (reconcile via `/operations`), expired run → 503 receipt with DELETING rows left to the janitor.
- `sweep(now)`: UPLOADING older than 1 h → FAILED (later removed by cleanup); DELETING untouched for 10 min (`STALE_DELETING_MS`) re-deleted idempotently and removed, staying DELETING while the origin fails.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/media/media-gc.service.spec.ts` 5 tests (free delete removes row+blob; cover, duplicated-PUBLIC and room-pin references preserved; foreign owner 404; origin failure restores READY then succeeds; UPLOADING busy; partial batch 200 with `DELETE_FAILED` entry and freedBytes of confirmed deletions only; completed-key 409; total failure 503 with restore; retired origin 503; 101 rows → 100 + `hasMore` then 1; singleton busy vs expired lease; janitor stale/fresh uploads and crashed deletion retry). API lint/typecheck PASS; API Jest 19 suites/142 tests PASS.

## TASK-069 — 2026-11-08T09:48:37+07:00

- Files: `apps/api/src/modules/media/media.controller.ts`, `apps/api/src/modules/media/media.module.ts`, `apps/api/src/app.module.ts`, `tests/integration/media.spec.ts`; task checklist/log.
- Routes: `POST /media/upload` (UPLOAD tier + per-user concurrency lease of 2, in-memory multer per request with `fileSize` = current largest settings cap so originals are limited before buffering, 1 file + `folder` + optional `accessibility` JSON, Idempotency-Key, 201 + ETag), `GET /media` (READ, owner READY page), `PATCH /media/:id` (WRITE, quoted If-Match, ETag), `DELETE /media/:id` (WRITE, 409 in use/busy, 503 origin). Audit `media.upload`/`media.delete` with v4 resource IDs only (no URLs/credentials). Responses contain only READY media with truthful `inUse`/`canDelete`; metadata stays `private, no-store`, files immutable via `/uploads`.
- `MediaModule` provides reference/service/GC services plus `MediaJanitor` (sweep on bootstrap and every 5 min, unref'd, non-overlapping, awaited on shutdown) and exports `MediaService`, `MediaGcService`, `MediaReferenceService` for the system module; registered in `AppModule`.
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/media.spec.ts` 2 tests — local origin (401 unauthenticated, 201 WebP READY + immutable public file, same-key replay, 415 SVG, 422 signature mismatch/executable/folder, 422 path-like folder, 413 per-type cap and 413 pre-buffer parser cap after lowering settings, owner-only library, foreign PATCH/DELETE 404, missing If-Match 422, PATCH 200 ETag "3", stale 409, attach-vs-delete race with exactly one winner and truthful inUse/canDelete, delete 200 then 404) and MinIO origin (2400×1200 → 1920×960 WebP stored, HeadObject size matches, delete removes the object). API lint/typecheck/build PASS; API Jest 19 suites/142 tests PASS; integration regression quizzes/quiz-transfer/users PASS.
- Pre-existing failure found (not caused by this task; no guard/main/storage changes since session start): `tests/integration/storage-serving.spec.ts` expects `POST /uploads/...` without Origin → 405, but the global Origin guard from TASK-052 answers 403 first. Tracked as corrective TASK-069A.

## TASK-069A — 2026-11-08T09:49:30+07:00

- Files: `tests/integration/storage-serving.spec.ts`; task checklist (corrective task inserted after TASK-069)/log.
- The TASK-045 assertion `POST /uploads/...` → 405 predates the TASK-052 global Origin guard, which rejects unattributed unsafe methods with 403 before any route. The test now asserts both layers: no Origin/X-Kabuki-Client → 403 `ORIGIN_DENIED`; allowed web origin + `web-v1` client → 405 with `Allow: GET, HEAD`. No production code changed. Also replaced a pre-existing non-null assertion (ESLint `no-non-null-assertion`) with an explicit runtime check and added a file header comment.
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/storage-serving.spec.ts` 1 test; ESLint and Prettier on the spec PASS.

## TASK-070 — 2026-11-08T09:54:57+07:00

- Files: `scripts/locales-validate.ts`, `scripts/lib/locale-packages.ts`, `tests/contracts/locale-packages.spec.ts`; task checklist/log.
- Library: discovers built-in (`packages/shared/locales/<tag>/`) and external (`extensions/locales/<tag>/`) packages; rejects symlinked packages/files, unsafe directory names, unexpected files (never read or evaluated), files over 256 KiB and packages over 2 MiB. A strict position-aware JSON reader (null-prototype objects, depth 32) rejects duplicate keys with 1-based line/column. Manifest: `catalogVersion` mismatch → `INCOMPATIBLE_VERSION`, shared `localeManifestSchema` (pseudo locales only with `--allow-pseudo`), tag must equal directory, duplicates across built-in/external → `DUPLICATE_LOCALE` (no implicit override). Messages: contract key check (`UNKNOWN_KEY`), value rules (markup → `FORBIDDEN_MARKUP`, length → `PACKAGE_TOO_LARGE`), ICU parse with required `other` (`INVALID_ICU`), AST nesting ≤5 / nodes ≤200, rich-text tags rejected, exact placeholder names and kinds (`PLACEHOLDER_MISMATCH`). Missing required keys: built-in → error, external → warning (en fallback). Coverage per package; compiled ASTs retained for the bundle builder; a full run requires the built-in `en` package.
- CLI: `--locale`, `--namespaces` (targeted verification), `--json`, `--builtin-root`, `--external-root`, `--contracts`, `--allow-pseudo`; roots canonicalized with `realpath`; exit 1 on errors, 2 on usage failure. Diagnostics follow the SA schema (file/namespace/key/severity/code/line/column/message).
- Note: `@formatjs/icu-messageformat-parser` 3.x is ESM-only, so the contract test drives the CLI through `tsx` as a child process (the operator path) instead of importing it into the CommonJS Jest runtime. `pnpm locales:validate` on the current repo correctly fails (`en` built-in not created until TASK-088).
- Verification PASS: `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/locale-packages.spec.ts` 4 tests (complete built-ins, partial RTL `ar` coverage 0.75 with MISSING_KEY warning, targeted `--locale/--namespaces`, exact positions for placeholder/ICU/markup/unknown/duplicate keys, `evil.js` reported and never executed, incompatible/duplicate/symlink/deep/oversize/malformed/mismatched packages, built-in missing key error, `en` required, bad namespace exit 2). ESLint/Prettier PASS; ad-hoc strict `tsc --noEmit` over the scripts PASS.

## TASK-071 — 2026-11-08T10:02:16+07:00

- Files: `scripts/locales-build.ts`, `scripts/locales-template.ts`, `tests/contracts/locale-build.spec.ts`, `docs/localization.md`; task checklist/log.
- Build: runs the TASK-070 validator first (any error aborts before writing), compiles each package's twelve namespaces to canonical sorted-key JSON of ICU ASTs (empty object for namespaces a partial package lacks), content-hashes every namespace, derives a deterministic `buildId` from manifests/coverage/hashes, validates the registry with `localeRegistrySchema` (en coverage 1), stages `<out>/<buildId>/` in a temp sibling then renames it, writes `template-v1.zip` and replaces `registry.json` by write+rename; keeps current and previous builds for rollback and prunes older ones. Flags: `--out`, `--builtin-root`, `--external-root`, `--contracts`, `--allow-pseudo`.
- Template: `--locale <tag> --out <dir>` scaffolds manifest (canonical tag, Intl native name, script direction, 0.1.0) plus the twelve en sources; `--out` must be a new directory inside the cwd with no symlinked parents (no overwrite/escape). `--zip <file>` writes the reproducible translator ZIP (`und` placeholder manifest, en sources, message contracts, README; fixed mtime).
- Guide `docs/localization.md`: layout, rules, add-language workflow (template → translate → validate targeted → build → rebuild/restart both containers), build artifacts, rollback, removal and fallback, unsupported runtime upload, diagnostic codes.
- `pnpm locales:build` on the current repo correctly aborts without writing (built-in `en` arrives in TASK-088; the full six-catalog build is gated by TASK-112).
- Verification PASS: `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/locale-build.spec.ts` 4 tests (schema-valid registry, URL/sha256 per asset, compiled AST content, empty namespace for partial RTL package, identical buildId/registry across two outputs; invalid external package exits 1 with PLACEHOLDER_MISMATCH and leaves registry/build dirs untouched; new build retained with previous, third build prunes the oldest, no staging leftovers; ZIP entries/manifest/en sources/README and byte-identical standalone ZIP; scaffold de/ar, refusal to overwrite or escape, scaffolded package validates at coverage 1). Locale validator contracts still PASS (8 total). ESLint/Prettier PASS; strict ad-hoc tsc over all locale scripts PASS.

## TASK-072 — 2026-11-08T10:05:10+07:00

- Files: `apps/api/src/modules/system/system.service.ts`, `health.service.ts`, `health.service.spec.ts`; task checklist/log.
- `HealthService`: DB (`SELECT 1`), active storage adapter `checkHealth()` and state (memory up / Redis PING) probed through `limitConcurrency(…, 3)` with a 2 s timeout each; rejection → `down`, timeout → `unknown`, both with safe codes (`DEPENDENCY_UNAVAILABLE`/`STORAGE_UNAVAILABLE`/`STATE_UNAVAILABLE`); per-part and overall `checkedAt` are the actual probe times; validated `Health` contains only enums/codes/drivers. Snapshot cached 5 s with a shared in-flight promise; `invalidate()`; tunables via optional `HEALTH_OPTIONS`.
- `SystemService`: SUPERADMIN check from the current DB user; `read` returns settings + metrics; `update` strict `settingsPatchSchema` (driver/unknown fields → 422), installed `defaultLocale` via the `InstalledLocales` abstraction (implemented by TASK-073's registry) → 422 `INVALID_LOCALE`, revision 409 with expected/current params, reports `registrationChanged` for audit and invalidates the public cache. `publicSettings()` cached ≤5 s (non-security display only; auth/policy keep reading SQL). Metrics 30 s fresh → stale (last values + timestamp) → unavailable, never blocking settings. Cross-instance invalidation relies on the 5 s TTL (no settings pub/sub channel exists yet).
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/system/health.service.spec.ts` 6 tests (ok snapshot with real timestamps, shared in-flight + 5 s cache + refresh after 5.001 s + invalidate; DB/storage down vs hanging Redis PING unknown within the timeout and no secret/URL/host leakage; adapter-reported unknown; parallelism peak 3; creator 403, driver field/empty patch 422, uninstalled locale 422, revision 409 with params, registration change flag; public cache stale for 5 s then refreshed and invalidated by PATCH; metrics fresh/cached/stale/unavailable with settings still returned). API lint/typecheck PASS; API Jest 20 suites/148 tests PASS.

## TASK-073 — 2026-11-08T10:08:21+07:00

- Files: `apps/api/src/modules/system/locale-registry.service.ts`, `audio-catalog.service.ts`, `registries.spec.ts`; task checklist/log.
- `LocaleRegistryService` (implements TASK-072 `InstalledLocales`): loads `LOCALE_BUNDLE_PATH/registry.json`, rejects incompatible `catalogVersion`, validates with `localeRegistrySchema` (complete `en`, URLs under its buildId) and verifies each namespace file exists as a regular file with the declared SHA-256. Invalid bundle → startup error; missing bundle → startup error in production, 503 `DEPENDENCY_UNAVAILABLE` from `current()` otherwise. `isInstalled`, `effectiveDefault` (configured default if installed, else `en`) and strong ETag (`"<buildId>"`). Locales are data: a seventh external locale registers without enum edits.
- `readAbout()`: version read from the API package manifest (fails rather than inventing one), fixed license/legal/language-guide URLs validated by `aboutSchema`.
- `AudioCatalogService`: loads the generated manifest from `AUDIO_MANIFEST_PATH` with the strict shared schema (legacy `phases` manifest rejected), rejects reused sources, traversal/external URLs (schema), and any referenced file that is missing, empty or a symlink under the manifest root; `lobbyTracks()` returns descriptors in manifest order for public-config, `isLobbyTrack()` for selection; same missing-file policy as the locale bundle. Final packaging/hash verification of the real converted files remains TASK-114/174.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/system/registries.spec.ts` 7 tests (7-locale bundle incl. external `de`, ETag, default fallback; tampered hash, catalogVersion 2, missing/symlinked namespace file, no `en` rejected; missing bundle dev 503 vs production startup failure; manifest derived from the actual 20 source cues → 4 lobby descriptors with known labels/volumes and nekoPop throttle; legacy manifest, missing cue, duplicate lobby, traversal, external URL, empty lobby, missing pair file and symlinked output rejected; missing manifest dev unavailable vs production failure; About version equals `apps/api/package.json`, missing version rejected). API lint/typecheck PASS; API Jest 21 suites/155 tests PASS.

## TASK-074 — 2026-11-08T10:12:51+07:00

- Files: `apps/api/src/modules/system/system.controller.ts`, `system.module.ts`, `apps/api/src/app.module.ts`, `tests/integration/system.spec.ts`; task checklist/log.
- Routes (7): `GET /system/health` (PUBLIC per-IP tier, 200 ok / 503 degraded with the same redacted body, strict empty query), `GET /system/settings` + `PATCH /system/settings` (JwtGuard per route, current SUPERADMIN, ADMIN tier, global Origin guard, quoted If-Match, ETag, audit `settings.update` + `registration.policy.change`), `POST /system/storage/cleanup-orphans` (CLEANUP tier 1/min + concurrency lease, `{}` body, Idempotency-Key, 200 CleanupResult, audit `cleanup`), `GET /system/public-config` (display settings, effective default locale, generated lobby tracks), `GET /system/locales` (`no-cache`, ETag buildId, 304 on If-None-Match), `GET /system/about`.
- `SystemModule` wires locale registry (bound to `InstalledLocales`), audio catalogue, health and settings services, imports `MediaModule` (GC/janitor) and `StateModule` (state probe); exports for later modules; registered in `AppModule`. Settings return even if metrics are unavailable; no driver editing via PATCH (strict schema).
- Note: the global middleware's PUBLIC-tier path list (`origin.guard.ts`) still names pre-SA paths (`/api/v1/health`, `/locales`, `/system/public`); the system controller charges the PUBLIC tier itself, so behaviour is correct without touching that file.
- Fix during verification: first run failed at startup (`HealthService` could not resolve `StateConnections`) → `StateModule` imported into `SystemModule`.
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/system.spec.ts` 3 tests (redacted health without secrets/paths and 422 for query; public-config defaultLocale fallback `en` and 4 lobby tracks; locales no-cache/ETag/304; About version; settings 401/403/ORIGIN_DENIED/missing If-Match 422/driver field 422/uninstalled locale 422/200 + ETag/stale 409/public-config reflects PATCH; cleanup creator 403, partial 200 with `DELETE_FAILED` for a read-only folder and freedBytes of the confirmed deletion only, fresh metrics, 429 on second run). Full integration suite 6 suites/14 tests PASS; API lint/typecheck/build PASS; API Jest 21 suites/155 tests PASS. Stale metrics are covered by the TASK-072 unit test (not reproducible over HTTP without a DB fault).

## TASK-075 — 2026-11-08T10:16:46+07:00

- Files: `apps/api/src/modules/game-engine/score-calculator.ts`, `ranking.ts`, `scoring.spec.ts`; task checklist/log.
- `evaluateAnswer`: SINGLE/TRUE_FALSE via public→private option mapping; MULTIPLE_SELECT C/K with any wrong option → INCORRECT; TYPE_ANSWER through shared `matchesTextAnswer` (NFC/trim/lowercase exact, one code-point edit only for keys ≥ 6); ORDER_PUZZLE all-or-nothing by mapping each public index to its private `sortOrder`; POLL never scored.
- `speedPoints`/`streakBonus`/`scoreAnswer`: server response time, < 500 ms full `1000×m`, otherwise rounded half-curve; base rounded, then `round(base×C/K)`, then bonus `min(500, 100×(streak−1))`; POLL keeps the streak (answered or not), m = 0 / wrong / unanswered reset it, NOT_ELIGIBLE keeps it.
- `computeQuestionResult`: pure/deterministic reveal (type-specific keys, option counts, correct/partial/incorrect/unanswered over eligible players, explanation), personal results for non-kicked players (total score, rank, player ahead, isNoPoints), totals for every player (kicked keep history, rank null) and the leaderboard.
- `ranking.ts`: total order score → correctCount → average response via integer cross-products (none last) → joinOrder; sequential ranks excluding kicked; top-5 with rank change, biggest positive climber (ties by rank then join order, none on first ranking); podium ≤ 3 real players.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/scoring.spec.ts` 8 tests (t=499→1000, t=500→988, 950/750/500, ×2, negative clamp; partial 375+100=475, wrong multi reset, bonus cap 500; POLL/multiplier-0/wrong/unanswered/not-eligible streaks, out-of-range index; Unicode/fuzzy text; shuffled puzzle mapping and duplicates; tie-breaks incl. equal averages and missing response last; top 5, climber, empty/1/2 winners, kicked excluded; full question result with reveal counts/personal/totals/ranks and determinism). API lint/typecheck PASS.

## TASK-076 — 2026-11-08T10:20:29+07:00

- Files: `apps/api/src/modules/game-engine/room-projector.ts`, `room-projector.spec.ts`, `apps/api/src/providers/state/state.module.ts`; task checklist/log.
- `projectHost`/`projectPlayer`/`projectRoom`: explicit allowlist constructors validated by `hostRoomSyncSchema`/`playerRoomSyncSchema`. Players list excludes kicked players; question null in LOBBY/COUNTDOWN/final phases, PREVIEW `options=[]`/`media=null`, ANSWERING/REVEAL/LEADERBOARD public options (TYPE_ANSWER always `[]`) and media snapshot; reveal only in ANSWER_REVEAL/LEADERBOARD; latest committed leaderboard after the first question; podium (≤3 real players) and endReason only in PODIUM/FINISHED. Host adds bgmTrack, required-set answered/eligible counts, finalization (host-only, reportId only when ready via schema) and phase capabilities. Player `self` carries stored (last finalized) score/streak/rank, own accepted answer only while the question is open/revealed, own personal result from reveal on. Binding checks: wrong host → FORBIDDEN, unknown → INVALID_SESSION_TOKEN, kicked → PLAYER_KICKED, stale generation → SESSION_REPLACED.
- `state.module.ts`: `StateProjection` is now created by a factory that registers `projectRoom` (pure function import, no circular Nest module), so memory and Redis stores project through it.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/room-projector.spec.ts` 17 tests — all 8 phases × PROJECTOR/STREAMER × host/player recursively scanned for private keys (sortOrder, publicToPrivateOptionIds, tokenHash, nicknameKey, connectionId, tickets, commands, frozenReport, hostId, answers, mediaId, optionText), option-level isCorrect (only the player's own PersonalResult may carry it), private option IDs, ticket/socket/connection markers, other players' submissions; explanation and accepted text only from reveal; both display modes identical content; puzzle exposes only public IDs/order; reconnect generation and kicked/unknown bindings rejected. API lint/typecheck/build PASS; API Jest 23 suites/180 tests PASS.

## TASK-077 — 2026-11-08T10:23:01+07:00

- Files: `apps/api/src/modules/game-engine/room-capacity.ts`, `room-capacity.spec.ts`; task checklist/log.
- `planCapacity(quiz, configured)`: `baseBytes` = serialized FrozenReport skeleton with every private question snapshot counted twice and widest session values; `perPlayerBytes` = 2048 + Σ(1024 + worst answer: text 48002, multiple/puzzle 32, single/TF/POLL 2); `maxPublicQuestionBytes` = largest answering-phase public projection. Effective maxPlayers = min(configured, 5000, ⌊(64 MiB − base)/perPlayer⌋, ⌊(4 MiB − maxPublicQuestion)/1024⌋); 422 `PAYLOAD_TOO_LARGE` when a public question exceeds 512 KiB, 422 `CAPACITY_TOO_SMALL` when the result is < 1. `hasSeat` counts retained kicked players. Errors raised before any room becomes ACTIVE.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/room-capacity.spec.ts` 5 tests (bounds incl. 8000 escaped controls = 48002 bytes; short quiz configured 1 → 1 and 5000 → roster-limited with both budgets respected, worst-case report and 15-family-emoji roster within reservation; 200-question mixed worst-case quiz: fully serialized worst report ≤ base + N×perPlayer ≤ 64 MiB and every public question ≤ reserved max; >512 KiB public question and configured 0 rejected; kicked seats counted). API typecheck PASS.
- Correction: the first TASK-077 commit (`43cfda7`) was pushed while `pnpm --filter @kabuki-neko/api lint` reported an unused `emptyAccessibility` import in the spec (the verification chain did not stop on the lint failure). Follow-up commit removes the import; re-run: API lint PASS, typecheck PASS, room-capacity spec 5/5 PASS.

## TASK-078 — 2026-11-08T10:28:52+07:00

- Files: `apps/api/src/modules/game-engine/room-registry.service.ts`, `room-registry.service.spec.ts`; task checklist/log. Prerequisite corrective TASK-078A (repository lookups) landed first.
- `createRoom(principal, request)`: current host from DB; one `RuntimeRepository.reserve` transaction authorizes own/PUBLIC quiz at the exact revision, builds the playable private snapshot (`createQuizSnapshot`, host mode, retained refs) under the same locks, plans capacity with current `max_players_per_room` (TASK-077), pins READY media, allocates a PIN (≤32 attempts) under `MAX_ACTIVE_ROOMS`, writes the `room.create` receipt and stores the creation snapshot. Then the state store creates the room if absent (deterministic `initialRoomState` from the allocation, TTL hard end + 24 h horizon) and SQL activates it; the ACK is returned only after activation. Errors: 404/409 revision/409 key conflict/422 QUIZ_NOT_PLAYABLE/503 PIN_EXHAUSTED/503 CAPACITY_REACHED; a lost allocation removes the created state and answers 409 ROOM_LOST.
- `reconcileCreating(now)`: CREATING allocations older than 120 s are activated when their state exists, otherwise released (PIN, media pins and pending receipt freed).
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/room-registry.service.spec.ts` 4 tests (two concurrent instances + retry → one ACTIVE allocation and LOBBY room, payload change 409; private foreign 404, stale revision 409, draft 422, PUBLIC reuse hosted by guest, no allocations after failures; 31 collisions then success on the 32nd attempt, then PIN_EXHAUSTED, active-room cap 503; crash before state → retry same room, crash before activation → retry same session, stale with state activated and without state released only after 120 s, allocation lost before activation → state removed and no dead ACK). API lint/typecheck PASS; API Jest 25 suites/189 tests PASS.

## TASK-078A — 2026-11-08T10:25:34+07:00

- Files: `packages/database/src/repositories/runtime.repository.ts`, `tests/contracts/runtime.repository.spec.ts`; task checklist (corrective task inserted before TASK-078, which now depends on it)/log.
- Added `find(sessionId)` and bounded `staleCreating(before, limit≤100)` (CREATING rows with `created_at < before`, oldest first, parameterized); exported the `Allocation` row type; documented the module. Existing reserve/activate/release behaviour unchanged. Also replaced a pre-existing non-null assertion in the contract test with an explicit check (ESLint `no-non-null-assertion`).
- Verification PASS: database lint/typecheck/build; `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/runtime.repository.spec.ts` 3 tests on SQLite/PostgreSQL/MySQL (find existing/unknown, stale boundary exclusive at created_at, creation snapshot round-trip, activated rows no longer stale); ESLint on the spec PASS.

## TASK-079A — 2026-11-08T10:30:15+07:00

- Files: `packages/database/src/repositories/runtime.repository.ts`, `tests/contracts/runtime.repository.spec.ts`; task checklist (corrective task inserted before TASK-079, which now depends on it)/log.
- Added `findByPin(pin)` (schema-validated PIN, null for malformed/unknown; PIN uniqueness enforced by SQL) and keyset-paged `active(afterId, limit≤500)` returning ACTIVE/FINALIZING allocations in id order for the scheduler scan. Parameterized queries; existing behaviour unchanged.
- Verification PASS: database lint/typecheck/build; ESLint on the spec; `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/runtime.repository.spec.ts` 3 tests on SQLite/PostgreSQL/MySQL (PIN hit/miss/malformed, active listing and keyset continuation, LOST excluded).

## TASK-079 — 2026-11-08T10:33:46+07:00

- Files: `apps/api/src/modules/game-engine/recovery.service.ts`, `friendly-names.ts`, `recovery.service.spec.ts`; task checklist/log. Prerequisite corrective TASK-079A (PIN lookup) landed first.
- `RecoveryService`: live PIN → SQL allocation (ACTIVE) → state by sessionId (reused PIN never confused). `checkPin` LOBBY/unlocked/free seats → OPEN. `requestFriendlyName`: friendly rooms only, safe adjective+animal candidate unique by normalized key, 32-byte base64url ticket stored as SHA-256 in the state store (socket-bound, 120 s, re-roll replaces the socket's ticket), at most 10 outstanding per IP and room (429 with retry hint). `join`: new joins validate nickname (shared schema → 422 INVALID, normalized substring match against the current profanity list → 422 FORBIDDEN) and one of six avatar styles, issue a 32-byte session token stored only as a hash, rely on the store's atomic uniqueness/ticket/receipt checks (lost ACK with same requestId → same slot/token, changed payload 409); recovery needs sessionId + token, rejects changed nickname/avatar (422), cross-room/unknown tokens (401) and kicked players (403), and returns the new connection generation for socket binding. `stateError` maps state-store domain codes to the socket envelope statuses (shared by later engine services).
- `friendly-names.ts`: reviewed family-safe lists (27×27), every combination ≤ 14 characters, crypto random draw.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/recovery.service.spec.ts` 6 tests (unknown/malformed/locked PIN; lost ACK same slot+token, conflict on changed payload, token never stored in plaintext, concurrent same-name join exactly one winner; profanity from current settings, blank nickname, invalid avatar; friendly typed-name bypass, foreign-socket ticket, consumed ticket and non-friendly room denied; per-IP ticket bound and name length guarantee; recovery bumps generation and stale generation SESSION_REPLACED, changed fields 422, cross-room 401, kicked 403). API lint/typecheck PASS; API Jest 26 suites/195 tests PASS.

## TASK-080 — 2026-11-08T10:38:27+07:00

- Files: `apps/api/src/modules/game-engine/game.service.ts`, `game.service.spec.ts`; task checklist/log.
- `hostCommand`: current host re-authorized every call, payload hash without requestId for store dedup, `expectedPhaseVersion` from the request (lock/kick read the current version and retry on a concurrent change; the store still checks atomically). skip/end during answering complete their pending store command by committing the frozen result; when a natural close already won (`OPERATION_PENDING`) the freeze is committed and the command retried once (observing STALE_PHASE). After every command: settle any frozen question (e.g. kick of the last required player) and freeze the report on PODIUM.
- `submitAnswer`: atomic store admission with the player binding/generation, then `settle` so an all-answered freeze reveals immediately; ACK `{accepted, submissionId, questionIndex, receivedAt}`.
- `settle`: deterministic `computeQuestionResult` from the frozen question, committed with CAS (revision + closed hash) — recomputable by any worker after a crash, never double-scored.
- `tick(identity, now)`: countdown → preview(0) at 3 s, preview → answering at 4 s (required set frozen by the store), timer close strictly after `acceptanceClosesAt` (no vacuous all-answered close with an empty required set), crash recovery of unscored freezes, report freeze in PODIUM and PODIUM → FINISHED at 8 s; transitions use the injectable `GAME_CLOCK` (same clock as the store) with bounded retry on a store-clock mismatch.
- `finalize`/`buildFrozenReport`: once per room in PODIUM/FINISHED, schema-valid immutable report — all questions (PLAYED with close reason/eligible set, UNPLAYED untouched), all players incl. kicked (rank null), one answer row per eligible player per played question; kicked players who answered are re-scored from their previous streak so points match totals. Hook installed via `setReportHook` (typed callback for TASK-084, no DI cycle).
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/game.service.spec.ts` 5 tests, run 3× (exact 3 s/4 s boundaries, skip vs late submit consistent counts with HOST_SKIP or ALL_ANSWERED, double next → one LEADERBOARD + STALE_PHASE, same-request replay ACK; kick last required → ALL_ANSWERED reveal, partial 1/2 → 375 points, kicked absent from personal; no vacuous reveal with empty required set, timer closes only after +1 ms past grace; empty-lobby end → report with 0 players, end during Q0 → Q0 PLAYED/HOST_END and Q1–Q2 UNPLAYED, idempotent second end, PODIUM → FINISHED at exactly 8 s; commit crash then next tick scores once, freeze crash then next tick freezes and calls the hook exactly once). API lint/typecheck PASS; API Jest 27 suites/200 tests PASS.

## TASK-081A — 2026-11-08T10:40:27+07:00

- Files: `packages/database/src/repositories/runtime.repository.ts`, `tests/contracts/runtime.repository.spec.ts`; task checklist (corrective task inserted before TASK-081, which now depends on it)/log.
- Added bounded `retired(before, limit≤100)`: CLOSED/LOST allocations with `last_heartbeat_at < before`, oldest first, parameterized — lets the scheduler retry conditional release (PIN, media pins, READY job) after retention, also after a restart. Existing behaviour unchanged.
- Verification PASS: database lint/typecheck/build; ESLint on the spec; `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/runtime.repository.spec.ts` 3 tests on SQLite/PostgreSQL/MySQL (LOST row invisible before its cutoff, listed after).

## TASK-081 — 2026-11-08T10:43:26+07:00

- Files: `apps/api/src/modules/game-engine/room-scheduler.ts`, `room-scheduler.spec.ts`; task checklist/log. Prerequisite corrective TASK-081A (retired allocations) landed first.
- `RoomScheduler`: 1 s scan (non-overlapping, unref'd) of ACTIVE/FINALIZING allocations (keyset pages) plus CREATING reconciliation; per room a 3000 ms state-store lease (owner = `DEPLOYMENT_INSTANCE_ID`, epoch) renewed every scan, only the holder ticks and arms a local timer for the exact next deadline (`nextDeadline`: phaseEndsAt for countdown/preview/podium, acceptanceClosesAt + 1 ms while accepting); every transition stays a CAS in GameService and host presence is never consulted. SQL heartbeat every 30 s. Lifetime: hard 8 h closes an ANSWERING question with EXPIRED (→ PODIUM EXPIRED with frozen report), other non-final phases and lobby idle 2 h become LOST (no invented report); missing state → LOST. PODIUM/FINISHED with a frozen report → allocation FINALIZING; FINISHED + 1 h (or a hard-expired final room) with a durable `ready` report → state released and allocation CLOSED; non-durable reports are never evicted (store refuses). CLOSED/LOST allocations released conditionally after 1 h on every scan (also after restart); leases given up on shutdown.
- Known limitation (documented): the state stores expose no atomic system "expire to PODIUM" for non-answering phases, so such rooms past the 8 h lifetime are marked LOST rather than given an EXPIRED report.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/game-engine/room-scheduler.spec.ts` 4 tests, run 2× (2999/3000 ms countdown, 4000 ms preview, grace +1 ms close, no pause without host actions, ACTIVE→FINALIZING on podium, 7999/8000 ms podium→finished; two instances: only the lease holder ticks, takeover after 3001 ms without renewal; missing state and idle lobby → LOST and released after 1 h; hard expiry while answering → EXPIRED close/report, retained while not durable, released and CLOSED after durable ready). API lint/typecheck PASS; API Jest 28 suites/204 tests PASS.

## TASK-082A — 2026-11-08T10:47:29+07:00

- Files: `apps/api/src/providers/state/game-state.interface.ts`, `memory-state.store.ts`, `redis-state.store.ts`, `lua/mutate-room.lua`; task checklist (corrective task inserted before TASK-082, which now depends on it)/log.
- `IGameStateStore.updateAvatar(identity, playerId, generation, avatar)`: schema-valid avatar (else INVALID_FORMAT), bound player check (unknown INVALID_SESSION_TOKEN, kicked PLAYER_KICKED, stale generation SESSION_REPLACED), LOBBY only (INVALID_PHASE), refreshes lobby activity and bumps revision/publicRevision; returns the new revision. Memory: inside the store critical section. Redis: new `avatar` op in the same-slot `mutate-room` Lua script (shipped to `dist` by the existing build copy).
- Verification PASS: API lint/typecheck/build (Lua present in dist); API Jest 28 suites/204 tests. Parity: an ad-hoc avatar scenario was appended temporarily to `tests/contracts/state-parity.spec.ts` (not a target file, reverted afterwards) and run with the full state-contract suite against memory and a real Redis container — 20 passed (revision bump, persisted avatar, stale generation, unknown player, invalid style, foreign session).

## TASK-082 — 2026-11-08T11:19:04+07:00

- Files: `apps/api/src/modules/game-engine/game.gateway.ts`, `game-engine.module.ts`, `apps/api/src/app.module.ts`, `tests/integration/game-gateway.spec.ts`; task checklist/log. Prerequisite corrective TASK-082A (atomic avatar updates) landed first.
- Gateway (`/game`, path `/socket.io`, `maxHttpBufferSize` 16 KiB, ping 25 s/20 s): middleware checks the Origin allowlist and the ≤ 8 KiB handshake and authenticates an optional access token (host principal; `auth:update` renews it); anonymous sockets that neither join nor authenticate are disconnected after 120 s. All 16 client events go through one dispatcher: shared request schema, per-event rate tier keyed by IP/user/player/socket (+ CREATE 5/min for room creation), server-side binding (host principal, player binding with connection generation — never the PIN alone), contract-validated success/error ACK envelopes with safe messages. Redis adapter installed on the root server (re-inits the namespace). Join replaces older sockets of the same player (`player:session_replaced` + disconnect; the store rejects stale generations regardless). Disconnect marks presence (generation-checked).
- Pushes: a per-room serialized publisher diffs private state against the last published summary and emits only role-safe data — `room:player_joined/updated/left/presence_changed/lock_changed` to host + players, `player:kicked` (+ forced disconnect), phase events (countdown, preview with options/media hidden, answering, reveal host vs per-player with own result, leaderboard with selfRank, podium host with finalization/reportId vs players with own result, finished), `game:answer_count_updated` and `report:status_changed` host-only, `room:expired` when state disappears, and `room:version` every 5 s. `NotifyingGameService` (provided for `GameService`) publishes after every scheduler tick without coupling the scheduler to the transport.
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/game-gateway.spec.ts` 3 tests with real socket.io clients (bad Origin/protocol/oversized handshake/invalid token rejected; every client event ACK validated against its contract through lock, kick, avatar, time, sync, recover, auth:update, session replacement, full game reveal → leaderboard → typed question → end → podium; 401 without host principal or binding, 403 for a foreign host; recursive scan: players never receive host-only events, finalization/report IDs, token hashes, answer counts or private mappings, explanation/accepted text only after reveal, own podium result only; oversize event closes the transport; TIME tier 429 on the 13th call). Stability: before labelled step timeouts were added, 2 of 4 runs hit Jest's 120 s timeout (root cause not identified); afterwards 10 of 10 consecutive runs passed with no labelled timeout firing. Full HTTP+socket integration suite 7 suites/17 tests PASS; API lint/typecheck/build PASS; API Jest 28 suites/204 tests PASS.

## TASK-083 — 2026-11-08T11:22:00+07:00

- Files: `apps/api/src/modules/reports/report-finalizer.ts`, `apps/api/src/modules/reports/report-finalizer.spec.ts`; task checklist/log.
- `ReportFinalizer.enqueue`: validates the FrozenReport (schema, cross references, 64 MiB cap) and its room identity, upserts the durable `finalization_jobs` row keyed by the stable session ID (same payload idempotent; a different payload is refused with "hash mismatch" and never overwrites), then marks the room state durable and the status pending. On a database failure the frozen report stays in the state store (not releasable) and the status becomes `failed`/retryable/`REPORT_SAVE_FAILED` with `reportId = null`; calling again retries.
- `ReportFinalizer.persist` + `projectReport`: maps the validated FrozenReport onto the history records and writes one claimed job via `ReportsRepository.persist` in a single transaction (deterministic UUIDv5 history IDs, deleted source quiz/question references nulled under locks, job READY); READY with the same payload is idempotent.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/reports/report-finalizer.spec.ts` 8 tests on SQLite with a real game played through the memory store (DB outage → failed/retryable then recovery, durable before state ack, stable UUIDv5 session-question/answer IDs, idempotent READY without duplicates; rollback when inserting game_sessions, session_questions, game_players or player_answers fails and when the job cannot be marked READY, followed by a successful retry; deleted source quiz → NULL quiz/question/answer references with snapshots intact; tampered payload and wrong hash refused without touching history; mismatched room identity 422). API lint/typecheck PASS; API Jest 29 suites/212 tests PASS.

## TASK-084 — 2026-11-08T11:36:44+07:00

- Files: `apps/api/src/modules/reports/report-worker.ts`, `report-worker.spec.ts`, `apps/api/src/modules/game-engine/game.service.ts`, `room-scheduler.ts`; task checklist/log.
- `ReportWorker`: polls every 1 s and fills up to `FINALIZE_CONCURRENCY` (default 2) slots, each claiming one due job via the repository's conditional UPDATE (all dialects, no SKIP LOCKED); a backlog drains immediately after each job. Lease 30 s renewed every 10 s while `ReportFinalizer.persist` writes the history in one transaction; a refused/expired lease returns `LEASE_LOST` without touching the job. Only after commit: state acknowledged durable, `markFinalization(ready, reportId = sessionId)` and the typed `ReportStatusListener` (host `report:status_changed`, wired in TASK-086). Failure: rollback, job FAILED with backoff 1/5/30/120/600 s, room status failed/retryable/`REPORT_SAVE_FAILED`; a payload hash mismatch is logged as an invariant alert (`INTERNAL_ERROR`) and never overwrites. After the five automated retries the job waits for `manualRetry` (owning host only, attempts reset). Lifecycle hooks start/stop the loop; durable jobs left by a previous process are picked up on start, and jobs of rooms whose memory state vanished still finish.
- `sync` (scheduler recovery): idempotent enqueue by session ID (re-creates the job after a DB outage; DB still down keeps failed/retryable and the frozen report pinned), then mirrors the durable job status into the room state (e.g. READY whose state update was lost).
- `GameService.setFinalizationSync` + `syncFinalization(identity)`: typed callback (no DI cycle) invoked for final rooms with a frozen report whose status is neither `ready` nor `lost`. `RoomScheduler.visit`: the room leader calls it at most every `FINALIZATION_SYNC_MS` = 5 s, so failed enqueues are retried and ready rooms get released after retention.
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/reports/report-worker.spec.ts` 8 tests, run 6× (two competing workers → exactly one READY, listener sees ready only once with history already committed; crashed lease not taken over at 29 999 ms, re-claimed after 30 s, the crashed worker's late write refused with LEASE_LOST, idempotent after READY with no duplicate players; lease renewed at +10 s and write succeeds after the original lease expired; restart with an empty memory store still writes and notifies; 1 initial + 5 backoffs at exact boundaries, nothing after 24 h, status failed/no reportId/room not releasable, foreign host cannot reset, manual retry → READY; peak concurrency exactly 2 with a 3-job backlog; scheduler-less sync after DB outage; scheduler syncs once, not again within 5 s, not after ready, releases the room after 1 h retention). Related game.service + room-scheduler specs PASS. API lint/typecheck PASS; Prettier PASS; API Jest 30 suites/220 tests PASS (Docker daemon started in the cloud container for the Redis-backed specs).

## TASK-085A — 2026-11-08T11:39:58+07:00

- Files: `packages/database/src/repositories/reports.repository.ts`, `tests/contracts/reports.repository.spec.ts`; task checklist (corrective task inserted before TASK-085, which now depends on it)/log.
- Reason: TASK-085/086 need the ready-only report list (`GET /reports`) and whole-session reads for analytics and CSV; TASK-040 only exposed per-player answer pages and a paged player list.
- `list(hostId, query)`: `reportsQuerySchema` (page/limit default 15, `quizId?`, `search`, `sort=ended_desc`), only `game_sessions` rows (READY by construction) of an active host, case-insensitive parameterized `LIKE … ESCAPE '!'` on the quiz title snapshot with `!`/`_`/`%` escaped, stable order `ended_at DESC, id DESC`. `allPlayers(hostId, id)`: whole player list sorted in memory by `comparePlayers` (ranked by rank, unranked last, kicked by join order — NULL ordering differs per dialect). `allAnswers(hostId, id)`: all answers ordered by question index then player ID. Both go through the existing `session()` gate (404 foreign/inactive host, FINALIZATION_PENDING / REPORT_SAVE_FAILED). Exported row types `ReportSessionRow`, `ReportPlayerRow`, `ReportQuestionRow`, `ReportAnswerRow`.
- Verification PASS: `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/reports.repository.spec.ts` 3 tests on SQLite/PostgreSQL/MySQL (newest-first ready list without the pending session, meta default limit 15, `100%`/`_` searches escaped, case-insensitive title search, quizId filter, page 2 limit 1, another host's list isolated, invalid sort rejected, inactive host lists nothing; bulk players rank1, rank2, unranked, kicked; bulk answers ordered; pending gate and foreign host 404). Database lint/typecheck/build PASS; ESLint + Prettier on the spec PASS.

## TASK-085 — 2026-11-08T11:48:17+07:00

- Files: `apps/api/src/modules/reports/reports.service.ts`, `report-csv.ts`, `reports.service.spec.ts`; task checklist/log. Prerequisite corrective TASK-085A (ready list + bulk reads) landed first.
- Analytics (`weighted-success-scored-opportunities-v1`): an opportunity is a stored answer row (eligible player, frozen before any kick) on a PLAYED non-POLL question with multiplier > 0; credit CORRECT 1, PARTIAL C/K, else 0; `value = null` when the denominator is 0. Player, question and session accuracy use the same rule. Question reports for every type: eligible/accepted/unanswered (= eligible − accepted), correct/partial/incorrect (0 for POLL), option counts per authoring option for choice/poll questions (zeros when UNPLAYED), authoring question without the public mapping. Hardest: ≤ 5 PLAYED questions with denominator > 0, lowest accuracy by exact cross product, then larger denominator, then index. Answer rows NOT_PLAYED / NOT_ELIGIBLE / ANSWERED / UNANSWERED (POLL normalized to denominator 0, basePoints = awarded − bonus). Every response is validated with the shared report schemas.
- `ReportsService`: `list`, `detail` (players page 1/20), `players`, `answers`, `exportCsv` (everything computed before the first chunk), `status` (history READY → durable job pending/failed → frozen room status → `lost` for a LOST allocation or an audited loss → 404) and `retry` (ready → ready, pending → 409, FAILED job → manual retry, no job + frozen room → worker sync / 503 while storage is down, lost → lost/not retryable). Repository gate errors map to 404 / 409 FINALIZATION_PENDING / 503 REPORT_SAVE_FAILED; only the current active host has access.
- `report-csv.ts`: BOM + exact 18 English columns, CRLF, ISO UTC, dot decimals (accuracy 6, average 3, fractional numerator 6), booleans `true`/`false`, empty unavailable values, every text RFC 4180 quoted with an apostrophe guard for `=`/`+`/`-`/`@` after optional whitespace or a leading TAB/CR/LF, other control characters replaced by U+FFFD, fixed ASCII filename from the session UUID.
- Known drift (outside the target files): `score-calculator.ts` increments `correctCount` for any `isCorrect` outcome including ×0 questions, while SA §4.5 counts only scored questions; reports mirror the stored value. Needs a corrective engine task (scoring.spec + CSV expectation).
- Verification PASS: `pnpm --filter @kabuki-neko/api test --runInBand --runTestsByPath src/modules/reports/reports.service.spec.ts` 6 tests, run 3× (real 5-question game with a kicked player: session 2.5/5, Q0 1/3 with option counts, Q1 partial 1.5/2, POLL and ×0 null, UNPLAYED zeros, players 0.75/0.5/kicked 0 of 1, nickname search; answer statuses incl. pagination and foreign player 404; hardest ties and denominator-0 null; CSV header/BOM/order/escaping, `'=HYPERLINK`, `'@Ann`, `'-Ben`, kicked row with empty rank/average, all injection vectors and control replacement; pending 409 / failed 503 / manual retry / ready, other host and deactivated host 404 everywhere; enqueue outage → status failed, retry 503 then pending, lobby 404, LOST and audited loss → lost). API lint/typecheck/Prettier PASS; API Jest 31 suites/226 tests PASS.

## TASK-086 — 2026-11-08T12:00:24+07:00

- Files: `apps/api/src/modules/reports/reports.controller.ts`, `reports.module.ts`, `apps/api/src/app.module.ts`, `tests/integration/reports.spec.ts`; task checklist/log.
- `ReportsController` (`/api/v1/reports`, JwtGuard, current active host re-read per request): `GET /` (READ, ready-only page, default limit 15, quizId/search), `GET /:id/status` (READ), `POST /:id/retry-finalize` (WRITE, strict `{}` body, Idempotency-Key via `report.retry` receipts: a replayed key never re-executes and returns the current status, another request under the same key 409 IDEMPOTENCY_CONFLICT, missing key 422; HTTP 200), `GET /:id` (full report with 20 players), `GET /:id/players`, `GET /:id/players/:playerId/answers` (READ), `GET /:id/export-csv` (EXPORT, `text/csv; charset=utf-8`, fixed attachment filename, `nosniff`, chunks written with backpressure after the whole report was gated). Non-UUID IDs are 404 like unknown reports; pending 409 / failed 503 are JSON envelopes, never partial CSV.
- `ReportsModule` + `ReportsWiring`: provides finalizer, worker (starts on bootstrap, stops on shutdown) and service; at init installs the engine report hook (`ReportFinalizer.enqueue`), the scheduler finalization sync (`ReportWorker.sync`) and the worker status listener, which re-publishes the room through the notifying game service so the gateway diff emits `report:status_changed` to the host room only — the ready status with reportId = sessionId only after the SQL commit. Callbacks are removed on destroy. `AppModule` imports it last.
- Environment notes: Docker daemon started manually in the cloud container (`dockerd`). In this container `system.spec.ts` (cleanup partial failure simulated with `chmod 0555`, ineffective as root uid 0) and the `media.spec.ts` MinIO case (Testcontainers image build from source fails here) fail independently of this task; both touch no report code.
- Verification PASS: `pnpm test:integration --runInBand --runTestsByPath tests/integration/reports.spec.ts` 2 tests, run 3× (completed game: host gets the ready push with reportId and the report is readable when it arrives, earlier pushes never carry a reportId, players never get the event; list limit 15 + quizId filter, detail 20 players + accuracy, player search, answers page 2/limit 1, foreign player 404, streamed CSV headers/BOM/18 columns/formula guards, status ready, retry ready + key replay + key conflict + missing key 422 + non-empty body 422; SUPERADMIN source owner 404 on all routes and empty list, 401 without token, non-UUID 404. Early end then API restarts editing SQLite in between: pending job → 409 on detail/players/CSV (JSON) and retry, status pending, absent from list; exhausted failed job → 503 JSON for CSV, status failed/retryable; manual retry → pending → ready with a report identical to the original). Full integration suite: reports, game-gateway, quizzes, quiz-transfer, users, storage-serving PASS (17/19 tests; the 2 failures above are environment-specific). API lint/typecheck/build/Prettier PASS; API Jest 31 suites/226 tests PASS.

## TASK-087A — 2026-11-08T12:22:09+07:00

- Files: `apps/web/postcss.config.mjs`; task checklist (corrective task inserted before TASK-087, which now depends on it)/log.
- Reason: the web manifest already pins `tailwindcss` 4.3.3 and `@tailwindcss/postcss`, but no task created a PostCSS configuration, so Next would not expand `@import "tailwindcss"`/`@theme` from TASK-087.
- Registers only `@tailwindcss/postcss` (no autoprefixer; Tailwind 4 handles prefixing/nesting). No dependency or lockfile change.
- Verification PASS: `pnpm --filter @kabuki-neko/web build` (static `/` and `/_not-found`); a scratch PostCSS run with this exact config over `@import "tailwindcss"` + `@theme inline` emitted `.p-4` and a theme-mapped `.bg-primary` utility; Prettier PASS.

## TASK-087 — 2026-11-08T12:26:27+07:00

- Files: `apps/web/src/app/globals.css`, `apps/web/src/lib/preferences.ts`, `apps/web/src/providers/theme-provider.tsx`, `apps/web/src/providers/theme-provider.spec.tsx`; task checklist/log. Prerequisite corrective TASK-087A (PostCSS/Tailwind 4) landed first.
- `globals.css`: `@import "tailwindcss"`; Design §2.1 semantic tokens with Shadcn-compatible names (`--background`, `--foreground`, `--primary(-foreground)`, `--secondary`, `--panel`/`--card`, `--subtle`/`--muted`, `--muted-foreground`, `--border`, `--input`, status text/surface pairs, `--ring`, `--scrim`, brand colors) for light on `:root` and dark on `:root[data-theme="dark"]`, plus a `prefers-color-scheme` fallback before hydration (explicit light wins); the four answer colors/text pairs of Design §2.2 declared once, solid and theme-independent, with the double white/ink focus pair; spacing, elevation (+ dark border), layers, layout/target sizes, motion durations; `@theme static` radius tokens and an `@theme inline` mapping so utilities (`bg-primary`, `bg-answer-d`, `shadow-2`, `text-title`, breakpoints 768/1200/1600) resolve to the variables; base styles with logical properties, 320 px minimum, `overflow-wrap`, 2 px + 2 px focus ring, tabular numbers, responsive container padding 16/24/32, and reduced motion collapsing every animation/transition. Noto Sans falls back to `system-ui` until the font asset task.
- `preferences.ts`: `system | light | dark` external store (`get`/`set`/`subscribe`) on versioned `localStorage` key `kabuki-neko.theme.v1`, every access guarded with an in-memory fallback when storage is denied/missing/full, invalid stored values ignored, cross-tab `storage` events, `resolveTheme`.
- `ThemeProvider`/`useTheme`: preference and OS dark mode via `useSyncExternalStore` (server snapshot = default), `forcedTheme` for the host stage/player game phases without overwriting the saved preference, writes only `data-theme`, `data-theme-preference` and `color-scheme` on <html> — the subtree is never remounted.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/providers/theme-provider.spec.tsx` 8 tests, run 4× (memory fallback with throwing storage, invalid stored value, cross-tab change, system dark change, forced dark/back with child state and a single mount, answer tokens equal `ANSWER_GEOMETRY` and absent from the dark block, green/white 4.50066:1 and yellow/ink 7.43:1 exact while yellow/white fails, primary pairs 4.63/7.71, no translucency, focus and reduced-motion baselines). The spec reads globals.css through `process.getBuiltinModule("node:fs")` because Vitest replaces CSS imports (even `?raw`) with an empty string. Web lint/typecheck/build PASS; built CSS contains the answer tokens, dark/system blocks, reduced motion and `--radius-*`. `pnpm --filter @kabuki-neko/web test` no longer fails with "No test files found" (00 §4.3). Prettier PASS.

## TASK-088 — 2026-11-08T12:28:32+07:00

- Files: `packages/shared/locales/en/manifest.json`, `common.json`, `auth.json`; task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `en`, `nativeName` "English", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors" (no URL).
- `common` (184 messages) and `auth` (52 messages): every contract key, including optional inventory titles, written as natural English sentences/labels — actions, confirmations (specific impact), navigation, pagination (`{page, number}` of `{totalPages, number}`; plural `resultCount` with `=0`/`one`/`other`), status (`lastUpdated` with `date`/`time` plus visible timezone), theme, visibility, language picker, and the L/E/I/P/X state copy for B01–B12, F19, M09, S01, S17, F01 and S02–S04 (Indonesian design notes translated to their user-facing meaning; no inventory IDs, implementation notes or raw keys). Auth failures use safe wording (no account enumeration), ambiguous requests tell the user to check status before retrying. No creator content or identifiers are translated.
- Verification PASS: `pnpm locales:validate --locale en --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: every message formatted with `intl-messageformat` (apostrophes render literally, plural 0/1/7 → "No results"/"1 result"/"7 results"); placeholders match contract names/types (validator). Locale contract tests 8/8 PASS; Prettier PASS. Full six-locale gate waits for the remaining catalog tasks.

## TASK-089 — 2026-11-08T12:30:03+07:00

- Files: `packages/shared/locales/en/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Every contract key including optional inventory titles, as natural English: quiz library/detail/metadata/import/export (plural `questionCount`/`issueCount`, `Row {row, number}, column {column}`, read-only and invalid-draft notices, atomic import failure), studio editor/slides/question/points/reveal/types/unsaved dialog (`Saved at {savedAt, time, short}`, plural `duration`, `{count, number} of {limit, number} characters`, `Slide {position, number} of {total, number}`, conflict "keep draft / reload saved version"), media library/upload/source/player/accessibility (`{percent, number}%`, `{limit, number} MiB`, exclusive upload-or-YouTube rule, missing alt/captions/transcript indicators), and L/E/I/P/X copy for F02–F07, M03–M05, M10, S05–S08. Creator content and identifiers are never translated.
- Verification PASS: `pnpm locales:validate --locale en --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: all 499 en messages so far formatted with `intl-messageformat` using contract-typed sample values — 0 exceptions, every string placeholder rendered, apostrophes literal. Prettier PASS. Full six-locale gate waits for the remaining catalog tasks.

## TASK-090 — 2026-11-08T12:31:36+07:00

- Files: `packages/shared/locales/en/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Every contract key including optional inventory titles, as natural English: host config (PROJECTOR vs STREAMER descriptions, friendly nicknames), lobby (`{count, number} of {capacity, number} players`, join announcement), QR dialog, controls, stage (`{answered, number} of {total, number} answered`, `Question {index, number} of {total, number}`, ordinal podium places via `selectordinal`, plural biggest climber), audio (autoplay blocked → turn on sound, local-only), finalization statuses; player join/scanner (wrong origin never opened, retry-after plural), avatar/nickname rules, answer inputs (immediate send for single choice, poll has no points, `{text}, position {position, number}`, plural seconds left with =0), connection states, results (plural points incl. streak bonus once, ordinal rank, streak count); reports list/detail/answers/table (`{numerator, number} of {denominator, plural, …}` for fractional weighted accuracy, `{milliseconds, number} ms`, end time with visible timezone, "—" for missing metrics, early-end/expired labels). L/E/I/P/X copy for F10, F11–F17, M01, M02, M06–M08, M12, S09, S10, S14–S16.
- Verification PASS: `pnpm locales:validate --locale en --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` and contract-typed values (0 problems); ordinals 1st/2nd/3rd/4th/11th/12th/13th/21st/22nd/23rd and "2.5 of 5 scored answers" checked. Prettier PASS. Full six-locale gate waits for the remaining catalog tasks.

## TASK-091 — 2026-11-08T12:33:16+07:00

- Files: `packages/shared/locales/en/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- admin: health (last checked with date/time), settings (registration modes, per-type upload caps, blocked nickname words, revision conflict), storage cleanup (confirmation, partial/more/failed, plural `cleanupResult` with deleted files, freed bytes and failures), invitations (one-time code shown once, expiry date/time, unknown outcome → check list before creating another), users (roles, status, last-administrator protection), and L/E/I/P/X copy for F08, F09, M11, S11, S12. validation: a safe explanation for each of the 95 domain error codes — no SQL, credentials, stack or hidden-resource details; NOT_FOUND does not reveal existence; `rateLimited` uses `{retryAfterMs, number}`, `revisionConflict` shows `{expectedRevision, number}`/`{currentRevision, number}`. accessibility: control/game/media labels incl. `Option {label}, {shape}: {text}` (creator text untouched), puzzle instructions and the shared-deadline note. about: audio credits, license/document labels (`Version {version}`, translated summary is not authoritative, no invented legal text), language-package guide (`{language}: {percent, number}% translated`) and F20/S13 states.
- Verification PASS: `pnpm locales:validate --locale en --namespaces admin,validation,accessibility,about` → coverage 100.0%, 0 errors, 0 warnings; full `pnpm locales:validate --locale en` (all 12 namespaces, 1102 messages) → 100.0%, 0 errors, 0 warnings. Review: 266 messages formatted with `intl-messageformat` and contract-typed values (0 problems). Locale contract tests 8/8; Prettier PASS. Full six-locale gate waits for the id/ja/zh-Hans/es/fr catalog tasks.

## TASK-092 — 2026-11-08T12:34:38+07:00

- Files: `packages/shared/locales/id/manifest.json`, `common.json` (184), `auth.json` (52); task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `id`, `nativeName` "Bahasa Indonesia", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors".
- Natural Indonesian (formal "Anda", consistent terms: kuis, room, PIN, kreator, instansi, unggah/unduh, kata sandi) for every common/auth key including optional inventory titles; Indonesian has only the CLDR `other` plural, so counts use `=0` + `other` (`{count, plural, =0 {Tidak ada hasil} other {# hasil}}`); dates/times via ICU `date`/`time` with the visible timezone; safe auth wording (no account enumeration). Creator content and identifiers are not translated.
- Verification PASS: `pnpm locales:validate --locale id --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: 236 messages formatted with `intl-messageformat` (locale `id`) and contract-typed values — 0 problems, every string placeholder rendered. Prettier PASS. Full six-locale gate waits for the remaining catalog tasks.

## TASK-093 — 2026-11-08T12:35:45+07:00

- Files: `packages/shared/locales/id/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Natural formal Indonesian for every key incl. optional inventory titles, consistent with TASK-092 terminology (kuis, draf, slide, pertanyaan, opsi, pembahasan, unggah/unduh, pustaka media, caption, transkrip, teks alternatif). Plurals use `other` (+ `=0` where meaningful): `{count, plural, =0 {Belum ada pertanyaan} other {# pertanyaan}}`, `{seconds, plural, other {# detik}}`; placeholders kept (`Baris {row, number}, kolom {column}`, `Slide {position, number} dari {total, number}`, `Disimpan pukul {savedAt, time, short}`, `{percent, number}%`, `{limit, number} MiB`). Creator content is never translated.
- Verification PASS: `pnpm locales:validate --locale id --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: 263 messages formatted with `intl-messageformat` (locale `id`) — 0 problems; caption terminology corrected during review ("Caption", not a translation term). Prettier PASS.

## TASK-094 — 2026-11-08T12:37:05+07:00

- Files: `packages/shared/locales/id/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Natural formal Indonesian for every key incl. optional inventory titles, consistent terminology (host, pemain, room, lobi, PIN, papan peringkat, podium, pembahasan, polling, rangkaian/bonus rangkaian, laporan). Indonesian plural/ordinal use `other`: `{rank, selectordinal, other {ke-#}}` ("Peringkat ke-1"), `{seconds, plural, =0 {Waktu habis} other {Sisa # detik}}`, `{points, plural, other {+# poin}}`, accuracy `{numerator, number} dari {denominator, plural, other {# jawaban berpoin}}`; `md` for milliseconds; end time with visible timezone. Player copy keeps the immediate-send warning for single choice, wrong-origin QR never opened, and safe join failures.
- Verification PASS: `pnpm locales:validate --locale id --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` (locale `id`) — 0 problems. Prettier PASS.

## TASK-095 — 2026-11-08T12:38:17+07:00

- Files: `packages/shared/locales/id/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- Natural formal Indonesian for every key: admin health/settings/storage/invitations/users and their five states (plural `cleanupResult` with `=0`/`other`, one-time invite code shown once, unknown outcome → check the list), safe explanations for all 95 domain error codes (no SQL/credentials/stack/hidden-resource details; `{retryAfterMs, number} md`, revision conflict with both revisions), accessibility labels (`Opsi {label}, {shape}: {text}` with creator text untouched, puzzle instructions, shared deadline), and about/credits/license/language-guide copy (translated summary is not authoritative; legal text never invented).
- Verification PASS: `pnpm locales:validate --locale id --namespaces admin,validation,accessibility,about` and the full `pnpm locales:validate --locale id` (12 namespaces, 1102 messages) → coverage 100.0%, 0 errors, 0 warnings. Review: 266 messages formatted with `intl-messageformat` (locale `id`) — 0 problems. Prettier PASS. The Indonesian package is now complete.

## TASK-096 — 2026-11-08T12:39:17+07:00

- Files: `packages/shared/locales/ja/manifest.json`, `common.json` (184), `auth.json` (52); task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `ja`, `nativeName` "日本語", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors".
- Natural Japanese: concise noun labels for buttons/navigation, polite です/ます sentences for notices and confirmations, full-width punctuation (：、（）), consistent terms (クイズ, ルーム, PIN, ホスト, プレイヤー, ログイン/ログアウト, アップロード/ダウンロード, 招待コード, インスタンス, クリエイター). Japanese has only the CLDR `other` plural, so counts use `=0` + `other` (`{count, plural, =0 {結果はありません} other {#件の結果}}`); pagination `{page, number} / {totalPages, number} ページ`; dates/times via ICU with the visible timezone; safe auth wording. Creator content and identifiers are not translated.
- Verification PASS: `pnpm locales:validate --locale ja --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: 236 messages formatted with `intl-messageformat` (locale `ja`) — 0 problems. Prettier PASS.

## TASK-097 — 2026-11-08T12:40:17+07:00

- Files: `packages/shared/locales/ja/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Natural Japanese with the TASK-096 conventions (concise labels, polite sentences, full-width punctuation) and consistent terms (クイズ, 下書き, スライド, 問題/問題文, 選択肢, 解説, 主催, BGM, メディアライブラリ, 字幕, 文字起こし, 代替テキスト); question types 単一選択/複数選択/○×問題/記述式/並べ替えパズル/アンケート. Plurals use `other` (+ `=0`): `{count, plural, =0 {問題はありません} other {#問}}`, `{seconds, plural, other {#秒}}`; placeholders kept (`{row, number}行目、{column}列`, `スライド {position, number} / {total, number}`, `{savedAt, time, short} に保存`, `{percent, number}%`, `{limit, number} MiB`). Creator content is never translated.
- Verification PASS: `pnpm locales:validate --locale ja --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: 263 messages formatted with `intl-messageformat` (locale `ja`) — 0 problems. Prettier PASS.

## TASK-098 — 2026-11-08T12:41:36+07:00

- Files: `packages/shared/locales/ja/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Natural Japanese with the established conventions and terms (ホスト, プレイヤー, ルーム, ロビー, ランキング, 表彰台, 解説, アンケート, 連続正解, レポート, 正答率); honorific さん after player nicknames in announcements. Plurals/ordinals use `other`: `{rank, selectordinal, other {#位}}`, `{seconds, plural, =0 {時間切れ} other {残り#秒}}`, `{points, plural, other {+#ポイント}}`, `第{index, number}問 / 全{total, number}問`, fractional accuracy `{numerator, number} / {denominator, plural, …}`, ミリ秒 and the visible timezone. Review fix: the biggest-climber phrase uses `#ランクアップ` (not `#位アップ`, which reads as an absolute rank).
- Verification PASS: `pnpm locales:validate --locale ja --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` (locale `ja`) — 0 problems. Prettier PASS.

## TASK-099 — 2026-11-08T12:42:44+07:00

- Files: `packages/shared/locales/ja/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- Natural Japanese for every key: admin health/settings/storage/invitations/users and their five states (plural `cleanupResult` with `=0`/`other`, one-time invite code, unknown outcome → check the list), safe explanations for all 95 domain error codes (no SQL/credentials/stack/hidden-resource details; `約{retryAfterMs, number}ミリ秒`, revision conflict with both revisions), accessibility labels (`選択肢{label}、{shape}：{text}`, creator text untouched; keyboard and puzzle instructions; shared deadline), and about/credits/license/language-guide copy (translated summary is not authoritative; legal text never invented).
- Verification PASS: `pnpm locales:validate --locale ja --namespaces admin,validation,accessibility,about` and the full `pnpm locales:validate --locale ja` (12 namespaces, 1102 messages) → coverage 100.0%, 0 errors, 0 warnings. Review: 266 messages formatted with `intl-messageformat` (locale `ja`) — 0 problems. Prettier PASS. The Japanese package is now complete.

## TASK-100 — 2026-11-08T12:43:38+07:00

- Files: `packages/shared/locales/zh-Hans/manifest.json`, `common.json` (184), `auth.json` (52); task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `zh-Hans`, `nativeName` "简体中文", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors".
- Natural Simplified Chinese with full-width punctuation (，。：（）“”) and consistent terms (测验, 房间, PIN, 主持人, 玩家, 登录/退出登录, 上传/下载, 邀请码, 实例, 创作者, 幻灯片), friendly "你" address. Chinese has only the CLDR `other` plural, so counts use `=0` + `other` (`{count, plural, =0 {没有结果} other {# 个结果}}`); pagination `第 {page, number} 页，共 {totalPages, number} 页`; dates/times via ICU with the visible timezone; safe auth wording. Creator content and identifiers are not translated.
- Verification PASS: `pnpm locales:validate --locale zh-Hans --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: 236 messages formatted with `intl-messageformat` (locale `zh-Hans`) — 0 problems. Prettier PASS.

## TASK-101 — 2026-11-08T12:44:34+07:00

- Files: `packages/shared/locales/zh-Hans/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Natural Simplified Chinese with the TASK-100 conventions and terms (测验, 草稿, 幻灯片, 题目, 选项, 解析, 主持, 背景音乐, 媒体库, 字幕, 文字稿, 替代文本); question types 单选题/多选题/判断题/填空题/排序题/投票. Plurals use `other` (+ `=0`): `{count, plural, =0 {暂无题目} other {# 道题}}`, `{seconds, plural, other {# 秒}}`; placeholders kept (`第 {row, number} 行，{column} 列`, `第 {position, number} 张幻灯片，共 {total, number} 张`, `保存于 {savedAt, time, short}`, `{percent, number}%`, `{limit, number} MiB`). Creator content is never translated.
- Verification PASS: `pnpm locales:validate --locale zh-Hans --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: 263 messages formatted with `intl-messageformat` (locale `zh-Hans`) — 0 problems. Prettier PASS.

## TASK-102 — 2026-11-08T12:45:42+07:00

- Files: `packages/shared/locales/zh-Hans/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Natural Simplified Chinese with the established conventions and terms (主持人, 玩家, 房间, 大厅, 排行榜, 领奖台, 解析, 投票, 连续答对/连胜奖励, 报告, 正确率; 投影模式/直播模式). Plurals/ordinals use `other`: `第 {rank, selectordinal, other {#}} 名`, `{seconds, plural, =0 {时间已到} other {剩余 # 秒}}`, `{points, plural, other {+# 分}}`, `第 {index, number} 题，共 {total, number} 题`, fractional accuracy `{numerator, number} / {denominator, plural, …}`, 毫秒 and the visible timezone. Player copy keeps the immediate-send warning for single choice and that other-site QR codes are never opened.
- Verification PASS: `pnpm locales:validate --locale zh-Hans --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` (locale `zh-Hans`) — 0 problems. Prettier PASS.

## TASK-103 — 2026-11-08T12:46:44+07:00

- Files: `packages/shared/locales/zh-Hans/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- Natural Simplified Chinese for every key: admin health/settings/storage/invitations/users and their five states (plural `cleanupResult` with `=0`/`other`, one-time invite code, unknown outcome → check the list), safe explanations for all 95 domain error codes (no SQL/credentials/stack/hidden-resource details; `约 {retryAfterMs, number} 毫秒`, revision conflict with both revisions), accessibility labels (`选项 {label}，{shape}：{text}`, creator text untouched; keyboard and puzzle instructions; shared deadline), and about/credits/license/language-guide copy (translated summary is not authoritative; legal text never invented).
- Verification PASS: `pnpm locales:validate --locale zh-Hans --namespaces admin,validation,accessibility,about` and the full `pnpm locales:validate --locale zh-Hans` (12 namespaces, 1102 messages) → coverage 100.0%, 0 errors, 0 warnings. Review: 266 messages formatted with `intl-messageformat` (locale `zh-Hans`) — 0 problems. Prettier PASS. The Simplified Chinese package is now complete.

## TASK-104 — 2026-11-08T12:47:44+07:00

- Files: `packages/shared/locales/es/manifest.json`, `common.json` (184), `auth.json` (52); task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `es`, `nativeName` "Español", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors".
- Natural neutral Spanish addressing the user with "tú", correct accents and inverted question marks, consistent terms (quiz/quizzes, sala, partida, PIN, anfitrión, jugador, iniciar/cerrar sesión, subir/descargar, código de invitación, instancia, creador, informe). Spanish plurals use `one` + `other` (with `=0`): `{count, plural, =0 {Sin resultados} one {# resultado} other {# resultados}}`; dates/times via ICU with the visible timezone; safe auth wording. Creator content and identifiers are not translated.
- Verification PASS: `pnpm locales:validate --locale es --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: 236 messages formatted with `intl-messageformat` (locale `es`) — 0 problems. Prettier PASS.

## TASK-105 — 2026-11-08T12:48:46+07:00

- Files: `packages/shared/locales/es/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Natural Spanish ("tú") with the TASK-104 terminology plus borrador, diapositiva, pregunta, opción, explicación, organizar una partida, biblioteca multimedia, subtítulos, transcripción, texto alternativo; question types opción única/selección múltiple/verdadero o falso/escribir la respuesta/ordenar (puzle)/encuesta. Plurals use `one` + `other` (+ `=0`): `{count, plural, =0 {Sin preguntas} one {# pregunta} other {# preguntas}}`, plural seconds and issue counts; placeholders kept (`Fila {row, number}, columna {column}`, `Diapositiva {position, number} de {total, number}`, `Guardado a las {savedAt, time, short}`, `{percent, number} %` with the Spanish non-breaking style, `{limit, number} MiB`). Creator content is never translated.
- Verification PASS: `pnpm locales:validate --locale es --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: 263 messages formatted with `intl-messageformat` (locale `es`) — 0 problems. Prettier PASS.

## TASK-106 — 2026-11-08T12:50:03+07:00

- Files: `packages/shared/locales/es/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Natural Spanish ("tú") with consistent terms (anfitrión, jugador, sala/sala de espera, partida, clasificación, podio, explicación, encuesta, racha/bonificación por racha, informe, precisión; modes Proyector/Retransmisión). Plurals use `one` + `other`; Spanish ordinals use `{rank, selectordinal, other {#.º}}` ("1.º puesto"); seconds left with `=0`; fractional accuracy `{numerator, number} de {denominator, plural, …}`; ms and the visible timezone. Player copy keeps the immediate-send warning for single choice and that other-site QR codes are never opened.
- Verification PASS: `pnpm locales:validate --locale es --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` (locale `es`) — 0 problems. Prettier PASS.

## TASK-107 — 2026-11-08T12:51:11+07:00

- Files: `packages/shared/locales/es/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- Natural Spanish for every key: admin health/settings/storage/invitations/users and their five states (plural `cleanupResult` with `=0`/`one`/`other`, one-time invite code, unknown outcome → check the list), safe explanations for all 95 domain error codes (no SQL/credentials/stack/hidden-resource details; `unos {retryAfterMs, number} ms`, revision conflict with both revisions), accessibility labels (`Opción {label}, {shape}: {text}`, creator text untouched; keyboard and puzzle instructions; shared deadline), and about/credits/license/language-guide copy (translated summary is not authoritative; legal text never invented).
- Verification PASS: `pnpm locales:validate --locale es --namespaces admin,validation,accessibility,about` and the full `pnpm locales:validate --locale es` (12 namespaces, 1102 messages) → coverage 100.0%, 0 errors, 0 warnings. Review: 266 messages formatted with `intl-messageformat` (locale `es`) — 0 problems. Prettier PASS. The Spanish package is now complete.

## TASK-108 — 2026-11-08T12:52:18+07:00

- Files: `packages/shared/locales/fr/manifest.json`, `common.json` (184), `auth.json` (52); task checklist/log.
- Manifest: `schemaVersion` 1, `locale` `fr`, `nativeName` "Français", `direction` `ltr`, `packageVersion` 1.0.0, `catalogVersion` "1", credits "Kabuki Neko contributors".
- Natural French addressing the user with "vous", French typography (typographic apostrophe ’, no-break space U+00A0 before `:` `?` `!` `;` `%` and inside « »), consistent terms (quiz, salle, partie, PIN, hôte, joueur, se connecter/se déconnecter, téléverser/télécharger, code d’invitation, instance, créateur, rapport). French plurals follow CLDR (0 and 1 are `one`): `{count, plural, =0 {Aucun résultat} one {# résultat} other {# résultats}}`; dates/times via ICU with the visible timezone; safe auth wording. The typographic apostrophe also avoids ICU apostrophe escaping. Creator content and identifiers are not translated.
- Verification PASS: `pnpm locales:validate --locale fr --namespaces common,auth` → coverage 100.0%, 0 errors, 0 warnings. Review: 236 messages formatted with `intl-messageformat` (locale `fr`) — 0 problems. Prettier PASS.

## TASK-109 — 2026-11-08T12:53:23+07:00

- Files: `packages/shared/locales/fr/quizzes.json` (91), `studio.json` (91), `media.json` (81); task checklist/log.
- Natural French ("vous") with French typography and the TASK-108 terminology plus brouillon, diapositive, question, option, explication, animer une partie, médiathèque, sous-titres, transcription, texte alternatif; question types choix unique/choix multiples/vrai ou faux/réponse à saisir/puzzle/sondage; `Mio` for MiB. Plurals follow CLDR French (`one` covers 0–1, plus `=0`): `{count, plural, =0 {Aucune question} one {# question} other {# questions}}`, plural seconds and issue counts; placeholders kept (`Ligne {row, number}, colonne {column}`, `Diapositive {position, number} sur {total, number}`, `Enregistré à {savedAt, time, short}`, `{percent, number} %`). Creator content is never translated.
- Verification PASS: `pnpm locales:validate --locale fr --namespaces quizzes,studio,media` → coverage 100.0%, 0 errors, 0 warnings. Review: 263 messages formatted with `intl-messageformat` (locale `fr`) — 0 problems. Prettier PASS.

## TASK-110 — 2026-11-08T12:55:09+07:00

- Files: `packages/shared/locales/fr/host.json` (123), `player.json` (126), `reports.json` (88); task checklist/log.
- Natural French ("vous") with French typography and consistent terms (hôte, joueur, salle/salle d’attente, partie, classement, podium, explication, sondage, série/bonus de série, rapport, précision; modes Projecteur/Diffusion). Plurals follow CLDR French; ordinals use `selectordinal` with `one`/`other` and gender agreement ("1re place", "2e place"; "Vous êtes 1er"); seconds left with `=0`; fractional accuracy `{numerator, number} sur {denominator, plural, …}`; ms and the visible timezone. Player copy keeps the immediate-send warning for single choice and that other-site QR codes are never opened.
- Verification PASS: `pnpm locales:validate --locale fr --namespaces host,player,reports` → coverage 100.0%, 0 errors, 0 warnings. Review: 337 messages formatted with `intl-messageformat` (locale `fr`) — 0 problems. Prettier PASS.

## TASK-111 — 2026-11-08T12:56:22+07:00

- Files: `packages/shared/locales/fr/admin.json` (98), `validation.json` (95), `accessibility.json` (26), `about.json` (47); task checklist/log.
- Natural French ("vous", French typography) for every key: admin health/settings/storage/invitations/users and their five states (plural `cleanupResult` with `=0`/`one`/`other`, `Mio`, one-time invite code, unknown outcome → check the list), safe explanations for all 95 domain error codes (no SQL/credentials/stack/hidden-resource details; `environ {retryAfterMs, number} ms`, revision conflict with both revisions), accessibility labels (`Option {label}, {shape} : {text}`, creator text untouched; keyboard and puzzle instructions; shared deadline), and about/credits/license/language-guide copy (translated summary is not authoritative; legal text never invented).
- Verification PASS: `pnpm locales:validate --locale fr --namespaces admin,validation,accessibility,about` → 100.0%, 0 errors, 0 warnings; the full unfiltered `pnpm locales:validate` now reports en, es, fr, id, ja and zh-Hans built-ins at 100.0% coverage with 0 errors and 0 warnings (6 × 12 namespaces × 1102 messages). Review: 266 messages formatted with `intl-messageformat` (locale `fr`) — 0 problems. Prettier PASS on all locale JSON. All six built-in catalogs are complete; TASK-112 runs the full six-locale gate and builds the bundle.

## TASK-112 — 2026-11-08T13:01:43+07:00

- Files: `scripts/locales-build.ts`, `tests/contracts/locale-coverage.spec.ts`; task checklist/log.
- `locales-build.ts`: refactored publishing into `publish(dir, bundle)` (staged immutable `<buildId>/`, atomic template ZIP, registry written last, prune all but active + previous) and applied it to the API bundle (`--out`, default `locales-built`) and the web public mirror (`--web-public`, default `apps/web/public/locales` for the standard build, `none` to skip) — same files, same registry, same buildId; both outputs stay git-ignored. Added `SHIPPED_BUILTINS` (en, id, ja, zh-Hans, es, fr): the standard build refuses to publish unless each is present with 100% coverage (`INVALID_MANIFEST` diagnostics, nothing written); custom `--builtin-root` builds require only the validator's complete `en` unless `--require-builtins <tags|none>` overrides. This also closes review finding MN-23's "only en required" gap at release time.
- `locale-coverage.spec.ts` (runs the ESM-backed tools through tsx like the existing locale tests): full gate 0 errors/0 warnings with exactly the six built-ins valid at coverage 1 and every namespace file holding exactly its contract keys; no raw keys and non-English catalogs ≤ 5% identical to English with no copied sentences; all 61 Design §6 inventory IDs (S01–S17, M01–M12, B01–B12, F01–F20) have title + L/E/I/P/X keys in exactly one namespace and non-empty messages in all six catalogs; build publishes byte-identical, SHA-256-verified assets and registries to both targets with the same deterministic buildId (rebuild → same ID); the template ZIP extracts to manifest + 12 namespaces and validates as an external `de` package at coverage 1; a partial builtin root is refused for the five missing locales without writing output.
- Verification PASS: `pnpm locales:validate` → 6 locales 100%, 0 errors, 0 warnings; `pnpm locales:build` → buildId `caa1a1e1…98d24`, 6 locales, mirrored to the web public dir; `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/locale-coverage.spec.ts` 5/5 (with locale-build + locale-packages: 13/13, run 3×). Script typecheck (strict base config) and ESLint/Prettier PASS.

## TASK-113 — 2026-11-08T13:03:44+07:00

- Files: `apps/web/public/brand/logo.svg`, `mascot.svg`, `favicon.svg`, `THIRD-PARTY-NOTICES.md`; task checklist/log.
- Original hand-written SVG artwork (no third-party art, fonts or generated images): a kabuki cat with crimson kumadori strokes, gold forehead crest and a calm, friendly expression in the Design palette (Crimson #D9381E, Gold #F59E0B, Sumi Ink #18181B, face paint #FFF8F0). `mascot.svg` 320×320 is decorative (`aria-hidden`); `logo.svg` 400×96 is informative (`role="img"` + `<title>Kabuki Neko</title>`) with a wordmark that switches ink/accent colors via `prefers-color-scheme` (#18181B/#D9381E light, #FAFAFA/#FF8A75 dark); `favicon.svg` 32×32 uses a crimson tile and a bold, text-free cat head that stays recognizable at 16 px. Each file carries a provenance comment. Notices: new “Kabuki Neko brand assets” section with purpose, viewBox, accessibility, minimum logo size (≥ 32 px height), palette, verification and SHA-256 per file; the pending-assets bullet now points to it (Noto Sans still pending for TASK-115).
- Verification PASS (browser assertion, Chromium via Playwright, scratch script): all three SVGs decode at 16/32/128/320 px on light and dark canvases (24/24 images); DOM scan finds no script/foreignObject/image/use/link nodes, no href/src/url() and no event attributes; logo wordmark computed fill rgb(24, 24, 27) light / rgb(250, 250, 250) dark; screenshots reviewed (logo legible on both themes, favicon readable at 16 px, wordmark legible from 32 px). Prettier PASS on the notices file.

## TASK-114 — 2026-11-08T13:11:47+07:00

- Files: `scripts/optimize-audio.mjs`, `scripts/optimize-audio.spec.mjs`, `package.json` (`audio:optimize`, `test:audio`), `.gitignore` (generated `apps/web/public/audio/` and its staging/previous dirs); task checklist/log.
- Pipeline: checks ffmpeg (libopus + libmp3lame) and ffprobe with clear errors; scans the five phase folders (dynamic lobby `bgm-lobby-<id>.mp3`, all thinking/leaderboard/podium cues and ten SFX required; symlinked folders/files, unsafe or colliding names, non-MP3 and unknown files rejected before encoding); encodes each source to Opus 96 kbps VBR WebM (48 kHz) and LAME 128 kbps MP3 with fixed argument arrays, no shell and no network, applying `loudnorm=I=-16:TP=-1.5:LRA=11` to BGM in both formats and no normalization to SFX; probes codec and duration (≤ 0.3 s + 1% drift) and fully decodes every output; copies CREDITS.md byte-for-byte (SHA-256 checked); builds the manifest without a `phases` wrapper (lobby id/label/volume in stable order with readable fallback labels, BGM loop true, SFX one-shot, nekoPop throttleMs 150, victory default 0.9) and validates it with the shared `audioManifestSchema`; stages everything in a sibling directory and swaps it in only after all checks pass, so failures keep the previous output and re-runs remove stale entries. Sources are read-only. CI/provisioning: requires FFmpeg with libopus/libmp3lame on PATH (or `--ffmpeg/--ffprobe`) and the built shared package.
- Real run (`pnpm audio:optimize`, 20 sources, 1 m 07 s): 40 outputs published; lobby kabuki, matcha, neko8bit, showtime. Measured savings: sources 37.53 MiB → Opus/WebM 17.98 MiB (52.1% smaller), MP3 21.49 MiB (42.7% smaller) — measured, not a universal claim. Independent ffprobe/decode of all 40: 20 opus + 20 mp3, 0 decode errors, max duration drift 0.62 s on bgm-podium-victory (both encodings agree; the source MP3 header under-reports its length), nothing shortened; CREDITS identical; manifest schema PASS.
- Verification PASS: `node --test scripts/optimize-audio.spec.mjs` 11 tests, run 2× (3/4/6 lobby fixtures with label/volume/codec/credits/schema checks and untouched sources; missing cue + empty lobby; unsafe names, symlinks, unexpected files, symlinked folder; corrupt source and simulated encoder crash both keep the previous output with no staging leftovers; stale cleanup; missing ffmpeg/ffprobe; loudnorm only on BGM). ESLint + Prettier PASS on both scripts; repeated `pnpm audio:optimize` idempotent.

## TASK-114A — 2026-11-08T13:21:10+07:00

- Files: `audio-assets/kabuki-neko-audio/CREDITS.md`, `THIRD-PARTY-NOTICES.md`, `docs/audio-provenance.json` (new); task checklist/log.
- CREDITS: separates the code license (Apache-2.0 + Commons Clause, which is not a blanket non-commercial grant and does not cover audio) from the asset license (OpenTracks Audio Source Usage License, copyright stays with each creator); summarizes the relevant OpenTracks terms checked on 2026-11-08 (conversion/editing allowed; tool apps/platforms must consult site management first; distributing the audio files themselves or exposing them for easy copying is prohibited; credit optional); marks the set **release-unverified**; adds a per-track Verifikasi column. Fixed the `hhttps://` (#23981) and `https://https://` (#182) links, moved `/id/` links to `/en/`, replaced the stale license link with `/en/help/articles/license/` and the SFX link with `/en/se`, corrected #12959 to “Cat sonata - 8bit”, and flagged #13513 (page shows “Pink Steroid” by Anonyment) and #3300 (page lists composer “alaki paca”) as ⚠ discrepancies without guessing replacements. Formatted with Prettier.
- Provenance (`docs/audio-provenance.json`, schemaVersion 1): codeLicense, assetLicense (fetched page SHA-256 and relevant terms), `releaseStatus: "release-unverified"`, 4 releaseBlockers (no written permission for embedding in a self-hostable platform; none for storing/serving files; two metadata discrepancies; 10 SFX without per-file source) and 20 file entries with path, SHA-256, bytes, duration, generated outputs, supplied credit, source and verification (7 matched, 1 matched-after-correction, 2 discrepancy, 10 unverified SFX).
- Notices: new “Audio assets (third-party, release-unverified)” section linking the credits and provenance, listing what matched, what did not and the OpenTracks terms, with an explicit statement that no legal clearance is claimed. The old audio bullet now points to it.
- Verification PASS (scratch assertion): 20/20 source MP3s have provenance entries with matching SHA-256 and existing `/audio/*.webm|*.mp3` outputs; all 12 CREDITS link targets are https on opentracks.com with no double scheme, and each returned HTTP 200 (curl); `pnpm audio:optimize` re-run (40 files) and `/audio/CREDITS.md` is byte-identical to the source; release status and blockers recorded; Prettier PASS on the three files.

## TASK-115 — 2026-11-08T13:30:19+07:00

- Files: `apps/web/public/fonts/noto-sans-latin.woff2` (new), `scripts/package-assets.ts` (new), `THIRD-PARTY-NOTICES.md`, `apps/web/src/app/globals.css` (outside the listed targets: the spec's `font-display: swap`, CJK fallback and self-hosting need an `@font-face`, and the TASK-087 header pointed to this task for it); task checklist/log.
- Font: Noto Sans variable Latin subset (`wght` 100–900, used for 400/600/700/800), byte-identical to `files/noto-sans-latin-wght-normal.woff2` of `@fontsource-variable/noto-sans@5.3.0` (tarball integrity matched the registry `sha512-e3Zu…BiA==`; upstream Google Fonts v42, font version 2.015, © 2022 The Noto Project Authors, OFL-1.1), 35,820 B, SHA-256 `51ca196f…b52d`. `globals.css` declares it as "Noto Sans" with `font-display: swap` and the upstream Latin `unicode-range`, so CJK text uses `system-ui, sans-serif` and no CJK font is shipped.
- Notices: new “Noto Sans font” section (source, package, integrity, coverage, bytes, SHA-256, unmodified-use statement, full OFL-1.1 text with its LICENSE SHA-256) and “DiceBear avatar artwork” section for the six `AVATAR_STYLES` (package@version, artwork source, designer, artwork license, package LICENSE SHA-256; CC BY 4.0 attribution for Adventurer and Fun Emoji; no artwork modification yet, TASK-123 must list any; “free for personal and commercial use” recorded verbatim without inferring terms; unused collection styles excluded). The pending-asset bullets now point to these sections and to the legal packaging step; the audio section from TASK-114A already covers the 20 sources, 40 generated variants, CREDITS and provenance.
- `scripts/package-assets.ts`: verifies before writing anything: the legal sources exist; brand SVGs and the font are regular files within size limits with the SHA-256 recorded in the notices; SVGs have an `<svg>` root and no script/handlers/references; the WOFF2 fully decodes (own header/table-directory/Brotli decoder, no new dependency), maps the required Latin/diacritic code points and has a `wght` axis covering 400–800; the reproduced OFL text still hashes to the recorded LICENSE; the installed DiceBear core/collection and six style packages match the notices' versions and LICENSE checksums; audio sources match provenance (no unlisted source) and, when generated, all 40 outputs carry WebM/MP3 signatures and `/audio/CREDITS.md` is identical (`--require-audio` makes the generated set mandatory). It then stages `LICENSE` and `THIRD-PARTY-NOTICES.md` as `apps/web/public/legal/{LICENSE,THIRD-PARTY-NOTICES}.txt` (git-ignored), compares the copies and swaps them in; failures exit 1 and keep the previous copies. Exported helpers are ready for the TASK-174 contract tests.
- Verification PASS: `pnpm exec tsx scripts/package-assets.ts` → 4 static assets, 6 DiceBear styles, 20 audio sources + 40 outputs verified; both legal files byte-identical to their sources (`cmp`). The decoder/cmap parser output equals fontTools (232 code points, same table set, wght 100/400/900); every character in the en/id/es/fr catalogs is mapped. Chromium on `next build` + `next start`: `/fonts/noto-sans-latin.woff2` 200 `font/woff2`, FontFace "Noto Sans" loaded with display swap; the platform font for Latin/diacritic text at 400/600/700/800 is the custom Noto Sans (widths grow with weight); Japanese and Chinese render with the system "WenQuanYi Zen Hei" and no glyph matches the tofu rendering; screenshot reviewed. 17 scratch negative cases PASS (script/handler SVG, truncated/corrupted/fake font, notices checksum, altered OFL text, DiceBear version row, symlinked asset, missing LICENSE, unlisted or changed audio source, `--require-audio`, CREDITS copy drift, bad audio signature, positive generated-audio run), each leaving the previous legal copies and no staging directory. Strict tsc (base config), ESLint and Prettier PASS; web Vitest 8/8, lint and typecheck PASS; `next build` PASS.

## TASK-116 — 2026-11-08T13:38:00+07:00

- Files: `apps/web/src/lib/i18n/resolve.ts`, `format.ts`, `catalog-loader.ts`, `resolve.spec.ts` (all new); task checklist/log.
- `resolve.ts`: `kn_locale` cookie (read with decoding/canonicalization; serialize Path=/, Max-Age=31536000, SameSite=Lax, Secure on HTTPS; malformed tags throw `INVALID_LOCALE`), `kabuki:locale` storage key, `parseAcceptLanguage` (quality order, stable ties, q=0/`*`/invalid q/malformed tags dropped, header length and entry count bounded), `matchLocale` (exact → same language+script+region → language-script tag → bare base → another region; script explicit or implied must agree; Chinese uses the exact SA table: TW/HK/MO and `zh-Hant-*` are Traditional, CN/SG/`zh-Hans-*`/bare `zh` Simplified, and absent `zh-Hant` never falls back to Simplified; other languages imply scripts via `Intl.Locale#maximize`) and `resolveLocale` (cookie → storage → Accept-Language → instance default → en, each matched against the installed registry so removed or malformed preferences fall through).
- `catalog-loader.ts`: validates the registry with the shared schema, loads only the requested namespaces plus `common` for the locale and for `en`, deduplicates concurrent requests and evicts failures for retry; every file must hash to the registry SHA-256 (Web Crypto, or a pure-JS SHA-256 when `crypto.subtle` is missing on plain-HTTP LAN origins) and stay under 1 MiB; catalogs are parsed as data and rebuilt as validated ASTs (known element types only, no tag/markup elements, `other` branches required, nesting ≤ 5, ≤ 200 nodes, safe keys/placeholders, null-prototype option maps). Loads are all-or-nothing with typed `CatalogLoadError` codes (INVALID_REGISTRY, LOCALE_NOT_INSTALLED, NAMESPACE_FETCH_FAILED, HASH_MISMATCH, INVALID_CATALOG).
- `format.ts`: `createTranslator` formats compiled ASTs with intl-messageformat (`ignoreTag`, plain-string output), cached per locale/key; a missing translation uses the `en` message with English plural rules (`MISSING_TRANSLATION`); unknown keys, unloaded namespaces and formatting errors return the localized `common.status.unavailable` (or "…") instead of the raw key and report `UNKNOWN_KEY`/`FORMAT_ERROR` to a sink that can never break rendering; all ICU date/time styles and `formatDate` are pinned to the resolved IANA zone (invalid zones fall back to the runtime zone/UTC) with a localized `timeZoneLabel`; `formatNumber` uses cached Intl formatters.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/lib/i18n/resolve.spec.ts` → 43 i18n tests (web total 51/51): full SA table for en/id/ja/es/fr regions, zh-CN/SG/Hans-*/bare zh → zh-Hans, zh-TW/HK/MO/Hant-* → null without zh-Hant and → zh-Hant when installed, malformed tags, script-safe sr/uz/pa variants, region ranking; Accept-Language weighting and hostile headers; precedence with removed/malformed cookie and storage values; cookie read/serialize; loader namespace selection, RTL entry, dedupe, removed locale, invalid registry (no en, bad buildId), tampered file, failed then retried namespace, markup/unknown type/missing other/reserved placeholder/bad key/string value rejection, pure-JS SHA-256 equal to node:crypto for 0–70,000 bytes and used when Web Crypto is absent; real en/fr catalogs: French plural (=0/one/other), French number grouping, dates pinned to Asia/Jakarta and UTC, en fallback with diagnostics, safe unknown-key text, markup-looking values returned as plain text. Web lint and typecheck PASS; Prettier applied.

## TASK-117 — 2026-11-08T13:50:07+07:00

- Files: `apps/web/src/providers/locale-provider.tsx`, `apps/web/src/components/ui/locale-picker.tsx`, `apps/web/src/providers/locale-provider.spec.tsx` (new), `apps/web/src/app/layout.tsx`; supporting changes outside the listed targets: `apps/web/src/lib/i18n/locale.server.ts` (new server-only SSR bootstrap, kept out of the client bundle), `apps/web/src/lib/i18n/catalog-loader.ts` (`SHELL_NAMESPACES`, `serializeCatalog`/`deserializeCatalog`) and `eslint.config.mjs` (override letting `apps/web/src/**/*.server.ts` use Node builtins while still forbidding API/database imports); task checklist/log.
- SSR (`layout.tsx` + `locale.server.ts`): reads `public/locales/registry.json` (or `KN_LOCALES_DIR`), re-read on mtime change, and loads catalogs from disk through the shared loader (same SHA-256 + AST validation); resolves `kn_locale` cookie → Accept-Language → instance default (API public-config via `API_INTERNAL_URL`, cached 30 s, 1.5 s timeout, last value kept on failure) → en; renders `<html lang dir>` and passes a plain-JSON snapshot of `common` + `accessibility`. A broken locale package falls back to en; a missing bundle renders the safe fallback text. Filesystem calls carry `turbopackIgnore` so the build does not trace the whole project. The layout is dynamic (varies by cookie/header).
- `LocaleProvider`: hydrates from the server snapshot (re-validated), so text/lang/dir match; UTC on the server and the browser time zone after hydration via `useSyncExternalStore`; a storage-only `kabuki:locale` preference (no explicit cookie) switches after hydration and writes the cookie; `setLocale` loads first, keeps the old locale active with `pending`, commits catalog/lang/dir in one update (`useLayoutEffect` for `<html>`), ignores superseded results, keeps the old locale with a typed `error` on failure, and persists to the cookie (Secure on HTTPS) and localStorage with memory fallback; `ensureNamespaces` adds route namespaces; `tEnglish` gives bilingual recovery labels; children are never keyed on the locale.
- `LocalePicker` (F19): globe + native name trigger, popover on md+ and bottom sheet below; heading “<label> / Language”; registry-driven options with untranslated native name (`lang`/`dir`), name localized via `Intl.DisplayNames`, tag, and “Shown in English” for partial packages; accent/case-insensitive search over all three; “Loading language…” on the pending option while the old language stays; failure alert with retry; guide link `/help/languages`; Escape/close restore focus to the trigger, outside click closes without moving focus.
- Browser-found fix: React Server Components reject the loader's null-prototype option maps, so `serializeCatalog` now JSON-round-trips them (client re-validates); a regression test fails without the fix and passes with it.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/providers/locale-provider.spec.tsx` → 8 provider/picker tests (web total 59/59, 10 consecutive full runs stable): deferred switch with old language active, atomic commit, focus return, draft kept and one mount; failed fetch keeps en with alert, retry into RTL `ar` sets lang/dir and partial fallback; superseded switch ignored; storage-only preference applied after hydration with cookie write (reload); cookie beats storage; denied storage/cookies don't throw; on-demand namespaces; no-bundle fallback; RSC-safe snapshot; picker search (native/localized/tag/accent), coverage hint, empty result, guide link, Escape and outside click. Real server (`next build` + `next start`, picker temporarily mounted on the home page, reverted): SSR `lang` fr-CA→fr, zh-TW→en, zh-TW+ja→ja, zh-CN/zh→zh-Hans, ja-JP→ja, de→en, cookie es beats Accept-Language, malformed cookie ignored; Chromium: no hydration/console errors, picker switch fr→ja keeps the draft and returns focus, cookie `kn_locale=ja` (Lax, Path=/, ~1 year) + storage, reload SSR renders ja, storage-only `es` switches after hydration and writes the cookie; desktop popover and mobile sheet screenshots reviewed. Web lint/typecheck, repo-wide `pnpm lint` (6 packages) and Prettier PASS; build has no warnings.

## TASK-118 — 2026-11-08T13:56:06+07:00

- Files: `apps/web/src/components/ui/action-button.tsx`, `form-field.tsx`, `choice-group.tsx`, `form-primitives.spec.tsx` (new); supporting test helper outside the listed targets: `apps/web/src/test/locale.tsx` (`renderWithLocale`/`testInitialLocale`: real catalogs compiled at test time inside a fetch-free LocaleProvider, reused by later component specs); task checklist/log.
- B01 `ActionButton`: native button (default `type="button"`), primary/secondary/ghost/danger variants via cva, `md` ≥ 44 px and `lg` 48 px targets, wrapping labels; `pending` keeps the label, adds a spinner and a translated "Working…" status, sets `aria-busy`/`aria-disabled`, stays focusable and blocks presses and form submission; `disabled` is native, or with `disabledReason` stays focusable with the reason as accessible description; icon-only variant requires `accessibleName` (type-enforced) and hides the icon.
- B02 `FormField`: text/email/password/number/select/textarea with stable id (prop or `useId`) and derived help/counter/status/error IDs in `aria-describedby`; `aria-invalid` on error or over-limit with the value kept; grapheme counter using the shared `graphemeLength` (never truncates; IME/paste values pass through unchanged); `aria-required` + visible translated "Required" (no native validation bubbles); password reveal toggle (`aria-pressed`, translated show/hide labels, autocomplete/name kept, no spellcheck/autocapitalize); select keeps the value while options load ("Loading options…"), labels an unknown current value "Unknown", shows "No options available." when empty, supports a placeholder and disabled options.
- B03 `ChoiceGroup`: radio/checkbox in `fieldset`/`legend` with native inputs selected by domain id (DOM ids derived from the id, never the visual index), names from the title only with description/disabled reason as accessible description, check mark + tint for selection distinct from the focus ring; tabs with ARIA tablist, roving tabindex, arrows/Home/End moving focus without selecting (manual activation via Enter/Space), disabled tabs skipped, `aria-controls` panels, padded scroll container so the focus outline is never clipped; `pending` disables the group with "Loading choices…" and keeps the selection, empty shows "No options available." plus a parent action, `error` is described and keeps the last selection.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/form-primitives.spec.tsx` → 14 primitive tests (web total 73/73): click/Enter/Space, pending label + no double submit, disabled vs disabled-with-reason, recovery after pending, icon-only name; labelled field with stable id/help/required, grapheme counter with combining mark + emoji and over-limit flag, IME text unchanged, described error with value kept, password paste/reveal/keyboard order, select loading/empty/unknown/placeholder/disabled options, number/textarea; radio by domain id with description/reason, checkbox toggling, pending/empty/error group states, tabs roving focus/manual activation/disabled skip. Five Design §6.3 states covered per component. Visual check in Chromium (temporary page, reverted) light and dark: variants, counter, error, select, radio selection vs focus, tab focus ring (clipping found and fixed). Web lint, typecheck, Prettier and `next build` PASS.

## TASK-119 — 2026-11-08T14:00:51+07:00

- Files: `apps/web/src/components/ui/modal-sheet.tsx`, `menu-popover.tsx`, `dialog-primitives.spec.tsx` (new); `action-button.tsx` gains a typed `ref` prop (React 19 ref-as-prop) so dialogs can focus Cancel first; task checklist/log.
- B04 `ModalSheet` (Radix Dialog, Shadcn base): modal focus trap with Tab/Shift+Tab wrap, background hidden from assistive technology and non-interactive, scroll lock; `initialFocus` (Cancel for destructive confirmations); Escape, the close button and (optional) outside press only call `onCloseRequest(reason)` — nothing runs; focus returns to the element that opened it; closing while `pending` never cancels the parent's request (parent keeps the state; `aria-busy` while pending). One active modal: a module-level stack makes a later dialog take over and releases the earlier focus trap, which returns when the later one closes (no stacked traps). Widths 480/880/1040 desktop, viewport−32 px mobile, `fullHeight` sheets; header (title, description, optional Back, translated close) and footer stay fixed while only the body scrolls; inline `role="alert"` error between body and footer; states `loading` ("Loading content…", title/close available), `empty` ("Nothing to show here." + Close), `ready`.
- B05 `MenuPopover` (Radix DropdownMenu): keyboard open (Enter/Space/ArrowDown) with focus on the first item, arrows/Home/End/type-ahead, disabled items announced and skipped, one `onAction(id)` per selection, Escape/selection return focus to the trigger; an empty loaded menu removes the trigger; `loading` keeps the trigger and shows "Loading actions…"; long labels wrap; 16 px collision padding keeps it in the viewport; icon-only trigger named by `triggerLabel`.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/dialog-primitives.spec.tsx` → 8 tests (web total 81/81, 5 consecutive full runs stable): Tab/Shift+Tab wrap, inert background, Escape request + return focus to the opener, Cancel initial focus, scrim press requests `outside` (or is ignored when disabled), close during a pending save keeps "saving" and the reopened button pending with no second request, single active modal hand-over and focus back, loading/empty/error/long-body states with close available and footer/error outside the scroller, header Back; menu keyboard flow with disabled item, wrapping label, single action, Escape focus return, empty menu without trigger, loading menu. Chromium visual check (temporary page, reverted) desktop 1024 and mobile 390: widths, body scroll, error and footer visible, Cancel focused. Web lint, typecheck, Prettier and `next build` PASS.

## TASK-120 — 2026-11-08T14:05:01+07:00

- Files: `apps/web/src/components/ui/status-notice.tsx`, `skeleton-block.tsx`, `status-badge.tsx`, `status-primitives.spec.tsx` (new); task checklist/log.
- B06 `StatusNotice` (banner/toast/empty): errors are `role="alert"`/assertive and never auto-dismiss; other tones `role="status"`/polite; `livePriority="off"` for static empty states; `pending` shows translated "Processing…"; no message → nothing rendered; optional focusable action (Retry) and dismiss; safe correlation IDs (`[A-Za-z0-9_-]{1,128}`) shown as the translated "Reference ID: …" with Copy (wrapping, unsafe values hidden); non-error toasts auto-dismiss after `autoDismissMs`, paused on hover/focus. `useStatusNotices` de-duplicates repeated events by key (refresh + repeat count shown as decorative ×N) and `StatusNoticeRegion` is an always-present labelled toast region. `contentState` decides idle/loading/error/empty/ready: a failed fetch is never "empty", idle never shows a skeleton, stale data stays ready.
- B07 `SkeletonBlock`: text/card/rows/media/avatar layouts with stable reserved sizes, decorative shapes (`aria-hidden`, pulse only with `motion-safe`), one `role="status"` loading label and `aria-busy`; after `slowAfterMs` the visible "taking longer" message, after `failAfterMs` an alert "This content couldn't load." with Retry — never an endless skeleton.
- B08 `StatusBadge`: icon + text for neutral/info/success/warning/danger, `pending` ("Checking…" + spinner) and `unknown` ("Not known yet", dashed); metric values formatted per locale, `null`/`undefined` shown as "Not known yet" next to the label, never 0; no label → nothing rendered; long labels wrap.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/status-primitives.spec.tsx` → 8 tests (web total 89/89, 3 consecutive runs stable): persistent error alert with retry focus and copied reference ID, unsafe ID hidden, no render without message, pending/empty semantics, auto-dismiss with hover/focus pause, de-duplicated region (×3, dismiss), `contentState` matrix, skeleton single label → slow message → error + retry, data-region harness (fetch failure → error + retry, not empty; success with no rows → empty; idle → no skeleton), badge icon+text, unknown vs 0, formatted numbers, pending/unknown, no empty badge. Chromium visual check (temporary page, reverted): tones, repeat counter, long reference ID wrapping, badges and card skeleton. Web lint, typecheck, Prettier and `next build` PASS.

## TASK-121 — 2026-11-08T14:08:47+07:00

- Files: `apps/web/src/components/ui/content-card.tsx`, `data-collection.tsx`, `collection-primitives.spec.tsx` (new); task checklist/log.
- B09 `ContentCard`: the heading is the only link (`next/link`) or button (`onOpen`); actions render in their own row, never nested inside it; title visually clamped to two lines with the full text kept for assistive technology and the detail page (long Latin/CJK text wraps); metadata as a description list; 16:9 cover box with a translated fallback ("The cover image isn't available.") on error — also for failures before hydration via `img.decode()` on mount; covers decorative unless `alt` is given; states loading (skeleton with "Loading item…"), missing ("This item no longer exists."), error (alert + Retry).
- B10 `DataCollection` (controlled; page owns the URL query state): desktop `<table>` with caption, `scope` headers, sortable header buttons with `aria-sort`, wrapping cells (`overflow-wrap:anywhere`), inside a labelled focusable horizontal scroll region; mobile cards (`md:hidden`) with header/value pairs titled by the primary column; rows keyed by `rowKey`; known totals show "N results" and "Page X of Y", unknown totals show only the page number with `hasNextPage` (never "0 results"); states via `contentState`: loading without data → skeleton "Loading results…", refetch with data → rows kept, `aria-busy` + "May be out of date", failed refresh with data → older rows + alert "This list couldn't be refreshed. You're seeing older data." + Retry, failure without data → error + Retry (never the empty message), success without rows → "No results. Try changing or clearing your filters." + parent action.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/collection-primitives.spec.tsx` → 6 tests (web total 95/95): single heading link with actions outside, full long CJK title, cover fallback, button heading, card loading/missing/error; captioned table + mobile cards, keyboard sort with `aria-sort`, row identity preserved by key on reorder, known/unknown-total pagination (Previous/Next, disabled ends, no result count when unknown), loading/stale/failed-refresh/error-without-data/empty states. Chromium visual check (temporary page, reverted) desktop 900 and mobile 390: cards, clamped CJK title, cover fallback (pre-hydration failure found and fixed), stale table, mobile cards, pagination. Web lint, typecheck, Prettier and `next build` PASS.

## TASK-122 — 2026-11-08T14:13:41+07:00

- Files: `apps/web/src/components/ui/media-preview.tsx`, `media-reveal.tsx`, `media-preview.spec.tsx` (new); task checklist/log.
- B11 `MediaPreview`: image/audio/video/YouTube from the public media payload. URL allowlist: same-origin `/uploads/<safe segments>.<ext>` (no `..`, no `//`), or absolute http(s) URLs only on configured `allowedOrigins` without credentials/hash; YouTube only via the shared `canonicalYouTubeUrl`, embedded from youtube-nocookie.com with `start`/`end`, sandboxed iframe, strict referrer; anything else is rejected before reaching the DOM ("This media isn't available." + `onError("REJECTED_URL")`). Reserved aspect ratio from width/height (16:9 default). Text alternatives only from the asset: image alt, audio transcript disclosure, video captions rendered from cues on half-open [start, end) intervals with an `aria-pressed` toggle, visual description; missing transcript/captions stated with the translated notes. Video clips snap to `startSec` and pause at `endSec`. Autoplay only on request; a blocked play shows "Your browser blocked automatic playback." + "Turn on playback" (`onUserPlay`). Load failures (including before hydration via `img.decode()`) show the kind-specific "unavailable" text + Retry; the component never owns or stops the game timer. Loads the `media` namespace on demand.
- `MediaReveal`: GRID_3X3/GRID_5X5/BLUR progress is a pure function of the server-synchronized clock and the authoritative window (`revealProgress`), re-read every 100 ms but never counted by frames; grids uncover `floor(progress × cells)` tiles (all at the deadline) in a seeded FNV-1a/mulberry32 Fisher–Yates order shared by host and players; blur 24 px → 0; reduced motion removes fades and quantizes blur into four steps; decorative overlay (`aria-hidden`); `complete` forces a full reveal.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/media-preview.spec.tsx` → 17 tests (web total 112/112, 3 consecutive runs stable): rejected URLs (javascript:, data:, foreign host, traversal, protocol-relative, non-upload path, credentials, non-YouTube embeds, duplicate `v`), allowed uploads/origins, embed URL, rejected asset renders no media element; image alt/ratio/failure/retry; YouTube sandbox/title/clip; video clip start/end and caption cue boundaries 5.999/6/7.5 with toggle; blocked autoplay → user play; transcript/visual description/missing notes; progress/tile/blur math, deterministic shared order, irregular clock jumps without drift, image failure not stopping the reveal, completion. Chromium visual check (temporary page/uploads, removed): 3×3 and 5×5 overlays aligned with the image box, blur midway, failure placeholder. Web lint, typecheck, Prettier and `next build` PASS.

## TASK-123 — 2026-11-08T14:17:28+07:00

- Files: `apps/web/src/lib/avatar.ts`, `apps/web/src/components/ui/avatar-illustration.tsx`, `avatar-illustration.spec.tsx` (new); task checklist/log.
- `lib/avatar.ts`: the six `AVATAR_STYLES` load lazily from `@dicebear/collection/async` (one chunk per style, only when used); `parseAvatar` validates with the shared `avatarSchema` (style enum, seed `[A-Za-z0-9_-]{1,100}`, strict object); generation uses only the seed (no artwork options, consistent with the notices' "no modification" statement) and returns a `data:image/svg+xml` URI for an `<img>` (no innerHTML, no remote/user SVG), cached (bounded 300); `defaultAvatar(nickname)` is a deterministic bottts seed (FNV-1a) for missing/invalid avatars; `randomAvatarSeed` rerolls locally with `crypto.getRandomValues` inside the schema alphabet; `monogram` gives grapheme-aware initials.
- B12 `AvatarIllustration`: validated avatar or the nickname's default (invalid input marked `data-fallback` with the translated "That avatar style isn't available…" title); fixed-size silhouette with "Loading avatar…" while the style chunk loads; a generation failure shows initials on a brand circle with "Initials are shown instead." — nickname kept, never blocking join; decorative mode (empty alt, `aria-hidden`) vs informative name (label → nickname → "Avatar"); `variant="mascot"` renders the bundled brand mascot with neutral/happy/surprised/thinking poses.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/ui/avatar-illustration.spec.tsx` → 6 tests (web total 118/118): six styles deterministic against an independent cache-free DiceBear generation, different seeds/styles differ, no script or remote href in output; schema validation incl. URL/markup seeds, extra keys and length; rerolls unique and schema-valid; default per nickname; monogram with accents/emoji; informative/decorative/labelled modes; invalid/missing avatar → nickname default; loading silhouette size/label; failing loader → initials. Production build in Chromium (temporary page, reverted): two lorelei seeds, invalid style → bottts default, mascot; only the lorelei (142 KB) and bottts (73 KB) artwork chunks were downloaded — unused styles were not. Note for TASK-180: the shared app chunk is ~574 KB raw (locale provider, zod, ICU formatter), to be measured against the player budget there. Web lint, typecheck, Prettier and `next build` PASS.

## TASK-124 — 2026-11-08T14:21:15+07:00

- Files: `apps/web/src/lib/api-client.ts`, `api-client.spec.ts` (new); task checklist/log.
- `createApiClient({ baseUrl, getAccessToken, refreshAccessToken, fetch, timeoutMs })`: typed `request` (Zod response schema → `INVALID_RESPONSE` on mismatch; `ETag` → revision); relative paths only (absolute, protocol-relative, non-slash and `..` paths refused before any fetch); headers `Accept`, JSON `Content-Type` (multipart left to the browser), `Authorization: Bearer` from the in-memory getter, `X-Kabuki-Client: web-v1`, `If-Match: "<revision>"`, `Idempotency-Key`; `credentials: "include"` for the refresh cookie, `cache: "no-store"`, timeout combined with the caller's `AbortSignal`.
- `ApiError(status, code, params, details, correlationId, uncertain)` from the shared envelope schema, `retryAfterMs` from the body or `Retry-After` (seconds/date); malformed error bodies become `INTERNAL_ERROR`; transport failures `NETWORK_ERROR`/`TIMEOUT`/`ABORTED`; mutations failing by network/timeout/502/503/504 are `uncertain`. `apiErrorMessageKey` maps every shared `ErrorCode` (95/95 present in the catalog) and client code to a `validation.errors.*`/`common.status.*` key.
- No blind retries: one refresh-and-replay after `TOKEN_EXPIRED` only for GET or mutations guarded by `If-Match`/`Idempotency-Key`, never for `/auth/*` credential mutations. `mutate(operation, request)` sends a keyed create/upload/import once and, if uncertain, reconciles via `GET /operations/:key?operation=…` (`reconciled` with resourceId, `pending`, `not-received` on 404, `unknown` when the lookup fails); definite failures are rethrown.
- `createLatestRequest` aborts superseded list/search requests and reports late results as stale; `download` fetches with the bearer header into a Blob with a sanitized `Content-Disposition` filename (UTF-8 `filename*`, separators/control chars replaced); `saveBlob` clicks a temporary `blob:` link and revokes it.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/lib/api-client.spec.ts` → 10 tests (web total 128/128): headers/credentials/no token in URL, If-Match/Idempotency-Key/multipart, refused paths with zero fetches, invalid response shapes; 409 conflict params + message key, 429 retry from body vs `Retry-After`, malformed 503 uncertain; message keys for all error codes; refresh-and-replay once for GET `/auth/me`, no refresh/replay for `/auth/refresh` or unguarded POST; out-of-order list with abort; uncertain upload → reconciled (single upload), import 504 → pending, create timeout → not-received (single create), 422 rethrown without lookup, lookup failure → unknown; download with bearer header, sanitized name, blob: URL revoked, no link left. Web lint, typecheck and Prettier PASS.

## TASK-125 — 2026-11-08T14:26:57+07:00

- Files: `apps/web/src/providers/auth-provider.tsx`, `apps/web/src/lib/refresh-coordinator.ts`, `apps/web/src/providers/auth-provider.spec.tsx` (new), `apps/web/src/app/layout.tsx` (AuthProvider inside LocaleProvider with the public API base `NEXT_PUBLIC_API_URL` + `/api/v1`); task checklist/log.
- `refresh-coordinator.ts`: single-flight per tab; cross-tab serialization with Web Locks (`kabuki-neko:auth-refresh`) or, without it, a bounded localStorage lease (owner + 10 s expiry, waiting tabs reuse the broadcast token or take over after the lease); the winner broadcasts the new access token on `BroadcastChannel` (`kabuki-neko:auth`, in memory only) so later tabs reuse it instead of replaying the rotated cookie; revoked/expired/uncertain outcomes resolve to a failure (no retries); `share` (sign-in) and `announceLogout` messages; strict message/lease parsing.
- `AuthProvider`: access JWT in a ref only (never storage); lazy `ensureSession` (refresh through the coordinator + `GET /auth/me`) triggered by `RequireAuth` — public pages make no auth calls; API client wired with the bearer getter and a once-per-request refresh; a failed refresh disables further automatic refreshes (no loop) and moves an authenticated session to `reauth`; 401 on `/auth/me` (deactivated) → anonymous; `acceptSession` stores sign-in/setup/register responses and shares the token so waiting tabs resume; `signOut` calls `/auth/logout`, clears token/principal, aborts `sessionSignal` and signs out every tab. `RequireAuth` hides protected content until checked, renders the fallback for anonymous visitors, and on `reauth` keeps the same wrapper mounted (`inert` + `aria-hidden`, non-secret drafts survive) with a re-auth prompt. `safeReturnTo` accepts only same-origin, normalized paths under /dashboard, /host, /reports, /join, /play, /about, /help.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/providers/auth-provider.spec.tsx` → 19 tests (web total 147/147, 3 consecutive runs stable) against a fake API that rotates the shared cookie and revokes the family on replay: three tabs with Web Locks → one refresh, lease fallback → one refresh and the lease released, uncoordinated tabs → revoked (control); lazy check hides content until refresh + /auth/me, token never in storage; anonymous and deactivated users see only the fallback; revoked refresh → `reauth`, no further refresh calls on repeated 401s, draft preserved in the inert wrapper; cross-tab single refresh, sign-out in one tab ends the other and aborts its session signal; 11 unsafe returnTo values rejected, safe paths kept with query/hash. Production build smoke in Chromium: home page renders with no console errors and no API calls. Web lint, typecheck and Prettier PASS.

## TASK-126 — 2026-11-08T14:30:15+07:00

- Files: `apps/web/src/stores/studio.store.ts`, `apps/web/src/hooks/use-unsaved-changes.ts`, `apps/web/src/stores/studio.store.spec.ts` (new); task checklist/log.
- `createStudioStore()` (Zustand vanilla store, one per open quiz; `useStudio(store, selector)` binding): `saved {revision, snapshot}` vs working `draft` (deep-cloned on load); `isDirty` compares canonical JSON (sorted keys) so key order, formatting and UI locale never affect it; new slides from `blankQuestion(type)` have empty, untranslated text, type-appropriate option counts (TF 2, TYPE_ANSWER 1 text key, others 4), POLL multiplier 0 and shared empty accessibility. Add (after the selected slide), duplicate (fresh question and option UUIDs, inserted after the source), move (by ID, clamped) and delete (by ID; selects the next neighbour, the previous one when the last slide is removed, nothing when the quiz becomes empty) renumber `orderIndex` contiguously; capped at 100 questions. Metadata patching; `updateQuestion` keeps id/orderIndex.
- Explicit save only (no timers, no persistence): `save(persist)` sends the draft with the saved revision; on success `saved` takes the server detail and the draft follows it unless the user edited during the request (those edits stay dirty); a 409 `REVISION_CONFLICT` keeps the draft object and records `conflict.currentRevision`; `rebaseDraft(detail)` adopts the server revision for a deliberate overwrite, `reloadFromServer(detail)` discards local edits; other failures (incl. network) keep the draft with `saveError`; concurrent saves are skipped.
- `useUnsavedChanges({ dirty, save })`: `beforeunload` warning armed only while dirty; `requestNavigation(go)` navigates immediately when clean, otherwise opens the guard with `stay`, `discard` and `saveThenLeave` (navigates only after a successful save; failure keeps the page, the draft and `failed`).
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/stores/studio.store.spec.ts` → 10 tests (web total 157/157): snapshot vs draft separation and structural dirty (revert = clean); add/duplicate/move with stable IDs, fresh duplicate IDs, clamped moves, contiguous order and shared `quizWriteSchema` validity after each change; deleting middle/last/only slides with selection; canonical equality under key reordering, identical blank slides under ja-JP/fr-FR, document language change not dirtying; no autosave after 60 s, saved revision 5→6 with an edit during save kept dirty; conflict preserves the draft, rebase then saves with revision 7, reload discards edits; network/422 failures keep the draft; guard navigation flow and beforeunload only while dirty. Web lint, typecheck and Prettier PASS.

## TASK-127 — 2026-11-08T14:33:59+07:00

- Files: `apps/web/src/stores/game.store.ts`, `apps/web/src/stores/game.store.spec.ts` (new); task checklist/log.
- `createGameStore()` (Zustand vanilla, outside the React tree; `useGame(store, selector)`): authoritative role snapshot (`HostRoomSync | PlayerRoomSync`), `snapshotRevision`, `phaseVersion`, seen event IDs (bounded 1000), transport state, `syncRequested`, local drafts keyed `${sessionId}:${questionId}`, terminal reason.
- `applySync`: installs a full snapshot; a different session (even with the same PIN) resets fences, drafts and terminal state; the same session keeps only the current question's draft; an `acceptedAnswer` in a player snapshot locks that draft (value and submissionId from the server).
- `applyEvent` fencing per SA §5.1: other session → dropped; `revision <= snapshotRevision` → dropped; duplicate `eventId` → dropped; `phaseVersion` older than the current → dropped (no phase rewind); out-of-order revisions within a phase and distinct events sharing a revision are applied. Reducer for player joined/updated/left/presence, lock, countdown, preview (resets accepted answer/result or host answered count), answering (authoritative timing), host answer counts, reveal (player result → score/streak/rank only from the server), leaderboard (+ player selfRank), podium (host finalization / player result), finished, report status; kicked/session-replaced/expired set the terminal reason; `room:error` requests a sync; `room:version` heartbeats newer than the snapshot request a sync.
- Drafts: `setDraft` only for the current answering question and while not submitted; `markSubmitting`/`markAccepted`/`markRejected`; `retryableSubmission` returns the in-flight draft only when the snapshot shows it unaccepted and `serverNow < acceptanceClosesAt` (identical submissionId/payload). No optimistic phase or score. `checkHeartbeat` requests a sync after 12 s without heartbeats; recovering from reconnect requests a sync.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/stores/game.store.spec.ts` → 7 tests (web total 164/164) with fixtures validated by the shared room schemas: stale/duplicate/stale-phase pushes, in-phase reordering, no rewind; same-revision distinct host events and player reveal/leaderboard projections; new session reusing the PIN (old pushes dropped, lower revisions accepted, drafts cleared); accepted recovery after reconnect (locked, no retry, sync satisfied); retry window before/after acceptance close; heartbeat-driven sync and missed heartbeats; kicked terminal and reset; state survives remounts under fr/ja locale providers. Web lint, typecheck and Prettier PASS.

## TASK-128 — 2026-11-08T14:40:30+07:00

- Files: `apps/web/src/lib/socket-client.ts`, `apps/web/src/hooks/use-socket.ts`, `apps/web/src/hooks/use-session-recovery.ts`, `apps/web/src/hooks/use-session-recovery.spec.tsx` (new); supporting change to `apps/web/src/stores/game.store.ts` (`requestSync`, `setTerminal` actions so ACK outcomes reach the single store); task checklist/log.
- `createGameSocket`: `<wsUrl>/game` on `/socket.io` (websocket → polling), Socket.IO auto-reconnect off, handshake `{protocolVersion: 1, accessToken?}` evaluated on every connect; `emit` validates the request with the shared contract (distributive payload type for union requests such as join), adds/keeps a `requestId`, resolves the parsed ACK (`ok` data or shared error envelope) or `unknown` after 5 s (late ACKs ignored, never treated as success or re-sent); `on` validates push envelopes with the role's event schemas; `backoffDelay` 1/2/4/8/16/30 s + ≤20 % jitter, never below `retryAfterMs`.
- `useGameSocket`: one client per page; all push and lifecycle listeners registered once (deps: client/store/role), removed on unmount; pushes → `store.applyEvent`; transport mirrored into the store; heartbeat watchdog every 2 s; manual reconnect with backoff over consecutive failures (reset after a successful connect), a later longer server retry-after reschedules the pending attempt; terminal outcomes disconnect and stop reconnecting.
- `useSessionRecovery`: player credentials only `{sessionId, playerId, sessionToken, pinCode}` in `kabuki:player:<sessionId>` + `kabuki:player-pin:<pin>` (validated on read); on connect (also when already connected at mount) players rejoin with the stored token — a lost ACK retries with the same requestId — and hosts `host:recover_room`, refreshing the access token via `onAuthExpired` + `auth:update` once on 401; `room:sync` whenever the store requests it; kick/replacement/invalid token/room lost or expired clear the credentials, mark the store terminal and never rejoin; `submit` sends a new answer only before `inputClosesAt`, resolves accepted/pending/rejected/closed, an unknown ACK or ALREADY_ANSWERED requests a sync, and only `retryableSubmission` (same submissionId and payload while acceptance is open) is ever re-sent.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/hooks/use-session-recovery.spec.tsx` → 8 tests (web total 172/172, 3 consecutive runs stable) with a scripted fake server: lost submit ACK → sync shows accepted → locked, one submit and one sync; never-received submit → identical re-send (same submissionId/answer); refresh after accepted → recovery join, draft locked, no submit; kick → credentials cleared, disconnected, no rejoin after reconnect; replacement + server disconnect → no reconnect; invalid recovery token → terminal and cleared; backoff 1 s/2 s/4 s over failures then reset, server retry-after 9 s honoured; host 401 → token refresh → `auth:update` → recovered; listener counts unchanged after a locale switch (en→fr) and repeated re-renders, connect listeners once per hook, all removed on unmount. Web lint, typecheck and Prettier PASS.

## TASK-129 — 2026-11-08T14:43:42+07:00

- Files: `apps/web/src/hooks/use-game-clock.ts`, `apps/web/src/components/player/game-timer.tsx`, `apps/web/src/hooks/use-game-clock.spec.tsx` (new); task checklist/log.
- `createClockSync`: each `room:time` sample estimates server time at receipt as `serverSentAt + RTT/2` with `RTT = (receive − send) − server processing` measured on `performance.now()`; offsets are stored against that monotonic clock (wall-clock jumps ignored); the offset is the median of the latest five samples; before any sample a provisional offset comes from the snapshot `serverTime`.
- `useGameClock({ socket, store })`: measures on connect/reconnect (also when already connected), every 30 s while connected, and when a new session snapshot arrives; stops while disconnected; only sample arrival updates React state; `serverNow()` is a stable function. It never edits the snapshot, submits, or extends deadlines.
- F15 `GameTimer`: SVG ring + monospace tabular number (88 px player / 128 px host) of `ceil((inputClosesAt − serverNow())/1000)`, refreshed locally every 200 ms inside the component only; clamped at 0 and never increasing for the same deadline (rebases can only shorten it); `onInputClosed` once at the deadline (UI lock only); grace period shows "Waiting for results…", afterwards "Answers are closed."; polite live region announces the opening time, five seconds left and "Time's up." once each per deadline (the visible number sits in a `role="timer"`, not live); a new deadline (next or recovered phase) resets; untimed phases render nothing; ring transition only with motion allowed.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/hooks/use-game-clock.spec.tsx` → 6 tests (web total 178/178, 3 consecutive runs stable): RTT midpoint math and median of the latest five with an outlier; provisional offset and immunity to a 1-hour device clock jump; sampling on connect, every 30 s, none while disconnected, again after reconnect, snapshot/timing untouched; rebase never grows the display (18 s stays 18 s, then shortens to 14 s), zero at the deadline with the grace message, closed message after grace, `onInputClosed` once; announcements exactly opening/5 s/time's up and a fresh deadline restarting at 20 s; 30 ticks without a parent re-render; untimed renders nothing. Web lint, typecheck and Prettier PASS.

## TASK-130 — 2026-11-08T14:48:10+07:00

- Files: `apps/web/src/stores/useAudioStore.ts`, `useAudioStore.spec.ts`, `apps/web/src/lib/audio-manager.ts`, `audio-manager.spec.ts` (new); task checklist/log.
- `useAudioStore` (Zustand `persist`, key `kabuki-neko-audio-prefs`, version 1): defaults isMuted false / master 0.8 / bgm 0.7 / sfx 0.9 / currentLobbyTrackId null; actions toggleMute, setMuted, setMaster/Bgm/SfxVolume (clamped 0–1, non-finite keeps the current value), setCurrentLobbyTrackId (safe track id or null), resetPreferences; session-only `streamerBgmOptIn` (default off, never persisted); `partialize` writes only the five preferences; `merge` re-validates hydrated data (`sanitizePreferences`); `skipHydration` + `hydrateAudioPreferences()` keep SSR and the first client render identical; resilient storage falls back to memory when localStorage is denied.
- `AudioManager` / `getAudioManager()` singleton: Howler imported lazily on first use; gain = cue (or override) × master × channel, mute → 0 without touching volumes, preferences re-applied to live handles; one steady BGM (same key never restarts), switching disposes the previous Howl, crossfade capped at 500 ms is the only overlap and the outgoing Howl is unloaded on completion or interruption; generation counter discards stale async work (e.g. stop while Howler loads); rate reset to 1 per track, `setBgmRate`; SFX cached per cue, `eventId` dedup (bounded) and monotonic per-cue throttle (nekoPop 150 ms); `[webm, mp3]` with MP3-only fallback after a load/decode error, then `error` status; `playerror` → `blocked`, `unlock()` resumes the context and replays the current BGM; exclusive lobby previews stopped by live BGM; `stopAll` unloads everything and cancels fades; lease ownership (`acquire`/`release`) so stale StrictMode/route cleanups never stop the current owner.
- Verification PASS: `pnpm --filter @kabuki-neko/web test` → 13 new tests (store 4, manager 9; web total 191/191, 3 consecutive runs stable) with fake Howler and clock: defaults/clamping/NaN, mute keeps volumes, exact persisted fields without the opt-in, validated hydration of corrupt values, denied storage; lazy load, gain math, mute/unmute, victory override; single steady loop, no orphan, rate reset; 2000 ms crossfade capped to 500 ms, interruption disposes the old outgoing, final state one playing Howl, fade-out stop unloads all; stale playBgm after stop creates nothing; burst of 10 nekoPop → 1 play then again after 150 ms, eventId dedup; blocked autoplay → unlock denied → unlock granted → replay; MP3 fallback then error; preview exclusivity; StrictMode lease ownership. Web lint, typecheck and Prettier PASS.

## TASK-130A — 2026-11-08T14:54:41+07:00

- Files: `apps/web/src/hooks/useAudioEngine.ts`, `apps/web/src/hooks/useAudioEngine.spec.tsx` (new); task checklist/log.
- `useAudioEngine({ role, snapshot, serverNow, manifest?, manager?, vibrate?, isHidden?, … })` maps authoritative room state to `AudioManager` actions: acquires/releases a manager lease, hydrates and applies audio preferences, loads/validates `/audio/audio-manifest.json` (or uses an injected one), unlocks on the first pointer/key/touch gesture and keeps listening while blocked (`unlock()` for explicit retry).
- Host: LOBBY plays the quiz's installed lobby id or one random pick per session (never re-rolled; the session choice wins after `cycleNextLobbyTrack`, which advances in manifest order with a 500 ms crossfade and records `currentLobbyTrackId`); countdown fades the lobby (400 ms) then hyoshigiStart; preview fades music and plays questionWhoosh; answering plays thinking music (puzzle for ORDER_PUZZLE or ≥ 60 s, sprint ≤ 15 s, else standard); for ≥ 10 s questions the last 5 s set rate 1.22 once and tick once per displayed second (dedup session/question/phaseVersion/second, hidden-tab ticks skipped for good), at the input deadline rate resets and music stops; reveal resets rate, stops music, timeupGong, revealBar at 450 ms; leaderboard groove with 300 ms fade-in; podium buildup, spotlights at 1200/3500/6500 ms for present ranks, victory (0.95) at 6500 ms (also without a first place, never regressing on re-render), no winners → nothing; FINISHED keeps the final music and only settles victory after a recovery. Signal `playerJoined` → nekoPop (manager throttles bursts).
- Player: no music except Streamer rooms after the session opt-in (thinking only, stopped at the input deadline); countdown optional 100 ms vibration; reveal CORRECT/PARTIAL → answerCorrect + [80,50,80], INCORRECT/UNANSWERED → answerWrong + 250 ms, positive with streak ≥ 3 → streakFire at 350 ms, POLL/NOT_ELIGIBLE nothing; podium rank 1–3 → answerCorrect when that rank appears; signals ownJoin/avatarRandomized/answerAccepted → nekoPop. Vibration is feature-detected and optional.
- Scheduling is relative to the authoritative phase start; cues more than 300 ms late (reconnect, hidden tab) are skipped and never replayed; music transitions still apply in hidden tabs; delayed cues are cancelled by generation on every relevant change and on exit; the choreography re-runs only on audio-relevant keys (phase/version/question/results/podium/track/display mode/opt-in), so joins and presence never repeat cues.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/hooks/useAudioEngine.spec.tsx` → 8 tests (web total 199/199, 3 consecutive runs stable) with a recording fake manager and fake timers/clock: full host flow lobby→FINISHED (all host cues in order, ticks 5…1, rate 1.22 → 1, podium spotlights + victory, FINISHED at 8000 ms without restart); variant selection and 5 s (no hurry-up) vs 10 s (5 ticks) questions; hidden-tab ticks skipped without replay; recovery into reveal (no late gong/revealBar), podium before/after 6500 ms, FINISHED, zero winners; lobby specific id, cycle with crossfade, no revert on re-render, exit cancels pending revealBar and releases the lease; player results/streak/vibration, POLL/NOT_ELIGIBLE silence, absent vibration API; own podium rank at 3500 ms, signals, Streamer opt-in music stopped at the deadline, no player ticks; gesture unlock retried while blocked then removed. All ten SFX exercised across both roles. Web lint, typecheck and Prettier PASS.

## TASK-130B — 2026-11-08T14:57:23+07:00

- Files: `apps/web/src/components/host/AudioController.tsx`, `AudioController.spec.tsx`, `apps/web/src/components/player/streamer-audio-toggle.tsx` (new); task checklist/log.
- `AudioController` (host stage, top right): mute button (`aria-pressed`, translated Mute/Unmute, focus kept) and the M shortcut, ignored in inputs/textareas/selects/role=textbox/contenteditable areas and with Ctrl/Alt/Meta/Shift or key repeat; "Sound settings" Radix popover with labelled 0–100 % sliders (master, music, sound effects; `aria-valuetext`, store-clamped) and the local-only note; LOBBY-only "Now playing: {track}" and "Next track" (calls the engine's 500 ms crossfade cycle; hidden with fewer than two tracks); states loading / no tracks (status), blocked autoplay and failure (alert + "Turn on sound"/"Try again" → unlock); only the local audio store and the provided callbacks are touched (no room settings or timer); the key listener is removed on unmount.
- `StreamerAudioToggle` (player): renders nothing outside Streamer rooms; in Streamer rooms an `aria-pressed` switch "Play thinking music on this device" / "Turn off thinking music" described by "Sound plays only on this device."; the opt-in is session-only (never persisted, never sent to the room).
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/host/AudioController.spec.tsx` → 6 tests (web total 205/205): mute by click and M with focus kept, M ignored with Ctrl/Shift/Meta, typing "m" into an input and contenteditable detection; keyboard-opened popover with three labelled sliders, change → 0.35, clamping, Escape returns focus; lobby-only title/Next track (and no unlock side effect), hidden outside LOBBY; loading/empty/blocked/error with actions; shortcut removed after unmount; Projector renders nothing, Streamer toggle on/off with description and nothing persisted. Web lint, typecheck and Prettier PASS.

## TASK-130C — 2026-11-08T14:59:49+07:00

- Files: `apps/web/src/components/common/CreditsModal.tsx`, `CreditsModal.spec.tsx` (new); task checklist/log.
- `CreditsModal` / `CreditsButton`: loads the packaged `/audio/CREDITS.md` (size-capped 256 KiB) and renders a safe Markdown subset with React nodes only — headings (offset under the dialog's h2), paragraphs, quotes, ordered/unordered lists, tables (labelled scroll regions, wrapping cells), rules, inline code, bold/italic and links; no raw HTML (markup appears as literal text); links only for `https:` (new tab, `noopener noreferrer`, no credentials) and same-origin paths, while `javascript:`, `data:`, `http:` and protocol-relative targets stay text. Original attribution language and composer metadata are preserved (content marked `lang="id"`); translated chrome states that code and audio are licensed separately; footer links to `/audio/CREDITS.md` (download), `/legal/THIRD-PARTY-NOTICES.txt` and the official `/legal/LICENSE.txt` — no claim that the code license covers the audio. States: loading (ModalSheet busy body), empty, ideal, partial (credits flagging ⚠/release-unverified show "Some audio credit details are missing."), error with Retry. Built on ModalSheet (media width, full-height mobile sheet, focus trap, Escape, focus returned to `CreditsButton`, the footer/admin trigger). Loads the `about` namespace on demand.
- Verification PASS: `pnpm --filter @kabuki-neko/web test -- src/components/common/CreditsModal.spec.tsx` → 5 tests (web total 210/210): real CREDITS.md renders ≥ 4 tables, composers, 10 OpenTracks source links with safe attributes, the code-license paragraph, the partial note and the three footer links; hostile document yields no script/img/iframe elements, literal markup text, only the https link as an anchor, `<iframe>` inside code; `safeHref` rules; loading and empty states; error → Try again → content; trigger → focus stays inside through tabbing, Escape closes and returns focus, mobile width class. Web lint, typecheck and Prettier PASS.

## TASK-131 — 2026-11-08T15:11:25+07:00

- **Files**:
  - `apps/web/src/lib/qr.ts` (CREATE): `normalizeOrigin`, `configuredAppOrigin` (`NEXT_PUBLIC_APP_URL`, else page origin), `isValidPin` (shared `pinCodeSchema`, ASCII digits only), `buildJoinUrl` (`${origin}/join?pin=NNNNNN`, leading zeros kept), `parseScannedJoin` (exact origin + `/join` + single `pin`; rejects other origins as `wrongOrigin`, and `javascript:`/`data:`/credentials/extra params/fragment/non-ASCII digits/oversize as `invalid`), `createQrMatrix` (lazy `qrcode`, ECC M), `qrSvgPath` (1×1 path squares with a 4-module quiet zone), camera helpers `cameraSupport`/`cameraConstraints`/`classifyCameraError`/`stopStream`, `loadQrDecoder` (native BarcodeDetector `qr_code` else lazy `@zxing/browser` canvas decode).
  - `apps/web/src/components/player/qr-scanner.tsx` (CREATE): M02 full-height ModalSheet. The camera starts only on "Allow camera access" and needs a secure context. States: idle placeholder, starting, scanning with an aiming frame and wrong-origin/invalid guidance (scanning continues, no navigation), recognized (`onPin` once), and failed (denied/no camera/unavailable/insecure/unsupported) with manual PIN. Tracks stop on success, Stop camera, switching camera, close, unmount, and on a stream that arrives late after close.
  - `apps/web/src/components/host/qr-dialog.tsx` (CREATE): `useQrSvg` (keyed by value), `joinLinkFor`, `QrCodeImage` (black on white SVG, forced colors off, max 320 px, same-size loading/error placeholder), `QrDialog` M07 (QR + link + PIN + Copy link). States: empty, loading, ideal, partial (no clipboard), and error (QR failed while link/PIN stay). A failed copy selects the link for manual copy. `QrEnlargeButton` is the lobby trigger.
  - `apps/web/src/lib/qr.spec.ts` (CREATE): 13 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/lib/qr.spec.ts`: 13/13. Covers a leading-zero PIN, foreign-origin and script/data URL rejection, a visual roundtrip (drawn SVG path rasterized, then ZXing decode, then PIN `012345`) with the quiet zone checked, and track teardown on success/stop/close/unmount/switch/late stream. Five repeated runs were stable.
  - Full web suite: 223/223 across 21 files. Lint, typecheck and `prettier --check` are clean. Build succeeded.
  - Chromium end-to-end on a temporary page (since restored):
    - The M07 dialog rendered in light desktop and dark mobile, with the QR at 320×320 and a white quiet zone in dark mode.
    - A screenshot of the rendered QR was fed as a Y4M fake camera into M02. Native BarcodeDetector was absent, so the lazy ZXing path ran. Result: `PIN: 012345` with status "QR code recognized…", `video.srcObject` null, and no console errors.
    - With the fake camera pattern the live preview showed. "Stop camera" changed the track from `live` to `ended`.
    - With no camera, the alert "No camera found. Enter the PIN instead." appeared, and the manual entry callback fired.

## TASK-132 — 2026-11-08T15:22:57+07:00

- **Files**:
  - `apps/web/src/components/ui/public-shell.tsx` (CREATE):
    - `usePublicConfig`: `/system/public-config`, abortable, with retry.
    - `SkipLink`, `monogramOf`.
    - `BrandMark`: square self-hosted mark plus the instance name, which wraps. A logo failure before or after hydration falls back to a monogram.
    - `ThemeMenu`: system/light/dark via the existing ThemeProvider.
    - `SiteFooter`: attribution, About, code license, third-party notices, language guide and the music credits `CreditsButton`.
    - `displayName`.
    - `PublicShell`: skip link; header with logo → `/`, Join a game → `/join`, Sign in → `/login`, LocalePicker and ThemeMenu; `main#main-content`; footer; error banner with Try again while static content stays usable.
  - `apps/web/src/components/ui/dashboard-shell.tsx` (CREATE, supporting). Next.js layout files may only export the layout, so the testable shell lives in a component.
    - Exports `DASHBOARD_NAV`, `navItemsFor` (creator: Quizzes/Media/Reports/About; superadmin adds Settings/Users), `isActivePath`, `loginHref` (safe `returnTo`) and `DashboardShell`.
    - `RequireAuth` shows only "Loading…" until the session check ends.
    - Anonymous visitors are sent with `router.replace` to `/login?returnTo=…`.
    - On reauth the page stays mounted but inert, with a focused "Sign in again" alert.
    - Sidebar: 224 px sticky on desktop, a disclosure Menu on mobile. It closes on Escape (focus returns to the button) and on navigation; `aria-current` marks the active page; About and the credits live in the sidebar.
    - Header: LocalePicker and a profile menu (theme and Sign out → `/login`).
  - `apps/web/src/app/(dashboard)/dashboard/layout.tsx` (CREATE): `DashboardShell` with noindex metadata.
  - `apps/web/src/app/(dashboard)/dashboard/page.tsx` (CREATE): server `redirect("/dashboard/quizzes")` as a fallback.
  - `apps/web/src/components/ui/shells.spec.tsx` (CREATE): 10 tests.
  - Supporting changes:
    - `apps/web/src/app/layout.tsx`: mount `ThemeProvider` between the locale and auth providers, so the shells' theme controls work and no route group remounts providers.
    - `apps/web/next.config.ts`: `redirects()` returns a 307 for `/dashboard` → `/dashboard/quizzes` before rendering. A page-level redirect inside the protected layout would only fire after the client-side auth check.
    - `apps/web/src/components/common/CreditsModal.tsx`: optional `className` on `CreditsButton`, so the footer trigger matches the footer links.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/ui/shells.spec.tsx`: 10/10, three repeated runs stable. Covers landmarks and skip link; header and legal footer; loading → ideal instance name; empty name → "Kabuki Neko"; missing logo → monogram; long wrapping names; error banner with retry; theme change without remount; credits from the footer (hostile markdown never becomes a script or link; Escape returns focus); no protected flash during the session check; creator vs superadmin navigation; a creator directly opening an admin URL; anonymous redirect with an encoded safe `returnTo`; mobile menu toggle/Escape/navigation close; profile menu theme and sign out; inert page with a focused sign-in prompt after revocation.
  - Full web suite: 233/233 across 22 files. Lint, typecheck, `prettier --check` and build all pass.
  - Chromium against `next start` with the API faked through Playwright routes and temporary probe pages (since removed):
    - `/dashboard` returns HTTP 307 to `/dashboard/quizzes`.
    - Superadmin desktop shows the sidebar with Settings/Users.
    - On a 360 px creator view, a long instance name and a long user name wrap.
    - The dark mobile menu opens.
    - Public desktop renders; on dark mobile the 503 shows the error banner.
    - An anonymous visitor lands on `/login?returnTo=%2Fdashboard%2Fquizzes` without the library flashing.

## TASK-133 — 2026-11-10T15:09:43+07:00

- **Files**:
  - `apps/web/src/app/page.tsx` (MODIFY): S01 landing inside `PublicShell`.
    - Instance name from the shell's public config. "Kabuki Neko" shows while loading or unknown; long names wrap with hyphenation, and the heading is smaller on mobile.
    - Lead text, "Join a game" → `/join`, "Sign in" → `/login`, and the PIN hint.
    - "Create one" → `/register` only for PUBLIC or INVITE_ONLY (hidden for SINGLE_ADMIN or when unknown).
    - Decorative mascot with a monogram fallback, including when it fails before hydration.
  - `apps/web/src/components/ui/session-fallback.tsx` (CREATE):
    - `FALLBACK_VARIANTS`, `isTerminalVariant`, `fallbackForError` (API/socket code → variant), `describeError` (code plus API correlation ID or server digest, never the message) and `safeReference`.
    - `SessionFallback` (S17): optional logo + language header, h1 and fixed safe message, and per-variant next steps:
      - not found → Home
      - forbidden → Back + Home
      - auth expired → Sign in again with a sanitized `returnTo`
      - room expired / kicked → Join a game + Home
      - replaced → Home + Join a game
      - service → Try again: one at a time, busy "Trying again…", the reason stays visible, and a failure shows "Still not working".
    - Shows a safe reference ID with support guidance. Before the validation/auth/player namespaces load it shows the `common` shell text.
    - `ConnectionBanner`: an inline status for reconnecting/offline/resyncing/lost; Retry only once the connection is lost.
  - `apps/web/src/app/not-found.tsx` (CREATE): `SessionFallback variant="notFound"`, noindex.
  - `apps/web/src/app/error.tsx` (CREATE): Next 16 boundary (`error`, `retry`). Maps the error code to a variant and passes the reference. Retry runs in a transition; a retry within 10 s is remembered across the boundary remount, so a repeated failure says "Still not working".
  - Supporting changes:
    - `apps/web/src/components/ui/public-shell.tsx`: `PublicShellContext` + `usePublicShell`, so the landing reuses the shell's config request. The brand text class now uses the real `text-body` token (`text-body-strong` did not exist).
    - `apps/web/src/components/ui/session-fallback.spec.tsx` (CREATE): 10 unit tests.
- **Verification**:
  - DoD browser assertions (`scratchpad/fallback-shot.cjs`, Chromium against `next start`, API faked via Playwright routes, temporary probe page since removed) all PASS:
    - S01 ideal at 320 px: a long instance name wraps, every control is ≥ 44 px, no horizontal overflow, Tab reaches the skip link first.
    - S01 offline: 503 shows the banner while the heading and CTAs stay; Try again recovers the instance name (2 requests).
    - S01 with the brand mark and mascot returning 404: both monograms are shown.
    - 404: HTTP 404, safe text that does not echo the path, Go to home.
    - kicked / roomExpired / replaced / authExpired: guidance, a manual next step, the reference ID, and no automatic navigation within 2.5 s.
    - Error boundary: an ApiError FORBIDDEN maps to the no-access text with its reference. A generic error hides its message, and a failed retry shows "Still not working" with the reason kept.
  - `session-fallback.spec.tsx` 10/10 and `shells.spec.tsx` 10/10 (two repeated runs).
  - Full web suite: 243/243 across 23 files. Lint, typecheck, `prettier --check` and build all pass.

## TASK-134 — 2026-11-10T15:18:56+07:00

- **Files**:
  - `apps/web/src/components/auth/public-auth-forms.tsx` (CREATE): F01 `PublicAuthForms({ mode, returnTo, onAuthenticated, onStepChange })`.
    - Helpers: `useSetupStatus` (`/auth/setup-status` with retry), `issueMessageKey` (server and zod codes → `validation.errors.*`), `validateFields` (shared request schemas, with required-first ordering), `serverFieldErrors` (maps `details[].path` to fields).
    - Internal pieces: `useSummaryFocus` (focuses the error summary in an effect, so it never steals focus later), `ErrorSummary` (a role=alert list linking to each field), `FormNotice`, and `PasswordField` (shared 12–128 policy shown as a range, a counter, and the range appended to the error).
    - LoginForm:
      - `username`/`current-password` hints; one request while pending; `acceptSession` → `onAuthenticated(safeReturnTo(returnTo))`.
      - INVALID_CREDENTIALS keeps the email and clears only the password.
      - SETUP_REQUIRED links to setup; network errors give the s03 error with entries kept.
      - The register link appears only when registration is open.
    - RegisterForm by policy:
      - SINGLE_ADMIN or REGISTRATION_CLOSED → closed state with Sign in.
      - PUBLIC → no invite field, and the body never carries `inviteCode`.
      - INVITE_ONLY → invite code required (trimmed, `one-time-code`).
      - EMAIL_EXISTS / INVITE_UNAVAILABLE → field error plus s04 partial.
      - OPERATION_COMPLETED_REAUTH_REQUIRED → sign-in notice.
      - An uncertain outcome gives the "check status" notice and keeps the same Idempotency-Key; a definitive failure creates a new key.
    - SetupForm:
      - Two local steps with a step list (`aria-current="step"`) and the heading focused on each step change; Back keeps values.
      - A single POST at the end with an Idempotency-Key.
      - SETUP_COMPLETE or a completed replay → race state with Sign in.
      - An uncertain outcome checks setup-status: initialized → Sign in; otherwise the s02 error with entries kept.
      - Already initialized → the alreadyInitialized message.
    - A status load failure shows the alert with Try again.
  - `apps/web/src/components/auth/public-auth-forms.spec.tsx` (CREATE): 13 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/auth/public-auth-forms.spec.tsx`: the full web suite runs, 256/256 across 24 files. The auth spec is 13/13 over five runs, stable after replacing rAF focus with effect focus.
  - Five states per mode:
    - Login: empty instructions; loading "Signing in…"; ideal "You're signed in." and returnTo; partial INVALID_CREDENTIALS; error on network failure.
    - Register: loading "Checking registration settings…"; empty when closed; ideal on success; partial when the invite is used; error on an uncertain outcome.
    - Setup: loading "Checking setup status…"; empty intro; ideal "Setup complete…"; partial on race; error with entries kept.
  - Also covered: policy closed / PUBLIC without inviteCode / INVITE_ONLY required; setup race; uncertain outcomes reconciled through status; one setup request despite a double press; Idempotency-Key reuse rules; autocomplete hints and `user.paste`; summary focus and its links to fields; server `details` mapping; the password policy range; no localStorage or sessionStorage writes.
  - Lint, typecheck, `prettier --check` and build all pass.

## TASK-135 — 2026-11-10T15:42:43+07:00

- **Files**:
  - `apps/web/src/app/(auth)/setup/page.tsx`, `login/page.tsx`, `register/page.tsx` (CREATE): server pages that mount the shared F01 forms inside `PublicShell`.
    - Each has a localized `<title>` via `generateMetadata` (for example "Sign in · Kabuki Neko") and noindex.
    - `/setup` asks `/auth/setup-status` without caching and redirects an initialized instance to `/login` before rendering.
    - Only the raw `returnTo` string crosses to the client.
  - Supporting files:
    - `apps/web/src/app/(auth)/auth-route.tsx` (CREATE, client): silent session check that shows only a loading status meanwhile. A live session goes to `safeReturnTo(returnTo)`; anonymous or reauth visitors get `PublicAuthForms`.
    - `apps/web/src/app/(auth)/auth-metadata.ts` (CREATE, server): `authMetadata`, `fetchSetupStatus` (internal URL, no-store, 1.5 s timeout) and `returnToFrom`.
    - `apps/web/src/lib/i18n/locale.server.ts`: `serverTranslator(request, namespaces)` for server-side titles, using the same locale resolution as the layout with an `en` fallback.
  - `tests/e2e/auth.spec.ts` (CREATE): 3 serial flows against the real API and the web app.
    - Two tabs race the setup; exactly one SUPERADMIN and one account exist; `/setup` then redirects to `/login`.
    - A wrong then a right password returns to `returnTo`; a live session skips the form; an unsafe `returnTo` goes to the dashboard; logout shows the form again.
    - Registration policies SINGLE_ADMIN (closed) / INVITE_ONLY (one-time code, reuse rejected, entries kept) / PUBLIC (no code), ending with users 3, SUPERADMIN 1, CREATOR 2.
    - No password or JWT appears in storage or HTML.
    - Each browser context gets its own `X-Forwarded-For` address.
  - `playwright.config.ts` (MODIFY, supporting; the original design is kept):
    - API: dependencies + API build; consistent `NEXT_PUBLIC_*`/`APP_URL` (required by `APP_URL === NEXT_PUBLIC_APP_URL`); `TRUST_PROXY_CIDRS` loopback, so per-IP auth limits apply per simulated client.
    - Web: `API_INTERNAL_URL`; production `next build` + `next start` instead of `next dev`. Dev mode writes `.next/dev/types`, whose global `LayoutProps` duplicates `.next/types` and breaks later `next build`/`tsc`.
    - `locale: en-US`; optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; `KABUKI_E2E_API_URL`.
  - Bug fixes found by E2E (supporting):
    - `apps/web/src/lib/refresh-coordinator.ts` + `apps/web/src/providers/auth-provider.tsx`: under StrictMode, effect cleanup closed the BroadcastChannel, and `postMessage` on the closed channel turned every successful refresh into "uncertain". Live sessions were then never restored after a reload. Fix:
      - Broadcasts are best effort.
      - The channel can be a factory, and `close()`/`reopen()` are bound to the provider effect.
      - A regression test was added in `auth-provider.spec.tsx`.
    - `apps/web/src/components/ui/modal-sheet.tsx`: `getServerSnapshot` returned a new array per call (React "should be cached" warning); it is now a constant.
  - `apps/web/src/components/auth/public-auth-forms.tsx`: the password range `(12–128)` is appended only to length errors, not to "required".
  - `docs/vibe/00-project-context.md`: the E2E row now describes the production build and the optional Chromium executable.
- **Verification**:
  - `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e -- tests/e2e/auth.spec.ts`: 3/3 PASS, four times (twice with `next dev` before switching, twice with the production build). The final run was 53.7 s with no WebServer warnings, and no `.next/dev` was left behind.
  - Web suite: 257/257 across 24 files. Lint, typecheck, `prettier --check` and build PASS. E2E files type-check with strict `tsc`.
  - Visual check in Chromium (production build) in Indonesian, the instance default:
    - Setup step 2 with error summary and field errors.
    - Login on dark mobile with the wrong-password notice.
    - Register on 360 px with the summary and no horizontal overflow.

## TASK-136 — 2026-11-10T15:47:34+07:00

- **Files**:
  - `apps/web/src/components/ui/confirm-dialog.tsx` (CREATE):
    - `confirmResultFromError`:
      - NOT_FOUND → missing.
      - FORBIDDEN and the 409 conflicts (MEDIA_IN_USE, LAST_SUPERADMIN, REVISION_CONFLICT, ROOM_ACTIVE, RESOURCE_BUSY, FINALIZATION_PENDING, OPERATION_PENDING, INVITE_UNAVAILABLE) → blocked with a safe reason.
      - Other definite errors → failed with reason and reference.
      - Uncertain or non-API errors → null, meaning "reconcile first".
    - `useConfirmAction({ run, onDone, reconcile })`:
      - The parent owns the operation: closing never cancels it, reopening shows it still pending, and `onDone` fires once on real success even after the dialog was closed.
      - Single flight.
      - An ambiguous outcome is only done when `reconcile()` says "done"; otherwise it stays an error with the "couldn't confirm" text.
    - `ConfirmDialog` (M09, ModalSheet):
      - Title "Confirm action", the impact as description, "Affected item: {name}" (long names wrap), and a specific CTA (danger by default).
      - Cancel has the initial focus; pending shows "Confirming…".
      - Empty state (no target or 404): Close only.
      - Partial (blocked): reason, Close only.
      - Error: retry plus a safe reference ID.
  - `apps/web/src/components/studio/unsaved-dialog.tsx` (CREATE): `UnsavedDialog` (M10) driven by `useUnsavedChanges`.
    - Stacked Stay (initial focus) / Discard / Save and continue.
    - "Saving, then continuing…" while saving; a failed save shows the error and keeps the dialog and the draft, so navigation stays blocked.
    - An incomplete-draft note; Escape means stay.
  - `apps/web/src/components/ui/confirm-dialog.spec.tsx` (CREATE): 9 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/ui/confirm-dialog.spec.tsx` runs the full suite: 266/266 across 25 files. The spec itself is 9/9 over three runs.
  - Covered: keyboard (Cancel focus, Tab trap, Escape with focus return, Enter on the CTA); pending close and reopen with a single run and `onDone` after close; blocked MEDIA_IN_USE reason, failed with "Reference ID: ref-500", uncertain with reconcile unknown → not success, 404 → empty with Close; reconcile "done" → success; null target → empty; question-type change: Cancel keeps QUIZ, confirm applies TRUE_FALSE; M10: clean → direct navigation, failed save blocks navigation and keeps the draft, then a successful save continues, Stay/Escape/Discard.
  - Lint, typecheck and prettier pass.
  - Chromium visual check at 360 px using a temporary probe (removed): M09 ideal (light), M09 blocked (dark), M10 with the failure and incomplete note (stacked buttons).

## TASK-137 — 2026-11-10T15:56:43+07:00

- **Files**:
  - `apps/web/src/components/studio/QuizSettingsModal.tsx` (CREATE): M03.
    - Helpers:
      - `useLobbyTracks`: the packaged audio manifest's lobby tracks, also handed to the audio manager; or the given tracks.
      - `bgmOptions`: "Random lobby music" first, then the manifest tracks, then a kept unknown or legacy id labelled "Random lobby music (<id>)".
    - Fields:
      - title: required, 150 chars, shared schema;
      - description: textarea, 5000;
      - cover: preview, "Choose cover" via `onChooseCover(select)` for the M05 picker, "Remove cover", and a failed image switches to the partial message;
      - visibility: radio, default PRIVATE;
      - background music: select plus a Preview/Stop toggle on the audio-manager singleton.
    - Preview behaviour: one at a time; it stops on track change, submit, close and unmount; legacy/Random cannot be previewed.
    - Create: `POST /quizzes` with an Idempotency-Key. A lost response is reconciled with `reconcileOperation(key, "quiz.create")` and `GET /quizzes/:id`, so no second create happens. Errors keep entries; server title issues map to the field.
    - Edit: `onApply(values)` only (draft, not saved).
  - `apps/web/src/components/host/host-config-dialog.tsx` (CREATE): M06 `HostConfigDialog`.
    - Shows the title and the pluralized question count.
    - Display mode: vertical radios with descriptions, default PROJECTOR.
    - Friendly nicknames: checkbox, default off.
    - Empty (0 / unplayable): note plus an Edit link to the studio, no Open lobby button.
    - Dirty: partial note and Open lobby soft-disabled.
    - Sending: `host:create_room` once (single flight).
      - ok → `onCreated`.
      - error → a new request id; REVISION_CONFLICT → save note; QUIZ_NOT_PLAYABLE → empty; others → error with reference.
      - unknown ACK → `reconcileRoom(requestId)` (default `api.reconcileOperation(…, "room.create")`); done → `onCreated({sessionId, pinCode:null})` with no re-send; otherwise the error state with Try again re-sending the same request id (server dedup → one room).
  - `apps/web/src/components/host/host-config-dialog.spec.tsx` (CREATE): 9 tests (6 for M06, 3 for M03).
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/host/host-config-dialog.spec.tsx` runs the full suite: 275/275 across 26 files. The spec is 9/9 over three runs with no act warnings.
  - Covered for M06: zero questions and unplayable (no emit); dirty blocks; stale revision gives a new id on retry; double submit makes one emit; a lost ACK is reconciled, then retried with the same id for one room; reconciled done means no re-send; CAPACITY_REACHED shows the error with a reference. The five states are all covered.
  - Covered for M03: Random plus the tracks; no overlapping previews; preview stops on change, close and submit; a legacy id is kept and not previewable but applied to the draft; create body and key; a lost response reconciled to the created quiz with a single POST; error keeps entries.
  - Lint, typecheck (after rebuilding `.next/types`), prettier and build PASS.
  - Chromium visual check using a temporary probe, since removed:
    - M03 edit at desktop size with the legacy track option;
    - M06 at 360 px, dark, after a lost ACK and failed reconciliation, showing the error and Try again;
    - M06 dirty at 360 px.

## TASK-138 — 2026-11-10T16:04:30+07:00

- **Files**:
  - `apps/web/src/components/studio/quiz-library-detail.tsx` (CREATE): F02 library (S05).
    - Helpers: `parseLibraryQuery` (scope own/public, page clamped to PAGING.maxPage, search 100 chars, sort) and `libraryHref` (defaults omitted).
    - `QuizLibrary({ query, onQueryChange, navigate, createRoom?, onImport? })`:
      - Header with Import (via `onImport`, disabled until the dialog lands) and Create (M03, then `/studio/:id`).
      - Scope tabs, search form (role=search), sort select.
      - Cards (ContentCard) with title link to the detail, cover with fallback, question count (plural), visibility, last saved, owner on public scope, an invalid-draft notice and "Read only".
      - Capability actions: Host (playable → M06 with a short-lived host socket via `createGameSocket`; invalid → detail page), Edit link, menu with Duplicate (POST with Idempotency-Key; a lost response is reconciled via `quiz.duplicate`, then the studio opens) and Delete (M09 via `useConfirmAction`: `If-Match` revision, reconcile by GET where 404 = deleted, `onDone` re-fetches).
      - Pagination is shown only for more than one page; an out-of-range page is clamped through `onQueryChange`.
      - Requests: `createLatestRequest` (stale responses dropped, aborted on unmount) and a version counter re-fetches after mutations.
      - States: loading skeleton grid; empty (own: create CTA; search: "No quizzes match" + Clear search); ideal; partial (refresh failed: "May be out of date" + retry, list kept); error (StatusNotice with reference + retry).
    - `QuizLibraryRoute` reads the query from params and pushes changes into the URL.
  - `apps/web/src/app/(dashboard)/dashboard/quizzes/page.tsx` (CREATE): the server page passes the first values of `scope/page/search/sort` to `QuizLibraryRoute`.
  - Supporting: `apps/web/src/providers/auth-provider.tsx` adds `getAccessToken()` (in-memory token getter) to the auth context for the game-socket handshake.
  - `apps/web/src/components/studio/quiz-library-detail.spec.tsx` (CREATE): 8 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/quiz-library-detail.spec.tsx` runs the full suite: 283/283 across 27 files. The spec is 8/8 over three runs with no act warnings.
  - Covered: loading skeleton then cards and the 12-per-page query; owner controls (Host / Edit / menu Duplicate+Delete); public read-only (no Edit/Delete, owner shown, read-only note); invalid draft Host goes to the detail page; empty own vs. empty search (Clear search) vs. error with reference and retry; delete with `If-Match "3"` removes the card through a re-fetch; REVISION_CONFLICT is blocked, not a success; a failed refresh after a delete gives the partial "May be out of date" with the list kept; stale responses after a scope change are dropped; pagination Next sends page 2 and page 5 of 3 is clamped to 3; duplicate opens the studio with an idempotency key; Host opens M06 and then `/host/:sessionId`; URL helpers.
  - Lint, typecheck, prettier and build PASS.
  - Chromium against `next start` with a route-faked API:
    - desktop owner grid with pagination;
    - 360 px dark public read-only view (horizontal overflow fixed from 6 px to 0 by making the search form fluid);
    - empty library.

## TASK-139 — 2026-11-10T16:09:57+07:00

- **Files**:
  - `apps/web/src/components/studio/quiz-detail.tsx` (CREATE): S06 `QuizDetailView({ quizId, navigate, createRoom?, save? })` plus `QuizDetailRoute`; helpers `exportFallbackName` (`<id>.kabukineko.json`) and `issueQuestionIndex`.
    - Loads `GET /quizzes/:id` (abortable). 404 and 403 show a single fixed "This quiz isn't available…" message with no title or owner; other errors show the s06 error with reference and retry.
    - Content: cover (placeholder when missing or broken), title (wraps), owner, visibility, plural question count, description (pre-line), and ordered questions (position · localized type · time limit in seconds via Intl unit · prompt, or "Nothing here yet").
    - Capability actions:
      - Edit link.
      - Duplicate: shared `duplicateQuiz` with reconcile; pending, failed or uncertain stays visible.
      - Download JSON: `api.download` + `saveBlob` with the server filename; an empty Blob or a failure gives "The export failed…", never success; "Preparing download…" while pending.
      - Delete: M09 with `If-Match`, reconciliation by GET (404 = done), then back to the library.
      - Host: M06 over a short-lived host socket; disabled with a reason for invalid or empty drafts.
    - Invalid draft: issue region "Slide n of N: <message>". Empty quiz: s06.empty plus the owner's Edit CTA.
  - `apps/web/src/app/(dashboard)/dashboard/quizzes/[quizId]/page.tsx` (CREATE): a non-UUID id goes to `notFound()`; otherwise the lower-cased id is passed to `QuizDetailRoute`.
  - Supporting: `apps/web/src/components/studio/quiz-library-detail.tsx` now exports `duplicateQuiz(api, quizId)` (Idempotency-Key + `quiz.duplicate` reconcile), reused by the library and the detail.
  - `apps/web/src/components/studio/quiz-detail.spec.tsx` (CREATE): 9 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/quiz-detail.spec.tsx` runs the full suite: 292/292 across 28 files. The spec is 9/9 over three runs with no act warnings.
  - Covered:
    - Loading, then the ideal owner view with ordered questions ("1 · Single choice · Time limit: 20 sec").
    - Public read-only: no Edit or Delete.
    - Hidden 404 and forbidden 403 show a fixed message without the title or a retry.
    - A 500 shows the error with a reference, and retry loads.
    - An empty quiz shows the owner CTA with Host disabled.
    - An invalid draft lists "Slide 2 of 2: The question needs text." with Host disabled.
    - A broken cover falls back to the placeholder.
    - Export: pending, then save with the server filename; a 500 or an empty Blob gives the failure message and save is not called again.
    - Duplicate opens the studio, and a 403 shows the failure.
    - Delete sends If-Match "5" and navigates to the library.
    - Helpers.
  - Lint, typecheck, prettier and build PASS.
  - Chromium against `next start` with a route-faked API: owner detail on desktop, invalid draft on 360 px in dark mode (issue list, Host disabled), and the 404 state. No horizontal overflow. The Host button was kept on one line with `shrink-0`.

## TASK-140 — 2026-11-10T16:17:00+07:00

- **Files**:
  - `apps/web/src/components/studio/import-export.tsx` (CREATE): M04/F07.
    - Helpers:
      - `detectFormat` (`.json`/`.csv`).
      - `parseCsvRows`: RFC 4180 with quotes, doubled quotes, CRLF/LF and BOM; never evaluates cells.
      - `referencedMedia`: the JSON `media` list or the CSV `media_ref` column, with UUIDs only, de-duplicated and capped at 201.
      - `issueLocation`: "Row n, column x", otherwise the path.
    - `ImportDialog({ open, onClose, onImported, save? })`:
      - File input (json/csv); unsupported type or more than 5 MiB is rejected before upload. Shows name, format and size.
      - JSON/CSV template downloads via `api.download` + `saveBlob`.
      - Media mapping: one select per reference, limited to the user's own media from `GET /media` of the same kind, sent as the `mediaMap` JSON field.
      - `POST /quizzes/import` (multipart `file` + optional `mediaMap`) with an Idempotency-Key, single flight, 60 s timeout. Success opens the studio through `onImported`.
      - 422 and other problems: up to 200 listed with location and message, plus the total (`params.actual`) and the atomic-failure note; the summary is focused.
      - Uncertain outcome: `reconcileOperation(key, "quiz.import")`. done → load the quiz and open it; not-received → retry with the same key; pending or unknown → error with a "check again" action.
      - States: empty, loading, ideal, partial, error.
  - `apps/web/src/components/studio/quiz-library-detail.tsx` (MODIFY): Import opens `ImportDialog`; a successful import invalidates the list and navigates to `/studio/:id`; `onImport` can replace the dialog.
  - `apps/web/src/components/studio/import-export.spec.tsx` (CREATE): 10 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/import-export.spec.tsx` runs the full suite: 302/302 across 29 files. The spec is 10/10 over three runs with no act warnings.
  - Covered:
    - empty → loading (single flight, FormData file, no mediaMap, key) → ideal;
    - .txt and over-5 MiB files rejected client-side;
    - 422 row/column problems with "250 problems found", the atomic note and focus;
    - MALFORMED_CSV and UNSUPPORTED_IMPORT_VERSION messages;
    - missing media: mapping limited to owned images; an unmapped reference shows the server location; then `mediaMap` `{ref: ownedId}` succeeds;
    - lost response: an unknown lookup gives the error; "check again" returns not-received, and the resend uses the same Idempotency-Key and succeeds; a reconciled done opens the quiz without a resend;
    - CSV template download with the server filename;
    - helpers, and the library Import button opening the dialog.
  - Lint, typecheck, prettier and build PASS.
  - Chromium at 360 px through the library with a route-faked 422: problem list scrollable in the sheet, summary focused. Copy was tidied: count and atomic note on separate lines, no duplicated generic sentence.

## TASK-150 — 2026-11-10T16:22:46+07:00

- **Scope note**: Started ahead of TASK-141–149 at the user's request: guest players (join without an account, PRD role PLAYER) were prioritized. Its only unfinished dependency, TASK-149 (About page), is an ordering link, not a technical prerequisite. The technical dependencies TASK-123 (avatar) and TASK-079 (game API) are done.
- **Files**:
  - `apps/web/src/components/player/avatar-customizer.tsx` (CREATE): `AvatarCustomizer` (M01/F12) plus helpers `styleName`, `nicknameProblem` and `DICE_SOUND_THROTTLE_MS`.
    - Join mode:
      - Avatar: 128 px preview and a 2-column radio grid of the six DiceBear styles with 40 px previews.
      - Dice: `randomAvatarSeed` plus a `nekoPop` cue through the audio manager singleton. The first press unlocks audio; cues are throttled to 150 ms; no sound object is created per render.
      - Nickname: `FormField`, 15-grapheme limit with counter, shared `nicknameSchema`, `autocomplete=nickname`. Friendly rooms instead show a read-only server name from `player:request_friendly_name` plus a ticket.
      - Join: `player:join_room` with a single-flight complete identity. On ok, the room-scoped credentials are stored with `savePlayerSession` and `onJoined` is called.
      - Lost ACK: the error notice is shown and the same `requestId` is reused.
      - Definitive errors get a new id. NICKNAME_TAKEN, NICKNAME_FORBIDDEN and NICKNAME_INVALID become field errors (taken also shows the partial note and clears the ticket). Room codes (full, locked, in progress, not found, expired, lost) show the error with Back.
      - Recovery props send `sessionId` + `sessionToken`, never the nickname.
    - Edit mode (lobby): avatar only; `player:update_avatar`; a failure reverts the preview to the saved avatar with the f12 error; outside LOBBY the controls are disabled and an `invalidPhase` note is shown.
  - `apps/web/src/components/player/avatar-customizer.spec.tsx` (CREATE): 7 tests.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/player/avatar-customizer.spec.tsx` runs the full suite: 309/309 across 30 files. The spec is 7/7 over three runs with no act warnings.
  - Covered:
    - six styles named and selectable;
    - a "😺Ñeko 小猫" nickname joins (empty → loading → ideal), with storage keys written;
    - local rejection of empty and 16-character names, while 15 family emoji are accepted;
    - dice re-rolls with the cue played once and unlock called once;
    - friendly name and ticket, then taken (partial), then a new name joins;
    - forbidden keeps fields; full room shows the error and Back; a lost ACK retries with the same request id while definitive errors get new ids;
    - recovery sends the token without a nickname and the server nickname is kept;
    - lobby edit: avatar-only payload, revert on failure, disabled outside the lobby.
  - Lint, typecheck (after a build to refresh `.next/types`), prettier and build PASS.
  - Chromium using a temporary probe (removed): join at 360 px light with the taken error and the 8/15 counter for the Unicode name; friendly at 360 px dark; lobby edit on desktop. No overflow, and all 7 avatar images rendered.

## TASK-151 — 2026-11-10T20:26:51+07:00

- **Scope note**: Part of the user-prioritized guest player flow (players join without an account). Dependencies TASK-150 and TASK-131 are done.
- **Files**:
  - `apps/web/src/components/player/pin-join-scanner.tsx` (CREATE): S14/F11 `PinJoinScanner` and `normalizePin`.
    - Input: one `inputmode=numeric` field; digits only, so leading zeros and pasted separators are handled ("000 123" → "000123").
    - `player:check_pin` runs over an anonymous player socket.
    - A deep link is checked exactly once (a ref guard that holds under StrictMode).
    - The QR scanner (M02) is wired to check once on a recognized PIN; "Enter the PIN instead" returns focus to the PIN field.
    - Errors:
      - unknown PIN → `invalidPin` (aria-invalid, never polled);
      - locked / full / in progress → specific guidance;
      - RATE_LIMITED → "Try again in N seconds" with Join soft-disabled until `retryAfterMs`;
      - unknown or offline → s14 error with Try again.
    - Recovery: credentials stored for the PIN offer "Rejoin your game" (also while GAME_IN_PROGRESS) using a recovery `player:join_room` bound to that sessionId. Dead credentials (INVALID_SESSION_TOKEN, KICKED, REPLACED, room gone) are cleared and lead to a new identity.
    - Identity uses the TASK-150 `AvatarCustomizer`; after joining, the player is sent to `/play/<pin>`.
  - `apps/web/src/components/player/join-route.tsx` (CREATE, supporting): client route wrapper with `router.push`.
  - `apps/web/src/app/(public)/join/page.tsx` (CREATE): PublicShell plus `JoinRoute`; `?pin` (first value, at most 32 chars) passed through; localized title via `serverTranslator(["player"])`.
  - `tests/e2e/join.spec.ts` (CREATE): real-stack E2E.
    - Setup: admin by setup or login, a playable quiz (POST plus PUT with a complete single-choice question), and two rooms via a socket.io host (normal and friendly).
    - Flows: leading-zero PIN with no polling, deep-link once, guest join, duplicate nickname, friendly join, locked room, loading/error via swallowed check frames, camera denied, foreign QR. The flows stay within CHECK_JOIN of 10 per minute per IP.
  - Supporting changes:
    - `apps/web/src/components/ui/modal-sheet.tsx`: optional `returnFocus` ref.
    - `apps/web/src/components/player/qr-scanner.tsx`: passes `returnFocus`.
    - `apps/web/src/components/player/pin-join-scanner.spec.tsx` (CREATE): 8 unit tests.
- **Verification**:
  - DoD `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm exec playwright test tests/e2e/join.spec.ts`: 6/6 PASS against the API (SQLite) and the production web build.
    - PIN 000123 kept, with one check frame only.
    - The deep link sends one check frame.
    - The guest join reaches `/play/<pin>`; localStorage holds the session id and no JWT.
    - The duplicate nickname is rejected with the field kept.
    - The friendly room joins with a server-picked name.
    - A locked room shows the partial guidance.
    - Loading "Checking…" with the input disabled, then the error with Try again after the 5 s ACK timeout.
    - Camera denied falls back to manual entry with focus on the PIN field.
    - A foreign QR (Y4M fake camera) is refused with no navigation.
  - Full `pnpm test:e2e` (auth + join): 9/9 PASS. The only server warning is `next start` with `output: standalone`, which TASK-175 addresses with the standalone runtime.
  - Unit: `pin-join-scanner.spec.tsx` 8/8 (stable over three runs). Web suite 317/317 across 31 files. Lint, typecheck, prettier and build PASS; the E2E files type-check with strict tsc.
  - Chromium check of `/join` at 360 px in light and dark (offline error state): no overflow.

## TASK-152 — 2026-11-10T20:31:17+07:00

- **Scope note**: Part of the user-prioritized guest player flow. Dependencies TASK-151 and TASK-128 are done.
- **Files**:
  - `apps/web/src/components/player/connection-recovery.tsx` (CREATE): F17 `ConnectionRecovery({ role, store, sessionId, nextRetryInSec?, outage?, authExpired?, onRetry, onLeave, storage?, children })` and the pure `recoveryView(state, flags)`.
    - empty (no credentials): join link.
    - connecting (first sync): status only, the screen is not rendered.
    - lost (no snapshot): error with Retry and Go to home.
    - live: children plus a sr-only "Connected".
    - stale (reconnecting with the backoff seconds, catching up after a sync request, state-store outage, lost after a snapshot): a sticky banner (status, or alert for outage/lost) with Retry/Leave; children kept visible but `inert` + aria-busy, so answer and host controls are locked. A pending submission says "Sending your answer… Catching up with the game…" and is never shown as accepted.
    - terminal (KICKED / SESSION_REPLACED incl. invalid token / ROOM_EXPIRED / ROOM_LOST): S17 SessionFallback (`chrome={false}`). Player credentials are cleared exactly once and nothing reconnects.
    - auth (host sign-in expired): authExpired fallback.
  - `apps/web/src/components/player/connection-recovery.spec.tsx` (CREATE): 7 tests with a real `createGameStore`.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/player/connection-recovery.spec.tsx` runs the full suite: 324/324 across 32 files. The spec is 7/7 over three runs.
  - Covered:
    - empty, connecting and live (controls usable);
    - reconnecting "(4 sec)" with stale content inert, Retry and Leave;
    - catching up after a sync request, still locked;
    - outage alert "The game service is temporarily unavailable…" with controls locked;
    - pending answer not shown as accepted;
    - lost before and after the first sync;
    - terminal kicked / replaced / lost: storage cleared once (record and PIN pointer), no further removals or retries after state changes;
    - host auth expired asks to sign in again;
    - `recoveryView` derivation.
  - Lint, typecheck (after a build refresh), prettier and build PASS.
  - Chromium at 360 px with a temporary probe (removed): reconnecting banner over the dimmed, locked lobby (dark), and the kicked fallback (light).

## TASK-153 — 2026-11-10T20:36:44+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/player/choice-answer-pad.tsx`: ChoiceAnswerPad, AnswerShape, ChoiceType, ChoiceOption, PadStatus.
  - `CREATE` `apps/web/src/components/player/choice-answer-pad.spec.tsx`: 6 tests.
- **Notes**: Single, true/false and poll answers send on the first tap. Multiple select toggles options and sends them with "Submit answer (n)"; with nothing chosen it shows "Choose an answer first." The accessible name always carries the letter, shape symbol and option text. Projector rooms show shapes first and offer a show/hide text toggle; Streamer rooms always show the text. Input locks while submitting, after acceptance, after closing, during grace and while offline. The pad never shows correctness or a key count. A new question resets the selection.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/player/choice-answer-pad.spec.tsx` → 33 files / 330 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a temporary probe (deleted afterwards): single-choice accepted at 360px light, multiple select at 360px dark with focus and selection, projector shape-first, true/false at 1024px dark, grace "Time's up.". No horizontal overflow.

## TASK-154 — 2026-11-10T20:45:20+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/player/text-answer-pad.tsx`: TextAnswerPad, parseTextAnswer, isComposingEnter, TextAnswerProblem.
  - `CREATE` `apps/web/src/components/player/puzzle-answer-pad.tsx`: PuzzleAnswerPad, isPuzzleOrder, moveEntry.
  - `CREATE` `apps/web/src/components/player/text-puzzle.spec.tsx`: 10 tests.
  - `MODIFY` `apps/web/src/components/player/choice-answer-pad.tsx`: exports AnswerLockState, isAnswerLocked, AnswerStatusLine, SHAPE_SYMBOL and COLOR_CLASS, so all three pads share one lock and status behavior. This is outside the target files but needed to avoid duplicating the lock rules.
- **Notes**:
  - Text pad:
    - The counter counts graphemes and never truncates.
    - The payload is NFC + trim and checked with the shared `textAnswerSchema` (250 graphemes, 8,000 bytes, no controls).
    - Enter never submits during IME composition (`isComposing`, composition events, Safari `keyCode 229`).
    - The field turns read-only when locked and keeps the sent text visible.
  - Puzzle pad:
    - Starts in the server's game order.
    - Letter, shape, color and label follow the item.
    - Move up and Move down buttons are named with the item through aria-labelledby. Focus stays on the moved item's button and the position is announced.
    - A pointer drag handle tracks the gesture with window listeners, so it survives DOM moves.
    - The payload is a frozen copy.
  - Drafts are restored only for the same, still-editable question; puzzle drafts must also be a valid permutation.
  - Locks: submitting, accepted, closed, grace and offline.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/player/text-puzzle.spec.tsx` → 34 files / 340 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a temporary probe (deleted afterwards):
    - Text error and accepted states at 360px, light and dark.
    - Puzzle keyboard move keeps focus on the item; real mouse drag reorders 0,2,1,3 → 2,1,3,0.
    - The 360px two-line row layout was fixed after the first screenshot showed mid-word breaks; 1024px dark also checked.
    - No horizontal overflow.

## TASK-155 — 2026-11-10T20:54:11+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/host/result-chart.tsx`: ResultChart, cuePlan, useCuePlan, STATIC_CUE, CHART_ANIMATION_MS.
  - `CREATE` `apps/web/src/components/player/personal-result.tsx`: PersonalResult, STREAK_CUE_MIN.
  - `CREATE` `apps/web/src/components/host/explanation-dialog.tsx`: ExplanationDialog, LONG_EXPLANATION.
  - `CREATE` `apps/web/src/components/host/result-chart.spec.tsx`: 11 tests.
- **Notes**:
  - Chart:
    - Choice, multiple and poll results are a real table with per-option counts.
    - Bars are scaled to the largest count, with no percentages, so multiple select can exceed the player count.
    - Correct options are marked with a check plus visible text; polls are neutral.
    - TYPE_ANSWER shows the accepted list and ORDER_PUZZLE the correct order, only from the reveal payload.
    - Outcome counts come from the server, and the M08 button appears only when an explanation exists.
  - Personal result:
    - All six results.
    - pointsAwarded is the headline, with the base/bonus breakdown taken from the payload (no client addition).
    - No-points, total, streak, rank and "behind" lines.
  - Motion:
    - Bars at revealBar +450 ms and the streak at +350 ms (AUDIO_TIMING) with the audio engine's cue tolerance.
    - Planned once per phaseKey (no replay), static under reduced motion and for late renders.
    - The components never play audio, so nothing is triggered twice.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/host/result-chart.spec.tsx` → 35 files / 351 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a temporary probe (deleted afterwards):
    - Single choice at 360px light (the row layout was fixed after the first shot split the swatch from long text).
    - Multiple select at 1024px dark; text and puzzle reveals at 360px.
    - Personal partial 475 = 375 + 100 in light and dark; explanation dialog with long text.
    - No horizontal overflow.

## TASK-156 — 2026-11-10T21:01:54+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/host/leaderboard.tsx`: Leaderboard, LeaderboardData, LeaderboardEntry, RankChange.
  - `CREATE` `apps/web/src/components/host/podium.tsx`: Podium, podiumStage, podiumOffset, PODIUM_OFFSETS, ReportStatus.
  - `CREATE` `apps/web/src/components/host/confetti-burst.tsx`: ConfettiBurst, CONFETTI_MS. This is an extra file so that confetti is a lazily loaded chunk (React.lazy), as the spec requires.
  - `CREATE` `apps/web/src/components/host/podium.spec.tsx`: 8 tests.
  - `MODIFY` `apps/web/src/components/host/result-chart.tsx`: useCuePlan gains an optional reduced-motion override (the F16 `reducedMotion` prop).
- **Notes**:
  - Leaderboard:
    - Server top five in server order (never re-sorted, ties kept), with avatar, wrapping nickname and score.
    - Rank change shown as an arrow plus a signed number (positive = up, matching the API's `previousRank - rank`). No catalog key exists for rank-change wording, so the signed number is the accessible text.
    - Biggest climber from the server; own row marked with `aria-current` plus the server rank.
    - 300 ms row fade-in.
  - Podium:
    - Only real winners, in server order. Ties share a rank and are revealed together; absent ranks are skipped.
    - Reveal timing comes from AUDIO_TIMING (1,200 / 3,500 / 6,500 ms) with the audio engine's CUE_TOLERANCE_MS. Cues seen late are shown without animation.
    - Confetti only when the first-place cue is seen live, at most 2 s, never under reduced motion or FINISHED, and never repeated for the same phaseKey.
    - Desktop columns 2/1/3; mobile stacks 1/2/3.
    - The report status is host-only.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/host/podium.spec.tsx` → 36 files / 359 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a temporary probe (deleted afterwards): podium at 1024px light and 360px dark, FINISHED at 360px, a live first-place reveal with confetti pieces confirmed in the DOM and on screen, and the leaderboard at 360px light and 1024px dark. No horizontal overflow.

## TASK-157 — 2026-11-10T21:25:00+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/player/player-stage-answer-pad.tsx`: PlayerStageAnswerPad, answerIndices, AnsweringSnapshot.
  - `CREATE` `apps/web/src/app/(player)/play/[pin]/page.tsx`: PIN validation (404 for anything else) and localized title. Passes only the PIN, so no quiz content reaches the RSC payload.
  - `CREATE` `apps/web/src/components/player/player-game.tsx`: PlayerGame, PlayerScreen, Countdown. An extra file: the client composition of all eight phases, kept out of the server page.
  - `CREATE` `tests/e2e/player.spec.ts`: 3 tests.
- **Notes**:
  - One socket, store, clock and audio engine per page, held in state, so locale/theme switches keep the socket, draft and focus.
  - Credentials are read after mount (no hydration mismatch). F17 wraps everything.
  - Phases: LOBBY (avatar editor), countdown, preview (no options), answering (PROJECTOR shapes first with an sr-only prompt and the shared-screen hint; STREAMER prompt plus media reveal), reveal (personal result + chart), leaderboard (own row and rank), podium/finished (no report link).
  - Answer status comes from `self.acceptedAnswer`, the store draft and the server reply. Grace comes from the authoritative `inputClosesAt`. The accepted sound plays only after an ACK.
  - E2E found that the server goes straight from the last reveal to PODIUM; the test follows the server.
- **Verification**:
  - `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e` → 12/12 passed:
    - auth 3, join 6, player 3;
    - the player run covers all six inputs, Streamer and Projector, refresh after acceptance, reconnect, grace, podium/final, kick, and no key in HTML/RSC, DOM or socket frames before the reveal.
  - Web suite: 36 files / 359 tests passed.
  - typecheck, lint, prettier and build → OK.
  - 360px screenshots (light and dark) of lobby, answering, accepted, reveal, leaderboard, puzzle, final, projector and kicked, taken through a temporary spec copy (deleted afterwards).

## TASK-141 — 2026-11-10T21:34:37+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/media/asset-library-picker-upload.tsx`:
    - components: AssetLibrary, AssetLibraryRoute, MediaMetadataDialog;
    - upload: createXhrUpload, UploadFn, UploadItem;
    - helpers: mediaKind, fileProblem, folderFor, parseMediaQuery, mediaHref, assetOf, missingAlternatives, secondsToMs.
  - `CREATE` `apps/web/src/app/(dashboard)/dashboard/media/page.tsx`
  - `CREATE` `apps/web/src/components/media/asset-library-picker-upload.spec.tsx`: 9 tests.
- **Notes**:
  - List: 24 per page, with type tabs and search in the URL; only the latest response is applied.
  - Cards show the image (or a type icon), size, an "In use" badge and missing alternatives.
  - Upload:
    - Allowed MIME types only (no SVG) and the per-type limit from public-config, both checked before sending.
    - XHR progress, then "Processing…" until 201 READY. Concurrency is 2. Per-file failures with retry (new key).
    - A lost response is reconciled through `/operations/:key?operation=media.upload`.
    - An expired token is refreshed through `/auth/me` and retried with the same key.
  - Metadata: full preview plus alt text/visual description (image), transcript (audio), or transcript, visual description and captions (video). Saved with PATCH + If-Match; a revision conflict shows the message with reload. Caption ranges are validated.
  - Delete uses M09 (MEDIA_IN_USE becomes a blocked notice); in-use media is disabled with a reason.
  - Picker mode locks the kind and selects READY items (for TASK-142).
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/media/asset-library-picker-upload.spec.tsx` → 37 files / 368 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a route-faked API at 1280px light, 360px dark, empty, the edit dialog with captions, and refused uploads at 360px. The upload row layout was fixed after the first shot broke a short file name per character. No horizontal overflow.

## TASK-142 — 2026-11-11T05:25:08+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/studio/media-picker.tsx`: MediaPicker, checkAttachment, parseSeconds, CoverSelection, QuestionMediaSelection.
  - `CREATE` `apps/web/src/components/studio/media-picker.spec.tsx`: 6 tests.
  - `MODIFY` `apps/web/src/components/studio/QuizSettingsModal.tsx`: "Choose cover" always shows. A parent `onChooseCover` still wins; otherwise the built-in M05 picker opens (applyCover).
  - `MODIFY` `apps/web/src/components/media/asset-library-picker-upload.tsx`: needed so the picker can reuse the library.
    - `view="upload"`, `embedded` and `onUploaded` (only after 201 READY);
    - M05 texts in picker mode;
    - no Delete in the picker.
- **Notes**:
  - Tabs: library / upload / YouTube (questions only); covers are images only.
  - The selection preview sits above the list, is focused and shows missing-alternative warnings.
  - Question attachments are checked with the shared mediaAttachmentSchema (exclusive source, clip range, canonical YouTube URL); malformed links are refused.
  - Accessibility is deep-copied (structuredClone) into the question selection.
  - Closing never aborts an upload; `onUploadSettled` reports READY assets to the parent.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/media-picker.spec.tsx` → 38 files / 374 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check:
    - cover picker from Create quiz at 1280px light and 360px dark;
    - question picker with a video selection and clip range at 1280px dark;
    - a malformed YouTube link at 360px.
    - The first shots showed the preview below the list, so it was moved above and focused.
    - No horizontal overflow.

## TASK-143 — 2026-11-11T05:32:14+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/studio/slide-navigator.tsx`: SlideNavigator, SortableSlide, SlideSummary, TYPE_KEY, MANY_SLIDES.
  - `CREATE` `apps/web/src/components/studio/slide-navigator.spec.tsx`: 6 tests.
  - `CREATE` `apps/web/src/types/global-jsx.d.ts`: extra file. React 19 types dropped the global `JSX` namespace that the dnd-kit `.d.ts` files still use, and the project keeps `skipLibCheck: false`. This alias keeps every library check on.
- **Notes**:
  - Entries are keyed by question UUID and show position, type and prompt (2 lines visually, full text for assistive technology), plus a problem indicator that jumps to the slide's issues.
  - Reordering:
    - dnd-kit pointer and keyboard sensors with localized announcements;
    - Move up/down buttons as the keyboard alternative, keeping focus on the moved slide and announcing "Slide n of total";
    - a rejected move shows the restored-order error.
  - Add/Duplicate/Delete with focus handling: the copy is selected and focused; delete focuses a neighbour, or Add slide on the empty canvas.
  - The list scrolls, and a hint appears from 20 slides.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/slide-navigator.spec.tsx` → 39 files / 380 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium probe (deleted) at 360px light and 1280px dark: a real mouse drag reordered 1,2,3 → 2,3,1; Move up kept focus on the moved slide. No overflow.

## TASK-144 — 2026-11-11T05:38:27+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/studio/question-fields.tsx`: QuestionFields, convertQuestionType, typeChangeLosesData, lengthIssues, TrueFalseLabels.
  - `CREATE` `apps/web/src/components/studio/question-fields.spec.tsx`: 8 tests.
  - `MODIFY` `apps/web/src/stores/studio.store.ts`: bug found during the visual check. `blankQuestion("TYPE_ANSWER")` created its accepted answer with `isCorrect: false`, so every new typed-answer slide showed a key-count problem. Accepted answers are now correct by definition.
- **Notes**:
  - Common fields: type (select), prompt 500, media button (M05 via `onChooseMedia`), explanation 1,000. Counters use graphemes.
  - Per type:
    - single / true-false: radio key;
    - multiple select: checkbox keys;
    - poll: no keys;
    - typed answer: 1–20 accepted answers;
    - puzzle: 4 items with Move up/down setting sortOrder.
    - Option IDs are stable across edits.
  - Type change: `convertQuestionType` keeps texts, IDs and keys that fit. A lossy change asks M09; Cancel keeps everything. New TRUE_FALSE options use the creator's localized "Correct"/"Incorrect" labels as content.
  - Problems: shared playability issues (draft warnings vs errors) plus local too-long checks, listed with focus buttons; `focusPath` focuses from outside.
  - Rows stack in two tiers on phones; this was fixed after the first 360px shot squeezed the option inputs.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/question-fields.spec.tsx` → 40 files / 388 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium probe (deleted): single choice at 360px light, puzzle at 1024px dark, typed answer with emoji at 360px dark. No overflow.

## TASK-145 — 2026-11-11T05:42:59+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/studio/question-properties.tsx`: QuestionProperties, attachmentKind, rangeInvalid, clearAttachment, AttachedMedia.
  - `CREATE` `apps/web/src/components/studio/question-properties.spec.tsx`: 6 tests.
- **Notes**:
  - Time limit is a select with exactly TIME_LIMITS_SEC.
  - Points 0/1/2 as radios; polls are fixed at 0 with the reason.
  - Media summary: upload kind and name, a YouTube URL, or "File missing" for an unresolvable ID (kept). Choose media opens M05; Remove media clears the attachment, range, effect and alternatives together.
  - Video clip range in whole seconds with an inline end>start error.
  - Reveal: NONE/3×3/5×5/BLUR. Effects are disabled without an image; an incompatible saved effect gets an error plus a "Show immediately" fix.
  - Question-context alternatives by kind (alt, visual description, transcript, captions). They are never prefilled (no file name as alt), and missing ones are listed as warnings that focus their field.
  - `focusPath` support.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/studio/question-properties.spec.tsx` → 41 files / 394 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium probe (deleted): image at 360px light, and YouTube with an invalid range, incompatible effect and caption at 360px dark. Duplicate help/error text was removed after the check. No overflow.

## TASK-146 — 2026-11-11T10:53:13+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/studio/studio-editor.tsx`: StudioEditor, StudioWorkspace, StudioRoute, useStudioLayout, persistQuiz.
  - `CREATE` `apps/web/src/app/(dashboard)/studio/[quizId]/page.tsx`: UUID check, localized title, DashboardShell (session gate).
  - `CREATE` `tests/e2e/studio.spec.ts`: 3 tests.
  - Supporting edits, recorded because they sit outside the target files:
    - `studio.store.ts`: MAX_QUESTIONS uses QUIZ_LIMITS.questions (200) instead of a hard-coded 100.
    - `media-picker.tsx`: the question selection carries the library `media` record, for the properties preview.
    - `question-fields.tsx`: typeChangeLosesData no longer treats template-filled blanks as a loss, so a blank slide changes type without M09; spec updated.
    - `auth-provider.tsx`: `/studio` is an allowed returnTo prefix.
- **Notes**:
  - Access gate: 404/403 show the fixed unavailable message; a read-only quiz shows a notice with a link to its detail.
  - Layouts: desktop ≥1024 rail 224 | canvas | properties 288; tablet with a slides drawer (ModalSheet); mobile with Slides/Editor/Properties tabs. All panels are views of one store.
  - Explicit save (button or Ctrl/Cmd+S) as a bulk PUT with If-Match. Status: unsaved, saving, "Saved at", all saved or failed.
  - A 409 keeps the draft, with Reload saved version or Keep my draft (rebase).
  - M10 guard plus beforeunload.
  - Host only when clean, saved, playable and capable; it opens M06 and then /host/:sessionId.
  - Media picks and saves update the local media map. The project has no shared query cache, so pages refetch on mount.
  - The header title gets a minimum basis, fixed after 320/768 screenshots showed it squeezed.
- **Verification**:
  - `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e` → 15/15 passed:
    - auth 3, join 6, player 3, studio 3;
    - studio covers six types, reorder, duplicate, delete, Ctrl+S, refresh, the language switch staying clean, a conflict from another tab with reload, a zero-slide draft saved and reloaded, the M10 guard, and 320/768/1280 layouts without overflow.
  - Web suite 41 files / 394 tests; typecheck, lint, prettier, E2E tsc and build → OK.

## TASK-147 — 2026-11-11T10:58:53+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/admin/admin-settings-health.tsx`: AdminSettingsHealth, SettingsPanel, HealthPanel, formOf, changedFields, HealthLoader.
  - `CREATE` `apps/web/src/app/(dashboard)/dashboard/settings/page.tsx`
  - `CREATE` `apps/web/src/components/admin/admin-settings-health.spec.tsx`: 7 tests.
- **Notes**:
  - Superadmin guard: other roles get a permission notice and no request.
  - Settings PATCH sends only the changed fields with If-Match; a conflict keeps the entries and offers a reload. Default language comes from the installed `/system/locales`.
  - Storage keeps stale and unavailable distinct from zero. Cleanup goes through M09 with a new Idempotency-Key per batch, and reports partial failures and "more remain".
  - Health reads 200 and 503 bodies via raw fetch, shows per-service status with check times and read-only drivers, and loads and retries independently.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/admin/admin-settings-health.spec.tsx` → 42 files / 401 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check at 1280px light and 360px dark with a route-faked API (stale metrics, degraded 503 health). The duplicate "Settings" heading became "Administration". No overflow.

## TASK-148 — 2026-11-11T11:05:29+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/admin/user-invites.tsx`: UserInvites, UsersPanel, InvitationsPanel, InviteDialog, Pager, ClipboardWriter.
  - `CREATE` `apps/web/src/app/(dashboard)/dashboard/users/page.tsx`
  - `CREATE` `apps/web/src/components/admin/user-invites.spec.tsx`: 6 tests.
  - `MODIFY` `apps/web/src/providers/auth-provider.tsx`: the context exposes `reloadPrincipal` (the existing loadPrincipal), needed for "403 refetch principal".
- **Notes**:
  - Superadmin guard.
  - Users tab: paged at 20, with search and role/status filters (an explicit "all" value, fixed after a screenshot showed blank selects).
  - Role and activation changes go through M09 with If-Match. LAST_SUPERADMIN is shown as blocked; a 403 reloads the principal and the list. Admins can't deactivate themselves.
  - Invitations tab: status filter, status badges, revoke for active codes only (M09).
  - M11: 1–720 h (default 168) with an Idempotency-Key. The one-time code is shown only in the dialog (read-only, select on focus). Copy has copied/failed/unavailable states with manual copy. A lost or replayed response says the outcome is unknown and refreshes the list. The code is forgotten on close, and nothing is emailed.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/admin/user-invites.spec.tsx` → 43 files / 407 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium check with a route-faked API: users at 1280px light and 360px dark, invitations list and code dialog at 360px. No overflow.

## TASK-149 — 2026-11-11T11:09:34+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/ui/document-view.tsx`: DocumentView, AboutDocument, LanguageGuide, LEGAL_*/LOCALE_* URLs.
  - `CREATE` `apps/web/src/app/(public)/about/page.tsx`, `apps/web/src/app/(public)/help/languages/page.tsx`, `apps/web/src/app/(dashboard)/dashboard/about/page.tsx`.
  - `CREATE` `apps/web/src/components/ui/document-view.spec.tsx`: 4 tests (extra file for the DoD assertions).
- **Notes**:
  - About shows the real `/system/about` version, or "Version unknown" (never invented).
  - Official license and notices links; the official LICENSE text in its original language (`lang="en"`), with a translated-summary label for other locales.
  - Source failure keeps the official link and offers retry.
  - Audio credits via the shared CreditsButton/CreditsModal, with the separate-licenses note.
  - The guide lists the documented steps, links the real template ZIP (download), and shows installed languages with coverage from the registry; an unavailable registry is reported.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test` → 44 files / 411 tests passed.
  - typecheck, lint, prettier and build → OK.
  - The production server returned 200 for /about, /help/languages, /dashboard/about, both /legal files, the template ZIP and registry.json.
  - The downloaded ZIP passed `unzip -t`; all JSON parsed and the manifest has locale `und`.
  - At 320px with 140% text, light and dark: no overflow, footer links /about, /legal/LICENSE.txt, /legal/THIRD-PARTY-NOTICES.txt and /help/languages, keyboard Tab reaches the links, and "Version unknown" shows without an API.

## TASK-158 — 2026-11-11T11:14:15+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/host/host-stage-lobby.tsx`: HostStageLobby, HostLobbyCommands, CommandOutcome.
  - `CREATE` `apps/web/src/components/host/host-stage-lobby.spec.tsx`: 5 tests.
- **Notes**:
  - Props-driven; commands return the server outcome, and the socket wiring comes in TASK-160.
  - Join panel: big PIN, join link (Copy link, with manual copy when no clipboard), QR plus Enlarge (M07).
  - Audio slot for the single AudioController, with no local player.
  - Roster keyed by id in join order: 200-player safe, joins announced without a focus move, connected/disconnected badges, kicked players removed only by the server roster, Remove always visible and confirmed by M09.
  - Lock/Start/End follow capabilities and wait for each ACK; the server's lock state is never flipped optimistically. Start is disabled with the reason when no player is connected; End goes through M09; a lost host connection pauses the controls.
  - The roster is one column below 400px, fixed after the 360px screenshot wrapped the "Disconnected" badge.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/host/host-stage-lobby.spec.tsx` → 45 files / 416 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium probe (deleted) at 1280px light and 360px dark. No overflow.

## TASK-159 — 2026-11-11T11:20:19+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/host/question-projector.tsx`: QuestionProjector, LONG_PROMPT.
  - `CREATE` `apps/web/src/components/host/host-phase-controls.tsx`: HostPhaseControls, HostPhaseCommands, nextLabelKey.
  - `CREATE` `apps/web/src/components/host/question-projector.spec.tsx`: 5 tests.
- **Notes**:
  - The projector renders countdown, preview and answering from the host sync.
    - Countdown is server-synced.
    - Preview shows the full prompt only.
    - Answering shows the timer, the answer count, public media (with a failure notice that does not block anything) and options with shapes and colours.
    - No correct key is shown before the reveal.
  - Prompts over 160 characters get a focusable scroll region with an Open/Close toggle.
  - Layout is 16:9 at 1280 and 1920; it becomes vertical on mobile.
  - Controls cover Start, Skip, Next and End.
    - They follow capabilities and run one pending command at a time (a ref guard) with expectedPhaseVersion.
    - The phase is never changed optimistically.
    - The Next label comes from server state: leaderboard, next question or podium.
    - End is confirmed through M09, and the controls lock while offline.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/host/question-projector.spec.tsx` → 46 files / 421 tests passed.
  - typecheck, lint, prettier and build → OK.
  - Chromium probe (deleted) at 1280 and 1920 dark, and at 360 light: no overflow.

## TASK-160 — 2026-11-11T15:41:17+07:00

- **Files**:
  - `CREATE` `apps/web/src/app/(host)/host/[sessionId]/page.tsx`: S16 route (UUID check, localized title, no server-side quiz content).
  - `CREATE` `apps/web/src/components/host/host-stage.tsx`: HostStageRoute, HostStage, createHostCommands, toOutcome.
  - `CREATE` `apps/web/src/components/host/report-finalization-notice.tsx`: ReportFinalizationNotice, newerStatus, FINALIZATION_POLL_MS.
  - `CREATE` `tests/e2e/host.spec.ts`: 3 E2E tests.
  - `MODIFY` `apps/web/src/components/ui/dashboard-shell.tsx`: exports RedirectToLogin/ReauthPrompt so the host route reuses the same session gate.
  - `MODIFY` `apps/web/src/hooks/useAudioEngine.ts`: returns `lobbyTracks` for the single AudioController (track count and label).
- **Notes**:
  - The stage is protected by RequireAuth: anonymous visitors go to sign-in with returnTo, and a lost session stays inert behind "Sign in again".
  - One socket, store, clock and audio engine per page. Recovery uses `host:recover_room` with a one-time token renewal (`auth:update`); when renewal fails, the authExpired fallback is shown.
  - Each of the 8 phases is composed from existing parts:
    - LOBBY: HostStageLobby with the AudioController slot.
    - Countdown, preview and answering: QuestionProjector.
    - ANSWER_REVEAL: ResultChart with ExplanationDialog (M08).
    - LEADERBOARD: Leaderboard.
    - PODIUM/FINISHED: Podium (no replay) plus the report notice.
    - HostPhaseControls provide End from every active phase.
  - Commands send the snapshot's phaseVersion and are never applied optimistically. An unknown ACK triggers requestSync and is never re-sent.
  - Audio: only useAudioEngine(host) drives sound, with a join pop for each new roster id. There is no other local player.
  - Report status is independent of FINISHED:
    - The newest status wins (socket push or REST, compared by updatedAt).
    - REST polling runs only while pushes can't arrive, including after the room is gone.
    - Retry uses an Idempotency-Key and reconciles uncertain outcomes.
    - "View report" appears only for ready with the real id.
  - E2E: the host context reuses the API sign-in's refresh cookie (storageState). Signing in through the UI tripped the shared per-email limit (5/min) and broke the next spec.
- **Verification**:
  - `pnpm test:e2e -- tests/e2e/host.spec.ts`: 3 passed, covering:
    - start, skip, next and podium/FINISHED with the ready report;
    - double clicks on Next sending one command each (question 2 follows question 1);
    - a dropped socket (controls locked, then recovered) and a reload recovery;
    - an early end from an empty lobby;
    - a finalization failure (status frames rewritten to failed) followed by a real retry that returns ready;
    - the 404, sign-in redirect and terminal fallback.
  - Full E2E suite: 18/18 passed. Web unit tests: 46 files / 421 tests passed. typecheck, lint, prettier, e2e tsc and the production build: OK.

## TASK-160A — 2026-11-11T16:26:06+07:00

- **Files**:
  - `CREATE` `tests/helpers/audio-observer.ts`: installAudioObserver, forceMp3, readAudioLog, anythingPlaying, sfxOf, sfxCalls, loopIntervals, maxLoopOverlap, loadErrors, SFX_FILES.
  - `CREATE` `tests/e2e/audio.spec.ts`: 3 E2E tests.
  - `MODIFY` `apps/web/src/stores/game.store.ts` (+ spec): bug found by the suite.
    - Reveal, leaderboard, podium and finished pushes carry no timing, and the reducer kept the previous phase's timing. Their `phaseStartedAt` was therefore seconds old, so the reveal gong, revealBar, answerCorrect/Wrong, podium spotlights and the podium animation were skipped as "too late".
    - Timing is now derived from the envelope's serverTime, exactly as the server stores it (podium +8000 ms).
  - `MODIFY` `apps/web/src/lib/audio-manager.ts` (+ spec): two bugs.
    - Howler emits `loaderror` for a Howl that is unloaded while decoding. The manager then built a stray MP3 replacement and could show a false "Sound couldn't play". Disposed handles are now ignored.
    - A cue requested before any screen set the manifest (join page dice / own join) is now played by lazily loading the manifest once.
  - `MODIFY` `apps/web/src/components/player/avatar-customizer.tsx`: the player's own new join plays one nekoPop (deduplicated per player id). This signal was missing.
  - `MODIFY` `playwright.config.ts`: the auth spec runs first as project `first-run` (it owns first-run setup); every other spec depends on it, whatever its file name.
- **Notes**:
  - The real Howler is observed through a `window.Howl` trap with a prototype wrapper. Nothing is faked: codec choice, decoding and playback come from the browser.
  - `play(id)` replays by Howler are kept apart from the app's `play()`. Events after unload are ignored for loop intervals and load errors.
  - Browser evidence:
    - Run: Chromium only.
    - Not run: Firefox and WebKit, which are not installed in this environment (installing other browsers is not allowed here).
    - Not run: manual iOS autoplay and gapless-loop observations, which need devices.
- **Verification**:
  - `pnpm test:e2e -- tests/e2e/audio.spec.ts`: 3 passed.
    - All 40 manifest sources return 200.
    - Gesture unlock; M mute stored and gain 0; random lobby pick plus Next track crossfade; burst join pops at least 140 ms apart.
    - Role matrix covers all 10 SFX:
      - host: hyoshigi ×1, gong ×5, revealBar ×5 at about 450 ms, tick ×5, rate 1.22 once then reset to 1, spotlights;
      - player: correct ×4 (including the podium rank), streak ×1, wrong ×1, no POLL feedback, no BGM or ticks.
    - Loop sequence lobby → sprint → groove → buildup → victory (victory once). Loop overlap stays within the 800 ms budget; no real load errors.
    - Teardown leaves nothing playing and no late cues.
    - With WebM forced off, the specific `matcha` track and the SFX load as MP3.
  - Full E2E suite: 21/21 passed. Web unit tests: 46 files / 424 tests passed. typecheck, lint, prettier and e2e tsc/eslint: OK.

## TASK-161 — 2026-11-11T16:32:05+07:00

- **Files**:
  - `CREATE` `apps/web/src/app/(dashboard)/dashboard/reports/page.tsx`: S09 route; passes the URL params (`quizId`, `search`, `page`) to the client list.
  - `CREATE` `apps/web/src/components/reports/report-list.tsx`: ReportList, ReportListRoute, parseReportsQuery, reportsHref, fetchReports, REPORTS_PAGE_SIZE.
  - `CREATE` `apps/web/src/components/reports/report-list.spec.tsx`: 7 tests.
- **Notes**:
  - Only ready reports are listed: 15 per page, `ended_desc`, with search and quiz filter. The server scopes every query to the host, so a foreign `quizId` returns no data.
  - URL query state; createLatestRequest aborts the older request, and a stale response is never applied. A page beyond the end moves back to the last page.
  - Each row shows the snapshot title (wraps; a deleted quiz keeps its title) linking to S10, the end date and time with the time-zone label, the player count, and a Completed / Ended early / Expired badge.
  - Empty states are distinct: no finished games (link to Quizzes) vs. no matches (Clear filters). A fetch failure shows the s09 error, the correlation id and Retry. A failed refresh keeps the rows as older data.
  - The quiz filter lists the host's own quizzes (limit 100). A filtered id that is missing stays visible as the current choice.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/reports/report-list.spec.tsx`: 7 passed. Covers L/E/I/P/X, pagination and clamping, the time zone shown, abort/latest-only, a 401 refresh followed by a retry, and a 404 error.
  - Full web suite: 47 files / 431 tests passed. typecheck, lint, prettier and build (route `/dashboard/reports`): OK.

## TASK-162 — 2026-11-11T16:35:58+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/reports/answer-detail-dialog.tsx`: AnswerDetailDialog, readableAnswer, readableSolution, ANSWERS_PAGE_SIZE.
  - `CREATE` `apps/web/src/components/reports/answer-detail-dialog.spec.tsx`: 5 tests.
- **Notes**:
  - M12 loads paged answers (`/reports/:id/players/:playerId/answers`, 20 per page, question_asc) and matches them against the report's immutable question snapshots.
  - Payloads are shown as readable text: option texts, typed text, a numbered order for puzzles. The correct answer comes from the snapshot (none for polls).
  - Outcome badges:
    - Correct, Partly correct, Incorrect, Answered/No answer for polls.
    - "No points" for m0 questions.
    - NOT_PLAYED, NOT_ELIGIBLE and UNANSWERED stay separate.
  - Each answer shows response time, base, bonus and total. `0` is a value and "—" means missing.
  - The report contract has no media URLs and there is no GET media/:id endpoint. The parent passes an optional media map; when an asset is missing or fails to load, "This media is no longer available." is shown.
  - Errors show the m12 error with Retry, never an empty list. Pagination moves focus to the "Answers" heading.
- **Verification**:
  - `pnpm --filter @kabuki-neko/web test -- src/components/reports/answer-detail-dialog.spec.tsx`: 5 passed. Covers the five states, partial/poll/m0/unplayed, and pagination with keyboard and focus.
  - Full web suite: 48 files / 436 tests passed. typecheck, lint and prettier: OK.

## TASK-163 — 2026-11-11T20:53:17+07:00

- **Files**:
  - `CREATE` `apps/web/src/components/reports/report-analytics.tsx`: ReportAnalytics, REPORT_STATUS_POLL_MS, REPORT_PLAYERS_PAGE_SIZE. Internal parts: FinalizationGate, ReportView, Kpi, PlayersPanel, QuestionsPanel, HardestQuestions.
  - `CREATE` `apps/web/src/app/(dashboard)/dashboard/reports/[sessionId]/page.tsx`: S10 route (UUID check, client-loaded report).
  - `CREATE` `tests/e2e/reports.spec.ts`: 4 E2E tests with real socket-driven games.
  - `MODIFY` `apps/web/src/components/reports/report-list.tsx`: loads the `media` namespace, because the filter's "All" label showed "Unavailable" (bug found by the E2E screenshot).
- **Notes**:
  - Gate:
    - 409 FINALIZATION_PENDING / 503 REPORT_SAVE_FAILED: status polling every 5 s; failed + retryable shows "Try saving again" (Idempotency-Key, reconciled); lost shows a message.
    - 404 shows a safe not-found for unknown sessions and other hosts.
  - Snapshot data only:
    - KPIs: players, played/total, accuracy with the server's numerator/denominator and its definition, unanswered.
    - Tabs: Players (20 from the report, then `/players` paging; "—" rank for kicked players; Answers opens M12) and Questions (played/unplayed, no-points badge, per-question metrics, "—" without a denominator).
    - Hardest questions from the server's indexes.
  - CSV: `api.download` with the server's safe filename, then saveBlob. Export failures use their own message (detail.exportFailed).
  - E2E fixtures:
    - complete game: Ani answers everything (partial MS = a correct subset, per the server rule), Budi never answers, Caca is kicked after a wrong Q1; includes a poll and a zero-point question;
    - early end with zero answers.
    - The second host is registered by invite or public mode, depending on the current registration mode.
    - The browser reuses the API sign-in's refresh cookie in one shared context.
- **Verification**:
  - `pnpm test:e2e -- tests/e2e/reports.spec.ts`: 4 passed (+3 first-run).
    - Ready-only list ordering and badges; complete report KPIs; kicked "—"; M12 partial; poll/m0 "—"; hardest.
    - The CSV download is byte-identical to the API export.
    - Early end shows zero answers and 3 unplayed questions.
    - Pending gate; another host gets 404 for the report and CSV; no token gets 401.
  - Screenshots at 1280 and 360: no overflow.
  - Full E2E suite: 25/25 passed. Web unit tests: 48 files / 436 tests passed. typecheck, lint and prettier: OK.

## TASK-164 — 2026-11-11T21:22:40+07:00

- **Files**:
  - `CREATE` `apps/web/src/proxy.ts`: proxy, contentSecurityPolicy, originOf, SECURITY_HEADERS, YOUTUBE_EMBED_ORIGIN, config matcher.
  - `MODIFY` `apps/web/next.config.ts`: static headers (nosniff, referrer, permissions) on every response.
  - `MODIFY` `apps/api/src/main.ts`: securityHeaders middleware.
  - `CREATE` `tests/e2e/security-headers.spec.ts`: 5 tests.
  - `CREATE` `docs/security-headers.md`: policy table, CSP_MEDIA_ORIGINS, HSTS at the HTTPS proxy (nginx/Caddy), redirects.
  - `MODIFY` `tests/e2e/studio.spec.ts` and `tests/e2e/audio.spec.ts`: harness robustness only.
    - The studio sign-in now waits out the shared per-email limit (5/min) that the two new specs pushed over.
    - The audio check now waits for the victory decode before reading the log.
- **Notes**:
  - Web CSP (per request, fresh nonce; all pages are dynamic because the root layout reads headers):
    - `script-src 'self' 'nonce-…' 'strict-dynamic'`: no unsafe-eval (development only) and no unsafe-inline for scripts;
    - `style-src 'self' 'unsafe-inline'` (React style attributes);
    - img/media from self, blob:, data:, the API origin and CSP_MEDIA_ORIGINS (runtime, not a public build value);
    - connect to self, the API and WS (http/ws forms);
    - `frame-src` youtube-nocookie only;
    - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`.
  - Permissions-Policy: camera=(self) for the QR scanner, microphone=().
  - API headers:
    - `default-src 'none'; frame-ancestors 'none'; sandbox`, X-Frame-Options DENY and a referrer policy;
    - CORP `cross-origin` for /uploads and `same-site` for everything else.
  - The existing upload MIME allowlist and nosniff are unchanged. The returnTo and QR guards are verified.
- **Verification**:
  - `pnpm test:e2e -- tests/e2e/security-headers.spec.ts`: 5 passed.
    - Fresh nonce; every script tag carries it; directives as above.
    - Hydration, signed-in dashboard pages, the game socket (PIN check), and an uploaded image loading from the API origin, all with zero CSP violations.
    - Injected inline and foreign scripts, a foreign iframe and an object are blocked, and the page still hydrates.
    - A foreign framer is blocked by frame-ancestors.
    - The returnTo values `//evil`, `https://evil` and `/\evil` all land on /dashboard/quizzes.
    - API headers checked.
    - No secret env names in the client bundles.
  - Full E2E suite: 30/30 passed. Web unit tests: 436/436. API Jest: 215 passed.
    - `rate-limit.service.spec.ts` (11 tests) cannot run here because it needs Docker (testcontainers Redis); this is pre-existing and unrelated.
  - typecheck, lint and prettier: OK.

## TASK-165 — 2026-11-11T21:36:50+07:00

- **Files**:
  - `CREATE` `tests/integration/auth-races.spec.ts`: 6 tests × 3 engines.
  - `CREATE` `tests/integration/authorization.spec.ts`: 6 tests × 3 engines.
  - `MODIFY` `tests/helpers/runtime.ts`: DB_DRIVERS/DbDriver, TestRuntime, databaseEnv (real PostgreSQL 16 / MySQL 8.4 containers, never a fallback), freePort, startApi (built API process with captured output), TEST_ORIGIN, httpClient.
- **Notes**:
  - Each engine gets a fresh runtime, database and API process. The API trusts loopback as a proxy, so simulated clients have their own rate-limit IPs.
  - Races (real HTTP):
    - 5 concurrent setups → exactly one SUPERADMIN, the rest 409 SETUP_COMPLETE;
    - 4 concurrent registrations on one invitation → one 201, the rest 409 INVITE_UNAVAILABLE; reuse 409;
    - PUBLIC with an inviteCode → 422; SINGLE_ADMIN → 403;
    - mutual demotion and mutual deactivation of two SUPERADMINs → exactly one active SUPERADMIN remains, and self-removal returns 409 LAST_SUPERADMIN;
    - concurrent refresh with one cookie → [200, 401] and the family is revoked; sequential reuse revokes the newer token;
    - deactivation → access 401, refresh 401, and a login body identical to a wrong password.
  - WS: host commands are refused right after a role change (TOKEN_REVOKED) until auth:update with a fresh token, and for good after deactivation.
  - Authorization matrix:
    - private quiz/export 404 for the other creator and the SUPERADMIN (no implicit bypass);
    - public quiz read/export allowed, valid PUT/DELETE 403/404 and unchanged, duplicate owned by B;
    - listings do not leak; anonymous 401;
    - media and reports (detail/status/players/CSV) 404 for non-owners or non-hosts;
    - socket lock/end/recover refused for non-hosts.
  - Boundary checks:
    - foreign or missing Origin and a missing client header → 403 with no change;
    - cross-origin refresh → 403;
    - the 11th login per IP → 429;
    - a register replay → 409 OPERATION_COMPLETED_REAUTH_REQUIRED with no credential;
    - logout revokes the refresh family (repeated logout 200, forged token 401).
  - Redaction: the API output contains none of the passwords, tokens, cookies or invite codes.
  - Environment: started dockerd in this container (testcontainers needs it), and image pulls through the proxy work.
- **Verification**:
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/auth-races.spec.ts`: 18/18 passed (SQLite, PostgreSQL 16, MySQL 8.4).
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/authorization.spec.ts`: 18/18 passed (all 3 engines).
  - Full integration suite: 53/55 passed. The 2 failures are pre-existing and environmental:
    - media.spec MinIO: the image is built from GitHub source inside `docker build`, which fails here;
    - system.spec cleanup: the delete failure is induced with chmod 0555, but this container runs as root, which ignores file permissions.
  - eslint and prettier on the new and modified files: OK.

## TASK-166 — 2026-11-11T22:00:41+07:00

- **Files**:
  - `CREATE` `tests/integration/content-races.spec.ts`: 6 tests × {SQLite, PostgreSQL, MySQL}/local + PostgreSQL/MinIO.
  - `CREATE` `tests/integration/media-failures.spec.ts`: 3 tests × 3 engines (local) + 4 MinIO failure-injection tests.
  - `MODIFY` `tests/helpers/runtime.ts`:
    - `KABUKI_TEST_MINIO_IMAGE` uses a prebuilt image of the same pinned MinIO source, needed here because `docker build` behind the TLS-intercepting proxy lacks its CA;
    - `startApi` points NEXT_PUBLIC_API_URL at its own origin (local upload URLs) and gains kill() (SIGKILL crash) and exitCode().
  - `MODIFY` `tests/integration/authorization.spec.ts`: the media checks now use PATCH/DELETE with the owner's real If-Match. The old GET /media/:id check passed only because that route does not exist.
- **Notes**:
  - Content races:
    - two saves on one revision → [200, 409] and the stored quiz is exactly the winner's;
    - duplicates with distinct keys → complete independent copies; one key → one copy;
    - create_room racing a save → a room only from the named revision, with that revision's prompt;
    - pins: B's copy keeps A's cover in use (409 MEDIA_IN_USE); an active room keeps question media in use after the quiz drops it;
    - attach vs delete → exactly one wins, a quiz never points at a deleted upload, and kept files exist;
    - cleanup removes only unreferenced uploads with exact count and bytes, and a concurrent run is refused (429 CLEANUP lease).
  - Failures:
    - malformed import/upload → stable errors with no quiz, media or finished operation;
    - an import aborted mid-body creates nothing, then the full file plus a replay creates exactly one quiz;
    - an incomplete S3 config refuses startup without printing the secret.
  - MinIO (container paused at precise points, API SIGKILLed):
    - an outage upload is never 201 and never listed, and uploads resume afterwards;
    - a crash mid blob write leaves no listed upload and existing files intact;
    - a crash after a delete claim leaves a DELETING row; it is aged past the janitor's 10-minute threshold in the DB (simulated time), and the startup sweep removes both row and blob;
    - cleanup during an outage answers 503 STORAGE_UNAVAILABLE with rows and files kept, then the next run deletes every READY/FAILED candidate with exact bytes.
  - Environment: dockerd started; MinIO image `kabuki-neko/minio-test:local-ca` built from the pinned commit plus the proxy CA.
- **Verification**:
  - `KABUKI_TEST_MINIO_IMAGE=kabuki-neko/minio-test:local-ca pnpm test:integration --runInBand --runTestsByPath tests/integration/content-races.spec.ts`: 24/24 passed.
  - `… --runTestsByPath tests/integration/media-failures.spec.ts`: 13/13 passed.
  - `authorization.spec.ts` re-run: 18/18. The existing media.spec MinIO test also passes with the prebuilt image.
  - eslint and prettier: OK.

## TASK-167 — 2026-11-11T22:27:57+07:00

- **Files**:
  - `CREATE` `docker/docker-compose.test-cluster.yml`: six Redis 7 nodes (3 masters + 3 replicas) with cluster mode, AOF everysec and node timeout 2 s.
    - Host networking on loopback ports KN_CLUSTER_PORT_0..5, so the announced addresses work from tests.
    - A one-shot `init` service creates the cluster.
    - Labels `com.kabuki-neko.purpose=test-cluster`.
  - `CREATE` `tests/helpers/redis-cluster.ts`: startRedisCluster runs the Compose file under a unique project with free ports, then waits for slots OK and replicas attached with `master_link_status:up`. It exposes cli, masterFor, waitHealthy, kill (SIGKILL), start, wipe, and stop (`down -v` of that project only).
  - `CREATE` `tests/contracts/redis-cluster.spec.ts`: 6 contracts against the production StateConnections/RedisStateStore.
  - `MODIFY` `tests/helpers/runtime.ts`: `runtime.redisCluster()` plus deferred cleanups, so cleanup removes only the test's Compose project.
- **Notes**:
  - Contracts:
    - every key of a PIN hashes to one slot; rooms on all three masters run create/join/command/snapshot/release with no CROSSSLOT;
    - SCRIPT FLUSH on all 6 nodes → NOSCRIPT reload;
    - two instances racing admitAnswer for one submission → identical results, then ALREADY_ANSWERED, with one stored answer; an old generation → SESSION_REPLACED; a stale skip_timer → STALE_PHASE with revision and lock unchanged;
    - Socket.io server events cross nodes between two instances' adapters;
    - master failover: commands fail closed while the slot has no master; the replica is promoted; the client follows (MOVED); the surviving room is one committed state (revision parity matches the lock flag; revision ≤ last ack, so no zero-RPO claim); the old master rejoins;
    - lost AOF tail: with the replica down and the master's appendonly turned off before the write, a master crash and restart leaves the room absent (null → ROOM_LOST); reads are refused while the slot has no master.
  - Fixture bug found while debugging: replicas must finish their initial sync before failover tests (otherwise "Disconnected from master for longer than allowed").
- **Verification**:
  - `docker compose -f docker/docker-compose.test-cluster.yml config --quiet`: OK.
  - `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/redis-cluster.spec.ts`: 6/6 passed, and no `test-cluster` containers are left afterwards.
  - `state-parity.spec.ts` (shares the runtime helper): 22/22 passed.
  - eslint and prettier: OK.

## TASK-168 — 2026-11-11T23:15:12+07:00

- **Files**:
  - `CREATE` `tests/integration/realtime-races.spec.ts`: 5 tests × PostgreSQL/MySQL.
  - `CREATE` `tests/integration/recovery.spec.ts`: 4 tests × PostgreSQL/MySQL.
  - `CREATE` `tests/integration/payload-privacy.spec.ts`: 1 full-game scan on PostgreSQL. Privacy is dialect-independent; the two-node path is what matters.
  - `CREATE` `tests/helpers/game.ts` (outside the listed targets): shared by the three specs.
    - startScaledApis: 2 API nodes in the multi topology on one Redis plus PostgreSQL/MySQL, sharing one public URL because the storage origin is pinned;
    - GameClient: records all events, distinct X-Forwarded-For per client;
    - quizWith, createRoom, join, answeringQuestion, serverOffset/untilServerTime, phaseVersion.
- **Notes**:
  - Races:
    - host on node A and players on node B share one authoritative game (same question id and deadlines);
    - two next_step calls with one phase version → exactly one accepted, the other STALE_PHASE, and question 2 is never announced;
    - submit vs skip and submit vs end → the answer counts or appears in the report exactly when its ACK was accepted;
    - the old socket is cut off after a reconnect on the other node (disconnected or refused);
    - a lost join ACK replayed on the other node returns the same playerId and token, with one roster entry.
  - Recovery:
    - receivedAt − serverStartTime < 500 ms → 1000 base points, and slower answers get less;
    - an answer received after inputClosesAt and within acceptanceClosesAt counts; one after acceptanceClosesAt gets TIME_EXPIRED, UNANSWERED and 0 points;
    - a player disconnected at freeze is optional (NOT_ELIGIBLE if it returns without answering); a kicked player releases the question, which closes as soon as the last required player answers;
    - SIGKILL of the host's node mid-question → recover_room on the other node shows the same question, its timer closes it, and the pre-crash answer counts once;
    - podium: a silent player is the only entry (rank 1, score 0, nobody invented); a room emptied by a kick has an empty podium (SA §5 rank rules).
  - Privacy (host, answering player, watcher, a mid-question recovery ACK and room:sync, all 5 types):
    - no isCorrect/acceptedTexts/correctOptionIds/correctOrderIds or the typed answer text before the reveal;
    - never tokenHash, frozenReport, answers, eligibility sets or sortOrder;
    - no host-only keys for players and no session tokens in pushes;
    - each reveal holds only the player's own result.
    - SSR HTML is covered by the browser suites.
  - No client timestamp is ever sent; all timing comes from the server's fields and receivedAt.
- **Verification**:
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/realtime-races.spec.ts`: 10/10.
  - `… recovery.spec.ts`: 8/8.
  - `… payload-privacy.spec.ts`: 1/1.
  - eslint and prettier: OK.

## TASK-169 — 2026-11-11T23:39:24+07:00

- **Files**:
  - `apps/api/src/modules/game-engine/room-scheduler.ts` (one error-level alarm per room when a frozen report is still not durable 24 h after the game; never evicted)
  - `apps/api/src/modules/game-engine/room-scheduler.spec.ts` (alarm unit test)
  - `tests/helpers/game.ts` (openDatabase, allocationStatus, ageRoomState, until, startSingleApi, uploadImage, QuestionSpec.mediaId)
  - `tests/integration/room-retention.spec.ts` (lobby 2h, hard 8h, finished 1h, pending >24h alarm without eviction, stale PIN cleanup, memory restart LOST)
  - `tests/integration/finalization-failures.spec.ts` (crash after end_game, crash inside the history write with an expired lease, failed backoff/503 gates/list/pins/manual reset/due retry, reportId gate, payload hash mismatch)
- **Verification**:
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/finalization-failures.spec.ts` → 12/12 (sqlite, postgres, mysql)
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/room-retention.spec.ts` → 18/18
  - API jest room-scheduler 5/5, API typecheck, eslint and prettier clean

## TASK-170 — 2026-11-11T23:47:09+07:00

- **Files**:
  - `tests/contracts/driver-matrix.spec.ts` (12 single-node DB×state×storage combinations with real engines and the built API; 2 multi-node topologies; 3 invalid multi-node configurations refused; versions + pass/fail evidence JSON)
  - `tests/contracts/cloud-storage.spec.ts` (independent AWS S3 / R2 / Spaces smoke with operator credentials; missing credentials recorded NOT RUN, skipped, never passed)
  - `docs/driver-verification.md` (scope, how to run, latest recorded run with engine versions and results)
- **Verification**:
  - `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/driver-matrix.spec.ts` → 18/18 (12/12 single-node, 2 multi-node, 3 refusals)
  - `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/cloud-storage.spec.ts` → 1 passed, 3 skipped; evidence records all three providers as NOT RUN (no credentials supplied). The configured path was self-checked against a throwaway MinIO (not provider evidence).
  - eslint and prettier clean

## TASK-171 — 2026-11-12T00:55:32+07:00

- **Files**:
  - `tests/e2e/fixtures/ui-state-cases.ts` (inventory of S01–S17, M01–M12, B01–B12, F01–F20 × L/E/I/P/X = 305 cells, each with the design expectation and existing tests by file + exact title; deterministic hold/offline/503 route fixtures; shared title constants and `declaresTest`)
  - `tests/e2e/ui-states.spec.ts` (inventory completeness/reference check; S05/S08/S09 loading/real empty/offline error/retry/ideal; S06/S10/S17 safe fallbacks; S11/S12 per-panel failure and retry, empty search; S01/S13 503 and failed sources with static content kept)
  - `tests/e2e/journeys.spec.ts` (setup→register→PUBLIC reuse→JSON import→WebP upload→six-type studio quiz hosted from the studio→browser + socket players→refresh recovery→podium→report + byte-identical CSV→admin orphan cleanup→About license; AC-01-01…AC-21-04 and PRD §9 scenarios 1–5 traced to existing tests or later tasks)
- **Verification**:
  - `pnpm test:e2e tests/e2e/journeys.spec.ts tests/e2e/ui-states.spec.ts` → 14/14 (incl. first-run dependency)
  - full `pnpm test:e2e` → 41/41
  - e2e typecheck, eslint and prettier clean
- **Notes**: the creator-forbidden settings message briefly shows the generic "Unavailable" fallback while the `validation` namespace loads (cosmetic; correct text appears once loaded).

## TASK-172 — 2026-11-12T03:56:37+07:00

- **Files**:
  - `tests/e2e/fixtures/locale-packages.ts` (test-only packages: genuine partial `de` and RTL `ar`; en-XA/ar-XB pseudo generator with ≥ +40% bracketed expansion that leaves ICU syntax intact; package writer)
  - `tests/contracts/localization-roundtrip.spec.ts` (built-ins complete; pseudo locales valid only with --allow-pseudo and never publishable; install de+ar → one bundle to API+web → built API serves it → rollback restores the original buildId)
  - `tests/e2e/localization.spec.ts` (picker lists 8 installed languages without code changes, German switch with en fallback + cookie + SSR; Arabic RTL and 320 px fit for de/ar; SSR cookie/Accept-Language/Chinese script/storage rules; failed catalog keeps old language and typed PIN then retries; mid-game switch online/offline never resends or changes content; dirty studio draft stays dirty with no save)
  - `playwright.config.ts` (scope addition: web server reads a private copy of the shipped bundle via KN_LOCALES_DIR so the spec can install/roll back without touching apps/web/public/locales)
  - `apps/web/src/components/player/player-game.tsx`, `apps/web/src/components/host/host-stage.tsx` (scope addition, gap found by the test: Design §3 requires a language control on the player/host stages; LocalePicker added above the recovery wrapper so it stays usable while reconnecting/offline)
- **Verification**:
  - `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/localization-roundtrip.spec.ts` → 3/3
  - `pnpm test:e2e tests/e2e/localization.spec.ts` → 8/8 (incl. first-run); full `pnpm test:e2e` → 46/46
  - web typecheck, lint, unit tests 436/436; shipped registry unchanged (6 locales, buildId caa1a1e1…)

## TASK-173 — 2026-11-12T04:36:02+07:00

- **Files**:
  - `tests/e2e/accessibility.spec.ts` (axe WCAG 2.0/2.1/2.2 A+AA on public/auth/dashboard/studio pages in light and dark themes and a rejected sign-in; M09 starts on Cancel, traps Tab, returns focus; studio slide reorder by keyboard; whole game by keyboard only: join, six answer types, puzzle move buttons, host Remove via M09 and phase controls, axe on every phase and the report)
  - `tests/e2e/responsive.spec.ts` (no horizontal scroll at 320/390/768/1280 px and 200% zoom for public/auth/dashboard/studio; ja and zh-Hans at 320 px; projector stage at 1280×720 and 1920×1080 with question and all answers in view; reduced motion leaves no running animation)
  - `docs/accessibility-verification.md` (dated automated evidence, fixes, manual screen-reader/IME/virtual-keyboard/forced-colors items marked not verified, creator media-alternative gap and essential-timing exception; not a WCAG certification)
  - `apps/web/src/app/globals.css` + 9 components (fix found by axe: primary used as text was 4.43:1/4.21:1; new `--primary-text` token #C2311A light / #FF8A75 dark for links and active navigation; buttons keep the brand crimson)
  - `apps/web/src/providers/theme-provider.spec.tsx` (guards the new token's AA contrast on every surface)
- **Verification**:
  - `pnpm test:e2e tests/e2e/accessibility.spec.ts tests/e2e/responsive.spec.ts` → 6/6 and 8/8 (incl. first-run); full `pnpm test:e2e` → 54/54
  - web typecheck, lint, unit tests 436/436
  - Manual assistive-technology items: not verified (recorded as such)

## TASK-174 — 2026-11-12T04:40:58+07:00

- **Files**:
  - `scripts/package-assets.ts` (adds: audio manifest validated with the shared strict schema so legacy/stale manifests fail, WebM + MP3 fallback per cue, manifest URL set = provenance outputs (40), WebM must carry Opus; attribution check (code license never covers the audio, asset license named in notices); API/web locale bundle identity (registry, every asset SHA-256, template ZIP); packages LICENSE/notices into both web `public/legal` and API `assets/legal`, and the audio manifest into API `assets/audio`, through staged swaps; `--ensure-audio` runs audio:optimize when outputs are missing; new options `--api`, `--locales`, `--require-locales`)
  - `tests/contracts/distribution.spec.ts` (private copy of the release inputs; complete tree packages both artifacts; 16 single-input removals/corruptions each fail with a precise message and leave packaged copies unchanged; missing generated audio fails under --require-audio; build hook declared)
  - `package.json` (`build` = `pnpm build:assets && turbo run build`; `build:assets` = locales:build + package-assets with every requirement; `assets:package`); `.gitignore` (`/apps/api/assets/`). `pnpm-lock.yaml` unchanged: no dependency added.
- **Verification**:
  - `pnpm test:contracts --runInBand --runTestsByPath tests/contracts/distribution.spec.ts` → 20/20
  - `pnpm build` → exit 0; locale bundle caa1a1e1… built and mirrored; 20 sources / 40 outputs verified; legal texts byte-identical in apps/web/public/legal and apps/api/assets/legal; API audio manifest packaged; guide `/help/languages` and `/locales/template-v1.zip` present
  - eslint/prettier clean

## TASK-175 — 2026-11-12T04:54:00+07:00

- **Files**:
  - `docker/Dockerfile.api` (Node 26.13.0 bookworm-slim pinned by digest sha256:add5c17c… — the workspace requires node ≥ 26.13 so Node 24 cannot run it; assets stage installs the frozen lockfile and runs `pnpm build:assets` with pinned ffmpeg 7:5.1.9-0+deb12u1; build stage compiles and `pnpm deploy --prod`; runtime with pinned ffprobe/tini 0.19.0-1+b3, UID 10001, only /app/data, /app/uploads, /tmp writable, locale bundle + generated audio set + legal texts, health-based HEALTHCHECK; build CA only as a BuildKit secret)
  - `docker/Dockerfile.web` (same assets stage; Next standalone build with NEXT_PUBLIC_* URL build args; runtime with standalone server, immutable .next/static and the full public dir incl. /legal, catalogs, audio; UID 10001; only .next/cache writable)
  - `docker/entrypoint.sh` (tini → exec node for signal forwarding; *_FILE secrets; multi-topology requires shared JWT secrets; compiled-schema config check printing only field names; bounded DB/Redis reachability gate before migrations, KN_STARTUP_WAIT_SEC)
  - `.dockerignore` (no node_modules/build outputs/generated assets/local data/secrets in the context)
  - `package.json` + `tests/contracts/distribution.spec.ts` (TASK-174 follow-up found by the image build: `build:assets` builds @kabuki-neko/shared first, which audio:optimize needs on a fresh checkout)
- **Verification**:
  - `docker build -f docker/Dockerfile.api -t kabuki-neko-api:test .` → OK (1.18 GB); `docker build -f docker/Dockerfile.web -t kabuki-neko-web:test .` → OK (504 MB) (built with the same-digest mirror.gcr.io base because Docker Hub answered 429, and the proxy CA as build secret)
  - API image: `ffprobe -version` 5.1.9; better-sqlite3 (SQLite 3.53.2) and sharp (WebP) load; uid 10001; dist read-only, data/uploads/tmp writable; container healthy with sqlite/memory/local, /system/locales serves buildId caa1a1e1…; SIGTERM stop in 1 s; gates: invalid config → field name only, multi without shared secrets refused, env+_FILE refused, unreachable Postgres fails after 4 s; no secrets in image env/history
  - Web image: uid 10001; healthy; /join, /legal/*.txt, /locales/registry.json, template ZIP, audio manifest/credits/WebM, brand, /help/languages all 200; static chunks immutable
  - `pnpm test:contracts --runTestsByPath tests/contracts/distribution.spec.ts` → 20/20

## TASK-176 — 2026-11-12T04:58:55+07:00

- **Files**:
  - `docker/docker-compose.yml` (default: web + api with kabuki-data/kabuki-uploads volumes; scale profile: secrets-init (random credentials generated once, 0400, per-service owners), PostgreSQL 16 and Redis 7 AOF pinned by digest, MinIO built from pinned upstream source, minio-init bucket with anonymous GetObject only; API depends on scale services with `required: false`; ports bind to KN_BIND_ADDRESS; no secrets, no minioadmin)
  - `scripts/start-profile.ts` (`pnpm deploy:scale`: DEPLOYMENT_PROFILE=scale + `--profile scale` always together; `default` profile; custom compose action; sets ALLOW_INSECURE_LOCAL_HTTP=true for the bundled HTTP MinIO only when unset, with a notice; argument array, no shell)
  - `.env.example` (Compose section: KN_* URLs/ports/bind/image tag, exact scale command, no secrets, driver overrides stay commented, no data transfer on profile change)
  - `docs/deployment.md` (commands, configuration, volumes and secrets, TLS proxy, same-site Lax refresh cookie, WebSocket upgrade, polling read timeout ≥ 75 s and sticky sessions, public media, health and startup order)
  - `docker/entrypoint.sh` (scope addition: KN_SECRETS_DIR lookup of lower-case secret files when neither the variable nor `_FILE` is set)
- **Verification**:
  - `docker compose -f docker/docker-compose.yml config --quiet` → OK; `DEPLOYMENT_PROFILE=scale docker compose -f docker/docker-compose.yml --profile scale config --quiet` → OK; `pnpm deploy:scale config --quiet` → OK
  - Driver semantics: rendered API env through the real `parseEnvironment` → default sqlite/memory/local, scale postgres/redis/s3
  - Default profile smoke (`docker compose … up --no-build` with the TASK-175 images): api and web healthy, /join 200, health ok sqlite/memory/local; `down -v`

## TASK-177 — 2026-11-12T05:07:10+07:00

- **Files**:
  - `tests/integration/deployment.spec.ts` (real Compose projects `kn-it-<random>` on free loopback ports from the production images; default: cold start, uid 10001 ownership, 0600 runtime secrets, setup/quiz/media reachable by the browser URL, durable report, live room; after recreate the old access token still verifies, quiz/media/report persist, in-memory room reported lost; bundle free of secrets/credential names. Scale: secrets-init/minio-init exit 0, generated files 0400 with per-service owners, postgres/redis/s3 health, MinIO anonymous GET 200 but listing/PUT 403, two API containers migrate a fresh database concurrently with one row per version, recreate keeps shared JWT secret and media, bundle free of DB password/S3 key/JWT; teardown `down -v` of that project only)
  - `tests/integration/catalog-deployment.spec.ts` (matching pair → web healthy; API with a different valid bundle (de) → API healthy, web unhealthy; tampered bundle → API exits non-zero; rollback to the matching API → web healthy without restart; removes only its labelled containers/network)
  - `docker/Dockerfile.web` (scope addition: healthcheck = catalog-pair readiness, web registry buildId must equal the API's)
  - `docs/deployment.md` (migration lock and 60 s waiters, catalog-pair readiness and rollback, what restarts keep, verification commands)
- **Verification**:
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/deployment.spec.ts` → default and scale both pass (real runs)
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/catalog-deployment.spec.ts` → 1/1
  - no kn-it/kn-catalog containers, networks or volumes left; images rebuilt as `:local` (API with TASK-176 entrypoint, web with the readiness check)

## TASK-178 — 2026-11-12T05:12:55+07:00

- **Files**:
  - `docs/operations.md` (backup scope = SQL + blobs + generated secrets + storage-origin ledger from one point in time; DB-first online order; SQLite online backup API command and WAL-safe restore; PostgreSQL pg_dump/pg_restore and MySQL mysqldump/mysql procedures (MYSQL_PWD); volume archives; restore checklist and session/revocation policy with secret rotation; no implicit data transfer on driver/profile switch; draining and STATE_NAMESPACE; recovery limits (memory rooms lost, Redis AOF ~1 s window, failed finalization retry + 24 h alarm, storage origin registry format); audit 30 d / logs 14 d; MAX_ACTIVE_ROOMS and the 10/min/IP join budget behind NAT)
  - `tests/integration/backup-restore.spec.ts` (per dialect: documented commands executed verbatim and asserted present in the guide; quiz + image + finished report + live room → backup → post-backup changes → stop/restore/start; instance, quiz media reference, served blob, byte-identical report restored; post-backup quiz gone; pre-backup token valid; post-backup refresh 401; live room lost; PostgreSQL: switching to SQLite starts uninitialized)
  - `docs/deployment.md` (links the operations guide)
- **Verification**:
  - `pnpm test:integration --runInBand --runTestsByPath tests/integration/backup-restore.spec.ts` → 4/4 (commands documented; sqlite, postgres, mysql)

## TASK-179 — 2026-11-12T06:24:53+07:00

- **Files**:
  - `scripts/benchmark-game.ts` (`pnpm benchmark:game --clients --transitions --mode memory|redis`; isolated harness (1 node memory/SQLite, or 2 nodes PostgreSQL+Redis); distinct simulated device addresses so production limits apply; four transitions per question with every player answering; NTP-style per-client clock calibration; transport (commit serverTime → receipt), admission and state-commit latencies separated; delivery completeness, disconnects, rejected answers, report queue age; environment/versions/duration; JSON record + Markdown; non-zero exit when the target is missed; renews the host token via auth:update on long runs)
  - `tests/performance/game-benchmark.spec.ts` (clock calibration incl. asymmetric bound, latency correction, nearest-rank percentiles, summaries, delivery loss, verdict incl. dropped connections)
  - `docs/performance-results.md` (method, environment, three recorded runs and findings)
- **Verification**:
  - `pnpm test:performance -- tests/performance/game-benchmark.spec.ts` → 10/10
  - `pnpm benchmark:game --clients 200 --transitions 100 --mode memory` → PASS: transport p95 18.97 ms, 0/20400 lost, report queue 976 ms for 5000 answers; admission p50 2.0 s / p95 8.3 s (finding)
  - `pnpm benchmark:game --clients 200 --transitions 100 --mode redis` → FAIL (recorded as failure): node B dropped all 100 players, transport p95 310 ms, 28.9% delivery loss; 60-client characterization run → FAIL p95 180 ms, no disconnects
  - Findings documented (multi-node target not met on this host; per-answer full-state settle likely serializes admission; node B disconnects consistent with event-loop starvation on a shared 4-core host), not extrapolated

## TASK-180 — 2026-11-12T06:39:29+07:00

- **Files**:
  - `scripts/measure-web-budget.ts` (production `next build` + `next start` only, refuses dev markers; real API + room for M01; 5 cold Chromium runs per scenario at 390×844, 1.6 Mbps/150 ms RTT, 4× CPU, cache off; scenarios /join in en, ja, zh-Hans, de (test long-text package), ar (test RTL package) and the identity step; initial JS gzip-9 incl. framework, locale payload incl. shell + en fallback, fonts/media separate; LCP/CLS raw + median; lazy checks for dnd-kit, ZXing, confetti and avatar style chunks; JSON record with the gzip manifest + Markdown; exit 1 on any budget failure)
  - `tests/performance/web-budget.spec.ts` (classification, gzip accounting with each URL once, medians, development-build refusal, explicit failure of every threshold)
  - `docs/performance-results.md` (method, raw + median results, verdict and concrete follow-up findings per chunk/file)
- **Verification**:
  - `pnpm test:performance -- tests/performance/web-budget.spec.ts` → pass
  - `pnpm exec tsx scripts/measure-web-budget.ts --runs 5` → **FAIL recorded**: initial JS 353.8 KiB gzip > 300 KiB; identity step median LCP 4280 ms > 4000 ms. Passing: locale payloads 10.3–23.2 KiB, /join LCP 620–648 ms in all locales, CLS ≤ 0.095, lazy loading of dnd-kit/ZXing/confetti/avatar styles
  - Findings name chunks 43pd1f38gdu5b.js (zod + intl-messageformat), 02p86dr4wnlm7.js (socket.io + audio manager), 34fq-xudn5cji.js (framer-motion + DiceBear core + QR generator) and the M01 render path for follow-up atomic fixes

## TASK-181 — 2026-11-12T07:18:04+07:00

- **Files**:
  - `.github/workflows/ci.yml` (read-only token, actions pinned to commit SHAs, no publish/deploy step. Jobs:
    - verify: frozen lockfile + unchanged lockfile, native better-sqlite3/sharp load, locales validate/build, lint, typecheck, unit, `test:performance`, `test:audio`;
    - supply-chain: `pnpm audit --prod --audit-level high`, license inventory and dependency SBOM kept as artifacts;
    - drivers: real-engine `test:contracts` + `test:integration`;
    - e2e: ffmpeg + production build + Playwright, reports and the catalog pair kept;
    - docker: both Compose profiles `config --quiet`, distribution contract, API/web image builds and image inventory;
    - release-evidence: `verify-release.ts --report` on branches/PRs, strict on `v*` tags.)
  - `scripts/verify-release.ts` (release evidence gate:
    - every PRD US/AC/BR/NFR has exactly one row, no unknown IDs;
    - evidence paths exist, VERIFIED rows cite a spec or measuring script, non-VERIFIED rows need a note;
    - identical API/web locale registries;
    - performance doc records the broadcast and bundle results; a failed measurement record or recorded FAIL forbids VERIFIED NFR-01/02;
    - `release-unverified` audio forbids VERIFIED US-19/AC-19-02;
    - strict mode fails on PENDING/GAP, `--report` lists them; JSON record in `test-results/release/`.)
  - `docs/release-checklist.md` (93 rows mapping US-01–21, 44 AC, BR-01–20, NFR-01–08 to evidence: 81 VERIFIED, 8 PENDING for manual a11y/language/cloud/audio reviews, 4 GAP for measured budget misses)
  - Out of target, recorded: `apps/web/src/components/studio/slide-navigator.spec.tsx` gives its 150-slide case a 20 s limit (2.6 s alone, ~6 s with turbo running every package in parallel on 4 cores, which broke the 5 s default in `pnpm test`).
- **Verification**:
  - `pnpm install --frozen-lockfile` (lockfile unchanged), `locales:validate`, `locales:build`, `lint`, `typecheck` → pass
  - `pnpm test` → pass (web 436/436 after the timeout fix)
  - `pnpm test:performance` → pass
  - `pnpm build` → pass
  - both Compose configs → pass
  - `pnpm test:e2e` → 54/54 pass
  - `pnpm test:contracts` → pass. First full run: 22/24 suites, MinIO image could not be built behind the sandbox proxy; storage + driver-matrix reran with `KABUKI_TEST_MINIO_IMAGE` 20/20.
  - `pnpm test:integration` → first full run 15/20 suites (MinIO builds). The 5 suites reran with the local MinIO image: 43/44. Remaining: `system.spec` cleanup partial failure, the known root-container limitation (`chmod 0555` is ineffective as uid 0), already noted for earlier tasks.
  - `pnpm exec tsx scripts/verify-release.ts` → exit 1, BLOCKED with 0 errors and 12 release gaps (PENDING/GAP listed); `--report` → exit 0
  - Negative check on a temporary copy: a missing row, a missing evidence file, VERIFIED NFR-01 with failed measurements, VERIFIED US-19 with unverified audio and a missing registry are each rejected
  - Remaining release gaps (truthfully not verified):
    - manual assistive-technology review;
    - native-speaker language review;
    - AWS S3/R2/Spaces (no credentials);
    - audio distribution rights (OpenTracks permission, TASK-114A);
    - NFR-01 two-node broadcast and NFR-02 bundle/LCP budgets

## TASK-182 — 2026-11-12T07:24:42+07:00

- **Files**:
  - `docs/self-hosting.md` (bilingual Indonesian + English operator guide:
    - requirements (Compose v2.24+, measured idle RAM, disk) and download by release tag;
    - `cp .env.example docker/.env` with only the public address to change; instance name at `/setup`; no secrets in `.env`;
    - default vs scale profile and first-run setup;
    - optional HTTPS override;
    - named-volume data locations (the compose file uses named volumes, not `docker/data`/`docker/uploads` folders; documented as they are);
    - upgrade with automatic leader-locked migrations, backup/restore via operations.md, smoke test;
    - troubleshooting: ports, wrong public URL, same-site cookie, ORIGIN_DENIED/CORS, S3 HTTP refusal, unhealthy containers, proxy CIDRs, certificates;
    - limits: in-memory rooms lost on restart, capacity not a certification with measured results, one API node, no registry images;
    - audio-rights warning (release-unverified, OpenTracks permission))
  - `docker/docker-compose.tls.yml` (Caddy pinned by digest:
    - only Caddy publishes 80/443(+udp); API/web/MinIO ports reset;
    - one origin `https://KN_DOMAIN` for the API env and the web build args;
    - TRUST_PROXY_CIDRS = Caddy's fixed address /32 on a private `edge` network;
    - cap_drop ALL + NET_BIND_SERVICE, read-only rootfs, certificate volumes)
  - `docker/Caddyfile` (automatic TLS for `{$KN_DOMAIN}`; routing:
    - `/socket.io` → API, with cookie affinity, flush and a 120 s read timeout;
    - `/api` and `/uploads` → API; `/kabuki-neko-media` → MinIO; everything else → web.
    HSTS only, no CSP override, admin endpoint off, no access log; `caddy fmt` clean)
  - `scripts/selfhost-smoke.sh` (bash `set -euo pipefail`, no sudo:
    - isolated `kn-smoke-*` project (refuses other names) on random free ports;
    - modes `--profile scale`, `--tls`, `--no-build`;
    - checks `/`, setup-status, `/join`, then first-run setup (password on stdin), restart, persisted setup and admin sign-in;
    - teardown `down` keeps volumes unless `--purge`, which removes only the smoke project's)
  - Required by the spec/DoD outside the target list:
    - `README.md` (new; links the guide, as the spec requires "README menautkan panduan");
    - `.env.example` (HTTPS override variables, so every variable the guide names is in `.env.example`)
- **Verification**:
  - `docker compose -f docker/docker-compose.yml -f docker/docker-compose.tls.yml config --quiet` (with KN_DOMAIN) → pass. Without KN_DOMAIN it refuses with a clear message. Scale + TLS rendered: only caddy publishes ports, trusted proxy `/32`.
  - `caddy validate` via the pinned caddy 2.11.9 container → Valid configuration, no format warning
  - Clean checkout (fresh clone + images built from it): `bash scripts/selfhost-smoke.sh` → PASS for the default profile, `--tls` (Caddy, KN_DOMAIN=localhost) and `--profile scale`; no kn-smoke containers, volumes or networks left after `--purge`
    - Images were built with `docker build` plus the sandbox proxy CA secret, then run with `--no-build`; Compose `--build` cannot pass that CA in this sandbox.
  - Every environment variable named in the guide/README is present in `.env.example`; all relative links and anchors resolve; secret scan of the new files finds no credential (only the runtime-generated throwaway smoke password)
  - Prettier check of the markdown/YAML → pass; `verify-release --report` → 0 errors, 12 known gaps

## TASK-183: Hentikan full-state settle di setiap admission jawaban — DONE
- **Date**: 2026-11-12 (Asia/Jakarta)
- **Files**:
  - `apps/api/src/modules/game-engine/game.service.ts`: `settle` is per-room single-flight and coalesced. A caller that arrives while a round runs shares one queued round that starts after it. The slot map is emptied as soon as no round is pending (no per-room leak, cf. MJ-05). The scoring body moved unchanged to `settleOnce`.
  - `apps/api/src/modules/game-engine/game.service.spec.ts`: new case. 50 concurrent answers make ≤ 3 full-state reads (2 settle rounds + the `finalize` read after the commit) and exactly one COMMITTED. The closing answer is scored before the ACKs resolve, and a later `settle` starts a fresh round.
- **Deviation from the task text**: the ACK still awaits its coalesced round instead of running settle in the background. The gateway publishes right after the ACK (`game.gateway.ts`, `player:submit_answer`), so a background settle would delay the closing answer's reveal to the next scheduler tick and break the task's own invariant.
- **Verification**:
  - New spec PASS; the same spec on the old `game.service.ts` FAIL (51 full-state reads).
  - Docker daemon had stopped (container restart) and was started again before the API tests.
  - `pnpm --filter @kabuki-neko/api lint` → pass.
  - `pnpm --filter @kabuki-neko/api typecheck` → pass.
  - `pnpm --filter @kabuki-neko/api test` → 37/37 suites, 254/254 tests.
  - `pnpm test:integration --testPathPatterns='recovery|realtime-races|game-gateway|finalization-failures'` → 4/4 suites, 33/33 tests.
  - `pnpm benchmark:game --clients 200 --transitions 100 --mode memory`:

    | | Transport p95 | Admission p50 | Admission p95 | Rejected answers |
    | --- | --- | --- | --- | --- |
    | Before (2026-11-12 QA run) | 20.59 ms | 2,014.84 ms | 8,427.85 ms | 1 |
    | After | 15.88 ms (PASS) | 2,127.99 ms | 9,437.25 ms | 13 of 5,000 (TIME_EXPIRED near the deadline) |

- **Finding**:
  - Admission latency did **not** improve, so full-state settle reads were not its bottleneck. `performance-results.md` Findings item 2 is disproven as the main cause.
  - The ACK awaits `GameGateway.publish`, which runs one full `diff` per answer: a private-state read, the host projection, and the summary of every player.
  - The diffs are serialized per room by `enqueue`, so the N-th answer of a burst waits for N diffs.
  - This is in `game.gateway.ts`, outside this task's target files. Corrective task TASK-183A was added.

## TASK-183A: Gabungkan publish gateway per room dan lepaskan ACK jawaban dari antrean publish — DONE
- **Date**: 2026-11-12 (Asia/Jakarta)
- **Files**:
  - `apps/api/src/modules/game-engine/game.gateway.ts`:
    - `publish` is coalesced per room (`pendingPublishes`): a call made while a publish of the room is queued but not started shares it, so at most one diff runs and one waits. `forget` keeps its place after the publishes queued before it, and both maps are empty when idle.
    - `player:submit_answer` returns its ACK without awaiting the publish; the publish is still started, and a missed one is caught by the `room:version` heartbeat.
  - `apps/api/src/modules/game-engine/game-gateway-publish.spec.ts` (new): three cases.
    - 50 publishes during a running diff → 2 diffs, maps empty afterwards.
    - `room:expired` after the queued publishes.
    - The answer ACK resolves while the publish's state read is still held.
- **Verification**:
  - New spec 3/3 PASS; the same spec on the old gateway 3/3 FAIL.
  - `pnpm --filter @kabuki-neko/api lint` → pass; `typecheck` → pass.
  - `pnpm --filter @kabuki-neko/api test` → 38/38 suites, 257/257 tests.
  - `pnpm test:integration --testPathPatterns='game-gateway|realtime-races|recovery|payload-privacy|room-retention'` → 5/5 suites, 40/40 tests.
  - `pnpm test:e2e tests/e2e/player.spec.ts tests/e2e/host.spec.ts` → 9/9 (with first-run).
  - `pnpm benchmark:game --clients 200 --transitions 100 --mode memory`:

    | | Transport p95 | Admission p50 | Admission p95 | Rejected answers |
    | --- | --- | --- | --- | --- |
    | Before (TASK-183) | 15.88 ms | 2,127.99 ms | 9,437.25 ms | 13 |
    | After | 13.37 ms (PASS) | 2,379.49 ms | 9,157.73 ms | 0 of 5,000 |

- **Finding**:
  - Admission latency is still unchanged. Neither the settle reads (TASK-183) nor the per-answer diff publishes are its bottleneck.
  - Remaining candidates:
    - the server event loop being busy elsewhere (scheduler ticks, Zod parsing per request, the heartbeat);
    - the load generator, which runs 200 clients in the same 4-core host.
  - Telling these apart needs the per-node event-loop and CPU diagnostics planned in TASK-184. TASK-185 then sets the root cause. No speculative change was made here.

## TASK-184: Tambah diagnostik per node dan verdict jujur pada benchmark — DONE
- **Date**: 2026-11-12 (Asia/Jakarta)
- **Files**:
  - `scripts/lib/event-loop-probe.cjs` (new). The benchmark's own API children load it with `NODE_OPTIONS=--require`; production images never do. Once per second it writes a `KN_PROBE {json}` line:
    - event-loop delay p50/p99/max from `monitorEventLoopDelay`, with the 10 ms sampling resolution subtracted so an idle loop reads ≈ 0;
    - CPU as % of one core from `process.cpuUsage` deltas;
    - heap in use.
    The timer is unref'd.
  - `scripts/benchmark-game.ts`:
    - Local nodes start with the probe (`startApi` already passes the parent environment, so the test helpers are unchanged; `NODE_OPTIONS` is restored afterwards).
    - The load generator samples itself the same way.
    - Every dropped player connection records its node and Socket.io reason, plus clients per node and the first disconnect time.
    - The record adds `diagnostics.nodes[]`: clients, measured flag, lag/CPU/heap and disconnects by reason. It also adds `diagnostics.loadGenerator` and `disconnectsFirstAtMs`.
    - The Markdown adds a per-process table.
    - `--api-urls a[,b]` (+ `--origin`, `KN_BENCH_HOST_EMAIL`/`_PASSWORD`) uses running nodes instead of a local harness, so the load generator can run on another machine. External nodes are marked "not measured".
    - Verdict (MN-43): answers not admitted and a report that never became durable are FAIL reasons.
  - `tests/performance/game-benchmark.spec.ts`: new cases for probe-line parsing and its window, per-process aggregation, disconnects per node/reason, `--api-urls` validation, and the MN-43 verdict reasons.
- **Verification**:
  - `pnpm test:performance -- tests/performance/game-benchmark.spec.ts` → 22/22.
  - `pnpm exec eslint scripts tests/performance` → pass.
  - `pnpm exec tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target es2023 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --types node scripts/benchmark-game.ts tests/performance/game-benchmark.spec.ts` → pass. There is no workspace typecheck target for `scripts/`; this mirrors the strict base config.
  - Prettier check of the three files → pass.
  - Probe sanity: an idle process reads lag p99 ≈ 0.7 ms, and a 300 ms busy loop reads `lagMaxMs` 298.5.
  - `pnpm benchmark:game --clients 20 --transitions 10 --mode redis --out test-results/benchmark/redis-short.json` → PASS, with the per-process table:
    - API node A: lag p99 median 2.55 ms, CPU mean 8.5%;
    - API node B: lag p99 median 0.96 ms;
    - load generator: lag p99 median 0.62 ms, CPU 1%;
    - 0 disconnects; admission p50 15.85 ms at 20 clients.
  - Not run: a live `--api-urls` run against nodes on another machine (no second machine here). The path is covered by the unit validation only.

## TASK-185: Ukur ulang topologi Redis dua node dan tetapkan akar masalah — DONE
- **Date**: 2026-11-12 (Asia/Jakarta)
- **Files**:
  - `docs/performance-results.md`: new section "Re-measurement and root cause".
  - `docs/vibe/07-qa-report.md`: US-20 note.
  - Scope extension, recorded because the DoD needs a redis record that the harness kept losing:
    - `scripts/benchmark-game.ts`: a host command without an ACK is retried and recorded, and a failed step ends the run early with `abortReason`. A node that dies has its exit code and last output in the record. A run that cannot finish carries each node's last output in the error.
    - `tests/performance/game-benchmark.spec.ts`: verdict case for `abortReason`.
  - `docs/vibe/04-tasks.md`: corrective tasks TASK-185A (crash), TASK-185B–D (publish path, settle read) and TASK-185E (re-measure).
- **Runs** (same 4-core host, loopback):
  - **Memory, 200 clients, 100 transitions** → FAIL (10 answers not admitted).
    - Transport p95 14.36 ms; admission p50 2,800 ms / p95 10,973 ms.
    - API loop lag max 4,905 ms, with only 268 of ~459 probe samples (loop blocked).
    - Load generator lag max 31 ms, CPU 1.5%.
  - **Redis, 200 clients, 100 transitions** → FAIL.
    - Transport p95 300.87 ms; delivery loss 28.9%; 2,469 answers not admitted.
    - Node B lost all 100 players at 412 s. Its probe stopped at 389 samples.
  - Two further redis runs did not finish: one host command got no ACK, and one REST call hit a node that was gone. This led to the harness changes above.
  - **Redis, 200 clients, 60 transitions** (crash capture): node A exited with code 1 after an unhandled `Error: Command timed out` from ioredis.
  - CPU profile (memory, 200 clients, 8 transitions): busy time is in the gateway `diff`:
    - `structuredClone` in `getPrivateSnapshot` ≈2.4 s, including settle;
    - `projectHost` grapheme/Zod ≈0.6 s;
    - per-player `projectPlayer` at reveal/podium ≈0.6 s.
- **Root cause** (server defects, conclusion (b)):
  1. `@socket.io/redis-adapter` 8.3.0 calls `pubClient.publish` without catching it, and the pub client has `commandTimeout: 2000`. A stalled loop or a Redis outage therefore crashes the API node.
  2. The publish path blocks the event loop for seconds, and the cost grows with the number of played questions.
- **Verification**:
  - `pnpm test:performance -- tests/performance/game-benchmark.spec.ts` → 22/22.
  - `pnpm exec eslint scripts tests/performance` → pass; tsc (strict, commonjs) for the script → pass.
  - `pnpm exec prettier --check docs/performance-results.md` → pass.
  - Records `test-results/benchmark/memory.json` and `redis.json` are referenced from the doc (copies in the session scratchpad).
