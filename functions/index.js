/**
 * ProSewa — Cloud Functions untuk bayaran langganan ToyyibPay
 * Projek: kukusanmy · Database Firestore: "prosewa" · Region: asia-southeast1
 *
 * prosewaCreateBill  : owner (log masuk) minta bil → pulangkan billCode ToyyibPay
 * prosewaCallback    : ToyyibPay panggil selepas bayar → sahkan → aktifkan langganan
 * prosewaRedeemPromo : owner guna kod promo (sekali guna) → tambah hari langganan
 * prosewaOnPayment   : bukti bayaran baru / lulus / tolak → push notification
 * prosewaOnReminder  : mesej owner → push kepada penyewa
 * prosewaOnIssue     : aduan kerosakan baru → owner; kemas kini status → penyewa
 * prosewaPushTick    : setiap 15 minit → peringatan berjadual, tarikh bayar, tunggakan, kontrak tamat
 * prosewaHealth      : setiap 30 minit → pemantau sistem (laman, database, notifikasi, ToyyibPay, ralat) + amaran kepada Super Admin
 * prosewaHealthNow   : Super Admin tekan "Semak sekarang" / "Uji amaran"
 * prosewaOnReport    : laporan masalah daripada owner → push kepada Super Admin
 *
 * Secret key ToyyibPay TIDAK ditulis dalam kod. Simpan sekali melalui CMD:
 *   firebase functions:secrets:set TOYYIBPAY_SECRET_KEY --project kukusanmy
 */
const {onRequest} = require('firebase-functions/v2/https');
const {onDocumentWritten, onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {getMessaging} = require('firebase-admin/messaging');
const {defineSecret} = require('firebase-functions/params');
const {initializeApp} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore('prosewa');
const TOYYIBPAY_SECRET_KEY = defineSecret('TOYYIBPAY_SECRET_KEY');
const CATEGORY_CODE = 'ofrxefa7';
const TP = 'https://toyyibpay.com';
const REGION = 'asia-southeast1';
const DB_REGION = 'asia-southeast1';   // lokasi database Firestore "prosewa" (trigger mesti sama lokasi)
const CALLBACK_URL = `https://${REGION}-kukusanmy.cloudfunctions.net/prosewaCallback`;
const ALLOWED_RETURN = ['https://prosewa.web.app/', 'https://prosewa.firebaseapp.com/', 'https://alemmaxx.github.io/ProSewa/'];

const DEFAULT_PLANS = [
  {id: 'monthly', name: 'Bulanan', months: 1, price: 19.90},
  {id: 'half', name: '6 Bulan', months: 6, price: 99.00},
  {id: 'yearly', name: 'Setahun', months: 12, price: 179.00}
];
const TRIAL_DAYS = 14;
const SUPER_UID = 'D3U6Dxs5joZQq5EYRdjZQUmRV773';
// Rekod ralat function supaya kelihatan di panel Super Admin → Status sistem
async function logErr(where, e) {
  try { await db.collection('sysErrors').add({src: 'fn', where: String(where).slice(0, 100), msg: String((e && (e.stack || e.message)) || e).slice(0, 500), at: myNow()}); } catch (x) { console.error('logErr', x); }
}

// ---------- tarikh (waktu Malaysia) ----------
const myISO = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'}).format(d);
const myNow = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 16); };
const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10); };

