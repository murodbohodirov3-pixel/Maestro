// The QR at a master's mirror, as the app and the api see it (owner's
// decisions of 2026-10-21): a client who scanned it stays at the top of that
// master's visit form for two hours, or until a visit of his is recorded, so
// several scans of one shift do not pile up and get mixed.

export const MIRROR_SCAN_HOURS = 2;

// The newest scan of each client, newest first; a blocked card is left out,
// since no visit of his can be recorded.
export function latestScanPerClient(rows) {
  const seen = new Set();
  return [...(rows ?? [])]
    .filter((row) => row?.client?.id && row.client.lifecycle_status !== 'blocked')
    .sort((left, right) => String(right.scanned_at).localeCompare(String(left.scanned_at)))
    .filter((row) => {
      if (seen.has(row.client.id)) return false;
      seen.add(row.client.id);
      return true;
    });
}

// «только что», «5 мин назад», «1 ч 10 мин назад».
export function scannedAgo(scannedAt, now = new Date()) {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(scannedAt).getTime()) / 60000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} ч ${rest} мин назад` : `${Math.floor(minutes / 60)} ч назад`;
}
