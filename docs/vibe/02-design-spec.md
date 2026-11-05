# 02 — UI/UX & Frontend Design Specification: Kabuki Neko

Tanggal: **2026-10-28 (Asia/Jakarta)**. Versi: **1.0**. Tahap: **Stage 2 — spesifikasi desain, belum implementasi**.

Sumber: [00-project-context.md](00-project-context.md) dan [01-prd.md](01-prd.md) v1.3.0, termasuk D-01–D-04, BR-01–BR-20, US-01–US-21. Inspeksi workspace saat desain: belum ada frontend, stylesheet, Tailwind config, komponen, manifest, atau aset merek; repositori Git sudah tersedia. Tambahan multibahasa pengguna dicatat secara aditif pada PRD §19 dan konteks proyek. Seluruh fitur P0 tetap dicakup; endpoint, skema, dan event tambahan yang dibutuhkan UI ditandai untuk Stage 3.

UI **multibahasa extensible** dengan paket awal `en`, `id`, `ja`, `zh-Hans`, `es`, `fr`; contoh copy dan wireframe dalam dokumen menggunakan Bahasa Indonesia. Nama/kode locale adalah baseline PRD §19. Identifier kontrak tetap bahasa Inggris. Tidak menambahkan billing, SSO, marketplace, AI generator, atau ujian asinkron. Rute selain yang eksplisit dalam PRD merupakan usulan navigasi frontend untuk difinalisasi SA.

## 1. Arah estetika dan prinsip pengalaman

**Panggung Kabuki yang ramah, dengan alat kerja kreator yang tenang.** Gunakan Sumi Ink untuk panggung host, Kumadori Crimson sebagai aksen utama, dan Kabuki Gold untuk perhatian/selebrasi. Dashboard memakai permukaan terang netral, hierarki tipografi yang jelas, serta ruang kosong yang cukup. Hindari dekorasi di belakang teks soal, PIN, timer, atau tombol jawaban.

- **Satu aksi utama per fase:** bergabung, menjawab, melanjutkan, atau menyimpan. Aksi destruktif masuk menu sekunder; Start/Skip/Next tidak berbagi label ambigu.
- **Bentuk + huruf + makna:** opsi selalu memiliki bentuk dan huruf A–D. Benar/salah, koneksi, validasi, dan lock memiliki ikon serta teks; warna bukan satu-satunya informasi.
- **Server menentukan fakta:** timer lokal menggambarkan tenggat server; skor, penerimaan jawaban, jumlah peserta, dan fase tidak dikarang klien.
- **Kepadatan mengikuti peran:** player fokus pada jempol dan membaca; host mudah terbaca dari jauh; studio menampilkan kontrol lengkap tanpa memaksa semua panel terbuka di ponsel.
- **Draft aman:** perubahan lokal terlihat jelas; “Tersimpan” hanya setelah respons berhasil. Kesalahan jaringan tidak menghapus input.
- **Recovery terlihat:** status “Menghubungkan kembali…” tidak disamarkan sebagai loading awal. Sinkronisasi tidak mengulang countdown atau jawaban yang telah diterima.
- **Maskot secukupnya:** kucing kabuki menyapa pada landing/lobi, menunggu pada empty/loading, dan merayakan podium. Tidak mengejek jawaban salah. Placeholder siluet/monogram tetap bekerja sebelum aset tersedia. Ilustrasi dekoratif `aria-hidden`; logo informatif berlabel “Kabuki Neko”.

### 1.1. Pola navigasi dan izin

| Peran / shell | Navigasi | Aturan |
| --- | --- | --- |
| Publik | Logo → `/`, Gabung → `/join`, Masuk → `/login` | Nama instansi dan atribusi konsisten; registrasi mengikuti setup-status |
| Creator | Kuis, Media, Laporan, Tentang; menu profil: tema dan keluar | Dashboard hanya memuat resource yang diizinkan; kuis PUBLIC kreator lain dapat dilihat/duplikasi/host |
| Superadmin | Navigasi Creator + Pengaturan + Pengguna & undangan | Tidak otomatis memperoleh akses edit kuis PRIVATE atau laporan host lain |
| Player | Identitas, skor, streak, status koneksi; Keluar pada menu | Tidak ada navigasi dashboard; recovery berdasarkan token room, bukan hanya PIN |
| Host | Panggung, toolbar fase, audio, menu Akhiri sesi | Hanya host sesi mengendalikan; host recovery wajib diverifikasi server |

Tautan yang tidak diizinkan disembunyikan; akses langsung tetap menghasilkan halaman aman. Tidak merender konten terlindungi sementara pemeriksaan akses berlangsung. Status 404/403 untuk resource sensitif tidak membocorkan judul atau pemilik.

## 2. Design tokens dan tema

Token merupakan kontrak desain, bukan konfigurasi Tailwind yang sudah dibuat. Implementasi kelak memetakan token semantik ke CSS variables/Shadcn dan konstanta geometri bersama. Semua ukuran di bawah dalam CSS px kecuali dinyatakan lain.

### 2.1. Warna semantik

| Token | Light | Dark | Penggunaan |
| --- | --- | --- | --- |
| `brand.crimson` | `#D9381E` | `#D9381E` | Identitas asli PRD, logo/dekorasi |
| `brand.gold` | `#F59E0B` | `#F59E0B` | Identitas asli PRD |
| `brand.ink` | `#18181B` | `#18181B` | Identitas asli PRD |
| `primary` / `on-primary` | `#D9381E` / `#FFFFFF` | `#FF8A75` / `#18181B` | CTA utama; variasi dark untuk keterbacaan |
| `secondary` / `on-secondary` | `#F59E0B` / `#18181B` | `#FBBF24` / `#18181B` | Aksi pendukung dan sorotan |
| `surface.canvas` | `#FAFAF9` | `#18181B` | Latar halaman |
| `surface.panel` | `#FFFFFF` | `#27272A` | Form, kartu, dialog |
| `surface.subtle` | `#F4F4F5` | `#3F3F46` | Kelompok kontrol/dekorasi, bukan background teks muted dark |
| `text.primary` | `#18181B` | `#FAFAFA` | Isi utama |
| `text.secondary` | `#52525B` | `#A1A1AA` | Metadata pada canvas/panel |
| `border.decorative` | `#E4E4E7` | `#3F3F46` | Pemisah non-interaktif |
| `border.control` | `#71717A` | `#71717A` | Batas field, kontrol, keadaan tidak terpilih |
| `success.text` / `success.surface` | `#166534` / `#DCFCE7` | `#86EFAC` / `#143322` | Berhasil dan jawaban benar |
| `warning.text` / `warning.surface` | `#854D0E` / `#FEF3C7` | `#FCD34D` / `#3B2B10` | Draft tidak lengkap, gangguan parsial |
| `danger.text` / `danger.surface` | `#B91C1C` / `#FEE2E2` | `#FCA5A5` / `#451A1A` | Error, jawaban salah, label hapus |
| `focus` | `#1D4ED8` | `#93C5FD` | Ring fokus di canvas/panel |
| `scrim` | `#18181B` pada 64% | `#000000` pada 72% | Latar dialog, bukan background teks |

Preferensi tema: `system | light | dark`, disimpan per browser. Host default dark; player default dark pada fase permainan dan mengikuti preferensi pada join. Theme switch tidak mengubah fase/seleksi. Keempat warna opsi **tetap sama pada kedua tema**. Field/button disabled memakai label tetap terbaca, warna netral dan ikon bila perlu; jangan mengurangi opacity seluruh kontrol sampai teks tak terbaca.

### 2.2. Warna dan geometri jawaban (tidak boleh ditukar)

| Indeks / label | Background | Bentuk | Teks dan ikon | Kontras hasil hitung |
| --- | --- | --- | --- | --- |
| 0 / A | `#E21B3C` | Segitiga ▲ | `#FFFFFF` | 4.71:1 |
| 1 / B | `#1368CE` | Belah ketupat ◆ | `#FFFFFF` | 5.39:1 |
| 2 / C | `#D89E00` | Lingkaran ● | `#18181B` | 7.43:1 |
| 3 / D | `#26890C` | Persegi ■ | `#FFFFFF` | 4.50066:1 |

Kuning tidak menggunakan teks putih. Hijau lolos ambang 4.5:1 dengan margin sangat tipis: warna solid harus persis, tanpa opacity, tint, gradient, atau overlay pada pasangan teksnya. Hover cukup elevasi/border; selected menambah check dan outline ganda hitam/putih. Fokus pada kartu berwarna memakai outline ganda putih dan ink agar tidak mengandalkan token fokus biru yang bisa menyatu dengan opsi B. Gunakan SVG geometri lokal yang konsisten, bukan bergantung pada bentuk glyph font; glyph di dokumen hanya notasi wireframe.

Perhitungan luminans sRGB lokal pada 2026-10-28: primary light/putih 4.63:1; secondary light/ink 8.25:1; primary dark/ink 7.71:1; text primary pada canvas light 16.96:1 dan dark 16.97:1; muted pada canvas light 7.40:1 dan dark 6.91:1; border control pada panel light 4.83:1 dan dark 3.08:1. Status text/surface: success 6.49/9.80, warning 6.15/9.46, danger 5.30/7.82 (light/dark). Angka ini verifikasi pasangan token, **bukan sertifikasi aksesibilitas aplikasi**; seluruh variasi hover/focus/disabled dan hasil render tetap diperiksa QA.

### 2.3. Tipografi

Keluarga utama: **Noto Sans**, self-host WOFF2 subset Latin, fallback `system-ui, sans-serif`; heading menggunakan keluarga sama. PIN/timer/angka: **ui-monospace, SFMono-Regular, Menlo, monospace** dan tabular numerals. Cukup font weight 400, 600, 700, 800; jangan mengunduh seluruh keluarga font. Semua font tetap opsional agar teks dapat dirender segera dengan fallback.

| Token | Size / line-height | Weight | Pemakaian |
| --- | --- | --- | --- |
| `text.caption` | 12 / 18 | 400–600 | Timestamp/metadata sekunder, bukan instruksi utama |
| `text.small` | 14 / 20 | 400–600 | Help text, badge |
| `text.body` | 16 / 24 | 400 | Form/input dan isi umum; input mobile minimal 16 |
| `text.label` | 16 / 24 | 600 | Tombol dan label |
| `text.title-sm` | 20 / 28 | 700 | Judul kartu/dialog |
| `text.title` | 28 / 36 | 700 | Judul halaman mobile |
| `text.display` | 40 / 48 | 800 | Landing/halaman desktop |
| `game.prompt` | 24 / 32 mobile; 40 / 52 pada host 1280; 48 / 60 pada 1920 | 700 | Teks soal penuh |
| `game.option` | 18 / 26 player; 28 / 36 host | 700 | Opsi STREAMER / host |
| `game.pin` | 40 / 48 mobile; 80 / 88 desktop; 112 / 120 pada 1920 | 800 | Enam digit, leading zero dipertahankan |
| `game.timer` | 28 / 36 player; 56 / 64 host | 800 | Angka dengan unit detik yang berlabel |

Long text tidak dikecilkan di bawah minimum untuk memaksa muat. Nama/judul pada daftar boleh ellipsis 1–2 baris dengan detail yang dapat dibuka via keyboard; prompt, opsi aktif, error, dan pembahasan harus terbaca penuh dengan wrapping/scroll. Gunakan `overflow-wrap` untuk string tanpa spasi. Jangan menaruh tooltip sebagai satu-satunya akses teks lengkap.

### 2.4. Spacing, grid, radius, elevation