async function getPlans() {
  const c = (await db.doc('config/app').get()).data() || {};
  const plans = DEFAULT_PLANS.map(p => { const o = (c.plans || []).find(x => x.id === p.id) || {}; return {...p, price: o.price != null ? +o.price : p.price}; });
  return {plans, trialDays: +c.trialDays || TRIAL_DAYS};
}
function subEnd(sub, trialDays) {
  if (!sub) return null;
  if (sub.plan === 'trial') { const start = sub.startTs ? myISO(sub.startTs.toDate()) : sub.start; return start ? addDays(start, trialDays) : null; }
  return sub.end || null;
}
function cors(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  return false;
}
const clean = (s, n) => String(s || '').replace(/[^A-Za-z0-9 _]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- 1) Cipta bil ----------
exports.prosewaCreateBill = onRequest({region: REGION, secrets: [TOYYIBPAY_SECRET_KEY]}, async (req, res) => {
  if (cors(req, res)) return;
  try {
    if (req.method !== 'POST') return res.status(405).json({error: 'POST sahaja'});
    const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({error: 'Sila log masuk semula.'});
    const user = await getAuth().verifyIdToken(token);
    const {plan: planId, returnUrl} = req.body || {};
    const {plans} = await getPlans();
    const plan = plans.find(p => p.id === planId);
    if (!plan) return res.status(400).json({error: 'Pakej tidak sah.'});
    const back = ALLOWED_RETURN.find(u => String(returnUrl || '').startsWith(u)) ? returnUrl : ALLOWED_RETURN[0];

    const owner = (await db.doc(`owners/${user.uid}`).get()).data() || {};
    const orderRef = db.collection('subOrders').doc();
    const amountSen = Math.round(plan.price * 100);
    const form = new URLSearchParams({
      userSecretKey: TOYYIBPAY_SECRET_KEY.value(),
      categoryCode: CATEGORY_CODE,
      billName: clean(`ProSewa ${plan.name}`, 30),
      billDescription: clean(`Langganan ProSewa ${plan.months} bulan`, 100),
      billPriceSetting: '1',
      billPayorInfo: '1',
      billAmount: String(amountSen),
      billReturnUrl: back,
      billCallbackUrl: CALLBACK_URL,
      billExternalReferenceNo: orderRef.id,
      billTo: clean(owner.name || user.email || 'Owner ProSewa', 50) || 'Owner ProSewa',
      billEmail: user.email || 'noreply@prosewa.web.app',
      billPhone: String(owner.phone || '0100000000').replace(/\D/g, '') || '0100000000',
      billPaymentChannel: '0',
      billChargeToCustomer: '',
      enableDuitNowQR: '1',   // DuitNow QR (perlu diaktifkan dalam akaun ToyyibPay); jika belum aktif, cuba semula tanpa QR
      chargeDuitNowQR: '0'
    });
    const send = async f => { const r = await fetch(`${TP}/index.php/api/createBill`, {method: 'POST', body: f}); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = null; } return {txt: t, code: Array.isArray(j) && j[0] && j[0].BillCode}; };
    let {txt, code: billCode} = await send(form);
    if (!billCode && /duitnow|qr/i.test(txt)) { form.delete('enableDuitNowQR'); form.delete('chargeDuitNowQR'); ({txt, code: billCode} = await send(form)); }   // QR belum aktif → FPX sahaja
    if (!billCode) { console.error('createBill gagal', txt); await logErr('prosewaCreateBill: ToyyibPay', txt); return res.status(502).json({error: 'ToyyibPay menolak permintaan bil.'}); }

    await orderRef.set({uid: user.uid, plan: plan.id, months: plan.months, amount: plan.price, billCode, status: 'pending', createdAt: FieldValue.serverTimestamp()});
    return res.json({billCode, url: `${TP}/${billCode}`});
  } catch (e) {
    console.error(e); if (!(e.code && String(e.code).startsWith('auth/'))) await logErr('prosewaCreateBill', e);
    return res.status(e.code && String(e.code).startsWith('auth/') ? 401 : 500).json({error: 'Ralat pelayan. Cuba lagi.'});
  }
});

// ---------- 2) Callback ToyyibPay ----------
exports.prosewaCallback = onRequest({region: REGION, secrets: [TOYYIBPAY_SECRET_KEY]}, async (req, res) => {
  try {
    const b = req.body || {};
    const orderId = b.order_id || b.billExternalReferenceNo;
    const billCode = b.billcode || b.billCode;
    if (!orderId || !billCode) return res.status(400).send('missing');
    const orderRef = db.doc(`subOrders/${orderId}`);
    const order = (await orderRef.get()).data();
    if (!order || order.billCode !== billCode) return res.status(404).send('order');
    if (order.status === 'paid') return res.send('OK');

    // Sahkan terus dengan ToyyibPay (jangan percaya data callback sahaja)
    const v = await fetch(`${TP}/index.php/api/getBillTransactions`, {method: 'POST', body: new URLSearchParams({billCode, billpaymentStatus: '1'})});
    const tx = await v.json().catch(() => []);
    const paid = Array.isArray(tx) && tx.find(t => String(t.billpaymentStatus) === '1' && Math.round(parseFloat(t.billpaymentAmount) * 100) >= Math.round(order.amount * 100));
    if (!paid) { await orderRef.update({status: 'failed', lastCallback: b, updatedAt: FieldValue.serverTimestamp()}); return res.send('NOT PAID'); }

    const {trialDays} = await getPlans();
    await db.runTransaction(async t => {
      const o = (await t.get(orderRef)).data();
      if (o.status === 'paid') return;
      const subRef = db.doc(`subs/${o.uid}`);
      const sub = (await t.get(subRef)).data();
      const today = myISO(), curEnd = subEnd(sub, trialDays);
      const from = curEnd && curEnd >= today ? curEnd : today;
      const end = addMonths(from, o.months);
      t.set(subRef, {plan: o.plan, start: (sub && sub.start) || today, end});
      t.set(db.collection('subPayments').doc(), {ownerId: o.uid, date: myNow(), plan: o.plan, months: o.months, amount: o.amount, ref: paid.billpaymentInvoiceNo || b.refno || billCode, until: end});
      t.update(orderRef, {status: 'paid', paidAt: FieldValue.serverTimestamp(), refno: b.refno || '', until: end});
    });
    return res.send('OK');
  } catch (e) {
    console.error(e); await logErr('prosewaCallback', e);
    return res.status(500).send('error');
  }
});


