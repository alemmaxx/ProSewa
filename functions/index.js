/**
 * ProSewa — Cloud Functions untuk bayaran langganan ToyyibPay
 * Projek: kukusanmy · Database Firestore: "prosewa" · Region: asia-southeast1
 *
 * prosewaCreateBill  : owner (log masuk) minta bil → pulangkan billCode ToyyibPay
 * prosewaCallback    : ToyyibPay panggil selepas bayar → sahkan → aktifkan langganan
 * prosewaRedeemPromo : owner guna kod promo (sekali guna) → tambah hari langganan
 * prosewaOnPayment   : bukti bayaran baru / lulus / tolak → push notification
 * prosewaOnReminder  : mesej owner → push kepada penyewa
 * prosewaPushTick    : setiap 15 minit → peringatan berjadual, tarikh bayar, tunggakan, kontrak tamat
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
      billChargeToCustomer: ''
    });
    const r = await fetch(`${TP}/index.php/api/createBill`, {method: 'POST', body: form});
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch (e) { j = null; }
    const billCode = Array.isArray(j) && j[0] && j[0].BillCode;
    if (!billCode) { console.error('createBill gagal', txt); return res.status(502).json({error: 'ToyyibPay menolak permintaan bil.'}); }

    await orderRef.set({uid: user.uid, plan: plan.id, months: plan.months, amount: plan.price, billCode, status: 'pending', createdAt: FieldValue.serverTimestamp()});
    return res.json({billCode, url: `${TP}/${billCode}`});
  } catch (e) {
    console.error(e);
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
    console.error(e);
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
    } catch (e) { console.error('tick', tok, e); }
  }
});
