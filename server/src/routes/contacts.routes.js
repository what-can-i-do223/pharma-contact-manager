// ============================================================================
// contacts.routes.js — /api/contacts
// ============================================================================
//
// Endpoints:
//   POST   /api/contacts        create (base + type detail row, one transaction)
//   GET    /api/contacts        list with ?type= ?status= ?city= ?q= ?sort=
//   GET    /api/contacts/:id    full detail incl. type details + activity timeline
//   PATCH  /api/contacts/:id    update base/status/details (status change is
//                               also logged as an activity, same transaction)
//
// CONVENTIONS USED THROUGHOUT:
//   * Every SQL value goes through $1/$2 placeholders — never string
//     concatenation. The only strings ever interpolated into SQL are
//     server-controlled (whitelisted column names, ORDER BY clauses).
//   * Validation happens BEFORE any SQL runs, and returns 400 with a message
//     that names the offending field — the DB's CHECK constraints are the
//     safety net, not the user-facing error path.
//   * Errors: 400 = you sent something wrong, 404 = the id doesn't exist,
//     500 = our bug (handled centrally in index.js).
// ============================================================================

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// ----------------------------------------------------------------------------
// Constants — mirror the schema's CHECK constraints
// ----------------------------------------------------------------------------
// Kept in one place so a validation message and the DB constraint can't
// drift apart silently. If schema.sql changes, change these.
const CONTACT_TYPES = ['hcp', 'pharmacist', 'procurement'];
const STATUSES = ['lead', 'active', 'dormant', 'closed'];
const TIERS = ['A', 'B', 'C'];

