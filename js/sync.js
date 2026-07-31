function fingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function syncPayloadSignature(payload) {
  return JSON.stringify({
    endpoint: payload.syncUrl || '',
    auth: fingerprint(payload.token),
    days: payload.days || [],
    txns: payload.txns || [],
    deletes: payload.deletes || []
  });
}

export function isSafeDryRunResult(result) {
  return result?.ok === true
    && result.dryRun === true
    && Number(result.dryRunVersion) >= 1;
}

export function syncResultParts(result) {
  const parts = [
    `${result.days || 0} day(s) added`,
    `${result.daysUpdated || 0} day(s) updated`,
    `${result.txns || 0} txn(s) added`,
    `${result.txnsUpdated || 0} txn(s) updated`
  ];
  if (result.daysSkipped) parts.push(`${result.daysSkipped} day(s) skipped`);
  if (result.txnsSkipped) parts.push(`${result.txnsSkipped} txn(s) skipped`);
  if (result.deletesSkipped) parts.push(`${result.deletesSkipped} stale deletion(s) cancelled`);
  if (result.daysDeleted || result.txnsDeleted) {
    parts.push(`${result.daysDeleted || 0} day row(s) deleted`);
    parts.push(`${result.txnsDeleted || 0} txn row(s) deleted`);
  } else if (result.deleted) {
    parts.push(`${result.deleted} row(s) deleted`);
  }
  return parts;
}