| Kelompok | Token / nilai |
| --- | --- |
| Spacing | `space.0=0`, `1=4`, `2=8`, `3=12`, `4=16`, `5=20`, `6=24`, `8=32`, `10=40`, `12=48`, `16=64` |
| Breakpoint | mobile `<768`; tablet `768–1199`; desktop `>=1200`; host besar `>=1600` |
| Page container | max 1280; padding 16 mobile, 24 tablet, 32 desktop; shell sidebar 224 desktop |
| Grid | 4 kolom mobile/gap16; 8 tablet/gap24; 12 desktop/gap24; kartu kuis 1/2/3 kolom |
| Studio | desktop: rail 224 + canvas min 480 flex + properties 288, gap16; tablet: rail 184 + canvas dan properties drawer; mobile: satu panel dengan tabs Slide/Editor/Properti |
| Host | referensi 1920×1080 dan 1280×720 (16:9), inset 32–48; tidak mengunci orientation atau mengubah seluruh panggung menjadi bitmap kecil |
| Player | width max 640, min supported viewport 320; min-height mengikuti dynamic viewport, safe-area pada footer; jawaban min-height 112, type/puzzle fleksibel |
| Radius | `sm=6` field; `md=12` kartu/answer pad; `lg=20` modal; `pill=999` badge/avatar |
| Elevation | `0=none`; `1=0 2px 6px #18181B14`; `2=0 8px 24px #18181B1F`; `3=0 20px 60px #00000040`; dark memakai border tambahan |
| Layer | base0; sticky10; menu20; scrim30; dialog40; toast50; tooltip60; ring fokus tidak boleh terpotong |
| Target | baseline produk 44×44 minimum untuk semua target; primary mobile 48 tinggi; ikon dengan hit area 44 meskipun glyph 20 |

Scroll utama halaman mengikuti dokumen; desktop studio boleh memiliki rail/properties scroll independen berlabel. Mobile tidak menumpuk area scroll tanpa kebutuhan. Sticky submit tidak menutupi field, error, atau fokus saat virtual keyboard terbuka.

## 3. Inventaris layar dan traceability

ID layar digunakan pada wireframe, kontrak komponen, matriks state, dan handoff. Fase game adalah state dari layar yang sama, bukan rute baru. Dialog tidak menambah histori navigasi kecuali kebutuhan deep-link ditetapkan SA.

| ID | Rute / layar | User stories | Hasil utama |
| --- | --- | --- | --- |
| S01 | `/` Landing | US-08, US-19 | Bergabung atau masuk sebagai kreator |
| S02 | `/setup` First-run wizard | US-01, US-17 | Instansi dan SUPERADMIN pertama |
| S03 | `/login` | US-01–02 | Autentikasi dan kembali ke rute tujuan yang aman |
| S04 | `/register` | US-02 | CREATOR menurut kebijakan registrasi |
| S05 | `/dashboard/quizzes` (default `/dashboard`) | US-03, US-05 | Milik saya / Publik, pencarian, CRUD/reuse |
| S06 | `/dashboard/quizzes/[quizId]` | US-03, US-07 | Detail sendiri atau read-only PUBLIC, host/duplicate/export |
| S07 | `/studio/[quizId]` | US-04, US-06, US-18 | Editor enam tipe soal dan metadata kuis |
| S08 | `/dashboard/media` | US-06 | Library media milik sendiri |
| S09 | `/dashboard/reports` | US-14 | Riwayat sesi yang di-host sendiri |
| S10 | `/dashboard/reports/[sessionId]` | US-14 | Analitik snapshot dan CSV |
| S11 | `/dashboard/settings` | US-02, US-15–17, US-20 | Settings, health detail, storage dan cleanup |
| S12 | `/dashboard/users` | US-01–02, US-15 | Pengguna dan undangan SUPERADMIN; kontrak SA masih dibutuhkan |
| S13 | `/dashboard/about` | US-19 | Identitas, atribusi, versi, ketentuan dari LICENSE |
| S14 | `/join?pin=000123` | US-08, US-12 | PIN, scan QR, customizer |
| S15 | `/play/[pin]` | US-08–13, US-18 | Lobi, delapan fase, hasil, recovery |
| S16 | `/host/[sessionId]` | US-07, US-10, US-13–14, US-18 | Panggung host, kontrol dan finalisasi |
| S17 | Fallback 404 / akses / sesi kedaluwarsa / layanan gagal | US-01, US-03, US-12, US-16–17 | Jalan pemulihan yang tepat tanpa membocorkan data |

| ID dialog | Nama | Pemicu |
| --- | --- | --- |
| M01 | Nickname & DiceBear / ubah avatar | Join valid; player LOBBY |
| M02 | Pemindai QR | S14 “Pindai QR” |
| M03 | Buat kuis / metadata kuis | S05 “Buat kuis”; S07 “Pengaturan kuis” |
| M04 | Impor kuis | S05 “Impor” |
| M05 | Asset picker / upload / YouTube | S07 media atau M03 cover |
| M06 | Persiapan host | S05/S06/S07 “Host” |
| M07 | QR diperbesar | QR S16 LOBBY |
| M08 | Pembahasan | S16 ANSWER_REVEAL |
| M09 | Konfirmasi aksi | Hapus kuis/media/slide, kick, akhiri sesi, cleanup, ubah akses pengguna, cabut undangan |
| M10 | Perubahan belum tersimpan | Keluar S07/form dirty |
| M11 | Buat / salin undangan | S12 |
| M12 | Detail jawaban peserta | S10 tabel peserta/soal |

US-16/17 tidak membutuhkan wizard pemilihan driver di UI: environment dan bootstrap tetap ranah maintainer. US-20 memerlukan logging/benchmark di backend dan QA; halaman log/audit baru tidak ditambahkan.

US-21 berlaku pada seluruh S01–S17 dan M01–M12. Kontrol bahasa tersedia di header publik/auth, menu shell dashboard, serta menu host/player. Panduan paket bahasa memakai halaman dokumentasi statis dengan pola S13; bukan layanan terjemahan eksternal.

## 4. Layout layar dan wireframe responsif

Notasi: `[Label]` = kontrol; `( )` = radio; `[x]` = checkbox; `...` = menu; kotak media/mascot adalah placeholder. Semua nama, copy, dan label terjemahan boleh wrap. Wireframe adalah struktur, bukan batas jumlah karakter. Desktop di bawah memakai lebar >=1200; mobile 320–767; tablet mengikuti aturan grid §2.4. Footer shell memuat atribusi dan tautan ketentuan.

### 4.1. Publik, setup dan autentikasi — S01–S04

```text
S01 Desktop                              Mobile
+-----------------------------------+   +-------------------------+
| Logo     [Bahasa] [Tema] [Masuk]   |   | Logo [Bahasa] [Menu]    |
| Kuis bersama, di panggungmu.       |   | Kuis bersama...         |
| [Gabung kuis] [Masuk kreator] CAT  |   | [Mascot]                |
| PIN tanpa akun; host di perangkat |   | [Gabung kuis]           |
| Atribusi / Ketentuan              |   | [Masuk kreator] Footer  |
+-----------------------------------+   +-------------------------+
S02 Desktop: centered max 560            Mobile: full-width form
+-----------------------------------+   +-------------------------+
| Logo [Bahasa]  Setup 1 dari 2      |   | Logo [Bahasa]           |
| 1 Instansi: nama [____________]   |   | Setup 1 dari 2          |
| 2 Admin: nama/email/password      |   | Nama instansi [_____]   |
| [Kembali] [Lanjut / Buat instansi] |   | [Lanjut]                |
| Error summary / legal footer     |   | Error / Footer          |
+-----------------------------------+   +-------------------------+
S03 Login / S04 Register desktop         Mobile
+-----------------------------------+   +-------------------------+
| Logo [Bahasa]                     |   | Logo [Bahasa]           |
|       Judul form max 440          |   | Masuk / Buat akun       |
|       Nama* [________________]    |   | Nama* [_____________]   |
|       Email [________________]    |   | Email [_____________]   |
|       Password [________][Lihat]  |   | Password [____][Lihat]  |
|       Kode undangan* [_______]    |   | Kode undangan* [____]   |
|       [Masuk / Buat akun]         |   | [Masuk / Buat akun]     |
|       Link registrasi / login     |   | Link / Footer           |
+-----------------------------------+   +-------------------------+
```

S02 menyimpan kedua langkah secara lokal dan hanya mengirim setup sekali pada langkah terakhir; tidak menyimpan password ke storage browser. Setup sudah selesai → penjelasan dan Masuk, termasuk ketika kalah race dengan tab lain. S03 tidak menambah reset password yang belum ada di PRD. S04 field nama hanya registrasi; kode undangan hanya INVITE_ONLY. SINGLE_ADMIN menampilkan “Pendaftaran ditutup. Hubungi pengelola instansi.” dan CTA Masuk, bukan form yang pasti ditolak. PUBLIC tidak memerlukan kode. Izinkan paste/password manager dan tampilkan aturan password dari kontrak SA, bukan aturan buatan UI yang berbeda dari server.

### 4.2. Kuis dan detail — S05–S06

```text
Desktop                                      Mobile
+----------+--------------------------------+ +-------------------------+
| Logo     | Kuis         [Impor][Buat kuis] | | [Menu] Kuis [Bahasa]    |
| Kuis     | [Milik saya][Publik] [Cari____] | | [Buat kuis] [Impor]     |
| Media    | +--------+ +--------+ +------+ | | [Milik saya][Publik]    |
| Laporan  | |cover   | |cover   | |cover | | | [Cari________________]  |
| Admin*   | |judul   | |judul   | |judul | | | [cover / judul / ...]  |
| Tentang  | |Host ...| |Host ...| |Host..| | | [Host] [Detail]         |
| Profil   | +--------+ +--------+ +------+ | | [Sebelum] 1 [Sesudah]   |
|          | [Sebelum] Halaman 1 [Sesudah]  | +-------------------------+
+----------+--------------------------------+
S06 detail desktop                           S06 mobile
+-------------------------------------------+ +-------------------------+
| [Kembali] Judul panjang         [Host]     | | [Kembali] Detail kuis   |
| Cover | Deskripsi / pemilik / PUBLIC       | | Cover / Judul / Pemilik |
|       | [Edit*][Duplikasi][Ekspor] [...]   | | [Host][Duplikasi] [...] |
| Soal: urutan / tipe / waktu / ringkasan    | | Daftar soal + detail    |
+-------------------------------------------+ +-------------------------+
```

Daftar memakai pagination 12 item sesuai PRD, query dipertahankan saat kembali. Scope Milik saya/PUBLIK perlu filter eksplisit dari SA. Kartu menampilkan judul, jumlah soal, visibility, waktu perubahan; invalid draft berlabel “Belum siap dimainkan”. Detail PUBLIC orang lain read-only: tidak menampilkan edit/hapus; duplikasi membuat milik pengguna lalu membuka studio. Ekspor JSON `.kabukineko.json`; format CSV hanya untuk impor kuis dan ekspor laporan. Tidak ada ekspor kuis CSV yang dijanjikan. Hapus melalui M09. “Host” pada draft invalid mengarahkan ke ringkasan masalah, tidak membuat room setengah valid.

### 4.3. Quiz Studio — S07

```text
Desktop
+---------------------------------------------------------------------+
| [Kembali] Judul [Metadata]  Belum disimpan  [Simpan draft] [Host]      |
+-------------+-----------------------------------+-------------------+
| SLIDE       | Prompt [_______________________]  | PROPERTI          |
| 1 [thumb] ! |          [_____________________]  | Tipe [v]          |
| 2 [thumb]   | +-------------------------------+ | Waktu [20 detik]  |
| [Naik/Turun]| | [Pilih media] / [YouTube]      | | Poin [Standard]   |
| [Duplikat]  | +-------------------------------+ | Reveal [None]     |
| [Hapus]     | A opsi [______] (kunci)          | Pembahasan [____] |
| [+ Soal]    | B opsi [______] (kunci)          | Validasi          |
+-------------+-----------------------------------+-------------------+
Mobile / tablet sempit
+-----------------------------------+
| [Kembali] Judul [Simpan] [...]     |
| [Slide] [Editor] [Properti]        |
| Panel terpilih, lebar penuh        |
| Prompt / media / opsi vertikal     |
| Error inline + status simpan       |
+-----------------------------------+
```

Semua operasi tetap tersedia di mobile. Tab hanya mengganti panel, bukan membuang form. Canvas memberi preview hierarki host, tetapi kontrol edit tetap field semantik. Draft bisa belum lengkap; validasi blok host dibedakan dari validasi struktur yang melarang save (mis. panjang berlebih). Save eksplisit sebagai baseline, shortcut Ctrl/Cmd+S; tidak mengklaim autosave sebelum arsitektur mendukungnya. Sesudah save berhasil, status “Tersimpan pukul …”; konflik versi menampilkan pilihan muat versi server atau pertahankan draft lokal untuk ditinjau, tanpa overwrite otomatis. Tidak menambahkan kolaborasi realtime.

