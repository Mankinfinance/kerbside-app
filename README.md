# Kerbside app

Order-ahead and kerbside pickup for Kerbside Eatery, built on top of Square.

- **Customer web app** (`/`): choose a store, build a bag, pay, then track the order live. "Cook it when I'm on my way" holds the order until the customer taps "Leaving now". "I'm here" tells staff which bay the car is in.
- **Staff kerbside screen** (`/staff`): a live board for the counter tablet showing cars waiting, ready, cooking and held orders. Staff can mark orders ready or handed over, cancel held orders, and mark items sold out for their store.
- **API server**: keeps the Square keys off the phone, prices every order from the Square catalog, takes payment through Square and tracks kerbside state.

Square stays the system of record for the menu, orders and payments, so the stores' tills and kitchen keep working as they do today.

## Status

| Part | State |
| --- | --- |
| Order flow, holds, kerbside, staff screen, sold out, points | Built and covered by automated tests |
| Square connection (`src/square/http-gateway.js`) | Written against Square's API docs. Request shapes are unit-tested, but it has **not yet run against a real Square account**. Run `npm run square:check` with sandbox keys first. |
| Fake Square (`src/square/fake-gateway.js`) | Local stand-in for development and tests only. It accepts Square's sandbox test card codes. Never use it with real customers. |
| Native iPhone and Android apps, push notifications, owner dashboard, Kerbside Club integration | Not built yet. See "Next" below. |

## How "cook it when I'm on my way" works

1. At checkout the card is **authorised, not charged** (a Square payment with `autocomplete: false`). The order shows as "held" on the staff screen.
2. When the customer taps "Leaving now" (or "I'm here"), the server **completes the payment**. The order becomes paid in Square and reaches the POS and kitchen like any other order.
3. If the customer never taps, the hold is released to the kitchen after `HOLD_MAX_MINUTES` (default 60).
4. Staff can cancel a held order, which voids the authorisation, so the customer is never charged.

## Run it locally

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env            # then edit; never commit .env
STAFF_PASSWORD='a long password' npm run staff:add -- --email you@example.com --name "Your name" --role owner
GATEWAY=fake INSECURE_COOKIES=1 npm start
```

Open http://127.0.0.1:3000 for the customer app and http://127.0.0.1:3000/staff for the staff screen. In fake mode, choose "Approved" or "Declined" for the test card.

## Connect Square (sandbox first)

1. Create a free account at developer.squareup.com and an application.
2. From the application's **Sandbox** credentials, copy the access token and application ID into the environment as `SQUARE_ACCESS_TOKEN` and `SQUARE_APPLICATION_ID`. Set `GATEWAY=square` and `SQUARE_ENVIRONMENT=sandbox`.
3. In the Square Sandbox dashboard, add a few menu items (with categories and modifiers) to the test seller account.
4. Run `npm run square:check`. It is read-only, and lists locations and counts menu items.
5. Start the server and place an order with a Square sandbox test card (for example `4111 1111 1111 1111`, any future expiry, any CVV).

Switch to `SQUARE_ENVIRONMENT=production` only with the owner's production credentials, after the security review.

## Tests

```bash
npm test      # API, order logic, auth and Square request shapes (node:test)
npm run e2e   # real server in two browsers: customer phone + staff tablet (Playwright)
```

## Configuration

See `.env.example`. Secrets only ever come from environment variables.

## Security notes

- Card details go from the browser straight to Square's Web Payments SDK. This server only sees a one-time token.
- Prices are never taken from the client. Square prices the order from the catalog, and the payment amount is Square's order total.
- Every Square call uses idempotency keys, so a double tap or retry never charges twice.
- Customers can only see or act on an order with its secret token. Unknown order and wrong token look the same.
- Staff passwords are hashed with scrypt. Session tokens are random, only their hashes are stored, and they travel in `httpOnly`, `SameSite=Strict`, `Secure` cookies.
- Sign-in locks for 15 minutes after five wrong attempts. Cross-site writes are blocked, and strict security headers (CSP, frame denial, HSTS) are set.
- Order tokens in event-stream URLs are redacted from logs.
- **Before real customers:** an independent security review, HTTPS hosting, database backups, monitoring, rate limits on order creation, two-factor sign-in for owners, and a privacy policy. See the go-live plan.

## Layout

```
src/
  index.js              start-up, background hold release
  server.js             routes, validation, security headers, event streams
  orders.js             order lifecycle, pricing checks, holds, kerbside, points
  auth.js               staff accounts and sessions
  db.js                 SQLite schema (kerbside state only; Square holds the rest)
  config.js             environment settings
  square/http-gateway.js   real Square API
  square/fake-gateway.js   local stand-in for tests
public/                 customer app and staff screen (no build step)
scripts/                add-staff, square-check
test/                   unit and API tests
e2e/                    browser test
```

## Next

1. Run against Square sandbox and fix whatever the real API disagrees with.
2. Kerbside Club: connect the existing loyalty provider or Square Loyalty, replacing the local points ledger.
3. Push notifications and native iPhone/Android apps (the API is ready for them).
4. Owner dashboard and push composer.
5. Production hosting with HTTPS, backups and monitoring.
6. Later features from the concept: catering, Stick Drops, scan to earn, group orders, partner delivery.
