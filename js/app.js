import { load, save, replaceDb, uid, todayStr, VENUE_TYPES } from './store.js';
import { parseZettleWorkbook } from './zettle.js';

const db = load();
const ui = { modal: null, forceHome: false, pad: null, notable: null, undoId: null, toastTimer: null, zimport: null, dayEditId: null };

/* ---------- helpers ---------- */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const eventById = (id) => db.events.find((e) => e.id === id);
const dayById = (id) => db.days.find((d) => d.id === id);
const activeDay = () => (db.activeDayId ? dayById(db.activeDayId) : null);
const daySales = (day) => db.sales.filter((s) => s.dayId === day.id);
const cashLogged = (day) => daySales(day).filter((s) => s.payType === 'cash').reduce((t, s) => t + s.amount, 0);
const dayTotal = (day) => (day.closedAt ? (day.cardTotal || 0) + (day.cashActual || 0) : null);
const zettleTxnsFor = (day) => Object.values(db.zettle).filter((z) => z.dayId === day.id);

/* ---------- views ---------- */

function render() {
  const day = activeDay();
  $('#view').innerHTML = day && !ui.forceHome ? dayView(day) : homeView();
  renderModal();
}

function homeView() {
  const day = activeDay();
  let html = `
    <div class="topbar">
      <h1>Glowstone Booth</h1>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="settings-open">⚙︎ Settings</button>
    </div>`;

  if (day) {
    const ev = eventById(day.eventId);
    html += `
      <div class="banner">Selling day in progress — ${esc(ev?.name)} · ${fmtDate(day.date)}</div>
      <button class="btn primary big" data-action="go-day">Resume selling day</button>`;
  } else {
    html += `<button class="btn primary big" data-action="start-day">Start selling day</button>`;
  }

  const evs = db.events
    .map((ev) => ({ ev, days: db.days.filter((d) => d.eventId === ev.id).sort((a, b) => b.date.localeCompare(a.date)) }))
    .filter((x) => x.days.length)
    .sort((a, b) => b.days[0].date.localeCompare(a.days[0].date));

  if (!evs.length) {
    html += `<p class="sub" style="margin-top:16px">No selling days yet. Tap the button above at your next event — log every cash sale with one tap, then close the day with your Zettle total.</p>`;
  } else {
    html += `<h2>History</h2>`;
    for (const { ev, days } of evs) {
      const closed = days.filter((d) => d.closedAt);
      const total = closed.reduce((t, d) => t + dayTotal(d), 0);
      const fees = (ev.boothFee || 0) + (ev.otherCosts || 0);
      const rows = days.map((d) => {
        if (!d.closedAt) return `<div class="day-row tappable" data-action="day-open" data-id="${d.id}" data-day-id="${d.id}"><span class="d">${fmtDate(d.date)}</span><span class="t">open — cash logged ${fmt(cashLogged(d))}</span></div>`;
        const perHr = d.hours ? fmt(dayTotal(d) / d.hours) + '/hr' : '';
        const ztx = zettleTxnsFor(d).length;
        return `<div class="day-row tappable" data-action="day-open" data-id="${d.id}" data-day-id="${d.id}"><span class="d">${fmtDate(d.date)}</span><span class="t">${fmt(dayTotal(d))}</span><span class="m">${d.hours ? d.hours + 'h ' + perHr : ''}${ztx ? ' · ' + ztx + ' card txns' : ''}</span></div>`;
      }).join('');
      html += `
        <div class="card">
          <strong>${esc(ev.name)}</strong> <span class="sub">· ${esc(ev.venueType || '')}</span>
          ${rows}
          <div class="sub" style="margin-top:8px">Total ${fmt(total)} − fees ${fmt(fees)} = <strong>${fmt(total - fees)}</strong></div>
        </div>`;
    }
  }
  return html;
}