Slide dapat diurutkan dengan drag handle dan tombol Naik/Turun. Duplikasi memilih salinan baru; hapus slide terakhir meninggalkan empty canvas dengan Tambah pertanyaan. Perubahan tipe yang membuang opsi/kunci dikonfirmasi M09 sebelum terjadi. Waktu hanya 5/10/20/30/60/90/120/240; multiplier 0/1/2; reveal NONE/GRID_3X3/GRID_5X5/BLUR (mencakup enum 5×5 meskipun ringkasan UI PRD tidak menyebutnya). Efek hanya aktif untuk gambar. Media upload dan URL YouTube saling eksklusif pada satu soal. Rentang video start/end berlabel detik, error end<=start inline.

| Tipe | Editor kunci | Player dan validasi |
| --- | --- | --- |
| SINGLE_CHOICE | 2–4 opsi, satu radio kunci | Sekali aktivasi langsung kirim satu indeks |
| TRUE_FALSE | Dua opsi Benar/Salah, satu radio kunci | A/segitiga = benar; B/belah ketupat = salah; satu indeks |
| MULTIPLE_SELECT | 2–4 opsi, checkbox kunci, minimal satu | Pilih >=1 lalu Kirim; tidak menampilkan jumlah kunci benar sebelum reveal |
| TYPE_ANSWER | Daftar teks yang diterima, minimal satu; tanpa opsi publik | Input teks + Kirim; IME tidak boleh submit pada Enter saat composition berlangsung |
| ORDER_PUZZLE | Tepat empat item dalam urutan benar; tombol urut dan drag | Empat item pada urutan permainan dari server; susun lalu Kirim; jangan mengirim urutan kunci |
| POLL | 2–4 opsi, tanpa kontrol kunci | Sekali pilih langsung kirim; badge “Polling • tanpa poin”; streak tetap |

Counter: judul 150, prompt 500, opsi/kunci 250 per entri, pembahasan 1000. Ukuran teks TYPE_ANSWER dari pemain ditetapkan SA dan ditampilkan dalam form. Perhitungan karakter Unicode harus sama frontend/backend; tidak memotong emoji atau gabungan karakter di tengah.

### 4.4. Media dan laporan — S08–S10

```text
S08 Desktop                                Mobile
+----------------------------------------+ +--------------------------+
| Media                [Unggah]          | | Media [Unggah]           |
| [Gambar][Audio][Video]                  | | [Jenis v]                |
| [thumb nama ...] [thumb nama ...]       | | [thumb] nama / size ...  |
| [preview/control] [preview/control]    | | [Putar] [Hapus]          |
| [Sebelum] Halaman 1 [Sesudah]           | | Pagination               |
+----------------------------------------+ +--------------------------+
S09 Daftar laporan desktop                  Mobile
+----------------------------------------+ +--------------------------+
| Laporan [Filter kuis v]                 | | Laporan [Filter kuis v]  |
| Judul | Tanggal | Peserta | Status      | | Judul / Tanggal          |
| Kuis A| ...     | 42      | Selesai [>] | | 42 peserta / Selesai [>] |
| Pagination                             | | Pagination               |
+----------------------------------------+ +--------------------------+
S10 Detail laporan desktop                  Mobile
+----------------------------------------+ +--------------------------+
| [Kembali] Judul snapshot [Unduh CSV]    | | [Kembali] Judul          |
| Peserta | Akurasi | Waktu | Status      | | [Unduh CSV] KPI wrap     |
| [Peserta] [Per soal]                    | | [Peserta] [Per soal]     |
| Rank Nama Skor Benar Kosong Streak Waktu| | Rank / Nama / Skor       |
| ...                       [Jawaban >]   | | Benar / Kosong [Detail]  |
| Soal tersulit: daftar + distribusi     | | Soal tersulit            |
+----------------------------------------+ +--------------------------+
```

Library 24 item/halaman. Preview gambar menggunakan object-contain agar tidak memotong materi; cover boleh object-cover dengan preview penuh. Upload menampilkan file asli, batas aktif dan progress nyata; setelah transfer status “Memproses…” sampai record tersedia. Batas default gambar 5MB, audio 10MB, video 25MB; gunakan nilai settings, jangan hardcode pesan yang bisa berbeda. Tipe yang diterima sesuai PRD; jangan menjanjikan SVG. Aset yang dipakai ditandai; hapus ditolak dengan alasan bila masih direferensikan termasuk snapshot aktif.

Laporan 15 sesi/halaman. S10 menampilkan hanya snapshot dan finalisasi server; `0` adalah nilai valid, `—` berarti tidak tersedia. Rincian mencakup final rank/score, correct/unanswered/max streak/avg response dan payload jawaban per soal melalui M12. Akurasi diberi definisi/denominator eksplisit dari server, membedakan partial MULTIPLE_SELECT, POLL, dan no-points; SA wajib menyelesaikan kontraknya sebelum implementasi. Soal tersulit memakai metrik berlabel, tidak diasumsikan semua item bernilai poin. Laporan sesi diakhiri dini berlabel “Diakhiri host”; soal yang belum dimainkan tidak disebut unanswered. CSV menunjukkan pending, unduhan siap, atau gagal; tidak menjadikan kegagalan sebagai file kosong yang berhasil.

### 4.5. Admin, pengguna, About — S11–S13

```text
S11 Desktop                                  Mobile
+-----------------------------------------+ +---------------------------+
| Pengaturan                              | | Pengaturan                |
| [Umum][Akses][Storage & health]          | | [Bagian v]                |
| Nama instansi [___] Bahasa default [v]   | | Field vertikal            |
| Registrasi [v] Max pemain [200]          | | [Simpan]                  |
| Batas gambar/audio/video; kata terlarang | | DB / Storage / State      |
| [Simpan]                                | | Status + waktu diperiksa  |
| DB / Storage / State: status + waktu    | | File / ukuran total       |
| File: n  Ukuran: n [Bersihkan orphan]    | | [Bersihkan orphan]        |
+-----------------------------------------+ +---------------------------+
S12 Desktop                                  Mobile
+-----------------------------------------+ +---------------------------+
| Pengguna & undangan [Buat undangan]      | | Pengguna & undangan       |
| [Pengguna][Undangan] [Cari____]          | | [Buat undangan] [Tab v]   |
| Nama Email Peran Status [Aksi]          | | Nama / Email              |
| ... / pagination                        | | Peran / Status [Aksi]     |
+-----------------------------------------+ +---------------------------+
S13 Desktop / panduan bahasa                  Mobile
+-----------------------------------------+ +---------------------------+
| Tentang Kabuki Neko                     | | Tentang Kabuki Neko       |
| Versi / atribusi / ringkasan penggunaan | | Versi / atribusi          |
| [Baca ketentuan resmi] [Paket bahasa]    | | Ringkasan wrap            |
| Teks dokumen max 72 karakter per baris  | | [Ketentuan][Paket bahasa] |
+-----------------------------------------+ +---------------------------+
```

S11 memisahkan konfigurasi yang bisa disimpan dari status driver read-only. Driver tidak dapat dialihkan di form. Health gagal tampil “Tidak dapat diperiksa”, bukan dianggap down tanpa bukti. Cleanup menampilkan scanned/deleted/freed dan kegagalan parsial jika ada; refresh metrik sesudah sukses. Tidak mengarang preview jumlah orphan dari jumlah file total. Bahasa default dipilih hanya dari katalog valid yang terpasang.

S12 menyediakan perubahan peran/status dan undangan sekali pakai sesuai scope administrasi PRD; larangan menonaktifkan/menurunkan SUPERADMIN terakhir wajib diputuskan SA dan diterapkan server. UI tidak mengasumsikan hak bypass resource. Kode undangan disalin manual; tidak ada email otomatis. Jika kontrak belum tersedia, ini kebutuhan implementasi untuk SA, bukan tombol dekoratif yang dianggap selesai.

S13 menampilkan teks lisensi resmi dari sumber distribusi, bukan membuat terjemahan legal yang dianggap menggantikan aslinya. Ringkasan UI dapat diterjemahkan dan berlabel ringkasan. Panduan bahasa memuat unduh/salin template, terjemahkan, validasi, pasang, build/restart jika dibutuhkan, verifikasi picker, dan rollback ke paket valid. Detail perintah/lokasi disediakan SA. Semua tautan harus punya target nyata sebelum rilis.

### 4.6. Join dan player — S14–S15

```text
S14 desktop centered max 440                Mobile
+----------------------------------------+ +---------------------------+
| Logo / mascot            [Bahasa]      | | Logo / mascot [Bahasa]    |
| Masukkan PIN permainan                 | | Masukkan PIN permainan    |
| [ 0 0 0 1 2 3 ]                         | | [ 0 0 0 1 2 3 ]          |
| [Gabung] [Pindai QR]                    | | [Gabung]                  |
| Error inline / [Kembali]                | | [Pindai QR] Error inline  |
+----------------------------------------+ +---------------------------+
S15 shell (desktop max640; mobile full width)
+---------------------------------------+
| Avatar Nama    Skor 1.850  Streak 2 [...]|
| Status koneksi / Soal 3 dari 10         |
| Konten fase (lihat tabel di bawah)     |
| Area jawaban / hasil                   |
| Footer kontekstual + safe area         |
+---------------------------------------+
```

PIN satu field `type=text`, `inputmode=numeric`, bukan enam field terpisah; paste enam digit tetap utuh. Autofocus pada entry manual ketika tidak mengganggu modal/recovery; deep-link `?pin=` mengisi dan memeriksa PIN satu kali lalu membuka M01 jika valid. Tidak auto-join sebelum identitas lengkap. QR dari kamera hanya menerima format join yang dikenali untuk instansi ini; jangan otomatis menavigasi URL arbitrer. Rate limit mengikuti server, copy menyebut kapan dapat mencoba lagi dari retry metadata; jangan auto-retry PIN invalid berulang.

| Fase S15 | Wireframe konten desktop/mobile (shell sama) | Perilaku |
| --- | --- | --- |
| LOBBY | `[Avatar besar] / Halo, Nama / Menunggu host / [Ubah avatar]` | Nickname tetap setelah join; avatar hanya dapat diubah di lobi |
| GAME_START_COUNTDOWN | `Kuis akan dimulai / 3 ... 2 ... 1` | Nilai tersinkron; tombol jawaban belum ada |
| QUESTION_PREVIEW | `Soal n/N / Tipe / Prompt / Bersiap menjawab` | 4 detik; teks preview sesuai payload, tanpa opsi/kunci |
| QUESTION_ANSWERING PROJECTOR | `Timer / Lihat layar host / [A ▲][B ◆] / [C ●][D ■]` | Bentuk dan huruf raksasa; grid 2×2, dua opsi jadi dua kartu; jumlah opsi sesuai snapshot |
| QUESTION_ANSWERING STREAMER | `Timer / Prompt / Media / [A teks][B teks] / [C teks][D teks]` | Isi penuh dapat scroll; pada 320px/teks panjang opsi satu kolom, tidak dipotong |
| ANSWER_REVEAL | `Ikon + Benar/Parsial/Salah/... / +poin / Bonus / Skor / Rank / Menunggu host` | Feedback hanya dari hasil individual server; explanation dapat tampil hanya bila payload mengizinkan |
| LEADERBOARD | `Peringkatmu n / Top 5 / Biggest climber / Menunggu host` | Tidak otomatis melompat ke soal berikut sebelum server |
| PODIUM | `Juara tersedia 3,2,1 / Hasilmu / Skor akhir` | Tidak mengisi juara fiktif bila peserta <3 |
| FINISHED | `Permainan selesai / Hasil akhir / [Gabung kuis lain]` | Tidak memberikan laporan host kepada player |

