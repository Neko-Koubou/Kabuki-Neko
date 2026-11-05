# 00 — Project Context: Kabuki Neko

Tanggal inspeksi: 2026-10-28 (Asia/Jakarta). Status: **Greenfield / specification only**.

## 1. Identitas, visi, dan sumber kebenaran

Kabuki Neko adalah platform kuis web real-time untuk penggunaan pribadi, pendidikan, komunitas, dan internal perusahaan. Prinsip produk: **Zero-Config Default, Enterprise Scalable**. Arsitektur yang diminta: modular full-stack TypeScript monorepo, namespace `@kabuki-neko/*`.

Sumber kebutuhan: [01-prd.md](01-prd.md), termasuk seluruh batasan bisnis, visual, kontrak, dan roadmap di dalamnya. Kebijakan distribusi yang diminta pengguna adalah source-available Apache 2.0 with Commons Clause, dengan tujuan penggunaan nonkomersial/no-resale sebagaimana dinyatakan PRD; dokumen konteks ini tidak menyusun teks lisensi baru.

Hasil inspeksi: hanya `docs/vibe/01-prd.md` dan metadata Finder `.DS_Store` yang ada sebelum init. Tidak ditemukan kode aplikasi, manifest dependency, lockfile, konfigurasi lint/test, Dockerfile, environment example, maupun direktori `.git`. Tidak ada `prd.md`, `PRD.md`, atau `docs/prd.md` alternatif. Struktur pada PRD adalah **target**, bukan implementasi yang telah tersedia.

## 2. Tech stack matrix

| Lapisan | Ketentuan dari PRD / status keputusan |
| --- | --- |
| Bahasa dan runtime | TypeScript strict; Node.js, versi runtime dan package manager akan dipin saat bootstrap setelah pemeriksaan kompatibilitas |
| Workspace | pnpm workspaces + Turborepo |
| Frontend | Next.js 15+ App Router, React 19, Tailwind CSS, Shadcn UI |
| Interaksi dan state | Framer Motion, Howler.js, DiceBear, Zustand, Zod, React Hook Form, socket.io-client, dnd-kit, canvas-confetti |
| Backend | NestJS 11+, Express, REST `/api/v1`, Socket.io namespace `/game` |
| Autentikasi | JWT access/refresh, passport-jwt; password Argon2id atau bcrypt sesuai keputusan arsitektur |
| Database | SQLite/better-sqlite3 default; PostgreSQL/pg atau MySQL/mysql2 melalui `DB_DRIVER` |
| ORM | PRD mengizinkan Drizzle atau TypeORM Dynamic Adapter Factory; pemilihan final di tahap vibe-sa, wajib mendukung ketiga dialek |
| State sementara | In-memory default; Redis/ioredis dan Socket.io Redis adapter untuk multi-instance |
| Media | Local directory default; S3-compatible untuk MinIO, R2, AWS S3, DigitalOcean Spaces; Sharp dan validasi magic bytes |
| Testing | Playwright E2E ditentukan PRD; usulan tooling unit/integration: Vitest frontend/shared, Jest + Supertest backend; finalisasi di vibe-sa |
| Lint dan format | Usulan ESLint + Prettier; belum ada konfigurasi atau dependency terpasang |
| Deploy | Docker Compose default web/api; profile scale menambahkan PostgreSQL, Redis, MinIO dan bucket init |
| Message broker | Tidak ada broker terpisah yang diminta; Redis adapter mendistribusikan event antar-instance |

Batas versi di atas disalin dari PRD, bukan klaim versi terbaru. Jangan mengganti stack atau mengurangi cakupan adapter tanpa perubahan spesifikasi yang eksplisit.

## 3. Struktur dan konvensi target

```text
apps/web/           # UI publik, player, host, auth, dashboard, studio
apps/api/           # config, common, providers, modules
packages/shared/    # Zod schemas, constants, DTO, socket contracts
packages/database/  # schema dan migrasi per dialek
packages/tsconfig/  # konfigurasi TypeScript bersama
docker/            # Dockerfiles dan docker-compose.yml
docs/vibe/         # artefak pipeline 00–07
```

