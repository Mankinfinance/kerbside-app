// Staff kerbside screen: live queue per store, status buttons and sold-out switches.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toFixed(2);
const S = { location: null, queue: [], menu: [], stream: null };
try { S.location = localStorage.getItem('ks.staff.location'); } catch { /* ignore */ }

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(body.error); }
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

function showLogin() { $('#login').hidden = false; $('#board').hidden = true; $('#who').hidden = true; $('#avail').hidden = true; S.stream?.close(); }

async function start() {
  try { await api('/api/staff/me'); } catch { return; }
  $('#login').hidden = true; $('#who').hidden = false; $('#board').hidden = false;
  const locs = await api('/api/locations');
  if (!locs.some((l) => l.id === S.location)) S.location = locs[0]?.id;
  $('#store').innerHTML = locs.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  $('#store').value = S.location;
  await load();
}

async function load() {
  try { localStorage.setItem('ks.staff.location', S.location); } catch { /* ignore */ }
  [S.queue, S.menu] = await Promise.all([api(`/api/staff/queue?location=${encodeURIComponent(S.location)}`), api(`/api/menu?location=${encodeURIComponent(S.location)}`)]);
  render(); renderAvail();
  S.stream?.close();
  S.stream = new EventSource(`/api/staff/events?location=${encodeURIComponent(S.location)}`);
  S.stream.onmessage = async (ev) => {
    const o = JSON.parse(ev.data);
    S.queue = await api(`/api/staff/queue?location=${encodeURIComponent(S.location)}`);
    render();
    if (o.status === 'arrived') flash(`${o.customerName} is here${o.bay ? ` · Bay ${o.bay}` : ''}`);
  };
}

const mins = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const COLS = [
  ['arrived', 'Car waiting', (o) => [['handed_over', 'Handed over']]],
  ['ready', 'Ready', (o) => [['handed_over', o.mode === 'kerbside' ? 'Handed over' : 'Collected']]],
  ['cooking', 'Cooking', (o) => [['ready', 'Mark ready']]],
  ['held', 'Held: cook on "leaving"', (o) => [['cooking', 'Start now'], ['cancelled', 'Cancel']]],
];
function ticket(o, actions) {
  return `<article class="ticket ${o.status}">
    <div class="row" style="justify-content:space-between"><span class="big">${o.bay ? `Bay ${esc(o.bay)}` : esc(o.id)}</span><span class="muted sm">${mins(o.createdAt)} min</span></div>
    <b>${esc(o.customerName)} · ${o.mode === 'kerbside' ? 'Kerbside' : 'Counter'}</b>
    ${o.car ? `<div>${esc(o.car)}</div>` : ''}
    ${o.status === 'cooking' && o.etaMinutes ? `<div class="sm"><b>Arriving in about ${o.etaMinutes} min</b></div>` : ''}
    ${o.arrivedAt && o.status !== 'arrived' ? `<div class="sm err">Customer is already here</div>` : ''}
    <ul>${o.items.map((l) => `<li><b>${l.quantity} × ${esc(l.name)}</b>${l.modifiers?.length ? `<br><span class="sm">${esc(l.modifiers.join(', '))}</span>` : ''}</li>`).join('')}</ul>
    <div class="row" style="justify-content:space-between"><span class="muted sm">${esc(o.id)}</span><span class="price">${money(o.totalCents)}</span></div>
    <div class="acts">${actions(o).map(([to, label]) => `<button class="btn ${to === 'cancelled' ? 'ghost' : ''}" data-id="${esc(o.id)}" data-to="${to}">${label}</button>`).join('')}</div>
  </article>`;
}
function render() {
  $('#board').innerHTML = COLS.map(([status, title, acts]) => {
    const list = S.queue.filter((o) => o.status === status);
    return `<section class="col"><h2>${title} <span class="muted">${list.length}</span></h2>${list.map((o) => ticket(o, acts)).join('') || '<p class="empty">Nothing here.</p>'}</section>`;
  }).join('');
}
function renderAvail() {
  $('#availList').innerHTML = S.menu.map((m) => `<label><input type="checkbox" data-sold="${esc(m.id)}" ${m.soldOut ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('');
}
function flash(msg) {
  const old = document.title; document.title = `● ${msg}`;
  setTimeout(() => { document.title = old; }, 8000);
}

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('/api/staff/login', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    $('#password').value = '';
    await start();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/staff/logout', { method: 'POST', body: '{}' }).catch(() => {}); showLogin(); });
$('#store').addEventListener('change', async (e) => { S.location = e.target.value; await load(); });
$('#availBtn').addEventListener('click', () => { $('#avail').hidden = !$('#avail').hidden; });
$('#availList').addEventListener('change', async (e) => {
  const id = e.target.dataset.sold; if (!id) return;
  try { await api('/api/staff/availability', { method: 'POST', body: JSON.stringify({ location: S.location, itemId: id, soldOut: e.target.checked }) }); }
  catch (err) { e.target.checked = !e.target.checked; $('#err').textContent = err.message; }
});
$('#board').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-to]'); if (!b) return;
  b.disabled = true; $('#err').textContent = '';
  try { await api(`/api/staff/orders/${encodeURIComponent(b.dataset.id)}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.to, location: S.location }) }); }
  catch (err) { $('#err').textContent = err.message; b.disabled = false; }
});
setInterval(() => { if (!$('#board').hidden) render(); }, 30_000); // keep "minutes ago" fresh

start();
