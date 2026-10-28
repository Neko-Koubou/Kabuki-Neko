# PRODUCT REQUIREMENTS DOCUMENT (PRD)
**Project Name:** Kabuki Neko  
**Package Namespace:** `@kabuki-neko/*`  
**Document Version:** 1.2.0
**Normalized:** 2026-10-28 — mengikuti PRD 1.1.0 dan klarifikasi pengguna; detail asli dipertahankan, tambahan terstruktur di §13–18.  
**Architecture Paradigm:** Modular Full-Stack TypeScript Monorepo  
**Primary Tech Stack:** Next.js (App Router) + NestJS + Socket.io  
**Distribution & License Target:** Source-Available (Apache 2.0 with Commons Clause — Free for Personal & Internal Corporate Use, Strictly Non-Commercial / No-Resale)

---

## 1. EXECUTIVE SUMMARY, VISION & LICENSING POLICY

### 1.1. Problem Statement
Platform kuis interaktif *real-time* komersial (seperti Kahoot!, Mentimeter, atau Quizizz) membatasi jumlah peserta pada paket gratis, mengunci fitur kustomisasi media di balik *paywall* mahal, serta menyimpan data pengguna di *cloud* tertutup. Alternatif yang ada saat ini umumnya sulit di-*deploy*, terpaku pada satu jenis database tertentu, atau tidak memiliki manajemen aset media (*Object Storage*) yang siap untuk skala produksi.

### 1.2. Product Vision
Membangun **Kabuki Neko**, aplikasi web kuis *real-time* bergaya Kahoot! dengan sentuhan karakter maskot kucing kabuki yang ekspresif, *type-safe*, dan menganut filosofi **"Zero-Config Default, Enterprise Scalable"**:
1. **Zero-Config Default:** Pengguna rumahan, guru, komunitas, atau tim internal kantor dapat menyalakan seluruh aplikasi hanya dengan satu perintah Docker menggunakan **SQLite**, **In-Memory State**, dan **Local Directory Storage** tanpa perlu mengonfigurasi server eksternal.
2. **Enterprise Scalable:** Saat dibutuhkan untuk skala ratusan hingga ribuan peserta (seperti *Townhall* perusahaan atau acara kampus), administrator cukup mengubah variabel `.env` untuk mengalihkan *driver* secara dinamis ke **PostgreSQL / MySQL**, **Redis Cluster**, serta **MinIO / Cloudflare R2 / AWS S3** tanpa mengubah satu baris kode pun.

### 1.3. User Personas & Roles
| Role ID | Nama Peran | Deskripsi & Hak Akses Utama |
| :--- | :--- | :--- |
| `SUPERADMIN` | Server Maintainer | Mengelola konfigurasi global instansi **Kabuki Neko**, kebijakan registrasi pengguna, batas ukuran unggahan file, memantau kesehatan storage/DB, dan menjalankan *Orphaned Media Garbage Collector*. |
| `CREATOR` | Quiz Maker / Host | Membuat, mengedit, mengimpor/mengekspor kuis di **Quiz Studio**, mengunggah gambar/audio/video, membuka sesi permainan langsung (*Live Host*), memoderasi lobi, dan mengunduh laporan analitik peserta. |
| `PLAYER` | Peserta Kuis (Guest) | Masuk ke sesi permainan tanpa registrasi akun menggunakan **6-Digit Game PIN** atau **QR Code**, memodifikasi avatar unik **DiceBear**, menjawab pertanyaan secara *real-time* via perangkat mobile/desktop, dan memulihkan sesi jika koneksi terputus. |

### 1.4. Licensing & Distribution Policy (Non-Commercial / No-Resale)
Proyek **Kabuki Neko** didistribusikan menggunakan skema **Apache License 2.0 with Commons Clause (Non-Commercial / No-Resale Source-Available License)** yang wajib disertakan di dalam file `LICENSE` pada *root* repositori dan ditampilkan pada *footer* serta halaman *About* di Admin Panel:
* **Hak yang Diizinkan (Permitted Uses):**
  * **Bebas Fork & Modifikasi:** Siapa pun berhak melakukan *fork*, memodifikasi kode sumber, menambahkan fitur, dan menyesuaikan tema untuk kebutuhan sendiri.
  * **Penggunaan Pribadi & Komunitas:** Bebas digunakan dan di-*self-host* untuk keperluan pribadi, sekolah, universitas, komunitas, dan organisasi nirlaba.
  * **Penggunaan Internal Perusahaan (Internal Corporate Use):** Perusahaan atau badan usaha diperbolehkan melakukan *self-hosting* **Kabuki Neko** untuk keperluan internal mereka sendiri (misalnya: *onboarding* karyawan, kuis *gathering/townhall* kantor, atau pelatihan internal) selama aksesnya tidak dipungut biaya.
* **Larangan Keras (Prohibited Commercial Uses):**
  * **Dilarang Memperjualbelikan (No Resale):** Dilarang menjual kode sumber, *binary*, atau paket instalasi **Kabuki Neko** (baik versi asli maupun hasil *fork*/modifikasi) kepada pihak mana pun.
  * **Dilarang Menjadikan Paid SaaS / Commercial Hosting:** Dilarang menawarkan **Kabuki Neko** sebagai layanan berbayar (*Software-as-a-Service*), menyewakan akses kuis berbayar, atau memonetisasi aplikasi secara komersial.
  * **Kewajiban Atribusi:** Setiap hasil *fork* atau pendistribusian ulang kode sumber wajib mempertahankan pemberitahuan hak cipta dan lisensi asli **Kabuki Neko**.

---

## 2. SYSTEM ARCHITECTURE & MONOREPO SPECIFICATION

### 2.1. Tech Stack Lock (Strict)
* **Monorepo Manager:** `pnpm` workspaces + `Turborepo`
* **Frontend (`apps/web`):** Next.js 15+ (App Router, React 19), TypeScript, Tailwind CSS, Shadcn UI, Framer Motion (animasi transisi & podium), Howler.js (audio engine), `@dicebear/core` & `@dicebear/collection` (avatar SVG deterministik), `socket.io-client`, `zustand` (state management klien), `zod` + `react-hook-form`.
* **Backend (`apps/api`):** NestJS 11+, TypeScript, `@nestjs/platform-express`, `@nestjs/websockets` + `socket.io`, `@nestjs/jwt` + `passport-jwt`, `@nestjs/throttler` (rate limiting), `sharp` (kompresi gambar ke WebP), `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (MinIO/R2/S3 adapter).
* **Database Layer (`packages/database`):** Drizzle ORM (atau TypeORM dengan *Dynamic Adapter Factory*) yang mendukung 3 dialek runtime: `sqlite` (`better-sqlite3`), `postgres` (`pg`), dan `mysql` (`mysql2`).
* **Shared Contracts (`packages/shared`):** Skema validasi `zod`, konstanta sistem, tipe DTO, dan kontrak *payload* event Socket.io yang digunakan bersama oleh `apps/web` dan `apps/api`.

### 2.2. Monorepo Directory Structure
```text
kabuki-neko/
├── apps/
│   ├── web/                                  # Next.js Frontend Application (Port 3000)
│   │   ├── public/
│   │   │   ├── audio/                        # Default BGM & SFX (lobby.mp3, tick.mp3, reveal.mp3, podium.mp3)
│   │   │   └── brand/                        # Kabuki Neko SVG Mascot, Logo, & Favicon
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (public)/                 # Landing page & PIN/QR Join Screen (/join)
│   │   │   │   ├── (player)/                 # Player Experience (/play/[pin])
│   │   │   │   ├── (host)/                   # Host Projector Experience (/host/[sessionId])
│   │   │   │   ├── (auth)/                   # Login, Register, & First-Run Setup Wizard (/setup)
│   │   │   │   └── (dashboard)/              # Creator & Superadmin Panel (/dashboard/*, /studio/[quizId])
│   │   │   ├── components/
│   │   │   │   ├── ui/                       # Base Shadcn UI primitives
│   │   │   │   ├── studio/                   # Slide Editor, Media Picker, Question Config Panel
│   │   │   │   ├── host/                     # Lobby Grid, Question Projector, Answer Bar Chart, Podium
│   │   │   │   └── player/                   # DiceBear Customizer, Geometric Answer Pad, Feedback Overlay
│   │   │   ├── hooks/                        # useSocket, useAudioEngine, useSessionRecovery
│   │   │   ├── stores/                       # Zustand stores (useGameStore, useStudioStore)
│   │   │   └── lib/                          # API fetchers, DiceBear SVG renderer, utils
│   │   └── package.json
│   │
│   └── api/                                  # NestJS Backend & WebSocket Engine (Port 3001)
│       ├── src/
│       │   ├── common/                       # Guards, Decorators, Filters, Pipes (ZodValidationPipe)
│       │   ├── config/                       # Env validation schema (Zod)
│       │   ├── providers/
│       │   │   ├── database/                 # Dynamic Multi-DB Module (SQLite | Postgres | MySQL)
│       │   │   ├── storage/                  # Dynamic Storage Module (Local FS | S3/MinIO/R2)
│       │   │   └── state/                    # Dynamic Ephemeral State Module (In-Memory Map | Redis)
│       │   ├── modules/
│       │   │   ├── auth/                     # JWT Auth, Refresh Token, First-Run Setup
│       │   │   ├── users/                    # User Management & Instance Registration Policy
│       │   │   ├── quizzes/                  # Quiz & Question CRUD, JSON/CSV Import & Export
│       │   │   ├── media/                    # Upload, Sharp WebP Optimization, Orphan Cleanup
│       │   │   ├── game-engine/              # Socket.io Gateway, State Machine, Score Calculator
│       │   │   ├── reports/                  # Post-Game Analytics, Player Logs, CSV Export
│       │   │   └── system/                   # Healthcheck, Storage Metrics, Global Settings, License Info
│       │   └── main.ts
│       └── package.json
│
├── packages/
│   ├── shared/                               # @kabuki-neko/shared
│   │   ├── src/
│   │   │   ├── constants/                    # Enums (QuestionType, GameState, Colors, ScoringRules)
│   │   │   ├── schemas/                      # Zod DTO schemas (Auth, Quiz, Question, Socket Payloads)
│   │   │   ├── socket-events.ts              # Typed Socket.io ClientToServer & ServerToClient interfaces
│   │   │   └── index.ts
│   │   └── package.json
│   ├── database/                             # @kabuki-neko/database
│   │   ├── src/
│   │   │   ├── schema/                       # Dialect-agnostic table definitions
│   │   │   ├── migrations/                   # Auto-migration runner per dialect
│   │   │   └── index.ts
│   │   └── package.json
│   └── tsconfig/                             # Shared TypeScript configurations
│
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   └── docker-compose.yml
├── LICENSE                                   # Apache 2.0 with Commons Clause (Non-Commercial / No-Resale)
├── .env.example
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 3. CORE INFRASTRUCTURE ADAPTERS SPECIFICATION

