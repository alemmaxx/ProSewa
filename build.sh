#!/bin/sh
# Bina folder _site: website owner (index.html) + website penyewa (penyewa.html) + halaman muat turun APK
set -e
rm -rf _site && mkdir -p _site
cp index.html download.html manifest.webmanifest manifest-penyewa.webmanifest sw.js icon-192.png icon-512.png icon-t-192.png icon-t-512.png _site/
cp -r .well-known _site/
sed -e 's#href="manifest.webmanifest"#href="manifest-penyewa.webmanifest"#' \
    -e 's#<title>ProSewa</title>#<title>ProSewa Penyewa</title>#' \
    -e 's#content="ProSewa">#content="Sewa Saya">#' \
    -e 's#icon-192.png#icon-t-192.png#g' \
    index.html > _site/penyewa.html
# APK terkini dari GitHub Release (jika ada)
if [ -n "$FETCH_APK" ]; then
  for f in ProSewa-Admin.apk ProSewa-Penyewa.apk; do
    curl -sSLf -o _site/$f https://github.com/alemmaxx/ProSewa/releases/download/latest/$f && echo "APK: $f" || echo "APK $f belum ada dalam Release"
  done
fi
echo "_site siap:"; ls _site
