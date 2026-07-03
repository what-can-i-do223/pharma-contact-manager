// ============================================================================
// ContactDetail — one contact: all fields, edit panel, timeline, log form
// ============================================================================
//
// Data flow: load() fetches the full contact (incl. activities) and every
// mutation (save edits, log activity) simply calls load() again afterwards —
// re-fetching beats hand-patching local state into agreement with the
// server, and at one-contact size the extra GET is free. The server is the
// single source of truth; this component just renders it.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, timeAgo } from '../format.js';
import { TypeBadge, StatusBadge, OverdueFlag } from '../components/Badges.jsx';
import TypeDetailFields from '../components/TypeDetailFields.jsx';

const STATUSES = ['lead', 'active', 'dormant', 'closed'];
const TIERS = ['A', 'B', 'C'];

// Human labels for timeline entry kinds.
const KIND_LABELS = { note: 'Note', visit: 'Visit', call: 'Call', status_change: 'Status' };

export default function ContactDetail({ id }) {
  const [contact, setContact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setContact(await api.getContact(id));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    // `id` can change without unmounting (list → back → other contact).
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error-banner">Couldn’t load contact: {error}</p>;

  return (
    <section>
      <a href="#/" className="muted">← All contacts</a>

      <div className="detail-head">
        <h1>{contact.full_name}</h1>
        <TypeBadge type={contact.contact_type} />
        <StatusBadge status={contact.status} />
        <span className="badge tier-badge">Tier {contact.tier}</span>
        <OverdueFlag contact={contact} />
      </div>

      <div className="detail-grid">
        <Facts contact={contact} />
        <EditPanel contact={contact} onSaved={load} />
      </div>

      <h2>Timeline</h2>
      <LogActivityForm contactId={id} onLogged={load} />
      <Timeline activities={contact.activities} />
    </section>
  );
}

// ── Read-only facts card ─────────────────────────────────────────────────────
function Facts({ contact }) {
  const d = contact.details;
  return (
    <dl className="facts">
      <dt>Phone</dt>
      <dd>{contact.phone ?? '—'}</dd>
      <dt>Email</dt>
      <dd>{contact.email ?? '—'}</dd>
      <dt>City</dt>
      <dd>{contact.city}</dd>
      <dt>Workplace</dt>
      <dd>
        {contact.workplace
          ? `${contact.workplace.name} (${contact.workplace.kind}, ${contact.workplace.city})`
          : '—'}
      </dd>

      {/* Type-specific facts — exactly one of these blocks applies. */}
      {contact.contact_type === 'hcp' && (
        <>
          <dt>Specialty</dt>
          <dd>{d.specialty}</dd>
          <dt>Role</dt>
          <dd>{d.role ?? '—'}</dd>
        </>
      )}
      {contact.contact_type === 'pharmacist' && (
        <>
          <dt>Ownership</dt>
          <dd>{d.is_owner ? 'Owner' : 'Staff pharmacist'}</dd>
        </>
      )}
      {contact.contact_type === 'procurement' && (
        <>
          <dt>Purchasing role</dt>
          <dd>{d.purchasing_role}</dd>
        </>
      )}

      <dt>Last visit</dt>
      <dd>{timeAgo(contact.last_visit_at)}</dd>
      <dt>Next visit due</dt>
      <dd>{fmtDate(contact.next_visit_due)}</dd>
    </dl>
  );
}

// ── Edit panel: status / tier / type-specific details ───────────────────────
// Local draft state, initialized from the contact; nothing touches the
// server until Save. Sending the unchanged status is harmless — the API
// only logs a status_change activity on a REAL transition (Phase 2).
function EditPanel({ contact, onSaved }) {
  const [draft, setDraft] = useState({
    status: contact.status,
    tier: contact.tier,
    details: { ...contact.details },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.updateContact(contact.id, draft);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
      onSaved(); // re-fetch: a status change also added a timeline entry
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h3>Edit</h3>

      <label className="field">
        Status
        <select
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      <label className="field">
        Tier
        <select
          value={draft.tier}
          onChange={(e) => setDraft({ ...draft, tier: e.target.value })}
        >
          {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>

      <TypeDetailFields
        type={contact.contact_type}
        values={draft.details}
        onChange={(details) => setDraft({ ...draft, details })}
      />

      {error && <p className="error-banner">{error}</p>}
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
      {savedFlash && <span className="muted"> Saved.</span>}
    </form>
  );
}

// ── Log an activity ──────────────────────────────────────────────────────────
// Only note/visit/call — the API rejects status_change here by design
// (those rows come from actual status edits, so the timeline can't lie).
function LogActivityForm({ contactId, onLogged }) {
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addActivity(contactId, { kind, body });
      setBody(''); // keep the kind — logging several visits in a row is common
      onLogged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="log-form" onSubmit={submit}>
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="note">Note</option>
        <option value="visit">Visit</option>
        <option value="call">Call</option>
      </select>
      <input
        type="text"
        placeholder="What happened?"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button type="submit" disabled={saving || body.trim() === ''}>
        {saving ? 'Logging…' : 'Log'}
      </button>
      {error && <p className="error-banner">{error}</p>}
    </form>
  );
}

// ── Timeline (server returns newest first) ──────────────────────────────────
function Timeline({ activities }) {
  if (activities.length === 0) {
    return <p className="muted">No activity yet — log the first note above.</p>;
  }
  return (
    <ul className="timeline">
      {activities.map((a) => (
        <li key={a.id}>
          <span className={`badge kind-${a.kind}`}>{KIND_LABELS[a.kind]}</span>
          <span className="timeline-body">{a.body}</span>
          <span className="muted timeline-date">{fmtDate(a.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
