const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'vtu.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  wallet_balance REAL NOT NULL DEFAULT 0,
  free_gb_claimed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,           -- 'fund_wallet' | 'airtime' | 'data'
  country TEXT,                 -- NG, GH, KE, ZA, EG
  currency TEXT,                -- NGN, GHS, KES, ZAR, EGP
  network TEXT,                 -- MTN, GLO, AIRTEL, 9MOBILE, SAFARICOM, etc.
  phone TEXT,
  plan TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL,         -- 'pending' | 'success' | 'failed'
  reference TEXT UNIQUE NOT NULL,
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

// Lightweight migration for existing DBs created before country/currency columns existed.
try { db.exec(`ALTER TABLE transactions ADD COLUMN country TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN currency TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN free_gb_claimed INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN expires_at TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN expired INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN recipient_name TEXT`); } catch (e) {}

db.exec(`
CREATE TABLE IF NOT EXISTS auto_recharge_schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'airtime' | 'data'
  country TEXT NOT NULL,
  network TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount REAL,                    -- for airtime
  plan_code TEXT,                 -- for data
  plan_price REAL,                -- for data
  frequency TEXT NOT NULL,        -- 'daily' | 'weekly' | 'monthly'
  active INTEGER NOT NULL DEFAULT 1,
  next_run TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

module.exports = db;
