// ============================================================================
// activities.routes.js — /api/contacts/:id/activities
// ============================================================================
//
//   POST /api/contacts/:id/activities   log a note / visit / call
//
// Reading the timeline has no endpoint of its own: the UI always shows it on
// the contact detail screen, which GET /api/contacts/:id already serves.
// Not building unused endpoints is a scope decision, not an omission.
// ============================================================================

const express = require('express');
const { pool } = require('../db');

// mergeParams: this router is mounted at '/api/contacts/:id/activities', and
// `:id` belongs to the MOUNT path — without this flag req.params.id would be
// undefined inside these handlers.
const router = express.Router({ mergeParams: true });

// The kinds a client may log directly. 'status_change' exists in the schema's
// CHECK but is deliberately NOT accepted here: those rows are written by the
// PATCH /api/contacts/:id transaction so the timeline can never claim a
// status change that didn't happen.
const USER_ACTIVITY_KINDS = ['note', 'visit', 'call'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.post('/', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'contact id must be a UUID' });
  }

  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'request body must be a JSON object' });
  }
  if (!USER_ACTIVITY_KINDS.includes(body.kind)) {
    return res.status(400).json({
      error: `kind must be one of: ${USER_ACTIVITY_KINDS.join(', ')}`,
    });
  }
  if (typeof body.body !== 'string' || body.body.trim().length === 0) {
    return res.status(400).json({ error: 'body must be a non-empty string' });
  }

  // Existence check first, so a missing contact is a clean 404 rather than
  // a foreign-key error we'd have to reverse-engineer a status code from.
  // Scoped by rep (Phase 7): logging an activity on another rep's contact
  // is the same 404 as a nonexistent one. No transaction needed: this is a
  // single INSERT, atomic by itself.
  const exists = await pool.query(
    'SELECT 1 FROM contacts WHERE id = $1 AND rep_id = $2',
    [id, req.rep.id]
  );
  if (exists.rows.length === 0) {
    return res.status(404).json({ error: 'contact not found' });
  }

  const { rows } = await pool.query(
    `INSERT INTO activities (contact_id, rep_id, kind, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, contact_id, kind, body, created_at`,
    [id, req.rep.id, body.kind, body.body.trim()]
  );

  res.status(201).json(rows[0]);
}));

module.exports = router;
