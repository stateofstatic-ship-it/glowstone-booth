export function participantSales(db, dayId) {
  return {
    cash: db.sales.filter(s => s.dayId === dayId && s.payType === 'cash' && s.giveawayParticipant === true).length,
    card: (db.giveaways?.[dayId]?.cardSales || []).length
  };
}

export function parseQrCsv(text, date) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i + 1] === '"' && quoted) { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      row.push(cell); if (row.some(v => v.trim())) rows.push(row);
      cell = ''; row = []; if (c === '\r' && text[i + 1] === '\n') i++;
    } else cell += c;
  }
  if (quoted) throw new Error('CSV contains an unfinished quoted field.');
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  const headers = (rows.shift() || []).map(v => v.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[_-]/g, ' '));
  const d = headers.indexOf('date'), t = headers.indexOf('total scans'), u = headers.indexOf('unique scans');
  if ([d, t, u].some(i => i < 0)) throw new Error('This export format is not supported yet. Use Date, Total Scans, Unique Scans columns, or enter the daily totals below.');
  const matches = rows.filter(r => r[d]?.trim() === date);
  if (matches.length !== 1) throw new Error('Choose an export with exactly one YYYY-MM-DD row for this selling day. Do not combine different QR codes or reporting periods.');
  return validateQrCounts(matches[0][t], matches[0][u], date, 'QRCG CSV');
}

export function validateQrCounts(total, unique, date, source = 'QRCG manual') {
  if (String(total).trim() === '' || String(unique).trim() === '') throw new Error('Enter both scan counts; leave unavailable data unrecorded.');
  const t = Number(total), u = Number(unique);
  if (![t, u].every(n => Number.isSafeInteger(n) && n >= 0) || u > t) throw new Error('Scan counts must be whole numbers, with unique scans no greater than total scans.');
  return { total: t, unique: u, date, source, recordedAt: Date.now() };
}

export function anonymousRound(round) {
  return {
    id: round.id, cutoff: round.cutoff, status: round.status, poolSize: round.entryIds.length,
    claimed: round.results.filter(r => r.outcome === 'claimed').length,
    absent: round.results.filter(r => r.outcome === 'absent').length
  };
}
