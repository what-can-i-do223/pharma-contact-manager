// Small presentational components shared by the list and detail views.
// Pure functions of their props — no state, no fetching.

// Human labels for the API's type codes. The API speaks 'hcp'; the UI says
// "Doctor" because that's what a rep calls them.
export const TYPE_LABELS = {
  hcp: 'Doctor',
  pharmacist: 'Pharmacist',
  procurement: 'Procurement',
};

// Each badge is a <span> whose CSS class encodes the value
// (badge type-hcp, badge status-active, ...) — the colors live in
// styles.css, so this file stays about structure, not appearance.

export function TypeBadge({ type }) {
  return <span className={`badge type-${type}`}>{TYPE_LABELS[type] ?? type}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

// The red overdue flag. Renders nothing when the contact isn't overdue —
// callers can drop it in unconditionally, keeping the table row markup flat.
// `is_overdue`/`days_overdue` come from the server (Phase 3a), so the UI
// never re-implements the tier-interval rule.
export function OverdueFlag({ contact }) {
  if (!contact.is_overdue) return null;
  return <span className="badge overdue">{contact.days_overdue}d overdue</span>;
}
