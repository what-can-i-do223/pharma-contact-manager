// ============================================================================
// digest.js — the daily-tasks email body (Phase 9)
// ============================================================================
//
// buildDailyDigest(rep) queries the rep's OWN overdue contacts (grouped by
// city, so the rep can plan a route) and pending order deliveries, and
// returns { subject, html, counts }. It only builds — sending is a separate
// concern (google.sendEmail), so the body is trivially previewable in-app
// without touching Gmail.
//
// Everything is scoped to rep.id; the digest can only ever describe the
// signed-in rep's data. The tier/overdue rule is imported from
// visitPlanner.js — the same single source of truth the list and agenda use.

const { pool } = require('./db');
const { NEXT_VISIT_DUE_SQL, DAYS_OVERDUE_SQL, LAST_VISIT_LATERAL } = require('./visitPlanner');

// ₹ with Indian digit grouping. Matches the helper in orders.routes.js /
// seedRep.js (a tiny formatter deliberately duplicated rather than coupling
// these modules through a shared import). Display-only — no math here.
const fmtINR = (n) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(parseFloat(n));

// Minimal HTML escape for the few user-controlled strings that land in the
// email (contact/ city names). Emails aren't a browser DOM, but a contact
// literally named "A & B <Clinic>" shouldn't corrupt the markup.
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

async function buildDailyDigest(rep) {
  // Overdue = due date already past (days_overdue > 0). Closed contacts are
  // excluded (you don't visit lost accounts) — same rule as the agenda.
  // Ordered by city then most-overdue-first so the grouping below is stable.
  const overdue = await pool.query(
    `SELECT c.full_name, c.city, c.tier, ${DAYS_OVERDUE_SQL} AS days_overdue
       FROM contacts c
       ${LAST_VISIT_LATERAL}
      WHERE c.rep_id = $1
        AND c.status <> 'closed'
        AND ${NEXT_VISIT_DUE_SQL} < now()
      ORDER BY c.city ASC, ${DAYS_OVERDUE_SQL} DESC`,
    [rep.id]
  );

  const pending = await pool.query(
    `SELECT c.full_name AS contact_name, o.total_amount,
            floor(extract(epoch FROM (now() - o.order_date)) / 86400)::int AS days_ago
       FROM orders o
       JOIN contacts c ON c.id = o.contact_id
      WHERE o.rep_id = $1 AND o.status = 'pending'
      ORDER BY o.order_date ASC`,
    [rep.id]
  );

  // Group overdue rows by city in JS (simpler than SQL aggregation for
  // building the nested HTML). Insertion order follows the ORDER BY.
  const byCity = new Map();
  for (const row of overdue.rows) {
    if (!byCity.has(row.city)) byCity.set(row.city, []);
    byCity.get(row.city).push(row);
  }

  const counts = {
    overdue: overdue.rows.length,
    cities: byCity.size,
    pending_orders: pending.rows.length,
  };

  // Subject is kept ASCII on purpose: it becomes an email header, and non-
  // ASCII there needs RFC-2047 encoding. The ₹ symbol lives only in the
  // UTF-8 HTML body. (An em dash would also break a raw header — hyphen it is.)
  const subject =
    `Your pharma tasks for today: ${counts.overdue} overdue visit` +
    `${counts.overdue === 1 ? '' : 's'}, ${counts.pending_orders} pending order` +
    `${counts.pending_orders === 1 ? '' : 's'}`;

  return { subject, html: renderHtml(rep, byCity, pending.rows, counts), counts };
}

// ----------------------------------------------------------------------------
// HTML rendering — inline styles only (email clients strip <style> blocks and
// don't cascade external CSS). Plain tables, web-safe font stack.
// ----------------------------------------------------------------------------
function renderHtml(rep, byCity, pendingRows, counts) {
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const overdueSection =
    counts.overdue === 0
      ? `<p style="color:#15803d;">No overdue visits — you're all caught up. 🎉</p>`
      : [...byCity.entries()]
          .map(
            ([city, rows]) => `
        <h3 style="font-size:14px;color:#2563eb;margin:16px 0 4px;">${esc(city)}</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${rows
            .map(
              (r) => `
          <tr>
            <td style="padding:4px 0;border-bottom:1px solid #f0f0f0;">
              ${esc(r.full_name)} <span style="color:#6b7280;">· Tier ${esc(r.tier)}</span>
            </td>
            <td style="padding:4px 0;border-bottom:1px solid #f0f0f0;text-align:right;color:#dc2626;font-weight:600;white-space:nowrap;">
              ${r.days_overdue}d overdue
            </td>
          </tr>`
            )
            .join('')}
        </table>`
          )
          .join('');

  const pendingSection =
    pendingRows.length === 0
      ? `<p style="color:#6b7280;">No orders awaiting delivery.</p>`
      : `<table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${pendingRows
            .map(
              (o) => `
          <tr>
            <td style="padding:4px 0;border-bottom:1px solid #f0f0f0;">
              ${esc(o.contact_name)} <span style="color:#6b7280;">· ordered ${o.days_ago}d ago</span>
            </td>
            <td style="padding:4px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;white-space:nowrap;">
              ${fmtINR(o.total_amount)}
            </td>
          </tr>`
            )
            .join('')}
        </table>`;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:8px;color:#1f2937;">
  <h1 style="font-size:20px;margin:0 0 4px;">Today's tasks</h1>
  <p style="color:#6b7280;margin:0 0 20px;">Hi ${esc(rep.name)}, here's your day for ${today}.</p>

  <h2 style="font-size:16px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;">
    Overdue visits <span style="color:#6b7280;font-weight:400;">(${counts.overdue})</span>
  </h2>
  ${overdueSection}

  <h2 style="font-size:16px;border-bottom:2px solid #e5e7eb;padding-bottom:4px;margin-top:28px;">
    Pending deliveries <span style="color:#6b7280;font-weight:400;">(${counts.pending_orders})</span>
  </h2>
  ${pendingSection}

  <p style="color:#9ca3af;font-size:12px;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px;">
    Sent by Pharma Contact Manager. You're receiving this because you asked for today's tasks.
  </p>
</div>`;
}

module.exports = { buildDailyDigest };