function dayView(day) {
  const ev = eventById(day.eventId);
  const cash = cashLogged(day);
  const sales = daySales(day).slice().sort((a, b) => b.ts - a.ts);
  const stale = day.date !== todayStr()
    ? `<div class="banner">This day was started ${fmtDate(day.date)} — remember to end it.</div>` : '';

  const recent = sales.slice(0, 8).map((s) => `
    <div class="sale-row" data-action="void-sale" data-id="${s.id}">
      <span class="amt">${fmt(s.amount)}</span>
      <span class="badge ${s.payType}">${s.payType.toUpperCase()}</span>
      ${s.category ? `<span class="badge cat">${esc(s.category)}</span>` : ''}
      <span class="meta" style="text-align:right">${fmtTime(s.ts)}</span>
    </div>`).join('');

  return `
    <div class="topbar">
      <button class="btn small ghost" data-action="go-home">← Home</button>
      <div class="spacer"></div>
      <button class="btn small primary" data-action="close-open">End day</button>
    </div>
    ${stale}
    <div class="card stat-hero">
      <div class="lab">${esc(ev?.name)} · ${fmtDate(day.date)}</div>
      <div class="big">${fmt(cash)}</div>
      <div class="lab">cash logged · ${sales.filter((s) => s.payType === 'cash').length} sales</div>
      <div class="hint">Card sales live in Zettle — you'll enter the total at day end.</div>
    </div>
    <div class="chip-grid">
      ${db.settings.chips.map((c) => `<button class="chip" data-action="chip" data-amount="${c}">$${c}</button>`).join('')}
    </div>
    <div class="row2">
      <button class="btn" data-action="pad-open">$ Custom</button>
      <button class="btn" data-action="notable-open">★ Notable</button>
    </div>
    ${sales.length ? `<h2>Recent · tap to remove</h2><div class="card">${recent}</div>` : ''}
  `;
}

/* ---------- modals ---------- */

function padMarkup(action, value) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
  return `
    <div class="pad-display">${value ? '$' + value : '$0'}</div>
    <div class="pad">
      ${keys.map((k) => `<button data-action="${action}" data-k="${k}">${k === 'back' ? '⌫' : k}</button>`).join('')}
    </div>`;
}

