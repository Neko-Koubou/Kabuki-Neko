# Review tambahan task audio — Kabuki Neko

Review dimulai 2026-10-29, difinalkan 2026-10-30 (Asia/Jakarta). Status: **perlu revisi sebelum menjadi task implementasi**.

Review mencakup dokumen tambahan pengguna, PRD/desain/SA, task plan yang ada, serta aset dan manifest lokal. Tidak mengubah kebutuhan upstream, task checklist, atau audio sumber; belum menjalankan encoder maupun aplikasi.

## 1. Bukti pemeriksaan

- Seluruh **20 MP3** tersedia: 4 lobby, 3 thinking, 1 leaderboard, 2 podium, dan 10 SFX. Semua 20 referensi `src` dalam [manifest sumber](../../../audio-assets/kabuki-neko-audio/audio-manifest.json) menunjuk file lokal yang ada; JSON dapat dibaca.
- Metadata audio diperiksa dengan `/usr/bin/afinfo`. Angka durasi berikut merupakan estimasi metadata, bukan hasil mendengarkan atau audit loudness. `ffprobe` tidak tersedia pada PATH sesi ini; transcode, LUFS/true-peak, loop seam, dan kompatibilitas browser belum diuji.
- [CREDITS.md](../../../audio-assets/kabuki-neko-audio/CREDITS.md) sudah ada. Deskripsi dua kandidat audio/credit kosong pada [04-tasks.md](../04-tasks.md) sudah tertinggal dari kondisi folder terbaru.
- Kebutuhan baru mengganti baseline empat cue/track tunggal menjadi katalog 20 audio dan empat tema lobby. Ini membutuhkan perubahan kontrak, bukan hanya menambahkan hook Howler.

## 2. Temuan dan koreksi

### AUDIO-01 — P1: durasi aset tidak cocok dengan pola pemicu

Dokumen tambahan baris 42, 45 dan 48 menyebut countdown 3 detik, tick setiap detik, serta buildup/spotlight podium. Metadata aktual:

| Aset | Estimasi durasi | Dampak |
| --- | --- | --- |
| `sfx-tick-last5s.mp3` | 28,500 detik | Memulai file utuh pada 5, 4, 3, 2, 1 akan menghasilkan lima playback yang tumpang tindih. |
| `sfx-hyoshigi-start.mp3` | 0,784 detik | Satu playback tidak otomatis menjadi rangkaian ketukan 3–2–1. |
| `bgm-podium-buildup.mp3` | 211,704 detik | Menunggu akhir track sebelum victory bertentangan dengan podium 3 detik di SA §5.5. |
| `sfx-podium-spotlight.mp3` | 6,165 detik | Pemutaran untuk tiga pemenang dalam 3 detik akan saling bertumpuk bila tidak dipotong/dibatasi. |
| `sfx-reveal-bar.mp3` | 6,048 detik | Durasi melebihi animasi chart 300 ms; perlu kebijakan penghentian ketika fase berubah. |

**Koreksi:** tambahkan metadata cue `startMs`/`durationMs`, loop range bila diperlukan, dan batas polyphony per jenis SFX. Pilih segmen setelah didengarkan; jangan mengarang titik potong berdasarkan nama file. Untuk tick, gunakan satu cue pendek per detik atau satu rangkaian lima detik, bukan keduanya. Jadwal podium mengikuti waktu fase server, tidak menunggu `onend` track. Tangani 0/1/2 pemenang dan reduced motion tanpa memutar cue untuk pemenang yang tidak ada.

### AUDIO-02 — P1: katalog baru belum kompatibel dengan DTO dan live snapshot

Dokumen baris 28/41 menggunakan `kabuki|neko8bit|showtime|matcha` dan `lobby[quiz.bgmTrack]`. SA §3.2/4.4 masih menetapkan default `kabuki-matsuri`, `AudioTrack` dengan empat URL scalar, dan shared validation katalog lama. SA §5.3 hanya menyimpan `bgmTrack` dalam snapshot privat; `HostRoomSync` tidak menyediakan field tersebut. Host yang memulihkan room tidak memiliki objek `quiz` yang diasumsikan tabel audio.

**Koreksi:** tetapkan ID kanonis dan kompatibilitas alias `kabuki-matsuri → kabuki`; perbarui defaults/schema/templates/import-export/public-config/audio manifest bersama-sama. Tambahkan konfigurasi audio aman pada host snapshot dari snapshot kuis sesi, tanpa membocorkan seluruh snapshot privat. Tentukan precedence: pilihan tersimpan kuis untuk room baru, override host hanya untuk sesi lokal, dan preferensi browser hanya sebagai default yang disepakati. Jangan biarkan localStorage menimpa pilihan kuis diam-diam. Quick switch lokal tidak memerlukan event server baru kecuali sinkronisasi antarperangkat memang diminta.

