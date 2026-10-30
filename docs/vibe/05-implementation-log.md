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