// Per-type detail metadata: which table completes each contact type and
// which fields it accepts. `required` is enforced on create; on PATCH all
// fields are optional. This table *drives* validation and the dynamic
// INSERT/UPDATE column lists — the only place a new detail field is added.
const DETAIL_SPEC = {
  hcp: {
    table: 'hcp_details',
    fields: {
      specialty: { required: true, kind: 'string' },
      role: { required: false, kind: 'string' },
    },
  },
  pharmacist: {
    table: 'pharmacist_details',
    fields: {
      // Optional on create: the DB default (false) applies when omitted.
      is_owner: { required: false, kind: 'boolean' },
    },
  },
  procurement: {
    table: 'procurement_details',
    fields: {
      purchasing_role: { required: true, kind: 'string' },
    },
  },
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ----------------------------------------------------------------------------
// Phase 3a — visit-tier planner constants
// ----------------------------------------------------------------------------
// How often each tier should be visited. THE product rule of the planner —
// change it here and every computed due date follows, because nothing below
// stores a due date: it's derived at query time from the activity log.
const TIER_VISIT_INTERVAL_DAYS = { A: 14, B: 30, C: 90 };

// The tier→interval rule as a SQL fragment. Interpolation is safe here:
// every character comes from the server-side constant above (tier letters
// and integers), never from a request.
const TIER_INTERVAL_SQL = `make_interval(days => CASE c.tier ${Object.entries(
  TIER_VISIT_INTERVAL_DAYS
)
  .map(([tier, days]) => `WHEN '${tier}' THEN ${days}`)
  .join(' ')} END)`;

// "When is the next visit due?" = last actual visit (or, for contacts never
// visited, when we first added them) + the tier's interval. `lv` is the
// LATERAL join in CONTACT_SELECT below. Defined once and reused in SELECT,
// WHERE (?overdue=) and ORDER BY (sort=overdue) — SQL can't reference a
// SELECT alias from WHERE, so the expression itself is the shared artifact.
const NEXT_VISIT_DUE_SQL = `(coalesce(lv.last_visit_at, c.created_at) + ${TIER_INTERVAL_SQL})`;

// Signed whole days past due: 6 = six days overdue, -9 = due in nine days.
// Keeping the sign (rather than clamping at 0) costs nothing and lets the
// client show "due in N days" for free. floor() so a contact only counts as
// "1 day overdue" once a full day has passed.
const DAYS_OVERDUE_SQL = `floor(extract(epoch FROM (now() - ${NEXT_VISIT_DUE_SQL})) / 86400)::int`;

// ----------------------------------------------------------------------------
// Phase 3b — duplicate-warning threshold
// ----------------------------------------------------------------------------
// Chosen EMPIRICALLY against the seed data, not guessed:
//   * unrelated seeded names top out at 0.23 similarity,
//   * a different person sharing a SURNAME ("Dr. Sanjay Mehta" vs
//     "Dr. Asha Mehta") scores 0.43 — below threshold, no warning,
//   * genuine duplicate variants of "Dr. Asha Mehta" — missing dot, typo
//     "Meta", dropped title, initialled first name — score 0.50–1.00.
// KNOWN FALSE-POSITIVE MODE (found in live testing, kept deliberately):
// a different person sharing title + FIRST name ("Dr. Sanjay Mehta" vs
// "Dr. Sanjay Gupta") scores 0.52 and triggers the warning. Raising the
// threshold above it would also silence real variants like "Asha Meta"
// (0.50). For a warning that costs one click to dismiss, a false positive
// is noise but a false negative defeats the feature — so 0.45 stands.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.45;

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

// Express 4 does not catch rejected promises from async handlers — without
// this wrapper an awaited query failure would hang the request instead of
// reaching the error middleware in index.js.
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Uniform 400 shape: { "error": "human-readable message" }.
const badRequest = (res, message) => res.status(400).json({ error: message });

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------
// Returns { error } on failure, or { base, details } with only the validated,
// normalized fields present. `partial: true` (PATCH) makes everything
// optional and forbids contact_type (changing type would orphan the detail
// row — deliberately unsupported).

function validateContactBody(body, { partial }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' };
  }

  const base = {};

  // -- contact_type: required on create, immutable afterwards ---------------
  if (!partial) {
    if (!CONTACT_TYPES.includes(body.contact_type)) {
      return { error: `contact_type is required and must be one of: ${CONTACT_TYPES.join(', ')}` };
    }
    base.contact_type = body.contact_type;
  } else if ('contact_type' in body) {
    return { error: 'contact_type cannot be changed after creation' };
  }

  // -- required-on-create text fields ----------------------------------------
  for (const field of ['full_name', 'city']) {
    if (field in body) {
      if (!isNonEmptyString(body[field])) {
        return { error: `${field} must be a non-empty string` };
      }
      base[field] = body[field].trim();
    } else if (!partial) {
      return { error: `${field} is required` };
    }
  }

  // -- optional text fields (null explicitly clears them) --------------------
  for (const field of ['phone', 'email']) {
    if (field in body) {
      if (body[field] !== null && !isNonEmptyString(body[field])) {
        return { error: `${field} must be a non-empty string or null` };
      }
      base[field] = body[field] === null ? null : body[field].trim();
    }
  }

  // -- enum fields ------------------------------------------------------------
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) {
      return { error: `status must be one of: ${STATUSES.join(', ')}` };
    }
    base.status = body.status;
  }
  if ('tier' in body) {
    if (!TIERS.includes(body.tier)) {
      return { error: `tier must be one of: ${TIERS.join(', ')}` };
    }
    base.tier = body.tier;
  }

  // -- workplace link (null unlinks; existence is checked by the FK) ---------
  if ('workplace_id' in body) {
    if (body.workplace_id !== null && !UUID_RE.test(String(body.workplace_id))) {
      return { error: 'workplace_id must be a UUID or null' };
    }
    base.workplace_id = body.workplace_id;
  }

  // Details are validated separately: on PATCH the contact's type comes from
  // the database, not the request, so the caller validates once it knows it.
  return { base, details: 'details' in body ? body.details : undefined };
}