Sistem wajib mengimplementasikan **Adapter Pattern** melalui *Dependency Injection* NestJS agar *driver* infrastruktur dapat diganti sepenuhnya melalui variabel `.env`.

### 3.1. Dynamic Database Provider (`DB_DRIVER`)
Aplikasi membaca variabel `DB_DRIVER` (`sqlite` | `postgres` | `mysql`) saat *bootstrap*:
* **Rules untuk Cross-Dialect Compatibility:**
  * Gunakan `UUID` (disimpan sebagai `VARCHAR(36)` pada SQLite/MySQL dan `UUID` pada Postgres) yang di-*generate* di level aplikasi (`crypto.randomUUID()`) agar tidak bergantung pada fungsi ekstensi database spesifik.
  * Gunakan kolom tipe `TEXT` (dengan serialisasi JSON otomatis di ORM) untuk menyimpan struktur array/objek ringan, serta `BIGINT` atau *ISO-8601 Timestamp* yang seragam di ketiga database.
  * Jalankan migrasi otomatis saat aplikasi menyala jika `DB_AUTO_MIGRATE=true`.

### 3.2. Dynamic Media Storage Adapter (`STORAGE_DRIVER`)
Semua operasi file wajib melewati kontrak `IStorageAdapter` (Token DI: `STORAGE_ADAPTER`):

```typescript
export interface UploadOptions {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  folder: 'covers' | 'questions' | 'audio' | 'video';
}

export interface StorageResult {
  key: string;        // e.g., "questions/550e8400-e29b-41d4-a716-446655440000.webp"
  publicUrl: string;  // Full accessible URL
  sizeBytes: number;
  mimeType: string;
}

export interface IStorageAdapter {
  upload(options: UploadOptions): Promise<StorageResult>;
  delete(key: string): Promise<void>;
  getSignedUploadUrl?(key: string, mimeType: string, expiresInSec: number): Promise<string>;
  checkHealth(): Promise<{ status: 'up' | 'down'; details?: string }>;
}
```

1. **`LocalStorageAdapter` (`STORAGE_DRIVER=local`):**
   * Menyimpan file ke direktori lokal yang ditentukan oleh `LOCAL_STORAGE_PATH` (default: `./uploads`).
   * Otomatis membuat sub-folder (`covers`, `questions`, `audio`, `video`) jika belum ada.
   * Menyajikan file secara statis melalui endpoint NestJS `/uploads/*` dengan header `Cache-Control: public, max-age=31536000, immutable`.
2. **`S3StorageAdapter` (`STORAGE_DRIVER=s3`):**
   * Menggunakan `@aws-sdk/client-s3`. Kompatibel penuh dengan **MinIO**, **Cloudflare R2**, **AWS S3**, dan **DigitalOcean Spaces**.
   * Konfigurasi wajib mendukung `S3_FORCE_PATH_STYLE=true` (krusial agar url *bucket* MinIO lokal `http://minio:9000/kabuki-neko-media/key` tidak error karena resolusi DNS *virtual-hosted style*).
   * Menggunakan variabel `S3_PUBLIC_URL` untuk merakit URL publik aset yang dikirim ke klien.
3. **Media Optimization Pipeline:**
   * Setiap unggahan gambar (`image/jpeg`, `image/png`, `image/webp`) wajib diproses terlebih dahulu oleh `sharp`: diubah ukurannya agar dimensi terpanjang maksimal `1920px` (tanpa *upscaling*) dan dikonversi ke format **WebP** (`quality: 82`) sebelum diteruskan ke `IStorageAdapter.upload()`.
   * Unggahan audio (`audio/mpeg`, `audio/ogg`, `audio/wav`) dan video (`video/mp4`, `video/webm`) divalidasi menggunakan *magic bytes* (`file-type`) dan diteruskan langsung ke adapter penyimpanan sesuai batas ukuran maksimal yang dikonfigurasi.

### 3.3. Dynamic Ephemeral Game State Adapter (`STATE_DRIVER`)
Seluruh siklus hidup sesi kuis aktif (Room PIN, daftar pemain di lobi, hitung mundur soal, jawaban masuk per milidetik, dan skor sementara) disimpan di memori cepat melalui kontrak `IGameStateStore` (Token DI: `GAME_STATE_STORE`):

```typescript
export interface IGameStateStore {
  createRoom(pin: string, state: ActiveRoomState, ttlSeconds: number): Promise<void>;
  getRoom(pin: string): Promise<ActiveRoomState | null>;
  updateRoom(pin: string, partialState: Partial<ActiveRoomState>): Promise<void>;
  deleteRoom(pin: string): Promise<void>;
  
  upsertPlayer(pin: string, player: ActivePlayerState): Promise<void>;
  getPlayer(pin: string, playerId: string): Promise<ActivePlayerState | null>;
  getPlayers(pin: string): Promise<ActivePlayerState[]>;
  removePlayer(pin: string, playerId: string): Promise<void>;

  recordAnswer(pin: string, questionIndex: number, answer: PlayerAnswerSubmission): Promise<boolean>; // returns false if already answered
  getAnswers(pin: string, questionIndex: number): Promise<PlayerAnswerSubmission[]>;
}
```

* **`InMemoryStateStore` (`STATE_DRIVER=memory`):** Menggunakan `Map<string, ActiveRoomState>` dengan pembersihan otomatis (*TTL sweep interval* setiap 15 menit untuk menghapus sesi terbengkalai).
* **`RedisStateStore` (`STATE_DRIVER=redis`):** Menggunakan `ioredis` (menyimpan *state* dalam struktur Redis Hash & Set dengan prefix `kabukineko:room:{pin}` dan `EXPIRE` otomatis) serta mengaktifkan `@socket.io/redis-adapter` pada WebSocket Gateway agar mendukung *horizontal scaling* multi-instance.

---

## 4. DATABASE SCHEMA SPECIFICATION (CROSS-DIALECT)

Semua tabel wajib didefinisikan di dalam `packages/database/src/schema/`.

### 4.1. Tabel `system_settings`
Menyimpan konfigurasi instansi yang dapat diubah oleh `SUPERADMIN` melalui Web Admin Panel.
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `'global'` | Baris tunggal dengan ID tetap `'global'` |
| `instance_name` | `VARCHAR(100)` | `NOT NULL` | `'Kabuki Neko'` | Nama instansi yang tampil di layar publik |
| `registration_mode` | `VARCHAR(20)` | `NOT NULL` | `'PUBLIC'` | Enum: `'SINGLE_ADMIN'` \| `'INVITE_ONLY'` \| `'PUBLIC'` |
| `max_image_size_mb` | `INTEGER` | `NOT NULL` | `5` | Batas maksimal unggah gambar (MB) |
| `max_video_size_mb` | `INTEGER` | `NOT NULL` | `25` | Batas maksimal unggah video (MB) |
| `max_players_per_room`| `INTEGER` | `NOT NULL` | `200` | Kapasitas maksimal pemain dalam 1 PIN ruangan |
| `profanity_words` | `TEXT (JSON)` | `NOT NULL` | `'[]'` | Array kata terlarang untuk filter nickname |
| `updated_at` | `TIMESTAMP` | `NOT NULL` | `NOW()` | Waktu pembaruan terakhir |