```text
Variasi area jawaban (semua pada desktop/mobile, wrap sesuai ruang)
SINGLE / TRUE_FALSE / POLL        MULTIPLE_SELECT
+---------------------------+    +---------------------------+
| [A shape] [B shape]        |    | [x A shape] [  B shape]    |
| [C shape] [D shape]*       |    | [x C shape] [  D shape]    |
| Satu ketuk langsung kirim  |    | [Kirim jawaban (2 dipilih)]|
+---------------------------+    +---------------------------+
TYPE_ANSWER                      ORDER_PUZZLE
+---------------------------+    +---------------------------+
| Jawaban [_______________] |    | 1 [Item A] [Naik][Turun]   |
| [Kirim jawaban]            |    | 2 [Item B] [Naik][Turun]   |
+---------------------------+    | 3 [Item C] [Naik][Turun]   |
                                 | 4 [Item D] [Naik][Turun]   |
                                 | [Kirim urutan]             |
                                 +---------------------------+
```

`*` hanya jika opsi ada. Pada PROJECTOR, puzzle tetap memiliki label item untuk dapat diurutkan dan input text tetap berlabel; mode tidak menghilangkan kontrol penting. Huruf/bentuk puzzle melekat pada identitas item saat berpindah, bukan posisi visual. Poll memakai single select dengan copy netral.

**Status jawaban terpisah dari fase room:** idle → submitting (“Mengirim…”, input terkunci) → accepted (“Jawaban terkirim. Menunggu hasil…”) atau rejected dengan alasan. ACK timeout = “Status jawaban belum diketahui. Memeriksa…” lalu state sync, tidak langsung sukses atau membolehkan jawaban kedua. Hanya retry payload yang sama jika kontrak server memastikan dedup. Nilai hasil/score tidak optimistis.

Pada deadline alami, input terkunci di nol dan copy “Waktu habis. Menunggu hasil…” selama grace 1.500ms, tanpa CTA kirim baru. Paket yang sudah in-flight dapat diterima server. Skip/semua menjawab menutup segera tanpa grace. Jangan menampilkan jawaban benar, partial, atau bonus selama grace. Reconnect menyelaraskan deadline dan status accepted; draft pilihan hanya boleh dipulihkan jika soal sama, belum accepted dan waktu masih terbuka.

Feedback parsial: “Sebagian benar” + poin dasar parsial + bonus streak, bukan merah/salah. POLL: “Pilihan tercatat” tanpa benar/salah dan tanpa perubahan streak. Non-POLL no-points: hasil benar/salah boleh terlihat, label “Soal tanpa poin”, skor/bonus nol dan streak reset sesuai server. Unanswered dan TIME_EXPIRED dibedakan dari jawaban salah yang benar-benar terkirim.

### 4.7. Panggung host — S16

```text
Desktop LOBBY 16:9                            Mobile host
+------------------------------------------+ +---------------------------+
| Gabung: domain/join  PIN 000123 [copy] QR | | URL / PIN [Copy] [QR]     |
| Judul kuis        [Audio][Volume][Track] | | Judul / Audio [...]       |
| [avatar nama] [avatar nama] [avatar ...] | | Grid 2 kolom peserta      |
| [avatar ... ] [avatar ... ] [avatar ...] | | Peserta 42 / 200          |
| 42 peserta  [Kunci ruang] [Mulai] [...]  | | [Kunci ruang][Mulai]      |
+------------------------------------------+ +---------------------------+
Desktop QUESTION_ANSWERING                    Mobile host
+------------------------------------------+ +---------------------------+
| Soal 3/10: prompt lengkap                 | | Soal 3/10 / Prompt        |
| (20s)      [Media, contain]     42/50     | | Timer / Jawaban 42/50     |
|                                          | | Media                     |
| [A shape + teks] [B shape + teks]         | | [A + teks] [B + teks]     |
| [C shape + teks] [D shape + teks]         | | [C + teks] [D + teks]     |
| [Audio]                   [Lewati waktu] | | [Lewati waktu]            |
+------------------------------------------+ +---------------------------+
```

Host mobile memakai alur vertikal dan toolbar sticky; bukan memaksa rasio 16:9 yang membuat semua teks kecil. Desktop untuk prompt/opsi ekstrem hingga batas PRD menyediakan area scroll teks berlabel dan mode perluas prompt; tidak memangkas isi atau menyembunyikan opsi di balik overlay. Uji juga proyektor 1280×720. Media error tidak memblokir seluruh UI: host dapat menunggu/mencoba lagi atau melewati waktu, tanpa otomatis menyatakan soal selesai.

| Fase S16 lain | Wireframe desktop | Mobile dan aturan |
| --- | --- | --- |
| GAME_START_COUNTDOWN | `Judul / jumlah soal / angka besar 3..2..1` | Sama, satu kolom; toolbar end tetap pada menu |
| QUESTION_PREVIEW | `Soal n/N / tipe + multiplier / prompt besar / Bersiap` | Prompt wrap penuh; 4 detik dari server |
| ANSWER_REVEAL | `Prompt / diagram A B C D + jumlah / opsi + check / [Pembahasan] [Lihat klasemen atau Podium]` | Diagram horizontal/daftar jumlah pada layar sempit; Next jelas sesuai next state |
| LEADERBOARD | `Top 5: avatar nama skor perubahan / Biggest climber / [Soal berikutnya]` | Daftar vertikal tanpa horizontal scroll; maksimal lima tersedia |
| PODIUM | `Sorotan 3 → 2 → 1 / avatar nama skor / status laporan` | Stack urutan final 1,2,3; hanya entri ada; reduced motion hasil langsung |
| FINISHED | `Selesai / Hasil akhir / [Lihat laporan] [Kembali ke kuis]` | Link laporan hanya jika ready; retry finalisasi bila gagal |

Reveal SINGLE/TRUE_FALSE/POLL/MULTIPLE memakai distribusi per opsi, label angka, bentuk dan alternatif tabel. MULTIPLE total pilihan dapat melebihi jumlah peserta: label “Jumlah pemilih per opsi”, bukan persentase yang diasumsikan total 100%. POLL tidak menandai jawaban benar. TYPE_ANSWER menampilkan jawaban diterima + jumlah benar/salah/tidak menjawab; ORDER_PUZZLE menampilkan urutan benar + jumlah hasil. Kontrak reveal kedua tipe ini perlu diperluas di SA; jangan membocorkan kuncinya lewat payload answering.

Grid peserta tidak menggeser fokus setiap kali pemain masuk; gunakan ID stabil, scroll/virtualisasi terukur untuk 200 pemain, dan total tetap terlihat. Kick tersedia pada hover **dan** tombol menu yang terlihat saat focus/touch. Disconnect berbeda dari kick; pemain disconnected diberi badge dan slot dipertahankan. Lock menunggu ACK; mengunci tidak mengeluarkan pemain lama yang melakukan recovery.

### 4.8. Fallback — S17

```text
Desktop max560                           Mobile
+--------------------------------------+ +---------------------------+
| Logo [Bahasa]                         | | Logo [Bahasa]             |
| [Ikon] Sesi tidak tersedia            | | Sesi tidak tersedia       |
| Alasan aman + langkah berikutnya      | | Penjelasan wrap           |
| [Gabung dengan PIN lain] [Beranda]     | | [CTA utama] [Beranda]     |
+--------------------------------------+ +---------------------------+
```

Varian: halaman tidak ditemukan → Beranda; auth kedaluwarsa → Masuk (pertahankan draft non-rahasia di memori); akses tidak ada → Kembali; room hilang/expired setelah restart → Gabung lagi; kicked → “Kamu telah dikeluarkan oleh host” tanpa auto-rejoin; koneksi digantikan sesi lain → “Sesi dibuka di perangkat lain”; layanan gagal → Coba lagi dan correlation ID aman bila tersedia. Room yang hilang tidak disebut berhasil dipulihkan. Koneksi sementara memakai banner di layar aktif, bukan selalu mengganti layar dengan fallback.

### 4.9. Dialog — M01–M12

Semua dialog mengikuti pola ini, dengan isi khusus pada tabel. Desktop max-width 480 normal / 880 media & import / 1040 detail. Mobile lebar viewport minus 32px; M02/M05/M12 full-height sheet dengan header dan close tetap terlihat. Body dapat scroll; footer sticky tidak menutupi error. Satu dialog aktif; konfirmasi yang dipanggil dari picker mengganti isi sementara dan kembali setelah dibatalkan, bukan menumpuk focus trap.

```text
Desktop modal                           Mobile sheet
+------------------------------------+  +----------------------------+
| Judul                         [X]  |  | [Kembali] Judul       [X] |
| Deskripsi / konteks                 |  | Konteks                    |
| Isi sesuai M-ID                    |  | Isi, satu kolom            |
| Status / error inline              |  | Scroll + error             |
| [Batal]               [Aksi utama] |  | [Batal] [Aksi utama]        |
+------------------------------------+  +----------------------------+
```

| Dialog | Isi desktop (urutan wireframe) | Mobile / CTA dan konsekuensi |
| --- | --- | --- |
| M01 Identitas | `Avatar preview | 6 gaya / [Acak] / Nickname 0/15 atau [Acak nama aman] / [Gabung]` | Preview di atas; enam gaya grid 2 kolom. Ubah avatar setelah join tidak mengedit nickname; CTA Simpan avatar. Friendly name dari server, tanpa field bebas |
| M02 Scanner | `Preview kamera / bingkai / [Ganti kamera jika tersedia] / Status / [Masukkan PIN]` | Kamera dibuka hanya setelah aksi pengguna; permission denied/insecure context memberi entry manual; tutup menghentikan stream |
| M03 Metadata | `Judul / Deskripsi / Cover [Pilih] / Visibility / Track BGM / [Buat atau Terapkan]` | Field stack; default PRIVATE. Buat menghasilkan satu slide kosong; perubahan metadata pada studio masih draft sampai Save |
| M04 Import | `[Pilih JSON/CSV] / Nama file / format dan limit / [Impor] / Error lokasi baris+field` | Error list full width, fokus ke summary. Server memvalidasi sebelum commit; sukses membuka kuis baru. Tidak mengarang langkah preview server yang belum punya endpoint |
| M05 Media picker | `[Library][Unggah][YouTube*] / filter / grid / preview / [Gunakan media]` | Grid 2→1 bila sempit; preview di bawah. `*` hanya media soal, bukan cover; cover hanya image. YouTube: URL/start/end, validasi allowlist SA |
| M06 Host config | `Judul / jumlah soal / (Projector) (Streamer) + deskripsi / Friendly nickname [ ] / [Buka lobi]` | Pilihan vertikal; defaults PROJECTOR, friendly off sebagai baseline. Tidak membuat room sebelum submit, disable pending; server validasi snapshot |
| M07 QR besar | `URL / QR berkontras tinggi / PIN / [Salin tautan]` | QR max min(320, lebar tersedia), quiet zone utuh; URL/PIN tetap alternatif; [Tutup] |
| M08 Pembahasan | `Prompt ringkas / explanation penuh / [Tutup]` | Teks wrap/scroll; hanya saat reveal. Tombol tidak ada bila explanation kosong |
| M09 Konfirmasi | `Nama target / dampak eksplisit / [Batal] [Aksi spesifik]` | Hapus kuis/media permanen; hapus slide/ubah tipe masih draft; Kick menyebut nickname & akses dicabut; End menyebut hasil sampai saat ini akan disimpan; cleanup menyebut hanya aset tak terpakai; akses akun/undangan menyebut target. Fokus awal Batal |
| M10 Unsaved | `Ada perubahan belum tersimpan / [Tetap di sini] [Buang perubahan] [Simpan lalu lanjut]` | Tombol stack; save gagal tetap di halaman dengan draft. Browser unload menggunakan dialog bawaan jika tersedia, bukan janji draft persisten |
| M11 Undangan | `Buat undangan sekali pakai / [Buat] → Kode/tautan + [Salin] / Status` | Tidak ada tombol email; masa berlaku mengikuti kontrak SA. Kode sensitif tidak masuk analytics/log/toast |
| M12 Jawaban | `Nama peserta / soal snapshot / jawaban dikirim vs hasil / waktu / poin / bonus` | Daftar berlabel per soal; payload puzzle/multiple ditampilkan bermakna, bukan JSON mentah; unanswered ditulis “Tidak menjawab” |

Escape/backdrop menutup dialog biasa tanpa menjalankan aksi destruktif. Menutup saat request terkirim tidak membatalkan operasi server; status pending dipertahankan oleh parent dan direkonsiliasi saat dibuka kembali. Tidak mengulang permintaan mutasi yang statusnya belum pasti.

