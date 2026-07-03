// ============================================================================
// products.routes.js — /api/products
// ============================================================================
//
//   GET /api/products — the active catalog, for the new-order form.
//
// Read-only, like workplaces: the catalog comes from the seed; managing it
// (create/deactivate products) is back-office work outside a rep's app.
// Only ACTIVE products are returned — the one thing a rep can do with the
// catalog is order from it, and discontinued products can't be ordered.
// (Historical orders still display discontinued products fine: the order
// endpoints join order_items → products directly by id.)

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, sku, form, unit_price
       FROM products
      WHERE active
      ORDER BY name`
  );
  res.json(rows);
}));

module.exports = router;