function renderModal() {
  const root = $('#modal-root');
  if (!ui.modal) { root.innerHTML = ''; return; }
  let sheet = '';

  if (ui.modal === 'pad') {
    const v = parseFloat(ui.pad.value) || 0;
    sheet = `
      <h3>Cash sale</h3>
      ${padMarkup('pad-key', ui.pad.value)}
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="pad-save">Log cash ${fmt(v)}</button>
      </div>`;
  }

  if (ui.modal === 'notable') {
    const n = ui.notable;
    sheet = `
      <h3>Notable piece</h3>
      <div class="cat-grid">
        ${db.settings.categories.map((c) => `<button class="cat ${n.cat === c ? 'sel' : ''}" data-action="notable-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      ${padMarkup('notable-key', n.value)}
      <div class="seg">
        <button class="${n.pay === 'card' ? 'sel' : ''}" data-action="notable-pay" data-pay="card">Card (in Zettle)</button>
        <button class="${n.pay === 'cash' ? 'sel' : ''}" data-action="notable-pay" data-pay="cash">Cash</button>
      </div>
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="notable-save">Save notable</button>
      </div>`;
  }

  if (ui.modal === 'pickEvent') {
    const recent = db.events.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
    sheet = `
      <h3>Which event?</h3>
      ${recent.map((e) => `<button class="btn big" style="margin-bottom:10px" data-action="pick-event" data-id="${e.id}">${esc(e.name)}</button>`).join('')}
      <button class="btn primary big" data-action="new-event">+ New event</button>`;
  }

  if (ui.modal === 'newEvent') {
    sheet = `
      <h3>New event</h3>
      <form id="form-event">
        <label>Event name</label>
        <input name="evname" required autocomplete="off" placeholder="Sandy Mountain Festival">
        <label>Venue type</label>
        <select name="venueType">${VENUE_TYPES.map((v) => `<option>${v}</option>`).join('')}</select>
        <label>Booth fee ($)</label>
        <input name="boothFee" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Other costs — travel, lodging, app fees ($)</label>
        <input name="otherCosts" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Sales tax % added at checkout (0 in Oregon)</label>
        <input name="taxRate" type="number" inputmode="decimal" step="0.01" placeholder="Seattle ≈ 10.35">
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Start selling day</button>
        </div>
      </form>`;
  }

  if (ui.modal === 'close') {
    const day = activeDay();
    sheet = `
      <h3>End day — ${esc(eventById(day.eventId)?.name)}</h3>
      <form id="form-close">
        <label>Hours (incl. drive + setup/teardown)</label>
        <input name="hours" type="number" inputmode="decimal" step="0.5" min="0" placeholder="12">
        <label>Card total from Zettle ($)</label>
        <input name="cardTotal" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Cash drawer count at close ($)</label>
        <input name="drawerCash" type="number" inputmode="decimal" step="1" placeholder="leave blank to use logged cash">
        <label>Starting float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" step="1" value="${db.settings.defaultFloat}">
        <label>Notes (weather, booth spot, crowd…)</label>
        <input name="notes" autocomplete="off" placeholder="optional">
        <div class="calc-line" id="close-calc"></div>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Not yet</button>
          <button type="submit" class="btn primary">Close day</button>
        </div>
      </form>`;
  }

  if (ui.modal === 'dayEdit') {
    const day = dayById(ui.dayEditId);
    if (!day) { ui.modal = null; root.innerHTML = ''; return; }
    const ev = eventById(day.eventId);
    const logged = cashLogged(day);
    const ztx = zettleTxnsFor(day);
    const total = day.closedAt ? dayTotal(day) : (day.cardTotal || 0) + logged;
    const syncNote = day.synced
      ? '<p class="sub">This day has already synced. Saving changes will queue a sheet update on the next sync.</p>' : '';
    const zettleNote = ztx.length
      ? `<p class="sub">${ztx.length} imported Zettle transaction(s): ${fmt(ztx.reduce((s, t) => s + t.gross, 0))}${day.cardTax ? ` · tax ${fmt(day.cardTax)}` : ''}</p>` : '<p class="sub">No Zettle transactions imported yet.</p>';
    sheet = `
      <h3>Edit day — ${esc(ev?.name || 'Selling day')}</h3>
      <div class="card">
        <div class="day-row"><span class="d">Cash</span><span class="t">${fmt(logged)} logged</span><span class="m">${daySales(day).filter((s) => s.payType === 'cash').length} taps</span></div>
        <div class="day-row"><span class="d">Card</span><span class="t">${fmt(day.cardTotal || 0)}</span><span class="m">${ztx.length} txns</span></div>
        <div class="day-row"><span class="d">Total</span><span class="t">${fmt(total)}</span><span class="m">${day.hours ? fmt(total / day.hours) + '/hr' : ''}</span></div>
      </div>
      ${zettleNote}
      ${syncNote}
      <form id="form-day-edit">
        <label>Event</label>
        <select name="eventId">${db.events.map((e) => `<option value="${e.id}" ${e.id === day.eventId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <label>Date</label>
        <input name="date" type="date" value="${esc(day.date)}">
        <label>Hours (incl. drive + setup/teardown)</label>
        <input name="hours" type="number" inputmode="decimal" step="0.5" min="0" value="${day.hours ?? ''}">
        <label>Card total from Zettle ($)</label>
        <input name="cardTotal" type="number" inputmode="decimal" step="0.01" value="${day.cardTotal ?? ''}">
        <label>Cash drawer count at close ($)</label>
        <input name="drawerCash" type="number" inputmode="decimal" step="1" value="${day.drawerCash ?? ''}" placeholder="leave blank to use logged cash">
        <label>Starting float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" step="1" value="${day.floatCash ?? db.settings.defaultFloat}">
        <label>Notes</label>
        <textarea name="notes" rows="3" placeholder="weather, booth spot, crowd...">${esc(day.notes || '')}</textarea>
        <div class="calc-line" id="day-edit-calc"></div>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save changes</button>
        </div>
      </form>
      <h2>Zettle</h2>
      <button class="btn primary" style="width:100%;margin-bottom:10px" data-action="zettle-pick-day">Import Zettle report into this day</button>
      <input type="file" id="zettle-day-file" accept=".xlsx,.xls" hidden>
      <button class="btn danger" style="width:100%" data-action="day-delete">Delete day</button>`;
  }

  if (ui.modal === 'settings') {
    const s = db.settings;
    sheet = `
      <h3>Settings</h3>
      <form id="form-settings">
        <label>Quick-tap amounts (comma separated)</label>
        <input name="chips" value="${s.chips.join(', ')}">
        <label>Categories (one per line)</label>
        <textarea name="categories" rows="8">${s.categories.map(esc).join('\n')}</textarea>
        <label>Default cash float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" value="${s.defaultFloat}">
        <label style="display:flex;align-items:center;gap:10px;margin-top:14px">
          <input name="dark" type="checkbox" style="width:24px;height:24px" ${s.dark ? 'checked' : ''}> Dark mode
        </label>
        <label>Sync URL (Apps Script web app)</label>
        <input name="syncUrl" value="${esc(s.syncUrl)}" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec">
        <label>Sync key</label>
        <input name="syncKey" value="${esc(s.syncKey)}" autocomplete="off" placeholder="gsk_…">
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
      <h2>Data</h2>
      <button class="btn primary" style="width:100%;margin-bottom:10px" data-action="sync-now">Sync to Google Sheets now</button>
      ${db.lastSync ? `<p class="sub" style="text-align:center;margin-top:0">Last sync: ${new Date(db.lastSync.at).toLocaleString()} — ${esc(db.lastSync.summary)}</p>` : ''}
      <div class="row2" style="margin-bottom:10px">
        <button class="btn" data-action="export-sales">Sales CSV</button>
        <button class="btn" data-action="export-days">Days CSV</button>
      </div>
      <div class="row2" style="margin-bottom:10px">
        <button class="btn" data-action="export-json">Backup (JSON)</button>
        <button class="btn" data-action="backup-pick">Restore backup</button>
      </div>
      <button class="btn primary" style="width:100%" data-action="zettle-pick">Import Zettle report (.xlsx)</button>
      <input type="file" id="zettle-file" accept=".xlsx,.xls" hidden>
      <input type="file" id="backup-file" accept=".json,application/json" hidden>
      <p class="sub" style="text-align:center">Glowstone Booth v0.4.4</p>`;
  }

  if (ui.modal === 'zimport') {
    const z = ui.zimport;
    const lines = z.matches.map((m) => {
      let dest;
      if (m.day) {
        const ev = eventById(m.day.eventId);
        const entered = m.day.closedAt ? ` — you entered card ${fmt(m.day.cardTotal || 0)}` : '';
        dest = `→ ${esc(ev?.name)} (existing day${entered})`;
      } else {
        dest = '→ new day';
      }
      return `<div class="day-row"><span class="d">${fmtDate(m.date)}</span><span class="t">${m.count} txns · ${fmt(m.gross)}</span><span class="m">${fmt(m.net)} + ${fmt(m.tax)} tax</span></div>
        <div class="sub" style="margin:0 0 8px 2px">${dest}</div>`;
    }).join('');
    const target = z.targetDayId ? dayById(z.targetDayId) : null;
    const eventPicker = z.needsEvent ? `
      <label style="font-weight:700;display:block;margin:12px 0 5px">Add new days under which event?</label>
      <select id="zimport-event" style="width:100%;font-size:1.1rem;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink)">
        ${db.events.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
        <option value="__new">+ New event…</option>
      </select>
      <input id="zimport-newname" placeholder="New event name (e.g. Fremont Fair)" autocomplete="off"
        style="width:100%;font-size:1.1rem;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);margin-top:8px">` : '';
    sheet = `
      <h3>${target ? `Import to ${esc(eventById(target.eventId)?.name || 'this day')}` : 'Import Zettle report'}</h3>
      <div class="card">${lines}</div>
      <p class="sub">Card transactions only — cash never hits Zettle. Amounts shown as collected (your keyed price + sales tax).</p>
      ${eventPicker}
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="zimport-apply">Import ${z.txns.length} transactions</button>
      </div>`;
  }

  root.innerHTML = `<div class="overlay"><div class="sheet">${sheet}</div></div>`;
  if (ui.modal === 'close') updateCloseCalc();
  if (ui.modal === 'dayEdit') updateDayEditCalc();
}

/* ---------- toast ---------- */

function showToast(msg, withUndo) {
  clearTimeout(ui.toastTimer);
  $('#toast-root').innerHTML = `
    <div class="toast">${esc(msg)}${withUndo ? '<button data-action="undo">UNDO</button>' : ''}</div>`;
  ui.toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, withUndo ? 6000 : 3000);
}

/* ---------- actions ---------- */

function logSale(amount, payType, category = null) {
  const day = activeDay();
  if (!day || !(amount > 0)) return;
  const sale = { id: uid(), dayId: day.id, ts: Date.now(), amount, payType, category };
  db.sales.push(sale);
  save(db);
  navigator.vibrate?.(25);
  ui.undoId = sale.id;
  ui.modal = null;
  showToast(`Logged ${fmt(amount)} ${payType}${category ? ' · ' + category : ''}`, true);
  render();
}

function startDayFor(eventId) {
  const ev = eventById(eventId);
  if (!ev) return;
  ev.lastUsed = Date.now();
  const day = { id: uid(), eventId, date: todayStr(), closedAt: null };
  db.days.push(day);
  db.activeDayId = day.id;
  save(db);
  ui.modal = null;
  ui.forceHome = false;
  render();
}

function padKey(state, k) {
  if (k === 'back') state.value = state.value.slice(0, -1);
  else if (k === '.') { if (!state.value.includes('.')) state.value = (state.value || '0') + '.'; }
  else {
    if (state.value.includes('.') && state.value.split('.')[1].length >= 2) return;
    if (state.value.replace('.', '').length >= 6) return;
    state.value = (state.value === '0' ? '' : state.value) + k;
  }
}

function updateCloseCalc() {
  const form = document.getElementById('form-close');
  const out = document.getElementById('close-calc');
  const day = activeDay();
  if (!form || !out || !day) return;
  const logged = cashLogged(day);
  const card = parseFloat(form.cardTotal.value) || 0;
  const float = parseFloat(form.floatCash.value) || 0;
  const drawerRaw = form.drawerCash.value.trim();
  let cashActual, note;
  if (drawerRaw === '') {
    cashActual = logged;
    note = `<span>No drawer count — using logged cash ${fmt(logged)}.</span>`;
  } else {
    cashActual = (parseFloat(drawerRaw) || 0) - float;
    const delta = cashActual - logged;
    const cls = Math.abs(delta) < 1 ? 'ok' : 'warn';
    note = `<span class="${cls}">Cash ${fmt(cashActual)} vs logged ${fmt(logged)} (Δ ${delta >= 0 ? '+' : ''}${fmt(delta)})</span>`;
  }
  const rate = eventById(day.eventId)?.taxRate || 0;
  const taxNote = rate > 0
    ? `<br><span>≈ ${fmt((card + cashActual) - (card + cashActual) / (1 + rate / 100))} of this is sales tax (net ${fmt((card + cashActual) / (1 + rate / 100))})</span>` : '';
  out.innerHTML = `Day total: <strong>${fmt(card + cashActual)}</strong><br>${note}${taxNote}`;
}

function submitClose(form) {
  const day = activeDay();
  if (!day) return;
  const float = parseFloat(form.floatCash.value) || 0;
  const drawerRaw = form.drawerCash.value.trim();
  day.hours = parseFloat(form.hours.value) || 0;
  day.cardTotal = parseFloat(form.cardTotal.value) || 0;
  day.floatCash = float;
  day.drawerCash = drawerRaw === '' ? null : parseFloat(drawerRaw) || 0;
  day.cashActual = drawerRaw === '' ? cashLogged(day) : (parseFloat(drawerRaw) || 0) - float;
  day.notes = form.notes.value.trim();
  day.closedAt = Date.now();
  db.activeDayId = null;
  save(db);
  ui.modal = null;
  ui.forceHome = false;
  const perHr = day.hours ? ` · ${fmt(dayTotal(day) / day.hours)}/hr` : '';
  showToast(`Day closed: ${fmt(dayTotal(day))}${perHr}`);
  render();
  if (db.settings.syncUrl && db.settings.syncKey) syncNow(true);
}

function updateDayEditCalc() {
  const form = document.getElementById('form-day-edit');
  const out = document.getElementById('day-edit-calc');
  const day = dayById(ui.dayEditId);
  if (!form || !out || !day) return;
  const logged = cashLogged(day);
  const card = parseFloat(form.cardTotal.value) || 0;
  const float = parseFloat(form.floatCash.value) || 0;
  const drawerRaw = form.drawerCash.value.trim();
  const cashActual = drawerRaw === '' ? logged : (parseFloat(drawerRaw) || 0) - float;
  const delta = cashActual - logged;
  const cls = Math.abs(delta) < 1 ? 'ok' : 'warn';
  out.innerHTML = `Day total: <strong>${fmt(card + cashActual)}</strong><br>` +
    `<span class="${cls}">Cash ${fmt(cashActual)} vs logged ${fmt(logged)} (Δ ${delta >= 0 ? '+' : ''}${fmt(delta)})</span>`;
}

function submitDayEdit(form) {
  const day = dayById(ui.dayEditId);
  if (!day) return;
  const oldDate = day.date;
  const oldEventId = day.eventId;
  const logged = cashLogged(day);
  const float = parseFloat(form.floatCash.value) || 0;
  const drawerRaw = form.drawerCash.value.trim();

  day.eventId = form.eventId.value;
  day.date = form.date.value || day.date;
  day.hours = parseFloat(form.hours.value) || 0;
  day.cardTotal = parseFloat(form.cardTotal.value) || 0;
  day.floatCash = float;
  day.drawerCash = drawerRaw === '' ? null : parseFloat(drawerRaw) || 0;
  day.cashActual = drawerRaw === '' ? logged : (parseFloat(drawerRaw) || 0) - float;
  day.notes = form.notes.value.trim();
  if (day.closedAt) day.synced = false;

  if (oldDate !== day.date || oldEventId !== day.eventId) {
    daySales(day).forEach((s) => { s.synced = false; });
    zettleTxnsFor(day).forEach((z) => { z.synced = false; });
  }

  save(db);
  ui.modal = null;
  showToast(day.closedAt ? 'Day updated — queued for next sync' : 'Day updated');
  render();
}

function submitEvent(form) {
  const ev = {
    id: uid(),
    name: form.evname.value.trim(),
    venueType: form.venueType.value,
    boothFee: parseFloat(form.boothFee.value) || 0,
    otherCosts: parseFloat(form.otherCosts.value) || 0,
    taxRate: parseFloat(form.taxRate.value) || 0,
    lastUsed: Date.now()
  };
  if (!ev.name) return;
  db.events.push(ev);
  save(db);
  startDayFor(ev.id);
}

function submitSettings(form) {
  const chips = form.chips.value.split(',').map((s) => parseFloat(s.trim())).filter((n) => n > 0).slice(0, 9);
  if (chips.length) db.settings.chips = chips;
  const cats = form.categories.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 24);
  if (cats.length) db.settings.categories = cats;
  db.settings.defaultFloat = parseFloat(form.floatCash.value) || 0;
  db.settings.dark = form.dark.checked;
  db.settings.syncUrl = form.syncUrl.value.trim();
  db.settings.syncKey = form.syncKey.value.trim();
  applyTheme();
  save(db);
  ui.modal = null;
  showToast('Settings saved');
  render();
}

