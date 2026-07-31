// Parser for PayPal Zettle "Detailed sales report" / "Raw data" exports (.xlsx).
// Pure function: takes a SheetJS workbook + the XLSX lib, returns normalized transactions.
// Report facts (verified against 2025 and 2026 exports):
//  - one sheet; a header row starting with "Date" and containing "Receipt number"
//  - one row per line item; custom-amount sales have blank Name and qty 1
//  - "Date" and "Time" can both be the same Excel serial datetime
//  - "Subtotal" is the whole receipt subtotal repeated on every line item
//  - "Final price" and explicit tax are line-level amounts

const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

function serialWallTime(n) {
  const d = new Date(Math.round((n - EXCEL_EPOCH_OFFSET) * 86400 * 1000));
  const parts = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds()
  };
  parts.date = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  parts.time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  parts.ts = new Date(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second, parts.millisecond
  ).getTime();
  return parts;
}

function parseUsDate(str) {
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function parseTime(str) {
  const m = String(str).trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] || 0);
  const meridiem = String(m[4] || '').toUpperCase();
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return {
    hour,
    minute,
    second,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

export function parseZettleWorkbook(wb, XLSX) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const hdrIdx = rows.findIndex((r) => r && r[0] === 'Date' && r.includes('Receipt number'));
  if (hdrIdx === -1) throw new Error('No header row found — is this a Zettle sales report?');
  const col = Object.fromEntries(rows[hdrIdx].map((h, i) => [h, i]));
  const get = (r, name) => r[col[name]];

  // group line items into transactions by receipt number
  const byRcpt = new Map();
  for (const r of rows.slice(hdrIdx + 1)) {
    if (!r || get(r, 'Receipt number') == null || get(r, 'Receipt number') === '') continue;
    const rcpt = String(get(r, 'Receipt number'));

    const t = get(r, 'Time');
    let ts = null, date = null, time = null;
    if (typeof t === 'number') {
      const wall = serialWallTime(t);
      ts = wall.ts;
      date = wall.date;
      time = wall.time;
    } else {
      date = parseUsDate(get(r, 'Date'));
      const tm = parseTime(t);
      if (date && tm) {
        const [year, month, day] = date.split('-').map(Number);
        ts = new Date(year, month - 1, day, tm.hour, tm.minute, tm.second).getTime();
        time = tm.time;
      }
    }
    if (!date) continue;

    const price = Number(get(r, 'Price (USD)')) || 0;
    const discount = Number(get(r, 'Discount (USD)')) || 0;
    const subtotal = get(r, 'Subtotal (USD)');
    const fallbackNet = price - Math.abs(discount);
    const gross = Number(get(r, 'Final price (USD)')) || 0;
    const explicitTax = get(r, 'Total tax collected (USD)');
    const quantityRaw = Number(get(r, 'Quantity'));
    const quantity = Number.isFinite(quantityRaw) ? quantityRaw : 1;
    const line = {
      name: String(get(r, 'Name') ?? ''),
      variant: String(get(r, 'Variant') ?? ''),
      sku: String(get(r, 'SKU') ?? ''),
      quantity,
      gross,
      tax: explicitTax != null && explicitTax !== '' ? Number(explicitTax) || 0 : null
    };

    const key = `${date}#${rcpt}`;
    if (!byRcpt.has(key)) {
      byRcpt.set(key, {
        key, rcpt, date, time, ts, net: 0, gross: 0, tax: 0, items: 0,
        staff: String(get(r, 'Staff') ?? ''), lines: [],
        subtotalValues: [], fallbackNet: 0, explicitTax: 0, hasExplicitTax: false
      });
    }
    const txn = byRcpt.get(key);
    txn.gross += gross;
    txn.items += quantity;
    txn.fallbackNet += fallbackNet;
    txn.lines.push(line);
    if (subtotal != null && subtotal !== '') txn.subtotalValues.push(Number(subtotal) || 0);
    if (line.tax != null) {
      txn.explicitTax += line.tax;
      txn.hasExplicitTax = true;
    }
    if (ts && (!txn.ts || ts < txn.ts)) {
      txn.ts = ts;
      txn.time = time;
    }
  }

  const txns = [...byRcpt.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const t of txns) {
    t.gross = +t.gross.toFixed(2);
    if (t.hasExplicitTax) {
      t.tax = +t.explicitTax.toFixed(2);
      t.net = +(t.gross - t.tax).toFixed(2);
    } else {
      const uniqueSubtotals = [...new Set(t.subtotalValues.map((value) => +value.toFixed(2)))];
      const subtotalNet = uniqueSubtotals.length === 1
        ? uniqueSubtotals[0]
        : t.subtotalValues.reduce((sum, value) => sum + value, 0);
      t.net = +(t.subtotalValues.length ? subtotalNet : t.fallbackNet).toFixed(2);
      t.tax = +(t.gross - t.net).toFixed(2);
    }
    delete t.subtotalValues;
    delete t.fallbackNet;
    delete t.explicitTax;
    delete t.hasExplicitTax;
  }

  // per-date rollup for the import preview
  const days = [];
  for (const date of [...new Set(txns.map((t) => t.date))].sort()) {
    const d = txns.filter((t) => t.date === date);
    days.push({
      date,
      count: d.length,
      net: +d.reduce((s, t) => s + t.net, 0).toFixed(2),
      gross: +d.reduce((s, t) => s + t.gross, 0).toFixed(2),
      tax: +d.reduce((s, t) => s + t.tax, 0).toFixed(2)
    });
  }
  return { txns, days };
}

