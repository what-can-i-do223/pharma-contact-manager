// ============================================================================
// seedRep.js — onboarding starter data for a brand-new rep
// ============================================================================
//
// WHY THIS EXISTS: a rep who signs in with Google for the first time would
// otherwise land on a completely empty app — no contacts, nothing to click,
// no overdue flags, no orders. seedStarterDataForRep() populates their (and
// only their) account with the same rich sample dataset the project ships in
// db/seed.sql, so the very first screen already demonstrates every feature.
//
// RELATIONSHIP TO db/seed.sql: this is the SAME dataset, deliberately — same
// 14 contacts, workplaces, backdated activities and orders, so behaviour
// matches what the docs describe. The difference is that db/seed.sql is a
// one-shot SQL script with HARDCODED UUIDs for the fixed "demo rep", whereas
// this is a parameterized function that generates FRESH UUIDs on every call.
// Fresh UUIDs are essential: reuse the hardcoded ids and the second rep to
// onboard would collide on primary keys with the first.
//
// GLOBAL vs PER-REP — the deliberate split:
//   * contacts / activities / orders / order_items → PER REP. New UUIDs,
//     stamped with repId. This is the isolated, rep-owned data.
//   * workplaces / products → GLOBAL reference data, shared across reps
//     (matching Phase 7's decision that these tables have no rep_id). We
//     get-or-create them: reuse the existing global rows if present, create
//     only what's missing. So onboarding a hundred reps does NOT create a
//     hundred duplicate "Lilavati Hospital" rows — the shared workplace
//     dropdown stays clean, and the function still works on a fresh
//     schema-only DB (it creates the catalog the first time).
//
// TRANSACTION: this function runs entirely on the CLIENT passed in — it does
// no BEGIN/COMMIT of its own. The caller (the OAuth callback) wraps rep
// creation + this seeding in ONE transaction, so a new rep atomically gets
// their account AND their data, or neither.

const crypto = require('crypto');

// Money formatting for the order timeline messages — mirrors the identical
// helper in orders.routes.js so seeded 'order' activities read exactly like
// ones the live POST /api/orders endpoint writes.
const fmtINR = (numericString) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(parseFloat(numericString));

// Backdating: db/seed.sql uses `now() - interval 'N days'`; here we compute
// the equivalent instant in JS and pass it as a timestamptz parameter. The
// overdue planner is relative to now(), so "created 40 days ago" behaves the
// same however long after seeding you look.
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

// ----------------------------------------------------------------------------
// The dataset, as plain data keyed by symbolic names (not UUIDs). UUIDs are
// generated at seed time and references resolved through lookup maps, so the
// same definitions produce a fresh, self-consistent graph on every call.
// ----------------------------------------------------------------------------

const WORKPLACES = [
  { key: 'lilavati', name: 'Lilavati Hospital', kind: 'hospital', city: 'Mumbai' },
  { key: 'sahyadri', name: 'Sahyadri Clinic', kind: 'clinic', city: 'Pune' },
  { key: 'apollo', name: 'Apollo Hospitals Jubilee Hills', kind: 'hospital', city: 'Hyderabad' },
  { key: 'kims', name: 'KIMS Hospital', kind: 'hospital', city: 'Hyderabad' },
  { key: 'maxsaket', name: 'Max Super Speciality Saket', kind: 'hospital', city: 'Delhi' },
  { key: 'wellness', name: 'Wellness Forever Bandra', kind: 'pharmacy', city: 'Mumbai' },
  { key: 'noble', name: 'Noble Chemists FC Road', kind: 'pharmacy', city: 'Pune' },
  { key: 'medplus', name: 'MedPlus Kukatpally', kind: 'pharmacy', city: 'Hyderabad' },
  { key: 'guardian', name: 'Guardian Pharmacy CP', kind: 'pharmacy', city: 'Delhi' },
  { key: 'ajanta', name: 'Ajanta Pharma Distributors', kind: 'distributor', city: 'Mumbai' },
];

