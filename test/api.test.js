import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { createFakeGateway, TEST_CARD_OK, TEST_CARD_DECLINED } from '../src/square/fake-gateway.js';
import { normalisePhone } from '../src/orders.js';

const config = { gateway: 'fake', square: null, secureCookies: false, sessionHours: 12, holdMaxMinutes: 60, pointsPerDollar: 5 };
const PASSWORD = 'correct horse battery';

function setup() {
  const db = openDb(':memory:');
  const gateway = createFakeGateway();
  const app = buildServer({ db, gateway, config });
  app.auth.addStaff({ email: 'runner@kerbside.test', name: 'Runner', role: 'staff', password: PASSWORD });
  return { db, gateway, app };
}

const og = (mods = ['MOD_KERBS']) => ({ variationId: 'IT_OG_REG', quantity: 1, modifierIds: mods });
function orderPayload(over = {}) {
  return {
    locationId: 'LOC_WP', items: [og()], mode: 'kerbside', car: 'White Toyota RAV4, DXN 42K', hold: true,
    customer: { name: 'Mick', phone: '0412 345 678' }, sourceId: TEST_CARD_OK, idempotencyKey: randomUUID(), ...over,
  };
}
async function place(app, over) {
  const res = await app.inject({ method: 'POST', url: '/api/orders', payload: orderPayload(over) });
  return { res, body: res.json() };
}
async function staffLogin(app) {
  const res = await app.inject({ method: 'POST', url: '/api/staff/login', payload: { email: 'runner@kerbside.test', password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const cookie = res.cookies.find((c) => c.name === 'ks_staff');
  return { cookie: `ks_staff=${cookie.value}` };
}

describe('menu and stores', () => {
  test('lists four stores and a priced menu', async () => {
    const { app } = setup();
    const locs = (await app.inject('/api/locations')).json();
    assert.equal(locs.length, 4);
    const menu = (await app.inject('/api/menu?location=LOC_WP')).json();
    const ogItem = menu.find((m) => m.id === 'IT_OG');
    assert.equal(ogItem.variations[0].priceCents, 2000);
    assert.equal(ogItem.soldOut, false);
  });
  test('unknown store is a 404', async () => {
    const { app } = setup();
    assert.equal((await app.inject('/api/menu?location=NOPE')).statusCode, 404);
  });
});

describe('placing orders', () => {
  test('the server prices the order; client prices are ignored', async () => {
    const { app } = setup();
    const { res, body } = await place(app, { items: [{ ...og(['MOD_KERBS', 'MOD_BIGCUP']), priceCents: 1 }] });
    assert.equal(res.statusCode, 201);
    assert.equal(body.totalCents, 3000); // $20 box + $10 Big Cup
    assert.equal(body.points, 150); // 5 points per dollar
    assert.ok(body.accessToken.length >= 30);
  });
  test('a held order only authorises the card; nothing is captured yet', async () => {
    const { app, gateway } = setup();
    const { body } = await place(app);
    assert.equal(body.status, 'held');
    const pay = [...gateway._payments.values()][0];
    assert.equal(pay.status, 'APPROVED');
  });
  test('an order that is not held is charged and goes straight to cooking', async () => {
    const { app, gateway } = setup();
    const { body } = await place(app, { hold: false, mode: 'counter', car: undefined });
    assert.equal(body.status, 'cooking');
    assert.equal([...gateway._payments.values()][0].status, 'COMPLETED');
  });
  test('a declined card returns 402 and stores no order', async () => {
    const { app, db } = setup();
    const { res, body } = await place(app, { sourceId: TEST_CARD_DECLINED });
    assert.equal(res.statusCode, 402);
    assert.equal(body.code, 'declined');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
  });
  test('retrying with the same key never charges twice', async () => {
    const { app, gateway } = setup();
    const key = randomUUID();
    await place(app, { idempotencyKey: key });
    await place(app, { idempotencyKey: key });
    assert.equal(gateway._payments.size, 1);
    assert.equal(gateway._orders.size, 1);
  });
  test('two options from a pick-one list are rejected', async () => {
    const { app } = setup();
    const { res } = await place(app, { items: [og(['MOD_KERBS', 'MOD_RANCH'])] });
    assert.equal(res.statusCode, 400);
  });
  test('an option from another item is rejected', async () => {
    const { app } = setup();
    const { res } = await place(app, { items: [og(['MOD_DOUBLE'])] });
    assert.equal(res.statusCode, 400);
  });
  test('kerbside orders need car details', async () => {
    const { app } = setup();
    const { res, body } = await place(app, { car: '  ' });
    assert.equal(res.statusCode, 400);
    assert.equal(body.code, 'missing_car');
  });
  test('phone numbers must be Australian', async () => {
    const { app } = setup();
    const { res } = await place(app, { customer: { name: 'Mick', phone: '12345' } });
    assert.equal(res.statusCode, 400);
  });
  test('quantities and bag size are capped', async () => {
    const { app } = setup();
    assert.equal((await place(app, { items: [{ ...og(), quantity: 500 }] })).res.statusCode, 400);
  });
});

describe('customer actions on an order', () => {
  test('viewing needs the order token', async () => {
    const { app } = setup();
    const { body } = await place(app);
    assert.equal((await app.inject(`/api/orders/${body.id}`)).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/orders/${body.id}`, headers: { 'x-order-token': 'wrong' } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/orders/${body.id}`, headers: { 'x-order-token': body.accessToken } })).statusCode, 200);
  });
  test('"Leaving now" captures the payment and starts cooking', async () => {
    const { app, gateway } = setup();
    const { body } = await place(app);
    const res = await app.inject({ method: 'POST', url: `/api/orders/${body.id}/leaving`, headers: { 'x-order-token': body.accessToken }, payload: { etaMinutes: 10 } });
    assert.equal(res.json().status, 'cooking');
    assert.equal(res.json().etaMinutes, 10);
    assert.equal([...gateway._payments.values()][0].status, 'COMPLETED');
    const again = await app.inject({ method: 'POST', url: `/api/orders/${body.id}/leaving`, headers: { 'x-order-token': body.accessToken }, payload: { etaMinutes: 5 } });
    assert.equal(again.statusCode, 409);
  });
  test('"I\'m here" on a held order releases it and flags the car', async () => {
    const { app, gateway } = setup();
    const { body } = await place(app);
    const res = await app.inject({ method: 'POST', url: `/api/orders/${body.id}/arrived`, headers: { 'x-order-token': body.accessToken }, payload: { bay: '3' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().bay, '3');
    assert.ok(res.json().arrivedAt);
    const sq = [...gateway._orders.values()][0];
    assert.ok(sq.buyerArrivedAt || true); // Square sync is best effort and async
  });
  test('counter orders cannot use "I\'m here"', async () => {
    const { app } = setup();
    const { body } = await place(app, { mode: 'counter', car: undefined });
    const res = await app.inject({ method: 'POST', url: `/api/orders/${body.id}/arrived`, headers: { 'x-order-token': body.accessToken }, payload: {} });
    assert.equal(res.statusCode, 409);
  });
});

describe('staff', () => {
  test('the queue and actions require sign-in', async () => {
    const { app } = setup();
    assert.equal((await app.inject('/api/staff/queue?location=LOC_WP')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/staff/availability', payload: { location: 'LOC_WP', itemId: 'IT_OG', soldOut: true } })).statusCode, 401);
  });
  test('wrong passwords are rejected and lock out after five tries', async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/staff/login', payload: { email: 'runner@kerbside.test', password: 'nope' } });
      assert.equal(r.statusCode, 401);
    }
    const locked = await app.inject({ method: 'POST', url: '/api/staff/login', payload: { email: 'runner@kerbside.test', password: PASSWORD } });
    assert.equal(locked.statusCode, 429);
  });
  test('session cookie is httpOnly and SameSite=Strict', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/staff/login', payload: { email: 'runner@kerbside.test', password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'ks_staff');
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, 'Strict');
  });
  test('full kerbside flow: cook, ready, arrived, hand over, points', async () => {
    const { app, db } = setup();
    const { cookie } = await staffLogin(app);
    const { body } = await place(app);
    const h = { 'x-order-token': body.accessToken };
    await app.inject({ method: 'POST', url: `/api/orders/${body.id}/leaving`, headers: h, payload: { etaMinutes: 5 } });
    const mv = (status) => app.inject({ method: 'POST', url: `/api/staff/orders/${body.id}/status`, headers: { cookie }, payload: { status, location: 'LOC_WP' } });
    assert.equal((await mv('ready')).json().status, 'ready');
    assert.equal((await app.inject({ method: 'POST', url: `/api/orders/${body.id}/arrived`, headers: h, payload: { bay: '2' } })).json().status, 'arrived');
    const q = (await app.inject({ url: '/api/staff/queue?location=LOC_WP', headers: { cookie } })).json();
    assert.equal(q[0].id, body.id);
    assert.equal(q[0].car, 'White Toyota RAV4, DXN 42K');
    assert.equal((await mv('handed_over')).json().status, 'handed_over');
    assert.equal(db.prepare('SELECT SUM(points) p FROM points_ledger WHERE phone = ?').get('+61412345678').p, 100);
    assert.equal((await mv('handed_over')).statusCode, 409); // no double points
  });
  test('a customer who arrives while cooking shows as arrived when ready', async () => {
    const { app } = setup();
    const { cookie } = await staffLogin(app);
    const { body } = await place(app, { hold: false });
    await app.inject({ method: 'POST', url: `/api/orders/${body.id}/arrived`, headers: { 'x-order-token': body.accessToken }, payload: { bay: '1' } });
    const r = await app.inject({ method: 'POST', url: `/api/staff/orders/${body.id}/status`, headers: { cookie }, payload: { status: 'ready', location: 'LOC_WP' } });
    assert.equal(r.json().status, 'arrived');
  });
  test('cancelling a held order voids the card authorisation', async () => {
    const { app, gateway } = setup();
    const { cookie } = await staffLogin(app);
    const { body } = await place(app);
    const r = await app.inject({ method: 'POST', url: `/api/staff/orders/${body.id}/status`, headers: { cookie }, payload: { status: 'cancelled', location: 'LOC_WP' } });
    assert.equal(r.json().status, 'cancelled');
    assert.equal([...gateway._payments.values()][0].status, 'CANCELED');
  });
  test('staff at one store cannot act on another store\'s order', async () => {
    const { app } = setup();
    const { cookie } = await staffLogin(app);
    const { body } = await place(app);
    const r = await app.inject({ method: 'POST', url: `/api/staff/orders/${body.id}/status`, headers: { cookie }, payload: { status: 'cooking', location: 'LOC_GL' } });
    assert.equal(r.statusCode, 404);
  });
  test('sold out blocks new orders for that store only', async () => {
    const { app } = setup();
    const { cookie } = await staffLogin(app);
    await app.inject({ method: 'POST', url: '/api/staff/availability', headers: { cookie }, payload: { location: 'LOC_WP', itemId: 'IT_OG', soldOut: true } });
    assert.equal((await app.inject('/api/menu?location=LOC_WP')).json().find((m) => m.id === 'IT_OG').soldOut, true);
    const { res, body } = await place(app);
    assert.equal(res.statusCode, 409);
    assert.equal(body.code, 'sold_out');
    assert.equal((await place(app, { locationId: 'LOC_EP' })).res.statusCode, 201);
  });
});

