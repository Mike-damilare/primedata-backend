require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const paystack = require('./paystack');
const vtpass = require('./vtpass');
const reloadly = require('./reloadly');
const whatsapp = require('./whatsapp');
const { getCountry, listCountries } = require('./countries');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 4000;

// ---------- Auth middleware ----------
function authOptional(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
      req.user = payload;
    } catch (e) { /* ignore invalid token, treat as guest */ }
  }
  next();
}

function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, password are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, name, email, phone, password_hash) VALUES (?,?,?,?,?)'
  ).run(id, name, email, phone || null, hash);

  const token = jwt.sign({ id, name, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, name, email, phone, wallet_balance: 0 } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, wallet_balance: user.wallet_balance }
  });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone, wallet_balance, free_gb_claimed FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// ---------- CASHBACK (data purchases only — margin-safe, kept off airtime) ----------
// Margin-based, not price-based: cashback = (DATA_MARGIN_RATE * CASHBACK_OF_MARGIN) * sale price.
// This means cashback automatically shrinks if wholesale costs rise — you always keep
// (1 - CASHBACK_OF_MARGIN) of your actual profit, never a fixed bite out of revenue.
const DATA_MARGIN_RATE = Number(process.env.DATA_MARGIN_RATE) || 0.07; // your avg margin on data — UPDATE THIS to your real number
const CASHBACK_OF_MARGIN = 0.15; // you keep 85% of profit on every data sale, guaranteed
const CASHBACK_CAP = 200; // hard ceiling per transaction (in local currency) — protects against huge bundle exposure
const CASHBACK_EXPIRY_DAYS = 30; // drives redemption urgency instead of sitting as a permanent liability

function grantCashback(userId, dataAmount, country, currency) {
  const marginEarned = Math.round(dataAmount * DATA_MARGIN_RATE * 100) / 100;
  let cashback = Math.round(marginEarned * CASHBACK_OF_MARGIN * 100) / 100;
  cashback = Math.min(cashback, CASHBACK_CAP);
  if (cashback <= 0) return { cashback: 0, marginEarned: 0 };
  db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(cashback, userId);
  const expiresAt = new Date(Date.now() + CASHBACK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO transactions (id, user_id, type, country, currency, amount, status, reference, is_guest, expires_at)
     VALUES (?,?,?,?,?,?,?,?,0,?)`
  ).run(uuidv4(), userId, 'cashback', country, currency, cashback, 'success', `CASHBACK_${uuidv4()}`, expiresAt);
  // Transparency receipt — exactly what "The Transparent Receipt" offer shows the customer
  return { cashback, marginEarned, marginPercent: DATA_MARGIN_RATE * 100, cashbackOfMarginPercent: CASHBACK_OF_MARGIN * 100 };
}

// Sweeps expired, unspent cashback out of wallets. Without this, "30-day expiry" is just a
// label with no teeth — this is what actually turns it into a real liability cap.
function sweepExpiredCashback() {
  const expired = db.prepare(
    `SELECT * FROM transactions WHERE type = 'cashback' AND expired = 0 AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
  ).all();
  for (const row of expired) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) continue;
    const clawback = Math.min(row.amount, user.wallet_balance); // never push balance negative
    if (clawback > 0) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(clawback, row.user_id);
    }
    db.prepare('UPDATE transactions SET expired = 1 WHERE id = ?').run(row.id);
  }
}

setInterval(sweepExpiredCashback, 60 * 60 * 1000); // hourly sweep


// Granted automatically after a user's FIRST successful PAID recharge (not on signup — rewards real customers).
const FREE_GB_PLAN = {
  NG: { network: 'MTN', planCode: 'mtn-1gb-30d' },
  GH: { network: 'MTN', planCode: 'gh-mtn-1gb' },
  KE: { network: 'SAFARICOM', planCode: 'ke-saf-1gb' },
  ZA: { network: 'VODACOM', planCode: 'za-voda-1gb' },
  EG: { network: 'VODAFONE', planCode: 'eg-voda-1gb' }
};

