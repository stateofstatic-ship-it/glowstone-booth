import { db, ui, esc, activeDay, eventById, persist, showToast, fmtTime } from './runtime.js';
import { render } from './views.js';
import { createRound, selectWinner, markOutcome, publicName, eligibleEntries, pacificDay } from './giveaway-core.js';
import { loadTemporary, saveTemporary, updateTemporary } from './giveaway-store.js';
import { participantSales, parseQrCsv, validateQrCounts, anonymousRound } from './giveaway-metrics.js';

export const giveawayUI = { temp: null, busy: false, error: '', spinning: false, muted: false, setup: false, audience: false, booted: false, checkIdentity: false };
let audioContext, visualFrame, animationResolve, initialized = false, refreshInFlight = false, lastSweep = 0, nextRefreshAttempt = 0;
const HOURS_24 = 86400000;
const now = () => Date.now();
const gid = () => globalThis.crypto.randomUUID();
function giveawayDay() {
  return db.days.find(day => day.id === ui.giveawayDayId) || activeDay() || db.days.find(day => db.giveaways?.[day.id]?.formUrl && !db.giveaways[day.id].finishedAt) || db.days.filter(day => db.giveaways?.[day.id]).at(-1) || null;
}
function dayRecord(id = giveawayDay()?.id) {
  const record = db.giveaways?.[id] || {};
  const prior = Object.values(db.giveaways || {}).filter(item => item.formUrl).at(-1) || {};
  return { ...record, formUrl: record.formUrl || prior.formUrl, config: record.config || prior.config };
}
const currentRound = () => giveawayUI.temp?.rounds?.at(-1);
function privateNow() {
  const offset = Number(dayRecord().serverOffset) || 0;
  return now() + offset;
}
function patchDay(patch, id = giveawayDay()?.id) {
  if (!id) throw new Error('Start a selling day first.');
  const previous = db.giveaways;
  db.giveaways = { ...previous, [id]: { ...previous?.[id], ...patch } };
  if (!persist()) { db.giveaways = previous; throw new Error('The change was not saved. Free some storage and retry.'); }
}
function notifyError(error) {
  giveawayUI.error = error.name === 'AbortError' ? 'The request timed out. Your saved entries are safe. Retry before drawing.' : error.message;
  showToast(giveawayUI.error);
}
function dayPayload() {
  const day = giveawayDay();
  if (!day) throw new Error('Start a selling day in Ops first.');
  return { id: day.id, date: day.date, event: eventById(day.eventId)?.name || '' };
}
function connectionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The Google giveaway URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname !== 'script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
    throw new Error('Use the HTTPS Google Apps Script deployment URL ending in /exec, without query parameters.');
  }
  return url;
}
async function request(operation, extra = {}) {
  const { giveawayUrl, giveawayKey } = db.settings;
  if (!giveawayUrl || !giveawayKey) throw new Error('Save your Google giveaway connection below first.');
  const url = connectionUrl(giveawayUrl);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url.href, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, cache: 'no-store',
      body: JSON.stringify({ action: 'giveaway', operation, token: giveawayKey, day: dayPayload(), ...extra }),
      signal: controller.signal, credentials: 'omit', redirect: 'follow'
    });
    if (!response.ok) throw new Error('Google sync returned HTTP ' + response.status + '.');
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Google rejected the request.');
    if (result.version !== 1 || !Number.isFinite(result.serverTime)) throw new Error('Update the Google backend before using Giveaways. It did not return a complete giveaway response.');
    return result;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Could not reach Google. Reconnect and refresh before the next drawing.');
    throw error;
  } finally { clearTimeout(timer); }
}
function validatedEntries(out, dayId) {
  if (out.dayId !== dayId || !Array.isArray(out.entries)) throw new Error('The response belongs to a different day or contains an incomplete entry list.');
  const ids = new Set();
  return out.entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.name !== 'string' || typeof entry.email !== 'string' ||
        !Number.isFinite(entry.submittedAt) || !Number.isFinite(entry.expiresAt) || entry.expiresAt > entry.submittedAt + HOURS_24) {
      throw new Error('The entry list failed validation. The previous saved list is still in use.');
    }
    ids.add(entry.id);
    return { id: entry.id, name: entry.name.slice(0, 160), email: entry.email.slice(0, 254), submittedAt: entry.submittedAt, expiresAt: entry.expiresAt, optIn: entry.optIn === true, purpose: entry.purpose || '', interest: entry.interest || '' };
  });
}
async function acceptSnapshot(out, prepared = false) {
  const day = dayPayload(), entries = validatedEntries(out, day.id);
  if (prepared && (!out.round || !Number.isFinite(out.round.cutoff) || !Array.isArray(out.round.entryIds) ||
      out.round.entryIds.some(id => !entries.some(entry => entry.id === id)))) throw new Error('The drawing snapshot is incomplete. Retry preparation.');
  const temp = await updateTemporary(previous => {
    if (previous?.dayId && previous.dayId !== day.id && previous.entries.length) throw new Error('Close the previous giveaway day before downloading another day.');
    const rounds = previous?.dayId === day.id ? previous.rounds : [];
    const next = { dayId: day.id, date: day.date, entries, rounds, lastSync: out.serverTime };
    if (prepared && !rounds.some(r => r.id === out.round.id)) {
      next.rounds = [...rounds, createRound({ ...out.round, dayId: day.id, date: day.date }, entries, out.serverTime)];
    }
    return next;
  }, out.serverTime);
  giveawayUI.temp = temp;
  patchDay({
    formUrl: safeFormUrl(out.formUrl), accepting: out.accepting, serverMetrics: out.metrics || dayRecord().serverMetrics,
    lastSync: out.serverTime, serverOffset: out.serverTime - now(), cleanup: out.cleanup || dayRecord().cleanup,
    ...(out.config ? { config: out.config } : {})
  });
}
function safeFormUrl(url) {
  if (!url) return '';
  try { const u = new URL(url); return u.protocol === 'https:' && ['docs.google.com', 'forms.gle'].includes(u.hostname) ? u.href : ''; } catch { return ''; }
}
async function guarded(fn) {
  if (giveawayUI.busy || giveawayUI.spinning) return;
  giveawayUI.busy = true; giveawayUI.error = '';
  const toast = document.getElementById('toast-root'); if (toast) toast.textContent = '';
  render();
  try { await fn(); } catch (error) { notifyError(error); }
  finally { giveawayUI.busy = false; render(); paintWheel(); }
}
async function loadPrivate() {
  giveawayUI.temp = await loadTemporary(privateNow());
  giveawayUI.booted = true;
}
export async function openGiveaways() {
  const pending = db.days.find(day => db.giveaways?.[day.id]?.formUrl && !db.giveaways[day.id].finishedAt);
  ui.giveawayDayId = pending?.id || activeDay()?.id || ui.giveawayDayId;
  ui.view = 'giveaways'; giveawayUI.error = ''; giveawayUI.checkIdentity = false;
  render();
  try { await loadPrivate(); } catch (error) { notifyError(error); }
  render(); paintWheel();
  if (giveawayDay() && dayRecord().formUrl && !dayRecord().finishedAt && navigator.onLine !== false) refreshGiveaways();
}
export async function refreshGiveaways() {
  if (refreshInFlight || giveawayUI.busy || giveawayUI.spinning || !giveawayDay()) return;
  refreshInFlight = true;
  await guarded(async () => {
    await loadPrivate();
    const result = await request('refresh');
    await acceptSnapshot(result);
  });
  nextRefreshAttempt = now() + (giveawayUI.error ? 120000 : 1800000);
  refreshInFlight = false;
}
async function setupGiveaway(form) {
  const config = {
    sponsorAddress: form.sponsorAddress.value.trim(), prizeDescription: form.prizeDescription.value.trim(),
    prizeValue: Number(form.prizeValue.value), drawTimes: form.drawTimes.value.split(',').map(s => s.trim()).filter(Boolean)
  };
  await guarded(async () => {
    const result = await request('setup', { config });
    patchDay({ config, formUrl: safeFormUrl(result.formUrl), accepting: result.accepting });
    giveawayUI.setup = false;
    showToast('Entry form configured. Open entries when this selling day begins.');
  });
}
async function openEntries() {
  await guarded(async () => {
    const day = dayPayload();
    if (day.date !== pacificDay(privateNow())) throw new Error('Open entries only for today’s selling day.');
    const result = await request('open', { config: dayRecord().config });
    await acceptSnapshot(result);
    showToast('Entries are open. Use the entry form link as your QRCG destination.');
  });
}
async function prepareDrawing() {
  await guarded(async () => {
    await loadPrivate();
    const previous = currentRound();
    if (previous && ['ready', 'selected'].includes(previous.status)) throw new Error('Finish the current drawing before preparing another.');
    const pending = dayRecord().pendingRound || { id: gid() };
    if (!dayRecord().pendingRound) patchDay({ pendingRound: pending });
    const out = await request('prepare', { roundId: pending.id });
    await acceptSnapshot(out, true);
    patchDay({ pendingRound: null, rounds: giveawayUI.temp.rounds.map(anonymousRound) });
    // The frozen pool survives a failed reopen, which can be retried independently.
    try {
      const reopened = await request('reopen');
      patchDay({ accepting: reopened.accepting });
    } catch { patchDay({ accepting: false }); giveawayUI.error = 'Drawing ready; the form could not reopen. Use Reopen entries when the connection returns.'; }
  });
}
function ensureAudio() {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (Audio && !audioContext) audioContext = new Audio();
  audioContext?.resume?.().catch(() => {});
}
function tone(freq, duration = 0.06, volume = 0.06) {
  if (giveawayUI.muted || !audioContext) return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), start = audioContext.currentTime;
  oscillator.type = 'sine'; oscillator.frequency.value = freq;
  gain.gain.setValueAtTime(volume, start); gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination); oscillator.start(start); oscillator.stop(start + duration);
}
function celebrate() {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.3, 0.055), i * 110));
  if (giveawayUI.muted || !audioContext) return;
  const rate = audioContext.sampleRate, buffer = audioContext.createBuffer(1, rate * 2, rate), samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate, envelope = Math.max(0, 1 - t / 2);
    samples[i] = (Math.random() * 2 - 1) * Math.pow(Math.max(0, Math.sin(t * 87) * Math.sin(t * 53)), 5) * envelope * 0.25;
  }
  const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination); source.start();
}
async function spin() {
  if (giveawayUI.busy || giveawayUI.spinning) return;
  ensureAudio();
  try {
    await loadPrivate();
    const activeId = giveawayDay()?.id;
    let picked;
    const saved = await updateTemporary(state => {
      if (!state || state.dayId !== activeId) throw new Error('Prepare a drawing for the active selling day first.');
      const round = state.rounds.at(-1);
      if (!round || !['ready', 'selected'].includes(round.status)) throw new Error('Prepare and refresh a drawing first.');
      const claimedIds = state.rounds.flatMap(r => r.results.filter(result => result.outcome === 'claimed').map(result => result.entryId));
      picked = selectWinner(round, state.entries, { now: privateNow(), claimedIds });
      return { ...state, rounds: [...state.rounds.slice(0, -1), picked] };
    }, privateNow());
    giveawayUI.temp = saved;
    patchDay({ rounds: saved.rounds.map(anonymousRound) });
    if (picked.status === 'exhausted') { showToast('There are no eligible entries left in this drawing.'); render(); return; }
    giveawayUI.checkIdentity = false; giveawayUI.spinning = true; render();
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 500 : 6500, started = performance.now();
    const claimedIds = saved.rounds.flatMap(r => r.results.filter(result => result.outcome === 'claimed').map(result => result.entryId));
    const pool = eligibleEntries(saved.entries, { date: saved.date, now: privateNow(), cutoff: picked.cutoff, claimedIds, absentIds: picked.absentIds }).filter(e => picked.entryIds.includes(e.id));
    const index = Math.max(0, pool.findIndex(e => e.id === picked.selectedId));
    const target = Math.PI * 12 + (Math.PI * 2 - (index + 0.5) / Math.max(1, pool.length) * Math.PI * 2);
    let lastTick = -1;
    await new Promise(resolve => {
      animationResolve = resolve;
      const frame = t => {
        const progress = Math.min(1, (t - started) / duration), eased = 1 - Math.pow(1 - progress, 4);
        paintWheel(target * eased, pool);
        const tick = Math.floor(target * eased * 10);
        if (tick !== lastTick) { tone(440 + (tick % 4) * 70); lastTick = tick; }
        if (progress < 1) visualFrame = requestAnimationFrame(frame); else resolve();
      };
      visualFrame = requestAnimationFrame(frame);
    });
    animationResolve = null;
    giveawayUI.temp = await updateTemporary(state => {
      const rounds = state.rounds.slice(), latest = rounds.at(-1);
      if (latest?.id === picked.id && latest.status === 'selected' && latest.selectedId === picked.selectedId) rounds[rounds.length - 1] = { ...latest, selectedAt: privateNow() };
      return { ...state, rounds };
    }, privateNow());
    giveawayUI.spinning = false;
    if (document.visibilityState !== 'hidden') celebrate();
    render(); paintWheel(target, pool);
  } catch (error) { giveawayUI.spinning = false; notifyError(error); render(); paintWheel(); }
}
async function outcome(value) {
  await guarded(async () => {
    const state = await updateTemporary(previous => {
      if (!previous || previous.dayId !== giveawayDay()?.id) throw new Error('This drawing is no longer available.');
      const rounds = previous.rounds.slice(), round = rounds.at(-1);
      rounds[rounds.length - 1] = markOutcome(round, value, privateNow());
      return { ...previous, rounds };
    }, privateNow());
    giveawayUI.temp = state; giveawayUI.checkIdentity = false;
    patchDay({ rounds: state.rounds.map(anonymousRound) });
  });
}
async function finishDay() {
  if (!confirm('Close giveaway entries, save consenting contacts and anonymous totals to Google Drive, and delete the day’s entry details?')) return;
  await guarded(async () => {
    const out = await request('finish', { metrics: metricsPayload() });
    if (!out.cleanup || out.cleanup.complete !== true) throw new Error('Day-end cleanup is incomplete. Entry details have not been cleared from this phone. Retry close and export.');
    await saveTemporary(null, privateNow());
    giveawayUI.temp = null;
    patchDay({ accepting: false, finishedAt: out.serverTime, cleanup: out.cleanup, exports: out.exports, pendingRound: null, serverMetrics: out.metrics || dayRecord().serverMetrics });
    showToast('Giveaway day closed. Contacts and anonymous totals saved; entry details cleared.');
  });
}
function metricsPayload() {
  const record = dayRecord(), sales = participantSales(db, giveawayDay()?.id);
  return { sales, qr: record.qr || null, rounds: record.rounds || [] };
}
async function syncMetrics() {
  await guarded(async () => { await request('metrics', { metrics: metricsPayload() }); patchDay({ metricsSyncedAt: now() }); showToast('Anonymous giveaway totals saved to Google.'); });
}
export function markGiveawayCardSale() {
  try {
    const day = activeDay();
    if (!day) throw new Error('Start a selling day before marking a card sale.');
    const cardSales = [...(dayRecord(day.id).cardSales || []), { id: gid(), ts: now() }];
    patchDay({ cardSales }, day.id);
    showToast('Giveaway customer card sale marked. Tap Undo marker if needed.'); render();
  } catch (error) { notifyError(error); }
}
function undoCard() {
  try { const day = activeDay(); if (!day) return; patchDay({ cardSales: (dayRecord(day.id).cardSales || []).slice(0, -1) }, day.id); render(); } catch (error) { notifyError(error); }
}
async function importQr(file) {
  try { patchDay({ qr: parseQrCsv(await file.text(), dayPayload().date) }); showToast('Daily QRCG totals saved.'); render(); } catch (error) { notifyError(error); }
}
export function handleGiveawaySubmit(form) {
  if (form.id === 'giveaway-connection') {
    if (giveawayUI.busy || giveawayUI.spinning) return true;
    try {
      const giveawayUrl = connectionUrl(form.giveawayUrl.value.trim()).href;
      const changed = giveawayUrl !== db.settings.giveawayUrl;
      if (changed && Object.values(db.giveaways || {}).some(record => record.formUrl)) throw new Error('This phone already has a giveaway form. Keep its deployment URL when updating the Google backend.');
      const giveawayKey = form.giveawayKey.value.trim() || (!changed && db.settings.giveawayKey);
      if (!giveawayKey) throw new Error('Enter the key for this giveaway deployment.');
      const previous = db.settings;
      db.settings = { ...previous, giveawayUrl, giveawayKey };
      if (!persist()) { db.settings = previous; throw new Error('The connection was not saved. Free some storage and retry.'); }
      giveawayUI.error = '';
      showToast('Connection saved. Save the entry form to test Google.'); render();
    } catch (error) { notifyError(error); }
    return true;
  }
  if (form.id === 'giveaway-setup') { setupGiveaway(form); return true; }
  if (form.id === 'giveaway-qr') {
    try { patchDay({ qr: validateQrCounts(form.total.value, form.unique.value, dayPayload().date) }); showToast('Daily scan totals saved.'); render(); } catch (error) { notifyError(error); }
    return true;
  }
  return false;
}
export function handleGiveawayChange(target) {
  if (target.id === 'giveaway-day-select') { ui.giveawayDayId = target.value; giveawayUI.checkIdentity = false; giveawayUI.error = ''; render(); paintWheel(); }
  if (target.id === 'giveaway-next-sale') ui.giveawayNextSale = target.checked;
  if (target.id === 'giveaway-qr-file' && target.files?.[0]) { importQr(target.files[0]); target.value = ''; }
}
export const giveawayHandlers = {
  'giveaways-open': openGiveaways,
  'giveaways-close': () => { giveawayUI.audience = false; document.body.classList.remove('giveaway-audience-mode'); ui.view = 'booth'; render(); },
  'giveaway-setup-open': () => { giveawayUI.setup = !giveawayUI.setup; render(); },
  'giveaway-open': openEntries,
  'giveaway-refresh': refreshGiveaways,
  'giveaway-prepare': prepareDrawing,
  'giveaway-reopen': () => guarded(async () => { const out = await request('reopen'); patchDay({ accepting: out.accepting }); }),
  'giveaway-spin': spin,
  'giveaway-claimed': () => outcome('claimed'),
  'giveaway-absent': () => outcome('absent'),
  'giveaway-identity': () => { giveawayUI.checkIdentity = !giveawayUI.checkIdentity; render(); paintWheel(); },
  'giveaway-audience': () => { giveawayUI.audience = !giveawayUI.audience; document.body.classList.toggle('giveaway-audience-mode', giveawayUI.audience); giveawayUI.checkIdentity = false; render(); paintWheel(); },
  'giveaway-mute': () => { giveawayUI.muted = !giveawayUI.muted; render(); paintWheel(); },
  'giveaway-finish': finishDay,
  'giveaway-card': markGiveawayCardSale,
  'giveaway-card-undo': undoCard,
  'giveaway-metrics-sync': syncMetrics
};
export function giveawaySaleControls(day) {
  const count = dayRecord(day.id).cardSales?.length || 0;
  return '<div class="giveaway-sale-tools"><label class="giveaway-checkbox"><input type="checkbox" id="giveaway-next-sale"' + (ui.giveawayNextSale ? ' checked' : '') + '> Customer entered today’s giveaway <span class="sub">Next cash sale</span></label>' +
    '<div class="row2"><button class="btn small" data-action="giveaway-card">+ Giveaway customer · card</button><button class="btn small ghost" data-action="giveaways-open">Giveaways</button></div>' +
    (count ? '<p class="sub">' + count + ' card sale marker' + (count === 1 ? '' : 's') + ' · <button class="btn small ghost" data-action="giveaway-card-undo">Undo marker</button></p>' : '') + '</div>';
}
function metric(label, value) { return '<div class="gw-metric"><strong>' + esc(value ?? '—') + '</strong><span>' + esc(label) + '</span></div>'; }
function button(action, label, primary = false, disabled = false) {
  return '<button class="btn' + (primary ? ' primary' : '') + '" data-action="' + action + '"' + (disabled || giveawayUI.busy || giveawayUI.spinning ? ' disabled' : '') + '>' + label + '</button>';
}
function setupMarkup(record) {
  const c = record.config || {};
  return '<form id="giveaway-setup" class="card gw-form"><h2>Entry form setup</h2><p class="sub">Create or update your Google form. Use a business mailing address suitable for the public rules.</p>' +
    '<label>Sponsor mailing address<input name="sponsorAddress" required maxlength="250" value="' + esc(c.sponsorAddress || '') + '" autocomplete="street-address"></label>' +
    '<label>Crystal prize description<input name="prizeDescription" required maxlength="160" value="' + esc(c.prizeDescription || '') + '" placeholder="Describe the actual specimen"></label>' +
    '<label>Approximate prize value ($)<input name="prizeValue" required type="number" min="0.01" max="10000" step="0.01" value="' + esc(c.prizeValue || '') + '"></label>' +
    '<label>Announced daily draw times (24-hour, comma separated)<input name="drawTimes" required value="' + esc((c.drawTimes || ['12:00', '14:00', '16:00']).join(', ')) + '"></label>' +
    '<p class="sub">One free entry per adult per day. Must be present; 60 seconds to approach. Prize winners sit out the rest of the day. Announce extra drawings before their cutoffs.</p>' +
    '<button class="btn primary" type="submit"' + (giveawayUI.busy ? ' disabled' : '') + '>Save entry form</button></form>';
}
function connectionMarkup() {
  const configured = db.settings.giveawayUrl && db.settings.giveawayKey;
  return '<details class="card"' + (configured ? '' : ' open') + '><summary>Google giveaway connection</summary><form id="giveaway-connection" class="gw-form">' +
    '<p class="sub">Connect the new giveaway backend once on this phone.</p><label>Deployment URL<input name="giveawayUrl" type="url" required autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(db.settings.giveawayUrl || '') + '"></label>' +
    '<label>Giveaway key<input name="giveawayKey" type="password" autocomplete="off" placeholder="' + (configured ? 'Saved key — leave blank to keep' : 'Key from Google setup') + '"' + (configured ? '' : ' required') + '></label>' +
    '<button class="btn" type="submit"' + (giveawayUI.busy ? ' disabled' : '') + '>Save connection</button></form></details>';
}
function surveyMarkup(survey = {}) {
  return ['purpose', 'interest'].map(key => {
    const values = survey[key] || {}, total = Object.values(values).reduce((sum, n) => sum + Number(n || 0), 0);
    return '<div><h3>' + (key === 'purpose' ? 'Shopping purpose' : 'Material interest') + '</h3><p class="sub">' + total + ' optional answers</p>' +
      Object.entries(values).map(([label, count]) => '<div class="gw-survey-row"><span>' + esc(label) + '</span><strong>' + esc(count) + '</strong></div>').join('') + '</div>';
  }).join('');
}
export function giveawayMarkup() {
  const day = giveawayDay(), record = dayRecord(), state = giveawayUI.temp?.dayId === day?.id ? giveawayUI.temp : null;
  const round = state?.rounds.at(-1), selected = state?.entries.find(e => e.id === round?.selectedId && e.expiresAt > privateNow());
  const claimedIds = state?.rounds.flatMap(r => r.results.filter(result => result.outcome === 'claimed').map(result => result.entryId)) || [];
  const pool = state ? eligibleEntries(state.entries, { date: day.date, now: privateNow(), claimedIds }) : [];
  const selectedNow = round?.status === 'selected' && selected, canSpin = round?.status === 'ready';
  const countdown = selectedNow ? Math.max(0, Math.ceil((60000 - (privateNow() - round.selectedAt)) / 1000)) : 0;
  const audience = giveawayUI.audience;
  let html = '<section class="giveaway-screen' + (audience ? ' gw-audience' : '') + '"><div class="topbar"><button class="btn small ghost" data-action="giveaways-close">← Ops</button><div class="spacer"></div><button class="btn small ghost" data-action="giveaway-mute">' + (giveawayUI.muted ? 'Sound off' : 'Sound on') + '</button><button class="btn small ghost" data-action="giveaway-audience">' + (audience ? 'Controls' : 'Audience view') + '</button></div>' +
    '<div class="gw-heading"><p class="gw-eyebrow">GLOWSTONE · STUDIO GIVEAWAY</p><h1>A little natural wonder.</h1><p>' + esc(day ? eventById(day.eventId)?.name : 'Start a selling day in Ops to begin.') + '</p></div>';
  if (!audience) html += connectionMarkup();
  if (!day) return html + '</section>';
  if (!audience) html += '<label class="gw-day-select">Giveaway day<select id="giveaway-day-select">' + db.days.filter(d => d.id === activeDay()?.id || db.giveaways?.[d.id] || d.id === day.id).map(d => '<option value="' + esc(d.id) + '"' + (d.id === day.id ? ' selected' : '') + '>' + esc(d.date + ' · ' + (eventById(d.eventId)?.name || 'Event')) + '</option>').join('') + '</select></label>';
  if (giveawayUI.error && !audience) html += '<p class="banner gw-error" role="alert">' + esc(giveawayUI.error) + '</p>';
  if (!audience) html += '<div class="gw-sync-line" role="status"><span class="gw-dot' + (record.accepting ? ' open' : '') + '"></span>' +
    (giveawayUI.busy ? 'Working…' : record.accepting ? 'Entry form open' : 'Entry form closed or not configured') +
    '<span>' + (record.lastSync ? 'Last complete refresh ' + esc(fmtTime(record.lastSync)) : 'No completed refresh yet') + '</span></div>';
  html += '<div class="gw-stage"><div class="gw-pointer" aria-hidden="true"></div><canvas id="giveaway-wheel" width="720" height="720" aria-label="Giveaway wheel. Every eligible entry has an equal chance."></canvas><div class="gw-hub"><span>' + (giveawayUI.spinning ? 'Good luck' : selectedNow || round?.status === 'claimed' ? 'Selected' : pool.length) + '</span><small>' + (selectedNow || round?.status === 'claimed' ? 'GLOWSTONE' : 'eligible entries') + '</small></div></div>';
  html += '<div class="gw-result" aria-live="polite"><p class="gw-eyebrow">' + (giveawayUI.spinning ? 'THE WHEEL IS TURNING' : selectedNow ? 'IS OUR WINNER HERE?' : round?.status === 'claimed' ? 'A NEW HOME FOR THIS SPECIMEN' : 'CRYSTALS, COMMUNITY, A LITTLE LUCK') + '</p><h2>' +
    (giveawayUI.spinning ? 'Who will it be?' : selectedNow || round?.status === 'claimed' ? esc(publicName(selected)) : round?.status === 'exhausted' ? 'Everyone in this pool has been called.' : !pool.length ? 'No eligible entries yet.' : 'The next find could be yours.') + '</h2>' +
    (selectedNow ? '<p id="giveaway-countdown">' + (countdown ? countdown + ' seconds to approach' : 'Claim window elapsed') + '</p>' : '') + '</div>';
  if (canSpin) html += button('giveaway-spin', 'Spin the wheel', true);
  if (selectedNow && !audience) html += '<div class="row2">' + button('giveaway-claimed', 'Prize claimed', true) + button('giveaway-absent', 'Absent · redraw', false, countdown > 0) + '</div><button class="btn small ghost" data-action="giveaway-identity">Private identity check</button>' +
    (giveawayUI.checkIdentity ? '<p class="gw-private">Ask the winner to state the email they entered: <strong>' + esc(selected.email) + '</strong></p>' : '');
  if (audience) return html + '</section>';
  html += '<div class="card gw-actions"><h2>Run the next drawing</h2><p class="sub">Refresh and prepare closes the form briefly and saves a fixed entry pool. A failed refresh delays the draw.</p><div class="row2">' +
    button('giveaway-refresh', 'Refresh now', false, !record.formUrl) + button('giveaway-prepare', 'Refresh & prepare draw', true, !record.formUrl || ['ready', 'selected'].includes(round?.status)) +
    '</div><div class="row2">' + button('giveaway-open', 'Open entries', false, !record.formUrl || record.accepting) + button('giveaway-reopen', 'Reopen entries', false, !record.formUrl || record.accepting) + '</div>' +
    (record.formUrl ? '<p><a class="gw-form-link" href="' + esc(safeFormUrl(record.formUrl)) + '" target="_blank" rel="noopener noreferrer">Open entry form ↗</a></p><p class="sub">Set your QRCG dynamic code destination to this form. Customers need internet to submit.</p>' : '') +
    '<button class="btn small ghost" data-action="giveaway-setup-open">' + (record.formUrl ? 'Edit form and drawing times' : 'Set up Google entry form') + '</button></div>';
  if (giveawayUI.setup || !record.formUrl) html += setupMarkup(record);
  const m = record.serverMetrics || {}, sales = participantSales(db, day.id), summaries = record.rounds || [];
  html += '<div class="card"><h2>Today’s signal</h2><div class="gw-metrics">' +
    metric('Form submissions', m.submissions) + metric('Eligible registrations', m.eligible) + metric('Duplicate entries', m.duplicates) + metric('Email opt-ins', m.optIns) +
    metric('Marked cash sales', sales.cash) + metric('Marked card sales', sales.card) + metric('Prizes claimed', summaries.reduce((n, r) => n + r.claimed, 0)) + metric('No-shows', summaries.reduce((n, r) => n + r.absent, 0)) +
    metric('QR scans', record.qr?.total) + metric('QR unique devices', record.qr?.unique) + '</div><p class="sub">Marked sales are transactions involving entrants, not unique buyers or proof the giveaway caused a sale. QRCG recognizes devices, not people.</p>' + surveyMarkup(m.survey) +
    button('giveaway-metrics-sync', 'Save anonymous totals to Google', false, !record.formUrl) + '</div>';
  html += '<details class="card"><summary>QRCG scan totals</summary><p class="sub">Record this selling day’s counts from your dynamic code’s dashboard, using Pacific time. Leave unavailable counts blank. No automatic QRCG analytics connection is assumed.</p>' +
    '<form id="giveaway-qr" class="gw-form"><label>Total scans<input name="total" type="number" min="0" step="1" required value="' + esc(record.qr?.total ?? '') + '"></label><label>Unique devices<input name="unique" type="number" min="0" step="1" required value="' + esc(record.qr?.unique ?? '') + '"></label><button class="btn" type="submit">Save scan totals</button></form>' +
    '<label class="gw-file-label">Import a daily CSV<input type="file" id="giveaway-qr-file" accept=".csv,text/csv"></label><p class="sub">Supported columns: Date (YYYY-MM-DD), Total Scans, Unique Scans. Other export layouts need manual entry.</p></details>';
  html += '<div class="card"><h2>Close the giveaway day</h2><p class="sub">Save subscribers and anonymous totals to Drive, then clear entry identities from Google Forms and this phone. Expired identities are also cleared automatically.</p>' +
    button('giveaway-finish', 'Close, export & clear entries', false, !record.formUrl || record.finishedAt || selectedNow) +
    (record.cleanup ? '<p class="sub">Cleanup: ' + esc(record.cleanup.complete ? 'verified complete' : 'pending or incomplete') + '</p>' : '') +
    '<p class="sub">Google and QRCG retain their own service records under their privacy policies. This app does not promise forensic or provider-backup erasure.</p></div></section>';
  return html;
}
export function paintWheel(rotation, entries) {
  const canvas = document.getElementById('giveaway-wheel');
  if (!canvas?.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const round = currentRound(), state = giveawayUI.temp;
  const claimedIds = state?.rounds.flatMap(r => r.results.filter(result => result.outcome === 'claimed' && result.entryId !== round?.selectedId).map(result => result.entryId)) || [];
  const pool = (entries || (state ? eligibleEntries(state.entries, { date: state.date, now: privateNow(), cutoff: round?.cutoff || privateNow(), claimedIds, absentIds: round?.absentIds || [] }).filter(e => !round || round.entryIds.includes(e.id)) : [])).filter(e => e.expiresAt > privateNow());
  const count = Math.min(60, pool.length || 12), cx = 360, radius = 342;
  if (rotation === undefined) {
    const selected = pool.findIndex(e => e.id === round?.selectedId);
    rotation = selected >= 0 ? Math.PI * 2 - (selected + 0.5) / pool.length * Math.PI * 2 : 0;
  }
  ctx.clearRect(0, 0, 720, 720); ctx.save(); ctx.translate(cx, cx); ctx.rotate(rotation - Math.PI / 2);
  const colors = ['#384e43', '#d2a85a', '#654478', '#ecdcc2', '#456b68', '#9d7360'];
  for (let i = 0; i < count; i++) {
    const start = i * Math.PI * 2 / count, end = (i + 1) * Math.PI * 2 / count;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, radius, start, end); ctx.closePath(); ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.save(); ctx.rotate((start + end) / 2); ctx.translate(radius - 24, 0); ctx.textAlign = 'right'; ctx.fillStyle = [1, 3].includes(i % colors.length) ? '#29251f' : '#fff9e9';
    const angle = ((rotation - Math.PI / 2 + (start + end) / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (angle > Math.PI / 2 && angle < Math.PI * 1.5) { ctx.rotate(Math.PI); ctx.textAlign = 'left'; }
    ctx.font = '600 ' + (count <= 8 ? 34 : count > 24 ? 13 : 24) + 'px system-ui';
    const label = pool.length <= 60 && pool.length > 0 ? publicName(pool[i]).slice(0, 17) : '✦';
    ctx.fillText(label, 0, 6); ctx.restore();
  }
  ctx.restore(); ctx.beginPath(); ctx.arc(cx, cx, radius + 4, 0, Math.PI * 2); ctx.strokeStyle = '#dfc899'; ctx.lineWidth = 12; ctx.stroke();
}
export function initializeGiveaways() {
  if (initialized) return;
  initialized = true;
  loadPrivate().catch(error => { giveawayUI.error = error.message; });
  const timer = setInterval(async () => {
    if (document.visibilityState === 'hidden' || giveawayUI.spinning || giveawayUI.busy) return;
    try {
      const selected = giveawayUI.temp?.entries.find(e => e.id === currentRound()?.selectedId);
      if (now() - lastSweep >= 60000 || (selected && selected.expiresAt <= privateNow())) {
        const before = giveawayUI.temp?.entries.length;
        await loadPrivate(); lastSweep = now();
        if (before !== giveawayUI.temp?.entries.length && ui.view === 'giveaways') {
          giveawayUI.checkIdentity = false; render(); paintWheel();
        }
      }
      if (ui.view === 'giveaways') {
        const countdown = document.getElementById('giveaway-countdown'), round = currentRound();
        if (countdown && round?.status === 'selected') {
          const left = Math.max(0, Math.ceil((60000 - (privateNow() - round.selectedAt)) / 1000));
          countdown.textContent = left ? left + ' seconds to approach' : 'Claim window elapsed';
          const absent = document.querySelector('[data-action="giveaway-absent"]'); if (absent) absent.disabled = left > 0;
        }
      }
      if (giveawayDay() && dayRecord().formUrl && !dayRecord().finishedAt && now() >= nextRefreshAttempt && privateNow() - (dayRecord().lastSync || 0) >= 1800000 && navigator.onLine !== false) refreshGiveaways();
    } catch (error) { giveawayUI.error = error.message; }
  }, 1000);
  timer.unref?.();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { giveawayUI.checkIdentity = false; document.querySelector('.gw-private')?.remove(); return; }
    try { await loadPrivate(); if (ui.view === 'giveaways') { render(); paintWheel(); } } catch (error) { notifyError(error); }
    if (giveawayDay() && dayRecord().formUrl && !dayRecord().finishedAt) refreshGiveaways();
  });
  globalThis.addEventListener?.('pagehide', () => { cancelAnimationFrame(visualFrame); animationResolve?.(); giveawayUI.checkIdentity = false; });
}
