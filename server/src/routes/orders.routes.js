// ============================================================================
// orders.routes.js — /api/orders
// ============================================================================
//
//   POST  /api/orders       create order + line items + timeline activity
//                           (ONE transaction)
//   GET   /api/orders       list with ?status= and ?contact_id= filters
//   GET   /api/orders/:id   full order incl. line items
//   PATCH /api/orders/:id   status change (pending → delivered | cancelled),
//                           logs a timeline activity in the same transaction
//
// MONEY RULES (the load-bearing decisions of this file):
//   * The client NEVER sends prices. Line items arrive as {product_id,
//     quantity} only; unit_price_at_order is snapshotted from the products
//     table inside the transaction. A tampered request can't discount itself.
//   * All money arithmetic happens IN POSTGRES (NUMERIC), never in JS —
//     JS numbers are binary floats and 0.1 + 0.2 !== 0.3. Node's pg driver
//     returns NUMERIC as strings, and this API passes them through as-is.
// ============================================================================

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const ORDER_STATUSES = ['pending', 'delivered', 'cancelled'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const badRequest = (res, message) => res.status(400).json({ error: message });

// "₹37,000.00" — for the human-readable timeline bodies. en-IN gives the
// Indian digit grouping (₹1,00,000 not ₹100,000). Formatting a string
// total from Postgres is display work, not arithmetic — parseFloat is fine
// here because the exact value was already fixed by the DB.
const fmtINR = (numericString) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(parseFloat(numericString));

// The list SELECT, shared by GET / and the responses of POST/PATCH so every
// endpoint returns the same order shape (same trick as CONTACT_SELECT).
const ORDER_SELECT = `
  SELECT o.id, o.contact_id, c.full_name AS contact_name,
         o.order_date, o.status, o.delivered_at, o.total_amount,
         (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM orders o
    JOIN contacts c ON c.id = o.contact_id
`;

// Full order incl. line items — two simple queries, like the contact
// detail endpoint. Products are joined for display fields; line_total is
// computed by Postgres (NUMERIC), not JS. repId scoping mirrors
// fetchContact: another rep's order id behaves exactly like a missing one.
async function fetchOrder(id, repId) {
  const { rows } = await pool.query(
    `${ORDER_SELECT} WHERE o.id = $1 AND o.rep_id = $2`,
    [id, repId]
  );
  if (!rows[0]) return null;

  const { rows: items } = await pool.query(
    `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.form,
            oi.quantity, oi.unit_price_at_order,
            (oi.quantity * oi.unit_price_at_order) AS line_total
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY p.name`,
    [id]
  );
  return { ...rows[0], items };
}

// ----------------------------------------------------------------------------
// GET /api/orders — list, newest first, with optional filters
// ----------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const { status, contact_id } = req.query;
  // Tenant scope first, unconditionally — same pattern as the contacts list.
  const where = ['o.rep_id = $1'];
  const params = [req.rep.id];

  if (status !== undefined) {
    if (!ORDER_STATUSES.includes(status)) {
      return badRequest(res, `status must be one of: ${ORDER_STATUSES.join(', ')}`);
    }
    params.push(status);
    where.push(`o.status = $${params.length}`);
  }

  if (contact_id !== undefined) {
    if (!UUID_RE.test(contact_id)) {
      return badRequest(res, 'contact_id must be a UUID');
    }
    params.push(contact_id);
    where.push(`o.contact_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `${ORDER_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.order_date DESC`,
    params
  );
  res.json(rows);
}));

// ----------------------------------------------------------------------------
// GET /api/orders/:id — full order with line items
// ----------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return badRequest(res, 'order id must be a UUID');

  const order = await fetchOrder(id, req.rep.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json(order);
}));

// ----------------------------------------------------------------------------
// POST /api/orders — create order + items + timeline row, atomically
// ----------------------------------------------------------------------------
// Body: { contact_id, items: [{ product_id, quantity }, …] }
// Note what is NOT in the body: prices, totals, status, dates. The client
// says WHAT and HOW MANY; the database says how much it costs.
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'request body must be a JSON object');
  }
  if (!UUID_RE.test(String(body.contact_id))) {
    return badRequest(res, 'contact_id is required and must be a UUID');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return badRequest(res, 'items must be a non-empty array of { product_id, quantity }');
  }

  // Validate the shape of every line before touching the DB.
  const seen = new Set();
  for (const [i, item] of body.items.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return badRequest(res, `items[${i}] must be an object`);
    }
    // Reject unknown keys — in particular, a client-supplied price is
    // refused loudly rather than silently ignored (same philosophy as the
    // details validator: typos and tampering should fail, not no-op).
    for (const key of Object.keys(item)) {
      if (key !== 'product_id' && key !== 'quantity') {
        return badRequest(res, `items[${i}] has unknown field "${key}" (allowed: product_id, quantity)`);
      }
    }
    if (!UUID_RE.test(String(item.product_id))) {
      return badRequest(res, `items[${i}].product_id must be a UUID`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return badRequest(res, `items[${i}].quantity must be a positive integer`);
    }
    if (seen.has(item.product_id)) {
      return badRequest(res, `items[${i}] repeats a product — send one line per product`);
    }
    seen.add(item.product_id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Contact must exist AND belong to this rep — ordering on another
    // rep's contact is indistinguishable from a nonexistent contact.
    const contact = await client.query(
      'SELECT full_name FROM contacts WHERE id = $1 AND rep_id = $2',
      [body.contact_id, req.rep.id]
    );
    if (contact.rows.length === 0) {
      await client.query('ROLLBACK');
      return badRequest(res, 'contact_id does not reference an existing contact');
    }

    // Fetch the products in one round trip. Inactive products are excluded
    // here, so ordering a discontinued product fails the "all found?" check.
    const productIds = body.items.map((i) => i.product_id);
    const products = await client.query(
      'SELECT id FROM products WHERE id = ANY($1) AND active',
      [productIds]
    );
    if (products.rows.length !== productIds.length) {
      const found = new Set(products.rows.map((r) => r.id));
      const missing = productIds.filter((id) => !found.has(id));
      await client.query('ROLLBACK');
      return badRequest(res, `unknown or inactive product id(s): ${missing.join(', ')}`);
    }

    const order = await client.query(
      `INSERT INTO orders (contact_id, rep_id) VALUES ($1, $2) RETURNING id`,
      [body.contact_id, req.rep.id]
    );
    const orderId = order.rows[0].id;

    // Insert every line with the price snapshotted FROM the products table
    // — the SELECT inside the INSERT is the snapshot. unnest() turns the
    // parallel arrays of ids/quantities into rows, keeping this one
    // statement instead of a loop of round trips.
    await client.query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price_at_order)
       SELECT $1, p.id, x.quantity, p.unit_price
         FROM unnest($2::uuid[], $3::int[]) AS x(product_id, quantity)
         JOIN products p ON p.id = x.product_id`,
      [orderId, productIds, body.items.map((i) => i.quantity)]
    );

    // Total = sum of the lines, computed by Postgres in NUMERIC. The UPDATE
    // happens inside the same transaction, so no reader ever sees the
    // order with its default 0 total.
    const totaled = await client.query(
      `UPDATE orders
          SET total_amount = (SELECT sum(quantity * unit_price_at_order)
                                FROM order_items WHERE order_id = $1)
        WHERE id = $1
        RETURNING total_amount`,
      [orderId]
    );

    // The timeline row — same transaction, so an order can't exist without
    // its trace on the contact (and vice versa). kind='order' is not
    // accepted by the user-facing activities endpoint, same trust rule as
    // 'status_change': its presence proves an order was really placed.
    const n = body.items.length;
    await client.query(
      `INSERT INTO activities (contact_id, rep_id, kind, body)
       VALUES ($1, $2, 'order', $3)`,
      [body.contact_id, req.rep.id, `Order placed: ${n} item${n === 1 ? '' : 's'}, ${fmtINR(totaled.rows[0].total_amount)}`]
    );

    await client.query('COMMIT');
    res.status(201).json(await fetchOrder(orderId, req.rep.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ----------------------------------------------------------------------------
// PATCH /api/orders/:id — status transitions
// ----------------------------------------------------------------------------
// Only { status } is patchable, and only FROM 'pending': delivered and
// cancelled are terminal. An order isn't a document you edit — it's a
// transaction that either completes or doesn't. (Wrong order? Cancel it
// and place a new one; both events stay on the timeline.)
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return badRequest(res, 'order id must be a UUID');

  const newStatus = req.body?.status;
  if (newStatus !== 'delivered' && newStatus !== 'cancelled') {
    return badRequest(res, "status must be 'delivered' or 'cancelled' (the only transitions from pending)");
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row: two simultaneous "mark delivered" clicks must not both
    // proceed (same FOR UPDATE reasoning as the contact PATCH). Scoped:
    // another rep's order is a 404 here.
    const current = await client.query(
      'SELECT contact_id, status, total_amount FROM orders WHERE id = $1 AND rep_id = $2 FOR UPDATE',
      [id, req.rep.id]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'order not found' });
    }
    const { contact_id, status: oldStatus, total_amount } = current.rows[0];

    if (oldStatus !== 'pending') {
      await client.query('ROLLBACK');
      return badRequest(res, `order is already ${oldStatus} — only pending orders can change status`);
    }

    // delivered_at is set/cleared together with the status; the schema's
    // CHECK ((status='delivered') = (delivered_at IS NOT NULL)) would
    // reject this UPDATE if the pair ever disagreed.
    await client.query(
      `UPDATE orders
          SET status = $2,
              delivered_at = CASE WHEN $2 = 'delivered' THEN now() END
        WHERE id = $1`,
      [id, newStatus]
    );

    await client.query(
      `INSERT INTO activities (contact_id, rep_id, kind, body)
       VALUES ($1, $2, 'order', $3)`,
      [contact_id, req.rep.id, `Order ${newStatus}: ${fmtINR(total_amount)}`]
    );

    await client.query('COMMIT');
    res.json(await fetchOrder(id, req.rep.id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
