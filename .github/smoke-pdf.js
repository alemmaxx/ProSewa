// Ujian CI: tukar PDF (slip bank) kepada gambar menggunakan pdf.js yang dibundel
const {chromium} = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<div style="font:20px sans-serif;padding:40px"><h1>MAYBANK2U</h1><p>Transfer Successful</p><p>Amount: RM 650.00</p><p>Ref: MBB123456789</p></div>');
  const pdf = await p.pdf({format: 'A4'}); const errs = []; const a = await b.newPage();
  a.on('pageerror', e => errs.push(e.message)); a.on('console', m => console.log('console:', m.text().slice(0, 200)));
  await a.goto('http://localhost:8765/'); await a.waitForTimeout(800);
  const r = await a.evaluate(async b64 => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const f = new File([bin], 'slip.pdf', {type: 'application/pdf'});
    const d = await compressImage(f, 1000, .68); const q = await compressLogo(f, 720); return {len: d.length, head: d.slice(0, 23), qr: q.slice(0, 22), d};
  }, pdf.toString('base64'));
  require('fs').writeFileSync('out.jpg', Buffer.from(r.d.split(',')[1], 'base64'));
  console.log('RESULT', r.len, r.head, r.qr, 'errs', JSON.stringify(errs));
  if (!r.head.startsWith('data:image/jpeg') || r.len < 5000) process.exit(1);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