### 4.2. Tabel `users`
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `UUID()` | ID unik pengguna |
| `email` | `VARCHAR(255)` | `UNIQUE, NOT NULL` | - | Email login |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` | - | Hash Argon2id / Bcrypt |
| `name` | `VARCHAR(100)` | `NOT NULL` | - | Nama tampilan kreator |
| `role` | `VARCHAR(20)` | `NOT NULL` | `'CREATOR'` | Enum: `'SUPERADMIN'` \| `'CREATOR'` |
| `avatar_style` | `VARCHAR(50)` | `NOT NULL` | `'bottts'` | Koleksi DiceBear untuk profil kreator |
| `avatar_seed` | `VARCHAR(100)` | `NOT NULL` | `'kabuki'` | Seed karakter DiceBear |
| `is_active` | `BOOLEAN` | `NOT NULL` | `true` | Status aktif akun |
| `created_at` | `TIMESTAMP` | `NOT NULL` | `NOW()` | Waktu pembuatan akun |

### 4.3. Tabel `media_assets`
Melacak seluruh aset yang diunggah ke direktori lokal maupun MinIO/R2/S3 untuk mendukung *Asset Library* dan *Orphan Cleanup*.
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `UUID()` | ID unik aset media |
| `uploader_id` | `VARCHAR(36)` | `FK -> users.id` | - | Kreator yang mengunggah file |
| `storage_driver` | `VARCHAR(20)` | `NOT NULL` | - | `'local'` \| `'s3'` |
| `storage_key` | `VARCHAR(500)` | `UNIQUE, NOT NULL` | - | Path relatif atau Object Key di S3/MinIO |
| `public_url` | `VARCHAR(1000)`| `NOT NULL` | - | URL publik untuk merender media |
| `original_name` | `VARCHAR(255)` | `NOT NULL` | - | Nama file asli saat diunggah |
| `mime_type` | `VARCHAR(100)` | `NOT NULL` | - | Contoh: `'image/webp'`, `'video/mp4'` |
| `size_bytes` | `INTEGER` | `NOT NULL` | - | Ukuran file dalam byte |
| `created_at` | `TIMESTAMP` | `NOT NULL` | `NOW()` | Waktu unggah |

### 4.4. Tabel `quizzes`
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `UUID()` | ID unik kuis |
| `creator_id` | `VARCHAR(36)` | `FK -> users.id` | - | Pemilik kuis |
| `title` | `VARCHAR(150)` | `NOT NULL` | - | Judul kuis |
| `description` | `TEXT` | `NULLABLE` | `NULL` | Deskripsi singkat kuis |
| `cover_media_id` | `VARCHAR(36)` | `FK -> media_assets.id`| `NULL` | Gambar sampul kuis (opsional) |
| `visibility` | `VARCHAR(20)` | `NOT NULL` | `'PRIVATE'` | Enum: `'PRIVATE'` \| `'PUBLIC'` |
| `bgm_track` | `VARCHAR(100)` | `NOT NULL` | `'kabuki-matsuri'`| Tema musik latar lobi & permainan |
| `created_at` | `TIMESTAMP` | `NOT NULL` | `NOW()` | Waktu pembuatan |
| `updated_at` | `TIMESTAMP` | `NOT NULL` | `NOW()` | Waktu modifikasi terakhir |

### 4.5. Tabel `questions`
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `UUID()` | ID unik slide pertanyaan |
| `quiz_id` | `VARCHAR(36)` | `FK -> quizzes.id (CASCADE)` | - | Relasi ke kuis induk |
| `order_index` | `INTEGER` | `NOT NULL` | `0` | Urutan slide (0-based) |
| `type` | `VARCHAR(30)` | `NOT NULL` | `'SINGLE_CHOICE'`| Enum: `'SINGLE_CHOICE'` \| `'MULTIPLE_SELECT'` \| `'TRUE_FALSE'` \| `'TYPE_ANSWER'` \| `'ORDER_PUZZLE'` \| `'POLL'` |
| `prompt_text` | `VARCHAR(500)` | `NOT NULL` | - | Teks pertanyaan |
| `media_id` | `VARCHAR(36)` | `FK -> media_assets.id (SET NULL)`| `NULL` | Lampiran gambar/audio/video diunggah |
| `external_video_url`| `VARCHAR(500)` | `NULLABLE` | `NULL` | Opsional embed YouTube URL |
| `video_start_sec` | `INTEGER` | `NULLABLE` | `0` | Waktu mulai putar video |
| `video_end_sec` | `INTEGER` | `NULLABLE` | `NULL` | Waktu berhenti putar video |
| `media_reveal_mode` | `VARCHAR(20)` | `NOT NULL` | `'NONE'` | Enum: `'NONE'` \| `'GRID_3X3'` \| `'GRID_5X5'` \| `'BLUR'` |
| `time_limit_sec` | `INTEGER` | `NOT NULL` | `20` | Pilihan: `5, 10, 20, 30, 60, 90, 120, 240` |
| `points_multiplier` | `INTEGER` | `NOT NULL` | `1` | Pilihan: `0` (No Points), `1` (Standard 1000), `2` (Double 2000) |
| `explanation_text` | `VARCHAR(1000)`| `NULLABLE` | `NULL` | Penjelasan yang tampil saat fase Reveal Answer |

### 4.6. Tabel `question_options`
| Column | Type | Constraints | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `VARCHAR(36)` | `PRIMARY KEY` | `UUID()` | ID unik opsi jawaban |
| `question_id` | `VARCHAR(36)` | `FK -> questions.id (CASCADE)` | - | Relasi ke pertanyaan |
| `color_index` | `INTEGER` | `NOT NULL` | `0` | `0`: Merah (Segitiga), `1`: Biru (Belah Ketupat), `2`: Kuning (Lingkaran), `3`: Hijau (Persegi) |
| `option_text` | `VARCHAR(250)` | `NOT NULL` | - | Teks pilihan jawaban (atau teks kunci pada `TYPE_ANSWER`) |
| `is_correct` | `BOOLEAN` | `NOT NULL` | `false` | Penanda jawaban benar |
| `sort_order` | `INTEGER` | `NOT NULL` | `0` | Urutan benar khusus tipe `ORDER_PUZZLE` |

### 4.7. Tabel `game_sessions`, `game_players`, & `player_answers` (Historical Analytics)
Data pada ketiga tabel ini ditulis secara *batch transaction* ketika permainan selesai (mencapai fase `PODIUM`) atau ketika Host mengakhiri sesi:
* **`game_sessions`**: `id (PK)`, `quiz_id (FK)`, `quiz_title_snapshot`, `host_id (FK)`, `pin_code (VARCHAR 6)`, `display_mode ('PROJECTOR' | 'STREAMER')`, `total_players`, `started_at`, `ended_at`.
* **`game_players`**: `id (PK)`, `session_id (FK CASCADE)`, `nickname`, `avatar_style`, `avatar_seed`, `final_score`, `final_rank`, `correct_count`, `unanswered_count`, `max_streak`, `avg_response_time_ms`.
* **`player_answers`**: `id (PK)`, `session_id (FK CASCADE)`, `player_id (FK CASCADE)`, `question_id (FK SET NULL)`, `question_index`, `submitted_payload (TEXT JSON)`, `is_correct (BOOLEAN)`, `response_time_ms (INTEGER)`, `points_awarded (INTEGER)`, `streak_bonus_awarded (INTEGER)`.

---

## 5. DETERMINISTIC GAME ENGINE & SCORING ALGORITHM

### 5.1. Room Lifecycle State Machine
Setiap ruangan aktif (`ActiveRoomState`) dikontrol secara ketat oleh server NestJS dan hanya dapat berada pada salah satu dari 8 *state* berikut:

```text
[LOBBY] 
   │ (Host triggers 'host:start_game')
   ▼
[GAME_START_COUNTDOWN] (3 detik: Animasi 3.. 2.. 1.. Mulai!)
   │ (Auto-transition by Server Timer)
   ▼
[QUESTION_PREVIEW] (4 detik: Menampilkan teks pertanyaan di layar sebelum opsi jawaban muncul)
   │ (Auto-transition by Server Timer -> mencatat `questionStartedAt = Date.now()`)
   ▼
[QUESTION_ANSWERING] (Durasi = `time_limit_sec` ATAU berhenti lebih cepat jika 100% pemain sudah menjawab)
   │ (Server Timer habis + grace 1500ms / Semua pemain menjawab / Host menekan 'Skip Timer')
   ▼
[ANSWER_REVEAL] (Menampilkan jawaban benar, grafik distribusi jawaban, penjelasan, & status Benar/Salah di HP pemain)
   │ (Host triggers 'host:next_step')
   ├──► Jika masih ada soal berikutnya ──► [LEADERBOARD] (Menampilkan Top 5 & Climber) ──► (Host triggers 'host:next_step') ──► [QUESTION_PREVIEW]
   └──► Jika ini adalah soal terakhir  ──► [PODIUM] (Animasi Juara 3, 2, 1 + Simpan Laporan ke DB) ──► [FINISHED]
```

### 5.2. Server-Side Scoring Formula (Anti-Cheat)
1. **Validasi Waktu:** Saat memasuki `QUESTION_ANSWERING`, server mencatat `questionStartedAt` (Unix epoch ms). Saat server menerima paket `player:submit_answer`, server mencatat `receivedAt = Date.now()`.
   * Waktu respons pemain: `t_elapsed = Math.max(0, receivedAt - questionStartedAt)`
   * Batas waktu soal dalam milidetik: `t_limit = time_limit_sec * 1000`
   * Pada `t_limit`, input UI ditutup dan server tetap dalam `QUESTION_ANSWERING` selama grace 1.500ms tanpa membocorkan jawaban. Reveal baru dikirim setelah grace berakhir. Jika semua pemain sudah menjawab atau Host memakai Skip Timer, penerimaan ditutup langsung tanpa grace; tidak boleh menerima jawaban setelah reveal.
   * Jika `t_elapsed > (t_limit + 1500)` (toleransi *network jitter* 1.5 detik), jawaban ditolak sebagai `TIME_EXPIRED`.
2. **Perhitungan Skor Dasar (`baseScore`):**
   * Jika jawaban **SALAH** atau tipe soal adalah `POLL` atau `points_multiplier === 0`:
     * `pointsAwarded = 0`
     * `currentStreak` di-reset menjadi `0` (jika bukan `POLL`).
   * Jika jawaban **BENAR**:
     * Untuk respons instan (`t_elapsed < 500` ms), pemain mendapatkan poin penuh: `rawScore = 1000 * points_multiplier`.
     * Untuk `t_elapsed >= 500` ms, gunakan kurva peluruhan linier Kahoot!:
       ```typescript
       const timeRatio = Math.min(1, t_elapsed / t_limit);
       const speedFactor = 1 - (timeRatio / 2); // Bernilai antara 0.50 hingga 1.00
       const basePoints = Math.round(1000 * points_multiplier * speedFactor);
       ```
3. **Aturan Khusus Tipe Soal:**
   * **`MULTIPLE_SELECT`**: Jika sebuah soal memiliki $K$ jawaban benar, dan pemain memilih sejumlah jawaban benar $C$ tanpa memilih jawaban yang salah sama sekali, maka pengali akurasinya adalah $(C / K)$. Jika pemain memilih satu saja opsi yang salah atau tidak memilih opsi benar, skor = `0` dan streak di-reset. Pilihan parsial dengan `C > 0` tanpa opsi salah tetap menaikkan streak dan memperoleh bonus streak penuh (keputusan pengguna). Skor dasar parsial dibulatkan: `Math.round(basePoints * C / K)`, lalu bonus streak ditambahkan; bonus tidak dikalikan rasio akurasi.
   * **`TYPE_ANSWER`**: Bandingkan input pemain (`trim().toLowerCase()`) terhadap daftar opsi jawaban benar menggunakan *exact match* atau jarak *Levenshtein* $\le 1$ (untuk kata dengan panjang $\ge 6$ huruf) guna mentoleransi salah ketik ringan.
   * **`ORDER_PUZZLE`**: Skor diberikan jika keempat item disusun tepat sesuai `sort_order`.
4. **Perhitungan Answer Streak Bonus (`streakBonus`):**
   * Untuk `POLL`, skor dan bonus selalu nol serta streak tidak berubah. Untuk soal lain dengan multiplier 0, skor dan bonus nol serta streak di-reset. Aturan berikut hanya untuk soal bernilai poin.
   * Setiap jawaban benar (termasuk MULTIPLE_SELECT parsial tanpa opsi salah) berturut-turut menaikkan `currentStreak += 1`.
   * Bonus poin beruntun diberikan mulai dari jawaban benar ke-2 berturut-turut:
     * Streak 1: `+0`
     * Streak 2: `+100`
     * Streak 3: `+200`
     * Streak 4: `+300`
     * Streak 5: `+400`
     * Streak $\ge 6$: `+500` (Maksimal bonus per soal).
   * Total tambahan skor pemain pada soal tersebut: `totalDelta = basePoints + streakBonus`.

---

## 6. REST API SPECIFICATION (`apps/api`)

Semua endpoint REST menggunakan prefix `/api/v1`. Respons error wajib mengikuti standar format `{ statusCode: number, errorCode: string, message: string, details?: unknown }`.

### 6.1. Auth & Setup Module (`/api/v1/auth`)
| Method | Endpoint | Auth Guard | Request Body / Query | Response (`200`/`201`) |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/auth/setup-status` | Public | - | `{ isInitialized: boolean, registrationMode: string, instanceName: string, license: 'Apache-2.0-with-Commons-Clause' }` |
| `POST` | `/auth/setup` | Public (Hanya jika `users` = 0) | `{ instanceName, name, email, password }` | `{ user: UserDTO, accessToken: string }` + Set Cookie `refresh_token` |
| `POST` | `/auth/register` | Public (Bergantung `registrationMode`) | `{ name, email, password, inviteCode? }` | `{ user: UserDTO, accessToken: string }` |
| `POST` | `/auth/login` | Public | `{ email, password }` | `{ user: UserDTO, accessToken: string }` + Set Cookie `refresh_token` |
| `POST` | `/auth/refresh` | Cookie `refresh_token` | - | `{ accessToken: string }` |
| `POST` | `/auth/logout` | `JwtAuthGuard` | - | `{ success: true }` |
| `GET` | `/auth/me` | `JwtAuthGuard` | - | `UserDTO` |

