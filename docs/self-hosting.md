# Self-hosting Kabuki Neko with Docker

Panduan ini untuk operator yang ingin menjalankan Kabuki Neko di server sendiri dengan Docker,
tanpa perlu menjadi developer. / This guide is for operators who want to run Kabuki Neko on their
own server with Docker, without being developers.

- [Bahasa Indonesia](#bahasa-indonesia)
- [English](#english)

Detail teknis lanjutan / advanced technical details:
[deployment.md](deployment.md) (Compose, profiles, secrets),
[operations.md](operations.md) (backup/restore, recovery limits),
[security-headers.md](security-headers.md) (HTTPS, HSTS, CSP),
[performance-results.md](performance-results.md) (measured capacity).

> **Penting / Important — audio.** Hak distribusi musik bawaan **belum terverifikasi**
> (`releaseStatus: release-unverified` di [audio-provenance.json](audio-provenance.json); izin
> OpenTracks diperlukan). Jangan menyebarkan ulang image atau paket ini ke publik sebelum status
> itu `cleared`. / The distribution rights of the bundled music are **not verified** yet
> (OpenTracks permission is needed). Do not redistribute the images or this package publicly until
> that status is `cleared`. See [release-checklist.md](release-checklist.md).

---

## Bahasa Indonesia

### 1. Prasyarat

| Kebutuhan | Minimum                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker    | Docker Engine 24 atau lebih baru, dengan plugin **Compose v2.24 atau lebih baru** (`docker compose version`). Pengguna Anda boleh menjalankan `docker` (grup `docker`); tidak perlu `sudo` untuk perintah di panduan ini.               |
| CPU / RAM | Profil default: 2 vCPU, 2 GB RAM (terukur saat idle: API ±110 MB + web ±50 MB). Profil scale: 2 vCPU, 4 GB RAM (PostgreSQL, Redis, MinIO ±100 MB lagi saat idle). Build image dari source butuh lebih banyak: sediakan 4 GB saat build. |
| Disk      | Disarankan **20 GB** kosong (profil default) atau **30 GB** (profil scale), dengan batas bawaan. Rinciannya di §6a "Ruang disk".                                                                                                        |
| Jaringan  | Untuk HTTPS: sebuah domain yang DNS-nya mengarah ke server, port 80 dan 443 terbuka dari internet.                                                                                                                                      |

### 2. Unduh

```bash
git clone https://github.com/Neko-Koubou/Kabuki-Neko.git
cd kabuki-neko
git checkout <tag-rilis>   # gunakan tag rilis, bukan cabang pengembangan
```

Image dibangun di server Anda dari source ini (`--build`); proyek tidak menerbitkan image ke
registry.

Audio sudah disimpan dalam bentuk **teroptimasi** di `audio-assets/kabuki-neko-audio/` (WebM/Opus
dan MP3 per cue, beserta manifest dan kredit). Build hanya menyalin dan memverifikasinya, jadi
tidak ada langkah optimasi audio dan ffmpeg tidak diperlukan untuk audio saat self-host.

### 3. Konfigurasi

```bash
cp .env.example docker/.env
```

Compose membaca `docker/.env`. Yang **wajib** Anda ubah hanyalah alamat publik:

- **Dengan HTTPS (disarankan, lihat §5):** aktifkan satu baris `KN_DOMAIN=quiz.sekolah.sch.id`.
- **Tanpa HTTPS (coba lokal saja):** biarkan default (`http://localhost:3000` dan
  `http://localhost:3001`). Hanya untuk dicoba dari komputer yang sama.
- Jika memakai reverse proxy Anda sendiri: `KN_PUBLIC_URL` (alamat web) dan `KN_API_PUBLIC_URL`
  (alamat API) sesuai yang dilihat browser, plus `TRUST_PROXY_CIDRS` berisi alamat proxy Anda.

Nama instansi diatur saat setup pertama (§4), bukan di file ini. **Jangan** menaruh password atau
secret apa pun di `docker/.env`: secret JWT, password database, dan kunci S3 dibuat otomatis
sekali saat start pertama dan disimpan di volume Docker.

### 4. Menjalankan

Profil default (SQLite, state game di memori, media lokal):

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps    # tunggu api dan web "healthy"
```

Buka `http://localhost:3000/setup` (atau `https://<domain>/setup` dengan HTTPS), lalu buat akun
administrator pertama dan nama instansi. Halaman setup hanya bisa dipakai sekali.

Profil scale (PostgreSQL 16, Redis 7, MinIO S3) untuk lebih banyak ruang game dan restart tanpa
kehilangan game yang sedang berjalan:

```bash
DEPLOYMENT_PROFILE=scale ALLOW_INSECURE_LOCAL_HTTP=true \
  docker compose -f docker/docker-compose.yml --profile scale up -d --build
```

`ALLOW_INSECURE_LOCAL_HTTP=true` di sini hanya mengizinkan koneksi HTTP **internal** ke MinIO di
jaringan privat Compose; alamat yang dibuka browser tetap harus HTTPS untuk produksi. Jangan
berpindah profil setelah ada data: data **tidak** dipindahkan antar-profil
([deployment.md](deployment.md#configuration)).

### 5. HTTPS otomatis (opsional, disarankan)

`docker/docker-compose.tls.yml` menambahkan reverse proxy Caddy dengan sertifikat TLS otomatis
untuk satu domain. Semua (web, API, socket game, media) memakai satu alamat `https://<domain>`.

```bash
# docker/.env berisi KN_DOMAIN=quiz.sekolah.sch.id
docker compose -f docker/docker-compose.yml -f docker/docker-compose.tls.yml up -d --build
# profil scale:
DEPLOYMENT_PROFILE=scale ALLOW_INSECURE_LOCAL_HTTP=true docker compose \
  -f docker/docker-compose.yml -f docker/docker-compose.tls.yml --profile scale up -d --build
```

- Hanya Caddy yang membuka port (80, 443); port API, web, dan MinIO tidak dibuka sama sekali.
- `/api`, `/socket.io` (WebSocket, timeout baca 120 detik), dan `/uploads` diteruskan ke API,
  `/kabuki-neko-media` ke MinIO (profil scale), sisanya ke web.
- API hanya memercayai `X-Forwarded-For` dari alamat tetap Caddy (`KN_PROXY_ADDRESS`).
- Caddy menambahkan HSTS (1 tahun). Aktifkan override ini hanya bila domain benar-benar akan
  selalu memakai HTTPS.
- Selalu gunakan `--build` setelah mengganti `KN_DOMAIN`: alamat publik ditanam ke image web.

### 6. Letak data

Data disimpan di **named volume** Docker (bukan folder di repo), dengan awalan nama proyek
`kabuki-neko_`:

| Volume                                            | Isi                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `kabuki-data`                                     | database SQLite, secret runtime yang dibuat otomatis, ledger media |
| `kabuki-uploads`                                  | media unggahan (profil default)                                    |
| `kabuki-secrets`                                  | kredensial profil scale                                            |
| `kabuki-postgres`, `kabuki-redis`, `kabuki-minio` | data layanan profil scale                                          |
| `caddy-data`, `caddy-config`                      | sertifikat TLS (override HTTPS)                                    |

`docker compose down` **tidak** menghapus volume. Jangan pernah menjalankan `down -v` pada proyek
produksi kecuali Anda memang ingin menghapus semua data.

### 6a. Ruang disk

Docker **tidak bisa membatasi ukuran named volume**. Karena itu Kabuki Neko membatasi bagian yang
tumbuh, dengan nilai bawaan yang disarankan, dan Anda bisa menaruh data di disk atau partisi
berukuran tertentu.

**Kebutuhan ruang yang disarankan** (dengan nilai bawaan):

| Bagian                    | Profil default                     | Profil scale                                 |
| ------------------------- | ---------------------------------- | -------------------------------------------- |
| Image                     | ±1,8 GB (+2–4 GB cache saat build) | ±2,3 GB (+2–4 GB cache saat build)           |
| Database                  | SQLite, sediakan 2 GB              | PostgreSQL, sediakan 5 GB                    |
| Media unggahan            | sampai kuota (10 GB)               | MinIO, sampai kuota (10 GB)                  |
| Redis                     | —                                  | AOF, sediakan 2× `KN_REDIS_MAXMEMORY` (2 GB) |
| Log container             | 2 × 3 × 10 MB ≈ 60 MB              | 7 × 3 × 10 MB ≈ 210 MB                       |
| **Total yang disarankan** | **20 GB kosong**                   | **30 GB kosong**                             |

**Pengaturan** (di `docker/.env`, lihat `.env.example`):

| Variabel                  | Bawaan  | Arti                                                                                                     |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `MEDIA_STORAGE_QUOTA_MIB` | `10240` | Total media unggahan (MiB). API menolak unggahan yang melewatinya ("batas tercapai"); `0` = tanpa batas. |
| `KN_LOG_MAX_SIZE`         | `10m`   | Ukuran satu file log container sebelum dirotasi.                                                         |
| `KN_LOG_MAX_FILE`         | `3`     | Jumlah file log yang disimpan per container.                                                             |
| `KN_REDIS_MAXMEMORY`      | `1gb`   | Batas memori Redis (profil scale). Saat penuh, tulisan gagal secara eksplisit; state game tidak dibuang. |

Kuota media bersifat lunak saat ada unggahan bersamaan: total bisa melewati kuota paling banyak
sebanyak (unggahan paralel × batas ukuran per file). Menghapus media, atau membersihkan media
yatim di halaman admin, membebaskan kuota.

Pemakaian Redis bergantung pada jumlah dan ukuran room aktif: room besar (200 pemain, banyak
soal) memakan beberapa MB. Pantau dengan
`docker compose -f docker/docker-compose.yml --profile scale exec redis redis-cli INFO memory`
(`used_memory_human`), lalu naikkan `KN_REDIS_MAXMEMORY` bersama `MAX_ACTIVE_ROOMS` bila perlu.

**Data di folder pilihan Anda (batas keras lewat disk/partisi).** Override
`docker/docker-compose.paths.yml` memetakan volume data ke folder host. Taruh folder itu di disk
atau partisi berukuran tertentu agar total ruang benar-benar dibatasi oleh filesystem:

```bash
sudo mkdir -p /srv/kabuki-neko/data /srv/kabuki-neko/uploads
sudo chown 10001:10001 /srv/kabuki-neko/data /srv/kabuki-neko/uploads
# profil scale juga: postgres (uid 70), redis (uid 999), minio (uid 65532)
echo "KN_STORAGE_ROOT=/srv/kabuki-neko" >> docker/.env
docker compose -f docker/docker-compose.yml -f docker/docker-compose.paths.yml up -d
```

Folder harus ada sebelum start pertama dan dapat ditulis oleh uid tersebut. Memindahkan instance
yang sudah berjalan ke folder host tidak memindahkan datanya: backup dulu lalu restore (§8).

**Memantau pemakaian:** `docker system df -v` (image, volume, cache build), `du -sh /srv/kabuki-neko/*`
(dengan override paths), dan `docker builder prune` untuk membersihkan cache build lama.

### 7. Upgrade

```bash
git fetch --tags && git checkout <tag-rilis-baru>
# backup dulu (§8), lalu:
docker compose -f docker/docker-compose.yml [-f docker/docker-compose.tls.yml] up -d --build
```

Migrasi database berjalan otomatis saat API start, di bawah lock database, sehingga hanya satu
proses yang menjalankannya. Image web dan API harus dari build yang sama: web baru "healthy"
setelah katalog bahasanya cocok dengan API.

### 8. Backup dan restore

Ikuti [operations.md](operations.md): backup database (SQLite/PostgreSQL), media, dan secret
bersama-sama, lalu uji restore secara berkala. Tanpa volume `kabuki-data` (profil default) atau
`kabuki-secrets` (profil scale), sesi login lama tidak dapat dipakai lagi.

### 9. Uji cepat (smoke test)

```bash
bash scripts/selfhost-smoke.sh                 # profil default, membangun image
bash scripts/selfhost-smoke.sh --profile scale # profil scale
bash scripts/selfhost-smoke.sh --tls           # lewat Caddy dengan KN_DOMAIN=localhost
```

Skrip ini memakai proyek Compose terpisah (`kn-smoke-…`) dan port acak, jadi tidak menyentuh
instalasi Anda. Ia memeriksa `/`, `/api/v1/auth/setup-status`, `/join`, melakukan setup, me-restart,
lalu memastikan data tetap ada. Volumenya hanya dihapus bila Anda menambahkan `--purge`
(`--no-build` memakai image yang sudah ada).

### 10. Troubleshooting

| Gejala                                                                      | Penyebab dan solusi                                                                                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port is already allocated`                                                 | Port sudah dipakai program lain. Ubah `KN_WEB_PORT`/`KN_API_PORT`/`KN_MEDIA_PORT` (atau `KN_HTTP_PORT`/`KN_HTTPS_PORT` untuk Caddy) di `docker/.env`.                                              |
| Halaman terbuka tetapi login/game gagal, atau mengarah ke `localhost`       | Alamat publik salah. Perbaiki `KN_DOMAIN` atau `KN_PUBLIC_URL`/`KN_API_PUBLIC_URL`, lalu `up -d --build` (alamat ditanam di image web). Jangan memakai nama service Compose (`api`, `web`).        |
| Login berhasil tetapi langsung keluar lagi                                  | Cookie refresh tidak terkirim: web dan API harus satu situs dan HTTPS. Pakai override HTTPS (satu domain) atau subdomain dari domain yang sama.                                                    |
| Error `ORIGIN_DENIED` (403) atau CORS di konsol browser                     | Alamat web yang dibuka browser berbeda dari `KN_PUBLIC_URL`/`KN_DOMAIN` (termasuk `http` vs `https` dan port).                                                                                     |
| Profil scale: API berhenti karena `S3_ENDPOINT`/`S3_PUBLIC_URL` tidak valid | Produksi menolak alamat S3 `http://`. MinIO bawaan memakai HTTP internal: set `ALLOW_INSECURE_LOCAL_HTTP=true` (seperti pada §4), dan pakai HTTPS untuk alamat media publik.                       |
| Container `unhealthy`                                                       | `docker compose -f docker/docker-compose.yml ps` lalu `logs api` / `logs web`. Web tetap unhealthy bila API mati atau katalog bahasa API dan web berasal dari build berbeda: build ulang keduanya. |
| Rate limit terasa terlalu ketat di belakang proxy sendiri                   | `TRUST_PROXY_CIDRS` harus berisi alamat proxy Anda (JSON, mis. `["10.0.0.5/32"]`), agar API melihat IP klien asli.                                                                                 |
| Sertifikat tidak terbit                                                     | DNS domain belum mengarah ke server, atau port 80/443 tertutup firewall. Lihat `logs caddy`.                                                                                                       |

### 11. Batasan

- Profil default menyimpan game yang sedang berjalan **di memori**: restart atau upgrade
  mengakhiri game yang aktif (laporan dan kuis tetap aman di database). Profil scale menyimpan
  state game di Redis (AOF).
- Kapasitas bukan sertifikasi. Hasil ukur: satu node memori lulus 200 pemain (p95 19 ms); dua
  node Redis **belum** memenuhi target ([performance-results.md](performance-results.md)).
  `MAX_ACTIVE_ROOMS` adalah batas, bukan jaminan.
- Compose ini menjalankan satu API. Lebih dari satu API memerlukan PostgreSQL/MySQL + Redis,
  secret JWT yang sama, dan sticky session ([deployment.md](deployment.md)).
- Tidak ada update otomatis dan tidak ada image resmi di registry.

---

## English

### 1. Requirements

| Need      | Minimum                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker    | Docker Engine 24 or newer with the **Compose v2.24 or newer** plugin (`docker compose version`). Your user may run `docker` (the `docker` group); no command in this guide needs `sudo`.                                         |
| CPU / RAM | Default profile: 2 vCPU, 2 GB RAM (measured idle: API ~110 MB + web ~50 MB). Scale profile: 2 vCPU, 4 GB RAM (PostgreSQL, Redis, MinIO add ~100 MB idle). Building the images from source needs more: allow 4 GB while building. |
| Disk      | Recommended **20 GB** free (default profile) or **30 GB** (scale profile), with the default limits. Details in §6a "Disk space".                                                                                                 |
| Network   | For HTTPS: a domain whose DNS points at the server, with ports 80 and 443 reachable from the internet.                                                                                                                           |

### 2. Download

```bash
git clone https://github.com/Neko-Koubou/Kabuki-Neko.git
cd kabuki-neko
git checkout <release-tag>   # use a release tag, not a development branch
```

The images are built on your server from this source (`--build`); the project does not publish
images to a registry.

### 3. Configure

```bash
cp .env.example docker/.env
```

Compose reads `docker/.env`. The only thing you **must** change is the public address:

- **With HTTPS (recommended, see §5):** uncomment one line, `KN_DOMAIN=quiz.example.org`.
- **Without HTTPS (local evaluation only):** keep the defaults (`http://localhost:3000` and
  `http://localhost:3001`). Only for trying it out from the same computer.
- Behind your own reverse proxy: `KN_PUBLIC_URL` (web) and `KN_API_PUBLIC_URL` (API) as browsers
  see them, plus `TRUST_PROXY_CIDRS` with your proxy's addresses.

The instance name is set during first-run setup (§4), not here. **Never** put passwords or secrets
in `docker/.env`: the JWT secrets, database password and S3 keys are generated once on first start
and kept in Docker volumes.

### 4. Run

Default profile (SQLite, in-memory game state, local media):

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps    # wait for api and web to be "healthy"
```

Open `http://localhost:3000/setup` (or `https://<domain>/setup` with HTTPS) and create the first
administrator and the instance name. The setup page works only once.

Scale profile (PostgreSQL 16, Redis 7, MinIO S3), for more game rooms and restarts that keep
running games:

```bash
DEPLOYMENT_PROFILE=scale ALLOW_INSECURE_LOCAL_HTTP=true \
  docker compose -f docker/docker-compose.yml --profile scale up -d --build
```

`ALLOW_INSECURE_LOCAL_HTTP=true` here only allows the **internal** HTTP connection to MinIO on the
private Compose network; browser-facing addresses must still be HTTPS in production. Do not switch
profiles once you have data: data is **not** moved between profiles
([deployment.md](deployment.md#configuration)).

### 5. Automatic HTTPS (optional, recommended)

`docker/docker-compose.tls.yml` adds a Caddy reverse proxy with automatic TLS certificates for one
domain. Everything (web, API, game socket, media) uses the single address `https://<domain>`.

```bash
# docker/.env contains KN_DOMAIN=quiz.example.org
docker compose -f docker/docker-compose.yml -f docker/docker-compose.tls.yml up -d --build
# scale profile:
DEPLOYMENT_PROFILE=scale ALLOW_INSECURE_LOCAL_HTTP=true docker compose \
  -f docker/docker-compose.yml -f docker/docker-compose.tls.yml --profile scale up -d --build
```

- Only Caddy publishes ports (80, 443); the API, web and MinIO ports are not published at all.
- `/api`, `/socket.io` (WebSocket, 120 s read timeout) and `/uploads` go to the API,
  `/kabuki-neko-media` to MinIO (scale profile), everything else to the web app.
- The API trusts `X-Forwarded-For` only from Caddy's fixed address (`KN_PROXY_ADDRESS`).
- Caddy adds HSTS (one year). Use the override only for a domain that will always serve HTTPS.
- Always use `--build` after changing `KN_DOMAIN`: the public address is built into the web image.

### 6. Where the data lives

Data lives in Docker **named volumes** (not folders in the repository), prefixed with the project
name `kabuki-neko_`:

| Volume                                            | Contents                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `kabuki-data`                                     | SQLite database, generated runtime secrets, media origin ledger |
| `kabuki-uploads`                                  | uploaded media (default profile)                                |
| `kabuki-secrets`                                  | scale profile credentials                                       |
| `kabuki-postgres`, `kabuki-redis`, `kabuki-minio` | scale profile service data                                      |
| `caddy-data`, `caddy-config`                      | TLS certificates (HTTPS override)                               |

`docker compose down` does **not** delete volumes. Never run `down -v` on a production project
unless you really mean to delete all data.

### 6a. Disk space

Docker **cannot limit the size of a named volume**. Kabuki Neko therefore bounds what grows, with
recommended defaults, and you can put the data on a disk or partition of a chosen size.

**Recommended space** (with the defaults):

| Part                  | Default profile               | Scale profile                             |
| --------------------- | ----------------------------- | ----------------------------------------- |
| Images                | ±1.8 GB (+2–4 GB build cache) | ±2.3 GB (+2–4 GB build cache)             |
| Database              | SQLite, allow 2 GB            | PostgreSQL, allow 5 GB                    |
| Uploaded media        | up to the quota (10 GB)       | MinIO, up to the quota (10 GB)            |
| Redis                 | —                             | AOF, allow 2× `KN_REDIS_MAXMEMORY` (2 GB) |
| Container logs        | 2 × 3 × 10 MB ≈ 60 MB         | 7 × 3 × 10 MB ≈ 210 MB                    |
| **Recommended total** | **20 GB free**                | **30 GB free**                            |

**Settings** (in `docker/.env`, see `.env.example`):

| Variable                  | Default | Meaning                                                                                           |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `MEDIA_STORAGE_QUOTA_MIB` | `10240` | Total uploaded media (MiB). The API refuses uploads past it ("limit reached"); `0` = unlimited.   |
| `KN_LOG_MAX_SIZE`         | `10m`   | Size of one container log file before it rotates.                                                 |
| `KN_LOG_MAX_FILE`         | `3`     | Log files kept per container.                                                                     |
| `KN_REDIS_MAXMEMORY`      | `1gb`   | Redis memory cap (scale profile). When full, writes fail explicitly; game state is never dropped. |

The media quota is soft under concurrent uploads: the total can pass it by at most (parallel
uploads × the per-file limit). Deleting media, or cleaning orphaned media on the admin page, frees
quota.

Redis use depends on the number and size of active rooms: a large room (200 players, many
questions) takes a few MB. Watch it with
`docker compose -f docker/docker-compose.yml --profile scale exec redis redis-cli INFO memory`
(`used_memory_human`) and raise `KN_REDIS_MAXMEMORY` together with `MAX_ACTIVE_ROOMS` if needed.

**Data in folders you choose (hard limit through a disk or partition).** The
`docker/docker-compose.paths.yml` override maps the data volumes to host folders. Put those
folders on a disk or partition of a fixed size so the filesystem really caps the total:

```bash
sudo mkdir -p /srv/kabuki-neko/data /srv/kabuki-neko/uploads
sudo chown 10001:10001 /srv/kabuki-neko/data /srv/kabuki-neko/uploads
# scale profile too: postgres (uid 70), redis (uid 999), minio (uid 65532)
echo "KN_STORAGE_ROOT=/srv/kabuki-neko" >> docker/.env
docker compose -f docker/docker-compose.yml -f docker/docker-compose.paths.yml up -d
```

The folders must exist before the first start and be writable by those uids. Moving a running
instance to host folders does not move its data: back up first, then restore (§8).

**Watching usage:** `docker system df -v` (images, volumes, build cache), `du -sh /srv/kabuki-neko/*`
(with the paths override), and `docker builder prune` to clear an old build cache.

### 7. Upgrade

```bash
git fetch --tags && git checkout <new-release-tag>
# back up first (§8), then:
docker compose -f docker/docker-compose.yml [-f docker/docker-compose.tls.yml] up -d --build
```

Database migrations run automatically when the API starts, under a database lock, so only one
process applies them. The web and API images must come from the same build: the web becomes
healthy only once its language catalog matches the API's.

### 8. Backup and restore

Follow [operations.md](operations.md): back up the database (SQLite/PostgreSQL), media and secrets
together, and test a restore regularly. Without the `kabuki-data` volume (default profile) or
`kabuki-secrets` (scale profile), existing sign-in sessions can no longer be used.

### 9. Smoke test

```bash
bash scripts/selfhost-smoke.sh                 # default profile, builds the images
bash scripts/selfhost-smoke.sh --profile scale # scale profile
bash scripts/selfhost-smoke.sh --tls           # through Caddy with KN_DOMAIN=localhost
```

The script uses a separate Compose project (`kn-smoke-…`) and random ports, so it never touches
your installation. It checks `/`, `/api/v1/auth/setup-status` and `/join`, runs the first-run
setup, restarts, and confirms the data is still there. Its volumes are deleted only when you add
`--purge` (`--no-build` reuses existing images).

### 10. Troubleshooting

| Symptom                                                                  | Cause and fix                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port is already allocated`                                              | Another program uses the port. Change `KN_WEB_PORT`/`KN_API_PORT`/`KN_MEDIA_PORT` (or `KN_HTTP_PORT`/`KN_HTTPS_PORT` for Caddy) in `docker/.env`.                                                    |
| Pages load but sign-in or games fail, or point at `localhost`            | Wrong public address. Fix `KN_DOMAIN` or `KN_PUBLIC_URL`/`KN_API_PUBLIC_URL`, then `up -d --build` (the address is built into the web image). Never use Compose service names (`api`, `web`).        |
| Sign-in works but you are signed out right away                          | The refresh cookie is not sent: web and API must be the same site and HTTPS. Use the HTTPS override (one domain) or subdomains of one domain.                                                        |
| `ORIGIN_DENIED` (403) or CORS errors in the browser console              | The web address in the browser differs from `KN_PUBLIC_URL`/`KN_DOMAIN` (including `http` vs `https` and the port).                                                                                  |
| Scale profile: the API stops on an invalid `S3_ENDPOINT`/`S3_PUBLIC_URL` | Production refuses `http://` S3 addresses. The bundled MinIO uses internal HTTP: set `ALLOW_INSECURE_LOCAL_HTTP=true` (as in §4), and use HTTPS for the public media address.                        |
| A container is `unhealthy`                                               | `docker compose -f docker/docker-compose.yml ps`, then `logs api` / `logs web`. The web stays unhealthy while the API is down or when web and API catalogs come from different builds: rebuild both. |
| Rate limits feel too strict behind your own proxy                        | `TRUST_PROXY_CIDRS` must list your proxy's addresses (JSON, e.g. `["10.0.0.5/32"]`) so the API sees real client addresses.                                                                           |
| No certificate is issued                                                 | The domain's DNS does not point here yet, or a firewall blocks ports 80/443. See `logs caddy`.                                                                                                       |

### 11. Limits

- The default profile keeps running games **in memory**: a restart or upgrade ends active games
  (reports and quizzes stay safe in the database). The scale profile keeps game state in Redis
  (AOF).
- Capacity is not a certification. Measured: one in-memory node passed 200 players (p95 19 ms);
  two Redis nodes do **not** meet the target yet ([performance-results.md](performance-results.md)).
  `MAX_ACTIVE_ROOMS` is a limit, not a guarantee.
- This Compose file runs one API. More API nodes need PostgreSQL/MySQL + Redis, the same JWT
  secrets and sticky sessions ([deployment.md](deployment.md)).
- There are no automatic updates and no official images in a registry.