// 10 active + 1 discontinued, matching db/seed.sql. Prices are the catalog
// snapshot source for the seeded orders below.
const PRODUCTS = [
  { name: 'CardioSafe 10', sku: 'CS-010', form: '10mg tablet, strip of 15', unit_price: 185.0, active: true },
  { name: 'CardioSafe 25', sku: 'CS-025', form: '25mg tablet, strip of 15', unit_price: 240.0, active: true },
  { name: 'GlucoBal 500', sku: 'GB-500', form: '500mg SR tablet, strip of 10', unit_price: 92.5, active: true },
  { name: 'ThyroNorm 25', sku: 'TN-025', form: '25mcg tablet, bottle of 120', unit_price: 158.0, active: true },
  { name: 'OsteoFlex Forte', sku: 'OF-FRT', form: '1500mg tablet, strip of 10', unit_price: 210.0, active: true },
  { name: 'PediCof Junior', sku: 'PC-JNR', form: '100ml syrup', unit_price: 74.0, active: true },
  { name: 'DermaTret 0.025%', sku: 'DT-025', form: '20g cream', unit_price: 129.0, active: true },
  { name: 'AmoxiCure 500', sku: 'AC-500', form: '500mg capsule, strip of 10', unit_price: 88.0, active: true },
  { name: 'IVexin 1g', sku: 'IV-1G0', form: '1g injection vial', unit_price: 342.0, active: true },
  { name: 'NeuroVit B12', sku: 'NV-B12', form: '1500mcg tablet, strip of 10', unit_price: 66.5, active: true },
  { name: 'CardioSafe 5', sku: 'CS-005', form: '5mg tablet, strip of 15', unit_price: 150.0, active: false },
];

// `created`/`updated` are days-ago. `details` carries the per-type fields.
const CONTACTS = [
  { key: 'asha', full_name: 'Dr. Asha Mehta', contact_type: 'hcp', phone: '+91 98200 11001', email: 'asha.mehta@lilavati.example', city: 'Mumbai', status: 'active', tier: 'A', workplace: 'lilavati', created: 90, updated: 20, details: { specialty: 'Cardiologist', role: 'Senior Consultant' } },
  { key: 'rajiv', full_name: 'Dr. Rajiv Kulkarni', contact_type: 'hcp', phone: '+91 98220 11002', email: 'rajiv.kulkarni@sahyadri.example', city: 'Pune', status: 'active', tier: 'B', workplace: 'sahyadri', created: 75, updated: 10, details: { specialty: 'General Physician', role: 'Resident Physician' } },
  { key: 'priya', full_name: 'Dr. Priya Nair', contact_type: 'hcp', phone: '+91 98490 11003', email: 'priya.nair@apollo.example', city: 'Hyderabad', status: 'active', tier: 'A', workplace: 'apollo', created: 120, updated: 2, details: { specialty: 'Endocrinologist', role: 'Head of Department' } },
  { key: 'sanjay', full_name: 'Dr. Sanjay Gupta', contact_type: 'hcp', phone: '+91 98110 11004', email: null, city: 'Delhi', status: 'lead', tier: 'B', workplace: 'maxsaket', created: 40, updated: 40, details: { specialty: 'Orthopedic Surgeon', role: 'Senior Consultant' } },
  { key: 'farhan', full_name: 'Dr. Farhan Sheikh', contact_type: 'hcp', phone: '+91 98850 11005', email: 'farhan.sheikh@kims.example', city: 'Hyderabad', status: 'dormant', tier: 'C', workplace: 'kims', created: 200, updated: 60, details: { specialty: 'Pediatrician', role: 'Consultant' } },
  { key: 'kavita', full_name: 'Dr. Kavita Rao', contact_type: 'hcp', phone: null, email: 'kavita.rao@sahyadri.example', city: 'Pune', status: 'lead', tier: 'C', workplace: 'sahyadri', created: 20, updated: 20, details: { specialty: 'Dermatologist', role: 'Consultant' } },
  { key: 'suresh', full_name: 'Suresh Patil', contact_type: 'pharmacist', phone: '+91 98200 22007', email: 'suresh.patil@wellness.example', city: 'Mumbai', status: 'active', tier: 'A', workplace: 'wellness', created: 150, updated: 3, details: { is_owner: true } },
  { key: 'meena', full_name: 'Meena Joshi', contact_type: 'pharmacist', phone: '+91 98220 22008', email: 'meena.joshi@noble.example', city: 'Pune', status: 'active', tier: 'B', workplace: 'noble', created: 100, updated: 45, details: { is_owner: true } },
  { key: 'arun', full_name: 'Arun Verma', contact_type: 'pharmacist', phone: '+91 98490 22009', email: null, city: 'Hyderabad', status: 'lead', tier: 'C', workplace: 'medplus', created: 100, updated: 100, details: { is_owner: false } },
  { key: 'divya', full_name: 'Divya Shetty', contact_type: 'pharmacist', phone: '+91 98110 22010', email: 'divya.shetty@guardian.example', city: 'Delhi', status: 'dormant', tier: 'B', workplace: 'guardian', created: 80, updated: 25, details: { is_owner: false } },
  { key: 'ramesh', full_name: 'Ramesh Iyer', contact_type: 'procurement', phone: '+91 98200 33011', email: 'ramesh.iyer@lilavati.example', city: 'Mumbai', status: 'active', tier: 'A', workplace: 'lilavati', created: 180, updated: 16, details: { purchasing_role: 'Purchase Officer' } },
  { key: 'anita', full_name: 'Anita Deshpande', contact_type: 'procurement', phone: '+91 98490 33012', email: 'anita.d@kims.example', city: 'Hyderabad', status: 'active', tier: 'B', workplace: 'kims', created: 110, updated: 8, details: { purchasing_role: 'Stores In-charge' } },
  { key: 'vikram', full_name: 'Vikram Malhotra', contact_type: 'procurement', phone: '+91 98200 33013', email: 'vikram.m@ajanta.example', city: 'Mumbai', status: 'lead', tier: 'A', workplace: 'ajanta', created: 30, updated: 30, details: { purchasing_role: 'Supply Chain Manager' } },
  { key: 'pooja', full_name: 'Pooja Reddy', contact_type: 'procurement', phone: '+91 98110 33014', email: 'pooja.reddy@max.example', city: 'Delhi', status: 'closed', tier: 'C', workplace: 'maxsaket', created: 160, updated: 30, details: { purchasing_role: 'Deputy Purchase Manager' } },
];

