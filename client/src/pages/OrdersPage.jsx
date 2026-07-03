// ============================================================================
// OrdersPage — all orders across contacts: status filter + fulfil buttons
// ============================================================================
//
// The rep's fulfilment view: what's pending, mark it delivered (or cancel).
// Same architecture as ContactList: the status filter re-queries the API,
// and mutations re-fetch the list — no client-side copies of server rules
// (which transitions are legal lives in the API; this page just shows the
// buttons only where they're valid, i.e. on pending orders).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, fmtINR } from '../format.js';
import { OrderStatusBadge } from '../components/OrderSection.jsx';

export default function OrdersPage() {
  const [status, setStatus] = useState(''); // '' = all
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null); // order currently being updated

  async function load() {
    try {
      setOrders(await api.listOrders(status ? { status } : {}));
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
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function transition(id, newStatus) {
    setBusyId(id);
    try {
      await api.updateOrderStatus(id, newStatus);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="controls">
        <h1 style={{ marginRight: 'auto' }}>Orders</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">pending</option>
          <option value="delivered">delivered</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>

      {error && <p className="error-banner">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && orders.length === 0 && <p className="muted">No orders match.</p>}

      {!loading && orders.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Contact</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
                <th>Delivered</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{fmtDate(o.order_date)}</td>
                  <td>
                    <a href={`#/contacts/${o.contact_id}`} className="row-link">
                      {o.contact_name}
                    </a>
                  </td>
                  <td>{o.item_count}</td>
                  <td><strong>{fmtINR(o.total_amount)}</strong></td>
                  <td><OrderStatusBadge status={o.status} /></td>
                  <td>{o.delivered_at ? fmtDate(o.delivered_at) : '—'}</td>
                  <td>
                    {/* Transitions only exist from 'pending' — for terminal
                        orders this cell is simply empty. */}
                    {o.status === 'pending' && (
                      <span className="order-actions">
                        <button
                          disabled={busyId === o.id}
                          onClick={() => transition(o.id, 'delivered')}
                        >
                          Mark delivered
                        </button>
                        <button
                          className="secondary"
                          disabled={busyId === o.id}
                          onClick={() => transition(o.id, 'cancelled')}
                        >
                          Cancel
                        </button>
                      </span>
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