export function importEventKey(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases = {
    'bellevue arts fair': 'bam arts fair',
    'bellevue festival of the arts': 'bam arts fair'
  };
  return aliases[key] || key;
}

export function explicitCachedCatalogEntries(entries, metadata = {}) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    catalogVersion: entry.catalogVersion ?? metadata.version ?? null,
    catalogGeneratedAt: entry.catalogGeneratedAt || metadata.generatedAt || '',
    requiresExplicit: true,
    stale: true
  }));
}

function catalogSuggestion(entry) {
  const event = String(entry.event || '');
  return {
    id: String(entry.id || ''),
    event,
    canonicalEvent: String(entry.canonicalEvent || event),
    channel: String(entry.channel || 'Event'),
    expectedCard: entry.expectedCard === '' ? '' : Number(entry.expectedCard) || 0,
    requiresExplicit: entry.requiresExplicit === true,
    source: String(entry.source || ''),
    sourceSheet: String(entry.sourceSheet || ''),
    sourceRow: entry.sourceRow ?? '',
    sourceDate: String(entry.sourceDate || entry.date || ''),
    correctionBasis: String(entry.correctionBasis || ''),
    expectedCardSource: String(entry.expectedCardSource || ''),
    catalogVersion: Number(entry.catalogVersion) || null,
    catalogGeneratedAt: String(entry.catalogGeneratedAt || ''),
    stale: entry.stale === true
  };
}

function dayAgreesWithSuggestion(day, eventName, suggestion) {
  const canonicalEvent = day.importCatalog?.canonicalEvent || day.canonicalEvent || eventName;
  const eventAgrees = importEventKey(canonicalEvent) === importEventKey(suggestion.canonicalEvent || suggestion.event);
  if (!day.mappingOnly) return eventAgrees;
  const catalogId = String(day.importCatalog?.id || day.importCatalogId || '');
  return !!catalogId && catalogId === suggestion.id && eventAgrees;
}

