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
