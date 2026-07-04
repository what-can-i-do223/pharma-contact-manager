// ============================================================================
// requireRep — the authentication wall for every data route
// ============================================================================
//
// Mounted as `app.use('/api', requireRep)` BEFORE the data routers, so no
// /api route can be reached anonymously (only /api/health is mounted above
// the wall — it exposes nothing). On success, `req.rep` = { id, email, name,
// google_connected } and every handler scopes its queries by req.rep.id.
//
// THE TENANT RULE THIS ENFORCES: the rep identity comes from the verified
// session cookie — NEVER from a request body, query param, or header a
// client could set. There is no code path where a client names its own rep.

const jwt = require('jsonwebtoken');
const { pool } = require('./db');

module.exports = async function requireRep(req, res, next) {
  try {
    const token = req.cookies?.session;
    if (!token) {
      return res.status(401).json({ error: 'not signed in' });
    }

    // Verifies signature AND expiry against SESSION_SECRET; throws on any
    // mismatch (tampered payload, wrong secret, expired) — caught below.
    const payload = jwt.verify(token, process.env.SESSION_SECRET);

    // Look the rep up fresh rather than trusting the JWT's claims for
    // anything but the id: a deleted rep's still-valid cookie must not
    // work, and email/name changes on next login should show immediately.
    const { rows } = await pool.query(
      `SELECT id, email, name,
              (google_refresh_token_enc IS NOT NULL) AS google_connected
         FROM reps WHERE id = $1`,
      [payload.rep_id]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'account no longer exists' });
    }

    req.rep = rows[0];
    next();
  } catch (err) {
    // jwt.verify throws JsonWebTokenError/TokenExpiredError — all of them
    // mean the same thing to the client: this session is no good.
    return res.status(401).json({ error: 'session invalid or expired — sign in again' });
  }
};