export function buildZettleImportRows(parsedDays, existingDays, catalogEntries = [], events = []) {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  return parsedDays.map((summary) => {
    const candidates = existingDays
      .filter((day) => day.date === summary.date)
      .map((day) => ({
        dayId: day.id,
        eventId: day.eventId,
        eventName: String(eventsById.get(day.eventId)?.name || ''),
        cardTotal: Number(day.cardTotal) || 0,
        closed: !!day.closedAt,
        mappingOnly: day.mappingOnly === true,
        importCatalogId: String(day.importCatalog?.id || day.importCatalogId || ''),
        canonicalEvent: String(day.importCatalog?.canonicalEvent || eventsById.get(day.eventId)?.name || ''),
        catalogVersion: Number(day.importCatalog?.version) || null
      }));
    const suggestions = catalogEntries
      .filter((entry) => entry.date === summary.date)
      .map(catalogSuggestion)
      .filter((entry) => entry.id && entry.event);
    const catalogAgreesWithLocal = candidates.length === 1
      && suggestions.length === 1
      && dayAgreesWithSuggestion(candidates[0], candidates[0].eventName, suggestions[0]);
    const catalogConflict = candidates.length === 1
      && suggestions.length > 0
      && !catalogAgreesWithLocal;
    let choice = '';
    const mappingNeedsExplicitReview = candidates[0]?.mappingOnly
      && suggestions[0]?.requiresExplicit;
    if (
      candidates.length === 1
      && (!suggestions.length ? !candidates[0].mappingOnly : catalogAgreesWithLocal)
      && !mappingNeedsExplicitReview
    ) {
      choice = `day:${candidates[0].dayId}`;
    } else if (candidates.length === 0 && suggestions.length === 1 && !suggestions[0].requiresExplicit) {
      choice = `catalog:${suggestions[0].id}`;
    }
    return {
      ...summary,
      candidates,
      suggestions,
      catalogConflict,
      choice
    };
  });
}

