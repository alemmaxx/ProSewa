/**
 * ProSewa — Cloud Functions untuk bayaran langganan ToyyibPay
 * Projek: kukusanmy · Database Firestore: "prosewa" · Region: asia-southeast1
 *
 * prosewaCreateBill : owner (log masuk) minta bil → pulangkan billCode ToyyibPay
 * prosewaCallback   : ToyyibPay panggil selepas bayar → sahkan → aktifkan langganan
 *
 * Secret key ToyyibPay TIDAK ditulis dalam kod. Simpan sekali melalui CMD:
 *   firebase functions:secrets:set TOYYIBPAY_SECRET_KEY --project kukusanmy
 */
const {onRequest} = require('firebase-functions/v2/https');
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