// Validates the type-specific `details` object against DETAIL_SPEC[type].
// Unknown keys are rejected (not ignored) so a typo like "speciality" fails
// loudly instead of silently dropping the value.
function validateDetails(contactType, details, { partial }) {
  const spec = DETAIL_SPEC[contactType];

  if (details === undefined) {
    if (partial) return { fields: {} }; // PATCH without details: nothing to do
    details = {}; // create: allow omission when no field is required...
  }
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return { error: 'details must be a JSON object' };
  }

  const allowed = Object.keys(spec.fields);
  for (const key of Object.keys(details)) {
    if (!allowed.includes(key)) {
      return { error: `unknown details field "${key}" for type ${contactType} (allowed: ${allowed.join(', ')})` };
    }
  }

  const fields = {};
  for (const [key, rules] of Object.entries(spec.fields)) {
    if (key in details) {
      const value = details[key];
      if (rules.kind === 'boolean') {
        if (typeof value !== 'boolean') return { error: `details.${key} must be true or false` };
        fields[key] = value;
      } else if (rules.required) {
        if (!isNonEmptyString(value)) return { error: `details.${key} must be a non-empty string` };
        fields[key] = value.trim();
      } else {
        if (value !== null && !isNonEmptyString(value)) {
          return { error: `details.${key} must be a non-empty string or null` };
        }
        fields[key] = value === null ? null : value.trim();
      }
    } else if (!partial && rules.required) {
      // ...but required fields still bite on create (e.g. hcp needs specialty).
      return { error: `details.${key} is required for type ${contactType}` };
    }
  }
  return { fields };
}

// ----------------------------------------------------------------------------
// Shared SELECT + row shaping
// ----------------------------------------------------------------------------
// One SELECT serves both the list and the single-contact endpoints, so the
// response shape can't diverge between them. LEFT JOINs because: a contact
// has exactly one of the three detail rows (the other two joins return
// NULLs), and workplace is optional.
//
// The LATERAL subqueries compute per-contact timestamps from the activity
// log. LATERAL = "run this subquery once per row of c" — it reads naturally
// and the planner drives both off idx_activities_contact_created.
//   la = last activity of ANY kind   → "last contacted" column
//   lv = last activity of kind VISIT → drives the overdue planner
// Two subqueries, not one, because they answer different questions: a call
// updates "last contacted" but does NOT reset the visit clock.
//
// next_visit_due / days_overdue are COMPUTED HERE AT QUERY TIME, never
// stored. A stored copy would be a cache to keep in sync on every activity
// insert and tier change; deriving from the log can't drift. At a rep's
// data volume the cost is microseconds.
const CONTACT_SELECT = `
  SELECT
    c.id, c.full_name, c.contact_type, c.phone, c.email, c.city,
    c.status, c.tier, c.created_at, c.updated_at,
    w.id   AS workplace_id,
    w.name AS workplace_name,
    w.kind AS workplace_kind,
    w.city AS workplace_city,
    h.specialty, h.role,
    p.is_owner,
    pr.purchasing_role,
    la.last_activity_at,
    lv.last_visit_at,
    ov.total_order_value,
    ${NEXT_VISIT_DUE_SQL} AS next_visit_due,
    ${DAYS_OVERDUE_SQL}   AS days_overdue
  FROM contacts c
  LEFT JOIN workplaces          w  ON w.id = c.workplace_id
  LEFT JOIN hcp_details         h  ON h.contact_id  = c.id
  LEFT JOIN pharmacist_details  p  ON p.contact_id  = c.id
  LEFT JOIN procurement_details pr ON pr.contact_id = c.id
  LEFT JOIN LATERAL (
    SELECT max(a.created_at) AS last_activity_at
    FROM activities a
    WHERE a.contact_id = c.id
  ) la ON true
  LEFT JOIN LATERAL (
    SELECT max(a.created_at) AS last_visit_at
    FROM activities a
    WHERE a.contact_id = c.id AND a.kind = 'visit'
  ) lv ON true
  LEFT JOIN LATERAL (
    -- Phase 6: lifetime order value shown on the detail page. Cancelled
    -- orders don't count — they're money that did NOT happen. NUMERIC sum
    -- in Postgres (arrives as a string), coalesced so no-orders reads 0.
    SELECT coalesce(sum(o.total_amount), 0) AS total_order_value
    FROM orders o
    WHERE o.contact_id = c.id AND o.status <> 'cancelled'
  ) ov ON true
`;

