// ============================================================================
// workplaces.routes.js — /api/workplaces
// ============================================================================
//
//   GET /api/workplaces — the full list, for the new-contact form's dropdown.
//
// Added in Phase 4: the create-contact form needs something to put in its
// workplace <select>, and seeded UUIDs can't be typed by hand. Read-only —
// creating/editing workplaces is out of scope for the prototype (they come
// from the seed), which is why there's no POST/PATCH here.
// No filters or paging: one rep's territory has tens of workplaces, and the
// client filters by kind locally (hospitals for HCPs, pharmacies for
// pharmacists) as a UX nicety.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  // No rep_id filter — workplaces, like products, is global reference data.
  const { rows } = await pool.query(
    'SELECT id, name, kind, city FROM workplaces ORDER BY name'
  );
  res.json(rows);
}));

module.exports = router;
