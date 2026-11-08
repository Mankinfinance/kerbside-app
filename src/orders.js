// Order service: everything between "Pay" and "Handed over".
// Prices are never taken from the client: Square (or the fake) prices the order from the catalog,
// and the payment amount is Square's order total.

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { nowIso } from './db.js';
import { GatewayError } from './square/errors.js';

export class AppError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// Australian numbers to E.164. Returns null if it doesn't look like a phone number.
export function normalisePhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (/^\+61[2-478]\d{8}$/.test(d)) return d;
  if (/^0[2-478]\d{8}$/.test(d)) return '+61' + d.slice(1);
  if (/^61[2-478]\d{8}$/.test(d)) return '+' + d;
  return null;
}

const ACTIVE = ['held', 'cooking', 'ready', 'arrived'];
// Allowed staff moves. Customers move held->cooking (leaving now) and ->arrived themselves.
const STAFF_MOVES = { held: ['cooking', 'cancelled'], cooking: ['ready'], ready: ['handed_over'], arrived: ['handed_over'] };

export function createOrderService({ db, gateway, config, log = console }) {
  const events = new EventEmitter();
  events.setMaxListeners(1000);
  let menuCache = { at: 0, items: null };

  async function menuItems() {
    if (!menuCache.items || Date.now() - menuCache.at > 60_000) menuCache = { at: Date.now(), items: await gateway.listMenu() };
    return menuCache.items;
  }
  const soldOutSet = (locationId) => new Set(db.prepare('SELECT item_id FROM sold_out WHERE location_id = ?').all(locationId).map((r) => r.item_id));
  const atLocation = (item, locationId) => (item.locationIds === null || item.locationIds.includes(locationId)) && !item.absentAtLocationIds.includes(locationId);

  async function locations() { return gateway.listLocations(); }
  async function requireLocation(locationId) {
    const loc = (await locations()).find((l) => l.id === locationId);
    if (!loc) throw new AppError(404, 'That store was not found.', 'unknown_location');
    return loc;
  }

  async function getMenu(locationId) {
    await requireLocation(locationId);
    const sold = soldOutSet(locationId);
    return (await menuItems()).filter((i) => atLocation(i, locationId)).map((i) => ({ ...i, soldOut: sold.has(i.id) }));
  }

  async function validateCart(locationId, items) {
    const menu = await getMenu(locationId);
    const byVariation = new Map();
    for (const it of menu) for (const v of it.variations) byVariation.set(v.id, it);
    return items.map((line) => {
      const it = byVariation.get(line.variationId);
      if (!it) throw new AppError(400, 'An item in your bag is not on this store\'s menu.', 'unknown_item');
      if (it.soldOut) throw new AppError(409, `${it.name} is sold out at this store today. Remove it to continue.`, 'sold_out');
      const mods = line.modifierIds || [];
      if (new Set(mods).size !== mods.length) throw new AppError(400, `Each option for ${it.name} can only be chosen once.`, 'bad_modifier');
      for (const list of it.modifierLists) {
        const chosen = list.modifiers.filter((m) => mods.includes(m.id));
        if (list.selection === 'single' && chosen.length > 1) throw new AppError(400, `Pick one ${list.name.toLowerCase()} for ${it.name}.`, 'bad_modifier');
      }
      const allowed = new Set(it.modifierLists.flatMap((l) => l.modifiers.map((m) => m.id)));
      if (mods.some((m) => !allowed.has(m))) throw new AppError(400, `That option isn't available for ${it.name}.`, 'bad_modifier');
      return { variationId: line.variationId, quantity: line.quantity, modifierIds: mods };
    });
  }

  const row = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  function publicView(o, locName) {
    return {
      id: o.id, status: o.status, mode: o.mode, locationId: o.location_id, locationName: locName,
      customerName: o.customer_name, car: o.car, bay: o.bay, items: JSON.parse(o.items_json),
      totalCents: o.total_cents, points: o.points, etaMinutes: o.eta_minutes,
      createdAt: o.created_at, holdExpiresAt: o.hold_expires_at, arrivedAt: o.arrived_at, handedOverAt: o.handed_over_at,
    };
  }
  async function view(o) {
    const loc = (await locations()).find((l) => l.id === o.location_id);
    return publicView(o, loc?.name || '');
  }
  async function emit(o) {
    const v = await view(o);
    events.emit(`order:${o.id}`, v);
    events.emit(`location:${o.location_id}`, v);
    return v;
  }
  function syncSquare(o, patch) {
    // Square's pickup status is kept in step on a best-effort basis; the app never blocks on it.
    gateway.updateFulfillment({ orderId: o.square_order_id, locationId: o.location_id, fulfillmentUid: o.fulfillment_uid, ...patch })
      .catch((e) => log.warn?.({ err: e.message, order: o.id }, 'Square fulfillment update failed'));
  }

  async function placeOrder({ locationId, items, mode, car, hold, customer, sourceId, idempotencyKey }) {
    await requireLocation(locationId);
    const phone = normalisePhone(customer.phone);
    if (!phone) throw new AppError(400, 'Enter an Australian mobile or landline number, like 0412 345 678.', 'bad_phone');
    if (mode === 'kerbside' && !car?.trim()) throw new AppError(400, 'Add your car colour, model and rego so we can find you.', 'missing_car');
    const lines = await validateCart(locationId, items);

    const key = idempotencyKey || randomUUID();
    const sq = await gateway.createOrder({
      locationId, lineItems: lines, customer: { name: customer.name.trim(), phone },
      kerbside: mode === 'kerbside' ? { car: car.trim() } : null, idempotencyKey: `${key}:order`,
    });
    if (sq.totalCents <= 0) throw new AppError(400, 'Your bag is empty.', 'empty');
    const payment = await gateway.createPayment({
      orderId: sq.orderId, locationId, amountCents: sq.totalCents, currency: sq.currency, sourceId,
      autocomplete: !hold, idempotencyKey: `${key}:payment`,
    });

    const id = 'K' + randomBytes(4).toString('hex').toUpperCase();
    const accessToken = randomBytes(24).toString('base64url');
    const created = nowIso();
    const status = hold ? 'held' : 'cooking';
    const holdExpires = hold ? new Date(Date.now() + config.holdMaxMinutes * 60_000).toISOString() : null;
    const points = Math.floor((sq.totalCents / 100) * config.pointsPerDollar);
    db.prepare(`INSERT INTO orders (id, access_token, location_id, square_order_id, square_payment_id, fulfillment_uid, mode, status,
      customer_name, customer_phone, car, items_json, total_cents, points, created_at, hold_expires_at, released_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, accessToken, locationId, sq.orderId, payment.paymentId, sq.fulfillmentUid, mode, status,
      customer.name.trim(), phone, mode === 'kerbside' ? car.trim() : null, JSON.stringify(sq.lineItems), sq.totalCents, points,
      created, holdExpires, hold ? null : created,
    );
    const o = row(id);
    if (!hold) syncSquare(o, { state: 'RESERVED' });
    return { ...(await emit(o)), accessToken };
  }

  function authorised(id, token) {
    const o = row(id);
    // Same error for "no such order" and "wrong token" so ids can't be probed.
    if (!o || !token || o.access_token !== token) throw new AppError(404, 'Order not found.', 'not_found');
    return o;
  }

  // One release per order at a time, so a double tap can't complete the payment twice.
  const releasing = new Map();
  function release(o, etaMinutes) {
    if (!releasing.has(o.id)) releasing.set(o.id, doRelease(o, etaMinutes).finally(() => releasing.delete(o.id)));
    return releasing.get(o.id);
  }
  async function doRelease(o, etaMinutes) {
    const fresh = row(o.id);
    if (fresh.status !== 'held') return fresh;
    await gateway.completePayment(o.square_payment_id);
    db.prepare('UPDATE orders SET status = ?, released_at = ?, eta_minutes = ? WHERE id = ? AND status = ?').run('cooking', nowIso(), etaMinutes ?? null, o.id, 'held');
    const updated = row(o.id);
    syncSquare(updated, { state: 'RESERVED' });
    return updated;
  }

  async function leaving(id, token, etaMinutes) {
    const o = authorised(id, token);
    if (o.status !== 'held') throw new AppError(409, 'This order is already being cooked.', 'not_held');
    return emit(await release(o, etaMinutes));
  }

  async function arrived(id, token, bay) {
    let o = authorised(id, token);
    if (o.mode !== 'kerbside') throw new AppError(409, 'This is a counter pickup order. Head inside to collect it.', 'not_kerbside');
    if (!ACTIVE.includes(o.status)) throw new AppError(409, 'This order has already been handed over.', 'finished');
    if (o.status === 'held') o = await release(o, 0);
    const at = nowIso();
    db.prepare('UPDATE orders SET status = CASE WHEN status = ? THEN ? ELSE status END, arrived_at = ?, bay = ? WHERE id = ?')
      .run('ready', 'arrived', at, bay ? String(bay).slice(0, 8) : null, id);
    const updated = row(id);
    syncSquare(updated, { buyerArrivedAt: at });
    return emit(updated);
  }

  async function customerView(id, token) { return view(authorised(id, token)); }

  async function staffMove(id, to, staffLocation) {
    const o = row(id);
    if (!o || (staffLocation && o.location_id !== staffLocation)) throw new AppError(404, 'Order not found.', 'not_found');
    // An arrived order that becomes ready stays "arrived" so the runner sees the car is waiting.
    if (to === 'ready' && o.status === 'cooking' && o.arrived_at) to = 'arrived';
    const allowed = STAFF_MOVES[o.status] || [];
    if (!allowed.includes(to) && !(to === 'arrived' && o.status === 'cooking')) {
      throw new AppError(409, `Can't move an order from ${o.status} to ${to}.`, 'bad_transition');
    }
    if (to === 'cancelled') {
      await gateway.cancelPayment(o.square_payment_id);
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', id);
      syncSquare(o, { state: 'CANCELED' });
    } else if (to === 'cooking') {
      await release(o, null);
    } else if (to === 'handed_over') {
      const at = nowIso();
      db.prepare('UPDATE orders SET status = ?, handed_over_at = ? WHERE id = ?').run('handed_over', at, id);
      db.prepare('INSERT OR IGNORE INTO points_ledger (phone, order_id, points, reason, created_at) VALUES (?,?,?,?,?)')
        .run(o.customer_phone, id, o.points, 'order', at);
      syncSquare(o, { state: 'COMPLETED' });
    } else {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(to, id);
      if (to === 'ready') syncSquare(o, { state: 'PREPARED' });
    }
    return emit(row(id));
  }

  async function queue(locationId) {
    const rows = db.prepare(`SELECT * FROM orders WHERE location_id = ? AND status IN ('held','cooking','ready','arrived') ORDER BY
      CASE status WHEN 'arrived' THEN 0 WHEN 'ready' THEN 1 WHEN 'cooking' THEN 2 ELSE 3 END, created_at`).all(locationId);
    const loc = await requireLocation(locationId);
    return rows.map((o) => publicView(o, loc.name));
  }

  async function setSoldOut(locationId, itemId, soldOut) {
    await requireLocation(locationId);
    if (!(await menuItems()).some((i) => i.id === itemId)) throw new AppError(404, 'Menu item not found.', 'unknown_item');
    if (soldOut) db.prepare('INSERT OR REPLACE INTO sold_out (location_id, item_id, updated_at) VALUES (?,?,?)').run(locationId, itemId, nowIso());
    else db.prepare('DELETE FROM sold_out WHERE location_id = ? AND item_id = ?').run(locationId, itemId);
    events.emit(`menu:${locationId}`, { itemId, soldOut });
  }

  function pointsFor(phoneRaw) {
    const phone = normalisePhone(phoneRaw);
    if (!phone) return 0;
    return db.prepare('SELECT COALESCE(SUM(points),0) AS p FROM points_ledger WHERE phone = ?').get(phone).p;
  }

  // Held orders are released to the kitchen if the customer never taps "Leaving now".
  async function releaseExpiredHolds() {
    const due = db.prepare("SELECT * FROM orders WHERE status = 'held' AND hold_expires_at <= ?").all(nowIso());
    for (const o of due) {
      try { await emit(await release(o, null)); } catch (e) { log.error?.({ err: e.message, order: o.id }, 'Auto-release failed'); }
    }
    return due.length;
  }

  return { events, locations, getMenu, placeOrder, leaving, arrived, customerView, staffMove, queue, setSoldOut, pointsFor, releaseExpiredHolds };
}

export { GatewayError };