## 5. Hierarki komponen, props, events dan kepemilikan state

Kontrak berikut adalah spesifikasi antarmuka komponen, bukan kode production atau pengganti DTO shared. Tipe domain memakai union/schema tervalidasi; tidak ada `any`. Event callback adalah intent UI, bukan bukti server sudah menyetujui.

```text
AppProviders (locale, theme, auth, preferences)
├─ PublicShell → PublicAuthForms / PinJoinScanner / DocumentView
├─ DashboardShell
│  ├─ QuizLibraryDetail → QuizCard, pagination, metadata/host dialogs
│  ├─ StudioEditor → SlideNavigator + QuestionFields + properties
│  ├─ AssetLibraryPickerUpload / ImportExport
│  ├─ ReportAnalytics → DataTable + ResultChart + answer detail
│  └─ AdminSettingsHealth / UserInvites / DocumentView
├─ PlayerShell → ConnectionRecovery + PlayerStageAnswerPad
│  ├─ AvatarCustomizer / GameTimer
│  └─ ResultChartLeaderboardPodium
└─ HostShell → ConnectionRecovery + HostStageLobby
   ├─ GameTimer + MediaPreview + AudioControls
   └─ ResultChartLeaderboardPodium + report finalization notice

Semua shell → LocalePicker, StatusNotice, base primitives sesuai kebutuhan
```

### 5.1. Reusable base components

| ID / komponen (varian) | Props wajib / opsional utama | Events | State lokal / sumber kebenaran |
| --- | --- | --- | --- |
| B01 `ActionButton` (text/icon) | label, variant, disabled, pending, accessibleName untuk icon-only | onPress | focus lokal; pending controlled parent; native button |
| B02 `FormField` (text/password/number/select/textarea) | id, label, value, required, help, error, limit, options, autocomplete | onChange, onBlur | reveal password/focus lokal; value di form; server errors dipetakan field |
| B03 `ChoiceGroup` (radio/checkbox/tabs) | label, items{id,label,disabled}, selected, mode, orientation | onSelect | active focus lokal; selected controlled; tidak memakai index visual sebagai ID |
| B04 `ModalSheet` | open, title, description?, size, initialFocus, pending? | onCloseRequest | focus trap/return focus lokal; parent menjaga mutasi pending |
| B05 `MenuPopover` | triggerLabel, items{id,label,action,disabled}, placement | onAction, onOpenChange | open/focus lokal; izin item dari domain parent |
| B06 `StatusNotice` (banner/toast/empty) | kind, title, message, action?, correlationId?, livePriority | onAction, onDismiss | visibility lokal; status faktual dari parent; error penting persistent |
| B07 `SkeletonBlock` | layout, accessibleLoadingLabel, reducedMotion | tidak ada | presentasional; container memberi aria-busy; dekorasi aria-hidden |
| B08 `StatusBadge` | label, icon, tone | tidak ada | stateless; tidak ada badge kosong tanpa makna |
| B09 `ContentCard` | heading, media?, metadata, actions, href? | onOpen | stateless; hindari nested link/button di satu klik wrapper |
| B10 `DataCollection` (table/list/pagination) | items, columns, rowKey, page, pageCount, sort?, pending, error? | onPage, onSort, onRowAction | fokus lokal; pagination/query di URL; total unknown bukan 0 |
| B11 `MediaPreview` | asset union image/audio/video/youtube, alt/description?, playbackRange?, revealMode, revealProgress | onReady, onError, onUserPlay | load/playback lokal; progres reveal dari waktu server; tanpa URL liar |
| B12 `AvatarIllustration` (DiceBear/mascot) | style, seed, size, label?, decorative, expression? | tidak ada | render deterministik lokal; avatar fallback mempertahankan nickname |

### 5.2. Feature components

| ID / komponen | Props / events utama | State dan batas tanggung jawab |
| --- | --- | --- |
| F01 `PublicAuthForms` | mode, setupStatus, passwordPolicy; onSubmit, onStepChange | Form lokal; auth global setelah sukses; tanpa persist password |
| F02 `QuizLibraryDetail` | scope, page, quiz summary/detail, capabilities; onCreate/Edit/Duplicate/Delete/Host/Export | Query/list server; permission server; local filter tidak membuka resource PRIVATE |
| F03 `StudioEditor` | quiz, revision, validationIssues; onSave, onMetadataChange, onHost, onLeave | `useStudioStore`: working draft + last saved snapshot + dirty flag; tidak share store dengan game |
| F04 `SlideNavigator` | slides{id,index,type,issues}, selectedId; onSelect/Add/Move/Duplicate/Delete | Fokus/drop position lokal; urutan draft global studio berdasarkan ID stabil |
| F05 `QuestionFields` | question union enam tipe, limits, media; onPatch, onTypeChangeRequest | Field errors lokal; key jawaban hanya tersedia pada editor berizin |
| F06 `AssetLibraryPickerUpload` | mode browse/select, allowedKinds, activeLimits, selectedId; onUpload/Select/Delete | File/progress lokal; aset baru hanya usable setelah server sukses; permission library dari server |
| F07 `ImportExport` | formats, schemaVersion, limits, resourceId; onImport, onExport | Request state parent; error lokasi; unduhan di browser tanpa token di URL publik |
| F08 `AdminSettingsHealth` | settings, metrics, health, installedLocales; onSave, onRefresh, onCleanup | Draft settings lokal; hasil/lastCheckedAt server; driver read-only |
| F09 `UserInvites` | users, invitations, capabilities; onChangeAccess, onCreateInvite, onRevoke | Pagination server; kode undangan ephemeral; tidak mengirim email |
| F10 `ReportAnalytics` | report snapshot, status, definitions; onExport, onInspectAnswer, onRetryFinalize | Data server immutable per sesi; presentation tab/filter lokal |
| F11 `PinJoinScanner` | initialPin, retryAfter?, roomAvailability; onCheckPin, onScan | PIN/kamera lokal; validasi join server; camera stream dihentikan saat exit |
| F12 `AvatarCustomizer` | nicknameMode, nickname, avatar, allowedStyles; onRollAvatar, onRequestFriendlyName, onJoin/Save | Seed preview lokal; nama aman server; onSave only LOBBY |
| F13 `HostStageLobby` | host-safe room snapshot, capabilities, players; onStart/Lock/Kick/Skip/Next/End | `useGameStore` view host; controls pending per action; server phase adalah otoritas |
| F14 `PlayerStageAnswerPad` | player-safe room snapshot, question discriminated union, answerStatus; onSelect/Reorder/Submit | Draft answer lokal per questionId/index; accepted/score server; tanpa kunci pre-reveal |
| F15 `GameTimer` | serverStartTime, timeLimit, serverTimeOffset, phase, deadlineStatus | Rendering lokal; tidak mengirim tick tiap detik; onDeadlineView hanya mengunci UI, tidak menetapkan reveal |
| F16 `ResultChartLeaderboardPodium` | result union per tipe, leaderboard, podium, reducedMotion; onExplanation | Presentasi lokal; score/rank/tie-break server; tidak menyortir ulang dengan aturan klien |
| F17 `ConnectionRecovery` | connectionStatus, lastSync, recoveryOutcome, pendingSubmission; onRetry/Leave | Transport lifecycle; room/token bound; state sync mengganti snapshot secara atomik |
| F18 `AudioControls` | muted, volume, trackId, playbackPhase, autoplayStatus; onMute/Volume/Track/Enable | Preferensi browser, engine lokal; interaksi eksplisit mengaktifkan playback; tidak sinkron mute semua peserta |
| F19 `LocalePicker` | installedLocales{tag,nativeName,dir}, currentLocale, pendingLocale; onSelect, onOpenGuide | Search/open lokal; locale provider global; switch commit setelah katalog siap |
| F20 `DocumentView` | title, sections, sourceVersion, officialText?, guideLinks | Read-only, anchor/fokus lokal; dokumen berbahasa lain memakai lang tersendiri |

### 5.3. State ownership dan rekonsiliasi

| Domain | Pemilik | Persistensi / aturan |
| --- | --- | --- |
| Identitas auth, permissions | server + auth provider | Refresh sesuai SA; access token tidak disalin ke query string/log |
| Room, phase, deadline, rank, score, acceptance | server → `useGameStore` | Guard stale events dengan session/question/sequence yang dirinci SA; snapshot role-specific |
| Player recovery token | storage browser per room sesuai PRD | Jangan disalin ke UI/telemetri; dicabut setelah kick/expiry; satu koneksi aktif |
| Pilihan jawaban belum kirim | komponen F14 keyed by session/question | Tidak ditimpa saat locale berubah; clear saat soal berganti atau accepted |
| Studio draft | `useStudioStore` | Baseline in-memory; navigation guard; reload warning, tidak menjanjikan offline persistence |
| Form login/settings/dialog | React Hook Form/local | Validasi Zod bersama; server error tetap ditampilkan |
| Locale, tema, mute/volume | provider/preference storage | Tetap tersedia bagi guest; kegagalan storage memakai memory tanpa memblokir |
| List filter/page | URL + request state | Tidak menyimpan salinan query server sebagai state game |

Optimistis hanya untuk perubahan lokal yang aman: seleksi, urut draft, preview avatar, mute dan volume. Save, join, start/next/end, kick, lock, cleanup, upload, serta skor menunggu ACK/response. Jika optimistic preview avatar gagal, kembalikan avatar terakhir yang dikonfirmasi dengan error. Jangan replay mutasi yang belum diketahui hasilnya tanpa rekonsiliasi server.

## 6. Mandatory five-state UI matrix

Setiap layar/dialog/komponen di inventaris memiliki lima keadaan berikut. “Empty” untuk komponen statis berarti data/aksi tidak ada, **bukan** membuat skeleton palsu. State parsial tidak disamakan dengan network failure. `L` loading, `E` empty, `I` ideal, `P` partial/edge, `X` error/offline. Copy adalah contoh Indonesia yang harus masuk katalog terjemahan.

### 6.1. Semua layar

