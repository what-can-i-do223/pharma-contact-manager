// ============================================================================
// visitPlanner.js — the visit-tier rule as shareable SQL fragments
// ============================================================================
//
// Phase 3 defined "when is a contact's next visit due" and computes it at
// query time (never stored). Phase 8's agenda needs the SAME computation, so
// the rule lives here — ONE source of truth — and both contacts.routes.js
// and agenda.routes.js import it. Duplicating the tier intervals across two
// files is exactly the drift risk Phase 3 argued against.
//
// USAGE CONTRACT: the fragments reference two aliases the embedding query
// MUST provide:
//   * `c`  — the contacts row (for c.tier, c.created_at)
//   * `lv` — a LATERAL join exposing `last_visit_at` (max created_at of this
//            contact's 'visit' activities). See either route file for the
//            exact join.

// THE product rule of the planner: how often each tier should be visited.
// Change it here and every due date + overdue flag across the app follows.
const TIER_VISIT_INTERVAL_DAYS = { A: 14, B: 30, C: 90 };

// The tier→interval rule as SQL. Interpolation is safe: every character comes
// from the server-side constant above (tier letters, integers), never input.
const TIER_INTERVAL_SQL = `make_interval(days => CASE c.tier ${Object.entries(
  TIER_VISIT_INTERVAL_DAYS
)
  .map(([tier, days]) => `WHEN '${tier}' THEN ${days}`)
  .join(' ')} END)`;

// next visit due = last actual visit (or created_at for never-visited) + the
// tier interval.
const NEXT_VISIT_DUE_SQL = `(coalesce(lv.last_visit_at, c.created_at) + ${TIER_INTERVAL_SQL})`;

// Signed whole days past due: 6 = six days overdue, -9 = due in nine days.
const DAYS_OVERDUE_SQL = `floor(extract(epoch FROM (now() - ${NEXT_VISIT_DUE_SQL})) / 86400)::int`;

// The LATERAL join the fragments depend on — exported so both routes build it
// identically instead of hand-copying the 'visit'-filtered subquery.
const LAST_VISIT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT max(a.created_at) AS last_visit_at
    FROM activities a
    WHERE a.contact_id = c.id AND a.kind = 'visit'
  ) lv ON true`;

module.exports = {
  TIER_VISIT_INTERVAL_DAYS,
  NEXT_VISIT_DUE_SQL,
  DAYS_OVERDUE_SQL,
  LAST_VISIT_LATERAL,
};