// Non-order activities. `days` = days-ago. The mix of visit/note/call and the
// backdating are chosen (as in db/seed.sql) so the overdue planner shows
// results immediately and the two-visit contact (priya) exercises the
// "latest visit wins" logic.
const ACTIVITIES = [
  { contact: 'asha', kind: 'visit', body: 'Detailed CardioSafe 10mg; she asked for the AMI outcomes trial reprint.', days: 20 },
  { contact: 'asha', kind: 'note', body: 'Prefers meetings after 2pm OPD. Gatekeeper: Sister Regina at reception.', days: 18 },
  { contact: 'asha', kind: 'call', body: 'Confirmed she received the trial reprint; wants samples next visit.', days: 12 },
  { contact: 'rajiv', kind: 'visit', body: 'Intro visit with GlucoBal starter pack. Positive on pricing vs competitor.', days: 10 },
  { contact: 'rajiv', kind: 'status_change', body: 'Status changed from lead to active after first prescription commitment.', days: 10 },
  { contact: 'priya', kind: 'visit', body: 'Quarterly review of ThyroNorm uptake in her OPD.', days: 35 },
  { contact: 'priya', kind: 'visit', body: 'Dropped new dosage chart; discussed switching two patients to 25mcg.', days: 5 },
  { contact: 'priya', kind: 'call', body: 'Her registrar asked for patient counselling leaflets in Telugu.', days: 2 },
  { contact: 'sanjay', kind: 'note', body: 'Referred by Dr. Mehta. Handles high-volume knee replacements; pitch OsteoFlex.', days: 38 },
  { contact: 'farhan', kind: 'visit', body: 'Brief corridor meeting; low interest, OPD was overflowing.', days: 120 },
  { contact: 'farhan', kind: 'status_change', body: 'Status changed from active to dormant — no response to three follow-ups.', days: 60 },
  { contact: 'kavita', kind: 'note', body: 'Met at Pune Derm CME. Interested in the new tretinoin formulation.', days: 20 },
  { contact: 'suresh', kind: 'visit', body: 'Stock check: CardioSafe moving well, reordered 200 strips.', days: 17 },
  { contact: 'suresh', kind: 'visit', body: 'Placed festival-season order; discussed shelf placement for OTC line.', days: 3 },
  { contact: 'meena', kind: 'visit', body: 'She flagged expiry-return delays from our CFA; promised to escalate.', days: 45 },
  { contact: 'meena', kind: 'note', body: 'Escalated the expiry-return issue to distribution manager over email.', days: 43 },
  { contact: 'arun', kind: 'call', body: 'Cold call. Store manager decides purchases; Arun influences substitution.', days: 90 },
  { contact: 'divya', kind: 'visit', body: 'Counter moved to new manager; Divya now handles only night shifts.', days: 25 },
  { contact: 'divya', kind: 'status_change', body: 'Status changed from active to dormant — purchasing moved to head office.', days: 25 },
  { contact: 'ramesh', kind: 'visit', body: 'Rate-contract renewal discussion; asked for revised quote by month end.', days: 16 },
  { contact: 'ramesh', kind: 'note', body: 'Quote sent. Tender committee meets first week of the month.', days: 13 },
  { contact: 'anita', kind: 'visit', body: 'Audited ward stock levels with her; shortfall in IV antibiotics line.', days: 8 },
  { contact: 'anita', kind: 'call', body: 'Confirmed emergency PO for the antibiotics shortfall was raised.', days: 6 },
  { contact: 'vikram', kind: 'call', body: 'Intro call. Ajanta covers 300+ retail counters in western suburbs.', days: 28 },
  { contact: 'pooja', kind: 'visit', body: 'Final negotiation on oncology line pricing.', days: 95 },
  { contact: 'pooja', kind: 'status_change', body: 'Status changed from active to closed — hospital signed exclusive with competitor.', days: 30 },
];

