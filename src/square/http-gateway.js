// Square gateway that talks to Square's REST API (sandbox or production).
// Every method returns the same normalised shapes as the fake gateway, so the rest of the app
// does not know which one it is using.
//
// NOTE: written against Square's documented API but NOT yet exercised against a real Square
// account. Run `npm run square:check` once SQUARE_ACCESS_TOKEN is set (see README).

import { randomUUID } from 'node:crypto';
import { GatewayError, PaymentDeclinedError } from './errors.js';

const DECLINE_CODES = new Set([
  'CARD_DECLINED', 'GENERIC_DECLINE', 'INSUFFICIENT_FUNDS', 'CVV_FAILURE', 'ADDRESS_VERIFICATION_FAILURE',
  'INVALID_EXPIRATION', 'CARD_EXPIRED', 'CARD_DECLINED_VERIFICATION_REQUIRED', 'VERIFY_CVV_FAILURE', 'TRANSACTION_LIMIT',
]);

export function createSquareHttpGateway({ baseUrl, accessToken, version }, fetchImpl = fetch) {
  async function call(method, path, body) {
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': version,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors?.length) {
      const errs = json.errors || [];
      const decline = errs.find((e) => e.category === 'PAYMENT_METHOD_ERROR' || DECLINE_CODES.has(e.code));
      if (decline) throw new PaymentDeclinedError(undefined, decline.code);
      throw new GatewayError(`Square ${method} ${path} failed (${res.status})`, res.status, errs.map((e) => ({ code: e.code, detail: e.detail })));
    }
    return json;
  }

  const money = (m) => (m ? Number(m.amount) : 0);

  return {
    kind: 'square',

    async listLocations() {
      const { locations = [] } = await call('GET', '/v2/locations');
      return locations
        .filter((l) => l.status === 'ACTIVE')
        .map((l) => ({
          id: l.id,
          name: l.name,
          address: [l.address?.address_line_1, l.address?.locality, l.address?.administrative_district_level_1, l.address?.postal_code].filter(Boolean).join(', '),
          timezone: l.timezone,
          currency: l.currency || 'AUD',
        }));
    },

    async listMenu() {
      const objects = [];
      let cursor;
      do {
        const q = new URLSearchParams({ types: 'ITEM,MODIFIER_LIST,CATEGORY' });
        if (cursor) q.set('cursor', cursor);
        const page = await call('GET', `/v2/catalog/list?${q}`);
        objects.push(...(page.objects || []));
        cursor = page.cursor;
      } while (cursor);

      const categories = new Map(objects.filter((o) => o.type === 'CATEGORY').map((o) => [o.id, o.category_data?.name || 'Menu']));
      const modLists = new Map(objects.filter((o) => o.type === 'MODIFIER_LIST' && !o.is_deleted).map((o) => [o.id, {
        id: o.id,
        name: o.modifier_list_data?.name || 'Options',
        selection: o.modifier_list_data?.selection_type === 'SINGLE' ? 'single' : 'multiple',
        modifiers: (o.modifier_list_data?.modifiers || []).map((m) => ({ id: m.id, name: m.modifier_data?.name, priceCents: money(m.modifier_data?.price_money) })),
      }]));

      return objects
        .filter((o) => o.type === 'ITEM' && !o.is_deleted)
        .map((o) => {
          const d = o.item_data || {};
          const categoryId = d.categories?.[0]?.id || d.category_id;
          return {
            id: o.id,
            name: d.name,
            description: d.description_plaintext || d.description || '',
            category: categories.get(categoryId) || 'Menu',
            locationIds: o.present_at_all_locations ? null : (o.present_at_location_ids || []),
            absentAtLocationIds: o.absent_at_location_ids || [],
            variations: (d.variations || [])
              .filter((v) => v.item_variation_data?.pricing_type !== 'VARIABLE_PRICING')
              .map((v) => ({ id: v.id, name: v.item_variation_data?.name || 'Regular', priceCents: money(v.item_variation_data?.price_money) })),
            modifierLists: (d.modifier_list_info || []).filter((i) => i.enabled !== false).map((i) => modLists.get(i.modifier_list_id)).filter(Boolean),
          };
        })
        .filter((i) => i.variations.length);
    },

    async createOrder({ locationId, lineItems, customer, kerbside, idempotencyKey }) {
      const pickup = {
        recipient: { display_name: customer.name, phone_number: customer.phone },
        schedule_type: 'ASAP',
        is_curbside_pickup: Boolean(kerbside),
        ...(kerbside ? { curbside_pickup_details: { curbside_details: kerbside.car } } : {}),
      };
      const { order } = await call('POST', '/v2/orders', {
        idempotency_key: idempotencyKey,
        order: {
          location_id: locationId,
          source: { name: 'Kerbside app' },
          line_items: lineItems.map((l) => ({
            catalog_object_id: l.variationId,
            quantity: String(l.quantity),
            modifiers: (l.modifierIds || []).map((id) => ({ catalog_object_id: id })),
          })),
          fulfillments: [{ type: 'PICKUP', state: 'PROPOSED', pickup_details: pickup }],
        },
      });
      return {
        orderId: order.id,
        version: order.version,
        totalCents: money(order.total_money),
        currency: order.total_money?.currency || 'AUD',
        fulfillmentUid: order.fulfillments?.[0]?.uid || null,
        lineItems: (order.line_items || []).map((l) => ({ name: l.name, quantity: Number(l.quantity), totalCents: money(l.total_money), modifiers: (l.modifiers || []).map((m) => m.name).filter(Boolean) })),
      };
    },

    async createPayment({ orderId, locationId, amountCents, currency, sourceId, autocomplete, idempotencyKey }) {
      const { payment } = await call('POST', '/v2/payments', {
        idempotency_key: idempotencyKey,
        source_id: sourceId,
        amount_money: { amount: amountCents, currency },
        order_id: orderId,
        location_id: locationId,
        autocomplete,
      });
      return { paymentId: payment.id, status: payment.status };
    },

    async completePayment(paymentId) {
      const { payment } = await call('POST', `/v2/payments/${encodeURIComponent(paymentId)}/complete`, {});
      return { status: payment.status };
    },

    async cancelPayment(paymentId) {
      const { payment } = await call('POST', `/v2/payments/${encodeURIComponent(paymentId)}/cancel`, {});
      return { status: payment.status };
    },

    // Best effort: keeps Square's pickup status in step with the staff screen.
    async updateFulfillment({ orderId, locationId, fulfillmentUid, state, buyerArrivedAt }) {
      if (!fulfillmentUid) return;
      const { order } = await call('GET', `/v2/orders/${encodeURIComponent(orderId)}`);
      const f = { uid: fulfillmentUid };
      if (state) f.state = state;
      if (buyerArrivedAt) f.pickup_details = { curbside_pickup_details: { buyer_arrived_at: buyerArrivedAt } };
      await call('PUT', `/v2/orders/${encodeURIComponent(orderId)}`, {
        idempotency_key: randomUUID(),
        order: { location_id: locationId, version: order.version, fulfillments: [f] },
      });
    },
  };
}
