// Customer web app: choose a store, build a bag, pay with Square, track the order.
// Prices shown here are estimates for display; the server prices every order from the catalog.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toFixed(2);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  config: null, locations: [], locationId: store.get('ks.location', null), menu: [], category: null,
  cart: store.get('ks.cart', []), view: 'menu', mode: 'kerbside', hold: true,
  name: store.get('ks.name', ''), phone: store.get('ks.phone', ''), car: store.get('ks.car', ''),
  orders: store.get('ks.orders', []), current: null, payKey: null, card: null, testCard: 'cnon:card-nonce-ok', busy: false, error: '',
};

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { status: res.status, code: body.code });
  return body;
}

// ---------- Boot ----------
async function boot() {
  S.config = await api('/api/config');
  $('#testBanner').hidden = !(S.config.gateway === 'fake' || S.config.square?.environment === 'sandbox');
  S.locations = await api('/api/locations');
  if (!S.locations.some((l) => l.id === S.locationId)) S.locationId = S.locations[0]?.id;
  $('#store').innerHTML = S.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  $('#store').value = S.locationId;
  $('#store').addEventListener('change', async (e) => { S.locationId = e.target.value; store.set('ks.location', S.locationId); S.card = null; await loadMenu(); render(); });
  await loadMenu();
  const live = S.orders.at(-1);
  if (live) { S.current = live; S.view = 'track'; }
  render();
}
async function loadMenu() {
  S.menu = await api(`/api/menu?location=${encodeURIComponent(S.locationId)}`);
  const cats = [...new Set(S.menu.map((m) => m.category))];
  if (!cats.includes(S.category)) S.category = cats[0];
}
const saveCart = () => store.set('ks.cart', S.cart);
const cartTotal = () => S.cart.reduce((a, l) => a + l.unitCents * l.quantity, 0);
const cartCount = () => S.cart.reduce((a, l) => a + l.quantity, 0);

// ---------- Views ----------
function render() {
  const v = $('#view');
  if (S.view === 'menu') v.innerHTML = menuView();
  else if (S.view === 'bag') v.innerHTML = bagView();
  else v.innerHTML = trackView();
  bar();
  if (S.view === 'bag') mountPayment();
}