/* ---------- Zettle import & backup restore ---------- */

let xlsxLoading = null;
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error('could not load spreadsheet parser')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

async function handleZettleFile(file, targetDayId = null) {
  try {
    showToast('Reading report…');
    const XLSX = await ensureXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parsed = parseZettleWorkbook(wb, XLSX);
    if (!parsed.txns.length) { showToast('No transactions found in that file'); return; }

    if (targetDayId) {
      const target = dayById(targetDayId);
      if (!target) { showToast('That day no longer exists'); return; }
      const match = parsed.days.find((d) => d.date === target.date);
      if (!match) {
        const dates = parsed.days.map((d) => fmtDate(d.date)).join(', ');
        showToast(`Report is for ${dates}; this day is ${fmtDate(target.date)}`);
        return;
      }
      const txns = parsed.txns.filter((t) => t.date === target.date);
      ui.zimport = {
        ...parsed,
        txns,
        days: [match],
        matches: [{ ...match, day: target }],
        needsEvent: false,
        targetDayId
      };
    } else {
      const matches = parsed.days.map((d) => ({ ...d, day: db.days.find((x) => x.date === d.date) || null }));
      ui.zimport = { ...parsed, matches, needsEvent: matches.some((m) => !m.day), targetDayId: null };
    }
    ui.modal = 'zimport';
    render();
  } catch (err) {
    showToast('Import failed: ' + err.message);
  }
}

