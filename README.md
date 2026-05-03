# Classic Radio

Classic Radio adalah aplikasi radio streaming desktop untuk Debian berbasis Tauri. UI klasik coklat keemasan dari versi web dipertahankan, lalu ditambah fitur desktop seperti system tray, manajemen stasiun, favorit, dan mini mode.

## Fitur

- Streaming radio Indonesia dan internasional.
- Dukungan stream umum seperti MP3, AAC, OGG, dan HLS `.m3u8` lewat `hls.js` lokal.
- Visualizer audio berbasis canvas.
- Tambah, edit, hapus, reset, validasi URL, dan test stream stasiun.
- Import dan export daftar stasiun sebagai JSON.
- Favorite station dan filter khusus favorit.
- Mini mode untuk tampilan player ringkas.
- Penyimpanan preferensi user: source terakhir, stasiun terakhir, volume, mute, dan mini mode.
- Shortcut keyboard: Space untuk play/pause, Arrow Left/Right untuk previous/next, Arrow Up/Down untuk volume, Escape untuk menutup dropdown.
- Status playback lebih informatif untuk loading, buffering, offline, error stream, dan reconnect.
- Data perubahan stasiun disimpan lokal di aplikasi.
- Tombol close menyembunyikan window ke system tray.
- Tray menu: Show, Hide, Play/Pause, Previous, Next, Exit.
- Label Play/Pause dan tooltip tray mengikuti status player.
- Dependency frontend dibundel lokal, tanpa CDN runtime untuk icon dan HLS.
- CSP Tauri dibuat lebih ketat dibanding konfigurasi awal.
- Target build Debian package `.deb`.

## Screenshot

### Full Mode

![Classic Radio full mode](assets/full-mode.png)

### Mini Mode

![Classic Radio mini mode](assets/mini-mode.png)

### Panel Preview

![Classic Radio panel preview](assets/on-panel-preview.png)

### Kelola Stasiun

![Classic Radio station manager](assets/setting-window.png)

## Struktur

```text
.
├── assets/
│   ├── full-mode.png
│   ├── mini-mode.png
│   ├── on-panel-preview.png
│   └── setting-window.png
├── package.json
├── vite.config.js
├── src/
│   ├── index.html
│   ├── main.js
│   ├── manager.html
│   ├── manager.js
│   ├── station-store.js
│   ├── station-store.test.js
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

Jalankan test, build frontend, dan `cargo check`:

```bash
npm run check
```

Build paket Debian:

```bash
npm run deb
```

File `.deb` akan dibuat di:

```text
src-tauri/target/release/bundle/deb/
```

Untuk versi `0.2.0`, nama artefak yang dihasilkan:

```text
Classic Radio_0.2.0_amd64.deb
```

## Catatan Debian

System tray di Linux bergantung pada dukungan tray desktop environment yang dipakai. Pada beberapa environment minimal, paket AppIndicator/Ayatana mungkin perlu tersedia agar icon tray tampil.

## Catatan Data

Daftar stasiun custom dan preferensi user disimpan di storage lokal WebView aplikasi. Gunakan fitur import/export JSON di window Kelola Stasiun untuk backup atau migrasi daftar stasiun.
