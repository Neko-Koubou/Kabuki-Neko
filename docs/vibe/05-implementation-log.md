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
