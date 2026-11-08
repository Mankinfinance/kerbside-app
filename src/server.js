// HTTP API and static web apps (customer app at /, staff kerbside screen at /staff).

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOrderService, AppError } from './orders.js';
import { createAuth } from './auth.js';
import { PaymentDeclinedError, GatewayError } from './square/errors.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'ks_staff';

const cartLine = z.object({
  variationId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(20),
  modifierIds: z.array(z.string().min(1).max(64)).max(10).default([]),
});
const orderBody = z.object({
  locationId: z.string().min(1).max(64),
  items: z.array(cartLine).min(1).max(30),
  mode: z.enum(['kerbside', 'counter']),
  car: z.string().max(80).optional(),
  hold: z.boolean().default(true),
  customer: z.object({ name: z.string().trim().min(1).max(60), phone: z.string().min(6).max(20) }),
  sourceId: z.string().min(1).max(512),
  idempotencyKey: z.string().uuid(),
});

export function buildServer({ db, gateway, config, logger = false }) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });
  const orders = createOrderService({ db, gateway, config, log: app.log });
  const auth = createAuth({ db, sessionHours: config.sessionHours });
  app.decorate('orders', orders);
  app.decorate('auth', auth);

  app.register(fastifyCookie);
  app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'] });

  // Security headers. The Square Web Payments SDK needs its CDN and its PCI iframe.
  const squareCdn = config.square ? new URL(config.square.webSdkUrl).origin : '';
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    reply.header('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' ${squareCdn} https://*.squarecdn.com`.trim(),
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com https://*.squarecdn.com",
      `frame-src https://*.squarecdn.com https://*.squareup.com https://*.squareupsandbox.com`,
      `connect-src 'self' https://*.squareup.com https://*.squareupsandbox.com https://*.squarecdn.com`,
      "img-src 'self' data:",
      "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  // Reject cross-site writes: JSON-only bodies plus a same-origin check.
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new AppError(403, 'Cross-site request blocked.', 'cross_site');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Some details are missing or invalid.', code: 'invalid', issues: err.issues.map((i) => i.path.join('.')) });
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof PaymentDeclinedError) return reply.code(402).send({ error: err.message, code: 'declined' });
    if (err instanceof GatewayError) {
      req.log.error({ err: err.message, details: err.details }, 'Square error');
      return reply.code(502).send({ error: "We couldn't reach the payment system. Nothing was charged. Try again in a moment.", code: 'gateway' });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: 'bad_request' });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Try again.', code: 'server' });
  });

  // ---------- Public ----------
  app.get('/api/config', async () => ({
    gateway: config.gateway,
    square: config.square ? { applicationId: config.square.applicationId, sdkUrl: config.square.webSdkUrl, environment: config.square.environment } : null,
  }));
  app.get('/api/locations', async () => orders.locations());
  app.get('/api/menu', async (req) => orders.getMenu(z.string().min(1).parse(req.query.location)));

  app.post('/api/orders', async (req, reply) => {
    const body = orderBody.parse(req.body);
    const result = await orders.placeOrder(body);
    return reply.code(201).send(result);
  });

  const orderToken = (req) => req.headers['x-order-token'] || req.query.token;
  app.get('/api/orders/:id', async (req) => orders.customerView(req.params.id, orderToken(req)));
  app.post('/api/orders/:id/leaving', async (req) => {
    const { etaMinutes } = z.object({ etaMinutes: z.number().int().min(0).max(120) }).parse(req.body);
    return orders.leaving(req.params.id, orderToken(req), etaMinutes);
  });
  app.post('/api/orders/:id/arrived', async (req) => {
    const { bay } = z.object({ bay: z.string().max(8).optional() }).parse(req.body || {});
    return orders.arrived(req.params.id, orderToken(req), bay);
  });
  app.get('/api/orders/:id/events', async (req, reply) => {
    const first = await orders.customerView(req.params.id, orderToken(req));
    return sse(req, reply, `order:${req.params.id}`, first);
  });

  // ---------- Staff ----------
  function requireStaff(req) {
    const staff = auth.sessionStaff(req.cookies[COOKIE]);
    if (!staff) throw new AppError(401, 'Sign in to continue.', 'auth');
    return staff;
  }
  app.post('/api/staff/login', async (req, reply) => {
    const { email, password } = z.object({ email: z.string().email().max(120), password: z.string().min(1).max(200) }).parse(req.body);
    const r = auth.login(email, password, req.ip);
    if (r.error === 'locked') throw new AppError(429, 'Too many attempts. Wait 15 minutes and try again.', 'locked');
    if (r.error) throw new AppError(401, 'That email and password don\'t match.', 'invalid');
    reply.setCookie(COOKIE, r.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, expires: new Date(r.expires) });
    return r.staff;
  });
  app.post('/api/staff/logout', async (req, reply) => {
    auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/staff/me', async (req) => requireStaff(req));
  app.get('/api/staff/queue', async (req) => { requireStaff(req); return orders.queue(z.string().min(1).parse(req.query.location)); });
  app.get('/api/staff/events', async (req, reply) => {
    requireStaff(req);
    const loc = z.string().min(1).parse(req.query.location);
    return sse(req, reply, `location:${loc}`, null);
  });
  app.post('/api/staff/orders/:id/status', async (req) => {
    requireStaff(req);
    const { status, location } = z.object({ status: z.enum(['cooking', 'ready', 'handed_over', 'cancelled']), location: z.string().min(1) }).parse(req.body);
    return orders.staffMove(req.params.id, status, location);
  });
  app.post('/api/staff/availability', async (req) => {
    requireStaff(req);
    const { location, itemId, soldOut } = z.object({ location: z.string().min(1), itemId: z.string().min(1), soldOut: z.boolean() }).parse(req.body);
    await orders.setSoldOut(location, itemId, soldOut);
    return { ok: true };
  });

  app.get('/staff', (req, reply) => reply.sendFile('staff.html'));

  // Server-sent events: one stream per order (customer) or per store (staff).
  function sse(req, reply, channel, initial) {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (initial) send(initial);
    const onEvent = (v) => send(v);
    orders.events.on(channel, onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ping); orders.events.off(channel, onEvent); });
  }

  return app;
}
