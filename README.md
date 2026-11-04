# ProSewa 🏠

App web untuk urus sewa rumah. Owner (tuan rumah) daftar dan urus penyewa. Setiap penyewa ada link sendiri, tanpa login. App boleh di-install di phone.

## Link
- **Owner (admin):** https://alemmaxx.github.io/ProSewa/
- **Penyewa:** `https://alemmaxx.github.io/ProSewa/penyewa.html?t=TOKEN` (salin dari kad penyewa)
- **Super Admin:** https://alemmaxx.github.io/ProSewa/#super (hanya akaun UID Super Admin)

## Fail
| Fail | Fungsi |
|---|---|
| `index.html` | App penuh (owner, penyewa, super admin). `penyewa.html` dijana daripada fail ini oleh `build.sh` semasa deploy |
| `firestore.rules` | Rules untuk database Firestore `prosewa` |
| `manifest*.webmanifest`, `sw.js`, `icon-*.png` | Install app (PWA) |
| `.github/workflows/pages.yml` | Auto-deploy ke GitHub Pages setiap push ke `main` |

## Firebase (projek kukusanmy, database `prosewa`)
1. Firestore: cipta database **`prosewa`**.
2. Authentication: aktifkan **Email/Password**, dan tambah domain `alemmaxx.github.io` di Authorized domains.
3. Tampal `firestore.rules` dalam database `prosewa`, tab Rules, kemudian **Publish**.
4. Isi `FIREBASE_CONFIG` di bahagian atas skrip dalam `index.html`. Kalau kosong, app berjalan dalam **mod peranti** (untuk ujian sahaja).

### Struktur data
- `owners/{uid}`: nama, telefon, bank, tetapan peringatan (awam, dibaca penyewa)
- `ownerPriv/{uid}`: emel (owner & Super Admin sahaja)
- `subs/{uid}`: langganan (`plan`, `startTs`/`start`, `end`). Owner hanya boleh mula percubaan; selebihnya Super Admin / Cloud Function ToyyibPay
- `config/app`: `trialDays`
- `subPayments/{id}`: sejarah bayaran langganan
- `tenants/{token}`: maklumat penyewa (ID dokumen = token link)
  - `tenants/{token}/payments/{id}`: bayaran & bukti (gambar dimampatkan, disimpan dalam dokumen)
  - `tenants/{token}/reminders/{id}`: peringatan dari owner

## Langganan
- Owner baru dapat **percubaan percuma** (asal 14 hari). Super Admin boleh ubah hari di `#super`.
- Bila **tamat**, owner dikunci di skrin bayar, dan semua link penyewanya tunjuk "Sistem tergendala".
- Super Admin boleh **+30 hari / +1 tahun / set semula percubaan / tamatkan** untuk setiap owner.
- ToyyibPay: akan disambung melalui Cloud Function (secret key tidak diletak dalam `index.html`).

## Bahasa
Togol **BM | EN**. Teks baru: tambah dalam kamus `I18N` (cari "Kamus BM → EN").