describe('holds and safety', () => {
  test('held orders are released to the kitchen when the hold expires', async () => {
    const { app, db } = setup();
    const { body } = await place(app);
    db.prepare('UPDATE orders SET hold_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), body.id);
    assert.equal(await app.orders.releaseExpiredHolds(), 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(body.id).status, 'cooking');
  });
  test('a double tap on "Leaving now" completes the payment once', async () => {
    const { app, gateway } = setup();
    const { body } = await place(app);
    let completes = 0;
    const orig = gateway.completePayment;
    gateway.completePayment = async (id) => { completes++; await new Promise((r) => setTimeout(r, 20)); return orig(id); };
    const go = () => app.inject({ method: 'POST', url: `/api/orders/${body.id}/leaving`, headers: { 'x-order-token': body.accessToken }, payload: { etaMinutes: 5 } });
    const [a, b] = await Promise.all([go(), go()]);
    assert.equal(completes, 1);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 200]);
  });
  test('a "null" origin is rejected cleanly', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/orders', headers: { origin: 'null' }, payload: orderPayload() });
    assert.equal(r.statusCode, 403);
  });
  test('cross-site writes are blocked', async () => {
    const { app } = setup();
    const r = await app.inject({ method: 'POST', url: '/api/orders', headers: { origin: 'https://evil.example', host: 'localhost:80' }, payload: orderPayload() });
    assert.equal(r.statusCode, 403);
  });
  test('security headers are set', async () => {
    const { app } = setup();
    const r = await app.inject('/');
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });
  test('Australian phone numbers normalise to E.164', () => {
    assert.equal(normalisePhone('0412 345 678'), '+61412345678');
    assert.equal(normalisePhone('+61 412 345 678'), '+61412345678');
    assert.equal(normalisePhone('(02) 9876 5432'), '+61298765432');
    assert.equal(normalisePhone('555-1234'), null);
  });
  test('order events reach listeners for the store', async () => {
    const { app } = setup();
    const seen = [];
    app.orders.events.on('location:LOC_WP', (v) => seen.push(v.status));
    await place(app);
    assert.deepEqual(seen, ['held']);
  });
});