- File/folder: `kebab-case`; komponen dan class: `PascalCase`; variabel/fungsi: `camelCase`; kolom DB: `snake_case`; enum/konstanta sesuai kontrak PRD.
- Web tidak mengakses database, secret, atau implementasi adapter. Shared tidak bergantung pada web/api atau membocorkan kode server ke browser.
- Logika kuis, penilaian, otorisasi, dan transisi state berada di server; driver database/storage/state diisolasi melalui adapter dan NestJS DI.
- UUID dihasilkan aplikasi; migrasi dan serialisasi harus setara di SQLite/PostgreSQL/MySQL. Notasi `UUID()`/`NOW()` dalam tabel PRD merupakan default konseptual, bukan SQL lintas-dialek yang siap dijalankan.
- Baca konteks dan artefak upstream sebelum implementasi. Tahap init/PRD/design/SA/tasks tidak menulis aplikasi. Tahap code hanya mengerjakan TASK-XXX terpilih dan memperbarui log serta checklist setelah verifikasi.

## 4. Verification commands

**Belum dapat dijalankan sebagai verifikasi proyek**: manifest, script, lockfile, aplikasi, dan test belum tersedia. Berikut kontrak perintah yang harus disediakan tahap bootstrap, bukan hasil pengujian.

| Tujuan | Perintah dari root workspace |
| --- | --- |
| Install awal | `pnpm install` |
| Install CI setelah lockfile tersedia | `pnpm install --frozen-lockfile` |
| Build | `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Unit test | `pnpm test` |
| Integration test | `pnpm test:integration` |
| Browser E2E | `pnpm test:e2e` |
| Validasi Compose | `docker compose -f docker/docker-compose.yml config --quiet` |
| Jalankan default | `docker compose -f docker/docker-compose.yml up -d` |
| Jalankan scale | `docker compose -f docker/docker-compose.yml --profile scale up -d` |

Bentuk singkat `docker compose up -d` pada PRD berlaku dari direktori `docker/`; pemetaan volume harus didokumentasikan sesuai lokasi file Compose. Profile scale juga harus memilih driver yang sesuai, bukan hanya menyalakan container tambahan.

## 5. Global non-negotiables

- TypeScript strict; tidak ada `any` pada kontrak baru, gunakan `unknown` dengan validasi/narrowing. Validasi semua boundary HTTP, Socket.io, environment, dan import.
- Tidak ada SQL tak terparameterisasi, secret hardcoded, password plaintext, token dalam log, atau kunci jawaban dalam payload player sebelum reveal.
- Otorisasi role dan kepemilikan resource di server, termasuk setiap aksi host; JWT valid saja tidak cukup.
- Server menguasai timer/skor; jawaban duplikat tidak menambah skor. Implementasi multi-instance harus menjaga penerimaan jawaban dan transisi state secara atomik.
- Unggahan dibatasi ukuran, tipe dan signature; tidak menerima SVG arbitrer. Penghapusan media tidak boleh merusak referensi kuis atau sesi aktif.
- Default deployment harus persisten untuk SQLite, uploads, dan secret yang dihasilkan; contoh credential di PRD bukan credential produksi.
- Target PRD: broadcast p95 <50ms untuk 200 klien per room; pengukuran harus mencatat kondisi jaringan, hardware dan beban. Dukungan ribuan peserta belum merupakan hasil benchmark.
- Warna jawaban selalu disertai simbol geometris; interaksi memiliki akses keyboard dan label yang dapat dibaca teknologi bantu.

## 6. Keputusan bisnis dikonfirmasi 2026-10-28

1. Input pemain ditutup saat timer habis; penerimaan paket terlambat berlangsung 1.500ms sebelum reveal.
2. MULTIPLE_SELECT parsial tanpa opsi salah memperoleh skor parsial, menaikkan streak, dan mendapat bonus streak.
3. CREATOR boleh melihat, menduplikasi, dan menjadi host kuis PUBLIC milik kreator lain; edit/hapus hanya oleh pemilik.
4. Seluruh UI web mendukung multibahasa dan bahasa tambahan melalui paket terjemahan yang dapat ditambahkan pengguna/pengelola instalasi. Bahasa awal: Inggris (`en`), Indonesia (`id`), Jepang (`ja`), Mandarin Simplified (`zh-Hans`), Spanyol (`es`), dan Prancis (`fr`). Pilihan Simplified adalah baseline desain untuk permintaan “china”; Traditional dapat ditambahkan sebagai paket terpisah. Detail kebutuhan dan acceptance criteria: PRD §19 / US-21.

## 7. Status pipeline dan langkah berikutnya

Stage 0 dan Stage 1 selesai. Stage 2 tersedia pada [02-design-spec.md](02-design-spec.md); tambahan multibahasa pengguna dicatat pada PRD §19 / US-21 dan dokumen desain. Tidak perlu mengimpor ulang PRD. Review PRD dan desain, lalu clear context (`/clear`) dan jalankan `$vibe-sa` sebelum perencanaan implementasi. Belum ada kode aplikasi atau hasil QA aplikasi.