| Layar | L — Loading | E — Empty/zero | I — Ideal | P — Partial/edge | X — Error/offline |
| --- | --- | --- | --- | --- | --- |
| S01 Landing | Shell/logo segera; instance metadata placeholder | Nama instansi belum tersedia → Kabuki Neko | Gabung/Masuk jelas | Nama panjang wrap; maskot hilang gunakan monogram | Banner layanan tidak tersedia + Coba lagi; konten statis tetap |
| S02 Setup | Periksa setup-status sebelum form | Belum init → “Siapkan instansimu” + Lanjut | Dua langkah lalu setup sukses | Setup dituntaskan tab lain → Masuk | Input tetap; field/summary error; hasil request ambigu cek status dahulu |
| S03 Login | Submit spinner, label Masuk tetap | Form kosong + Masuk | Auth sukses ke tujuan aman | Akun nonaktif/kredensial salah pesan aman | “Tidak dapat masuk. Coba lagi.”; password tidak tersimpan |
| S04 Register | Memuat kebijakan; submit pending | SINGLE_ADMIN → pendaftaran ditutup + Masuk | Akun CREATOR dibuat | Invite invalid/used atau email konflik inline | Pertahankan nama/email; tampil kegagalan tanpa janji akun dibuat |
| S05 Kuis | 6 kartu skeleton, query aria-busy | “Belum ada kuis” + Buat/Impor; hasil search kosong + Hapus filter | Kartu + pagination + scope | Cover hilang placeholder; judul panjang 2 baris + detail | Retry daftar; jangan mengganti gagal fetch menjadi empty |
| S06 Detail | Heading/cover/list skeleton | Soal nol → Tambah soal jika pemilik | Metadata + tindakan sesuai izin | Kuis PUBLIC read-only; warning invalid draft | Tidak tersedia/akses ditolak → Kembali; tidak bocorkan judul |
| S07 Studio | Tiga panel skeleton sesuai breakpoint | “Belum ada pertanyaan” + Tambah | Draft/edit/save + status valid | Soal panjang, metadata parsial, conflict revision, draft belum lengkap | Save gagal: draft tetap, retry/resolve; host disabled hingga valid/saved |
| S08 Media | Grid skeleton / upload progress | “Belum ada media” + Unggah | Grid, preview, pilih/hapus sesuai izin | Thumbnail gagal, file masih dipakai, processing upload | Error per file + Coba lagi; gagal daftar terpisah dari gagal upload |
| S09 Reports | Table/card skeleton | “Belum ada sesi selesai” + Kembali ke kuis | List sesi milik host | Sesi diakhiri dini berlabel; judul snapshot panjang | Retry; tidak tampil sebagai 0 laporan bila fetch gagal |
| S10 Report | Skeleton KPI/table; finalisasi pending terpisah | “Belum ada jawaban pada sesi ini”; 0 peserta valid | Snapshot + rincian + CSV | Missing metric “—”; no-points/POLL excluded sesuai definisi; partial diberi label | Retry fetch/finalisasi/export secara terpisah; jangan tampil sukses kosong |
| S11 Settings | Skeleton field/metrics, jangan isi default palsu | Storage 0 file → “Belum ada file”; health unknown “Belum diperiksa” | Settings tersimpan, metrik dan health | Satu driver gagal, nilai stale timestamp, cleanup sebagian gagal | Form dipertahankan; Retry per panel; tidak silent fallback driver |
| S12 Users | Rows skeleton; invite generation pending | Undangan nol → Buat undangan; hasil search nol → Hapus filter | User/role/status/invite | Nama/email panjang, expired/used invitation, proteksi admin terakhir | Aksi ditolak tetap data lama + alasan; reload izin saat 403 |
| S13 About/guide | Teks statis dahulu; versi placeholder | Versi tidak tersedia “Versi tidak diketahui”; guide tetap | Atribusi, official terms, panduan paket | Teks asli berbeda bahasa berlabel | Link/sumber gagal tampil retry; jangan mengarang teks legal pengganti |
| S14 Join | Memeriksa PIN/recovery, input disabled sementara | PIN kosong → “Masukkan 6 digit PIN” | Room valid → M01 | PIN 0-leading; lock/full/in-progress; retryAfter | Offline → Coba lagi; tidak polling PIN salah; token invalid → masuk ulang sesuai kondisi |
| S15 Player | Initial sync skeleton; fase diketahui tetap tampil saat reconnect | LOBBY menunggu host; belum dipilih → hint/Kirim disabled | Fase/answer pad/results sesuai §4.6 | Soal panjang, partial result, <3 podium, media gagal, ack unknown | Banner reconnect + input locked; sync; expired/kicked → S17; jangan gandakan jawaban |
| S16 Host | Initial sync skeleton; action pending | LOBBY 0 → “Bagikan PIN agar pemain bergabung”; Start disabled | Stage + kontrol fase | 200 pemain, <5 leaderboard, <3 podium, beberapa disconnect | Kontrol locked saat offline; reconnect host perlu auth; finalisasi gagal retry terpisah |
| S17 Fallback | Retry busy tetap alasan sebelumnya | Tanpa error code → penjelasan umum + Beranda | Alasan aman + CTA sesuai konteks | Ref ID panjang dapat disalin; user signed-out variant | Retry gagal tetap actionable; offline tidak membuat loop redirect |

### 6.2. Semua dialog

| Dialog | L | E | I | P | X |
| --- | --- | --- | --- | --- | --- |
| M01 Identitas | Avatar preview / request nama aman pending | Nickname kosong → hint 15 karakter + isi/acak | Avatar + nama valid → Gabung | Nama duplikat/terlarang; glyph CJK/emoji; lobby edit avatar-only | Join gagal pertahankan input; jika room berubah status kembali ke join |
| M02 Scanner | Membuka kamera | Tidak ada kamera → Masukkan PIN | QR dikenali → check PIN satu kali | Cahaya buruk/QR instansi lain → arahan tanpa navigasi | Permission denied/unavailable → PIN manual; stream ditutup |
| M03 Metadata | Create pending | Judul kosong → required; cover optional → Pilih cover | Buat/apply metadata | Judul 150, cover gagal, deskripsi panjang | Error inline; modal terbuka dan input tetap |
| M04 Import | Upload/validasi/commit dengan label nyata | Belum ada file → Pilih file | Impor berhasil → studio | File salah format/versi; error per lokasi, pagination error list jika panjang | Tidak ada kuis parsial; retry hanya setelah status commit dipastikan |
| M05 Media | Grid/progress/processing | “Belum ada media jenis ini” + Unggah | Selected preview + Gunakan | File salah tipe/terlalu besar; video range invalid; media missing | Error per sumber; tidak memilih record yang belum tersedia |
| M06 Host config | Validasi snapshot/create pending | Nol soal → Perbaiki kuis | Pilih mode/friendly → lobi | Draft dirty → simpan dahulu; pemain maks mengikuti setting | Room create gagal → retry setelah rekonsiliasi; bukan buat room ganda |
| M07 QR | Generate placeholder dengan dimensi tetap | URL belum ada → tunggu room | QR + URL + PIN | Clipboard unavailable → seleksi tautan manual | QR gagal → URL/PIN tetap dapat dipakai |
| M08 Explanation | Tidak fetch bila sudah ada di reveal | Tombol tidak ditampilkan jika kosong | Pembahasan lengkap | 1000 karakter → scroll, CJK wrap | Snapshot tidak tersedia → tutup + retry sync, tanpa kunci prematur |
| M09 Confirm | Aksi pending, target tetap terlihat | Target sudah hilang → info + Tutup | Target/dampak/CTA spesifik | Referential conflict/role rule → alasan aman | Tidak tutup sebagai sukses; rekonsiliasi jika response hilang |
| M10 Unsaved | Simpan lalu lanjut pending | Tidak dirty → dialog tidak diperlukan | Tiga pilihan jelas | Draft invalid tetap dapat save jika hanya incomplete; struktur invalid perlu perbaikan | Save gagal tetap draft, jangan lanjut navigasi |
| M11 Invite | Generate pending | Belum ada kode → Buat | Kode + Salin + status | Expired/used/revoked; copy gagal → salin manual | Jangan menciptakan undangan ganda saat hasil belum pasti |
| M12 Answers | Detail skeleton | “Tidak menjawab”/“Soal belum dimainkan” sesuai snapshot | Payload manusiawi + hasil/poin/waktu | Partial multiple; missing historical media; banyak soal pagination | Retry detail; tidak menyimpulkan jawaban kosong karena fetch gagal |

### 6.3. Semua base components

Varian yang tercantum pada §5.1 mewarisi baris komponen induk, termasuk varian icon-only, drawer, toast, checkbox, dan table.

| Komponen | L | E | I | P | X |
| --- | --- | --- | --- | --- | --- |
| B01 ActionButton | Spinner + label; cegah double submit | Aksi tidak tersedia → sembunyikan atau disabled + alasan | Label jelas + focus | Label panjang wrap; icon-only accessible name | Parent notice/inline error; re-enable hanya aman |
| B02 FormField | Async options pending; existing value tetap | Placeholder membantu, label tetap | Value/help/counter | Max length/Unicode wrap; missing option berlabel | aria-invalid + described error; value tetap |
| B03 ChoiceGroup | Item pending non-interactive | “Tidak ada pilihan” + aksi parent | Selected dan fokus berbeda jelas | Disabled option/alasan, horizontal tabs overflow terkontrol | Parent error; selection terakhir tetap |
| B04 ModalSheet | Skeleton pada body; judul/close tersedia | Konten kosong → empty notice + Tutup | Focus trapped + return focus | Long body scroll; satu modal | Error inline, close tetap; parent simpan request state |
| B05 MenuPopover | Item dinamis loading, trigger tetap | Menu kosong → trigger dihilangkan | Menu keyboard + labels | Label panjang wrap/reposition viewport | Tutup aman + notice; tidak trigger aksi palsu |
| B06 StatusNotice | “Memproses…” dengan status | Tanpa message → tidak render | Pesan + CTA relevan | Pesan panjang wrap; repeated events dedup | Error penting tidak auto-dismiss; retry focusable |
| B07 SkeletonBlock | Dimensi stabil, satu label loading | Tidak ada data load → tidak render skeleton | Diganti konten siap | Lambat → pesan menunggu; reduced motion statis | Diganti error + Retry, tidak skeleton abadi |
| B08 StatusBadge | “Memeriksa…” jika benar pending | Nilai unknown “Belum diketahui” | Icon + teks | Angka besar/label panjang wrap | Tone danger + teks bila status error, bukan icon saja |
| B09 ContentCard | Media/text skeleton | Resource tidak ada → empty parent | Judul + metadata + actions | Cover gagal fallback; title penuh pada detail | Error card lokal atau parent retry |
| B10 DataCollection | Skeleton rows; existing page stale berlabel | No rows + CTA/reset filter | Table/list + pagination | Banyak data server pagination, unknown total, long cells | Pertahankan page lama berlabel stale + Retry |
| B11 MediaPreview | Poster/progress, reserved ratio | Tidak ada attachment → hilangkan slot atau picker studio | Media + controls/alt | Autoplay blocked → Putar; missing captions/transcript ditandai pada authoring | Placeholder + Retry; tidak menghentikan timer diam-diam |
| B12 AvatarIllustration | Siluet ukuran tetap | Avatar belum ada → default deterministik | Avatar resmi/mascot | Seed/style invalid → fallback + nama tetap | Render gagal → monogram; tidak blok join |

### 6.4. Semua feature components

Feature mewarisi matriks layar/dialog yang dipetakan dan menambahkan kondisi khusus berikut; keduanya wajib dipakai, bukan memilih salah satu.

| Komponen / rujukan | L | E | I | P | X |
| --- | --- | --- | --- | --- | --- |
| F01 / S02–04 | Policy/submit busy | Form kosong/registration closed | Auth flow | Setup race/invite mode | Field + form error |
| F02 / S05–06 | Query skeleton | Buat/import/reset filter | Allowed actions | PUBLIC read-only/invalid draft | Safe forbidden + retry |
| F03 / S07,M10 | Load/save pending | Tambah pertanyaan | Draft/saved | Revision conflict, incomplete | Preserve draft; no false saved |
| F04 / S07 | Thumbnail skeleton | Tambah slide | Select/move via ID | 100+ slides scroll, fokus stabil | Reorder invalid pulihkan urutan draft terakhir |
| F05 / S07 | Schema/content loading | Required hints per tipe | Six-type fields | Limits, changing type loss | Inline issues + summary ke field |
| F06 / S08,M05 | Upload/processing | Unggah | Select ready media | In-use/delete conflict | Per-file error retry |
| F07 / M04,S06,S10 | Import/export pending | Pilih file/no resource | Commit/download confirmed | Format/version/row errors | Atomic failure; no empty success |
| F08 / S11 | Per-panel load | 0 files/unknown health | Valid settings/metrics | Partial cleanup/stale metrics | Save draft retained; per-panel retry |
| F09 / S12,M11 | List/generation busy | Buat undangan | User/invite management | Used/expired/admin-last rule | Mutation rejected, refetch |
| F10 / S09–10,M12 | Fetch/finalization | No completed sessions/answers | Snapshot analytics | Partial/no-point metrics | No report link before ready |
| F11 / S14,M02 | Check/camera pending | Isi PIN | Valid PIN | Full/locked/rate-limited | Manual entry/retry metadata |
| F12 / M01 | Roll friendly name pending | Isi nama/acak | Preview + join | Six styles/missing font/nickname conflict | Preserve seed/name on rejection |
| F13 / S16 | Sync/command busy | 0 players + share PIN | Role-safe host stage | Disconnect grid/duplicate next ack | Freeze commands until sync |
| F14 / S15 | Sync/submitting | No selection hint | Correct control per type | Partial feedback/ack unknown/IME | Lock offline; sync before retry |
| F15 / S15–16 | Await authoritative timestamp | Phase untimed → no timer | Numeric/ring deadline | 0 during grace; stale clock offset | Sync warning; never extend server time |
| F16 / S10,S15–16 | Results not yet sent → waiting | No answers/eligible ranks → text | Counts/ranks/podium | <3 winners, ties, long names | Preserve last confirmed result + stale label |
| F17 / S15–16 | Initial sync/reconnect | No token → join/auth path | Connected, notice unobtrusive | One active connection / missed phases | Backoff then manual retry; revoked/expired terminal |
| F18 / S16 | Audio loading | No selected track → pilih track | Mute/volume/play | Browser blocks autoplay → Aktifkan suara | Audio failed + retry, visual game continues |
| F19 / semua | Catalog pending; old locale remains | Search no result → Hapus pencarian / panduan | Native name + active check | Missing key fallback en; newly installed locale | Switch failed keeps old locale + Coba lagi |
| F20 / S13 | Source metadata pending | Missing version uses label | Readable document + anchors | Long official text/lang mismatch | Missing source actionable, no invented content |