// ---------- 3) Kod promo (sekali guna) ----------
exports.prosewaRedeemPromo = onRequest({region: REGION}, async (req, res) => {
  if (cors(req, res)) return;
  try {
    if (req.method !== 'POST') return res.status(405).json({error: 'POST sahaja'});
    const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({error: 'Sila log masuk semula.'});
    const user = await getAuth().verifyIdToken(token);
    const code = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!code) return res.status(400).json({error: 'Sila masukkan kod promo.'});
    const {trialDays} = await getPlans();
    const out = await db.runTransaction(async t => {
      const pRef = db.doc(`promos/${code}`), p = (await t.get(pRef)).data();
      if (!p) return {error: 'Kod promo tidak sah.'};
      if (p.used) return {error: 'Kod promo ini sudah digunakan.'};
      if (p.expires && p.expires < myISO()) return {error: 'Kod promo ini sudah tamat tempoh.'};
      const days = Math.max(1, Math.min(3650, parseInt(p.days, 10) || 0));
      const subRef = db.doc(`subs/${user.uid}`), sub = (await t.get(subRef)).data();
      const today = myISO(), curEnd = subEnd(sub, trialDays);
      const from = curEnd && curEnd >= today ? curEnd : today, end = addDays(from, days);
      const plan = sub && sub.plan && sub.plan !== 'trial' ? sub.plan : 'promo';
      t.set(subRef, {plan, start: (sub && sub.start) || today, end});
      t.update(pRef, {used: true, usedBy: user.uid, usedEmail: user.email || '', usedAt: myNow()});
      t.set(db.collection('subPayments').doc(), {ownerId: user.uid, date: myNow(), plan: 'promo', months: 0, days, amount: 0, ref: code, until: end});
      return {ok: true, days, end};
    });
    return out.error ? res.status(400).json(out) : res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(e.code && String(e.code).startsWith('auth/') ? 401 : 500).json({error: 'Ralat pelayan. Cuba lagi.'});
  }
});

// ---------- 4) Push notification (FCM) ----------
// Peranti disimpan dalam devices/{fcmToken}: {uid} untuk owner, {tok} untuk penyewa, + lang & platform
const RM = n => 'RM ' + Number(n || 0).toFixed(2);
const MON = {bm: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'], en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']};
const ml = (ym, l) => { const [y, m] = String(ym || '').split('-'); return m ? `${MON[l][+m - 1]} ${y}` : ''; };
const dl = (iso, l) => { const [y, m, d] = String(iso || '').split('-'); return d ? `${+d} ${MON[l][+m - 1]} ${y}` : ''; };

