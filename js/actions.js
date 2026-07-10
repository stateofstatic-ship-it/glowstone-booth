import { db, ui, persist, showToast, fmt, fmtDate, fmtTime, activeDay, eventById, dayById, daySales, cashLogged, dayTotal, zettleTxnsFor } from './runtime.js';
import { uid, todayStr, replaceDb } from './store.js';
import { render, renderModal } from './views.js';
import { parseZettleWorkbook } from './zettle.js';

export function applyTheme() {
  document.documentElement.classList.toggle('dark', !!db.settings.dark);
}

export function logSale(amount, payType, category = null) {
  const day = activeDay();
  if (!day || !(amount > 0)) return;
  const sale = { id: uid(), dayId: day.id, ts: Date.now(), amount, payType, category };
  db.sales.push(sale);
  persist();
  navigator.vibrate?.(25);
  ui.undoId = sale.id;
  ui.modal = null;
  showToast(`Logged ${fmt(amount)} ${payType}${category ? ' · ' + category : ''}`, true);
  render();
}

export function startDayFor(eventId) {
  const ev = eventById(eventId);
  if (!ev) return;
  ev.lastUsed = Date.now();
  const day = { id: uid(), eventId, date: todayStr(), closedAt: null };
  db.days.push(day);
  db.activeDayId = day.id;
  persist();
  ui.modal = null;
  ui.forceHome = false;
  render();
}

export function padKey(state, k) {
  if (k === 'back') state.value = state.value.slice(0, -1);
  else if (k === '.') { if (!state.value.includes('.')) state.value = (state.value || '0') + '.'; }
  else {
    if (state.value.includes('.') && state.value.split('.')[1].length >= 2) return;
    if (state.value.replace('.', '').length >= 6) return;
    state.value = (state.value === '0' ? '' : state.value) + k;
  }
}

export function updateCloseCalc() {
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

export function submitClose(form) {
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
  persist();
  ui.modal = null;
  ui.forceHome = false;
  const perHr = day.hours ? ` · ${fmt(dayTotal(day) / day.hours)}/hr` : '';
  showToast(`Day closed: ${fmt(dayTotal(day))}${perHr}`);
  render();
  if (db.settings.syncUrl && db.settings.syncKey) syncNow(true);
}

export function updateDayEditCalc() {
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

export function submitDayEdit(form) {
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
  persist();
  ui.modal = null;
  showToast(day.closedAt ? 'Day updated — queued for next sync' : 'Day updated');
  render();
}

export function submitEvent(form) {
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
  persist();
  startDayFor(ev.id);
}

export function submitSettings(form) {
  const chips = form.chips.value.split(',').map((s) => parseFloat(s.trim())).filter((n) => n > 0).slice(0, 9);
  if (chips.length) db.settings.chips = chips;
  const cats = form.categories.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 24);
  if (cats.length) db.settings.categories = cats;
  db.settings.defaultFloat = parseFloat(form.floatCash.value) || 0;
  db.settings.dark = form.dark.checked;
  db.settings.syncUrl = form.syncUrl.value.trim();
  db.settings.syncKey = form.syncKey.value.trim();
  applyTheme();
  persist();
  ui.modal = null;
  showToast('Settings saved');
  render();
}
// MARKER_NEXT_CHUNK

/* ---------- Zettle import & backup restore ---------- */

let xlsxLoading = null;
export function ensureXLSX() {
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

export async function handleZettleFile(file, targetDayId = null) {
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
      ui.zimport = { ...parsed, txns, days: [match], matches: [{ ...match, day: target }], needsEvent: false, targetDayId };
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

export function applyZettleImport() {
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
  persist();
  const targetDayId = z.targetDayId || null;
  ui.dayEditId = targetDayId;
  ui.modal = targetDayId ? 'dayEdit' : null;
  ui.zimport = null;
  showToast(`Imported ${z.txns.length} card transactions${targetDayId ? ' into day' : ''}`);
  render();
}

export async function handleBackupFile(file) {
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

/* ---------- day deletion ---------- */

export function deleteDayPrompt(dayId) {
  const day = dayById(dayId);
  if (!day) return;
  const ev = eventById(day.eventId);
  const nSales = daySales(day).length;
  const nZtx = zettleTxnsFor(day).length;
  navigator.vibrate?.(60);
  const extra = day.synced ? '\n\nNote: this day was already synced — its row in Daily_Sales will be deleted on next sync.' : '';
  const msg = `Delete ${day.closedAt ? 'closed' : 'open'} day ${fmtDate(day.date)} · ${ev?.name || ''}?\n` +
    `${nSales} logged sale(s) and ${nZtx} imported card txn(s) will be removed.${extra}\n\nThis can't be undone.`;
  if (!confirm(msg)) return;
  db.sales = db.sales.filter((s) => s.dayId !== dayId);
  for (const k of Object.keys(db.zettle)) if (db.zettle[k].dayId === dayId) delete db.zettle[k];
  db.days = db.days.filter((d) => d.id !== dayId);
  if (db.activeDayId === dayId) db.activeDayId = null;
  if (ui.dayEditId === dayId) ui.dayEditId = null;
  if (day.synced) {
    db.tombstones = db.tombstones || [];
    db.tombstones.push({ type: 'day', date: day.date, event: ev?.name || '', at: Date.now(), synced: false });
  }
  ui.modal = null;
  persist();
  showToast('Day deleted');
  render();
}

export function openDayEdit(dayId) {
  if (ui.suppressDayClick) return;
  if (!dayById(dayId)) return;
  ui.dayEditId = dayId;
  ui.modal = 'dayEdit';
  render();
}

/* ---------- sheet sync ---------- */

export async function syncNow(auto) {
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) { if (!auto) showToast('Set the Sync URL and key in Settings first'); return; }
  const days = db.days.filter((d) => d.closedAt && !d.synced);
  const sales = db.sales.filter((s) => !s.synced);
  const ztx = Object.values(db.zettle).filter((z) => !z.synced);
  const tombstones = (db.tombstones || []).filter((t) => !t.synced);
  if (!days.length && !sales.length && !ztx.length && !tombstones.length) { if (!auto) showToast('Nothing new to sync'); return; }
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
    ],
    deletes: tombstones.map((t) => ({ type: t.type, date: t.date, event: t.event }))
  };
  if (!auto) showToast('Syncing…');
  try {
    const res = await fetch(syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'sync rejected');
    days.forEach((d) => { d.synced = true; });
    sales.forEach((s) => { s.synced = true; });
    ztx.forEach((z) => { z.synced = true; });
    tombstones.forEach((t) => { t.synced = true; });
    const parts = [
      `${out.days || 0} day(s) added`,
      `${out.daysUpdated || 0} day(s) updated`,
      `${out.txns || 0} txn(s) added`,
      `${out.txnsUpdated || 0} txn(s) updated`
    ];
    if (out.deleted) parts.push(`${out.deleted} row(s) deleted`);
    db.lastSync = { at: Date.now(), summary: parts.join(', ') };
    persist();
    showToast(`Synced: ${db.lastSync.summary}`);
    render();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  }
}

export async function loadInsights() {
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) {
    ui.modal = 'insights';
    ui.insights = null;
    render();
    return;
  }
  ui.modal = 'insights';
  ui.insights = { loading: true };
  render();
  try {
    const url = new URL(syncUrl);
    url.searchParams.set('token', syncKey);
    url.searchParams.set('action', 'insights');
    const res = await fetch(url.toString(), { method: 'GET' });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'insights rejected');
    ui.insights = out;
    render();
  } catch (err) {
    ui.insights = { error: err.message };
    render();
  }
}