Semua fase game memiliki state data/transport di atas. Loading tidak pernah digunakan untuk menutupi pause server tanpa status. Snapshot baru menggantikan tampilan yang basi; reconnect langsung ke fase terbaru dan tidak memutar semua animasi yang terlewat.

## 7. Micro-interactions dan aksesibilitas

Target desain mengikuti **WCAG 2.2 AA** pada NFR-04 PRD, mencakup baseline WCAG 2.1 AA yang diminta skill. Persyaratan relevan mencakup kontras teks 4.5:1 (teks besar 3:1), kontras kontrol 3:1, reflow, operasi keyboard, fokus tidak tertutup, alternatif drag, serta status semantik. Implementasi dan konten harus diperiksa sebelum menyatakan kepatuhan. Referensi normatif: [W3C WCAG Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/).

Dialog memiliki nama, `role=dialog`, `aria-modal=true`, latar inert, Tab/Shift+Tab di dalam dialog, Escape untuk menutup, dan pengembalian fokus. Fokus awal diarahkan ke judul untuk isi panjang atau Batal untuk tindakan destruktif. Pola rujukan: [W3C APG Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### 7.1. Keyboard, fokus, dan semantik produk

- Sediakan skip link “Lewati ke konten”, satu h1 per layar, landmark main/nav/header/footer, serta urutan DOM yang mengikuti alur baca. Fokus terlihat minimal ring 2px + offset 2px sebagai baseline produk, tidak terpotong oleh overflow.
- Semua opsi game adalah button atau checkbox/radio semantik sesuai jenis. Nama aksesibel memuat huruf, bentuk, teks bila tersedia, dan status dipilih. Icon dekoratif tidak dibacakan dua kali. Teks di dalam tombol menjadi bagian dari accessible name.
- Tab mencapai kontrol; Enter/Space mengaktifkan. Jangan mengikat huruf A–D global yang bisa mengganggu input text/IME. Pengiriman pada SINGLE/POLL diberi instruksi sebelum input aktif karena langsung mengirim.
- Puzzle dan slide memakai tombol “Pindah ke atas/bawah”, label item dan posisi. Setelah move, fokus tetap pada item yang dipindah; live region mengumumkan “Item … posisi 2 dari 4”. Drag hanya alternatif tambahan, bukan satu-satunya cara.
- Countdown tidak mengumumkan setiap frame/detik. Umumkan pembukaan soal, sekali saat lima detik tersisa bila durasi memungkinkan, dan penutupan input. Angka/ring tetap dapat diperiksa pembaca layar. Jangan mengumumkan setiap player join di room 200 orang; gunakan ringkasan jumlah yang dibatasi frekuensinya.
- `aria-live=polite` untuk save, accepted, koneksi dan hasil; `role=alert` hanya error yang membutuhkan perhatian langsung. Skeleton punya satu label loading di parent, bukan banyak item berulang. Toast bukan satu-satunya penyampai error penting.
- Fase baru memfokuskan heading soal/hasil pada navigasi fase yang substantif. Jangan mencuri fokus selama mengetik, mengurutkan, locale switch, atau saat opsi yang sama diperbarui. Hindari memindahkan fokus otomatis ke tombol answer yang dapat terkirim karena key masih ditekan.
- Validasi submit menampilkan summary yang menaut ke field invalid pertama; error spesifik dekat field, `aria-invalid` dan `aria-describedby`. Helper/label selalu terlihat, bukan hanya placeholder.
- Data table memakai caption, header scope dan sort berlabel; chart menyediakan angka dan tabel/daftar setara. Grafik tidak bergantung pada tinggi batang atau warna. Ranking memakai urutan server dan menampilkan label perubahan `Naik 2`, bukan panah saja.
- Target produk 44×44, tombol utama 48 tinggi. Tooltip muncul pada hover/focus dan bisa ditutup; bantuan penting tetap inline. Zoom 200%, reflow 320 CSS px, landscape/portrait dan virtual keyboard tidak menghilangkan CTA atau fokus. Tabel kompleks boleh scroll horizontal dalam container berlabel; sediakan kartu ringkas di mobile.

### 7.2. Waktu, media, dan alternatif yang perlu disediakan

Permainan live memakai deadline bersama yang esensial pada PRD; jangan membuat perpanjangan lokal atau pause klien yang mengubah fairness. Host dapat memilih durasi soal hingga 240 detik sebelum sesi. SA/QA perlu mendokumentasikan alasan pengecualian timing untuk pertandingan live dan tetap menghindari timeout yang tidak perlu pada form/setup/studio.

PROJECTOR default tetap pad geometri. Untuk player yang tidak dapat membaca layar bersama, sediakan preferensi aksesibilitas **“Tampilkan teks soal di perangkat ini”** sebagai presentasi lokal dari materi publik yang sama; tidak mengganti mode room, timer atau scoring. Preferensi ini membutuhkan payload prompt/opsi publik yang dapat diakses player tanpa kunci. SA harus menyelesaikan kontraknya; aplikasi tidak boleh mengklaim pengalaman PROJECTOR aksesibel penuh jika hanya ada visual pada proyektor tanpa alternatif tersebut.

Media buatan kreator memerlukan alternatif sesuai konteks: alt deskriptif yang tidak mengungkap kunci soal lebih awal, transkrip audio, caption video, dan deskripsi informasi visual penting. Nama file bukan pengganti deskripsi. F05/F06 perlu field metadata aksesibilitas serta indikator “Alternatif teks belum tersedia”; skema PRD belum merinci field tersebut, sehingga SA wajib membawa gap ini ke kontrak media/question. Jangan mengarang transkrip atau menyatakan otomatis tersedia. Reveal gambar juga tidak boleh membocorkan jawaban melalui alt yang sengaja menyebut kunci. Jika alternatif yang setara belum ada, konten kuis tersebut belum memenuhi target aksesibilitas meski kontrol UI sudah sesuai.

Audio selalu memiliki mute/volume dan aksi “Aktifkan suara” jika autoplay diblokir. BGM tidak dimulai sebelum interaksi yang diizinkan browser; transisi fase memakai cue visual selain suara. Caption/transkrip tidak diganti efek suara. Saat keluar room/pindah media, hentikan track lama; reconnect tidak menumpuk playback.

### 7.3. Motion dan feedback

| Interaksi | Durasi / perilaku | Reduced motion |
| --- | --- | --- |
| Hover/focus/press | 120ms, translate maksimal 1px; tidak mengubah warna teks/opsi | Perubahan border instan |
| Menu/dialog | 160–200ms fade; fokus aktif segera | Tanpa gerakan/fade wajib |
| Avatar masuk lobi | 180ms pop ringan, tidak menggeser fokus | Muncul langsung |
| Acak avatar | 240ms rotasi ikon dadu, preview terbaru saja | Ganti preview tanpa rotasi |
| Pindah urutan | 180ms posisi, announce setelah move | Posisi instan + announcement |
| Countdown | Angka 3/2/1 mengikuti waktu server | Angka tetap tampil, tanpa zoom |
| Grid 3×3/5×5, blur | Progres deterministik dari deadline; bukan frame counter lokal | Reveal langkah diskret tanpa transisi halus, progres sama |
| Chart/leaderboard | 300ms, label final segera tersedia | Hasil final langsung |
| Podium | Reveal 3→2→1, total maksimal 3s; confetti maksimal 2s | Semua hasil langsung, tanpa confetti/sorotan bergerak |

Tidak menggunakan kedipan cepat, guncangan layar untuk jawaban salah, atau animasi infinite yang menyembunyikan kondisi error. Skip animasi podium tidak memajukan state game. Semua feedback skor selalu berasal dari server; animasi angka tidak menghitung ulang skor.

## 8. Multibahasa, paket tambahan, dan layout internasional — US-21

### 8.1. Bahasa awal dan pemilih bahasa

| Locale | Label asli pada picker | Arah | Font fallback yang diperlukan |
| --- | --- | --- | --- |
| `en` | English | LTR | Latin/system |
| `id` | Bahasa Indonesia | LTR | Latin/system |
| `ja` | 日本語 | LTR | Noto Sans JP atau font CJK sistem |
| `zh-Hans` | 简体中文 | LTR | Noto Sans SC atau font CJK sistem |
| `es` | Español | LTR | Latin termasuk diakritik |
| `fr` | Français | LTR | Latin termasuk diakritik |

Font Noto Sans Latin pada §2.3 bukan jaminan glyph CJK. Dahulukan font sistem CJK dan hanya load subset tambahan yang benar-benar dibutuhkan locale; jangan mengunduh semua font Jepang/China untuk tiap player. Font fallback tidak mengubah bobot informasi atau memotong line-height. Bentuk geometri tetap SVG.

```text
Desktop popover (F19)                   Mobile sheet (F19 memakai B04)
+----------------------------------+   +-----------------------------+
| Bahasa / Language                |   | Bahasa / Language       [X] |
| [Cari bahasa________________]    |   | [Cari bahasa____________]   |
| [ ] English                      |   | [ ] English                 |
| [x] Bahasa Indonesia             |   | [x] Bahasa Indonesia        |
| [ ] 日本語                       |   | ... daftar scroll           |
| [ ] 简体中文 ...                 |   | [Bahasa belum tersedia?]    |
| [Bahasa belum tersedia?]         |   +-----------------------------+
+----------------------------------+
```

Picker mudah ditemukan melalui ikon globe + nama bahasa aktif, tidak hanya bendera/ikon. Nama asli bahasa tidak diterjemahkan agar pengguna bisa kembali dari bahasa yang tidak dipahami. Search mencocokkan nativeName, label terlokalisasi dan tag. Semua paket valid tampil dari registry, bukan daftar enam pilihan hardcoded. “Bahasa belum tersedia?” membuka panduan S13 yang juga dapat dibaca dari shell publik tanpa login; identitas route dokumentasi ditentukan SA.

Locale tidak menjadi path/room key baru. Resolve sekali saat bootstrap: explicit saved → supported browser match → instance default → en. `en-US`/`en-GB` dapat memakai en bila belum ada paket khusus; mapping serupa untuk varian Latin. Jepang `ja-JP` → ja. Resolusi Chinese harus menghormati script/region: jangan menyajikan Simplified sebagai Traditional tanpa keputusan yang terlihat; bila tidak ada pasangan yang sesuai gunakan fallback sesuai kebijakan dan biarkan pengguna memilih. SA menetapkan tabel matching/test cases termasuk browser yang mengirim `zh` saja.

Switch memuat katalog baru dahulu, lalu mengganti provider secara atomik dan menyimpan preferensi. Sementara loading, opsi tujuan berstatus “Memuat bahasa…” dan UI lama tetap operasional; gagal mempertahankan bahasa lama + retry. Fokus kembali ke pemicu, draft dan scroll dipertahankan sejauh mungkin. Jangan re-mount room, mengulang check_pin/join, atau reset form karena locale berubah. Host locale tidak memaksa locale player. Default instansi hanya memengaruhi resolusi tanpa preferensi pengguna.

### 8.2. Kontrak paket bahasa dan panduan kontributor

Paket berupa **data deklaratif**, bukan kode. Usulan isi logis (serialisasi final oleh SA):

| Bagian | Isi yang diperlukan |
| --- | --- |
| Manifest | schemaVersion, locale tag, nativeName, direction `ltr/rtl`, packageVersion, compatibility/catalogVersion, credits opsional |
| Namespace | common, auth, quizzes, studio, media, host, player, reports, admin, validation, accessibility, about |
| Messages | Key stabil, pesan utuh, placeholder bernama dengan tipe, plural/select sesuai format yang dipilih SA |
| Template | Sumber en lengkap + daftar key/deskripsi konteks/placeholder; tidak menyalin placeholder ke terjemahan tanpa memahami konteks |
| Validation output | File/namespace/key, severity, missing key, unknown key, wrong placeholder, invalid syntax, duplicate locale |

Alur pengguna/pengelola: **ambil template → buat manifest locale → terjemahkan → validasi → pasang di lokasi ekstensi terdokumentasi → build/restart bila diperlukan → cek picker dan smoke test → rollback bila bermasalah**. Pengguna biasa pada instalasi bersama menyerahkan paket kepada pengelola melalui saluran mereka sendiri; UI tidak mengirim pesan/kontribusi otomatis. Tidak ada editor paket atau upload global melalui dashboard pada baseline.

En menjadi katalog sumber lengkap dan fallback per key. Enam bahasa bawaan harus 100% key lengkap pada rilis; paket tambahan yang parsial boleh menampilkan fallback en dengan diagnostik untuk pengelola. Missing key tidak ditampilkan sebagai `player.answer.sent`; fallback mencakup label aksesibilitas dan validasi. Paket tidak valid tidak boleh mengganti paket aktif. User-facing error umum tersedia dari katalog minimal yang sudah dimuat bila paket tujuan gagal.

Semua teks aplikasi memakai key, termasuk `aria-label`, judul dokumen, toast, plural peserta/soal, empty states, filename deskriptif export, helper dan penjelasan mode. API mengirim errorCode + params yang aman agar klien memetakan pesan; jangan menerjemahkan enum/event/payload. Tidak merangkai kalimat dari fragmen yang bergantung urutan grammar. Package message tidak boleh menjalankan HTML/JS; link/format kaya memakai slot komponen yang dibatasi bila diperlukan. String user selalu data, tidak dievaluasi sebagai template.

### 8.3. Formatting, Unicode, RTL dan konten

- Format jumlah, skor, tanggal, waktu, unit dan plural melalui locale-aware formatter. Simpan timestamp/angka sebagai data netral; label laporan menyebut zona waktu tampilan. Unduhan CSV mempertahankan kontrak kolom/data yang stabil dan escaping BR-20; bahasa header/format export diputuskan dan didokumentasikan SA, bukan berubah tanpa kontrak karena picker.
- PIN selalu enam digit ASCII, monospace, LTR dan bisa disalin utuh. ID, token, kode undangan, URL, enum tipe soal, serta indeks opsi tidak diterjemahkan. Tampilan angka skor boleh lokal tetapi payload selalu number.
- Placeholder tidak dihitung sebagai kata yang diterjemahkan. Tangani plural 0/1/banyak menurut katalog, bukan aturan `count===1` universal.
- `lang` dan `dir` mengikuti locale aktif; nama bahasa di picker memakai tag bahasanya sendiri. Pakai logical properties start/end, bukan hardcode left/right. Pada RTL, navigasi/panel mengikuti arah baca; PIN, URL, kode dan tabel angka diisolasi dengan bidi. Urutan logis opsi A–D, identitas warna/bentuk dan puzzle tidak dibalik atau diubah menjadi indeks lain.
- Uji copy dengan ekspansi minimal 40%; tombol boleh wrap atau berkembang. Jangan memberi width tetap berdasarkan label Inggris. Modal/footer menumpuk tombol pada ruang sempit. CJK wrap menggunakan pemenggalan yang wajar, bukan hanya spasi; input dan error mendukung IME, combining marks, emoji.
- Panah “kembali/berikutnya” mengikuti arah baca; ikon play, logo, geometri jawaban, angka PIN dan media tidak dicerminkan. Label screen reader mengikuti arah/locale, bukan posisi CSS.
- Soal, opsi, explanation, nickname dan judul buatan pengguna tetap sama saat bahasa UI berubah. Locale bukan mekanisme penerjemah isi kuis. Pencocokan TYPE_ANSWER tetap BR-10; jangan memakai locale pemain untuk mengubah lowercasing/aturan skor. Normalisasi Unicode dan hitung karakter harus dituntaskan konsisten pada SA.
- Bahasa pada lisensi resmi dapat berbeda; tandai `lang` teks asli. Ringkasan yang diterjemahkan tidak menggantikan dokumen resmi.

## 9. Budget frontend dan bukti verifikasi yang dibutuhkan

Budget berikut merupakan **target desain awal**, bukan hasil benchmark. SA harus menegaskan cara pengukuran dan perubahan budget secara terlacak sebelum task implementasi; tidak ada aplikasi yang sudah dapat diuji saat dokumen ini dibuat.

| Area | Target / aturan penerimaan |
| --- | --- |
| Player initial JS | <=300 KiB gzip total chunk yang diperlukan untuk join/play pertama pada build production; laporkan termasuk framework, tanpa menyembunyikan dependency di angka lain |
| Locale initial payload | <=50 KiB gzip per locale untuk namespace player/publik yang diperlukan; fallback minimal termasuk budget; load namespace studio/admin hanya di rute terkait |
| Player load | Target LCP <=4 detik dan CLS <=0.1 pada viewport 390×844, cold cache, bandwidth 1.6 Mbps/RTT150ms, CPU slowdown4×; catat perangkat/runner dan median 5 run |
| Split loading | Studio, dnd-kit editor, admin charts, QR camera decoder, confetti dan koleksi avatar tidak semua masuk boot player; lazy sesuai aksi/fase tanpa menghambat answer pad |
| Media | Dimensi reserved; responsive images; tidak preload semua video/seluruh kuis; fallback saat lambat. Media tidak dibebankan ke budget JS namun byte/waktunya dilaporkan terpisah |
| Realtime | Deadline berdasarkan server; update timer display lokal tanpa per-tick global rerender. NFR broadcast p95<50ms/200 klien dibuktikan terpisah dari performance render |
| Font/locale | Fallback font segera; tidak memuat enam katalog penuh atau seluruh glyph CJK pada setiap rute |

### 9.1. Checklist handoff ke QA

- Uji keyboard penuh: setup/login/join/customizer, enam tipe gamepad, reorder slide dan puzzle, modal, kick, end, import, media, settings, laporan dan locale picker.
- Verifikasi lima state untuk seluruh S/M/B/F pada §6, termasuk no answers, 0 pemain, satu/dua peserta podium, 200 pemain, long content hingga batas PRD, missing media, upload parsial, rate limit dan server errors.
- Uji 320px, 390px, tablet 768px, studio 1280px, proyektor 1280×720 dan 1920×1080; 200% zoom/reflow, portrait/landscape, keyboard virtual dan reduced motion.
- Uji deadline+grace, early skip, duplicate submit, ACK hilang, refresh setelah accepted, reconnect lintas fase, kicked/revoked token, host reconnect dan restart memory state. Tidak ada kunci di DOM/network sebelum reveal, termasuk TYPE_ANSWER dan ORDER_PUZZLE.
- Uji skor parsial MULTIPLE_SELECT berikut bonus/streak, POLL tanpa perubahan streak, no-points reset, tie-break server, empty leaderboard dan finalisasi laporan gagal/retry.
- Uji en/id/ja/zh-Hans/es/fr lengkap, placeholder/plural, fallback en, katalog gagal dimuat, persist/reload, pergantian bahasa saat menjawab dan saat draft dirty, contoh paket RTL serta pseudolocale +40%.
- Uji kontrast aktual, focus ring di semua warna jawaban, reader labels/live regions, dialog focus return, text alternatives/caption/transcript dan font fallback. Token yang lolos hitung tidak menggantikan inspeksi browser.
- Uji kepemilikan resource: PUBLIC reuse diperbolehkan, edit/hapus pemilik saja; laporan host saja termasuk untuk pemilik kuis asal dan SUPERADMIN. Pesan gagal tidak membocorkan judul PRIVATE.

## 10. Keputusan desain, gap kontrak, dan handoff SA

### 10.1. Keputusan yang sudah ditetapkan untuk desain

1. Identitas warna PRD dipertahankan; teks opsi kuning ink dan hijau putih solid. Tema admin adaptif, panggung host default dark.
2. Semua layar dan enam tipe soal tetap tersedia pada mobile; studio berpindah panel dengan tab. Tidak ada fitur sumber yang dikurangi untuk rilis.
3. Save draft eksplisit, state dirty terlihat, guard navigasi; optimistic UI hanya untuk state lokal yang aman.
4. Deadline input dan grace dipisahkan secara visual; hasil hanya setelah reveal server. Partial MULTIPLE_SELECT dihitung feedback berhasil parsial, dengan bonus/streak dari server.
5. Enam locale awal dan paket eksternal menjadi P0 sesuai permintaan pengguna; zh-Hans adalah asumsi default untuk Mandarin, bukan larangan zh-Hant. Penambahan bahasa lewat data/panduan pengelola, tanpa hardcoded daftar bahasa.
6. Copy contoh Indonesia; default instansi id, fallback key en. Locale per pengguna independen dari room dan isi kuis.

### 10.2. Kontrak yang perlu diselesaikan sebelum implementasi

| ID | Gap / keputusan SA | Dampak layar/komponen |
| --- | --- | --- |
| SA-01 | Shared view models role-specific: public question per tipe, identity opsi, server timestamp/offset, revision/sequence, accepted-answer recovery | F13–17; mencegah key leak, duplicate dan stale event |
| SA-02 | Payload reveal text/puzzle/partial/POLL/no-points/unanswered dan definisi pointsAwarded versus bonus (hindari menjumlah bonus dua kali) | S15–16, F16, laporan |
| SA-03 | Host recovery, end_game, lock_changed/kicked, duplicate commands, timeout/TTL, finalisasi pending/ready/failed/retry; reportId nullable sampai ready | S16/S17; jangan memakai kontrak podium lama seolah report selalu tersedia |
| SA-04 | Settings max_audio_size_mb, default_locale, installed locale registry; user management/invite lifecycle dan proteksi admin terakhir | S11–12, M11, F08–09,F19 |
| SA-05 | i18n library, message syntax, manifest schema/validation, package discovery path/install/build/rollback, browser matching, persistence/SSR, Unicode length | Seluruh layar; US-21 |
| SA-06 | Import version/template/limits/per-row errors, atomic commit reconciliation, media ownership/list filters, delete in-use errors | S05/S08,M04–05 |
| SA-07 | Draft incomplete save vs strict schema invalid, bulk-save revision conflict detection, snapshot host consistency | S07,M06,M10 |
| SA-08 | Query scope own/public, capabilities, pagination/sort; report accuracy denominator/partial/no-points and hardest-question metric | S05–06,S09–10; jangan hardcode metrik ambigu |
| SA-09 | Password policy, registration errors, invite status, refresh expiry/revocation, validation error params yang bisa diterjemahkan | S02–04,S12 |
| SA-10 | Media alt/transcript/caption/descriptive metadata, safe YouTube URL/start-end, prompt/opsi publik untuk alternatif teks PROJECTOR | S07–08,S15–16; gap aksesibilitas wajib ditutup |
| SA-11 | Cleanup partial-failure result, health timestamp/stale semantics, auditable error correlation tanpa secret | S11; metrik tidak menutupi failure |
| SA-12 | Audio track catalog, asset/logo delivery, locale-aware font subsets, QR decoder compatibility dan budget production | S01,S14–16; baseline aset belum ada |

SA harus mempertahankan seluruh keputusan bisnis PRD; gap di tabel merupakan kontrak yang perlu dilengkapi, bukan izin menampilkan fitur tanpa implementasi server. Perubahan kebutuhan akibat aksesibilitas atau format data dicatat pada upstream secara terlacak sebelum coding.

### 10.3. Status artefak

Stage 2 menghasilkan spesifikasi desain ini: aesthetic/tokens, seluruh layar dan dialog desktop/mobile, kontrak komponen/state, matriks lima state, interaksi/accessibility, dan multibahasa extensible. Dokumen tidak menyatakan frontend, katalog terjemahan, aset visual, atau pengujian aplikasi telah tersedia. Tidak ada production code yang dibuat.

**Next Step:** Review `docs/vibe/02-design-spec.md`, termasuk tambahan bahasa pada PRD §19. Kemudian clear context (`/clear`) dan jalankan `/vibe-sa` (atau `$vibe-sa`).
