// In-memory stand-in for Square, used for local development and automated tests until real
// Square sandbox keys are available. It mirrors the http gateway's shapes and Square's sandbox
// test card codes. It is NOT Square: never use it for real customers.
//
// Menu and prices are Kerbside's public menu where known; others are indicative placeholders.

import { randomUUID } from 'node:crypto';
import { PaymentDeclinedError, GatewayError } from './errors.js';

// Square's documented sandbox test nonces.
export const TEST_CARD_OK = 'cnon:card-nonce-ok';
export const TEST_CARD_DECLINED = 'cnon:card-nonce-declined';

const LOCATIONS = [
  { id: 'LOC_WP', name: 'Wetherill Park', address: 'T038/583 Polding St, Wetherill Park NSW 2164', timezone: 'Australia/Sydney', currency: 'AUD' },
  { id: 'LOC_EP', name: 'Edmondson Park', address: '54 Soldiers Parade, Edmondson Park NSW 2174', timezone: 'Australia/Sydney', currency: 'AUD' },
  { id: 'LOC_EC', name: 'Eastern Creek', address: '159 Rooty Hill Rd S, Eastern Creek NSW 2766', timezone: 'Australia/Sydney', currency: 'AUD' },
  { id: 'LOC_GL', name: 'Glendale', address: '387 Lake Rd, Glendale NSW 2285', timezone: 'Australia/Sydney', currency: 'AUD' },
];

const sauces = { id: 'ML_SAUCE', name: 'Dipping sauce', selection: 'single', modifiers: [
  { id: 'MOD_KERBS', name: 'Kerbs sauce', priceCents: 0 }, { id: 'MOD_HONEY', name: 'Hot honey', priceCents: 0 }, { id: 'MOD_RANCH', name: 'Ranch', priceCents: 0 }] };
const boxUp = { id: 'ML_BOXUP', name: 'Level it up', selection: 'multiple', modifiers: [
  { id: 'MOD_TENDER', name: 'Extra tender', priceCents: 400 }, { id: 'MOD_BIGCUP', name: 'Big Cup Sauce', priceCents: 1000 }] };
const burgerUp = { id: 'ML_BURGERUP', name: 'Level it up', selection: 'multiple', modifiers: [
  { id: 'MOD_DOUBLE', name: 'Double patty', priceCents: 400 }, { id: 'MOD_CHEESE', name: 'Extra cheese', priceCents: 150 }, { id: 'MOD_MEAL', name: 'Make it a meal (fries + drink)', priceCents: 700 }] };

const item = (id, name, category, priceCents, description, modifierLists = []) =>
  ({ id, name, description, category, locationIds: null, absentAtLocationIds: [], variations: [{ id: `${id}_REG`, name: 'Regular', priceCents }], modifierLists });

const MENU = [
  item('IT_OG', 'OG Kerbs Box', 'Fried Chicken', 2000, 'Chicken tenders, fries, toast, slaw and house Kerbs sauce.', [sauces, boxUp]),
  item('IT_T3', '3-Piece Tender Box', 'Fried Chicken', 1900, 'Three chicken tenders with sides and sauce.', [sauces]),
  item('IT_T4', '4-Piece Tender Box', 'Fried Chicken', 2200, 'Four chicken tenders with sides and sauce.', [sauces]),
  item('IT_RODEO', 'Rodeo Burger', 'Burgers', 1650, 'Smash patty, American cheese, onion rings, smoky BBQ.', [burgerUp]),
  item('IT_BIGK', 'Big K Burger', 'Burgers', 1800, "Kerbside's biggest burger.", [burgerUp]),
  item('IT_CHEESE', 'Cheeseburger', 'Burgers', 1200, 'Smash patty, American cheese, pickles, onion, ketchup, mustard.', [burgerUp]),
  item('IT_HHSUB', 'Hot Honey Chicken Sub', 'Subs', 1750, 'Hot honey dipped tenders, lettuce, habanero mayo, pickles, toasted tiger roll.'),
  item('IT_PHILLY', 'Philly Steak Sub', 'Subs', 1900, 'Shaved steak, grilled onions and peppers, melted cheese. Price indicative.'),
  item('IT_MOZZ', 'Mozzarella Squares (2)', 'Sides', 800, 'Two big golden squares.'),
  item('IT_BIGCUP', 'Big Cup Sauce', 'Sides', 1000, 'A full cup of house Kerbs sauce.'),
  item('IT_BISCOFF', 'Biscoff Cheesecake Stick', 'Desserts', 1400, 'Where it all started.'),
];

