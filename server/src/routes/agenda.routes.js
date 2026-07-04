// ============================================================================
// agenda.routes.js — /api/agenda : the rep's "what needs doing" view
// ============================================================================
//
//   GET /api/agenda → { due_visits: [...], pending_deliveries: [...] }
//
// Reads LOCAL data only — it works whether or not the rep has connected
// Google (Calendar sync is an enhancement layered on top, not a dependency).
// Everything is scoped to the signed-in rep (req.rep.id from requireRep).

const express = require('express');
const { pool } = require('../db');
const { NEXT_VISIT_DUE_SQL, DAYS_OVERDUE_SQL, LAST_VISIT_LATERAL } = require('../visitPlanner');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// "This week" = overdue OR due within the next 7 days. A rep's agenda should
// surface the visits they're behind on AND the ones coming up, so we take
// everything due on or before 7 days from now (days_overdue >= -7), most
// overdue first.
//
// CLOSED contacts are excluded: a lost account isn't something you plan a
// visit to. Lead/active/dormant stay in — dormant especially, since an
// overdue dormant contact is a re-engagement prompt. (Status and the raw
// overdue math are intentionally independent everywhere else; this agenda-
// specific filter is a product decision, documented in PHASE_8_EXPLAINED.)
router.get('/', asyncHandler(async (req, res) => {
  const dueVisits = await pool.query(
    `SELECT c.id, c.full_name, c.contact_type, c.city, c.tier, c.status,
            c.calendar_event_id,
            w.name AS workplace_name, w.city AS workplace_city,
            ${NEXT_VISIT_DUE_SQL} AS next_visit_due,
            ${DAYS_OVERDUE_SQL}   AS days_overdue
       FROM contacts c
       LEFT JOIN workplaces w ON w.id = c.workplace_id
       ${LAST_VISIT_LATERAL}
      WHERE c.rep_id = $1
        AND c.status <> 'closed'
        AND ${NEXT_VISIT_DUE_SQL} <= now() + interval '7 days'
      ORDER BY ${NEXT_VISIT_DUE_SQL} ASC`,
    [req.rep.id]
  );

  // Pending orders the rep is waiting to see delivered. There's no separate
  // delivery-due date in the model, so "pending deliveries" = pending orders,
  // oldest first (the ones aging longest need chasing first).
  const pendingDeliveries = await pool.query(
    `SELECT o.id, o.contact_id, c.full_name AS contact_name,
            o.order_date, o.total_amount,
            (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o
       JOIN contacts c ON c.id = o.contact_id
      WHERE o.rep_id = $1 AND o.status = 'pending'
      ORDER BY o.order_date ASC`,
    [req.rep.id]
  );

  res.json({
    due_visits: dueVisits.rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      contact_type: r.contact_type,
      city: r.city,
      tier: r.tier,
      status: r.status,
      workplace: r.workplace_name
        ? { name: r.workplace_name, city: r.workplace_city }
        : null,
      next_visit_due: r.next_visit_due,
      days_overdue: r.days_overdue,
      is_overdue: r.days_overdue > 0,
      calendar_event_id: r.calendar_event_id,
    })),
    pending_deliveries: pendingDeliveries.rows,
  });
}));

module.exports = router;
