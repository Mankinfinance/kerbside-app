// SQLite storage using Node's built-in driver. Holds only what Square does not:
// kerbside state (held, arrived, bay), sold-out switches, staff logins and the points ledger.
// Square remains the record for menu, orders and payments.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,                 -- our id, public to the customer
  access_token TEXT NOT NULL,          -- secret the customer needs to view or act on the order
  location_id TEXT NOT NULL,
  square_order_id TEXT NOT NULL,
  square_payment_id TEXT NOT NULL,
  fulfillment_uid TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('kerbside','counter')),
  status TEXT NOT NULL CHECK (status IN ('held','cooking','ready','arrived','handed_over','cancelled')),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  car TEXT,
  bay TEXT,
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  eta_minutes INTEGER,
  created_at TEXT NOT NULL,
  hold_expires_at TEXT,
  released_at TEXT,
  arrived_at TEXT,
  handed_over_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_location_status ON orders(location_id, status);

CREATE TABLE IF NOT EXISTS sold_out (
  location_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (location_id, item_id)
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff','owner')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  order_id TEXT,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (order_id, reason)
);
CREATE INDEX IF NOT EXISTS points_phone ON points_ledger(phone);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();
