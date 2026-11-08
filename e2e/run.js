// End-to-end: real server (fake Square), a customer phone and a staff tablet in two browsers.
// Usage: npm run e2e   (screenshots land in e2e/shots/)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`, DB = 'data/e2e.db';
const env = { ...process.env, GATEWAY: 'fake', PORT: String(PORT), DB_PATH: DB, INSECURE_COOKIES: '1', LOG_LEVEL: 'warn' };
rmSync('data/e2e.db', { force: true }); rmSync('data/e2e.db-wal', { force: true }); rmSync('data/e2e.db-shm', { force: true });
mkdirSync('e2e/shots', { recursive: true });
execFileSync('node', ['scripts/add-staff.js', '--email', 'runner@kerbside.test', '--name', 'Runner'], { env: { ...env, STAFF_PASSWORD: 'correct horse battery' } });

const server = spawn('node', ['src/index.js'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const results = [];
const check = (cond, name) => { results.push([Boolean(cond), name]); if (!cond) console.log('FAIL', name); };
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/locations'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  browser = await chromium.launch();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const tablet = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  for (const p of [phone, tablet]) p.on('pageerror', (e) => errors.push(e.message));

  // Staff signs in
  await tablet.goto(BASE + '/staff');
  await tablet.fill('#email', 'runner@kerbside.test');
  await tablet.fill('#password', 'wrong password');
  await tablet.click('#login button[type=submit]');
  await tablet.waitForSelector('#loginErr:not(:empty)');
  check((await tablet.textContent('#loginErr')).includes("don't match"), 'wrong password is refused');
  await tablet.fill('#password', 'correct horse battery');
  await tablet.click('#login button[type=submit]');
  await tablet.waitForSelector('#board:not([hidden])');
  check(true, 'staff signs in');

  // Customer builds a bag
  await phone.goto(BASE + '/');
  await phone.waitForSelector('.item');
  check(await phone.isVisible('#testBanner'), 'test-mode banner is shown');
  await phone.click('[data-item="IT_OG"]');
  await phone.check('input[value="MOD_BIGCUP"]');
  await phone.click('#addBtn');
  await phone.click('#barBtn');
  check((await phone.textContent('#barBtn')).includes('$30.00'), 'bag total includes Big Cup Sauce ($30)');
  await phone.screenshot({ path: 'e2e/shots/1-bag.png', fullPage: true });

  // Validation, then a declined card, then success
  await phone.click('#barBtn');
  check((await phone.textContent('#err')).includes('name'), 'asks for a name first');
  await phone.fill('#name', 'Mick');
  await phone.fill('#phone', '0412 345 678');
  await phone.fill('#car', 'White Toyota RAV4, DXN 42K');
  await phone.click('[data-testcard="cnon:card-nonce-declined"]');
  await phone.click('#barBtn');
  await phone.waitForFunction(() => document.querySelector('#err')?.textContent.includes('declined'));
  check(true, 'declined card shows a clear message');
  await phone.click('[data-testcard="cnon:card-nonce-ok"]');
  await phone.click('#barBtn');
  await phone.waitForSelector('.hero');
  check((await phone.textContent('.hero')).includes('Kitchen is ready when you are'), 'held order shows "waiting for you"');
  await phone.screenshot({ path: 'e2e/shots/2-held.png', fullPage: true });

  // Staff sees it held, live
  await tablet.waitForSelector('.ticket.held');
  check((await tablet.textContent('.ticket.held')).includes('White Toyota RAV4'), 'staff sees held order with car details');
  check((await tablet.textContent('.ticket.held')).includes('Big Cup Sauce'), 'staff ticket shows the options chosen');

  // Customer leaves; staff sees it cooking
  await phone.click('[data-leave="10"]');
  await tablet.waitForSelector('.ticket.cooking');
  check((await tablet.textContent('.ticket.cooking')).includes('Arriving in about 10 min'), 'staff sees cooking with ETA');
  await phone.waitForFunction(() => document.querySelector('.hero h1')?.textContent.includes('Cooking'));
  check(true, 'customer sees cooking');

  // Staff marks ready; customer arrives at bay 3
  await tablet.click('.ticket.cooking button[data-to="ready"]');
  await phone.waitForFunction(() => document.querySelector('.hero h1')?.textContent.includes('Ready'));
  check(true, 'customer sees ready live');
  await phone.fill('#bay', '3');
  await phone.click('[data-act="arrived"]');
  await tablet.waitForSelector('.ticket.arrived');
  check((await tablet.textContent('.ticket.arrived')).includes('Bay 3'), 'staff sees the car waiting in bay 3');
  await tablet.screenshot({ path: 'e2e/shots/3-staff-arrived.png' });

  // Hand over; customer gets points
  await tablet.click('.ticket.arrived button[data-to="handed_over"]');
  await phone.waitForFunction(() => document.body.textContent.includes('Kerbside Club points'));
  check((await phone.textContent('main')).includes('+150 Kerbside Club points'), 'customer sees +150 points');
  await phone.screenshot({ path: 'e2e/shots/4-done.png', fullPage: true });
  await tablet.waitForFunction(() => !document.querySelector('.ticket'));
  check(true, 'ticket leaves the staff board');

  // Sold out reaches the customer menu
  await tablet.click('#availBtn');
  await tablet.check('input[data-sold="IT_RODEO"]');
  await phone.click('[data-act="new"]');
  await phone.click('[data-cat="Burgers"]');
  await phone.waitForSelector('[data-item="IT_RODEO"][aria-disabled="true"]');
  check((await phone.textContent('[data-item="IT_RODEO"]')).includes('Sold out today'), 'sold-out item shows on the customer menu');
  await phone.screenshot({ path: 'e2e/shots/5-sold-out.png', fullPage: true });

  check(errors.length === 0, `no browser errors (${errors.join('; ')})`);
} catch (e) {
  check(false, `crashed: ${e.message.split('\n')[0]}`);
} finally {
  await browser?.close();
  server.kill();
}
const failed = results.filter(([ok]) => !ok);
console.log(`\ne2e: ${results.length - failed.length}/${results.length} checks passed`);
for (const [, n] of failed) console.log(' - FAILED:', n);
process.exit(failed.length ? 1 : 0);