export function planZettleImport(rows, existingDays, events, selections = {}) {
  const daysById = new Map(existingDays.map((day) => [day.id, day]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const operations = [];
  const errors = [];

  for (const row of rows) {
    const selection = selections[row.date] || {};
    const choice = String(selection.choice ?? row.choice ?? '');
    if (choice === 'skip') {
      operations.push({ date: row.date, kind: 'skip', summary: row });
      continue;
    }

    if (choice.startsWith('day:')) {
      const dayId = choice.slice(4);
      const day = daysById.get(dayId);
      if (!day || day.date !== row.date) {
        errors.push(`${row.date}: choose an existing day on the same date`);
        continue;
      }
      const duplicateDays = existingDays.filter(
        (item) => item.date === row.date && item.eventId === day.eventId
      );
      if (duplicateDays.length > 1) {
        errors.push(`${row.date}: duplicate days exist for the same event and must be resolved first`);
        continue;
      }
      operations.push({
        date: row.date,
        kind: 'day',
        dayId,
        replaceCard: !day.mappingOnly && !!selection.replaceCard,
        summary: row
      });
      continue;
    }

    if (choice.startsWith('catalog:')) {
      const suggestionId = choice.slice(8);
      const suggestion = (row.suggestions || []).find((entry) => entry.id === suggestionId);
      if (!suggestion || !suggestion.event) {
        errors.push(`${row.date}: choose a valid protected Sheet suggestion`);
        continue;
      }
      const matchingDays = existingDays.filter((day) => {
        if (day.date !== row.date) return false;
        const event = eventsById.get(day.eventId);
        return dayAgreesWithSuggestion(day, event?.name || '', suggestion);
      });
      if (matchingDays.length > 1) {
        errors.push(`${row.date}: duplicate days already match the protected Sheet suggestion`);
        continue;
      }
      if (matchingDays.length === 1) {
        operations.push({
          date: row.date,
          kind: 'day',
          dayId: matchingDays[0].id,
          replaceCard: false,
          summary: row
        });
        continue;
      }
      const mappingDays = existingDays.filter((day) => day.date === row.date && day.mappingOnly);
      if (mappingDays.length > 1) {
        errors.push(`${row.date}: multiple historical receipt mappings must be resolved before remapping`);
        continue;
      }
      if (mappingDays.length === 1) {
        if (!selection.remapCatalog) {
          errors.push(`${row.date}: explicitly confirm the historical receipt remap`);
          continue;
        }
        if (!mappingDays[0].closedAt) {
          errors.push(`${row.date}: an open mapping cannot be remapped`);
          continue;
        }
        operations.push({
          date: row.date,
          kind: 'remapCatalog',
          dayId: mappingDays[0].id,
          fromEvent: String(eventsById.get(mappingDays[0].eventId)?.name || ''),
          suggestion,
          summary: row
        });
        continue;
      }
      operations.push({
        date: row.date,
        kind: 'catalog',
        suggestion,
        summary: row
      });
      continue;
    }

    if (choice.startsWith('event:')) {
      const eventId = choice.slice(6);
      if (!eventsById.has(eventId)) {
        errors.push(`${row.date}: choose a valid event`);
        continue;
      }
      const duplicate = existingDays.find((day) => day.date === row.date && day.eventId === eventId);
      if (duplicate) {
        errors.push(`${row.date}: choose the existing day instead of creating a duplicate`);
        continue;
      }
      operations.push({ date: row.date, kind: 'event', eventId, summary: row });
      continue;
    }

    errors.push(`${row.date}: choose a destination or explicitly skip`);
  }

  return { ok: errors.length === 0, errors, operations };
}

export function zettleRemapIssues(txns, operation, existingTransactions) {
  if (operation?.kind !== 'remapCatalog') return [];
  const incoming = txns.filter((txn) => txn.date === operation.date);
  const stored = Object.entries(existingTransactions || {})
    .filter(([, txn]) => txn?.dayId === operation.dayId)
    .map(([key, txn]) => ({ ...txn, key: txn.key || key }));
  const issues = [];
  const incomingKeys = new Set(incoming.map((txn) => txn.key));
  const storedKeys = new Set(stored.map((txn) => txn.key));
  if (!incoming.length) issues.push(`${operation.date}: the remap contains no receipts`);
  if (incomingKeys.size !== incoming.length) issues.push(`${operation.date}: the remap contains duplicate receipt keys`);
  if (stored.length !== incoming.length || storedKeys.size !== incomingKeys.size) {
    issues.push(`${operation.date}: re-import the complete original receipt set before remapping`);
  }
  for (const txn of incoming) {
    const prior = existingTransactions?.[txn.key];
    if (!prior || prior.dayId !== operation.dayId) {
      issues.push(`${operation.date}: every receipt must already belong to the historical mapping`);
      continue;
    }
    if (prior.date !== operation.date || txn.date !== operation.date) {
      issues.push(`${operation.date}: receipt dates must remain locked during remapping`);
      continue;
    }
    if (!zettleTransactionMatches(prior, txn, operation.dayId)) {
      issues.push(`${operation.date}: stored receipt content differs from the re-imported report`);
    }
  }
  for (const key of storedKeys) {
    if (!incomingKeys.has(key)) {
      issues.push(`${operation.date}: re-import the complete original receipt set before remapping`);
      break;
    }
  }
  return [...new Set(issues)];
}

export function zettleImportConflicts(txns, operations, existingTransactions) {
  const destinations = new Map(operations.map((operation) => [operation.date, operation]));
  return txns.filter((txn) => {
    const existing = existingTransactions[txn.key];
    if (!existing) return false;
    const operation = destinations.get(txn.date);
    if (operation?.kind === 'remapCatalog') return existing.dayId !== operation.dayId;
    return operation?.kind === 'event'
      || operation?.kind === 'catalog'
      || (operation?.kind === 'day' && existing.dayId !== operation.dayId);
  });
}

export function zettleTransactionMatches(prior, incoming, dayId) {
  return !!prior
    && prior.dayId === dayId
    && prior.gross === incoming.gross
    && prior.net === incoming.net
    && prior.tax === incoming.tax
    && prior.time === incoming.time
    && prior.staff === incoming.staff;
}
