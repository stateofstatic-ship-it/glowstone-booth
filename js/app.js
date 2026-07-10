import { db, ui, $, fmt, persist, showToast } from './runtime.js';
import { render, renderModal, priceMatchesMarkup, priceResultMarkup, renderPriceToolLive } from './views.js';
import { tagPrice } from './pricing.js';
import { parseZettleWorkbook } from './zettle.js';
import {
  logSale, startDayFor, padKey, updateCloseCalc, submitClose, updateDayEditCalc, submitDayEdit, submitEvent, submitSettings,
  applyTheme, handleZettleFile, applyZettleImport, handleBackupFile, deleteDayPrompt, openDayEdit,
  syncNow, loadInsights, loadPriceMaterials, ensureXLSX, exportJson, exportSales, exportDays
} from './actions.js';

/* ---------- event wiring ---------- */

const handlers = {
  'go-home': () => { ui.forceHome = true; render(); },
  'go-day': () => { ui.forceHome = false; render(); },
  'insights-open': loadInsights,
  'insights-refresh': loadInsights,
  'price-open': loadPriceMaterials,
  'price-refresh': loadPriceMaterials,
  'price-material': (d) => { ui.price.selectedId = d.id; renderPriceToolLive(); },
  'price-multiplier': (d) => { ui.price.multiplier = Number(d.multiplier); renderPriceToolLive(); },
  'price-copy': async (d) => {
    const text = fmt(Number(d.price));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      showToast(`${text} copied`);
    }
    catch { showToast(`Suggested price: ${text}`); }
  },
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
    persist();
    $('#toast-root').innerHTML = '';
    render();
  },
  'void-sale': (d) => {
    const s = db.sales.find((x) => x.id === d.id);
    if (s && confirm(`Remove ${fmt(s.amount)} ${s.payType} sale?`)) {
      db.sales = db.sales.filter((x) => x.id !== d.id);
      persist();
      render();
    }
  },
  'close-open': () => { ui.modal = 'close'; render(); },
  'settings-open': () => { ui.modal = 'settings'; render(); },
  'modal-cancel': () => { ui.modal = null; render(); },
  'export-json': exportJson,
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
  if (e.target.id === 'price-search' && ui.price) {
    ui.price.search = e.target.value;
    const matches = document.getElementById('price-matches');
    if (matches) matches.innerHTML = priceMatchesMarkup();
  }
  if (e.target.id === 'price-weight' && ui.price) {
    ui.price.weight = e.target.value;
    const result = document.getElementById('price-result');
    if (result) result.innerHTML = priceResultMarkup();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'zettle-file' && e.target.files?.[0]) { handleZettleFile(e.target.files[0]); e.target.value = ''; }
  if (e.target.id === 'zettle-day-file' && e.target.files?.[0]) { handleZettleFile(e.target.files[0], ui.dayEditId); e.target.value = ''; }
  if (e.target.id === 'backup-file' && e.target.files?.[0]) { handleBackupFile(e.target.files[0]); e.target.value = ''; }
});

/* ---------- day deletion (long-press) ---------- */

let press = null;
function cancelPress() { if (press) { clearTimeout(press.t); press = null; } }
document.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('[data-day-id]');
  if (!row) return;
  cancelPress();
  press = {
    x: e.clientX, y: e.clientY,
    t: setTimeout(() => {
      ui.suppressDayClick = true;
      setTimeout(() => { ui.suppressDayClick = false; }, 500);
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
    ui.suppressDayClick = true;
    setTimeout(() => { ui.suppressDayClick = false; }, 500);
    cancelPress();
    deleteDayPrompt(row.dataset.dayId);
  }
});

/* ---------- boot ---------- */

applyTheme();
render();

window.__gs = { handleZettleFile, parseZettleWorkbook, ensureXLSX, syncNow, loadInsights, loadPriceMaterials, tagPrice };

const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isDev) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
}
navigator.storage?.persist?.();
