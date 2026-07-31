import { db, ui, persist, showToast, fmt, fmtDate, fmtTime, activeDay, eventById, dayById, daySales, cashLogged, dayTotal, zettleTxnsFor } from './runtime.js';
import { uid, todayStr, replaceDb } from './store.js';
import { render, renderModal } from './views.js';
import {
  buildZettleImportRows,
  explicitCachedCatalogEntries,
  importEventKey,
  parseZettleWorkbook,
  planZettleImport,
  zettleImportConflicts,
  zettleRemapIssues,
  zettleTransactionMatches
} from './zettle.js';
import {
  buildIcs,
  calendarEntries,
  checklistTemplates,
  scheduledPlannerEvents,
  validatePlannerFeedResponse
} from './planner.js';
import { SUGGESTED_EVENTS } from './event-suggestions.js';
import { isSafeDryRunResult, syncPayloadSignature, syncResultParts } from './sync.js';

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
  if (day.mappingOnly) {
    showToast('Historical receipt mappings can only be corrected by reviewing the POS import again.');
    return;
  }
  const oldDate = day.date;
  const oldEventId = day.eventId;
  const oldEventName = eventById(oldEventId)?.name || '';
  const wasSynced = day.synced === true;
  const nextDate = form.date.value || day.date;
  const nextEventId = form.eventId.value;
  const importedTxns = zettleTxnsFor(day);
  if (nextDate !== oldDate && importedTxns.length) {
    showToast('Receipt dates come from the POS report. Delete and re-import this day to change its date.');
    return;
  }
  const logged = cashLogged(day);
  const float = parseFloat(form.floatCash.value) || 0;
  const drawerRaw = form.drawerCash.value.trim();
  const identityChanged = oldDate !== nextDate || oldEventId !== nextEventId;
  if (wasSynced && identityChanged) {
    db.tombstones = db.tombstones || [];
    const alreadyQueued = db.tombstones.some((item) =>
      !item.synced
      && item.type === 'day'
      && item.date === oldDate
      && item.event === oldEventName
    );
    if (!alreadyQueued) {
      db.tombstones.push({ type: 'day', date: oldDate, event: oldEventName, at: Date.now(), synced: false });
    }
  }
  day.eventId = nextEventId;
  day.date = nextDate;
  day.hours = parseFloat(form.hours.value) || 0;
  day.cardTotal = parseFloat(form.cardTotal.value) || 0;
  day.floatCash = float;
  day.drawerCash = drawerRaw === '' ? null : parseFloat(drawerRaw) || 0;
  day.cashActual = drawerRaw === '' ? logged : (parseFloat(drawerRaw) || 0) - float;
  day.notes = form.notes.value.trim();
  if (day.closedAt) day.synced = false;
  if (identityChanged) {
    daySales(day).forEach((s) => { s.synced = false; });
    importedTxns.forEach((z) => { z.synced = false; });
    if (importedTxns.length) db.syncReviewRequired = true;
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

function plannerEventById(id) {
  return db.plannerEvents.find((event) => event.id === id);
}

function plannerTaskById(id) {
  return db.plannerTasks.find((task) => task.id === id);
}

function plannerSnapshot() {
  return {
    events: JSON.parse(JSON.stringify(db.plannerEvents)),
    tasks: JSON.parse(JSON.stringify(db.plannerTasks))
  };
}

function persistPlannerChange(snapshot) {
  if (persist()) return true;
  db.plannerEvents = snapshot.events;
  db.plannerTasks = snapshot.tasks;
  return false;
}

function reconcileGeneratedTasks(event) {
  const templates = checklistTemplates(event, todayStr());
  const activeTemplateKeys = new Set(templates.map((template) => template.templateKey));
  const beforeCleanup = db.plannerTasks.length;
  db.plannerTasks = db.plannerTasks.filter((task) =>
    task.plannerEventId !== event.id || !task.templateKey || task.completedAt || task.templateEdited || activeTemplateKeys.has(task.templateKey));
  const counts = { added: 0, updated: 0, removed: beforeCleanup - db.plannerTasks.length };
  for (const { templateKey, title, dueDate, kind, priority } of templates) {
    const existing = db.plannerTasks.find((task) => task.plannerEventId === event.id && task.templateKey === templateKey);
    if (existing) {
      if (existing.templateEdited) continue;
      if (!existing.completedAt && (existing.title !== title || existing.dueDate !== dueDate || existing.kind !== kind || existing.priority !== priority)) {
        Object.assign(existing, { title, dueDate, kind, priority, updatedAt: Date.now() });
        counts.updated++;
      }
      continue;
    }
    db.plannerTasks.push({
      id: uid(),
      plannerEventId: event.id,
      title,
      kind,
      dueDate,
      priority,
      reminderDays: [14, 7, 2],
      completedAt: null,
      templateKey,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    counts.added++;
  }
  return counts;
}

export function submitPlannerEvent(form) {
  const name = form.eventName.value.trim();
  if (!name) return;
  const eventStart = form.eventStart.value;
  const eventEnd = form.eventEnd.value;
  if (eventEnd && !eventStart) {
    showToast('Add an event start date before the end date');
    return;
  }
  if (eventStart && eventEnd && eventEnd < eventStart) {
    showToast('Event end date cannot be before the start date');
    return;
  }
  const snapshot = plannerSnapshot();
  const now = Date.now();
  const existing = plannerEventById(ui.plannerEventId);
  const event = existing || { id: uid(), createdAt: now };
  event.name = name;
  event.city = form.city.value.trim();
  event.state = form.state.value.trim().toUpperCase();
  event.venueType = form.venueType.value;
  event.eventStart = eventStart;
  event.eventEnd = eventEnd;
  event.applicationDeadline = form.applicationDeadline.value;
  event.reminderDate = form.reminderDate.value;
  event.status = form.status.value;
  event.sourceUrl = form.sourceUrl.value.trim();
  event.luxuryFit = Number(form.luxuryFit.value) || 0;
  event.audienceFit = Number(form.audienceFit.value) || 0;
  event.homeDecorFit = Number(form.homeDecorFit.value) || 0;
  event.juriedArtFit = Number(form.juriedArtFit.value) || 0;
  event.eligibilityRisk = form.eligibilityRisk.value;
  event.evidence = form.evidence.value.trim();
  event.notes = form.notes.value.trim();
  event.updatedAt = now;
  if (!existing) db.plannerEvents.push(event);
  if (existing && db.plannerTasks.some((task) => task.plannerEventId === event.id && task.templateKey)) {
    reconcileGeneratedTasks(event);
  }
  if (!persistPlannerChange(snapshot)) return;
  ui.modal = null;
  ui.plannerEventId = event.id;
  ui.plannerFilter = 'all';
  showToast(existing ? 'Event plan updated' : 'Event plan added');
  render();
}

export function submitPlannerTask(form) {
  const title = form.taskTitle.value.trim();
  if (!title || !form.dueDate.value) return;
  const snapshot = plannerSnapshot();
  const now = Date.now();
  const existing = plannerTaskById(ui.plannerTaskId);
  const task = existing || { id: uid(), createdAt: now, completedAt: null };
  task.title = title;
  task.plannerEventId = form.plannerEventId.value;
  task.kind = form.kind.value;
  task.dueDate = form.dueDate.value;
  task.priority = form.priority.value;
  task.notes = form.notes.value.trim();
  task.reminderDays ??= [14, 7, 2];
  if (existing?.templateKey) task.templateEdited = true;
  task.updatedAt = now;
  if (!existing) db.plannerTasks.push(task);
  if (!persistPlannerChange(snapshot)) return;
  ui.modal = null;
  ui.plannerFilter = 'tasks';
  showToast(existing ? 'Task updated' : 'Task added');
  render();
}

export function addSuggestedPlannerEvent(suggestionId) {
  const suggestion = SUGGESTED_EVENTS.find((event) => event.suggestionId === suggestionId);
  if (!suggestion) return;
  const existing = db.plannerEvents.find((event) => event.sourceSuggestionId === suggestionId);
  if (existing) {
    if (!confirm('Apply the research bundled with this app version? Your status, fit scores, and personal notes will stay unchanged.')) return;
    const snapshot = plannerSnapshot();
    existing.sourceUrl = suggestion.sourceUrl;
    existing.deadlineVerifiedAt = suggestion.deadlineVerifiedAt;
    existing.timingNote = suggestion.timingNote;
    existing.evidence = suggestion.evidence;
    existing.eligibilityRisk = suggestion.eligibilityRisk;
    existing.researchNotes = suggestion.notes;
    existing.reminderDate = suggestion.reminderDate;
    existing.applicationDeadline = suggestion.applicationDeadline || '';
    existing.eventStart = suggestion.eventStart || '';
    existing.eventEnd = suggestion.eventEnd || '';
    existing.updatedAt = Date.now();
    if (!persistPlannerChange(snapshot)) return;
    showToast('Bundled research fields applied');
    render();
    return;
  }
  const snapshot = plannerSnapshot();
  const now = Date.now();
  const { notes: researchNotes, ...research } = suggestion;
  db.plannerEvents.push({
    ...research,
    id: uid(),
    sourceSuggestionId: suggestionId,
    researchNotes,
    notes: '',
    createdAt: now,
    updatedAt: now
  });
  if (!persistPlannerChange(snapshot)) return;
  showToast('Added to application pipeline');
  render();
}

export function togglePlannerTask(taskId) {
  const task = plannerTaskById(taskId);
  if (!task) return;
  const snapshot = plannerSnapshot();
  task.completedAt = task.completedAt ? null : Date.now();
  task.updatedAt = Date.now();
  if (!persistPlannerChange(snapshot)) return;
  render();
}

export function deletePlannerTaskPrompt(taskId) {
  const task = plannerTaskById(taskId);
  if (!task || !confirm(`Delete task "${task.title}"?`)) return;
  const snapshot = plannerSnapshot();
  db.plannerTasks = db.plannerTasks.filter((item) => item.id !== taskId);
  if (!persistPlannerChange(snapshot)) return;
  ui.modal = null;
  ui.plannerTaskId = null;
  showToast('Task deleted');
  render();
}

export function deletePlannerEventPrompt(eventId) {
  const event = plannerEventById(eventId);
  if (!event || !confirm(`Delete "${event.name}" and its linked tasks?`)) return;
  const snapshot = plannerSnapshot();
  db.plannerEvents = db.plannerEvents.filter((item) => item.id !== eventId);
  db.plannerTasks = db.plannerTasks.filter((task) => task.plannerEventId !== eventId);
  if (!persistPlannerChange(snapshot)) return;
  ui.modal = null;
  ui.plannerEventId = null;
  showToast('Event plan deleted');
  render();
}

export function addApplicationChecklist(eventId) {
  const event = plannerEventById(eventId);
  if (!event) return;
  const booked = ['accepted', 'booked'].includes(event.status);
  if (booked && !event.eventStart) {
    showToast('Add the event date before creating prep tasks');
    return;
  }
  const snapshot = plannerSnapshot();
  const counts = reconcileGeneratedTasks(event);
  if ((counts.added || counts.updated || counts.removed) && !persistPlannerChange(snapshot)) return;
  if (counts.added || counts.updated || counts.removed) {
    showToast(`Checklist: ${counts.added} added, ${counts.updated} updated, ${counts.removed} retired`);
  }
  else showToast('Checklist already up to date');
  ui.plannerFilter = 'tasks';
  render();
}

export function exportPlannerCalendar() {
  const activeEvents = db.plannerEvents.filter((event) => !['declined', 'skip', 'complete'].includes(event.status));
  const activeIds = new Set(activeEvents.map((event) => event.id));
  const calendarDb = {
    plannerEvents: activeEvents,
    plannerTasks: db.plannerTasks.filter((task) => !task.plannerEventId || activeIds.has(task.plannerEventId)),
    plannerFeed: db.plannerFeed
  };
  if (!calendarEntries(calendarDb).length) {
    showToast('Add a dated event or task first');
    return;
  }
  const ics = buildIcs(calendarDb);
  download(`glowstone-planner-${todayStr()}.ics`, ics, 'text/calendar;charset=utf-8');
  showToast('Calendar file downloaded');
}
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

async function loadImportCatalog() {
  const cached = Array.isArray(db.importCatalog?.dates)
    ? explicitCachedCatalogEntries(db.importCatalog.dates, db.importCatalog)
    : [];
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) {
    return {
      dates: cached,
      note: cached.length
        ? 'Using a saved protected Sheet catalog. Every cached suggestion requires explicit review.'
        : 'Protected Sheet suggestions are unavailable until Sync URL and key are configured.'
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const url = new URL(syncUrl);
    url.searchParams.set('token', syncKey);
    url.searchParams.set('action', 'importcatalog');
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`server returned HTTP ${res.status}`);
    const out = await res.json();
    const catalogVersion = Number(out.importCatalogVersion);
    const catalogGeneratedAt = String(out.generatedAt || '');
    if (!out.ok || catalogVersion < 2 || !catalogGeneratedAt || !Array.isArray(out.dates)) {
      throw new Error('Apps Script must be updated before historical suggestions are available');
    }
    const dates = out.dates.map((entry) => ({
      ...entry,
      catalogVersion,
      catalogGeneratedAt,
      stale: false
    }));
    db.importCatalog = {
      version: catalogVersion,
      generatedAt: catalogGeneratedAt,
      dates,
      fetchedAt: Date.now()
    };
    persist();
    return {
      dates,
      note: `Protected Sheet suggestions loaded for ${dates.length} recorded date(s).`
    };
  } catch (err) {
    return {
      dates: cached,
      note: cached.length
        ? `Protected Sheet refresh failed; saved suggestions require explicit review. ${err.message}`
        : `Protected Sheet suggestions unavailable. ${err.message}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleZettleFile(file, targetDayId = null) {
  try {
    showToast('Reading report…');
    const XLSX = await ensureXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parsed = parseZettleWorkbook(wb, XLSX);
    if (!parsed.txns.length) { showToast('No transactions found in that file'); return; }
    const catalog = targetDayId
      ? { dates: [], note: '' }
      : await loadImportCatalog();

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
      const row = buildZettleImportRows([match], db.days)[0];
      row.choice = `day:${target.id}`;
      ui.zimport = { ...parsed, txns, days: [match], matches: [row], targetDayId, error: null };
    } else {
      const matches = buildZettleImportRows(parsed.days, db.days, catalog.dates, db.events);
      ui.zimport = { ...parsed, matches, targetDayId: null, error: null, catalogNote: catalog.note };
    }
    ui.modal = 'zimport';
    render();
  } catch (err) {
    showToast('Import failed: ' + err.message);
  }
}

function importCatalogEvent(suggestion) {
  const name = suggestion.canonicalEvent || suggestion.event;
  const key = importEventKey(name);
  let event = db.events.find((item) => importEventKey(item.name) === key);
  if (event) return event;
  event = {
    id: uid(),
    name,
    venueType: 'Other',
    boothFee: 0,
    otherCosts: 0,
    taxRate: 0,
    lastUsed: 0,
    historicalOnly: true
  };
  db.events.push(event);
  return event;
}

function importCatalogSnapshot(suggestion) {
  return {
    id: String(suggestion.id || ''),
    version: Number(suggestion.catalogVersion) || null,
    generatedAt: String(suggestion.catalogGeneratedAt || ''),
    source: String(suggestion.source || ''),
    sourceSheet: String(suggestion.sourceSheet || ''),
    sourceRow: suggestion.sourceRow ?? '',
    sourceDate: String(suggestion.sourceDate || ''),
    channel: String(suggestion.channel || 'Event'),
    canonicalEvent: String(suggestion.canonicalEvent || suggestion.event || ''),
    correctionBasis: String(suggestion.correctionBasis || ''),
    expectedCardSource: String(suggestion.expectedCardSource || ''),
    stale: suggestion.stale === true
  };
}

function importMappingNote(snapshot) {
  const row = snapshot.sourceRow === '' ? '' : ` row ${snapshot.sourceRow}`;
  const source = [snapshot.source, snapshot.sourceSheet].filter(Boolean).join(' / ');
  return `POS mapping from ${source || 'protected Sheet catalog'}${row}`;
}

export function applyZettleImport() {
  const z = ui.zimport;
  if (!z) return;

  const selections = {};
  for (const row of z.matches) {
    const destination = document.querySelector(`[data-zimport-date="${row.date}"]`);
    const replace = document.querySelector(`[data-zimport-replace="${row.date}"]`);
    const remap = document.querySelector(`[data-zimport-remap="${row.date}"]`);
    const selection = {
      choice: destination?.value ?? row.choice ?? '',
      replaceCard: !!replace?.checked,
      remapCatalog: !!remap?.checked
    };
    selections[row.date] = selection;
    row.choice = selection.choice;
    row.replaceCard = selection.replaceCard;
    row.remapCatalog = selection.remapCatalog;
  }
  z.tenderConfirmed = !!document.getElementById('zimport-tender-confirm')?.checked;

  const plan = planZettleImport(z.matches, db.days, db.events, selections);
  if (!plan.ok) {
    z.error = plan.errors.length === 1
      ? plan.errors[0]
      : `${plan.errors.length} dates still need a valid destination or an explicit skip.`;
    renderModal();
    return;
  }
  if (!z.tenderConfirmed) {
    z.error = 'Confirm the tender warning before importing.';
    renderModal();
    return;
  }

  const conflicts = zettleImportConflicts(z.txns, plan.operations, db.zettle);
  if (conflicts.length) {
    z.error = `${conflicts.length} receipt(s) already belong to another day. Nothing was imported.`;
    renderModal();
    return;
  }
  const remaps = plan.operations.filter((operation) => operation.kind === 'remapCatalog');
  const remapIssues = remaps.flatMap((operation) => {
    const day = dayById(operation.dayId);
    const issues = zettleRemapIssues(z.txns, operation, db.zettle);
    if (!day || !day.mappingOnly || day.date !== operation.date || !day.closedAt) {
      issues.push(`${operation.date}: the source is not a closed historical receipt mapping`);
    }
    if (day && (daySales(day).length || db.activeDayId === day.id)) {
      issues.push(`${operation.date}: a selling day with app sales cannot be remapped as receipt history`);
    }
    return issues;
  });
  if (remapIssues.length) {
    z.error = [...new Set(remapIssues)].join(' ');
    renderModal();
    return;
  }
  if (remaps.length) {
    const summary = remaps.map((operation) =>
      `${fmtDate(operation.date)}: ${operation.fromEvent || 'existing mapping'} to ${operation.suggestion.canonicalEvent || operation.suggestion.event} (${operation.summary.count} receipts)`
    ).join('\n');
    if (!confirm(`Correct these historical receipt mappings?\n\n${summary}\n\nOnly Txn_Log event labels will be updated. No Daily_Sales totals will be published or deleted.`)) {
      return;
    }
  }

  const replacements = plan.operations
    .filter((operation) => operation.kind === 'day' && operation.replaceCard)
    .map((operation) => ({
      operation,
      day: dayById(operation.dayId)
    }))
    .filter(({ operation, day }) => day && Math.abs((Number(day.cardTotal) || 0) - operation.summary.gross) >= 0.005);
  if (replacements.length) {
    const delta = replacements.reduce(
      (sum, { operation, day }) => sum + operation.summary.gross - (Number(day.cardTotal) || 0),
      0
    );
    const direction = delta >= 0 ? `increase recorded day totals by ${fmt(delta)}` : `decrease recorded day totals by ${fmt(Math.abs(delta))}`;
    if (!confirm(`Replace saved card totals on ${replacements.length} day(s)? This will ${direction} while leaving cash unchanged.`)) {
      return;
    }
  }

  const before = JSON.parse(JSON.stringify(db));
  let imported = 0;
  let skipped = 0;
  for (const operation of plan.operations) {
    if (operation.kind === 'skip') {
      skipped += operation.summary.count;
      continue;
    }

    let day = ['day', 'remapCatalog'].includes(operation.kind) ? dayById(operation.dayId) : null;
    const catalogOperation = ['catalog', 'remapCatalog'].includes(operation.kind);
    const catalogEvent = catalogOperation ? importCatalogEvent(operation.suggestion) : null;
    const catalogSnapshot = catalogOperation ? importCatalogSnapshot(operation.suggestion) : null;
    let dayNeedsSync = operation.kind === 'event' || operation.kind === 'remapCatalog' || operation.replaceCard;
    if (operation.kind === 'remapCatalog') {
      day.eventId = catalogEvent.id;
      day.mappingOnly = true;
      day.importCatalogId = catalogSnapshot.id;
      day.importCatalog = catalogSnapshot;
      day.notes = importMappingNote(catalogSnapshot);
    }
    if (!day) {
      day = {
        id: uid(),
        eventId: catalogEvent?.id || operation.eventId,
        date: operation.date,
        closedAt: Date.now(),
        hours: 0,
        cardTotal: operation.summary.gross,
        cardNet: operation.summary.net,
        cardTax: operation.summary.tax,
        floatCash: 0,
        drawerCash: null,
        cashActual: 0,
        notes: operation.kind === 'catalog'
          ? importMappingNote(catalogSnapshot)
          : 'imported from Zettle',
        imported: true,
        mappingOnly: operation.kind === 'catalog',
        importCatalogId: operation.kind === 'catalog' ? operation.suggestion.id : '',
        importCatalog: operation.kind === 'catalog' ? catalogSnapshot : null,
        synced: operation.kind === 'catalog'
      };
      db.days.push(day);
    } else if (operation.replaceCard) {
      day.cardTotal = operation.summary.gross;
      day.cardNet = operation.summary.net;
      day.cardTax = operation.summary.tax;
      if (day.closedAt) day.synced = false;
    }

    for (const txn of z.txns.filter((item) => item.date === operation.date)) {
      const prior = db.zettle[txn.key];
      const unchangedForSync = zettleTransactionMatches(prior, txn, day.id);
      const forceResync = operation.kind === 'remapCatalog';
      if (forceResync || !unchangedForSync || !prior.synced) dayNeedsSync = true;
      db.zettle[txn.key] = {
        ...txn,
        dayId: day.id,
        ...(forceResync ? { synced: false } : unchangedForSync && prior.synced ? { synced: true } : {})
      };
      imported++;
    }
    if (dayNeedsSync && day.closedAt && !day.mappingOnly) day.synced = false;
  }
  db.syncReviewRequired = db.syncReviewRequired || Object.values(db.zettle).some((item) => !item.synced);
  if (!persist()) {
    for (const key of Object.keys(db)) delete db[key];
    Object.assign(db, before);
    render();
    return;
  }

  const targetDayId = z.targetDayId || null;
  ui.dayEditId = targetDayId;
  ui.modal = targetDayId ? 'dayEdit' : null;
  ui.zimport = null;
  showToast(`Imported ${imported} POS receipt(s)${skipped ? `; skipped ${skipped}` : ''}. Review Sheet sync before publishing.`);
  render();
}

export async function handleBackupFile(file) {
  try {
    const next = JSON.parse(await file.text());
    if (!next.version || !Array.isArray(next.days) || !Array.isArray(next.sales)) throw new Error('not a Glowstone backup file');
    const plannerEvents = Array.isArray(next.plannerEvents) ? next.plannerEvents.length : 0;
    const plannerTasks = Array.isArray(next.plannerTasks) ? next.plannerTasks.length : 0;
    const stats = `${next.events?.length ?? 0} sales events, ${next.days.length} days, ${next.sales.length} sales, ${plannerEvents} planner events, ${plannerTasks} planner tasks`;
    const plannerWarning = (db.plannerEvents.length || db.plannerTasks.length) && !plannerEvents && !plannerTasks
      ? ' Warning: this backup has no Planner data and will erase the current Planner.'
      : '';
    if (!confirm(`Replace ALL data on this device with the backup (${stats})? This cannot be undone.${plannerWarning}`)) return;
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
  if (day.mappingOnly) {
    showToast('Historical receipt mappings can only be corrected by reviewing the POS import again.');
    return;
  }
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
  const day = dayById(dayId);
  if (!day) return;
  if (day.mappingOnly) {
    showToast('Historical receipt mappings can only be corrected by reviewing the POS import again.');
    return;
  }
  ui.dayEditId = dayId;
  ui.modal = 'dayEdit';
  render();
}

/* ---------- sheet sync ---------- */

let syncRequestInFlight = false;

export function collectSyncBatch() {
  const { syncUrl, syncKey } = db.settings;
  const days = db.days.filter((d) => d.closedAt && !d.synced && !d.mappingOnly);
  const sales = db.sales.filter((s) => !s.synced);
  const ztx = Object.values(db.zettle).filter((z) => !z.synced);
  const tombstones = (db.tombstones || []).filter((t) => !t.synced);
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
      ...ztx.map((z) => ({ key: z.key, date: z.date, time: z.time || fmtTime(z.ts), event: evName(z.dayId), amount: z.gross, payType: 'card', category: '', source: 'zettle', net: z.net, tax: z.tax, staff: z.staff }))
    ],
    deletes: tombstones.map((t) => ({ type: t.type, date: t.date, event: t.event }))
  };
  return {
    syncUrl,
    days,
    sales,
    ztx,
    tombstones,
    payload,
    signature: syncPayloadSignature({ ...payload, syncUrl })
  };
}

function batchIsEmpty(batch) {
  return !batch.days.length && !batch.sales.length && !batch.ztx.length && !batch.tombstones.length;
}

async function postSync(syncUrl, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`server returned HTTP ${res.status}`);
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'sync rejected');
    return out;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function markBatchSynced(batch) {
  batch.days.forEach((item) => { item.synced = true; });
  batch.sales.forEach((item) => { item.synced = true; });
  batch.ztx.forEach((item) => { item.synced = true; });
  batch.tombstones.forEach((item) => { item.synced = true; });
}

function saveSyncResult(batch, out) {
  markBatchSynced(batch);
  const parts = syncResultParts(out);
  db.lastSync = { at: Date.now(), summary: parts.join(', ') };
  return persist();
}

export async function previewSync() {
  if (syncRequestInFlight) {
    showToast('A Sheet sync request is already running');
    return;
  }
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) {
    showToast('Set the Sync URL and key in Settings first');
    return;
  }
  const batch = collectSyncBatch();
  if (batchIsEmpty(batch)) {
    if (db.syncReviewRequired) {
      db.syncReviewRequired = false;
      persist();
    }
    showToast('Nothing new to sync');
    return;
  }
  showToast('Checking Google Sheets changes…');
  syncRequestInFlight = true;
  try {
    const out = await postSync(syncUrl, { ...batch.payload, dryRun: true });
    if (!isSafeDryRunResult(out)) {
      throw new Error('Apps Script must be updated before reviewed sync is available');
    }
    if (collectSyncBatch().signature !== batch.signature) {
      throw new Error('local data changed during preview; run it again');
    }
    ui.syncPreview = { batch, out, signature: batch.signature };
    ui.modal = 'syncPreview';
    render();
  } catch (err) {
    showToast('Sync preview failed: ' + err.message);
  } finally {
    syncRequestInFlight = false;
  }
}

export async function confirmSync() {
  if (syncRequestInFlight) {
    showToast('A Sheet sync request is already running');
    return;
  }
  const preview = ui.syncPreview;
  if (!preview) return;
  const current = collectSyncBatch();
  if (current.signature !== preview.signature) {
    ui.syncPreview = null;
    ui.modal = 'settings';
    showToast('Pending data changed. Run the sync preview again.');
    render();
    return;
  }
  showToast('Syncing reviewed changes…');
  syncRequestInFlight = true;
  try {
    const out = await postSync(preview.batch.syncUrl, { ...preview.batch.payload, dryRun: false });
    if (out.dryRun === true) throw new Error('server did not commit the reviewed changes');
    if (collectSyncBatch().signature !== preview.signature) {
      ui.syncPreview = null;
      ui.modal = 'settings';
      showToast('Sheet received the reviewed snapshot, but local data changed during sync. Preview again.');
      render();
      return;
    }
    db.syncReviewRequired = false;
    const saved = saveSyncResult(preview.batch, out);
    ui.syncPreview = null;
    ui.modal = 'settings';
    showToast(saved
      ? `Synced: ${db.lastSync.summary}`
      : 'Sheet sync succeeded, but local status was not saved. Export a backup before reloading.');
    render();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  } finally {
    syncRequestInFlight = false;
  }
}

export async function syncNow(auto) {
  if (!auto) return previewSync();
  if (syncRequestInFlight) return;
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) return;
  if (db.syncReviewRequired) {
    showToast('POS imports are waiting for reviewed Sheet sync in Settings');
    return;
  }
  const batch = collectSyncBatch();
  if (batchIsEmpty(batch)) return;
  syncRequestInFlight = true;
  try {
    const out = await postSync(syncUrl, { ...batch.payload, dryRun: false });
    if (collectSyncBatch().signature !== batch.signature) {
      showToast('Sheet received the snapshot, but local data changed during sync. Review it in Settings.');
      render();
      return;
    }
    const saved = saveSyncResult(batch, out);
    showToast(saved
      ? `Synced: ${db.lastSync.summary}`
      : 'Sheet sync succeeded, but local status was not saved. Export a backup before reloading.');
    render();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  } finally {
    syncRequestInFlight = false;
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

let plannerFeedRequestInFlight = false;

export async function loadPlannerFeed({ manual = false } = {}) {
  if (plannerFeedRequestInFlight) {
    if (manual) showToast('Events_Master is already refreshing');
    return;
  }
  const { syncUrl, syncKey } = db.settings;
  if (!syncUrl || !syncKey) {
    ui.plannerFeedLoading = false;
    ui.plannerFeedError = 'Set the Sync URL and key in Settings to load Events_Master.';
    if (manual) showToast('Set the Sync URL and key in Settings first');
    if (ui.view === 'planner') render();
    return;
  }

  plannerFeedRequestInFlight = true;
  ui.plannerFeedLoading = true;
  ui.plannerFeedError = '';
  if (ui.view === 'planner') render();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const url = new URL(syncUrl);
    url.searchParams.set('token', syncKey);
    url.searchParams.set('action', 'events');
    const res = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`server returned HTTP ${res.status}`);
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'Events_Master request was rejected');
    const validated = validatePlannerFeedResponse(out);
    const previous = db.plannerFeed;
    db.plannerFeed = { ...validated, fetchedAt: Date.now() };
    if (!persist()) {
      db.plannerFeed = previous;
      throw new Error('the refreshed schedule could not be saved on this device');
    }
    ui.plannerFeedError = '';
    if (manual) {
      const count = scheduledPlannerEvents(db).length;
      showToast(`Events_Master refreshed: ${count} scheduled event${count === 1 ? '' : 's'}`);
    }
  } catch (err) {
    const hasSavedSchedule = Boolean(
      db.plannerFeed?.fetchedAt ||
      (Array.isArray(db.plannerFeed?.events) && db.plannerFeed.events.length)
    );
    const fallback = hasSavedSchedule
      ? 'The saved schedule is still in use.'
      : 'No saved schedule is available yet.';
    ui.plannerFeedError = err.name === 'AbortError'
      ? `Events_Master refresh timed out. ${fallback}`
      : `Events_Master refresh failed: ${err.message}. ${fallback}`;
    if (manual) showToast(hasSavedSchedule
      ? 'Could not refresh Events_Master; saved schedule kept'
      : 'Could not load Events_Master; try again online');
  } finally {
    clearTimeout(timeout);
    plannerFeedRequestInFlight = false;
    ui.plannerFeedLoading = false;
    if (ui.view === 'planner') render();
  }
}

export async function loadPriceMaterials() {
  const cached = db.priceCatalog?.materials || [];
  const prior = ui.price || {};
  const source = cached.some((m) => m.sourceTrip === prior.source) ? prior.source : '';
  ui.modal = 'priceTool';
  ui.price = {
    loading: !cached.length,
    materials: cached,
    search: prior.search || '',
    source,
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
    if (!out.materials.some((m) => m.sourceTrip === ui.price.source)) ui.price.source = '';
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

export function buildDaysCsv() {
  const rows = [['date', 'event', 'venue_type', 'hours', 'card_total', 'drawer_cash', 'float', 'cash_actual', 'cash_logged', 'day_total', 'booth_fee', 'other_costs', 'notes'].join(',')];
  for (const d of db.days.filter((day) => !day.mappingOnly).sort((a, b) => a.date.localeCompare(b.date))) {
    const ev = eventById(d.eventId);
    rows.push([d.date, ev?.name, ev?.venueType, d.hours ?? '', d.cardTotal ?? '', d.drawerCash ?? '', d.floatCash ?? '', d.cashActual ?? '', cashLogged(d), dayTotal(d) ?? '', ev?.boothFee ?? '', ev?.otherCosts ?? '', d.notes || ''].map(csvCell).join(','));
  }
  return rows.join('\n');
}

export function exportDays() {
  download(`glowstone-days-${todayStr()}.csv`, buildDaysCsv(), 'text/csv');
}
