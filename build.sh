#!/bin/sh
# Bina folder _site: website owner (index.html) + website penyewa (penyewa.html)
set -e
rm -rf _site && mkdir -p _site
cp index.html manifest.webmanifest manifest-penyewa.webmanifest sw.js icon-192.png icon-512.png icon-t-192.png icon-t-512.png _site/
sed -e 's#href="manifest.webmanifest"#href="manifest-penyewa.webmanifest"#' \
    -e 's#<title>ProSewa</title>#<title>ProSewa Penyewa</title>#' \
    -e 's#content="ProSewa">#content="Sewa Saya">#' \
    -e 's#icon-192.png#icon-t-192.png#g' \
    index.html > _site/penyewa.html
echo "_site siap:"; ls _site