function applyZettleImport() {
  const z = ui.zimport;
  if (!z) return;
  let eventId = null;
  if (z.needsEvent) {
    const sel = document.getElementById('zimport-event');
    eventId = sel && sel.value !== '__new' ? sel.value : null;
    if (!eventId) {
      const name = document.getElementById('zimport-newname')?.value.trim() || 'Imported event';
      const ev = { id: uid(), name, venueType: 'Other', boothFee: 0, otherCosts: 0, lastUsed: Date.now() };
      db.events.push(ev);
      eventId = ev.id;
    }
  }
  for (const m of z.matches) {
    let day = m.day;
    if (!day) {
      day = { id: uid(), eventId, date: m.date, closedAt: Date.now(), hours: 0, cardTotal: m.gross, floatCash: 0, drawerCash: null, cashActual: 0, notes: 'imported from Zettle', imported: true };
      db.days.push(day);
    }
    day.cardTotal = m.gross;
    day.cardNet = m.net;
    day.cardTax = m.tax;
    if (day.closedAt) day.synced = false;
    for (const t of z.txns.filter((x) => x.date === m.date)) {
      db.zettle[t.key] = { ...t, dayId: day.id };
    }
  }
  save(db);
  const targetDayId = z.targetDayId || null;
  ui.dayEditId = targetDayId;
  ui.modal = targetDayId ? 'dayEdit' : null;
  ui.zimport = null;
  showToast(`Imported ${z.txns.length} card transactions${targetDayId ? ' into day' : ''}`);
  render();
}