export async function loadPriceMaterials() {
  const cached = db.priceCatalog?.materials || [];
  const prior = ui.price || {};
  ui.modal = 'priceTool';
  ui.price = {
    loading: !cached.length,
    materials: cached,
    search: prior.search || '',
    selectedId: prior.selectedId || '',
    weight: prior.weight || '',
    multiplier: prior.multiplier || 12,
    error: null
  };
  render();
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) {
    ui.price.loading = false;
    ui.price.error = 'Set the Sync URL and key in Settings first.';
    renderModal();
    return;
  }
  try {
    const url = new URL(syncUrl);
    url.searchParams.set('token', syncKey);
    url.searchParams.set('action', 'materials');
    const res = await fetch(url.toString(), { method: 'GET' });
    const out = await res.json();
    if (!out.ok || !Array.isArray(out.materials)) throw new Error(out.error || 'material list rejected');
    db.priceCatalog = { materials: out.materials, fetchedAt: Date.now() };
    persist();
    ui.price.materials = out.materials;
    ui.price.loading = false;
    ui.price.error = null;
    if (!out.materials.some((m) => m.id === ui.price.selectedId)) ui.price.selectedId = '';
    renderModal();
  } catch (err) {
    ui.price.loading = false;
    ui.price.error = err.message;
    renderModal();
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

export function exportJson() {
  download(`glowstone-backup-${todayStr()}.json`, JSON.stringify(db, null, 2), 'application/json');
}

export function exportSales() {
  const rows = [['date', 'event', 'time', 'amount', 'pay_type', 'category', 'notable'].join(',')];
  for (const s of db.sales) {
    const day = dayById(s.dayId);
    const ev = day && eventById(day.eventId);
    rows.push([day?.date, ev?.name, fmtTime(s.ts), s.amount, s.payType, s.category || '', s.category ? 'yes' : ''].map(csvCell).join(','));
  }
  download(`glowstone-sales-${todayStr()}.csv`, rows.join('\n'), 'text/csv');
}

export function exportDays() {
  const rows = [['date', 'event', 'venue_type', 'hours', 'card_total', 'drawer_cash', 'float', 'cash_actual', 'cash_logged', 'day_total', 'booth_fee', 'other_costs', 'notes'].join(',')];
  for (const d of db.days.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const ev = eventById(d.eventId);
    rows.push([d.date, ev?.name, ev?.venueType, d.hours ?? '', d.cardTotal ?? '', d.drawerCash ?? '', d.floatCash ?? '', d.cashActual ?? '', cashLogged(d), dayTotal(d) ?? '', ev?.boothFee ?? '', ev?.otherCosts ?? '', d.notes || ''].map(csvCell).join(','));
  }
  download(`glowstone-days-${todayStr()}.csv`, rows.join('\n'), 'text/csv');
}