async function pushTo(field, value, build, url) {
  const snap = await db.collection('devices').where(field, '==', value).get();
  if (snap.empty) return 0;
  const msgs = snap.docs.map(d => { const l = d.data().lang === 'en' ? 'en' : 'bm', m = build(l);
    return {token: d.id, notification: {title: m.title, body: m.body}, data: {title: m.title, body: m.body, url: url || ''},
      android: {priority: 'high', notification: {icon: 'ic_stat_ps', color: '#d9b44a', sound: 'default'}}, webpush: {headers: {Urgency: 'high'}}}; });
  const r = await getMessaging().sendEach(msgs);
  db.doc('health/admin').set({push: {sent: FieldValue.increment(r.successCount), fail: FieldValue.increment(r.failureCount)}}, {merge: true}).catch(() => {});
  const dead = r.responses.map((x, i) => !x.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(x.error && x.error.code || '') ? snap.docs[i].ref : null).filter(Boolean);
  await Promise.all(dead.map(ref => ref.delete().catch(() => {})));
  return r.successCount;
}
const toOwner = (uid, build) => pushTo('uid', uid, build, 'https://prosewa.web.app/index.html');
const toTenant = (tok, build) => pushTo('tok', tok, build, `https://prosewa.web.app/penyewa.html?t=${tok}`);

exports.prosewaOnPayment = onDocumentWritten({document: 'tenants/{tok}/payments/{pid}', database: 'prosewa', region: DB_REGION}, async ev => {
  const b = ev.data.before.exists ? ev.data.before.data() : null, a = ev.data.after.exists ? ev.data.after.data() : null;
  if (!a) return;
  const tok = ev.params.tok;
  if (!b && a.status === 'pending')
    return toOwner(a.ownerId, l => l === 'en' ? {title: '🧾 New payment proof', body: `${a.tenantName} · ${ml(a.month, l)} · ${RM(a.amount)}. Tap to review.`} : {title: '🧾 Bukti bayaran baru', body: `${a.tenantName} · ${ml(a.month, l)} · ${RM(a.amount)}. Tekan untuk semak.`});
  const was = b ? b.status : '';
  if (a.status === 'confirmed' && was !== 'confirmed')
    return toTenant(tok, l => l === 'en' ? {title: '✅ Payment approved', body: `Receipt ${a.receiptNo} for ${ml(a.month, l)} (${RM(a.amount)}) is ready.`} : {title: '✅ Bayaran diluluskan', body: `Resit ${a.receiptNo} untuk ${ml(a.month, l)} (${RM(a.amount)}) sedia.`});
  if (a.status === 'rejected' && was !== 'rejected')
    return toTenant(tok, l => l === 'en' ? {title: '❌ Payment proof rejected', body: `${ml(a.month, l)}: ${a.rejectReason || 'Please contact your landlord.'}`} : {title: '❌ Bukti bayaran ditolak', body: `${ml(a.month, l)}: ${a.rejectReason || 'Sila hubungi tuan rumah.'}`});
  if (a.status === 'void' && was !== 'void')
    return toTenant(tok, l => l === 'en' ? {title: '🚫 Receipt voided', body: `Receipt ${a.receiptNo}: ${a.voidReason || ''}`} : {title: '🚫 Resit dibatalkan', body: `Resit ${a.receiptNo}: ${a.voidReason || ''}`});
});

exports.prosewaOnIssue = onDocumentWritten({document: 'tenants/{tok}/issues/{iid}', database: 'prosewa', region: DB_REGION}, async ev => {
  const b = ev.data.before.exists ? ev.data.before.data() : null, a = ev.data.after.exists ? ev.data.after.data() : null;
  if (!a) return;
  if (!b) return toOwner(a.ownerId, l => l === 'en' ? {title: '🛠️ New maintenance request', body: `${a.tenantName}: ${a.title}`} : {title: '🛠️ Aduan kerosakan baru', body: `${a.tenantName}: ${a.title}`});
  const nb = (b.updates || []).length, na = (a.updates || []).length;
  if (na > nb) { const u = a.updates[na - 1], done = u.status === 'done';
    return toTenant(ev.params.tok, l => l === 'en' ? {title: done ? '✅ Request resolved' : '🛠️ Request in progress', body: `${a.title}${u.note ? ' — ' + u.note : ''}`} : {title: done ? '✅ Aduan selesai' : '🛠️ Aduan sedang diuruskan', body: `${a.title}${u.note ? ' — ' + u.note : ''}`}); }
});

const msgBuild = r => l => ({title: l === 'en' ? '📩 Message from landlord' : '📩 Mesej dari tuan rumah', body: String(r.message || '').slice(0, 240)});
exports.prosewaOnReminder = onDocumentCreated({document: 'tenants/{tok}/reminders/{rid}', database: 'prosewa', region: DB_REGION}, async ev => {
  const r = ev.data.data();
  if (!r || r.pushed || r.at > myNow()) return;   // berjadual: dihantar oleh prosewaPushTick
  await toTenant(ev.params.tok, msgBuild(r));
  await ev.data.ref.update({pushed: true});
});

