import { db, ui, $, esc, fmt, fmtDate, fmtTime, eventById, dayById, activeDay, daySales, cashLogged, dayTotal, zettleTxnsFor, pct } from './runtime.js';
import { PRICE_MULTIPLIERS, tagPrice } from './pricing.js';
import { VENUE_TYPES, todayStr } from './store.js';
import { updateCloseCalc, updateDayEditCalc } from './actions.js';

export function render() {
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
      <button class="btn small ghost" data-action="insights-open">Insights</button>
      <button class="btn small ghost" data-action="settings-open">⚙︎ Settings</button>
    </div>
    <button class="btn price-tool" data-action="price-open">Price Tool</button>`;

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

// (todayStr imported directly from store.js above)

/* ---------- modal markup ---------- */

function padMarkup(action, value) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
  return `
    <div class="pad-display">${value ? '$' + value : '$0'}</div>
    <div class="pad">
      ${keys.map((k) => `<button data-action="${action}" data-k="${k}">${k === 'back' ? '⌫' : k}</button>`).join('')}
    </div>`;
}

function insightsMarkup() {
  const data = ui.insights;
  if (!db.settings.syncUrl || !db.settings.syncKey) {
    return `
      <h3>Insights</h3>
      <p class="sub">Set the Sync URL and key in Settings first. Insights come from the same Apps Script endpoint that updates the master sheet.</p>
      <button class="btn primary" style="width:100%" data-action="settings-open">Open Settings</button>`;
  }
  if (!data || data.loading) {
    return `
      <h3>Insights</h3>
      <div class="card"><strong>Loading sheet insights...</strong><p class="sub">Reading Dashboard, Event_Analysis, Historical_Sales, Daily_Sales, and Txn_Log.</p></div>`;
  }
  if (data.error) {
    return `
      <h3>Insights</h3>
      <div class="card"><strong>Could not load insights</strong><p class="sub">${esc(data.error)}</p></div>
      <button class="btn primary" style="width:100%" data-action="insights-refresh">Try again</button>`;
  }

  const m = data.metrics || {};
  const events = data.events || [];
  const yoy = data.yoy || [];
  const tax = data.tax || [];
  const history = data.history || {};
  const histTop = history.topEvents || [];
  const quality = data.dataQuality || [];
  const recs = data.recommendations || [];
  const best = events[0];
  const worst = events.slice().sort((a, b) => (a.netPerDay || 0) - (b.netPerDay || 0))[0];
  const up = yoy[0];
  const down = yoy.slice().sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];
  const txn = data.txnStats;
  const eventRows = events.slice(0, 6).map((e) => `
    <div class="day-row">
      <span class="d">${esc(e.state || '') || 'OR'}</span>
      <span class="t">${esc(e.event)}</span>
      <span class="m">${fmt(e.netPerDay)}/net day</span>
    </div>`).join('');
  const recRows = recs.map((r) => `<div class="insight-note"><strong>${esc(r.title)}</strong><span>${esc(r.detail)}</span></div>`).join('');
  const taxTotal = tax.reduce((s, x) => s + (x.tax || 0), 0);

  return `
    <h3>Insights</h3>
    <div class="sub" style="margin-bottom:10px">Sheet refresh: ${data.generatedAt ? new Date(data.generatedAt).toLocaleString() : 'just now'}</div>
    <div class="kpi-grid">
      <div class="kpi"><span>Net revenue</span><strong>${fmt(m.netRevenue)}</strong></div>
      <div class="kpi"><span>Net after costs</span><strong>${fmt(m.netAfterCosts)}</strong></div>
      <div class="kpi"><span>Selling days</span><strong>${Number(m.sellingDays || 0)}</strong></div>
      <div class="kpi"><span>Revenue / hour</span><strong>${fmt(m.revenuePerHour)}</strong></div>
    </div>
    ${history.rows ? `<div class="card">
      <strong>Historical baseline: ${esc((history.years || []).join(', '))}</strong>
      <p class="sub">${history.eventRows || history.rows} event rows, ${fmt(history.totalRevenue)} recorded income. Top historical comp: ${histTop[0] ? `${esc(histTop[0].event)} at ${fmt(histTop[0].perDay)}/day` : 'none yet'}.</p>
    </div>` : ''}
    ${best ? `<div class="card"><strong>Best event so far: ${esc(best.event)}</strong><p class="sub">${fmt(best.netPerDay)}/day net of tax, ${fmt(best.netAfterCosts)} after event costs.</p></div>` : ''}
    ${worst && worst !== best ? `<div class="card"><strong>Lowest performer: ${esc(worst.event)}</strong><p class="sub">${fmt(worst.netPerDay)}/day net of tax. Check booth fee, venue fit, and product mix before rebooking.</p></div>` : ''}
    <h2>Event Ranking</h2>
    <div class="card">${eventRows || '<p class="sub">No event rows yet.</p>'}</div>
    <h2>Movement</h2>
    <div class="card">
      ${up ? `<div class="day-row"><span class="d">Best</span><span class="t">${esc(up.event)}</span><span class="m">${pct(up.changePct)} YoY</span></div>` : ''}
      ${down ? `<div class="day-row"><span class="d">Watch</span><span class="t">${esc(down.event)}</span><span class="m">${pct(down.changePct)} YoY</span></div>` : ''}
      <div class="day-row"><span class="d">Tax</span><span class="t">WA normalization</span><span class="m">${fmt(taxTotal)} est.</span></div>
    </div>
    ${txn ? `<h2>Latest Detail</h2><div class="card">
      <strong>${esc(txn.event)} · ${esc(txn.date)}</strong>
      <p class="sub">${txn.cardTransactions} card txns, ${txn.cashTaps} cash taps. Median card basket ${fmt(txn.medianCardNet)}; ${pct(txn.cardOver100Pct)} of card baskets were $100+.</p>
    </div>` : ''}
    ${recRows ? `<h2>BI Notes</h2><div class="card">${recRows}</div>` : ''}
    ${quality.length ? `<h2>Data Checks</h2><div class="card">${quality.slice(0, 5).map((q) => `<p class="sub">• ${esc(q)}</p>`).join('')}</div>` : ''}
    <button class="btn primary" style="width:100%" data-action="insights-refresh">Refresh insights</button>`;
}

/* ---------- weight-based pricing markup ---------- */

function selectedMaterial() {
  return ui.price?.materials?.find((m) => m.id === ui.price.selectedId) || null;
}

export function priceMatchesMarkup() {
  const p = ui.price;
  const query = (p?.search || '').trim().toLowerCase();
  if (!p?.materials?.length) return '<p class="sub">No material costs are available yet.</p>';
  if (!query) return '<p class="sub">Search by material, quality, supplier, or trip.</p>';
  const matches = p.materials.filter((m) => [m.material, m.quality, m.vendor, m.sourceTrip].join(' ').toLowerCase().includes(query)).slice(0, 12);
  if (!matches.length) return '<p class="sub">No matching material. Try a shorter word.</p>';
  return matches.map((m) => `
    <button class="material-match ${m.id === p.selectedId ? 'sel' : ''}" data-action="price-material" data-id="${esc(m.id)}">
      <span>${esc(m.material)}${m.quality ? ` · ${esc(m.quality)}` : ''}</span>
      <small>${fmt(m.unitCost)}/kg · ${esc(m.sourceTrip)}</small>
    </button>`).join('');
}

function priceSelectionMarkup() {
  const m = selectedMaterial();
  if (!m) return '<div class="price-selected empty">Choose the closest material/quality from the search results.</div>';
  return `<div class="price-selected">
    <strong>${esc(m.material)}${m.quality ? ` · ${esc(m.quality)}` : ''}</strong>
    <span>${fmt(m.unitCost)}/kg · ${esc(m.costBasis || 'recorded cost')} · ${esc(m.sourceTrip)}</span>
  </div>`;
}

export function priceResultMarkup() {
  const p = ui.price;
  const m = selectedMaterial();
  const weight = Number(p?.weight) || 0;
  const multiplier = Number(p?.multiplier) || 0;
  if (!m || !(weight > 0) || !(multiplier > 0)) return '<p class="sub">Select a material and enter the piece weight to see a price.</p>';
  const cost = m.unitCost * weight;
  const raw = cost * multiplier;
  const tag = tagPrice(raw);
  const ending = raw < 200 ? 'Nearest 3/7 tag price' : 'Rounded whole-dollar price';
  return `<div class="price-result-card">
    <span>${ending}</span>
    <strong>${fmt(tag)}</strong>
    <p>${weight.toFixed(3)} kg × ${fmt(m.unitCost)}/kg = ${fmt(cost)} cost · ${multiplier}x = ${fmt(raw)}</p>
    <button class="btn small primary" data-action="price-copy" data-price="${tag}">Copy ${fmt(tag)}</button>
  </div>`;
}

function priceToolMarkup() {
  const p = ui.price;
  if (!p || p.loading) return `
    <h3>Price Tool</h3>
    <div class="card"><strong>Loading material costs...</strong><p class="sub">Refreshing the standardized purchase catalog from Google Sheets.</p></div>`;
  if (p.error && !p.materials?.length) return `
    <h3>Price Tool</h3>
    <div class="card"><strong>Could not load material costs</strong><p class="sub">${esc(p.error)}</p></div>
    <button class="btn primary" style="width:100%" data-action="price-refresh">Try again</button>`;
  const stamp = db.priceCatalog?.fetchedAt ? new Date(db.priceCatalog.fetchedAt).toLocaleString() : '';
  return `
    <h3>Price Tool</h3>
    <p class="sub">Material cost × weight × chosen markup. Prices under $200 land on the closest ending in 3 or 7.</p>
    ${p.error ? `<div class="banner">Using saved material costs. Refresh failed: ${esc(p.error)}</div>` : ''}
    <label>Find material</label>
    <input id="price-search" autocomplete="off" placeholder="Amethyst, ammonite, labradorite..." value="${esc(p.search || '')}">
    <div class="material-results" id="price-matches">${priceMatchesMarkup()}</div>
    <div id="price-selection">${priceSelectionMarkup()}</div>
    <label>Piece weight (KG)</label>
    <input id="price-weight" type="number" inputmode="decimal" min="0" step="0.001" placeholder="0.250" value="${esc(p.weight || '')}">
    <h2>Markup</h2>
    <div class="multiplier-grid">
      ${PRICE_MULTIPLIERS.map((x) => `<button class="multiplier ${p.multiplier === x ? 'sel' : ''}" data-action="price-multiplier" data-multiplier="${x}">${x}x</button>`).join('')}
    </div>
    <div id="price-result">${priceResultMarkup()}</div>
    <button class="btn" style="width:100%;margin-top:12px" data-action="price-refresh">Refresh material costs</button>
    ${stamp ? `<p class="sub" style="text-align:center">Saved on this phone: ${stamp}</p>` : ''}`;
}

export function renderPriceToolLive() {
  const matches = document.getElementById('price-matches');
  const selection = document.getElementById('price-selection');
  const result = document.getElementById('price-result');
  if (matches) matches.innerHTML = priceMatchesMarkup();
  if (selection) selection.innerHTML = priceSelectionMarkup();
  if (result) result.innerHTML = priceResultMarkup();
  document.querySelectorAll('[data-action="price-multiplier"]').forEach((el) => {
    el.classList.toggle('sel', Number(el.dataset.multiplier) === ui.price?.multiplier);
  });
}

/* ---------- render modal ---------- */

export function renderModal() {
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
  // MARKER_DAYEDIT_SETTINGS

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
      <p class="sub" style="text-align:center">Glowstone Booth v0.5.2</p>`;
  }

  if (ui.modal === 'insights') sheet = insightsMarkup();
  if (ui.modal === 'priceTool') sheet = priceToolMarkup();

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
