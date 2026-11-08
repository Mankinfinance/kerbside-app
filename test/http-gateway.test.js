// Checks the requests the real Square gateway builds, using a stubbed fetch.
// This proves the request shapes and response handling, not that Square accepts them:
// that needs `npm run square:check` with real sandbox keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSquareHttpGateway } from '../src/square/http-gateway.js';
import { PaymentDeclinedError, GatewayError } from '../src/square/errors.js';

function stub(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  return { calls, fetchImpl };
}
const cfg = { baseUrl: 'https://connect.squareupsandbox.com', accessToken: 'TEST_TOKEN', version: '2025-01-23' };

test('sends auth and version headers', async () => {
  const { calls, fetchImpl } = stub([{ status: 200, json: { locations: [{ id: 'L1', name: 'WP', status: 'ACTIVE', address: { address_line_1: '583 Polding St', locality: 'Wetherill Park' } }] } }]);
  const g = createSquareHttpGateway(cfg, fetchImpl);
  const locs = await g.listLocations();
  assert.equal(calls[0].headers.Authorization, 'Bearer TEST_TOKEN');
  assert.equal(calls[0].headers['Square-Version'], '2025-01-23');
  assert.equal(locs[0].address, '583 Polding St, Wetherill Park');
});

test('normalises the catalog, following pagination', async () => {
  const { fetchImpl, calls } = stub([
    { status: 200, json: { cursor: 'next', objects: [
      { type: 'CATEGORY', id: 'C1', category_data: { name: 'Fried Chicken' } },
      { type: 'MODIFIER_LIST', id: 'ML1', modifier_list_data: { name: 'Sauce', selection_type: 'SINGLE', modifiers: [{ id: 'M1', modifier_data: { name: 'Kerbs', price_money: { amount: 0, currency: 'AUD' } } }] } },
    ] } },
    { status: 200, json: { objects: [
      { type: 'ITEM', id: 'I1', present_at_all_locations: true, item_data: { name: 'OG Kerbs Box', categories: [{ id: 'C1' }], modifier_list_info: [{ modifier_list_id: 'ML1' }],
        variations: [{ id: 'V1', item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 2000, currency: 'AUD' } } }] } },
      { type: 'ITEM', id: 'I2', item_data: { name: 'Market price', variations: [{ id: 'V2', item_variation_data: { pricing_type: 'VARIABLE_PRICING' } }] } },
    ] } },
  ]);
  const menu = await createSquareHttpGateway(cfg, fetchImpl).listMenu();
  assert.match(calls[1].url, /cursor=next/);
  assert.equal(menu.length, 1);
  assert.equal(menu[0].category, 'Fried Chicken');
  assert.equal(menu[0].variations[0].priceCents, 2000);
  assert.equal(menu[0].modifierLists[0].selection, 'single');
  assert.equal(menu[0].locationIds, null);
});

test('builds a curbside pickup order', async () => {
  const { fetchImpl, calls } = stub([{ status: 200, json: { order: { id: 'O1', version: 1, total_money: { amount: 3000, currency: 'AUD' }, fulfillments: [{ uid: 'F1' }], line_items: [{ name: 'OG Kerbs Box', quantity: '1', total_money: { amount: 3000 } }] } } }]);
  const r = await createSquareHttpGateway(cfg, fetchImpl).createOrder({
    locationId: 'L1', lineItems: [{ variationId: 'V1', quantity: 1, modifierIds: ['M1'] }],
    customer: { name: 'Mick', phone: '+61412345678' }, kerbside: { car: 'White RAV4' }, idempotencyKey: 'k1',
  });
  const body = calls[0].body;
  assert.equal(body.idempotency_key, 'k1');
  assert.equal(body.order.line_items[0].quantity, '1');
  assert.equal(body.order.fulfillments[0].pickup_details.is_curbside_pickup, true);
  assert.equal(body.order.fulfillments[0].pickup_details.curbside_pickup_details.curbside_details, 'White RAV4');
  assert.deepEqual(r, { orderId: 'O1', version: 1, totalCents: 3000, currency: 'AUD', fulfillmentUid: 'F1', lineItems: [{ name: 'OG Kerbs Box', quantity: 1, totalCents: 3000, modifiers: [] }] });
});

test('held orders create a delayed-capture payment', async () => {
  const { fetchImpl, calls } = stub([{ status: 200, json: { payment: { id: 'P1', status: 'APPROVED' } } }]);
  await createSquareHttpGateway(cfg, fetchImpl).createPayment({ orderId: 'O1', locationId: 'L1', amountCents: 3000, currency: 'AUD', sourceId: 'cnon:x', autocomplete: false, idempotencyKey: 'k2' });
  assert.equal(calls[0].body.autocomplete, false);
  assert.deepEqual(calls[0].body.amount_money, { amount: 3000, currency: 'AUD' });
});

test('card declines become PaymentDeclinedError', async () => {
  const { fetchImpl } = stub([{ status: 402, json: { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: 'Declined' }] } }]);
  await assert.rejects(
    createSquareHttpGateway(cfg, fetchImpl).createPayment({ orderId: 'O1', locationId: 'L1', amountCents: 1, currency: 'AUD', sourceId: 'x', autocomplete: true, idempotencyKey: 'k' }),
    PaymentDeclinedError,
  );
});

test('other Square errors become GatewayError without leaking the token', async () => {
  const { fetchImpl } = stub([{ status: 401, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'bad token' }] } }]);
  await assert.rejects(createSquareHttpGateway(cfg, fetchImpl).listLocations(), (e) => e instanceof GatewayError && !e.message.includes('TEST_TOKEN'));
});

test('fulfillment updates send the current order version', async () => {
  const { fetchImpl, calls } = stub([{ status: 200, json: { order: { version: 4 } } }, { status: 200, json: { order: {} } }]);
  await createSquareHttpGateway(cfg, fetchImpl).updateFulfillment({ orderId: 'O1', locationId: 'L1', fulfillmentUid: 'F1', state: 'PREPARED' });
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].body.order.version, 4);
  assert.deepEqual(calls[1].body.order.fulfillments[0], { uid: 'F1', state: 'PREPARED' });
});