async function handleBackupFile(file) {
  try {
    const next = JSON.parse(await file.text());
    if (!next.version || !Array.isArray(next.days) || !Array.isArray(next.sales)) throw new Error('not a Glowstone backup file');
    const stats = `${next.events?.length ?? 0} events, ${next.days.length} days, ${next.sales.length} sales`;
    if (!confirm(`Replace ALL data on this device with the backup (${stats})? This cannot be undone.`)) return;
    replaceDb(next);
    location.reload();
  } catch (err) {
    showToast('Restore failed: ' + err.message);
  }
}

/* ---------- day deletion (long-press) ---------- */

function deleteDayPrompt(dayId) {
  const day = dayById(dayId);
  if (!day) return;
  const ev = eventById(day.eventId);
  const nSales = daySales(day).length;
  const nZtx = zettleTxnsFor(day).length;
  navigator.vibrate?.(60);
  const extra = day.synced ? '\n\nNote: this day was already synced — also delete its row in Daily_Sales.' : '';
  const msg = `Delete ${day.closedAt ? 'closed' : 'open'} day ${fmtDate(day.date)} · ${ev?.name || ''}?\n` +
    `${nSales} logged sale(s) and ${nZtx} imported card txn(s) will be removed.${extra}\n\nThis can't be undone.`;
  if (!confirm(msg)) return;
  db.sales = db.sales.filter((s) => s.dayId !== dayId);
  for (const k of Object.keys(db.zettle)) if (db.zettle[k].dayId === dayId) delete db.zettle[k];
  db.days = db.days.filter((d) => d.id !== dayId);
  if (db.activeDayId === dayId) db.activeDayId = null;
  if (ui.dayEditId === dayId) ui.dayEditId = null;
  ui.modal = null;
  save(db);
  showToast('Day deleted');
  render();
}