const dueISO = (ym, day) => { const [y, m] = ym.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return `${ym}-${String(Math.min(+day || 1, last)).padStart(2, '0')}`; };
exports.prosewaPushTick = onSchedule({schedule: 'every 15 minutes', region: REGION, timeZone: 'Asia/Kuala_Lumpur'}, async () => {
  const now = myNow(), today = now.slice(0, 10), ym = today.slice(0, 7), {trialDays} = await getPlans();
  await db.doc('health/admin').set({lastTick: now}, {merge: true}).catch(() => {});
  const tenants = await db.collection('tenants').where('active', '==', true).get();
  const owners = {}, subs = {};
  for (const d of tenants.docs) {
    const t = d.data(), tok = d.id, log = t.pushLog || {}, upd = {};
    try {
      if (!(t.ownerId in owners)) { owners[t.ownerId] = (await db.doc(`owners/${t.ownerId}`).get()).data() || {}; subs[t.ownerId] = (await db.doc(`subs/${t.ownerId}`).get()).data(); }
      const end = subEnd(subs[t.ownerId], trialDays); if (end && end < today) continue;   // langganan owner tamat
      const st = {autoOn: true, autoDays: 3, autoTime: '09:00', overdueOn: true, ...(owners[t.ownerId].settings || {})};
      // a) mesej berjadual owner
      const rem = await d.ref.collection('reminders').where('at', '<=', now).get();
      for (const r of rem.docs) if (!r.data().pushed) { await toTenant(tok, msgBuild(r.data())); await r.ref.update({pushed: true}); }
      // b) tarikh bayar & tunggakan bulan ini
      if (!t.startDate || t.startDate.slice(0, 7) <= ym) {
        const due = dueISO(ym, t.dueDay), time = st.autoTime || '09:00';
        const pays = (await d.ref.collection('payments').where('month', '==', ym).get()).docs.map(x => x.data());
        const paid = pays.filter(p => p.status === 'confirmed').reduce((s, p) => s + (+p.amount || 0), 0);
        const pending = pays.some(p => p.status === 'pending');
        const rent = [...(t.rentHist || [])].sort((x, y) => x.from.localeCompare(y.from)).reduce((r, x) => r != null ? r : (ym < x.from ? +x.prev : null), null) ?? (+t.rent || 0);
        const unpaid = paid < rent && !pending;
        if (st.autoOn && unpaid && log.due !== ym && now >= `${addDays(due, -(+st.autoDays || 0))}T${time}` && today <= due) {
          await toTenant(tok, l => l === 'en' ? {title: '🔔 Rent payment reminder', body: `Rent for ${ml(ym, l)} ${RM(rent)} is due by ${dl(due, l)}.`} : {title: '🔔 Peringatan bayar sewa', body: `Sewa ${ml(ym, l)} ${RM(rent)} perlu dibayar sebelum ${dl(due, l)}.`});
          upd['pushLog.due'] = ym;
        }
        if (st.overdueOn && unpaid && log.od !== ym && now >= `${addDays(due, 1)}T${time}`) {
          await toTenant(tok, l => l === 'en' ? {title: '⚠️ Rent overdue', body: `Rent for ${ml(ym, l)} ${RM(rent)} is unpaid. Please pay and upload your proof.`} : {title: '⚠️ Sewa tertunggak', body: `Sewa ${ml(ym, l)} ${RM(rent)} belum dibayar. Sila bayar & muat naik bukti.`});
          await toOwner(t.ownerId, l => l === 'en' ? {title: '⚠️ Rent overdue', body: `${t.name} has not paid ${ml(ym, l)} (${RM(rent)}).`} : {title: '⚠️ Sewa tertunggak', body: `${t.name} belum bayar ${ml(ym, l)} (${RM(rent)}).`});
          upd['pushLog.od'] = ym;
        }
      }
      // c) kontrak hampir tamat (30, 7, 1 hari) → owner & penyewa
      if (t.contractEnd && now.slice(11) >= '09:00') {
        const left = Math.round((Date.parse(t.contractEnd) - Date.parse(today)) / 864e5);
        const n = left >= 0 ? [1, 7, 30].find(x => left <= x) : null;
        if (n && !(log.c && log.c[t.contractEnd + '_' + n])) {
          await toOwner(t.ownerId, l => l === 'en' ? {title: '📄 Tenancy ending soon', body: `${t.name}'s tenancy ends on ${dl(t.contractEnd, l)} (${left} days). Renew or plan the move-out.`} : {title: '📄 Kontrak hampir tamat', body: `Kontrak ${t.name} tamat pada ${dl(t.contractEnd, l)} (${left} hari lagi). Perbaharui atau rancang keluar.`});
          await toTenant(tok, l => l === 'en' ? {title: '📄 Tenancy ending soon', body: `Your tenancy ends on ${dl(t.contractEnd, l)}. Please contact your landlord about renewal.`} : {title: '📄 Kontrak sewa hampir tamat', body: `Kontrak sewa anda tamat pada ${dl(t.contractEnd, l)}. Sila hubungi tuan rumah untuk pembaharuan.`});
          upd[`pushLog.c.${t.contractEnd}_${n}`] = true;
        }
      }
      if (Object.keys(upd).length) await d.ref.update(upd);
    } catch (e) { console.error('tick', tok, e); await logErr('prosewaPushTick ' + tok.slice(0, 4), e); }
  }
});