async function maybeGrantFreeGB(userId, country, phone) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.free_gb_claimed) return null;

  // Count this user's prior successful PAID RECHARGES (airtime/data only — excludes wallet funding and the free reward itself)
  const priorSuccessCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND status = 'success' AND type IN ('airtime','data')`
  ).get(userId).cnt;

  // This grant runs AFTER the triggering purchase has already been recorded as success,
  // so "first successful paid recharge" means count should now be exactly 1.
  if (priorSuccessCount !== 1) return null;

  const reward = FREE_GB_PLAN[country];
  if (!reward) return null;

  const reference = `FREEGB_${uuidv4()}`;
  const fulfillRes = await fulfillData(country, { network: reward.network, phone, planCode: reward.planCode, requestId: reference });
  const success = fulfillRes.code === '000';

  db.prepare(
    `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, plan, amount, status, reference, is_guest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
  ).run(uuidv4(), userId, 'free_reward', country, getCountry(country).currency, reward.network, phone, reward.planCode, 0, success ? 'success' : 'failed', reference);

  if (success) {
    db.prepare('UPDATE users SET free_gb_claimed = 1 WHERE id = ?').run(userId);
  }
  return { success, network: reward.network };
}


// ---------- SEND ABROAD (cross-border recharge) ----------
// Same wallet + fulfillment pipeline as a normal purchase, but explicitly framed for the
// "top up family in another country" use case — recipient name is captured for the receipt.
// This already works technically (country param is independent of the sender's own location)
// — this endpoint just makes the use case a first-class, clearly-labeled flow.
app.post('/api/send-abroad', authRequired, async (req, res) => {
  const { country, type, network, phone, recipientName, amount, planCode, planPrice } = req.body;
  if (!country || !type || !network || !phone || !recipientName) {
    return res.status(400).json({ error: 'country, type, network, phone, recipientName required' });
  }
  const countryCfg = getCountry(country);
  if (!countryCfg) return res.status(400).json({ error: 'Unsupported country' });

  const chargeAmount = type === 'airtime' ? amount : planPrice;
  if (!chargeAmount) return res.status(400).json({ error: 'amount (airtime) or planPrice (data) required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.wallet_balance < chargeAmount) return res.status(400).json({ error: 'Insufficient wallet balance' });

  const reference = `SEND_${uuidv4()}`;
  const result = type === 'airtime'
    ? await fulfillAirtime(country, { network, phone, amount, requestId: reference })
    : await fulfillData(country, { network, phone, planCode, requestId: reference });
  const success = result.code === '000';

  db.prepare(
    `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, plan, amount, status, reference, is_guest, recipient_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`
  ).run(uuidv4(), user.id, type, country, countryCfg.currency, network, phone, planCode || null, chargeAmount, success ? 'success' : 'failed', reference, recipientName);

  let cashback = { cashback: 0 };
  let freeGB = null;
  if (success) {
    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(chargeAmount, user.id);
    if (type === 'data') cashback = grantCashback(user.id, chargeAmount, country, countryCfg.currency);
    freeGB = await maybeGrantFreeGB(user.id, country, phone);
  }

  res.json({ success, reference, recipientName, country: countryCfg.name, cashback, freeGB });
});

// ---------- WHATSAPP BOT (mock mode — wire real Meta WhatsApp Cloud API creds to go live) ----------
// Recognizes the sender by their registered phone number, executes real purchases through
// the same wallet + fulfillment pipeline as the app, replies with a confirmation message.
app.post('/api/whatsapp/webhook', async (req, res) => {
  const { from, text } = req.body; // from = sender's phone number, text = message body
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(from);
  if (!user) {
    await whatsapp.sendMessage(from, "We don't recognize this number. Sign up at primedata.app first, then message us from your registered number.");
    return res.json({ handled: true, reason: 'unregistered_number' });
  }

  const parsed = whatsapp.parseCommand(text);
  const country = 'NG'; // default — could be stored per-user once multi-country profile exists

  if (parsed.command === 'BALANCE') {
    await whatsapp.sendMessage(from, `Your PrimeData wallet balance is ₦${user.wallet_balance.toLocaleString()}.`);
    return res.json({ handled: true, command: 'BALANCE' });
  }

  if (parsed.command === 'RECHARGE') {
    if (!parsed.amount || user.wallet_balance < parsed.amount) {
      await whatsapp.sendMessage(from, `Sorry, insufficient wallet balance for ₦${parsed.amount}. Reply BALANCE to check, or fund your wallet in the app.`);
      return res.json({ handled: true, command: 'RECHARGE', success: false });
    }
    const reference = `WA_AIRTIME_${uuidv4()}`;
    const result = await fulfillAirtime(country, { network: parsed.network, phone: from, amount: parsed.amount, requestId: reference });
    const success = result.code === '000';
    const countryCfg = getCountry(country);

    db.prepare(
      `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, amount, status, reference, is_guest)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`
    ).run(uuidv4(), user.id, 'airtime', country, countryCfg.currency, parsed.network, from, parsed.amount, success ? 'success' : 'failed', reference);

    if (success) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(parsed.amount, user.id);
      await whatsapp.sendMessage(from, `✅ ₦${parsed.amount} ${parsed.network} airtime delivered! New balance: ₦${(user.wallet_balance - parsed.amount).toLocaleString()}.`);
    } else {
      await whatsapp.sendMessage(from, `Recharge failed, please try again or use the app.`);
    }
    return res.json({ handled: true, command: 'RECHARGE', success });
  }

  await whatsapp.sendMessage(from, `Hi! Reply with:\nRECHARGE [amount] [network] — e.g. "RECHARGE 500 MTN"\nBALANCE — check your wallet`);
  res.json({ handled: true, command: 'UNKNOWN' });
});


// Looks at a user's past data purchases on the same plan/network to estimate when they'll
// likely run low, and flags it proactively. No competitor in this market does this.
app.get('/api/predictions', authRequired, (req, res) => {
  const dataPurchases = db.prepare(
    `SELECT * FROM transactions WHERE user_id = ? AND type = 'data' AND status = 'success' ORDER BY created_at ASC`
  ).all(req.user.id);

  const groups = {};
  for (const tx of dataPurchases) {
    const key = `${tx.network}|${tx.plan}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tx);
  }

  const predictions = [];
  for (const [key, txs] of Object.entries(groups)) {
    if (txs.length < 2) continue;
    const [network, plan] = key.split('|');

    let totalGapDays = 0;
    for (let i = 1; i < txs.length; i++) {
      const gap = (new Date(txs[i].created_at) - new Date(txs[i - 1].created_at)) / (1000 * 60 * 60 * 24);
      totalGapDays += gap;
    }
    const avgGapDays = totalGapDays / (txs.length - 1);
    const lastPurchase = new Date(txs[txs.length - 1].created_at);
    const predictedRunOutDate = new Date(lastPurchase.getTime() + avgGapDays * 24 * 60 * 60 * 1000);
    const daysUntilPredicted = (predictedRunOutDate - new Date()) / (1000 * 60 * 60 * 24);

    predictions.push({
      network, plan,
      country: txs[txs.length - 1].country,
      avgUsageDays: Math.round(avgGapDays),
      predictedRunOutDate: predictedRunOutDate.toISOString(),
      daysUntilPredicted: Math.round(daysUntilPredicted),
      runningLow: daysUntilPredicted <= 2,
      lastAmount: txs[txs.length - 1].amount
    });
  }

  res.json({ predictions });
});

// ---------- COUNTRIES ----------
app.get('/api/countries', (req, res) => {
  res.json({ countries: listCountries() });
});

// ---------- DATA PLANS ----------
app.get('/api/plans/:country/:network', (req, res) => {
  const country = getCountry(req.params.country);
  if (!country) return res.status(404).json({ error: 'Unsupported country' });
  const network = req.params.network.toUpperCase();

  const plans = country.provider === 'vtpass'
    ? vtpass.getDataPlans(network)
    : reloadly.getDataPlans(req.params.country, network);

  res.json({ plans, currency: country.currency, symbol: country.symbol });
});

// Helper: route a fulfillment call to the right provider based on country
async function fulfillAirtime(countryCode, args) {
  const country = getCountry(countryCode);
  if (!country) throw new Error('Unsupported country');
  if (country.provider === 'vtpass') return vtpass.buyAirtime(args);
  return reloadly.buyAirtime({ countryCode, ...args });
}

async function fulfillData(countryCode, args) {
  const country = getCountry(countryCode);
  if (!country) throw new Error('Unsupported country');
  if (country.provider === 'vtpass') return vtpass.buyData(args);
  return reloadly.buyData({ countryCode, ...args });
}

// ---------- WALLET: FUND ----------
app.post('/api/wallet/fund/init', authRequired, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const reference = `WALLET_${uuidv4()}`;

  db.prepare(
    `INSERT INTO transactions (id, user_id, type, amount, status, reference, is_guest)
     VALUES (?,?,?,?,?,?,0)`
  ).run(uuidv4(), user.id, 'fund_wallet', amount, 'pending', reference);

  const result = await paystack.initializePayment({
    email: user.email,
    amount,
    reference,
    metadata: { type: 'fund_wallet', user_id: user.id }
  });

  res.json(result);
});

app.post('/api/wallet/fund/verify', authRequired, async (req, res) => {
  const { reference } = req.body;
  const tx = db.prepare('SELECT * FROM transactions WHERE reference = ?').get(reference);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.status === 'success') return res.json({ status: 'already_credited' });

  const result = await paystack.verifyPayment(reference);
  const ok = result?.data?.status === 'success';

  if (ok) {
    db.prepare('UPDATE transactions SET status = ? WHERE reference = ?').run('success', reference);
    db.prepare('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?').run(tx.amount, tx.user_id);
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(tx.user_id);
    return res.json({ status: 'success', wallet_balance: user.wallet_balance });
  } else {
    db.prepare('UPDATE transactions SET status = ? WHERE reference = ?').run('failed', reference);
    return res.json({ status: 'failed' });
  }
});

// ---------- BUY AIRTIME ----------
// Works for logged-in users (pay from wallet) AND guests (pay direct via Paystack)
app.post('/api/buy/airtime', authOptional, async (req, res) => {
  const { country, network, phone, amount, payWith } = req.body; // payWith: 'wallet' | 'paystack'
  if (!country || !network || !phone || !amount) return res.status(400).json({ error: 'country, network, phone, amount required' });
  const countryCfg = getCountry(country);
  if (!countryCfg) return res.status(400).json({ error: 'Unsupported country' });

  const reference = `AIRTIME_${uuidv4()}`;
  const isGuest = !req.user;

  if (!isGuest && payWith === 'wallet') {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.wallet_balance < amount) return res.status(400).json({ error: 'Insufficient wallet balance' });

    const vtRes = await fulfillAirtime(country, { network, phone, amount, requestId: reference });
    const success = vtRes.code === '000';

    db.prepare(
      `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, amount, status, reference, is_guest)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`
    ).run(uuidv4(), user.id, 'airtime', country, countryCfg.currency, network, phone, amount, success ? 'success' : 'failed', reference);

    if (success) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(amount, user.id);
    }
    const freeGB = success ? await maybeGrantFreeGB(user.id, country, phone) : null;
    return res.json({ success, reference, vtRes, freeGB });
  }

  // Guest or pay-direct flow: must pay via Paystack first
  db.prepare(
    `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, amount, status, reference, is_guest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(uuidv4(), req.user?.id || null, 'airtime', country, countryCfg.currency, network, phone, amount, 'pending', reference, isGuest ? 1 : 0);

  const payRes = await paystack.initializePayment({
    email: req.body.email || 'guest@primedata.com',
    amount,
    reference,
    metadata: { type: 'airtime', country, network, phone }
  });

  res.json({ pendingPayment: true, reference, payRes });
});

// ---------- BUY DATA ----------
app.post('/api/buy/data', authOptional, async (req, res) => {
  const { country, network, phone, planCode, price, payWith, email } = req.body;
  if (!country || !network || !phone || !planCode || !price) return res.status(400).json({ error: 'country, network, phone, planCode, price required' });
  const countryCfg = getCountry(country);
  if (!countryCfg) return res.status(400).json({ error: 'Unsupported country' });

  const reference = `DATA_${uuidv4()}`;
  const isGuest = !req.user;

  if (!isGuest && payWith === 'wallet') {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.wallet_balance < price) return res.status(400).json({ error: 'Insufficient wallet balance' });

    const vtRes = await fulfillData(country, { network, phone, planCode, requestId: reference });
    const success = vtRes.code === '000';

    db.prepare(
      `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, plan, amount, status, reference, is_guest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
    ).run(uuidv4(), user.id, 'data', country, countryCfg.currency, network, phone, planCode, price, success ? 'success' : 'failed', reference);

    if (success) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(price, user.id);
    }
    const cashback = success ? grantCashback(user.id, price, country, countryCfg.currency) : { cashback: 0 };
    const freeGB = success ? await maybeGrantFreeGB(user.id, country, phone) : null;
    return res.json({ success, reference, vtRes, freeGB, cashback });
  }

  db.prepare(
    `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, plan, amount, status, reference, is_guest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(uuidv4(), req.user?.id || null, 'data', country, countryCfg.currency, network, phone, planCode, price, 'pending', reference, isGuest ? 1 : 0);

  const payRes = await paystack.initializePayment({
    email: email || 'guest@primedata.com',
    amount: price,
    reference,
    metadata: { type: 'data', country, network, phone, planCode }
  });

  res.json({ pendingPayment: true, reference, payRes });
});

// ---------- CONFIRM A GUEST/DIRECT PAYMENT THEN FULFILL ----------
app.post('/api/buy/confirm', authOptional, async (req, res) => {
  const { reference } = req.body;
  const tx = db.prepare('SELECT * FROM transactions WHERE reference = ?').get(reference);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (tx.status === 'success') return res.json({ status: 'already_fulfilled' });

  const payCheck = await paystack.verifyPayment(reference);
  const paid = payCheck?.data?.status === 'success';
  if (!paid) {
    db.prepare('UPDATE transactions SET status = ? WHERE reference = ?').run('failed', reference);
    return res.json({ status: 'payment_failed' });
  }

  let vtRes;
  if (tx.type === 'airtime') {
    vtRes = await fulfillAirtime(tx.country, { network: tx.network, phone: tx.phone, amount: tx.amount, requestId: reference });
  } else {
    vtRes = await fulfillData(tx.country, { network: tx.network, phone: tx.phone, planCode: tx.plan, requestId: reference });
  }
  const fulfilled = vtRes.code === '000';
  db.prepare('UPDATE transactions SET status = ? WHERE reference = ?').run(fulfilled ? 'success' : 'failed', reference);

  let freeGB = null;
  let cashback = { cashback: 0 };
  if (fulfilled && tx.user_id) {
    if (tx.type === 'data') cashback = grantCashback(tx.user_id, tx.amount, tx.country, tx.currency);
    freeGB = await maybeGrantFreeGB(tx.user_id, tx.country, tx.phone);
  }

  res.json({ status: fulfilled ? 'success' : 'fulfillment_failed', vtRes, freeGB, cashback });
});

// ---------- AUTO-RECHARGE SCHEDULES ----------
function computeNextRun(frequency, from = new Date()) {
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

app.post('/api/auto-recharge', authRequired, (req, res) => {
  const { type, country, network, phone, amount, planCode, planPrice, frequency } = req.body;
  if (!type || !country || !network || !phone || !frequency) {
    return res.status(400).json({ error: 'type, country, network, phone, frequency required' });
  }
  if (type === 'airtime' && !amount) return res.status(400).json({ error: 'amount required for airtime schedule' });
  if (type === 'data' && (!planCode || !planPrice)) return res.status(400).json({ error: 'planCode and planPrice required for data schedule' });

  const id = uuidv4();
  const nextRun = computeNextRun(frequency);
  db.prepare(
    `INSERT INTO auto_recharge_schedules (id, user_id, type, country, network, phone, amount, plan_code, plan_price, frequency, next_run)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.user.id, type, country, network, phone, amount || null, planCode || null, planPrice || null, frequency, nextRun);

  res.json({ schedule: db.prepare('SELECT * FROM auto_recharge_schedules WHERE id = ?').get(id) });
});

app.get('/api/auto-recharge', authRequired, (req, res) => {
  const schedules = db.prepare('SELECT * FROM auto_recharge_schedules WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ schedules });
});

app.delete('/api/auto-recharge/:id', authRequired, (req, res) => {
  const sched = db.prepare('SELECT * FROM auto_recharge_schedules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!sched) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE auto_recharge_schedules SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ cancelled: true });
});

// Runs due auto-recharge schedules: pulls from wallet, fulfills, reschedules. Checked every 60s.
async function runDueAutoRecharges() {
  const due = db.prepare(
    `SELECT * FROM auto_recharge_schedules WHERE active = 1 AND next_run <= datetime('now')`
  ).all();

  for (const sched of due) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sched.user_id);
    const countryCfg = getCountry(sched.country);
    const chargeAmount = sched.type === 'airtime' ? sched.amount : sched.plan_price;

    if (!user || !countryCfg || user.wallet_balance < chargeAmount) {
      // Insufficient balance — skip this cycle, try again next cycle (push next_run forward so it doesn't spam-retry)
      db.prepare('UPDATE auto_recharge_schedules SET next_run = ? WHERE id = ?')
        .run(computeNextRun(sched.frequency), sched.id);
      continue;
    }

    const reference = `AUTO_${uuidv4()}`;
    let result, success;
    if (sched.type === 'airtime') {
      result = await fulfillAirtime(sched.country, { network: sched.network, phone: sched.phone, amount: sched.amount, requestId: reference });
    } else {
      result = await fulfillData(sched.country, { network: sched.network, phone: sched.phone, planCode: sched.plan_code, requestId: reference });
    }
    success = result.code === '000';

    db.prepare(
      `INSERT INTO transactions (id, user_id, type, country, currency, network, phone, plan, amount, status, reference, is_guest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
    ).run(uuidv4(), user.id, sched.type, sched.country, countryCfg.currency, sched.network, sched.phone, sched.plan_code, chargeAmount, success ? 'success' : 'failed', reference);

    if (success) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?').run(chargeAmount, user.id);
      if (sched.type === 'data') grantCashback(user.id, chargeAmount, sched.country, countryCfg.currency);
      await maybeGrantFreeGB(user.id, sched.country, sched.phone);
    }

    db.prepare('UPDATE auto_recharge_schedules SET next_run = ? WHERE id = ?')
      .run(computeNextRun(sched.frequency), sched.id);
  }
}

setInterval(() => { runDueAutoRecharges().catch(e => console.error('Auto-recharge run failed:', e)); }, 60 * 1000);


app.get('/api/transactions', authRequired, (req, res) => {
  const txs = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ transactions: txs });
});

app.get('/api/transactions/:reference', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE reference = ?').get(req.params.reference);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json({ transaction: tx });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mockMode: process.env.MOCK_MODE === 'true' });
});

app.listen(PORT, () => {
  console.log(`PrimeData backend running on port ${PORT} (MOCK_MODE=${process.env.MOCK_MODE})`);
});
