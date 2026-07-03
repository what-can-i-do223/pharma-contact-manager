# Phase 6 Explained — Orders & Products

## 1. What we built

A complete ordering slice on top of the existing app: a `products` catalog
(10 active seeded products + 1 discontinued one), `orders` with priced
`order_items`, four endpoints (list products; create order; list/filter
orders; fetch one order; change order status), and the UI — a new-order form
with a live total on the contact detail page, an Orders page with a status
filter and mark-delivered/cancel buttons, and each contact's lifetime order
value on their detail page. Placing or fulfilling an order also writes an
`'order'` activity, so orders appear in the contact timeline between visits
and calls. Everything is verified: constraint tests in SQL, ~15 curl cases
including tamper attempts, and a headless-browser run through both new UI
flows. No external dependencies — deliberately, per the spec, before the
Google phases.

## 2. Design decisions — chosen vs. rejected

**The stored `total_amount`, and why it doesn't contradict Phase 3.** Phase
3 argued *never store what you can derive* (and refused a `last_visited`
column); this phase stores a total that is derivable from line items. The
distinction: `next_visit_due` derives from data that **keeps changing**
(new visits, tier edits) — a stored copy needs perpetual invalidation. An
order is a **completed transaction**: line items are immutable after
creation (there is no edit-order endpoint), so the stored total has nothing
to drift from. It's the same snapshot logic as `unit_price_at_order` — if
the catalog price rises next week, this order must still say what the
customer agreed to pay. Rule of thumb worth saying on camera: *derive from
living data; snapshot completed transactions.*

**The client never sends prices.** `POST /api/orders` accepts only
`{product_id, quantity}` lines; `unit_price_at_order` is copied from the
catalog *inside the transaction*, and the total is summed from those
snapshots. A request that includes a price field is rejected loudly (tested
— 400 naming the field), so a tampered client can't give itself a discount.
The browser's live total is explicitly a preview; the DB's NUMERIC math is
the truth.

**Money is NUMERIC in Postgres, strings in JS.** JS numbers are binary
floats (`0.1 + 0.2 !== 0.3`); compounding that across line items is how
invoices end up a paisa off. All money arithmetic — line totals, order
totals, lifetime value — happens in SQL in `NUMERIC(12,2)`; the API passes
the resulting strings through untouched and the client only *formats* them
(`Intl.NumberFormat('en-IN')` for ₹ and Indian digit grouping).

**Order statuses are a one-way street.** `pending → delivered | cancelled`,
and that's all — terminal states are terminal (tested: re-PATCHing a
delivered order 400s). An order isn't a document you edit; it's a
transaction that either completes or doesn't. Placed the wrong order?
Cancel it, place a new one — both events stay on the timeline. This also
made `delivered_at` enforceable in the schema:
`CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))` — the status
and its timestamp can never disagree, in either direction.

**Soft delete for products (`active` flag).** Old orders reference their
products forever, so products are never deleted (the FK deliberately has no
CASCADE — deleting a referenced product is an *error*, tested). Discontinued
products flip `active = false`: the catalog endpoint stops offering them,
the order endpoint rejects them (tested with the seeded discontinued
CardioSafe 5), and history keeps rendering.

**Smaller calls:**

| Decision | Why |
|---|---|
| Order events use a new activity kind `'order'`, writable only by the order endpoints | Same trust rule as `status_change`: a timeline entry saying "Order placed" is proof one was. The user-facing activities endpoint still accepts only note/visit/call. |
| `UNIQUE (order_id, product_id)` | "3 + 2 of the same product" is one line with quantity 5; the form disables already-picked products so users never hit the constraint. |
| Cancelled orders excluded from lifetime value | It's money that did *not* happen. (`WHERE status <> 'cancelled'` in the lifetime-value subquery.) |
| Seeded orders are threaded into existing stories | Suresh's visit note already said "reordered 200 strips" — order 1 *is* that order. The demo reads as one coherent history, not two unrelated datasets. |
| `'order'` activities don't touch the visit planner | Only `kind = 'visit'` feeds `next_visit_due`, so Phase 3's overdue numbers are unchanged (regression-tested: still 8 overdue). |

## 3. Walkthrough of the tricky parts

### 3.1 The create-order transaction (orders.routes.js)

Five statements, one atomic unit:

1. **Contact exists?** — plain SELECT; 400 with a clear message if not.
2. **Fetch the products** — `WHERE id = ANY($1) AND active`. Inactive or
   unknown ids simply don't come back, and the count mismatch names the
   missing ids in the 400.