### AUDIO-03 — P1: `isAudioUnlocked` tidak boleh dipersist sebagai fakta runtime

Baris 28 menyimpan status unlock ke localStorage. Setelah reload, nilai `true` lama tidak membuktikan AudioContext baru dapat memutar suara. Pemanggilan `Howler.ctx.resume()` tanpa memeriksa backend juga tidak mencakup fallback HTML5.

**Koreksi:** persist hanya preferensi; status unlock berada dalam memori dan ditentukan ulang dari hasil playback/unlock aktual. Tangani rejected resume/playerror, pertahankan tombol “Aktifkan suara”, dan bersihkan listener. Unlock perlu tersedia juga di studio preview dan customizer join, bukan hanya halaman host/player. `resume()` mengembalikan Promise; status UI berubah setelah berhasil. [MDN AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume). Howler menyediakan auto-unlock/event unlock, sedangkan HTML5 audio memiliki kebutuhan unlock sendiri. [Dokumentasi Howler](https://github.com/goldfire/howler.js#global-options).

### AUDIO-04 — P1: event audio belum mempunyai dedup dan pembatalan

Baris 37–48 menghubungkan cue langsung ke event, tanpa aturan snapshot recovery, event duplikat, stale callback, atau delayed SFX. Hook yang remount, dua listener, maupun snapshot setelah reconnect dapat mengulang gong/podium. Timeout streak 300 ms dapat berbunyi setelah soal berikutnya dimulai.

**Koreksi:** satu orchestrator browser dengan lifecycle jelas. Deduplikasi phase cue menggunakan sessionId/phaseVersion/cue, event cue memakai eventId, dan tick memakai questionId+detik. Invalidate semua callback fade/load/delay saat sesi/fase berubah. Snapshot recovery hanya merekonsiliasi BGM yang sekarang relevan, tidak memutar ulang SFX historis. Tetapkan stop/reset rate pada FINISHED, keluar, kick, sesi digantikan, lost room, dan preview studio selesai. Batasi burst `nekoPop` ketika banyak peserta join.

### AUDIO-05 — P2: timer nol dan reveal adalah dua waktu berbeda

Baris 46 menempatkan gong “tepat saat waktu habis” di event `game:answer_reveal`. Menurut SA §5.5, input tutup pada deadline, lalu ada grace 1.500 ms; reveal juga dapat terjadi lebih awal karena skip/semua menjawab. Keduanya tidak dapat dianggap satu trigger.

**Koreksi yang disarankan:** tick/hurry-up berhenti pada `inputClosesAt`; gong dan chart cue dipicu satu kali oleh reveal yang sudah disahkan server, dengan copy yang tidak mengklaim selalu berarti timer nol. Jika gong harus persis pada deadline, jadikan cue lokal terpisah dan jangan ulang di reveal. Tidak ada suara benar/salah saat grace. Tick berasal dari clock sync yang sudah ada; reconnect tidak mengejar tick yang terlewat. Durasi thinking saat ini mencakup seluruh enum waktu yang diizinkan, jadi rentang 46–59 detik bukan bug pada baseline sekarang.

### AUDIO-06 — P2: trigger streak salah untuk POLL

Baris 46 hanya memeriksa `currentStreak >= 3`. Pada POLL, streak lama dipertahankan; pemain dengan streak 3 akan mendapat suara bonus meskipun polling tidak memberi bonus.

**Koreksi:** cue streak mensyaratkan hasil baru CORRECT/PARTIAL, `!isNoPoints`, bonus positif, dan streak baru >=3. PARTIAL memperoleh suara sukses sesuai keputusan produk. POLL, UNANSWERED, NOT_ELIGIBLE dan hasil nullable mendapat perilaku netral eksplisit. Cue klik jawaban adalah konfirmasi interaksi lokal, bukan bukti jawaban sudah diterima server.

### AUDIO-07 — P2: fallback MP3 belum dinormalisasi dan build belum terdefinisi

Baris 17 memberi filter loudnorm pada WebM BGM, tetapi baris 20 hanya menyebut encoder/bitrate MP3. Itu tidak memenuhi label “Normalized” dan dapat menghasilkan volume berbeda menurut format yang dipilih browser. SFX `nekoPop` sumbernya 96 kbps; encode 128 kbps tidak selalu memperkecil file.

**Koreksi:** gunakan sumber/cue/normalisasi BGM yang sama untuk kedua format, tetapkan sample rate keluaran yang didukung, dan ukur hasil. Loudnorm mendukung single/double pass; mode dynamic dapat memakai 192 kHz internal sehingga sample rate keluaran perlu eksplisit. [Dokumentasi FFmpeg loudnorm](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/filters.texi). Pin FFmpeg build dengan libopus/libmp3lame pada lingkungan build web/CI; ffprobe runtime API yang direncanakan saat ini tidak menyediakan encoder build tersebut.

Build harus memvalidasi manifest, menjaga source, menulis ke staging lalu mempublikasikan hanya ketika 40 output audio dan dua metadata lengkap, serta gagal jelas jika codec/input hilang. Tambahkan durasi/checksum/schemaVersion ke manifest generated. Array format memprioritaskan format kompatibel; jangan menganggapnya otomatis menyelesaikan semua HTTP/decode failure. [Howler src/loaderror](https://github.com/goldfire/howler.js#options).

### AUDIO-08 — P2: crossfade, rate dan volume memiliki lebih dari satu definisi

Baris 31 meminta crossfade sekaligus hanya satu BGM aktif. Crossfade membutuhkan overlap outgoing/incoming. Selain itu manifest `thinking.puzzle.hurryUpRate=1.18`, sementara dokumen meminta 1.22 untuk seluruh thinking. Volume track di manifest dan volume kategori di store belum mempunyai rumus gabungan. Toggle opt-in BGM player STREAMER juga belum ada dalam state yang didefinisikan.

**Koreksi:** tetapkan maksimal satu BGM stabil, maksimal dua selama transisi 500 ms, kemudian stop/unload outgoing. Pergantian cepat harus membatalkan fade lama agar tidak mematikan track baru. Pilih satu sumber rate; mengikuti permintaan terbaru berarti memperbarui puzzle menjadi 1.22. Definisikan effective volume = mute gate × volume kategori × gain track; rate reset 1 saat keluar answering. Tambahkan preferensi opt-in streamer terpisah, default off. AudioContext unlocked bukan persetujuan menyalakan BGM.

### AUDIO-09 — P2: musik dapat menutupi materi soal

Mapping answering selalu memainkan thinking BGM pada host, sementara soal bisa memuat audio/video/YouTube. Tanpa aturan prioritas, musik menutupi materi yang harus didengar peserta. BGM victory hampir 396 detik juga berisiko dimuat penuh jauh sebelum diperlukan bila seluruh katalog dipreload.

**Koreksi:** hentikan atau kecilkan BGM saat media soal bersuara, lalu pulihkan hanya jika phase/generation masih sesuai. Definisikan prioritas preview studio, media soal, BGM dan SFX; preload hanya cue pendek yang diperlukan serta BGM fase relevan. Howler memiliki opsi streaming HTML5 untuk berkas besar; pilihan backend tetap perlu uji rate/loop/fade dan autoplay. [Howler html5/preload](https://github.com/goldfire/howler.js#options).

### AUDIO-10 — P2: kredit dan kebijakan distribusi belum terbukti lengkap

[CREDITS.md](../../../audio-assets/kabuki-neko-audio/CREDITS.md) mempunyai URL rusak `hhttps://` untuk puzzle dan `https://https://` untuk buildup. Kredit 10 SFX hanya menunjuk halaman library umum tanpa pemetaan judul/komposer/sumber per file. Identitas file tidak dapat dipastikan dari nama baru atau ekstensi.

**Koreksi:** lengkapi provenance per file termasuk versi/tanggal ketentuan dan izin modifikasi serta distribusi bersama aplikasi. Pisahkan lisensi kode dan audio dalam notices. Menyalin credits atau mengubah MP3 ke WebM tidak dengan sendirinya menyelesaikan izin distribusi. URL lisensi OpenTracks yang diberikan tidak berhasil dibaca melalui alat web saat review; karena itu review ini **belum memverifikasi** klaim izin maupun larangan pada notice. Ini bukan kesimpulan bahwa penggunaan aset tersebut terlarang. Jangan menerbitkan klaim legal baru sebagai fakta sebelum sumbernya tersedia.

### AUDIO-11 — P2: aksesibilitas dan lokalisasi perlu masuk acceptance criteria

Baris 45 menambah flash merah tanpa pola/durasi; baris 52 menambah shortcut satu huruf M. Desain sebelumnya melarang kedipan cepat dan mewajibkan keyboard serta enam bahasa. Shortcut global dapat mengganggu input/IME, dan shortcut karakter perlu dinonaktifkan/dibatasi fokus atau memakai modifier.

**Koreksi:** warning stabil berikon/teks, dukung reduced motion tanpa strobe; M tidak aktif dalam input/textarea/contenteditable/IME dan diberi kebijakan remap/off atau focus scope. Pisahkan kontrol BGM/SFX sesuai state, label aksesibel dan status loading/empty/ideal/partial/error. Lokalisasikan label, error autoplay, credits section dan preview untuk enam katalog. Nama komposer/judul asli tidak diterjemahkan sebagai UI.

## 3. Dampak pada task plan

Pertahankan ID task yang sudah ada saat mengintegrasikan revisi agar referensi tidak rusak. Revisi tugas lama yang overlap; jangan menambahkan implementasi audio kedua dengan nama file berbeda.

| Task lama | Perubahan yang diperlukan |
| --- | --- |
| TASK-001/008 | Pastikan dependency root/web dan lockfile mencakup tool build, Howler/types; aplikasi masih belum memiliki manifest. |
| TASK-014 | Ganti katalog empat URL menjadi kontrak manifest/kategori/tema yang berversi. |
| TASK-019/020/022 | Telusuri schema kuis/import/game/socket yang terkena ID BGM dan host recovery; update tugas yang benar-benar mengubah kontrak. |
| TASK-073/074 | Sesuaikan audio registry dan public-config dengan katalog baru. |
| TASK-114 | Ganti pembuatan empat MP3 baseline menjadi pemeriksaan sumber/cue serta pipeline 20 input → 40 output. |
| TASK-115 | Lengkapi notices dan packaging audio yang baru. |
| TASK-130 | Pecah store, engine playback dan orchestrator menjadi task kecil; gunakan `audio.store.ts`/`use-audio-engine.ts` mengikuti konvensi kebab-case yang ada. |
| TASK-137/146/150/157/158/160 | Integrasi metadata/studio, avatar, player dan host; jangan memasukkan semua perubahan ini ke task engine. |
| TASK-149 | About/credits; tetap gunakan rute About yang ada, modal hanya bila memang dibutuhkan. |
| TASK-174/175/181 | Packaging, encoder build image dan CI: input hilang/manifest invalid/credits tidak lengkap harus terdeteksi. |

Urutan pecahan kerja yang disarankan: rekonsiliasi PRD/desain/SA → audit aset/kredit/cue → schema katalog → optimizer dan verifikasi hasil → preference store → playback engine → orchestrator host → orchestrator player → studio/controls/credits → browser/integration/release evidence. Setiap task resmi tetap harus memiliki 1–4 target file, Depends On dan perintah/assertion DoD. File audio generated tidak dibuat satu task per file; source yang diedit dan tool pembangkitnya yang dibatasi.

## 4. Acceptance checks minimum untuk revisi

1. Dua puluh input lengkap; 40 hasil format dapat diprobe, durasi cue benar, jalur manifest/credits valid, source hash tidak berubah. Gagal satu input tidak menerbitkan set output parsial.
2. Fresh load, reload dengan saved preferences, autoplay denied, resume rejected dan fallback HTML5 tetap punya kontrol aktivasi yang bekerja.
3. Rapid track switching/React remount/reconnect/reordered events tidak menggandakan cue; delayed streak dan fade callback dibatalkan ketika generasi berubah.
4. Soal 5/10/20/30/60/90/120/240 detik, timer nol+grace, early skip/all-answered, POLL/no-points/partial/unanswered menghasilkan cue yang benar tanpa hasil prematur.
5. Podium 0/1/2/3 pemain selesai sesuai fase 3 detik; recovery tidak memutar buildup/spotlight historis. FINISHED/exit/mute/hidden-state behavior terdokumentasi dan diuji.
6. PROJECTOR player tanpa BGM; STREAMER BGM hanya opt-in; materi audio/video tidak tertutup BGM. Safari/iOS nyata tetap perlu smoke test di samping Playwright WebKit.
7. Kontrol keyboard, IME, reduced motion, enam bahasa, offline/missing audio serta credits rendering aman; kegagalan audio tidak menghentikan permainan.

Review ini selesai. Temuan merupakan perubahan spesifikasi yang direkomendasikan; belum menandai task implementasi apa pun selesai.
