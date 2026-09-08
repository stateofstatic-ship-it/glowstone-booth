const TTL = 24 * 60 * 60 * 1000;
export const CLAIM_WINDOW_MS = 10000;
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
export function normalizeEmail(value) { return String(value ?? '').trim().toLowerCase(); }
export function pacificDay(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function eligibleEntries(entries, { date, now = Date.now(), cutoff = now, claimedIds = [], absentIds = [] }) {
  const current = stamp(now), limit = stamp(cutoff), seen = new Set(), excluded = new Set([...claimedIds, ...absentIds]);
  return [...entries].sort((a, b) => stamp(a.submittedAt) - stamp(b.submittedAt)).filter(entry => {
    const submitted = stamp(entry.submittedAt), email = normalizeEmail(entry.email);
    if (entry.expiresAt != null && !Number.isFinite(stamp(entry.expiresAt))) return false;
    if (!entry.id || !Number.isFinite(submitted) || submitted > current || submitted > limit || Math.min(submitted + TTL, entry.expiresAt == null ? Infinity : stamp(entry.expiresAt)) <= current || pacificDay(submitted) !== date || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || (entry.adult !== undefined && entry.adult !== true)) return false;
    if (seen.has(email)) return false;
    seen.add(email);
    return !excluded.has(entry.id);
  });
}
export function secureIndex(count, crypto = globalThis.crypto) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 0x100000000) throw new RangeError('A nonempty valid pool is required.');
  if (!crypto?.getRandomValues) throw new Error('Secure randomness is unavailable.');
  const ceiling = Math.floor(0x100000000 / count) * count, value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= ceiling);
  return value[0] % count;
}
export function createRound({ id, dayId, date, cutoff, entryIds }, entries, now = Date.now()) {
  if (!id || !dayId || !Number.isFinite(stamp(cutoff)) || stamp(cutoff) > stamp(now)) throw new Error('A valid round and cutoff are required.');
  const requested = entryIds ? new Set(entryIds) : null;
  return { id, dayId, date: date || pacificDay(stamp(cutoff)), cutoff, entryIds: eligibleEntries(entries, { date: date || pacificDay(stamp(cutoff)), cutoff, now }).filter(entry => !requested || requested.has(entry.id)).map(entry => entry.id), status: 'ready', selectedId: null, selectedAt: null, absentIds: [], results: [] };
}
export function selectWinner(round, entries, { now = Date.now(), claimedIds = [], crypto = globalThis.crypto } = {}) {
  if (round.status === 'selected') {
    const live = eligibleEntries(entries, { date: round.date || pacificDay(stamp(round.cutoff)), cutoff: round.cutoff, now });
    if (!live.some(entry => entry.id === round.selectedId)) throw new Error('The selected entry has expired. Prepare a new drawing.');
    return { ...round };
  }
  if (round.status !== 'ready') return { ...round };
  const frozen = new Set(round.entryIds);
  const pool = eligibleEntries(entries, { date: round.date || pacificDay(stamp(round.cutoff)), cutoff: round.cutoff, now, claimedIds, absentIds: round.absentIds }).filter(entry => frozen.has(entry.id));
  if (!pool.length) return { ...round, status: 'exhausted', selectedId: null, selectedAt: null };
  return { ...round, status: 'selected', selectedId: pool[secureIndex(pool.length, crypto)].id, selectedAt: now };
}
export function markOutcome(round, outcome, now = Date.now()) {
  if (round.status !== 'selected' || !round.selectedId) throw new Error('Select a winner first.');
  if (!['claimed', 'absent'].includes(outcome)) throw new Error('Invalid winner outcome.');
  if (outcome === 'absent' && stamp(now) - stamp(round.selectedAt) < CLAIM_WINDOW_MS) throw new Error('Wait 10 seconds before marking a no-show.');
  return { ...round, status: outcome === 'claimed' ? 'claimed' : 'ready', selectedId: outcome === 'claimed' ? round.selectedId : null, selectedAt: outcome === 'claimed' ? round.selectedAt : null, absentIds: outcome === 'absent' ? [...round.absentIds, round.selectedId] : [...round.absentIds], results: [...round.results, { entryId: round.selectedId, outcome, at: now }] };
}
export function publicName(entry) {
  const words = String(entry?.name ?? '').trim().split(/\s+/);
  const first = String(entry?.firstName ?? words[0] ?? '').trim(), initial = [...String(entry?.lastName ?? (words.length > 1 ? words.at(-1) : '')).trim()][0];
  return `${first}${initial ? ` ${initial}.` : ''}`.trim();
}
export function deriveMetrics(entries = [], rounds = []) {
  return { entries: entries.length, rounds: rounds.length, claimed: rounds.reduce((n, round) => n + round.results.filter(result => result.outcome === 'claimed').length, 0), absent: rounds.reduce((n, round) => n + round.results.filter(result => result.outcome === 'absent').length, 0) };
}
