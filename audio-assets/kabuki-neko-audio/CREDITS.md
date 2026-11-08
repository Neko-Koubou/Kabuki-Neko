# Kabuki Neko — Atribusi & Ketentuan Aset Audio

> **Status distribusi: release-unverified.** Izin tertulis yang diperlukan untuk mendistribusikan audio ini bersama Kabuki Neko belum ada. Lihat bagian [Status hak distribusi](#status-hak-distribusi-release-unverified) dan inventaris per file di `docs/audio-provenance.json` (repositori).

## Lisensi kode berbeda dari lisensi aset audio

- **Kode sumber** aplikasi Kabuki Neko dilisensikan di bawah **Apache License 2.0 dengan Commons Clause v1.0** (lihat file `LICENSE`). Commons Clause membatasi penjualan perangkat lunak atau layanan yang nilainya berasal seluruhnya atau sebagian besar dari perangkat lunak ini; klausul itu **bukan** larangan menyeluruh atas semua penggunaan komersial dan **tidak** berlaku untuk file audio di direktori ini.
- **Seluruh musik latar (BGM) dan efek suara (SFX)** di direktori ini **tidak** termasuk dalam lisensi kode sumber. Hak ciptanya tetap milik masing-masing komposer/kreator yang mempublikasikannya di **OpenTracks.com (sebelumnya DOVA-SYNDROME)**, di bawah [Audio Source Usage License OpenTracks](https://opentracks.com/en/help/articles/license/) beserta ketentuan tambahan yang mungkin ditetapkan oleh masing-masing kreator.

## Ringkasan ketentuan OpenTracks yang relevan

Diperiksa pada 2026-11-08 dari halaman lisensi resmi di atas. Ringkasan ini bukan nasihat hukum; teks resmi OpenTracks yang berlaku.

1. Konversi format (misalnya MP3 → WebM/Opus) dan penyuntingan audio diperbolehkan.
2. Lisensi ditujukan bagi pengguna primer yang membuat karya. Untuk penanaman ke **aplikasi alat (tool app) atau platform** dan pemberian lisensi kepada penggunanya (pengguna sekunder), OpenTracks meminta **konsultasi dengan pengelola situs terlebih dahulu**.
3. Dilarang mendistribusikan atau menjual file audio itu sendiri (termasuk sebagai koleksi bahan mentah audio / _raw audio pack_), baik komersial maupun non-komersial, dan dilarang menggunakan audio dalam kondisi di mana pengguna akhir dapat dengan mudah mengakses dan menyalin file audionya.
4. Lisensi OpenTracks tidak mewajibkan kredit; kredit tetap dicantumkan di sini sebagai bentuk penghargaan dan jejak asal-usul.

## Status hak distribusi (release-unverified)

Belum ada izin tertulis dari pengelola OpenTracks untuk (a) menanamkan audio ini ke Kabuki Neko sebagai platform yang dapat di-_self-host_ oleh pihak lain, dan (b) menyimpan file audio di repositori serta menyajikannya sebagai file yang dapat diunduh dari aplikasi. Sampai izin tersebut diperoleh, atau aset diganti dengan audio yang ketentuannya memperbolehkan, audio ini **tidak boleh dianggap siap untuk rilis atau distribusi**. Selain itu, dua metadata track di bawah belum cocok dengan halaman sumbernya dan sepuluh SFX belum memiliki sumber per file.

---

## Struktur Direktori & Daftar Kredit per Fase

Kolom **Verifikasi** membandingkan judul dan komposer dengan halaman sumber OpenTracks pada 2026-11-08: ✓ cocok, ⚠ tidak cocok (lihat catatan), – belum dapat diverifikasi.

### 1. `01-lobby/` — Musik Ruang Tunggu (Lobby Phase)

| Nama File                | Deskripsi Penggunaan                        | Judul Asli Track  | Komposer                        | Sumber & Lisensi                                                | Verifikasi                                                                                                       |
| :----------------------- | :------------------------------------------ | :---------------- | :------------------------------ | :-------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `bgm-lobby-kabuki.mp3`   | Tema utama lobi (Japanese Matsuri/Shamisen) | Cat life          | GT-K                            | [OpenTracks #2551](https://opentracks.com/en/bgm/detail/2551)   | ✓                                                                                                                |
| `bgm-lobby-neko8bit.mp3` | Tema lobi alternatif (Chiptune 8-Bit)       | Cat sonata - 8bit | Hupple                          | [OpenTracks #12959](https://opentracks.com/en/bgm/detail/12959) | ✓ (judul dikoreksi dari "ICat sonata" sesuai halaman sumber)                                                     |
| `bgm-lobby-showtime.mp3` | Tema lobi alternatif (Classic Variety Show) | Black Agent       | MFP【Marron Fields Production】 | [OpenTracks #23982](https://opentracks.com/en/bgm/detail/23982) | ✓                                                                                                                |
| `bgm-lobby-matcha.mp3`   | Tema lobi santai (Chill Lo-Fi)              | 2:23 AM / 10℃     | Sharou (しゃろう)               | [OpenTracks #13513](https://opentracks.com/en/bgm/detail/13513) | ⚠ halaman #13513 menampilkan "Pink Steroid" oleh Anonyment; tautan atau metadata perlu dikonfirmasi pemilik aset |

### 2. `02-thinking/` — Musik Menjawab Soal (Question Answering Phase)

| Nama File                | Deskripsi Penggunaan                   | Judul Asli Track | Komposer                        | Sumber & Lisensi                                                | Verifikasi                                                                                 |
| :----------------------- | :------------------------------------- | :--------------- | :------------------------------ | :-------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `bgm-think-standard.mp3` | Musik berpikir soal standar (20s–30s)  | Quiz Time        | shimtone                        | [OpenTracks #12099](https://opentracks.com/en/bgm/detail/12099) | ✓                                                                                          |
| `bgm-think-sprint.mp3`   | Musik berpikir soal cepat (5s–15s)     | quiz time man    | Takumi Higashi (東 たくみ)      | [OpenTracks #3300](https://opentracks.com/en/bgm/detail/3300)   | ⚠ judul cocok, tetapi halaman #3300 mencantumkan komposer "alaki paca"; perlu dikonfirmasi |
| `bgm-think-puzzle.mp3`   | Musik berpikir soal panjang (60s–240s) | Pacific Samba    | MFP【Marron Fields Production】 | [OpenTracks #23981](https://opentracks.com/en/bgm/detail/23981) | ✓ (tautan diperbaiki dari `hhttps://`)                                                     |

### 3. `03-leaderboard/` — Transisi Klasemen Sementara (Leaderboard Phase)

| Nama File                    | Deskripsi Penggunaan             | Judul Asli Track | Komposer   | Sumber & Lisensi                                                | Verifikasi |
| :--------------------------- | :------------------------------- | :--------------- | :--------- | :-------------------------------------------------------------- | :--------- |
| `bgm-leaderboard-groove.mp3` | Musik transisi Top 5 Leaderboard | Have a nice day  | えだまめ88 | [OpenTracks #18070](https://opentracks.com/en/bgm/detail/18070) | ✓          |

### 4. `04-podium/` — Pengumuman Juara Akhir (Podium Phase)

| Nama File                | Deskripsi Penggunaan               | Judul Asli Track | Komposer       | Sumber & Lisensi                                                | Verifikasi                                    |
| :----------------------- | :--------------------------------- | :--------------- | :------------- | :-------------------------------------------------------------- | :-------------------------------------------- |
| `bgm-podium-buildup.mp3` | Ketukan drumroll Juara 3 & Juara 2 | CLAP!            | T.Waraya       | [OpenTracks #182](https://opentracks.com/en/bgm/detail/182)     | ✓ (tautan diperbaiki dari `https://https://`) |
| `bgm-podium-victory.mp3` | Musik perayaan Juara 1 & Konfeti   | Crescendo Jitter | まんぼう二等兵 | [OpenTracks #23364](https://opentracks.com/en/bgm/detail/23364) | ✓                                             |

### 5. `05-sfx/` — Efek Suara Interaktif (Sound Effects)

Seluruh efek suara (`sfx-hyoshigi-start.mp3`, `sfx-neko-pop.mp3`, `sfx-question-whoosh.mp3`, `sfx-tick-last5s.mp3`, `sfx-timeup-gong.mp3`, `sfx-reveal-bar.mp3`, `sfx-answer-correct.mp3`, `sfx-answer-wrong.mp3`, `sfx-streak-fire.mp3`, dan `sfx-podium-spotlight.mp3`) disebut berasal dari para kreator di [OpenTracks.com SFX Library](https://opentracks.com/en/se). **Sumber dan kreator per file belum tercatat** (–); jangan menganggap atribusinya terverifikasi sampai halaman sumber masing-masing file ditemukan.