function menuView() {
  const cats = [...new Set(S.menu.map((m) => m.category))];
  const items = S.menu.filter((m) => m.category === S.category);
  return `<h1>Order ahead</h1>
  <p class="muted sm">Order now, tap "Leaving now" when you head off, and we'll bring it to your car.</p>
  ${S.orders.length ? `<button class="btn ghost block" data-act="track" style="margin:6px 0 12px">View your current order</button>` : ''}
  <div class="chips" role="group" aria-label="Menu categories">${cats.map((c) => `<button class="chip" aria-pressed="${c === S.category}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
  <div>${items.map((m) => `<button class="item" data-item="${esc(m.id)}" ${m.soldOut ? 'aria-disabled="true"' : ''}>
    <span><b>${esc(m.name)}${m.soldOut ? '<span class="tag">Sold out today</span>' : ''}</b><span class="muted sm">${esc(m.description)}</span></span>
    <span class="price">${money(m.variations[0].priceCents)}</span></button>`).join('') || '<p class="muted">Nothing here right now.</p>'}</div>`;
}

function bagView() {
  if (!S.cart.length) return `<h1>Your bag</h1><p class="muted">Your bag is empty.</p><button class="btn" data-act="menu">Browse the menu</button>`;
  const sold = new Set(S.menu.filter((m) => m.soldOut).map((m) => m.id));
  return `<button class="btn ghost" data-act="menu">‹ Menu</button>
  <h1 style="margin-top:12px">Your bag</h1>
  ${S.cart.map((l, i) => `<div class="line"><div><b>${l.quantity} × ${esc(l.name)}</b>${l.modNames.length ? `<div class="muted sm">${esc(l.modNames.join(', '))}</div>` : ''}
    ${sold.has(l.itemId) ? '<div class="err">Sold out at this store. Remove it to continue.</div>' : ''}
    <div class="qty" style="margin-top:6px"><button data-dec="${i}" aria-label="Remove one">−</button><button data-inc="${i}" aria-label="Add one">+</button></div></div>
    <span class="price">${money(l.unitCents * l.quantity)}</span></div>`).join('')}
  <h2>Pickup</h2>
  <div class="seg" role="group" aria-label="Pickup type">
    <button data-mode="kerbside" aria-pressed="${S.mode === 'kerbside'}">Bring it to my car</button>
    <button data-mode="counter" aria-pressed="${S.mode === 'counter'}">Counter pickup</button>
  </div>
  <div class="panel" style="display:grid;gap:12px">
    <label class="f">Your name<input type="text" id="name" autocomplete="given-name" value="${esc(S.name)}" maxlength="60"></label>
    <label class="f">Mobile<input type="tel" id="phone" autocomplete="tel" value="${esc(S.phone)}" placeholder="0412 345 678" maxlength="20"></label>
    ${S.mode === 'kerbside' ? `<label class="f">Car colour, model and rego<input type="text" id="car" value="${esc(S.car)}" placeholder="White Toyota RAV4, DXN 42K" maxlength="80"></label>` : ''}
    <label class="toggle"><input type="checkbox" id="hold" ${S.hold ? 'checked' : ''}><span><b>Cook it when I'm on my way</b><br><span class="muted sm">We hold your order and start cooking when you tap "Leaving now". Your card is authorised now and charged when you leave.</span></span></label>
  </div>
  <h2>Payment</h2>
  ${S.config.gateway === 'fake'
    ? `<div class="panel"><b>Test card</b><p class="muted sm">This server is running without Square. Choose a test result.</p>
        <div class="seg"><button data-testcard="cnon:card-nonce-ok" aria-pressed="${S.testCard === 'cnon:card-nonce-ok'}">Approved</button><button data-testcard="cnon:card-nonce-declined" aria-pressed="${S.testCard === 'cnon:card-nonce-declined'}">Declined</button></div></div>`
    : `<div class="panel"><div id="card-container"></div><p class="muted sm">Card details go straight to Square. Kerbside never sees them.</p></div>`}
  <p class="err" id="err" role="alert">${esc(S.error)}</p>
  <div class="row" style="justify-content:space-between"><span class="muted">Estimated total</span><span class="price">${money(cartTotal())}</span></div>`;
}

const STEPS = { kerbside: [['held', 'Order in, waiting for you'], ['cooking', 'Cooking'], ['ready', 'Ready'], ['arrived', 'We know you\'re here'], ['handed_over', 'Handed over']],
  counter: [['held', 'Order in, waiting for you'], ['cooking', 'Cooking'], ['ready', 'Ready at the counter'], ['handed_over', 'Collected']] };
function trackView() {
  const o = S.current?.view;
  if (!o) return `<p class="muted">Loading your order…</p>`;
  const steps = STEPS[o.mode].filter(([k]) => o.status === 'held' || k !== 'held' || o.holdExpiresAt);
  const idx = steps.findIndex(([k]) => k === o.status);
  const head = { held: 'Kitchen is ready when you are', cooking: o.etaMinutes ? `Cooking. See you in about ${o.etaMinutes} min` : 'Cooking now', ready: o.mode === 'kerbside' ? 'Ready. Tap "I\'m here" when you park' : 'Ready at the counter', arrived: 'A runner is on the way', handed_over: 'Enjoy your feed', cancelled: 'This order was cancelled' }[o.status];
  return `<div class="hero"><div class="sm" style="opacity:.8">ORDER ${esc(o.id)} · ${esc(o.locationName)}</div><h1>${esc(head)}</h1>
    ${o.car ? `<div class="sm" style="opacity:.85">${esc(o.car)}${o.bay ? ` · Bay ${esc(o.bay)}` : ''}</div>` : ''}</div>
  <ol class="steps">${steps.map(([k, l], i) => `<li class="${i < idx || o.status === 'handed_over' ? 'done' : i === idx ? 'now' : ''}">${esc(l)}</li>`).join('')}</ol>
  ${o.status === 'held' ? `<div class="panel"><b>Leaving now?</b><p class="muted sm">Tell us how far away you are and we'll time it so it's hot when you arrive. Your card is charged when you tap.</p>
     <div class="leave">${[5, 10, 15].map((n) => `<button class="btn" data-leave="${n}">${n} min</button>`).join('')}</div></div>` : ''}
  ${o.mode === 'kerbside' && ['held', 'cooking', 'ready'].includes(o.status) ? `<div class="panel"><b>Here already?</b>
     <div class="row" style="margin-top:8px"><label class="f" style="flex:1">Bay number (optional)<input type="text" id="bay" maxlength="8" inputmode="numeric"></label><button class="btn" data-act="arrived" style="align-self:flex-end">I'm here</button></div></div>` : ''}
  ${o.status === 'handed_over' ? `<div class="panel"><b>+${o.points} Kerbside Club points</b><p class="muted sm">Added to ${esc(S.phone || 'your number')}.</p></div>` : ''}
  <div class="panel"><b>Your order</b>${o.items.map((l) => `<div class="line"><span>${l.quantity} × ${esc(l.name)}${l.modifiers?.length ? `<br><span class="muted sm">${esc(l.modifiers.join(', '))}</span>` : ''}</span><span class="price">${money(l.totalCents)}</span></div>`).join('')}
    <div class="line" style="border:0"><b>Total</b><b class="price">${money(o.totalCents)}</b></div></div>
  <p class="err" role="alert">${esc(S.error)}</p>
  ${['handed_over', 'cancelled'].includes(o.status) ? `<button class="btn block" data-act="new">Start a new order</button>` : `<button class="btn ghost block" data-act="menu">Back to the menu</button>`}`;
}

function bar() {
  const b = $('#bar'), btn = $('#barBtn');
  if (S.view === 'menu' && S.cart.length) { b.hidden = false; btn.disabled = false; btn.textContent = `View bag · ${cartCount()} · ${money(cartTotal())}`; btn.dataset.act = 'bag'; }
  else if (S.view === 'bag' && S.cart.length) { b.hidden = false; btn.disabled = S.busy; btn.textContent = S.busy ? 'Placing your order…' : (S.hold ? `Authorise ${money(cartTotal())}` : `Pay ${money(cartTotal())}`); btn.dataset.act = 'pay'; }
  else b.hidden = true;
}

// ---------- Square card ----------
async function mountPayment() {
  if (S.config.gateway !== 'square' || !$('#card-container')) return;
  try {
    if (!window.Square) await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = S.config.square.sdkUrl; s.onload = ok; s.onerror = fail; document.head.append(s); });
    if (!S.card || S.card.locationId !== S.locationId) {
      const payments = window.Square.payments(S.config.square.applicationId, S.locationId);
      S.card = { locationId: S.locationId, el: await payments.card() };
    }
    await S.card.el.attach('#card-container');
  } catch {
    S.error = "The card form couldn't load. Check your connection and refresh.";
    const e = $('#err'); if (e) e.textContent = S.error;
  }
}
async function cardToken() {
  if (S.config.gateway === 'fake') return S.testCard;
  const r = await S.card.el.tokenize();
  if (r.status !== 'OK') throw new Error(r.errors?.[0]?.message || 'Check your card details and try again.');
  return r.token;
}

// ---------- Item sheet ----------
let sheet = null;
function openItem(id) {
  const m = S.menu.find((x) => x.id === id);
  if (!m || m.soldOut) return;
  sheet = { m, qty: 1 };
  $('#itemTitle').textContent = m.name;
  $('#itemDesc').textContent = m.description;
  $('#itemOpts').innerHTML = m.modifierLists.map((l, li) => `<fieldset style="border:0;padding:0;margin:0 0 8px"><legend class="sm muted" style="font-weight:700;margin-bottom:6px">${esc(l.name)}${l.selection === 'single' ? ' · pick one' : ''}</legend>
    ${l.modifiers.map((mod, mi) => `<label class="opt"><input type="${l.selection === 'single' ? 'radio' : 'checkbox'}" name="ml${li}" value="${esc(mod.id)}" data-price="${mod.priceCents}" data-name="${esc(mod.name)}" ${l.selection === 'single' && mi === 0 ? 'checked' : ''}><span>${esc(mod.name)}</span><span class="muted">${mod.priceCents ? '+' + money(mod.priceCents) : ''}</span></label>`).join('')}</fieldset>`).join('');
  $('#qty').textContent = '1';
  $('#itemDialog').showModal();
}
$('#qtyUp').addEventListener('click', () => { sheet.qty = Math.min(20, sheet.qty + 1); $('#qty').textContent = sheet.qty; });
$('#qtyDown').addEventListener('click', () => { sheet.qty = Math.max(1, sheet.qty - 1); $('#qty').textContent = sheet.qty; });
$('#itemDialog').addEventListener('close', () => {
  if ($('#itemDialog').returnValue !== 'add' || !sheet) return;
  const chosen = [...document.querySelectorAll('#itemOpts input:checked')];
  const v = sheet.m.variations[0];
  S.cart.push({ itemId: sheet.m.id, variationId: v.id, name: sheet.m.name, quantity: sheet.qty,
    modifierIds: chosen.map((c) => c.value), modNames: chosen.map((c) => c.dataset.name),
    unitCents: v.priceCents + chosen.reduce((a, c) => a + Number(c.dataset.price), 0) });
  saveCart(); render();
});

// ---------- Actions ----------
function readForm() {
  if ($('#name')) S.name = $('#name').value; if ($('#phone')) S.phone = $('#phone').value; if ($('#car')) S.car = $('#car').value;
  if ($('#hold')) S.hold = $('#hold').checked;
  store.set('ks.name', S.name); store.set('ks.phone', S.phone); store.set('ks.car', S.car);
}
async function pay() {
  readForm();
  S.error = '';
  if (!S.name.trim()) return showError('Add your name so we know whose order it is.');
  if (!S.phone.trim()) return showError('Add your mobile so we can reach you about your order.');
  if (S.mode === 'kerbside' && !S.car.trim()) return showError('Add your car colour, model and rego so we can find you.');
  S.busy = true; bar();
  try {
    S.payKey ||= crypto.randomUUID(); // reused on retry so a double tap never charges twice
    const sourceId = await cardToken();
    const order = await api('/api/orders', { method: 'POST', body: JSON.stringify({
      locationId: S.locationId, mode: S.mode, hold: S.hold, car: S.mode === 'kerbside' ? S.car : undefined,
      customer: { name: S.name, phone: S.phone }, sourceId, idempotencyKey: S.payKey,
      items: S.cart.map((l) => ({ variationId: l.variationId, quantity: l.quantity, modifierIds: l.modifierIds })),
    }) });
    const { accessToken, ...view } = order;
    S.orders.push({ id: order.id, token: accessToken }); store.set('ks.orders', S.orders.slice(-5));
    S.cart = []; saveCart(); S.payKey = null;
    S.current = { id: order.id, token: accessToken, view };
    S.view = 'track'; S.busy = false; follow(); render(); scrollTo(0, 0);
  } catch (e) {
    S.busy = false;
    if (e.code === 'declined') S.payKey = null; // a new card attempt needs a new key
    if (e.code === 'sold_out') await loadMenu();
    showError(e.message);
  }
}
function showError(msg) { S.error = msg; render(); const e = $('#err') || $('.err'); e?.scrollIntoView({ block: 'center' }); }

let stream = null;
function follow() {
  stream?.close();
  if (!S.current) return;
  stream = new EventSource(`/api/orders/${encodeURIComponent(S.current.id)}/events?token=${encodeURIComponent(S.current.token)}`);
  stream.onmessage = (ev) => { S.current.view = JSON.parse(ev.data); if (S.view === 'track') render(); };
  stream.onerror = () => { /* the browser reconnects on its own */ };
}
async function orderAction(path, body) {
  S.error = '';
  try {
    S.current.view = await api(`/api/orders/${encodeURIComponent(S.current.id)}/${path}`, { method: 'POST', headers: { 'X-Order-Token': S.current.token }, body: JSON.stringify(body) });
  } catch (e) { S.error = e.message; }
  render();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.cat) { S.category = d.cat; render(); }
  else if (d.item) openItem(d.item);
  else if (d.inc) { S.cart[d.inc].quantity = Math.min(20, S.cart[d.inc].quantity + 1); saveCart(); readForm(); render(); }
  else if (d.dec) { const l = S.cart[d.dec]; l.quantity--; if (!l.quantity) S.cart.splice(d.dec, 1); saveCart(); readForm(); render(); }
  else if (d.mode) { readForm(); S.mode = d.mode; render(); }
  else if (d.testcard) { readForm(); S.testCard = d.testcard; render(); }
  else if (d.leave) await orderAction('leaving', { etaMinutes: Number(d.leave) });
  else if (d.act === 'arrived') await orderAction('arrived', { bay: $('#bay')?.value || undefined });
  else if (d.act === 'bag') { S.view = 'bag'; S.error = ''; render(); scrollTo(0, 0); }
  else if (d.act === 'menu') { readForm(); S.view = 'menu'; await loadMenu().catch(() => {}); render(); }
  else if (d.act === 'pay') await pay();
  else if (d.act === 'track') { S.current = S.orders.at(-1); S.view = 'track'; follow(); render(); }
  else if (d.act === 'new') { S.orders = []; store.set('ks.orders', []); S.current = null; stream?.close(); S.view = 'menu'; await loadMenu().catch(() => {}); render(); }
});
$('#view').addEventListener('change', (e) => { if (e.target.id === 'hold') { S.hold = e.target.checked; bar(); } });

// Keep sold-out flags fresh while someone is browsing.
setInterval(async () => { if (S.view === 'menu' && !document.hidden) { await loadMenu().catch(() => {}); render(); } }, 60_000);

boot().then(() => { if (S.view === 'track') follow(); }).catch(() => { $('#view').innerHTML = '<p class="err">We couldn\'t load the menu. Check your connection and refresh.</p>'; });
