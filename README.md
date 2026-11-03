# ProSewa 🏠 — v2

App web untuk **1 owner, ramai penyewa**. Setiap penyewa ada link sendiri dan tak perlu daftar akaun. Boleh di-install sebagai app di phone.

## Dua website
- **Owner (admin):** `https://alemmaxx.github.io/ProSewa/` — install sebagai app **ProSewa**.
- **Penyewa:** `https://alemmaxx.github.io/ProSewa/penyewa.html?t=KOD` — setiap penyewa ada link & kod sendiri, install sebagai app **ProSewa Penyewa**.
- `penyewa.html` dijana automatik oleh `build.sh` semasa deploy (GitHub Actions) — edit `index.html` sahaja.

## Fail
| Fail | Fungsi |
|---|---|
| `index.html` | App penuh (owner + penyewa) |
| `manifest.webmanifest` | Supaya boleh "Install app" |
| `sw.js` | Service worker: install, buka laju, notifikasi phone |
| `icon-192.png`, `icon-512.png` | Ikon app |

Upload **semua 5 fail** ke folder yang sama (contoh repo GitHub `ProSewa` → Settings → Pages). Link owner: `https://alemmaxx.github.io/ProSewa/`

## Owner (admin)
- **Login admin**: kali pertama buka, cipta akaun admin. Atau tekan "Cuba dengan data contoh" (admin@demo.com / 1234).
- **Tab Penyewa**: tekan **+** (kanan atas) untuk tambah nama, telefon, alamat, harga sewa, dan tarikh bayar (hari bulan ke-). Lepas simpan, link penyewa terus keluar dan boleh dihantar melalui WhatsApp.
- **Tab Status Sewa**:
  - Bukti bayaran dari penyewa (gambar resit bank). Tekan **Lulus**, dan resit terus masuk ke app penyewa. Atau tekan **Tolak** dan pilih sebab.
  - Senarai **Belum bayar** dan **Sudah bayar** untuk setiap bulan.
  - **🔔 Hantar peringatan** (terus) atau **⏰ Jadual** ikut tarikh & masa. Peringatan masuk notifikasi app penyewa, bukan WhatsApp. Butang 💬 hanya untuk chat segera.
  - **Rekod tunai** untuk bayaran tunai, dengan resit dijana automatik.
- **Tab Laporan**: kutipan berbanding jangkaan setiap bulan, % kutipan, tunggakan ikut penyewa, dan muat turun CSV.
- **Tab Tetapan**: maklumat bank (dipaparkan kepada penyewa), peringatan automatik (X hari sebelum, jam berapa), notifikasi phone, install app, dan tukar kata laluan.

## Penyewa (buka link sendiri)
- Notifikasi: peringatan bayar, tunggakan, mesej dari owner, bayaran diluluskan atau ditolak.
- **Muat naik bukti bayaran**: pilih screenshot atau gambar resit, kemudian hantar. Tunggu owner luluskan, dan resit akan muncul.
- **Sejarah**: semua bayaran, dengan tarikh dan resit.
- Boleh install sebagai app. Link disimpan, jadi ikon app terus buka paparan penyewa.

## ⚠️ Had versi ini (sebelum Firebase)
- Data disimpan **dalam browser/peranti** sahaja. Link penyewa hanya berfungsi di peranti yang sama, jadi sesuai untuk cuba dan demo. **Selepas sambung Firebase**, link boleh dibuka di phone penyewa.
- Peringatan berjadual muncul dalam app penyewa bila sampai masa. WhatsApp hanya untuk chat segera; semua peringatan dihantar dalam app.

## Langkah seterusnya: Firebase (projek kukusanmy, database `prosewa`)
1. Tukar objek `DB` dalam `index.html` kepada Firestore (fungsi sama: list/get/add/update/remove).
2. Login owner guna Firebase Authentication.
3. Penyewa akses melalui token link (rules Firestore semak token).
4. Bukti bayaran simpan di Firebase Storage.
5. Cloud Function berjadual: hantar push notification (FCM) ke phone penyewa ikut tarikh dan masa, walaupun app tertutup.
