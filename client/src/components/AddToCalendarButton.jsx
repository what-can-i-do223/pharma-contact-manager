// ============================================================================
// AddToCalendarButton — "Add to Google Calendar" for a contact's due visit
// ============================================================================
//
// Reused by the Agenda rows and the contact detail page. Three terminal
// states: already-synced (shows a static "on calendar" chip), just-synced,
// and not-connected (shows a "Connect Google" link — the graceful path when
// the server answers 409 google_not_connected). Errors other than
// not-connected surface inline rather than throwing.
import { useState } from 'react';
import { api, ApiError } from '../api.js';

export default function AddToCalendarButton({ contact, onSynced }) {
  // Seed from the contact: if it already carries an event id, it's synced.
  const [status, setStatus] = useState(contact.calendar_event_id ? 'synced' : 'idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (status === 'synced') {
    return <span className="cal-chip synced">📅 On Google Calendar</span>;
  }

  if (status === 'not_connected') {
    return (
      <span className="cal-chip reconnect">
        <a href="/auth/google">Connect Google</a> to sync visits
      </span>
    );
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.addToCalendar(contact.id);
      setStatus('synced');
      if (onSynced) onSynced();
    } catch (err) {
      // The one expected non-success: Google isn't connected. Swap the button
      // for a reconnect link instead of showing it as a failure.
      if (err instanceof ApiError && err.status === 409 && err.payload?.code === 'google_not_connected') {
        setStatus('not_connected');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="cal-add">
      <button className="secondary cal-btn" disabled={busy} onClick={add}>
        {busy ? 'Adding…' : '📅 Add to Google Calendar'}
      </button>
      {error && <span className="error-inline"> {error}</span>}
    </span>
  );
}