### 6.2. Quiz & Studio Module (`/api/v1/quizzes`)
| Method | Endpoint | Auth Guard | Request Body / Query | Response (`200`/`201`) |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/quizzes` | `JwtAuthGuard` | `?page=1&limit=12&search=&visibility=` | `{ items: QuizSummaryDTO[], meta: PaginationMeta }` |
| `POST` | `/quizzes` | `JwtAuthGuard` | `{ title, description?, visibility, bgmTrack }` | `QuizDetailDTO` (otomatis membuat 1 slide kosong default) |
| `GET` | `/quizzes/:id` | `JwtAuthGuard` | - | `QuizDetailDTO` (beserta array `questions` & `options` terurut) |
| `PUT` | `/quizzes/:id` | `JwtAuthGuard` | `UpdateQuizBulkDTO` (Menyimpan metadata kuis sekaligus sinkronisasi seluruh array slide pertanyaan & opsi dalam 1 transaksi) | `QuizDetailDTO` |
| `POST` | `/quizzes/:id/duplicate`| `JwtAuthGuard` | - | `QuizDetailDTO` (Salinan kuis milik pengguna) |
| `DELETE`| `/quizzes/:id` | `JwtAuthGuard` | - | `{ deleted: true }` |
| `GET` | `/quizzes/:id/export` | `JwtAuthGuard` | `?format=json` | File unduhan `.kabukineko.json` |
| `POST` | `/quizzes/import` | `JwtAuthGuard` | `Multipart file (.kabukineko.json atau .csv)` | `QuizDetailDTO` |

### 6.3. Media Module (`/api/v1/media`)
| Method | Endpoint | Auth Guard | Request Body / Query | Response (`200`/`201`) |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/media/upload` | `JwtAuthGuard` | `Multipart FormData: file, folder` | `MediaAssetDTO` (Sudah terkompresi ke WebP jika gambar) |
| `GET` | `/media` | `JwtAuthGuard` | `?page=1&limit=24&type=image\|video\|audio` | `{ items: MediaAssetDTO[], meta: PaginationMeta }` |
| `DELETE`| `/media/:id` | `JwtAuthGuard` | - | `{ deleted: true }` |

### 6.4. Reports & Analytics Module (`/api/v1/reports`)
| Method | Endpoint | Auth Guard | Request Body / Query | Response (`200`) |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/reports` | `JwtAuthGuard` | `?page=1&limit=15&quizId=` | `{ items: SessionSummaryDTO[], meta }` |
| `GET` | `/reports/:sessionId` | `JwtAuthGuard` | - | `SessionFullReportDTO` (Ringkasan akurasi, daftar pemain, analisis per butir soal, daftar soal tersulit) |
| `GET` | `/reports/:sessionId/export-csv` | `JwtAuthGuard` | - | Stream unduhan file `text/csv` nilai seluruh peserta |

### 6.5. System & Superadmin Module (`/api/v1/system`)
| Method | Endpoint | Auth Guard | Request Body / Query | Response (`200`) |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/system/health` | Public | - | `{ app: 'Kabuki Neko', status: 'ok', dbDriver, storageDriver, stateDriver, storageHealth }` |
| `GET` | `/system/settings` | `RolesGuard('SUPERADMIN')` | - | `SystemSettingsDTO` + metrik jumlah file & ukuran total storage |
| `PATCH` | `/system/settings` | `RolesGuard('SUPERADMIN')` | `Partial<SystemSettingsDTO>` | `SystemSettingsDTO` |
| `POST` | `/system/storage/cleanup-orphans` | `RolesGuard('SUPERADMIN')` | - | `{ scannedCount: number, deletedCount: number, freedBytes: number }` |

---

## 7. WEBSOCKET (SOCKET.IO) REAL-TIME PROTOCOL

* **Namespace:** `/game`
* **Kontrak File:** `packages/shared/src/socket-events.ts`

### 7.1. Client-to-Server Events (`ClientToServerEvents`)
| Event Name | Sender | Payload Schema | Server Action & Ack Response |
| :--- | :--- | :--- | :--- |
| `host:create_room` | Host | `{ quizId: string, displayMode: 'PROJECTOR' \| 'STREAMER', friendlyNicknames: boolean }` | Memvalidasi JWT Host, memuat kuis dari DB ke `IGameStateStore`, membuat 6-digit PIN unik yang belum terpakai. Mengembalikan Ack `{ ok: true, pinCode, sessionId }`. |
| `host:lock_room` | Host | `{ pinCode: string, isLocked: boolean }` | Mengubah status kunci lobi dan menyiarkan `room:lock_changed` ke semua klien di ruangan. |
| `host:kick_player` | Host | `{ pinCode: string, playerId: string }` | Menghapus pemain dari `IGameStateStore`, memutus socket pemain tersebut dengan event `player:kicked`, dan menyiarkan `room:player_left`. |
| `host:start_game` | Host | `{ pinCode: string }` | Memulai transisi dari `LOBBY` ke `GAME_START_COUNTDOWN`. |
| `host:skip_timer` | Host | `{ pinCode: string }` | Menghentikan hitung mundur `QUESTION_ANSWERING` lebih awal dan langsung memicu `ANSWER_REVEAL` tanpa grace; semua jawaban berikutnya ditolak. |
| `host:next_step` | Host | `{ pinCode: string }` | Memajukan *state* dari `ANSWER_REVEAL` $\rightarrow$ `LEADERBOARD` $\rightarrow$ `QUESTION_PREVIEW` berikutnya (atau `PODIUM` jika soal habis). |
| `player:check_pin` | Player | `{ pinCode: string }` | Mengecek apakah ruangan dengan PIN tersebut ada dan tidak terkunci. Mengembalikan Ack `{ ok: boolean, error?: string, friendlyNicknames?: boolean }`. |
| `player:join_room` | Player | `{ pinCode: string, nickname: string, avatar: { style: string, seed: string }, sessionToken?: string }` | Jika `sessionToken` valid dan cocok dengan pemain yang sudah ada di ruangan, pulihkan sesi (*reconnection*). Jika pemain baru, validasi *profanity filter* dan keunikan *nickname*, buat `playerId` & `sessionToken`, masukkan ke ruangan, dan siarkan `room:player_joined`. |
| `player:update_avatar` | Player | `{ pinCode: string, avatar: { style: string, seed: string } }` | (Hanya saat `LOBBY`) Memperbarui tampilan karakter DiceBear pemain secara *real-time* di layar proyektor Host. |
| `player:submit_answer` | Player | `{ pinCode: string, questionIndex: number, answer: number \| number[] \| string }` | Mencatat jawaban ke `IGameStateStore`, menghitung skor & streak di server, mengirim Ack `{ accepted: true }`, dan menyiarkan `game:answer_count_updated` ke Host. Jika seluruh pemain aktif sudah menjawab, otomatis hentikan timer soal. |

