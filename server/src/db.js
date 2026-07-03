// ============================================================================
// db.js — the single shared PostgreSQL connection pool
// ============================================================================
//
// WHY A POOL (and why only one):
//   Opening a Postgres connection is expensive (TCP + auth handshake). A Pool
//   keeps a small set of connections alive and lends them out per query.
//   Every module imports THIS pool, so the whole app shares one set of
//   connections instead of each file creating its own.
//
// TWO WAYS THE APP USES IT:
//   * `pool.query(...)`         — one-shot queries. The pool checks a client
//                                 out, runs the query, returns it. Fine for
//                                 all single-statement reads/writes.
//   * `pool.connect()`          — checks out a DEDICATED client, needed for
//                                 transactions (BEGIN/COMMIT must run on the
//                                 same connection). Caller MUST release() it
//                                 in a finally block or the pool leaks.
//
// NO ORM — a deliberate stack choice. Raw SQL keeps every query visible and
// explainable, and $1/$2 parameter placeholders make injection impossible
// (values are sent separately from the SQL text, never string-concatenated).
// ============================================================================

// Load server/.env if present. Done here (not only in index.js) so anything
// that imports the pool — including future scripts/tests — gets the same
// configuration without depending on import order.
require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  // Standard libpq connection string. The fallback matches a stock local
  // Postgres (same OS user, no password), so `npm run dev` works with zero
  // config on a typical dev machine; .env overrides it when needed.
  connectionString:
    process.env.DATABASE_URL || 'postgres://localhost:5432/pharma_contacts',
});

// If an *idle* pooled connection dies (Postgres restarted, laptop slept),
// pg emits 'error' on the pool; without a handler that crashes the process.
// Log it — the pool replaces dead connections on the next checkout.
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = { pool };