// ---------- 5) Pemantau sistem (macam ProSyariah) ----------
// config/status → awam (app tunjuk jalur amaran umum kepada semua pengguna)
// health/admin  → butiran penuh (Super Admin sahaja); amaran push kepada Super Admin bila masalah bermula / pulih
const LV = {ok: 0, warn: 1, down: 2};
const mins = (a, b) => (Date.parse(b + ':00+08:00') - Date.parse(a + ':00+08:00')) / 6e4;
async function timed(url, opt = {}) {
  let last = null;
  for (let i = 0; i < 2; i++) {   // cuba dua kali supaya gangguan sekejap tidak dikira masalah
    const t0 = Date.now();
    try { const r = await fetch(url, {...opt, signal: AbortSignal.timeout(15000)}); const ms = Date.now() - t0; last = {ok: r.status < 500, status: r.status, ms}; if (last.ok && ms < 8000) return last; }
    catch (e) { last = {ok: false, err: e.name || 'Error', ms: Date.now() - t0}; }
    await new Promise(r => setTimeout(r, 3000));
  }
  return last;
}
async function runHealth(src) {
  const now = myNow(), issues = [], checks = {};
  const add = (k, pub, lv, msg, en) => issues.push({k, pub, lv, msg, en});
  // 1) Laman app
  for (const [url, k, bm, en] of [['https://prosewa.web.app/index.html', 'site', 'Laman owner (prosewa.web.app)', 'Owner site (prosewa.web.app)'], ['https://prosewa.web.app/penyewa.html', 'site_t', 'Laman penyewa', 'Tenant site']]) {
    const r = await timed(url + '?t=' + Date.now()); checks[k] = r;
    if (!r.ok) add(k, true, 'down', `${bm}: tidak dapat dibuka (${r.status || r.err}).`, `${en}: could not be opened (${r.status || r.err}).`);
    else if (r.ms > 8000) add(k + '_slow', true, 'warn', `${bm}: perlahan (${(r.ms / 1000).toFixed(1)}s).`, `${en}: slow (${(r.ms / 1000).toFixed(1)}s).`);
  }
  // 2) Database
  try { const t0 = Date.now(); await db.doc('health/ping').set({at: now, src}); await db.doc('health/ping').get(); checks.db = {ok: true, ms: Date.now() - t0}; }
  catch (e) { checks.db = {ok: false, err: String(e.message || e).slice(0, 120)}; add('db', true, 'down', `Database tidak dapat ditulis/dibaca: ${checks.db.err}`, `Database cannot be written/read: ${checks.db.err}`); }
  const prev = (await db.doc('health/admin').get().catch(() => null))?.data() || {};
  // 3) Penjadual notifikasi (prosewaPushTick setiap 15 minit)
  checks.lastTick = prev.lastTick || '';
  if (!prev.lastTick || mins(prev.lastTick, now) > 40) add('tick', true, 'warn', `Penjadual notifikasi tidak berjalan sejak ${prev.lastTick ? Math.round(mins(prev.lastTick, now)) + ' minit' : '(tiada rekod)'}. Peringatan sewa mungkin lewat.`, `The notification scheduler has not run since ${prev.lastTick ? Math.round(mins(prev.lastTick, now)) + ' minutes' : '(no record)'}. Rent reminders may be late.`);
  // 4) Push notification (sejak semakan lepas)
  const ps = prev.push || {}, sent = +ps.sent || 0, fail = +ps.fail || 0; checks.push = {sent, fail};
  if (fail >= 5 && fail > sent) add('push', false, 'warn', `Push notification banyak gagal: ${fail} gagal, ${sent} berjaya (30 minit lepas).`, `Many push notifications failed: ${fail} failed, ${sent} sent (last 30 min).`);
  // 5) ToyyibPay (bayaran langganan)
  const tp = await timed('https://toyyibpay.com/'); checks.toyyib = tp;
  if (!tp.ok) add('toyyib', false, 'warn', `ToyyibPay tidak dapat dibuka (${tp.status || tp.err}). Owner mungkin tidak dapat bayar langganan.`, `ToyyibPay could not be opened (${tp.status || tp.err}). Owners may not be able to pay for subscriptions.`);
  // 6) Ralat function & app (30 minit lepas)
  const since = new Date(Date.now() + 8 * 3600e3 - 30 * 6e4).toISOString().slice(0, 16);
  const errs = (await db.collection('sysErrors').where('at', '>=', since).get().catch(() => null))?.docs.map(d => d.data()) || [];
  const fe = errs.filter(e => e.src === 'fn').length, ce = errs.filter(e => e.src === 'web' || e.src === 'apk').length; checks.errors = {fn: fe, app: ce};
  if (fe >= 3) add('fn_err', false, 'warn', `${fe} ralat function dalam 30 minit lepas. Lihat senarai ralat di bawah.`, `${fe} function errors in the last 30 minutes. See the error list below.`);
  if (ce >= 10) add('app_err', false, 'warn', `${ce} ralat dari app pengguna dalam 30 minit lepas.`, `${ce} errors from users' apps in the last 30 minutes.`);
  // 7) Bayaran langganan gagal disahkan (24 jam)
  const d24 = new Date(Date.now() - 864e5);
  const failed = (await db.collection('subOrders').where('status', '==', 'failed').get().catch(() => null))?.docs.filter(d => (d.data().updatedAt?.toDate?.() || 0) >= d24).length || 0; checks.subFailed = failed;
  if (failed) add('sub_fail', false, 'warn', `${failed} bayaran langganan ToyyibPay tidak berjaya disahkan dalam 24 jam lepas. Semak subOrders.`, `${failed} ToyyibPay subscription payment(s) could not be verified in the last 24 hours. Check subOrders.`);

  const pubLevel = issues.filter(i => i.pub).reduce((m, i) => LV[i.lv] > LV[m] ? i.lv : m, 'ok');
  const level = issues.reduce((m, i) => LV[i.lv] > LV[m] ? i.lv : m, 'ok');
  await db.doc('config/status').set({level: pubLevel, at: now}, {merge: true});
  const out = {level, pubLevel, at: now, src, issues, checks, push: {sent: 0, fail: 0}};
  // amaran kepada Super Admin bila tahap berubah (bermula / pulih)
  const was = prev.alertLevel || 'ok';
  if (level !== was) {
    const sum = issues.map(i => i.msg).join(' · ').slice(0, 200), sumEn = issues.map(i => i.en).join(' · ').slice(0, 200);
    await toOwner(SUPER_UID, l => level === 'ok' ? (l === 'en' ? {title: '🟢 ProSewa recovered', body: 'All systems are back to normal.'} : {title: '🟢 Sistem ProSewa pulih', body: 'Semua sistem kembali normal.'})
      : (l === 'en' ? {title: level === 'down' ? '🔴 ProSewa disruption' : '🟠 ProSewa warning', body: sumEn} : {title: level === 'down' ? '🔴 Gangguan sistem ProSewa' : '🟠 Amaran sistem ProSewa', body: sum})).catch(() => {});
    out.alertLevel = level; out.lastAlert = now;
  }
  await db.doc('health/admin').set(out, {merge: true});
  return out;
}
exports.prosewaHealth = onSchedule({schedule: 'every 30 minutes', region: REGION, timeZone: 'Asia/Kuala_Lumpur'}, async () => { try { await runHealth('auto'); } catch (e) { console.error(e); await logErr('prosewaHealth', e); } });