### 7.2. Server-to-Client Events (`ServerToClientEvents`)
| Event Name | Recipient | Payload Schema | Description |
| :--- | :--- | :--- | :--- |
| `room:state_sync` | Caller (Host/Player) | `RoomSyncPayload` | Dikirim saat baru bergabung atau saat *reconnect* agar UI langsung menyesuaikan *state* ruangan terkini. |
| `room:player_joined` | Room Broadcast | `{ player: PublicPlayerDTO, totalPlayers: number }` | Memunculkan kartu avatar DiceBear baru di lobi dengan animasi *pop-in*. |
| `room:player_updated`| Room Broadcast | `{ playerId: string, avatar: { style: string, seed: string } }` | Memperbarui SVG DiceBear pemain di lobi Host. |
| `room:player_left` | Room Broadcast | `{ playerId: string, totalPlayers: number }` | Menghapus pemain yang di-*kick* dari layar lobi. |
| `game:countdown` | Room Broadcast | `{ durationSec: 3, quizTitle: string, totalQuestions: number }` | Memicu animasi hitung mundur mulai permainan. |
| `game:question_preview`| Room Broadcast | `{ questionIndex: number, totalQuestions: number, type: QuestionType, promptText: string, pointsMultiplier: number, previewDurationMs: 4000 }` | Menampilkan teks pertanyaan sebelum tombol jawaban terbuka. |
| `game:question_answering`| Room Broadcast | `{ questionIndex: number, type: QuestionType, promptText?: string, media?: MediaPayload, options: PublicOptionDTO[], timeLimitSec: number, serverStartTime: number }` | *(Catatan: `options` TIDAK menyertakan field `isCorrect`)*. Membuka papan tombol jawaban di perangkat pemain. |
| `game:answer_count_updated`| Host Only | `{ answeredCount: number, totalPlayers: number }` | Memperbarui penghitung jumlah jawaban yang masuk di layar proyektor. |
| `game:answer_reveal` | Host Broadcast + Individual Player Emit | **Host Payload:** `{ correctOptionIds: string[], optionCounts: Record<string, number>, explanationText?: string }`<br>**Player Individual Payload:** `{ isCorrect: boolean, pointsAwarded: number, streakBonus: number, currentStreak: number, totalScore: number, currentRank: number, rankBehindPlayerName?: string }` | Menampilkan grafik batang distribusi jawaban di proyektor dan layar hijau/merah di HP masing-masing pemain. |
| `game:leaderboard` | Room Broadcast | `{ topPlayers: LeaderboardEntryDTO[], biggestClimber?: { nickname: string, ranksGained: number } }` | Menampilkan 5 besar klasemen sementara dengan animasi pergeseran baris. |
| `game:podium` | Room Broadcast | `{ podium: [PodiumPlayerDTO, PodiumPlayerDTO?, PodiumPlayerDTO?], reportId: string }` | Menampilkan animasi Podium Juara 3, 2, 1 beserta konfeti. |

---

## 8. FUNCTIONAL REQUIREMENTS & UI/UX SCREEN SPECIFICATIONS

### 8.1. Visual Identity ("Kabuki Neko" Theme) & Geometry Mapping
* **Tema Visual Kabuki Neko:** Memadukan warna khas panggung Kabuki Jepang (aksen *Kumadori Crimson* `#D9381E`, *Kabuki Gold* `#F59E0B`, dan *Sumi Ink Dark* `#18181B`) dengan ilustrasi maskot kucing Kabuki pada layar kosong (*empty states*), *loading screen*, dan lobi permainan.
* **Standar Aksesibilitas Tombol Jawaban:** Untuk menjaga aksesibilitas bagi penyandang buta warna, keempat opsi jawaban wajib selalu dipasangkan dengan kombinasi warna kontras tinggi dan ikon bentuk geometris tetap:
  * **Index 0 (Opsi A):** Background `#E21B3C` (Crimson Red) — Ikon **Segitiga (Triangle ▲)**
  * **Index 1 (Opsi B):** Background `#1368CE` (Royal Blue) — Ikon **Belah Ketupat (Diamond ◆)**
  * **Index 2 (Opsi C):** Background `#D89E00` (Golden Yellow) — Ikon **Lingkaran (Circle ●)**
  * **Index 3 (Opsi D):** Background `#26890C` (Forest Green) — Ikon **Persegi (Square ■)**

### 8.2. Screen-by-Screen Specifications (`apps/web`)

#### A. Layar Player (`/join` & `/play/[pin]`) — Mobile-First Design
1. **PIN Entry & QR Scanner (`/join`):**
   * Menampilkan logo & maskot **Kabuki Neko** di atas kotak input PIN.
   * Membaca query parameter `?pin=123456` secara otomatis jika diakses dari hasil pindai QR Code.
   * Input numerik 6 digit berukuran besar dengan auto-focus.
2. **DiceBear Avatar & Nickname Customizer (Pre-Lobby Modal):**
   * Menampilkan pratinjau avatar SVG secara langsung menggunakan `@dicebear/core` dan `@dicebear/collection`.
   * Menyediakan *selector* 6 koleksi gaya karakter: `bottts`, `adventurer`, `fun-emoji`, `pixel-art`, `lorelei`, dan `avataaars`.
   * Tombol **"Acak Karakter (Dice Roll)"** yang menghasilkan `avatarSeed` acak baru dengan animasi putar.
   * Input `Nickname` (maksimal 15 karakter) atau tombol *Spin Friendly Nickname* jika Host mengaktifkan mode nama aman.
3. **Player Gamepad View (`/play/[pin]`):**
   * **Header Bar:** Menampilkan avatar DiceBear mini dan *Nickname* di kiri, serta *Badge* total skor dan ikon api *Streak* di kanan.
   * **Mode `PROJECTOR`:** Layar tengah HP hanya menampilkan 4 tombol raksasa berwarna dengan simbol geometris (▲, ◆, ●, ■) yang memenuhi area sentuh jempol.
   * **Mode `STREAMER`:** Menampilkan teks pertanyaan, gambar soal, dan teks pada masing-masing tombol warna sehingga peserta yang bermain lewat Zoom/Discord tetap bisa membaca soal dari satu layar.
   * **Interactive Inputs per Question Type:**
     * `SINGLE_CHOICE` / `TRUE_FALSE`: Sekali ketuk langsung mengirim jawaban dan mengunci layar ke status *"Jawaban Terkirim! Menunggu pemain lain..."*.
     * `MULTIPLE_SELECT`: Pemain dapat mencentang beberapa tombol warna sekaligus, lalu menekan tombol **"Kirim Jawaban"** di bagian bawah.
     * `TYPE_ANSWER`: Menampilkan kolom input teks bersih dan tombol kirim.
     * `ORDER_PUZZLE`: Menampilkan 4 kartu yang dapat digeser (*drag-and-drop* / tombol panah atas-bawah) untuk mengurutkan jawaban.

#### B. Layar Host / Proyektor (`/host/[sessionId]`) — 16:9 Large Screen Design
1. **Lobby Screen:**
   * Header raksasa di bagian atas menampilkan URL bergabung, **6-Digit Game PIN** (font *monospace* ekstra tebal dengan fitur klik untuk *copy*), serta **QR Code** yang dapat diperbesar ke tengah layar dengan sekali klik.
   * Kontrol Musik & Suara (Mute/Unmute, Volume Slider, Ganti Track BGM).
   * Grid dinamis tempat munculnya karakter DiceBear dan *nickname* peserta yang baru masuk. Saat kursor diarahkan ke kartu peserta, muncul efek coret merah (*Kick Player*).
   * Toolbar bawah: Indikator jumlah peserta, tombol **Lock/Unlock Room**, dan tombol **Start Game**.
2. **Active Question Projector:**
   * Banner teks soal di bagian atas, penghitung waktu mundur melingkar (*Circular Countdown Timer*) di sisi kiri, dan penghitung jumlah jawaban masuk (`Answered: 42 / 50`) di sisi kanan.
   * Area tengah menampilkan media (Gambar dengan efek *Grid Reveal* 3x3/5x5 yang terbuka bertahap, pemutar Audio, atau Video).
   * Bagian bawah menampilkan 2 hingga 4 kartu pilihan jawaban.
3. **Answer Reveal & Leaderboard:**
   * Setelah waktu dan grace 1.500ms berakhir (atau penutupan lebih awal), opsi yang salah meredup (`opacity-40`) dan opsi yang benar ditandai ikon centang beranimasi, sementara grafik batang vertikal (*Bar Chart*) tumbuh di bagian tengah layar menunjukkan jumlah pemilih tiap opsi.
   * Tombol untuk menampilkan modal `Explanation Text` jika soal memiliki pembahasan.
   * Layar Podium Akhir menampilkan animasi sorotan lampu panggung untuk Juara 3, Juara 2, lalu Juara 1 lengkap dengan semburan `canvas-confetti`.

#### C. Quiz Studio (`/studio/[quizId]`) — Desktop Creator Experience
1. **3-Pane Layout:**
   * **Left Pane (Slide Navigator):** Daftar thumbnail vertikal seluruh slide pertanyaan. Mendukung *drag-and-drop reordering* (`@dnd-kit`), tombol duplikasi slide, hapus slide, dan tombol **"+ Tambah Pertanyaan"**.
   * **Center Pane (WYSIWYG Canvas):** Kanvas interaktif yang meniru tampilan layar Host secara langsung. Kreator mengetik pertanyaan langsung di atas banner soal, memilih/mengunggah media di kotak tengah (atau memilih dari *Asset Library*), serta mengetik teks opsi jawaban dan menandai jawaban benar di bagian bawah.
   * **Right Pane (Slide Properties):** Pengaturan *Question Type*, *Time Limit* (5s–240s), *Points Multiplier* (Standard, Double, No Points), *Media Reveal Effect* (None, Grid 3x3, Blur), dan *Answer Explanation*.
2. **Validation Indicator:**
   * Menandai slide di panel kiri dengan ikon peringatan kuning jika teks pertanyaan masih kosong atau belum ada opsi jawaban yang ditandai sebagai jawaban benar.

---

## 9. ACCEPTANCE CRITERIA & QA TEST SCENARIOS (GHERKIN)

Spesifikasi ini menjadi acuan pengujian otomatis (Unit, Integration, dan Playwright E2E) pada tahap QA pipeline:

### Scenario 1: Multi-Driver Storage & Automatic WebP Compression
```gherkin
Feature: Media Upload and Storage Abstraction

  Scenario: Creator uploads a PNG image when STORAGE_DRIVER is set to local or s3
    Given a user with role "CREATOR" is authenticated in Kabuki Neko
    And the environment variable "STORAGE_DRIVER" is configured ("local" or "s3")
    When the user uploads a 2MB PNG file to "POST /api/v1/media/upload" with folder "questions"
    Then the backend MUST process the buffer using Sharp and convert it to "image/webp"
    And the converted file MUST be stored via the active IStorageAdapter
    And a new record MUST be inserted into the "media_assets" table with mime_type "image/webp"
    And the endpoint MUST return HTTP 201 with a valid "publicUrl"
```

