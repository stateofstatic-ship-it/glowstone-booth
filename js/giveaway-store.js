const TTL = 86400000;
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
function sanitize(state, now) {
  if (!state) return null;
  const entries = (state.entries || []).filter(entry => Number.isFinite(stamp(entry.submittedAt)) && stamp(entry.submittedAt) <= now && Math.min(stamp(entry.submittedAt) + TTL, entry.expiresAt == null ? Infinity : stamp(entry.expiresAt)) > now);
  const live = new Set(entries.map(entry => entry.id));
  const rounds = (state.rounds || []).map(round => ({ ...round, entryIds: round.entryIds.filter(id => live.has(id)), absentIds: round.absentIds.filter(id => live.has(id)), selectedId: live.has(round.selectedId) ? round.selectedId : null, selectedAt: live.has(round.selectedId) ? round.selectedAt : null, status: round.status === 'selected' && !live.has(round.selectedId) ? 'ready' : round.status, results: round.results.map(result => ({ ...result, entryId: live.has(result.entryId) ? result.entryId : null })) }));
  return { dayId: state.dayId, date: state.date, entries, rounds, lastSync: state.lastSync ?? null, expiresAt: entries.length ? Math.max(...entries.map(entry => stamp(entry.submittedAt) + TTL)) : now };
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Temporary storage is unavailable. Enable IndexedDB to use giveaways.'));
    const request = globalThis.indexedDB.open('glowstone_giveaways_v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error || new Error('Unable to open temporary storage.'));
    request.onblocked = () => reject(new Error('Temporary storage is blocked by another tab.'));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function updateTemporary(mutator, now = Date.now()) {
  now = stamp(now);
  if (!Number.isFinite(now)) throw new Error('A valid storage time is required.');
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result, failure;
    const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state'), request = store.get('current');
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure || tx.error || new Error('Unable to save temporary giveaway data.')); };
    request.onsuccess = () => {
      try {
        const updated = mutator(sanitize(request.result, now));
        if (updated?.then) throw new Error('Temporary storage mutations must be synchronous.');
        result = sanitize(updated, now);
        if (result) store.put(result, 'current'); else store.delete('current');
      } catch (error) { failure = error; tx.abort(); }
    };
  });
}
export function loadTemporary(now = Date.now()) { return updateTemporary(state => state, now); }
export function saveTemporary(state, now = Date.now()) { return updateTemporary(() => state, now); }
export function purgeTemporary(now = Date.now()) { return updateTemporary(state => state, now); }