let press = null;
let suppressDayClick = false;
function cancelPress() { if (press) { clearTimeout(press.t); press = null; } }
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('[data-day-id]');
  if (!row) return;
  cancelPress();
  press = {
    x: e.clientX, y: e.clientY,
    t: setTimeout(() => {
      suppressDayClick = true;
      setTimeout(() => { suppressDayClick = false; }, 500);
      press = null;
      deleteDayPrompt(row.dataset.dayId);
    }, 600)
  };
});
document.addEventListener('pointerup', cancelPress);
document.addEventListener('pointercancel', cancelPress);
document.addEventListener('pointermove', (e) => {
  if (press && (Math.abs(e.clientX - press.x) > 12 || Math.abs(e.clientY - press.y) > 12)) cancelPress();
});
document.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-day-id]');
  if (row) {
    e.preventDefault();
    suppressDayClick = true;
    setTimeout(() => { suppressDayClick = false; }, 500);
    cancelPress();
    deleteDayPrompt(row.dataset.dayId);
  }
});

/* ---------- sheet sync ---------- */

async function syncNow(auto) {
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) { if (!auto) showToast('Set the Sync URL and key in Settings first'); return; }
  const days = db.days.filter((d) => d.closedAt && !d.synced);
  const sales = db.sales.filter((s) => !s.synced);
  const ztx = Object.values(db.zettle).filter((z) => !z.synced);
  if (!days.length && !sales.length && !ztx.length) { if (!auto) showToast('Nothing new to sync'); return; }
  const evName = (dayId) => { const d = dayById(dayId); return d ? eventById(d.eventId)?.name || '' : ''; };
  const payload = {
    token: syncKey,
    days: days.map((d) => ({
      date: d.date,
      event: eventById(d.eventId)?.name || '',
      cash: d.cashActual ?? cashLogged(d),
      card: d.cardTotal || 0,
      hours: d.hours || 0,
      transactions: daySales(d).filter((s) => s.payType === 'cash').length + zettleTxnsFor(d).length || ''
    })),
    txns: [
      ...sales.map((s) => ({ key: 'app#' + s.id, date: dayById(s.dayId)?.date || '', time: fmtTime(s.ts), event: evName(s.dayId), amount: s.amount, payType: s.payType, category: s.category || '', source: 'app' })),
      ...ztx.map((z) => ({ key: z.key, date: z.date, time: fmtTime(z.ts), event: evName(z.dayId), amount: z.gross, payType: 'card', category: '', source: 'zettle', net: z.net, tax: z.tax, staff: z.staff }))
    ]
  };
  if (!auto) showToast('Syncing…');
  try {
    const res = await fetch(syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'sync rejected');
    days.forEach((d) => { d.synced = true; });
    sales.forEach((s) => { s.synced = true; });
    ztx.forEach((z) => { z.synced = true; });
    const parts = [
      `${out.days || 0} day(s) added`,
      `${out.daysUpdated || 0} day(s) updated`,
      `${out.txns || 0} txn(s) added`,
      `${out.txnsUpdated || 0} txn(s) updated`
    ];
    db.lastSync = { at: Date.now(), summary: parts.join(', ') };
    save(db);
    showToast(`Synced: ${db.lastSync.summary}`);
    render();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}

/* ---------- exports ---------- */

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportSales() {
  const rows = [['date', 'event', 'time', 'amount', 'pay_type', 'category', 'notable'].join(',')];
  for (const s of db.sales) {
    const day = dayById(s.dayId);
    const ev = day && eventById(day.eventId);
    rows.push([day?.date, ev?.name, fmtTime(s.ts), s.amount, s.payType, s.category || '', s.category ? 'yes' : ''].map(csvCell).join(','));
  }
  download(`glowstone-sales-${todayStr()}.csv`, rows.join('\n'), 'text/csv');
}

function exportDays() {
  const rows = [['date', 'event', 'venue_type', 'hours', 'card_total', 'drawer_cash', 'float', 'cash_actual', 'cash_logged', 'day_total', 'booth_fee', 'other_costs', 'notes'].join(',')];
  for (const d of db.days.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const ev = eventById(d.eventId);
    rows.push([d.date, ev?.name, ev?.venueType, d.hours ?? '', d.cardTotal ?? '', d.drawerCash ?? '', d.floatCash ?? '', d.cashActual ?? '', cashLogged(d), dayTotal(d) ?? '', ev?.boothFee ?? '', ev?.otherCosts ?? '', d.notes || ''].map(csvCell).join(','));
  }
  download(`glowstone-days-${todayStr()}.csv`, rows.join('\n'), 'text/csv');
}