### Scenario 2: Server-Side Anti-Cheat & Speed Scoring
```gherkin
Feature: Deterministic Server-Side Score Calculation

  Scenario: Two players submit the correct answer at different speeds
    Given an active game room in state "QUESTION_ANSWERING"
    And the current question has time_limit_sec = 20 and points_multiplier = 1
    And both players have currentStreak = 0 before answering
    And the server records questionStartedAt = 1000000
    When Player A submits the correct option at server timestamp 1002000 (2 seconds elapsed)
    And Player B submits the correct option at server timestamp 1010000 (10 seconds elapsed)
    Then Player A MUST receive round(1000 * 1 * (1 - (2000 / 40000))) = 950 points
    And Player B MUST receive round(1000 * 1 * (1 - (10000 / 40000))) = 750 points
    And neither player client payload during QUESTION_ANSWERING contains the "isCorrect" boolean
```

### Scenario 3: Player Session Reconnection Mid-Game
```gherkin
Feature: Resilient WebSocket Session Recovery

  Scenario: Player accidentally refreshes mobile browser during question 3
    Given Player "Budi" has joined room "884920" with score 1850 and streak 2
    And "Budi" has a valid "sessionToken" stored in browser localStorage
    When "Budi" disconnects and reconnects to "/play/884920" sending "player:join_room" with the saved "sessionToken"
    Then the server MUST restore "Budi" to the existing player slot without creating a duplicate player
    And "Budi" MUST retain score 1850, streak 2, and current DiceBear avatar
    And the client UI MUST immediately sync to the room's active state via "room:state_sync"
```

### Scenario 4: Orphaned Media Garbage Collection
```gherkin
Feature: Storage Maintenance and Orphan Cleanup

  Scenario: Superadmin cleans up unreferenced media files
    Given "media_asset_A" is referenced by "question_1"
    And "media_asset_B" is NOT referenced by any row in "quizzes" or "questions"
    When a user with role "SUPERADMIN" calls "POST /api/v1/system/storage/cleanup-orphans"
    Then the file for "media_asset_B" MUST be deleted from the active Storage Adapter (Local or S3/MinIO)
    And the record "media_asset_B" MUST be removed from the "media_assets" table
    And "media_asset_A" MUST remain untouched
```

### Scenario 5: Non-Commercial License Verification
```gherkin
Feature: Source-Available Non-Commercial License Compliance

  Scenario: Repository and Admin Panel display the Non-Commercial License terms
    Given the Kabuki Neko repository and web application are built
    When the reviewer inspects the root LICENSE and Admin About page
    Then the root directory MUST contain a "LICENSE" file with Apache 2.0 + Commons Clause terms
    And the license text MUST explicitly permit forking, editing, personal use, and internal company use
    And the license text MUST explicitly prohibit selling, sublicensing for a fee, or commercial SaaS hosting
```

---

## 10. SECURITY, RATE LIMITING & NFR

1. **PIN Enumeration & Brute-Force Protection:**
   * Batasi event `player:check_pin` dan `player:join_room` maksimal **10 request per 60 detik per alamat IP** menggunakan `@nestjs/throttler`.
2. **Payload Sanitization & File Security:**
   * Semua input teks (`nickname`, `prompt_text`, `option_text`) wajib divalidasi dengan `zod` dan disanitasi dari injeksi XSS.
   * Validasi *file signature* (*magic bytes*) wajib menolak file eksekusi atau SVG berbahaya pada endpoint upload media (Avatar DiceBear hanya dirender dari parameter `style` dan `seed` resmi, bukan dari unggahan file SVG bebas).
3. **Performance Targets:**
   * Latensi *broadcast* event pergantian soal ke 200 klien WebSocket di dalam satu ruangan harus berada di bawah **50ms** (p95).
   * Ukuran bundle JavaScript halaman Player (`/play/[pin]`) harus dioptimalkan agar cepat dimuat pada jaringan seluler 3G/4G.

---

## 11. ENVIRONMENT VARIABLES & DOCKER DEPLOYMENT SPEC

### 11.1. Complete `.env.example` Contract
```env
# ==========================================
# 1. APPLICATION & NETWORK (KABUKI NEKO)
# ==========================================
NODE_ENV=production
NEXT_PUBLIC_APP_NAME="Kabuki Neko"
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=http://localhost:3001
API_PORT=3001
CORS_ORIGIN=http://localhost:3000

# ==========================================
# 2. AUTHENTICATION & SECURITY
# ==========================================
JWT_ACCESS_SECRET=change_me_to_a_secure_64_char_random_string_access
JWT_REFRESH_SECRET=change_me_to_a_secure_64_char_random_string_refresh
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ==========================================
# 3. DATABASE CONFIGURATION
# Supported DB_DRIVER: sqlite | postgres | mysql
# ==========================================
DB_DRIVER=sqlite
DB_AUTO_MIGRATE=true

# Used when DB_DRIVER=sqlite
SQLITE_PATH=./data/kabuki-neko.sqlite

# Used when DB_DRIVER=postgres or mysql
# DATABASE_URL=postgresql://kabukineko:secretpassword@localhost:5432/kabuki_neko_db
# DATABASE_URL=mysql://kabukineko:secretpassword@localhost:3306/kabuki_neko_db
DB_POOL_MAX=20

# ==========================================
# 4. EPHEMERAL GAME STATE (REAL-TIME ENGINE)
# Supported STATE_DRIVER: memory | redis
# ==========================================
STATE_DRIVER=memory
REDIS_URL=redis://localhost:6379

# ==========================================
# 5. MEDIA & OBJECT STORAGE
# Supported STORAGE_DRIVER: local | s3
# ==========================================
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=./uploads

# S3-Compatible Config (MinIO, Cloudflare R2, AWS S3) - Active when STORAGE_DRIVER=s3
S3_ENDPOINT=http://localhost:9000
S3_REGION=auto
S3_BUCKET=kabuki-neko-media
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL=http://localhost:9000/kabuki-neko-media
```

### 11.2. Docker Compose Self-Hosting Profiles
File `docker/docker-compose.yml` wajib menyediakan dua mode pengoperasian:
1. **Default Mode (`docker compose up -d`):** Menjalankan container `kabuki-neko-web` dan `kabuki-neko-api` dengan *bind volume* `./data:/app/data` (SQLite) dan `./uploads:/app/uploads` (Local Storage).
2. **Production Scale Profile (`docker compose --profile scale up -d`):** Menyalakan container tambahan `postgres:16-alpine`, `redis:7-alpine`, dan `minio/minio` lengkap dengan *init container* (`minio/mc`) yang otomatis membuat bucket `kabuki-neko-media` dengan *public read policy*.

---

## 12. PIPELINE EXECUTION ORDER (IMPLEMENTATION ROADMAP)

Urutan pengerjaan modul untuk dieksekusi oleh *coding pipeline*:
1. **Milestone 1 (Workspace, License, & Shared Contracts):** Inisialisasi `pnpm` monorepo (`kabuki-neko`), pembuatan file `LICENSE` (Apache 2.0 with Commons Clause — Non-Commercial / No-Resale), `Turborepo`, dan paket `@kabuki-neko/shared` (seluruh Zod DTO, konstanta warna/bentuk, dan interface event Socket.io).
2. **Milestone 2 (Database & Core Adapters):** Implementasi `@kabuki-neko/database` (skema lintas-dialek SQLite/Postgres/MySQL) beserta `StorageModule` (`LocalStorageAdapter` + `S3StorageAdapter` + `sharp` pipeline) dan `GameStateModule` (`InMemoryStateStore` + `RedisStateStore`) di NestJS.
3. **Milestone 3 (Auth, Setup Wizard, & REST API):** Implementasi autentikasi JWT, *First-Run Setup Wizard*, endpoint CRUD Kuis/Pertanyaan, Impor/Ekspor `.kabukineko.json`/`.csv`, dan Superadmin Storage Cleanup.
4. **Milestone 4 (WebSocket Game Engine):** Implementasi `GameGateway` Socket.io, *Room State Machine*, *Timer Loop*, algoritma skor & *streak*, serta mekanisme *reconnection* pemain.
5. **Milestone 5 (Frontend Admin & Quiz Studio):** Pembuatan halaman Setup, Dashboard Kreator bertema **Kabuki Neko**, **3-Pane WYSIWYG Quiz Studio**, *Asset Library Modal*, dan halaman *Superadmin Settings*.
6. **Milestone 6 (Frontend Live Host & Player Experience):** Pembuatan halaman Join PIN/QR, *DiceBear Avatar Customizer*, layar Proyektor Host (Lobby, Soal, Grafik Batang, Podium, Audio Engine Howler.js), layar Gamepad Pemain, dan halaman Analitik Laporan Pasca-Kuis.
7. **Milestone 7 (E2E Testing & Docker Bundling):** Pengujian skenario Gherkin, pembuatan `Dockerfile` multi-stage, dan validasi `docker-compose.yml`.

---

## 13. NORMALIZATION, SCOPE PRIORITIZATION & ROLE PERMISSIONS

### 13.1. Kedudukan dokumen

Bagian 1–12 mempertahankan kebutuhan, detail stack, kontrak infrastruktur, skema, API, event, tampilan, environment, dan roadmap sumber. Bagian 13–18 menambahkan traceability produk dan aturan uji; koreksi pada bagian awal hanya memperjelas keputusan pengguna, konsistensi timer/skor, tipe nullable yang salah tulis, serta `unknown` menggantikan `any`. Seluruh fitur asli tetap masuk cakupan. Dokumen ini tidak menyatakan fitur sudah diimplementasikan.

Keputusan eksplisit pengguna pada 2026-10-28:
- **D-01:** Tutup input di akhir timer, terima paket terlambat sampai 1.500ms berikutnya, baru buka kunci jawaban.
- **D-02:** MULTIPLE_SELECT parsial tanpa opsi salah tetap menaikkan streak dan memperoleh bonus.
- **D-03:** CREATOR dapat melihat, menyalin, dan menjadi host kuis PUBLIC milik kreator lain; edit/hapus tetap hanya oleh pemilik.