export function createFakeGateway() {
  const orders = new Map();
  const payments = new Map();
  const variationIndex = new Map();
  const modifierIndex = new Map();
  for (const it of MENU) {
    for (const v of it.variations) variationIndex.set(v.id, { item: it, variation: v });
    for (const ml of it.modifierLists) for (const m of ml.modifiers) modifierIndex.set(m.id, m);
  }
  const used = new Map(); // idempotency key -> result

  return {
    kind: 'fake',
    _orders: orders,
    _payments: payments,

    async listLocations() { return LOCATIONS.map((l) => ({ ...l })); },
    async listMenu() { return structuredClone(MENU); },

    async createOrder({ locationId, lineItems, customer, kerbside, idempotencyKey }) {
      if (used.has(idempotencyKey)) return used.get(idempotencyKey);
      if (!LOCATIONS.some((l) => l.id === locationId)) throw new GatewayError('Unknown location', 400);
      const lines = lineItems.map((l) => {
        const hit = variationIndex.get(l.variationId);
        if (!hit) throw new GatewayError(`Unknown catalog object ${l.variationId}`, 400);
        const mods = (l.modifierIds || []).map((id) => {
          const m = modifierIndex.get(id);
          if (!m) throw new GatewayError(`Unknown modifier ${id}`, 400);
          return m;
        });
        const unit = hit.variation.priceCents + mods.reduce((a, m) => a + m.priceCents, 0);
        return { name: hit.item.name, quantity: l.quantity, totalCents: unit * l.quantity, modifiers: mods.map((m) => m.name) };
      });
      const order = {
        orderId: `FAKE_ORD_${randomUUID().slice(0, 8)}`,
        version: 1,
        totalCents: lines.reduce((a, l) => a + l.totalCents, 0),
        currency: 'AUD',
        fulfillmentUid: `FUL_${randomUUID().slice(0, 6)}`,
        lineItems: lines,
      };
      orders.set(order.orderId, { ...order, locationId, customer, kerbside, state: 'PROPOSED', paid: false });
      used.set(idempotencyKey, order);
      return order;
    },

    async createPayment({ orderId, amountCents, sourceId, autocomplete, idempotencyKey }) {
      if (used.has(idempotencyKey)) return used.get(idempotencyKey);
      const order = orders.get(orderId);
      if (!order) throw new GatewayError('Unknown order', 404);
      if (amountCents !== order.totalCents) throw new GatewayError('Amount does not match order total', 400);
      if (sourceId === TEST_CARD_DECLINED) throw new PaymentDeclinedError();
      if (sourceId !== TEST_CARD_OK) throw new GatewayError('Invalid card token', 400);
      const p = { paymentId: `FAKE_PAY_${randomUUID().slice(0, 8)}`, status: autocomplete ? 'COMPLETED' : 'APPROVED' };
      payments.set(p.paymentId, { ...p, orderId });
      if (autocomplete) order.paid = true;
      used.set(idempotencyKey, p);
      return { ...p };
    },

    async completePayment(paymentId) {
      const p = payments.get(paymentId);
      if (!p) throw new GatewayError('Unknown payment', 404);
      if (p.status === 'CANCELED') throw new GatewayError('Payment was cancelled', 400);
      p.status = 'COMPLETED';
      orders.get(p.orderId).paid = true;
      return { status: p.status };
    },

    async cancelPayment(paymentId) {
      const p = payments.get(paymentId);
      if (!p) throw new GatewayError('Unknown payment', 404);
      if (p.status === 'COMPLETED') throw new GatewayError('Payment already completed', 400);
      p.status = 'CANCELED';
      return { status: p.status };
    },

    async updateFulfillment({ orderId, state, buyerArrivedAt }) {
      const o = orders.get(orderId);
      if (!o) throw new GatewayError('Unknown order', 404);
      if (state) o.state = state;
      if (buyerArrivedAt) o.buyerArrivedAt = buyerArrivedAt;
    },
  };
}