exports.prosewaHealthNow = onRequest({region: REGION}, async (req, res) => {
  if (cors(req, res)) return;
  try {
    const user = await getAuth().verifyIdToken((req.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
    if (user.uid !== SUPER_UID) return res.status(403).json({error: 'Super Admin sahaja.'});
    if ((req.body || {}).test) {
      const n = await toOwner(SUPER_UID, l => l === 'en' ? {title: '🧪 ProSewa test alert', body: 'The system alarm is working. You will be notified here if there is a problem.'} : {title: '🧪 Amaran ujian ProSewa', body: 'Sistem amaran berfungsi. Anda akan dimaklumkan di sini jika berlaku masalah.'});
      return res.json({sent: n});
    }
    const delUid = (req.body || {}).deleteOwner;
    if (delUid) {   // padam owner TIDAK AKTIF & semua datanya (subPayments dikekalkan untuk laporan kewangan)
      const uid = String(delUid).slice(0, 128);
      if (uid === SUPER_UID) return res.status(400).json({error: 'Tidak boleh padam akaun Super Admin.'});
      const sub = (await db.doc(`subs/${uid}`).get()).data();
      let endD = sub && sub.plan !== 'trial' ? sub.end : null;
      if (sub && sub.plan === 'trial') sub.start = sub.start || (sub.startTs && sub.startTs.toDate ? sub.startTs.toDate().toISOString().slice(0, 10) : '');
      if (sub && !endD && sub.start) { const td = +(((await db.doc('config/app').get()).data() || {}).trialDays ?? 14); const d = new Date(sub.start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + td); endD = d.toISOString().slice(0, 10); }
      if (endD && endD >= myNow().slice(0, 10)) return res.status(400).json({error: 'Owner masih aktif. Tamatkan langganan dahulu.'});
      let n = 0;
      const ten = await db.collection('tenants').where('ownerId', '==', uid).get();
      for (const t of ten.docs) { await db.recursiveDelete(t.ref); n++; }
      for (const col of ['expenses', 'properties', 'recurring']) { const q = await db.collection(col).where('ownerId', '==', uid).get(); for (const d of q.docs) { await d.ref.delete(); n++; } }
      for (const [col, f] of [['devices', 'uid'], ['subOrders', 'uid']]) { const q = await db.collection(col).where(f, '==', uid).get(); for (const d of q.docs) { await d.ref.delete(); n++; } }
      for (const path of [`owners/${uid}`, `ownerPriv/${uid}`, `subs/${uid}`]) { await db.doc(path).delete().catch(() => {}); n++; }
      await getAuth().deleteUser(uid).catch(e => console.warn('deleteUser', e.message));
      return res.json({ok: true, docs: n});
    }
    const dg = (req.body || {}).diag;
    if (dg) {   // diagnostik owner tertentu (Super Admin): peranti push & pesanan ToyyibPay
      const uid = String(dg).slice(0, 128);
      const dev = await db.collection('devices').where('uid', '==', uid).get();
      const ord = await db.collection('subOrders').where('uid', '==', uid).get();
      const ten = await db.collection('tenants').where('ownerId', '==', uid).get();
      let tdev = 0; for (const t of ten.docs.filter(d => d.data().active !== false)) tdev += (await db.collection('devices').where('tok', '==', t.id).count().get()).data().count;
      return res.json({devices: dev.docs.map(d => ({platform: d.data().platform, at: d.data().at, lang: d.data().lang})), tenantDevices: tdev,
        orders: ord.docs.map(d => { const o = d.data(); return {status: o.status, amount: o.amount, plan: o.plan, billCode: o.billCode, at: o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString() : ''}; }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10)});
    }
    return res.json(await runHealth('manual'));
  } catch (e) { console.error(e); return res.status(500).json({error: 'Ralat pelayan. Cuba lagi.'}); }
});

exports.prosewaOnReport = onDocumentCreated({document: 'sysErrors/{id}', database: 'prosewa', region: DB_REGION}, async ev => {
  const r = ev.data.data(); if (!r || r.src !== 'report') return;
  await pushTo('uid', SUPER_UID, l => ({title: l === 'en' ? '📮 Problem report from user' : '📮 Laporan masalah daripada pengguna', body: `${r.who || ''}${r.where ? ' · ' + r.where : ''}: ${String(r.msg || '').slice(0, 200)}`}), 'https://prosewa.web.app/index.html#super');
});