### 13.2. MoSCoW matrix

Karena sumber tidak mengizinkan pemangkasan fitur, seluruh kebutuhan eksplisit diperlakukan sebagai P0 untuk baseline rilis lengkap. Milestone adalah urutan pengerjaan, bukan izin menghilangkan fitur dari rilis.

| Prioritas | Cakupan |
| --- | --- |
| Must Have / P0 | Setup, JWT, tiga mode registrasi dan peran; Quiz Studio, enam tipe soal, CRUD/duplicate/import/export; media library dan semua adapter; host/player real-time, PIN/QR, DiceBear, audio, projector/streamer, moderasi, recovery; scoring, streak, reveal, leaderboard/podium; laporan/CSV; settings/health/cleanup; branding, aksesibilitas, keamanan, lisensi dan dua profil Docker; semua §1–12 |
| Should Have / P1 | Tidak ada fitur sumber yang diturunkan ke P1; backlog tambahan perlu keputusan produk tersendiri |
| Could Have / P2 | Belum ditentukan; bukan alasan menambah fitur saat coding |
| Won't Have / di luar scope | Paid SaaS/billing/resale; aplikasi mobile native; pembayaran peserta; fitur baru seperti AI question generation, SSO, marketplace, atau mode ujian asinkron tidak termasuk baseline |

### 13.3. Matriks izin resource

| Operasi | SUPERADMIN | CREATOR | PLAYER |
| --- | --- | --- | --- |
| Settings, kebijakan registrasi, health detail, orphan cleanup | Ya | Tidak | Tidak |
| CRUD kuis dan media milik sendiri | Ya sebagai pemilik | Ya sebagai pemilik | Tidak |
| Melihat/menyalin/host kuis PUBLIC | Ya | Ya | Hanya payload permainan yang diizinkan |
| Edit/hapus kuis milik orang lain | Tidak diberikan otomatis | Tidak | Tidak |
| Membaca kuis PRIVATE | Pemilik; tanpa akses global implisit | Pemilik | Tidak |
| Kontrol sesi, kick/lock/start/skip/next/end | Host sesi | Host sesi | Tidak |
| Laporan dan ekspor peserta | Host sesi; tanpa akses global implisit | Host sesi | Tidak |
| Jawaban dan avatar pemain | Tidak menyamar sebagai pemain | Tidak menyamar sebagai pemain | Hanya slot sesi sendiri dengan token yang valid |

Baseline izin mengikuti least privilege. Aset yang dirender melalui public URL memang dapat diakses oleh pemilik URL; visibility PRIVATE melindungi data kuis/API, bukan menjanjikan kerahasiaan URL media publik.

## 14. NUMBERED USER STORIES & ACCEPTANCE CRITERIA

Setiap US adalah kebutuhan yang harus ditautkan oleh design, SA, TASK-XXX, review, dan QA. Skenario di §9 tetap berlaku; skenario berikut menambahkan happy path dan negative/edge coverage. Kata Given/When/Then di bawah bersifat normatif.

### US-01 — Setup dan autentikasi

Sebagai **SUPERADMIN/CREATOR**, saya ingin menyiapkan instansi dan login dengan aman. Sumber: §1.3, §6.1, §11.

```gherkin
Feature: US-01 Setup dan autentikasi
  Scenario: AC-01-01 Happy path
    Given instansi belum memiliki pengguna
    When maintainer mengirim setup yang valid
    Then tepat satu SUPERADMIN dibuat dan setup berikutnya ditutup, access token serta refresh cookie diterbitkan

  Scenario: AC-01-02 Negative atau edge case
    Given setup telah selesai atau dua setup berjalan bersamaan
    When permintaan setup lain diterima
    Then tidak ada SUPERADMIN tambahan; login akun nonaktif atau kredensial salah ditolak tanpa membocorkan password
```

### US-02 — Kebijakan registrasi

Sebagai **SUPERADMIN**, saya ingin mengontrol siapa yang dapat menjadi kreator. Sumber: §1.3, §4.1, §6.1, §6.5.

```gherkin
Feature: US-02 Kebijakan registrasi
  Scenario: AC-02-01 Happy path
    Given registrasi PUBLIC aktif
    When pengguna mengirim data valid dengan email unik
    Then akun CREATOR dibuat tanpa hak SUPERADMIN

  Scenario: AC-02-02 Negative atau edge case
    Given mode SINGLE_ADMIN atau INVITE_ONLY aktif
    When pendaftar mengirim registrasi tanpa izin yang sesuai
    Then registrasi ditolak; INVITE_ONLY hanya menerima undangan valid dan tidak boleh memakainya ulang
```

### US-03 — CRUD, visibility dan reuse kuis

Sebagai **CREATOR**, saya ingin mengelola kuis sendiri dan memakai kuis publik. Sumber: §4.4, §6.2, D-03.

```gherkin
Feature: US-03 CRUD, visibility dan reuse kuis
  Scenario: AC-03-01 Happy path
    Given kreator mengakses kuis PUBLIC milik kreator lain
    When ia melihat, menduplikasi, atau membuat room
    Then operasi diizinkan; salinan memperoleh identitas baru dan menjadi miliknya

  Scenario: AC-03-02 Negative atau edge case
    Given kuis dimiliki kreator lain
    When kreator mencoba mengedit/menghapus atau membaca kuis PRIVATE
    Then server menolak tanpa perubahan; listing tidak membocorkan kuis PRIVATE
```

### US-04 — Quiz Studio dan enam tipe soal

Sebagai **CREATOR**, saya ingin menyusun kuis melalui editor tiga panel. Sumber: §4.5–4.6, §8.2.C.

```gherkin
Feature: US-04 Quiz Studio dan enam tipe soal
  Scenario: AC-04-01 Happy path
    Given kreator membuka kuis sendiri
    When ia mengubah slide, mengurutkan, menduplikasi, menghapus, dan menyimpan konfigurasi valid
    Then seluruh metadata, urutan, media, opsi, explanation dan konfigurasi enam tipe soal tersimpan dalam satu transaksi

  Scenario: AC-04-02 Negative atau edge case
    Given slide kosong atau aturan tipe soal belum lengkap
    When kreator mencoba menjalankan kuis
    Then slide diberi indikator dan kuis tidak dapat dijalankan sampai valid; draft tetap dapat disimpan tanpa dianggap siap dimainkan
```

### US-05 — Import dan export kuis

Sebagai **CREATOR**, saya ingin memindahkan materi lewat JSON atau CSV. Sumber: §6.2, §12 milestone 3.

```gherkin
Feature: US-05 Import dan export kuis
  Scenario: AC-05-01 Happy path
    Given file .kabukineko.json atau CSV sesuai skema impor
    When kreator mengimpor lalu mengekspor JSON
    Then isi kuis dan urutan soal dipertahankan serta pemilik hasil impor adalah kreator tersebut

  Scenario: AC-05-02 Negative atau edge case
    Given file rusak, tipe soal tidak didukung, atau media tidak dapat diakses
    When impor divalidasi
    Then error menunjukkan lokasi masalah dan tidak meninggalkan kuis parsial; kode dan URL eksternal tidak dieksekusi
```

### US-06 — Upload dan asset library

Sebagai **CREATOR**, saya ingin menggunakan gambar, audio, dan video yang aman. Sumber: §3.2, §4.3, §6.3, §9 scenario 1.

```gherkin
Feature: US-06 Upload dan asset library
  Scenario: AC-06-01 Happy path
    Given unggahan valid berada dalam batas ukuran dan driver local atau s3 aktif
    When kreator mengunggah lalu memilih aset
    Then gambar menjadi WebP quality 82 maksimal 1920px tanpa upscaling; audio/video tervalidasi tersimpan dan dapat digunakan dari library

  Scenario: AC-06-02 Negative atau edge case
    Given signature file salah, ukuran melampaui batas, atau storage gagal
    When upload diterima
    Then operasi ditolak dengan error jelas dan tidak membuat record sukses yang menunjuk file hilang
```

### US-07 — Menyiapkan dan memoderasi lobi

Sebagai **CREATOR sebagai host**, saya ingin mengundang peserta dan mengendalikan room. Sumber: §7.1, §8.2.B.

```gherkin
Feature: US-07 Menyiapkan dan memoderasi lobi
  Scenario: AC-07-01 Happy path
    Given kuis valid dan host berwenang
    When host membuat room, memilih display mode, friendly nickname dan kontrol audio
    Then server mengalokasikan PIN unik enam digit; URL dan QR tersedia, avatar serta jumlah peserta diperbarui langsung

  Scenario: AC-07-02 Negative atau edge case
    Given pengguna bukan host room
    When ia mengirim start, lock, kick, skip, next atau end
    Then aksi ditolak; kick oleh host mencabut kemampuan token pemain untuk kembali ke slot yang sama
```

### US-08 — Join PIN/QR dan identitas

Sebagai **PLAYER**, saya ingin bergabung tanpa akun dengan nickname dan avatar. Sumber: §7.1, §8.2.A, §10.

```gherkin
Feature: US-08 Join PIN/QR dan identitas
  Scenario: AC-08-01 Happy path
    Given room terbuka dan belum penuh
    When pemain memasukkan PIN atau membuka URL QR lalu memilih nickname serta salah satu enam gaya DiceBear
    Then satu slot dan sessionToken dibuat; avatar seed dapat diacak dan lobi menampilkan identitasnya

  Scenario: AC-08-02 Negative atau edge case
    Given PIN tidak valid, room terkunci/penuh, nickname duplikat/terlarang atau lebih dari 15 karakter
    When pemain mencoba join
    Then server menolak dengan pesan yang dapat ditindaklanjuti; request melewati 10 per 60 detik per IP dibatasi
```

### US-09 — Gamepad dan display mode

Sebagai **PLAYER**, saya ingin menjawab sesuai tipe soal dan perangkat. Sumber: §8.1, §8.2.A.

