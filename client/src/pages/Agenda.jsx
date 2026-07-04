// ============================================================================
// Agenda — the rep's "what needs doing" screen (Phase 8)
// ============================================================================
//
// Two local-data sections: visits due (overdue + next 7 days) and pending
// order deliveries. Works with or without Google connected; each due visit
// offers "Add to Google Calendar" (the only Google-dependent bit, and it
// degrades to a reconnect prompt on its own).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, fmtINR } from '../format.js';
import { TypeBadge, OverdueFlag } from '../components/Badges.jsx';
import AddToCalendarButton from '../components/AddToCalendarButton.jsx';

export default function Agenda() {
  const [agenda, setAgenda] = useState(null);
  const [error, setError] = useState(null);

  const load = () =>
    api.getAgenda().then(setAgenda).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  if (error) return <p className="error-banner">Couldn’t load agenda: {error}</p>;
  if (!agenda) return <p className="muted">Loading…</p>;

  const { due_visits, pending_deliveries } = agenda;

  return (
    <section>
      <h1>Agenda</h1>

      <h2>Visits due <span className="muted">— overdue &amp; next 7 days</span></h2>
      {due_visits.length === 0 ? (
        <p className="muted">No visits due this week. 🎉</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Workplace</th>
                <th>Tier</th>
                <th>Due</th>
                <th>Calendar</th>
              </tr>
            </thead>
            <tbody>
              {due_visits.map((v) => (
                <tr key={v.id}>
                  <td><a href={`#/contacts/${v.id}`} className="row-link">{v.full_name}</a></td>
                  <td><TypeBadge type={v.contact_type} /></td>
                  <td>{v.workplace ? `${v.workplace.name}, ${v.workplace.city}` : <span className="muted">—</span>}</td>
                  <td className="tier">{v.tier}</td>
                  <td>
                    {/* Server-computed overdue flag, or the due date if upcoming */}
                    {v.is_overdue ? <OverdueFlag contact={v} /> : <>{fmtDate(v.next_visit_due)} <span className="muted">(in {-v.days_overdue}d)</span></>}
                  </td>
                  <td><AddToCalendarButton contact={v} onSynced={load} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Pending deliveries</h2>
      {pending_deliveries.length === 0 ? (
        <p className="muted">No orders awaiting delivery.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ordered</th>
                <th>Contact</th>
                <th>Items</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {pending_deliveries.map((o) => (
                <tr key={o.id}>
                  <td>{fmtDate(o.order_date)}</td>
                  <td><a href={`#/contacts/${o.contact_id}`} className="row-link">{o.contact_name}</a></td>
                  <td>{o.item_count}</td>
                  <td><strong>{fmtINR(o.total_amount)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
