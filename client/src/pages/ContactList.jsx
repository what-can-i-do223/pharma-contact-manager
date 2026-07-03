// ============================================================================
// ContactList — the home screen: filterable, sortable table of all contacts
// ============================================================================
//
// State model: ONE `filters` object drives everything. Any control change
// updates it, and a single effect re-fetches whenever it changes. No client-
// side filtering — the API already does filter/search/sort (Phase 2/3), and
// doing it twice would mean two implementations that can disagree.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { timeAgo } from '../format.js';
import { TypeBadge, StatusBadge, OverdueFlag, TYPE_LABELS } from '../components/Badges.jsx';

const INITIAL_FILTERS = { q: '', type: '', status: '', sort: 'name', overdue: false };

export default function ContactList() {
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Merge one control's change into the filter object.
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    let cancelled = false; // ignore responses that arrive after a newer request

    // 250ms debounce: typing in the search box updates `filters` per
    // keystroke, but we only hit the API once the user pauses. The cleanup
    // below cancels the pending timer whenever filters change again — that
    // cancellation IS the debounce.
    const timer = setTimeout(async () => {
      try {
        const rows = await api.listContacts({
          q: filters.q,
          type: filters.type,
          status: filters.status,
          sort: filters.sort,
          // Only send overdue=true when the box is ticked; unticked means
          // "don't filter on it" (sending overdue=false would HIDE overdue
          // contacts, which is not what an unticked checkbox means).
          overdue: filters.overdue ? 'true' : '',
        });
        if (!cancelled) {
          setContacts(rows);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filters]);

  return (
    <section>
      <div className="controls">
        <input
          type="search"
          placeholder="Search by name…"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />

        <select value={filters.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}s</option>
          ))}
        </select>

        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          {['lead', 'active', 'dormant', 'closed'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select value={filters.sort} onChange={(e) => set({ sort: e.target.value })}>
          <option value="name">Sort: name</option>
          <option value="last_contacted">Sort: last contacted</option>
          <option value="overdue">Sort: most overdue</option>
        </select>

        <label className="field checkbox">
          <input
            type="checkbox"
            checked={filters.overdue}
            onChange={(e) => set({ overdue: e.target.checked })}
          />
          Overdue only
        </label>
      </div>

      {error && <p className="error-banner">Couldn’t load contacts: {error}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && !error && contacts.length === 0 && (
        <p className="muted">No contacts match these filters.</p>
      )}

      {!loading && !error && contacts.length > 0 && (
        // .table-wrap gives the table its own horizontal scroll on narrow
        // screens instead of breaking the page layout.
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>City</th>
                <th>Status</th>
                <th>Tier</th>
                <th>Last contacted</th>
                <th>Visit due</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`#/contacts/${c.id}`} className="row-link">{c.full_name}</a>
                  </td>
                  <td><TypeBadge type={c.contact_type} /></td>
                  <td>{c.city}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="tier">{c.tier}</td>
                  <td>{timeAgo(c.last_activity_at)}</td>
                  <td>
                    {/* Server-computed: red pill when overdue, otherwise
                        "in Nd" from the signed days_overdue (−9 → in 9d). */}
                    <OverdueFlag contact={c} />
                    {!c.is_overdue && (
                      <span className="muted">in {-c.days_overdue}d</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
