// Staff accounts and sessions. Passwords are scrypt-hashed; session tokens are random and only their
// SHA-256 hash is stored, so a leaked database does not expose live sessions.

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { nowIso } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

const sha = (t) => createHash('sha256').update(t).digest('hex');
// A real hash to compare against when the email doesn't exist, so timing doesn't reveal accounts.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export function createAuth({ db, sessionHours }) {
  const attempts = new Map(); // key -> { count, until }
  const LIMIT = 5, WINDOW_MS = 15 * 60_000;

  function addStaff({ email, name, role, password }) {
    if (!password || password.length < 12) throw new Error('Password must be at least 12 characters.');
    db.prepare('INSERT INTO staff (email, name, role, password_hash, created_at) VALUES (?,?,?,?,?)')
      .run(email.trim().toLowerCase(), name.trim(), role, hashPassword(password), nowIso());
  }

  function login(email, password, ip) {
    const key = `${String(email).toLowerCase()}|${ip}`;
    const a = attempts.get(key);
    if (a && a.count >= LIMIT && a.until > Date.now()) return { error: 'locked' };
    const staff = db.prepare('SELECT * FROM staff WHERE email = ?').get(String(email).trim().toLowerCase());
    const ok = verifyPassword(String(password), staff ? staff.password_hash : DUMMY_HASH) && Boolean(staff);
    if (!ok) {
      const next = a && a.until > Date.now() ? a.count + 1 : 1;
      attempts.set(key, { count: next, until: Date.now() + WINDOW_MS });
      return { error: 'invalid' };
    }
    attempts.delete(key);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + sessionHours * 3600_000).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?,?,?)').run(sha(token), staff.id, expires);
    return { token, staff: { id: staff.id, name: staff.name, role: staff.role, email: staff.email }, expires };
  }

  function sessionStaff(token) {
    if (!token) return null;
    const r = db.prepare(`SELECT s.id, s.name, s.role, s.email, x.expires_at FROM sessions x JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ?`).get(sha(token));
    if (!r) return null;
    if (r.expires_at <= nowIso()) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); return null; }
    return { id: r.id, name: r.name, role: r.role, email: r.email };
  }

  function logout(token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }

  return { addStaff, login, sessionStaff, logout };
}
