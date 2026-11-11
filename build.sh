#!/bin/sh
# Bina folder _site: website owner (index.html) + website penyewa (penyewa.html) + halaman muat turun APK
set -e
rm -rf _site && mkdir -p _site
cp index.html download.html promo.html privasi.html padam-akaun.html manifest.webmanifest manifest-penyewa.webmanifest sw.js icon-192.png icon-512.png icon-t-192.png icon-t-512.png _site/
cp -r .well-known shots _site/
sed -e 's#href="manifest.webmanifest"#href="manifest-penyewa.webmanifest"#' \
    -e 's#<title>ProSewa</title>#<title>ProSewa Penyewa</title>#' \
    -e 's#content="ProSewa">#content="Sewa Saya">#' \
    -e 's#icon-192.png#icon-t-192.png#g' \
    index.html > _site/penyewa.html
# Pustaka untuk baca PDF & jana PDF (dari npm, jika sudah dipasang)
if [ -d node_modules/pdfjs-dist ]; then
  mkdir -p _site/lib
  cp node_modules/pdfjs-dist/build/pdf.min.js node_modules/pdfjs-dist/build/pdf.worker.min.js _site/lib/
  [ -f node_modules/html2pdf.js/dist/html2pdf.bundle.min.js ] && cp node_modules/html2pdf.js/dist/html2pdf.bundle.min.js _site/lib/
  echo "lib: pdf.js & html2pdf"
fi
# APK terkini dari GitHub Release (jika ada)
if [ -n "$FETCH_APK" ]; then
  for f in ProSewa-Admin.apk ProSewa-Penyewa.apk; do
    curl -sSLf -o _site/$f https://github.com/alemmaxx/ProSewa/releases/download/latest/$f && echo "APK: $f" || echo "APK $f belum ada dalam Release"
  done
  curl -sSLf -o _site/apk-version.json https://github.com/alemmaxx/ProSewa/releases/download/latest/apk-version.json && cat _site/apk-version.json || echo "apk-version.json belum ada"
fi
echo "_site siap:"; ls _site