3. **Insert the order** (defaults: pending, total 0).
4. **Insert all lines in one statement** — the interesting one:

   ```sql
   INSERT INTO order_items (order_id, product_id, quantity, unit_price_at_order)
   SELECT $1, p.id, x.quantity, p.unit_price
     FROM unnest($2::uuid[], $3::int[]) AS x(product_id, quantity)
     JOIN products p ON p.id = x.product_id
   ```

   `unnest` zips the parallel arrays (ids, quantities) into rows; the JOIN
   pulls each product's *current* price — that `p.unit_price` landing in
   `unit_price_at_order` **is** the snapshot. One round trip regardless of
   line count, and no price ever passes through JS.
5. **Total** — `UPDATE orders SET total_amount = (SELECT sum(quantity *
   unit_price_at_order) …)` — Postgres NUMERIC arithmetic; then the
   timeline INSERT ("Order placed: 2 items, ₹1,805.00").

All inside BEGIN/COMMIT: a crash anywhere leaves no half-order, no
orphaned lines, no phantom timeline entry.

### 3.2 The live total vs. the real total

The form recomputes `Σ price × qty` in JS floats on every keystroke — and
that's fine *because it's a preview that nothing stores*. The moment the
order is placed, the server recomputes in NUMERIC and the UI re-fetches.
Verified end-to-end in the browser: preview showed ₹1,805.00 for
5 × 185 + 10 × 88, and the placed order's DB total matched exactly, as did
the lifetime value's move (46,986 → 48,791).

### 3.3 What was verified

- **Schema:** all six seeded totals equal their item sums (checked by
  query); five constraint tests failed correctly — delivered-without-
  timestamp, timestamp-without-delivered, duplicate product line, zero
  quantity, deleting a referenced product.
- **API:** create computes the right total and logs the timeline row;
  delivered sets `delivered_at` and logs; terminal orders reject changes;
  empty/fractional/duplicate/inactive/unknown inputs each 400 with the
  intended message; client-supplied price rejected; missing order/contact →
  404/400. Regression: overdue count and name search unchanged.
- **UI (headless browser, screenshots reviewed):** orders section renders
  seeded history; already-picked products are disabled on other lines; live
  total correct; placing the order updates list, timeline and lifetime
  value; Orders page filters and mark-delivered/cancel work; the delivered
  event lands on the contact timeline. No console errors. DB reseeded after.

One honest note: the first browser-driver run failed by *trying to select a
disabled option* — line 2's dropdown correctly disables the product line 1
picked. Test-script bug, but it inadvertently proved the duplicate-
prevention UX; the fixed driver asserts that disabling explicitly.

## 4. Likely reviewer / video questions — with tight answers

**Q: You argued against storing derived values in Phase 3 — why is `total_amount` stored?**
Because the inputs stopped moving. Overdue derives from living data (every
new visit changes it), so storing it means invalidation forever. An order's
lines are immutable once placed — the total is a snapshot of a finished
transaction, exactly like the per-line price snapshot. Derive from living
data; snapshot completed transactions.

**Q: What stops a malicious client from setting its own prices?**
The API's item schema is `{product_id, quantity}` — nothing else parses,
and an included price field is a named 400, not silently ignored. Prices
come from the catalog inside the insert transaction. The client literally
has no channel through which to influence money.

**Q: Why can't I edit an order?**
Terminal-state design: pending either becomes delivered or cancelled, and
history is append-only — like the activity timeline. Cancel-and-reorder
covers the "oops" case while keeping both events auditable. Fewer states,
fewer bugs, and `delivered_at` becomes DB-enforceable.

**Q: Why does the timeline show orders?**
The rep's question is still "what happened with this person?" — a ₹37,000
order is at least as important as a phone call. Same one-timeline principle
from Phase 1; `'order'` rows are written only by the order endpoints, so
they're trustworthy the same way `status_change` rows are.

**Q: Float errors in the order form's live total?**
Possible in principle, irrelevant by design: the preview is display-only.
The authoritative total is computed by Postgres in NUMERIC from the
snapshotted prices. If the preview and the DB ever disagreed by a paisa,
the DB wins the moment the response renders.

**Q: What happens to old orders when a product is discontinued?**
Nothing — that's the point of the `active` flag. The product row stays
(deleting it is blocked by the FK), old order lines keep their name and
snapshot price, and only the catalog endpoint and order validation stop
offering it.
