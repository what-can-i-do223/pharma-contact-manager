// ============================================================================
// OrderSection — the Orders block on the contact detail page (Phase 6)
// ============================================================================
//
// Three pieces in one file because they only ever appear together here:
//   * OrderStatusBadge — also imported by the Orders page
//   * NewOrderForm     — product lines + quantities with a live total
//   * OrderSection     — lifetime value line, the contact's orders, the form
//
// The LIVE TOTAL is deliberately client-side float math: it's a preview,
// recomputed keystroke-by-keystroke for feedback. The authoritative total is
// computed by Postgres in NUMERIC when the order is placed — the preview is
// allowed to be a display convenience precisely because nothing stores it.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, fmtINR } from '../format.js';

export function OrderStatusBadge({ status }) {
  return <span className={`badge order-${status}`}>{status}</span>;
}

// One empty line to start; users add more as needed.
const EMPTY_LINE = { product_id: '', quantity: 1 };

function NewOrderForm({ contactId, onCreated }) {
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listProducts().then(setProducts).catch((err) => setError(err.message));
  }, []);

  const priceOf = (id) => {
    const p = products.find((x) => x.id === id);
    return p ? parseFloat(p.unit_price) : 0;
  };

  // Preview only — see the header comment.
  const liveTotal = lines.reduce(
    (sum, l) => sum + (l.product_id ? priceOf(l.product_id) * (l.quantity || 0) : 0),
    0
  );

  const setLine = (i, patch) =>
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  // A product already picked on another line is disabled in the dropdown —
  // the API enforces one-line-per-product, so the form shouldn't offer
  // a combination it knows will be rejected.
  const pickedElsewhere = (i) =>
    new Set(lines.filter((_, idx) => idx !== i).map((l) => l.product_id));

  const completeLines = lines.filter((l) => l.product_id && l.quantity > 0);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createOrder(
        contactId,
        completeLines.map((l) => ({ product_id: l.product_id, quantity: l.quantity }))
      );
      setLines([{ ...EMPTY_LINE }]); // reset for the next order
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card order-form" onSubmit={submit}>
      <h3>New order</h3>

      {lines.map((line, i) => (
        <div className="order-line" key={i}>
          <select
            value={line.product_id}
            onChange={(e) => setLine(i, { product_id: e.target.value })}
          >
            <option value="">— pick a product —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id} disabled={pickedElsewhere(i).has(p.id)}>
                {p.name} · {p.form} · {fmtINR(p.unit_price)}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            step="1"
            value={line.quantity}
            onChange={(e) => setLine(i, { quantity: parseInt(e.target.value, 10) || 0 })}
            aria-label="Quantity"
          />
          {lines.length > 1 && (
            <button
              type="button"
              className="secondary"
              onClick={() => setLines(lines.filter((_, idx) => idx !== i))}
              aria-label="Remove line"
            >
              ✕
            </button>
          )}
        </div>
      ))}

      <div className="order-form-foot">
        <button
          type="button"
          className="secondary"
          onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
        >
          + Add product
        </button>
        <span className="order-live-total">Total: {fmtINR(liveTotal)}</span>
      </div>

      {error && <p className="error-banner">{error}</p>}
      <button type="submit" disabled={saving || completeLines.length === 0}>
        {saving ? 'Placing…' : 'Place order'}
      </button>
    </form>
  );
}

export default function OrderSection({ contact, onChanged }) {
  const [orders, setOrders] = useState(null); // null = loading

  const load = () =>
    api.listOrders({ contact_id: contact.id }).then(setOrders).catch(() => setOrders([]));

  useEffect(() => {
    load();
    // reload when the parent re-fetched the contact (e.g. after an order —
    // total_order_value changed, and so did our list)
  }, [contact]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h2>
        Orders{' '}
        <span className="muted order-value-line">
          — lifetime value {fmtINR(contact.total_order_value)}
        </span>
      </h2>

      <div className="detail-grid">
        <div>
          {orders === null && <p className="muted">Loading…</p>}
          {orders?.length === 0 && <p className="muted">No orders yet.</p>}
          {orders?.length > 0 && (
            <ul className="order-list">
              {orders.map((o) => (
                <li key={o.id}>
                  <span>
                    {fmtDate(o.order_date)} · {o.item_count} item{o.item_count === 1 ? '' : 's'}
                  </span>
                  <strong>{fmtINR(o.total_amount)}</strong>
                  <OrderStatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <NewOrderForm
          contactId={contact.id}
          onCreated={() => {
            load();
            onChanged(); // parent re-fetches: timeline + lifetime value moved
          }}
        />
      </div>
    </>
  );
}
