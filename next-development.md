# Next Development

Dokumen ini berisi saran task pengembangan berikutnya untuk Classic Radio, disusun dari konteks proyek saat ini: aplikasi Tauri + Vite vanilla JS untuk radio streaming desktop Debian.

## Prioritas Tinggi


2. Tambahkan validasi URL stasiun di manager
   - Cegah input URL kosong, format salah, atau protokol selain `http`/`https`.
   - Tampilkan pesan error yang jelas di form manager.
   - Pertimbangkan tombol "Test stream" sebelum menyimpan stasiun.

3. Perbaiki persistensi data stasiun
   - Saat ini data tersimpan di `localStorage`.
   - Untuk aplikasi desktop, pertimbangkan simpan ke file config Tauri agar lebih eksplisit dan mudah backup.
   - Tambahkan mekanisme import/export JSON untuk daftar stasiun.

4. Tangani dependency CDN
   - `Font Awesome` dan `hls.js` masih dimuat dari CDN.
   - Untuk aplikasi desktop Debian, sebaiknya bundling dependency lewat npm agar aplikasi tetap berjalan offline.
   - Update `index.html` dan `manager.html` supaya tidak bergantung pada internet untuk icon/player library.

5. Tambahkan state loading/error yang lebih informatif
   - Bedakan status: loading, buffering, offline, stream mati, CORS/error playback, reconnecting.
   - Tampilkan nama stasiun dan reason error secara ringkas.
   - Hindari status generik seperti "Error playing station." untuk kasus yang bisa dijelaskan.

## Prioritas Menengah

1. Simpan preferensi user
   - Source terakhir: Indonesia/internasional.
   - Stasiun terakhir.
   - Volume terakhir.
   - Mute state.
   - Ukuran/posisi window jika dibutuhkan.



3. Rapikan UX manager stasiun
   - Tambahkan konfirmasi sebelum delete dan reset.
   - Tambahkan indikator mode edit.
   - Tambahkan urutan/sort stasiun, minimal sort berdasarkan nama.
   - Pertimbangkan drag-and-drop reorder jika daftar makin besar.

4. Perbaiki sistem tray
   - Update label menu Play/Pause sesuai state player.
   - Tambahkan current station di tooltip tray jika memungkinkan.
   - Pastikan behavior close/hide konsisten untuk main window dan station manager.

5. Tambahkan shortcut keyboard
   - Space: play/pause.
   - Arrow Left/Right: previous/next.
   - Arrow Up/Down: volume.
   - Escape: tutup dropdown atau manager.

## Prioritas Rendah



2. Tambahkan favorite stations
   - User bisa menandai stasiun favorit.
   - Tambahkan filter "Favorites" di player.

3. Tambahkan mini mode
   - Window kecil berisi current station + tombol play/prev/next.
   - Cocok untuk penggunaan desktop jangka panjang.




## Quality dan Build

1. Tambahkan lint/format
   - Gunakan formatter konsisten untuk JS/CSS/Rust.
   - Tambahkan script npm untuk `format` dan `check`.

2. Tambahkan test minimal
   - Unit test untuk `station-store.js`.
   - Test validasi station form.
   - Smoke test build frontend.

3. Verifikasi build Tauri Debian
   - Jalankan `npm run deb` di environment Debian dengan dependency native lengkap.
   - Cek hasil `.deb`, icon, launcher, kategori aplikasi, dan tray.

4. Review konfigurasi security
   - `csp` saat ini `null`.
   - Setelah CDN dibundling lokal, pasang CSP yang lebih ketat.
   - Audit permission Tauri agar hanya capability yang benar-benar dibutuhkan yang aktif.



