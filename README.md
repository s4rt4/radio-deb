# Classic Radio

Classic Radio adalah aplikasi radio streaming desktop untuk Debian berbasis Tauri. UI klasik coklat keemasan dari versi web dipertahankan, lalu ditambah fitur desktop seperti system tray dan manajemen stasiun.

## Fitur

- Streaming radio Indonesia dan internasional.
- Dukungan stream umum seperti MP3, AAC, OGG, dan HLS `.m3u8`.
- Visualizer audio berbasis canvas.
- Tambah, edit, hapus, dan reset stasiun.
- Data perubahan stasiun disimpan lokal di aplikasi.
- Tombol close menyembunyikan window ke system tray.
- Tray menu: Show, Hide, Play/Pause, Previous, Next, Exit.
- Target build Debian package `.deb`.

## Struktur

```text
.
├── package.json
├── vite.config.js
├── src/
│   ├── index.html
│   ├── main.js
│   ├── style.css
│   └── data/
│       ├── indonesia.js
│       └── international.js
├── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        ├── lib.rs
        └── main.rs
└── docs/
    └── source_radio_indonesia/
```

## Prasyarat Debian

Install dependency native yang dibutuhkan Tauri/WebKitGTK:

```bash
sudo apt install pkg-config libglib2.0-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

## Development

Install dependency JavaScript:

```bash
npm install
```

Jalankan aplikasi desktop:

```bash
npm run tauri:dev
```

Build paket Debian:

```bash
npm run deb
```

File `.deb` akan dibuat di folder target Tauri setelah build selesai.

## Catatan Debian

System tray di Linux bergantung pada dukungan tray desktop environment yang dipakai. Pada beberapa environment minimal, paket AppIndicator/Ayatana mungkin perlu tersedia agar icon tray tampil.
