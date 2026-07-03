// Small date-formatting helpers shared by the list and detail views.
// No date library — the two formats this app needs are a dozen lines.

// "12 Mar 2026" — for absolute timestamps in the timeline.
export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// "₹9,986.00" with Indian digit grouping (₹1,00,000). The API sends money
// as exact NUMERIC strings; parseFloat here is display-only — no arithmetic
// is ever done on the result.
export function fmtINR(numericString) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(parseFloat(numericString ?? 0));
}

// "today" / "3d ago" / "2mo ago" — for the last-contacted column, where the
// rep thinks in "how long since I touched this person", not calendar dates.
export function timeAgo(iso) {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