function openDayEdit(dayId) {
  if (suppressDayClick) return;
  if (!dayById(dayId)) return;
  ui.dayEditId = dayId;
  ui.modal = 'dayEdit';
  render();
}

/* ---------- event wiring ---------- */

const handlers = {
  'go-home': () => { ui.forceHome = true; render(); },
  'go-day': () => { ui.forceHome = false; render(); },
  'day-open': (d) => openDayEdit(d.id),
  'start-day': () => { ui.modal = db.events.length ? 'pickEvent' : 'newEvent'; render(); },
  'pick-event': (d) => startDayFor(d.id),
  'new-event': () => { ui.modal = 'newEvent'; render(); },
  'chip': (d) => logSale(Number(d.amount), 'cash'),
  'pad-open': () => { ui.pad = { value: '' }; ui.modal = 'pad'; render(); },
  'pad-key': (d) => { padKey(ui.pad, d.k); renderModal(); },
  'pad-save': () => { const v = parseFloat(ui.pad.value); if (v > 0) logSale(v, 'cash'); },
  'notable-open': () => { ui.notable = { cat: null, value: '', pay: 'card' }; ui.modal = 'notable'; render(); },
  'notable-cat': (d) => { ui.notable.cat = d.cat; renderModal(); },
  'notable-key': (d) => { padKey(ui.notable, d.k); renderModal(); },
  'notable-pay': (d) => { ui.notable.pay = d.pay; renderModal(); },
  'notable-save': () => {
    const n = ui.notable;
    const v = parseFloat(n.value);
    if (!n.cat || !(v > 0)) { showToast('Pick a category and enter an amount'); return; }
    logSale(v, n.pay, n.cat);
  },
  'undo': () => {
    if (!ui.undoId) return;
    db.sales = db.sales.filter((s) => s.id !== ui.undoId);
    ui.undoId = null;
    save(db);
    $('#toast-root').innerHTML = '';
    render();
  },
  'void-sale': (d) => {
    const s = db.sales.find((x) => x.id === d.id);
    if (s && confirm(`Remove ${fmt(s.amount)} ${s.payType} sale?`)) {
      db.sales = db.sales.filter((x) => x.id !== d.id);
      save(db);
      render();
    }
  },
  'close-open': () => { ui.modal = 'close'; render(); },
  'settings-open': () => { ui.modal = 'settings'; render(); },
  'modal-cancel': () => { ui.modal = null; render(); },
  'export-json': () => download(`glowstone-backup-${todayStr()}.json`, JSON.stringify(db, null, 2), 'application/json'),
  'export-sales': exportSales,
  'export-days': exportDays,
  'zettle-pick': () => document.getElementById('zettle-file')?.click(),
  'zettle-pick-day': () => document.getElementById('zettle-day-file')?.click(),
  'backup-pick': () => document.getElementById('backup-file')?.click(),
  'zimport-apply': applyZettleImport,
  'day-delete': () => deleteDayPrompt(ui.dayEditId),
  'sync-now': () => syncNow(false)
};

document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('overlay')) { ui.modal = null; render(); return; }
  const el = e.target.closest('[data-action]');
  if (el) handlers[el.dataset.action]?.(el.dataset, el);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'form-close') submitClose(e.target);
  if (e.target.id === 'form-event') submitEvent(e.target);
  if (e.target.id === 'form-day-edit') submitDayEdit(e.target);
  if (e.target.id === 'form-settings') submitSettings(e.target);
});

document.addEventListener('input', (e) => {
  if (e.target.closest('#form-close')) updateCloseCalc();
  if (e.target.closest('#form-day-edit')) updateDayEditCalc();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'zettle-file' && e.target.files?.[0]) { handleZettleFile(e.target.files[0]); e.target.value = ''; }
  if (e.target.id === 'zettle-day-file' && e.target.files?.[0]) { handleZettleFile(e.target.files[0], ui.dayEditId); e.target.value = ''; }
  if (e.target.id === 'backup-file' && e.target.files?.[0]) { handleBackupFile(e.target.files[0]); e.target.value = ''; }
});

/* ---------- boot ---------- */

function applyTheme() {
  document.documentElement.classList.toggle('dark', !!db.settings.dark);
}

applyTheme();
render();

// test hooks (harmless in production; lets automated checks drive the import pipeline)
window.__gs = { handleZettleFile, parseZettleWorkbook, ensureXLSX, syncNow };

const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isDev) {
  // auto-refresh once when an updated service worker takes over, so new
  // versions appear without manual cache clearing
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
}
navigator.storage?.persist?.();
