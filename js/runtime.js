import { load, save } from './store.js';

export const db = load();
export const ui = { modal: null, forceHome: false, pad: null, notable: null, undoId: null, toastTimer: null, zimport: null, dayEditId: null, insights: null, price: null, suppressDayClick: false };

export function persist() {
  try { save(db); return true; }
  catch { showToast('Storage full — action NOT saved. Export a backup now.'); return false; }
}

/* ---------- helpers ---------- */

export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const eventById = (id) => db.events.find((e) => e.id === id);
export const dayById = (id) => db.days.find((d) => d.id === id);
export const activeDay = () => (db.activeDayId ? dayById(db.activeDayId) : null);
export const daySales = (day) => db.sales.filter((s) => s.dayId === day.id);
export const cashLogged = (day) => daySales(day).filter((s) => s.payType === 'cash').reduce((t, s) => t + s.amount, 0);
export const dayTotal = (day) => (day.closedAt ? (day.cardTotal || 0) + (day.cashActual || 0) : null);
export const zettleTxnsFor = (day) => Object.values(db.zettle).filter((z) => z.dayId === day.id);
export const pct = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';

/* ---------- toast ---------- */

export function showToast(msg, withUndo) {
  clearTimeout(ui.toastTimer);
  $('#toast-root').innerHTML = `
    <div class="toast">${esc(msg)}${withUndo ? '<button data-action="undo">UNDO</button>' : ''}</div>`;
  ui.toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, withUndo ? 6000 : 3000);
}