// Folds a flat SQL row into the API's nested JSON shape. The `details`
// object contains only the fields for THIS contact's type — the NULL columns
// from the two non-matching detail joins are simply not read.
function shapeContact(row) {
  let details;
  if (row.contact_type === 'hcp') {
    details = { specialty: row.specialty, role: row.role };
  } else if (row.contact_type === 'pharmacist') {
    details = { is_owner: row.is_owner };
  } else {
    details = { purchasing_role: row.purchasing_role };
  }

  return {
    id: row.id,
    full_name: row.full_name,
    contact_type: row.contact_type,
    phone: row.phone,
    email: row.email,
    city: row.city,
    status: row.status,
    tier: row.tier,
    workplace: row.workplace_id
      ? { id: row.workplace_id, name: row.workplace_name, kind: row.workplace_kind, city: row.workplace_city }
      : null,
    details,
    last_activity_at: row.last_activity_at,
    // Planner fields (Phase 3a). is_overdue is derived server-side so every
    // client agrees on what "overdue" means — the client never re-implements
    // the rule, it just renders these.
    last_visit_at: row.last_visit_at,
    next_visit_due: row.next_visit_due,
    days_overdue: row.days_overdue,
    is_overdue: row.days_overdue > 0,
    // NUMERIC string, e.g. "46986.00" — formatting is the client's job.
    total_order_value: row.total_order_value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Fetch one contact in full API shape (used by GET /:id and to build the
// response after POST/PATCH, so writes always return the canonical shape).
async function fetchContact(id) {
  const { rows } = await pool.query(`${CONTACT_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? shapeContact(rows[0]) : null;
}

// ----------------------------------------------------------------------------
// GET /api/contacts — filterable, sortable list
// ----------------------------------------------------------------------------
router.get('/', asyncHandler(async (req, res) => {
  const { type, status, city, q, sort, overdue } = req.query;

  // WHERE clauses and their parameters are built in lockstep: push the value,
  // then reference it as $<position>. Values never touch the SQL string.
  const where = [];
  const params = [];

  if (type !== undefined) {
    if (!CONTACT_TYPES.includes(type)) {
      return badRequest(res, `type must be one of: ${CONTACT_TYPES.join(', ')}`);
    }
    params.push(type);
    where.push(`c.contact_type = $${params.length}`);
  }

  if (status !== undefined) {
    if (!STATUSES.includes(status)) {
      return badRequest(res, `status must be one of: ${STATUSES.join(', ')}`);
    }
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }

  if (city !== undefined) {
    // ILIKE without wildcards = case-insensitive equality ("pune" finds "Pune").
    params.push(city);
    where.push(`c.city ILIKE $${params.length}`);
  }

  if (q !== undefined) {
    // Substring name search. The wildcards live in the PARAMETER, not the
    // SQL, so a q containing % or _ is still safe (worst case: odd matches).
    params.push(`%${q}%`);
    where.push(`c.full_name ILIKE $${params.length}`);
  }

  if (overdue !== undefined) {
    if (overdue !== 'true' && overdue !== 'false') {
      return badRequest(res, "overdue must be 'true' or 'false'");
    }
    // The due-date expression goes into WHERE directly (SQL can't reference
    // a SELECT alias there). No params: the expression is built entirely
    // from server-side constants. Note the filter composes with the others —
    // ?overdue=true&status=active is the rep's real "today list".
    where.push(
      overdue === 'true'
        ? `now() > ${NEXT_VISIT_DUE_SQL}`
        : `now() <= ${NEXT_VISIT_DUE_SQL}`
    );
  }

  // ORDER BY cannot be parameterized ($n only works for values), so the sort
  // key is mapped through this whitelist — request input never reaches the
  // SQL string itself.
  const SORTS = {
    name: 'c.full_name ASC',
    last_contacted: 'la.last_activity_at DESC NULLS LAST',
    // Most overdue first; among not-yet-due contacts this naturally becomes
    // "due soonest first", which is exactly what a planning screen wants.
    overdue: `${DAYS_OVERDUE_SQL} DESC`,
  };
  const sortKey = sort === undefined ? 'name' : sort;
  if (!SORTS[sortKey]) {
    return badRequest(res, `sort must be one of: ${Object.keys(SORTS).join(', ')}`);
  }

  const sql = `
    ${CONTACT_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${SORTS[sortKey]}
  `;
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(shapeContact));
}));

// ----------------------------------------------------------------------------
// GET /api/contacts/:id — full detail + activity timeline
// ----------------------------------------------------------------------------
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Validate the UUID shape ourselves: otherwise Postgres throws a cast
  // error, which would surface as a 500 for what is really a bad request.
  if (!UUID_RE.test(id)) return badRequest(res, 'contact id must be a UUID');

  const contact = await fetchContact(id);
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  // Second query for the timeline. One round-trip more than a mega-join,
  // but each query stays trivially readable — the right trade at this scale.
  const { rows: activities } = await pool.query(
    `SELECT id, kind, body, created_at
       FROM activities
      WHERE contact_id = $1
      ORDER BY created_at DESC`,
    [id]
  );

  res.json({ ...contact, activities });
}));

// ----------------------------------------------------------------------------
// POST /api/contacts — create base + detail row in ONE transaction
// ----------------------------------------------------------------------------
// The schema guarantees a detail row can't be of the wrong type, but it can't
// guarantee one EXISTS — that's this transaction's job: either both rows are
// created or neither is. No half-contacts, even if the process dies mid-way.
router.post('/', asyncHandler(async (req, res) => {
  const validated = validateContactBody(req.body, { partial: false });
  if (validated.error) return badRequest(res, validated.error);

  const { base } = validated;
  const detailsResult = validateDetails(base.contact_type, validated.details, { partial: false });
  if (detailsResult.error) return badRequest(res, detailsResult.error);
  const detailFields = detailsResult.fields;

  // -- Phase 3b: duplicate warning -------------------------------------------
  // Trigram similarity across ALL existing names (not just same-type: the
  // same human entered once as HCP and once as procurement is still a dupe).
  // Above threshold → 409 with the candidates; the client reviews them and
  // may resubmit with ?force=true, which skips this check entirely.
  // Runs BEFORE the transaction — it's a read, nothing to roll back.
  // No trigram index: similarity() in this form scans, and a scan over one
  // rep's contacts is sub-millisecond. (An index needs the % operator and
  // set_limit() — machinery this data volume doesn't justify.)
  if (req.query.force !== 'true') {
    const { rows: matches } = await pool.query(
      `SELECT id, full_name, contact_type, city,
              round(similarity(full_name, $1)::numeric, 2) AS similarity
         FROM contacts
        WHERE similarity(full_name, $1) >= $2
        ORDER BY similarity(full_name, $1) DESC
        LIMIT 5`,
      [base.full_name, DUPLICATE_SIMILARITY_THRESHOLD]
    );
    if (matches.length > 0) {
      // 409 Conflict: the request is well-formed but clashes with existing
      // state. Distinct from 400 so the client can branch: 400 → fix the
      // form, 409 → show the "did you mean one of these?" dialog.
      return res.status(409).json({
        error: 'possible duplicate: existing contact(s) have a very similar name',
        matches,
        hint: 'review the matches; resubmit with ?force=true to create anyway',
      });
    }
  }

  // Build the INSERT from whichever base fields were provided, so DB defaults
  // (status 'lead', tier 'C') apply when the client omits them — defaults
  // live in ONE place, the schema. Column names come from our validator's
  // whitelist, never from raw input.
  const cols = Object.keys(base);
  const values = cols.map((c) => base[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  // Transactions need one dedicated connection (BEGIN/COMMIT are per-
  // connection state), hence pool.connect() instead of pool.query().
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO contacts (${cols.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id`,
      values
    );
    const contactId = inserted.rows[0].id;

    // Detail row — even when no fields were provided (pharmacist with all
    // defaults) the row itself must exist to complete the contact.
    const spec = DETAIL_SPEC[base.contact_type];
    const dCols = Object.keys(detailFields);
    await client.query(
      `INSERT INTO ${spec.table} (contact_id${dCols.map((c) => `, ${c}`).join('')})
       VALUES ($1${dCols.map((_, i) => `, $${i + 2}`).join('')})`,
      [contactId, ...dCols.map((c) => detailFields[c])]
    );

    await client.query('COMMIT');
    res.status(201).json(await fetchContact(contactId));
  } catch (err) {
    await client.query('ROLLBACK');
    // 23503 = foreign key violation; the only FK reachable from user input
    // here is workplace_id (a well-formed UUID that matches no workplace).
    if (err.code === '23503') {
      return badRequest(res, 'workplace_id does not reference an existing workplace');
    }
    throw err; // anything else is our bug → central 500 handler
  } finally {
    client.release(); // ALWAYS return the connection, success or failure
  }
}));

// ----------------------------------------------------------------------------
// PATCH /api/contacts/:id — partial update; status changes hit the timeline
// ----------------------------------------------------------------------------
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return badRequest(res, 'contact id must be a UUID');

  const validated = validateContactBody(req.body, { partial: true });
  if (validated.error) return badRequest(res, validated.error);
  const { base } = validated;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE locks the row so the read-compare-write below (does the
    // status actually change?) can't race a concurrent PATCH to the same
    // contact. Also tells us the contact's type, which details validation
    // needs — on PATCH the type comes from the DB, never the request.
    const current = await client.query(
      'SELECT contact_type, status FROM contacts WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'contact not found' });
    }
    const { contact_type: contactType, status: oldStatus } = current.rows[0];

    const detailsResult = validateDetails(contactType, validated.details, { partial: true });
    if (detailsResult.error) {
      await client.query('ROLLBACK');
      return badRequest(res, detailsResult.error);
    }
    const detailFields = detailsResult.fields;

    if (Object.keys(base).length === 0 && Object.keys(detailFields).length === 0) {
      await client.query('ROLLBACK');
      return badRequest(res, 'request body contains no updatable fields');
    }

    // Base-row update. updated_at is maintained HERE (schema decision: no
    // trigger) — and bumped even for detail-only patches, since details are
    // conceptually part of the contact.
    const sets = Object.keys(base).map((col, i) => `${col} = $${i + 1}`);
    await client.query(
      `UPDATE contacts
          SET ${[...sets, 'updated_at = now()'].join(', ')}
        WHERE id = $${sets.length + 1}`,
      [...Object.values(base), id]
    );

    // A REAL status change (not just re-sending the current value) is logged
    // in the same transaction — the timeline and the status can never
    // disagree, because they commit or roll back together.
    if (base.status !== undefined && base.status !== oldStatus) {
      await client.query(
        `INSERT INTO activities (contact_id, kind, body)
         VALUES ($1, 'status_change', $2)`,
        [id, `Status changed from ${oldStatus} to ${base.status}.`]
      );
    }

    if (Object.keys(detailFields).length > 0) {
      const spec = DETAIL_SPEC[contactType];
      const dSets = Object.keys(detailFields).map((col, i) => `${col} = $${i + 1}`);
      await client.query(
        `UPDATE ${spec.table}
            SET ${dSets.join(', ')}
          WHERE contact_id = $${dSets.length + 1}`,
        [...Object.values(detailFields), id]
      );
    }

    await client.query('COMMIT');
    res.json(await fetchContact(id));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') {
      return badRequest(res, 'workplace_id does not reference an existing workplace');
    }
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