```gherkin
Feature: US-09 Gamepad dan display mode
  Scenario: AC-09-01 Happy path
    Given room memasuki QUESTION_ANSWERING
    When pemain berinteraksi dengan soal
    Then PROJECTOR menampilkan kontrol geometris dan STREAMER juga menampilkan materi; single/true-false/poll memakai pilihan, multiple memakai konfirmasi, text memakai input, puzzle memakai urutan

  Scenario: AC-09-02 Negative atau edge case
    Given soal belum terbuka atau jawaban sudah diterima
    When pemain mencoba submit atau mengganti avatar di luar LOBBY
    Then server menolak perubahan tidak sah dan UI menampilkan status yang konsisten
```

### US-10 — Timer, grace dan anti-cheat

Sebagai **PLAYER**, saya ingin mendapat penilaian waktu yang konsisten. Sumber: §5.1–5.2, §7, D-01.

```gherkin
Feature: US-10 Timer, grace dan anti-cheat
  Scenario: AC-10-01 Happy path
    Given soal berdurasi 20 detik dan belum ditutup lebih awal
    When waktu mencapai 20 detik lalu paket jawaban diterima pada 21 detik
    Then UI sudah terkunci, paket diterima tanpa membuka kunci jawaban sebelumnya, dan skor memakai timestamp server dengan timeRatio maksimum 1

  Scenario: AC-10-02 Negative atau edge case
    Given jawaban datang lebih dari 21,5 detik atau setelah reveal/skip
    When server memproses submit termasuk payload timestamp atau skor palsu
    Then jawaban ditolak dan tidak mengubah skor; kunci TYPE_ANSWER, sort_order benar, dan isCorrect tidak bocor sebelum reveal
```

### US-11 — Skor dan streak

Sebagai **PLAYER**, saya ingin mendapat poin sesuai akurasi dan kecepatan. Sumber: §5.2, §9 scenario 2, D-02.

```gherkin
Feature: US-11 Skor dan streak
  Scenario: AC-11-01 Happy path
    Given basePoints 750, streak sebelumnya 1, dan MULTIPLE_SELECT memiliki K=2 jawaban benar
    When pemain memilih C=1 opsi benar tanpa opsi salah
    Then base parsial 375 ditambah bonus 100 menghasilkan delta 475 dan streak 2

  Scenario: AC-11-02 Negative atau edge case
    Given pemain memilih opsi salah atau tidak menjawab
    When soal diselesaikan
    Then skor nol dan streak reset; POLL selalu nol dan tidak mengubah streak; multiplier 0 pada non-POLL nol termasuk bonus dan reset streak
```

### US-12 — Pemulihan sesi pemain

Sebagai **PLAYER**, saya ingin melanjutkan permainan setelah koneksi terputus. Sumber: §7.1–7.2, §9 scenario 3.

```gherkin
Feature: US-12 Pemulihan sesi pemain
  Scenario: AC-12-01 Happy path
    Given slot pemain masih ada dan sessionToken valid
    When pemain refresh dan melakukan join kembali
    Then slot, avatar, skor, streak dan status sudah-menjawab dipulihkan melalui room:state_sync tanpa duplikasi

  Scenario: AC-12-02 Negative atau edge case
    Given token milik room lain, telah dicabut, atau state room sudah kedaluwarsa
    When klien meminta pemulihan
    Then server menolak pemulihan identitas; retry jawaban yang sebelumnya diterima tidak memberi poin kedua kali
```

### US-13 — Reveal, leaderboard dan podium

Sebagai **CREATOR sebagai host**, saya ingin menampilkan hasil permainan secara jelas. Sumber: §5.1, §7.2, §8.2.B.

```gherkin
Feature: US-13 Reveal, leaderboard dan podium
  Scenario: AC-13-01 Happy path
    Given penerimaan jawaban ditutup
    When host melanjutkan reveal dan leaderboard hingga soal terakhir
    Then grafik dan explanation tampil; Top 5 dan biggest climber tersedia; podium menampilkan juara 3, 2, 1 yang tersedia dengan animasi dan konfeti

  Scenario: AC-13-02 Negative atau edge case
    Given peserta kurang dari tiga atau event next terkirim dua kali
    When server melanjutkan state
    Then UI hanya merender juara yang ada dan satu transisi valid diterapkan tanpa melewati soal
```

### US-14 — Laporan dan CSV

Sebagai **CREATOR sebagai host**, saya ingin meninjau akurasi dan hasil peserta. Sumber: §4.7, §6.4.

```gherkin
Feature: US-14 Laporan dan CSV
  Scenario: AC-14-01 Happy path
    Given sesi mencapai PODIUM atau diakhiri host
    When penyimpanan laporan berhasil dan host membuka laporan
    Then snapshot sesi, statistik pemain, jawaban, soal tersulit dan CSV tersedia dengan data yang konsisten

  Scenario: AC-14-02 Negative atau edge case
    Given finalisasi diulang, transaksi gagal, atau pengguna bukan host meminta laporan
    When server memproses permintaan
    Then tidak ada laporan duplikat/parsial atau kebocoran; kegagalan tidak ditampilkan sebagai sukses dan finalisasi dapat dicoba kembali
```

### US-15 — Pengaturan dan cleanup

Sebagai **SUPERADMIN**, saya ingin memelihara instansi serta kapasitas media. Sumber: §4.1, §6.5, §9 scenario 4.

```gherkin
Feature: US-15 Pengaturan dan cleanup
  Scenario: AC-15-01 Happy path
    Given SUPERADMIN membuka settings dan ada media yang tidak direferensikan
    When ia memperbarui batas atau menjalankan cleanup
    Then settings tervalidasi dan tersimpan, metrik ditampilkan, aset orphan dihapus dengan ringkasan scanned/deleted/freed

  Scenario: AC-15-02 Negative atau edge case
    Given aset masih direferensikan atau penghapusan storage gagal
    When cleanup memproses aset
    Then aset terpakai tetap utuh dan kegagalan dicatat tanpa menghapus record seolah file berhasil dihapus
```

### US-16 — Driver infrastruktur dan scaling

Sebagai **SUPERADMIN**, saya ingin memilih infrastruktur lewat environment. Sumber: §2–3, §11.

```gherkin
Feature: US-16 Driver infrastruktur dan scaling
  Scenario: AC-16-01 Happy path
    Given konfigurasi sqlite/postgres/mysql, local/s3, memory/redis valid
    When aplikasi bootstrap dengan driver terpilih
    Then kontrak data dan perilaku tetap setara; migrasi mengikuti DB_AUTO_MIGRATE; Redis memungkinkan host dan pemain di instance berbeda

  Scenario: AC-16-02 Negative atau edge case
    Given driver tidak dikenal atau dependensi yang dipilih tidak tersedia
    When bootstrap atau healthcheck dijalankan
    Then error terdiagnosis tanpa membocorkan secret dan tanpa beralih diam-diam ke driver lain atau kehilangan data
```

### US-17 — Self-host Docker

Sebagai **Server Maintainer**, saya ingin menjalankan instalasi default dan profil scale. Sumber: §11.2, §12.

```gherkin
Feature: US-17 Self-host Docker
  Scenario: AC-17-01 Happy path
    Given Docker tersedia dan konfigurasi deployment memenuhi kontrak
    When maintainer menjalankan compose default atau profile scale
    Then default menjalankan web/api dengan SQLite/uploads persisten; scale menyiapkan PostgreSQL/Redis/MinIO beserta bucket dan driver yang sesuai

  Scenario: AC-17-02 Negative atau edge case
    Given container default dibuat ulang dengan volume yang sama
    When aplikasi menyala kembali
    Then akun, kuis dan media tetap tersedia; state game in-memory yang hilang tidak diklaim dapat dipulihkan
```

### US-18 — Identitas visual dan aksesibilitas

Sebagai **PLAYER/CREATOR**, saya ingin mengoperasikan UI tanpa bergantung pada warna atau mouse. Sumber: §8, §10.

```gherkin
Feature: US-18 Identitas visual dan aksesibilitas
  Scenario: AC-18-01 Happy path
    Given pengguna membuka player, host atau studio
    When ia bernavigasi dengan keyboard atau teknologi bantu
    Then tema Kabuki Neko konsisten, warna jawaban disertai bentuk dan label, fokus terlihat, serta puzzle dapat diurutkan dengan tombol

  Scenario: AC-18-02 Negative atau edge case
    Given audio autoplay diblokir atau pengguna memilih reduced motion
    When halaman permainan dimuat
    Then kontrol untuk memulai audio tersedia dan informasi hasil tetap terbaca tanpa mengandalkan suara/animasi
```

### US-19 — Distribusi dan atribusi

Sebagai **Server Maintainer**, saya ingin mengetahui ketentuan penggunaan produk. Sumber: §1.4, §9 scenario 5.

```gherkin
Feature: US-19 Distribusi dan atribusi
  Scenario: AC-19-01 Happy path
    Given distribusi aplikasi telah disiapkan
    When pengguna membuka LICENSE, footer atau About Admin
    Then ketentuan dan atribusi yang diminta §1.4 tersedia konsisten termasuk penggunaan pribadi/internal serta larangan resale/paid SaaS

  Scenario: AC-19-02 Negative atau edge case
    Given paket distribusi kehilangan LICENSE atau atribusi
    When pemeriksaan rilis dilakukan
    Then rilis tidak dinyatakan memenuhi acceptance criteria lisensi
```

### US-20 — Kinerja dan audit operasional

Sebagai **Server Maintainer**, saya ingin memverifikasi keandalan dan menelusuri tindakan penting. Sumber: §10, §17.

```gherkin
Feature: US-20 Kinerja dan audit operasional
  Scenario: AC-20-01 Happy path
    Given 200 klien aktif pada satu room dengan lingkungan benchmark tercatat
    When uji broadcast dan tindakan admin dijalankan
    Then p95 broadcast di bawah 50ms dan audit tindakan penting tersedia dengan timestamp, aktor, resource, hasil serta correlation ID

  Scenario: AC-20-02 Negative atau edge case
    Given beban melampaui target atau input/log mengandung token dan secret
    When hasil uji dan log diperiksa
    Then kegagalan target dilaporkan jujur dan data rahasia tidak muncul pada log
```
