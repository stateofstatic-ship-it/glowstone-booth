// Parser for PayPal Zettle "Detailed sales report" / "Raw data" exports (.xlsx).
// Pure function: takes a SheetJS workbook + the XLSX lib, returns normalized transactions.
// Report facts (verified against a real export, June 2026):
//  - one sheet; a header row starting with "Date" and containing "Receipt number"
//  - one row per line item; custom-amount sales have blank Name and qty 1
//  - "Time" is an Excel serial datetime (date+time); "Date" is a text cell
//  - "Price"/"Subtotal" are pre-tax; "Final price" is what was collected (incl. sales tax)

const EXCEL_EPOCH_OFFSET = 25569; // days between 1899-12-30 and 1970-01-01

function serialToDate(n) {
  return new Date(Math.round((n - EXCEL_EPOCH_OFFSET) * 86400 * 1000));
}

function parseUsDate(str) {
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
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
    let ts = null, date = null;
    if (typeof t === 'number') {
      const d = serialToDate(t);
      ts = d.getTime();
      date = d.toISOString().slice(0, 10); // serial is booth wall time; UTC getters preserve it
    } else {
      date = parseUsDate(get(r, 'Date'));
      const tm = String(t ?? '').match(/(\d{1,2}):(\d{2})/);
      if (date && tm) ts = Date.UTC(...date.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)), Number(tm[1]), Number(tm[2]));
    }
    if (!date) continue;

    const price = Number(get(r, 'Price (USD)')) || 0;
    const discount = Number(get(r, 'Discount (USD)')) || 0;
    const subtotal = get(r, 'Subtotal (USD)');
    const net = subtotal != null && subtotal !== '' ? Number(subtotal) || 0 : price - discount;
    const gross = Number(get(r, 'Final price (USD)')) || 0;

    const key = `${date}#${rcpt}`;
    if (!byRcpt.has(key)) {
      byRcpt.set(key, { key, rcpt, date, ts, net: 0, gross: 0, items: 0, staff: String(get(r, 'Staff') ?? '') });
    }
    const txn = byRcpt.get(key);
    txn.net += net;
    txn.gross += gross;
    txn.items += Number(get(r, 'Quantity')) || 1;
    if (ts && (!txn.ts || ts < txn.ts)) txn.ts = ts;
  }

  const txns = [...byRcpt.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const t of txns) {
    t.net = +t.net.toFixed(2);
    t.gross = +t.gross.toFixed(2);
    t.tax = +(t.gross - t.net).toFixed(2);
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