// Orders reference contacts by key and products by SKU. `order` = days-ago the
// order was placed; `delivered`/`cancelled` = days-ago that transition
// happened (only one applies, per the schema's status↔delivered_at CHECK).
// Line prices are snapshotted from the live product row at seed time, and the
// total is computed by Postgres — the same money path the real endpoint uses.
const ORDERS = [
  { contact: 'suresh', order: 17, status: 'delivered', delivered: 15, items: [{ sku: 'CS-010', quantity: 200 }] },
  { contact: 'suresh', order: 3, status: 'pending', items: [{ sku: 'GB-500', quantity: 60 }, { sku: 'NV-B12', quantity: 40 }, { sku: 'PC-JNR', quantity: 24 }] },
  { contact: 'meena', order: 44, status: 'pending', items: [{ sku: 'OF-FRT', quantity: 30 }, { sku: 'DT-025', quantity: 20 }] },
  { contact: 'ramesh', order: 12, status: 'pending', items: [{ sku: 'IV-1G0', quantity: 50 }, { sku: 'AC-500', quantity: 150 }] },
  { contact: 'anita', order: 6, status: 'delivered', delivered: 5, items: [{ sku: 'IV-1G0', quantity: 30 }] },
  { contact: 'pooja', order: 95, status: 'cancelled', cancelled: 93, items: [{ sku: 'CS-025', quantity: 100 }] },
];

