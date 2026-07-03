// ============================================================================
// index.js — Express bootstrap
// ============================================================================
//
// Wiring order matters in Express (it's a middleware pipeline, top to
// bottom): body parsing → routes → 404 catch-all → error handler last.
//
// NO CORS middleware — deliberate: in development the Vite dev server
// (Phase 4) proxies /api/* to this port, so the browser only ever talks to
// one origin; in a real deployment the built client would be served from
// the same origin too. Not adding middleware we don't need.
// ============================================================================

require('dotenv').config();
const express = require('express');

const contactsRouter = require('./routes/contacts.routes');
const activitiesRouter = require('./routes/activities.routes');
const workplacesRouter = require('./routes/workplaces.routes');

const app = express();

// Parse JSON request bodies. Malformed JSON throws here and is turned into a
// clean 400 by the error handler at the bottom.
app.use(express.json());

// One-line liveness check — lets the setup instructions verify "server up +
// DB reachable" before any real endpoint is exercised.
app.get('/api/health', async (req, res) => {
  try {
    const { pool } = require('./db');
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: 'database unreachable' });
  }
});

// The activities router is mounted on the nested path; `mergeParams` inside
// it picks up `:id`. Mounted before /api/contacts only for readability —
// Express matches by path, so order between these two doesn't change routing.
app.use('/api/contacts/:id/activities', activitiesRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/workplaces', workplacesRouter);

// Anything that fell through every route above is an unknown path → 404 as
// JSON (this is an API; HTML error pages would just confuse fetch callers).
app.use((req, res) => {
  res.status(404).json({ error: `no route: ${req.method} ${req.path}` });
});

// Central error handler — MUST have 4 args or Express won't treat it as one.
// Everything unexpected funnels here: log the real error server-side, return
// a generic 500 (internal details don't belong in API responses).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') {
    // express.json() couldn't parse the body — the client's fault, not ours.
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