// ----------------------------------------------------------------------------
// The seeding function
// ----------------------------------------------------------------------------
async function seedStarterDataForRep(client, repId) {
  // --- Products: global, get-or-create by unique SKU -----------------------
  // ON CONFLICT (sku) DO NOTHING makes this idempotent across reps; we then
  // read back every product's id + authoritative unit_price to snapshot into
  // order items (whether we just inserted it or it already existed).
  const productBySku = {};
  for (const p of PRODUCTS) {
    await client.query(
      `INSERT INTO products (name, sku, form, unit_price, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sku) DO NOTHING`,
      [p.name, p.sku, p.form, p.unit_price, p.active]
    );
    const { rows } = await client.query(
      'SELECT id, unit_price FROM products WHERE sku = $1',
      [p.sku]
    );
    productBySku[p.sku] = rows[0];
  }

  // --- Workplaces: global, get-or-create by (name, kind, city) -------------
  // workplaces has no unique key, so we can't ON CONFLICT — a select-or-insert
  // gives the same get-or-create behaviour: reuse a matching global row,
  // create it only if absent. Keeps the shared workplace dropdown free of
  // duplicates no matter how many reps onboard.
  const workplaceId = {};
  for (const w of WORKPLACES) {
    const existing = await client.query(
      'SELECT id FROM workplaces WHERE name = $1 AND kind = $2 AND city = $3 LIMIT 1',
      [w.name, w.kind, w.city]
    );
    if (existing.rows[0]) {
      workplaceId[w.key] = existing.rows[0].id;
    } else {
      const inserted = await client.query(
        'INSERT INTO workplaces (name, kind, city) VALUES ($1, $2, $3) RETURNING id',
        [w.name, w.kind, w.city]
      );
      workplaceId[w.key] = inserted.rows[0].id;
    }
  }

  // --- Contacts + their per-type detail row (per rep, fresh UUIDs) ---------
  const contactId = {};
  for (const c of CONTACTS) {
    const id = crypto.randomUUID();
    contactId[c.key] = id;
    await client.query(
      `INSERT INTO contacts
         (id, rep_id, full_name, contact_type, phone, email, city,
          status, tier, workplace_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, repId, c.full_name, c.contact_type, c.phone, c.email, c.city,
        c.status, c.tier, workplaceId[c.workplace],
        daysAgo(c.created), daysAgo(c.updated),
      ]
    );
    if (c.contact_type === 'hcp') {
      await client.query(
        'INSERT INTO hcp_details (contact_id, specialty, role) VALUES ($1, $2, $3)',
        [id, c.details.specialty, c.details.role ?? null]
      );
    } else if (c.contact_type === 'pharmacist') {
      await client.query(
        'INSERT INTO pharmacist_details (contact_id, is_owner) VALUES ($1, $2)',
        [id, c.details.is_owner]
      );
    } else {
      await client.query(
        'INSERT INTO procurement_details (contact_id, purchasing_role) VALUES ($1, $2)',
        [id, c.details.purchasing_role]
      );
    }
  }

  // --- Non-order activities ------------------------------------------------
  for (const a of ACTIVITIES) {
    await client.query(
      `INSERT INTO activities (contact_id, rep_id, kind, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [contactId[a.contact], repId, a.kind, a.body, daysAgo(a.days)]
    );
  }

  // --- Orders + items + order-timeline activities --------------------------
  // Mirrors POST /api/orders exactly: insert order (total 0), insert line
  // items with snapshotted prices, then let Postgres compute the NUMERIC
  // total. The 'order' activity text uses that DB-computed total, so seeded
  // orders are indistinguishable from ones placed through the live endpoint.
  for (const o of ORDERS) {
    const orderId = crypto.randomUUID();
    await client.query(
      `INSERT INTO orders
         (id, contact_id, rep_id, order_date, status, delivered_at, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [
        orderId, contactId[o.contact], repId, daysAgo(o.order), o.status,
        o.delivered != null ? daysAgo(o.delivered) : null,
      ]
    );
    for (const it of o.items) {
      const prod = productBySku[it.sku];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_at_order)
         VALUES ($1, $2, $3, $4)`,
        [orderId, prod.id, it.quantity, prod.unit_price]
      );
    }
    const { rows } = await client.query(
      `UPDATE orders
          SET total_amount = (SELECT sum(quantity * unit_price_at_order)
                                FROM order_items WHERE order_id = $1)
        WHERE id = $1
        RETURNING total_amount`,
      [orderId]
    );
    const total = rows[0].total_amount;
    const n = o.items.length;

    await client.query(
      `INSERT INTO activities (contact_id, rep_id, kind, body, created_at)
       VALUES ($1, $2, 'order', $3, $4)`,
      [contactId[o.contact], repId,
       `Order placed: ${n} item${n === 1 ? '' : 's'}, ${fmtINR(total)}`,
       daysAgo(o.order)]
    );
    if (o.status === 'delivered') {
      await client.query(
        `INSERT INTO activities (contact_id, rep_id, kind, body, created_at)
         VALUES ($1, $2, 'order', $3, $4)`,
        [contactId[o.contact], repId, `Order delivered: ${fmtINR(total)}`, daysAgo(o.delivered)]
      );
    }
    if (o.status === 'cancelled') {
      await client.query(
        `INSERT INTO activities (contact_id, rep_id, kind, body, created_at)
         VALUES ($1, $2, 'order', $3, $4)`,
        [contactId[o.contact], repId, `Order cancelled: ${fmtINR(total)}`, daysAgo(o.cancelled)]
      );
    }
  }
}

module.exports = { seedStarterDataForRep };
