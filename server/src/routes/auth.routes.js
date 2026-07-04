// ============================================================================
// auth.routes.js — /auth/* : the Google OAuth flow + session management
// ============================================================================
//
// THE FLOW, END TO END (authorization-code grant):
//   1. Browser hits GET /auth/google → we redirect it to Google's consent
//      screen with our client id, requested scopes, and a random `state`.
//   2. The rep approves. Google redirects the browser to our REDIRECT_URI
//      (/auth/google/callback) carrying a one-time `code` and echoing state.
//   3. The SERVER exchanges code + client secret for tokens (the browser
//      never sees the client secret or the tokens — that's the point of the
//      code flow) and verifies the ID token's signature.
//   4. We upsert the rep by google_sub, store the Google tokens (refresh
//      token encrypted), and issue OUR OWN session: a short-lived signed JWT
//      in an httpOnly cookie. Google logs you in once; our cookie keeps you
//      logged in — Google is not consulted again per request.
//
// One consent therefore provides BOTH the rep's identity (multi-rep login)
// AND the Calendar/Gmail authorization used in Phases 8–9.

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { oauthClient, SCOPES, encryptToken } = require('../google');
const { seedStarterDataForRep } = require('../seedRep');
const requireRep = require('../requireRep');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';
const SESSION_HOURS = 12;

// Session cookie flags, used on set and clear (they must match for clearing
// to work). httpOnly: JS can't read it — an XSS can't exfiltrate the
// session. sameSite lax: not sent on cross-site POSTs (CSRF floor), but
// still sent on the top-level redirect back from Google. secure:false only
// because dev runs on plain http://localhost — a deployment must set it.
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: false, path: '/' };

// ----------------------------------------------------------------------------
// GET /auth/google — kick off the consent flow
// ----------------------------------------------------------------------------
router.get('/google', (req, res) => {
  // `state` defends against login CSRF: an attacker can't forge a callback
  // to our server carrying THEIR code, because they can't read the random
  // value we parked in the victim's cookie. Google echoes state back
  // untouched; the callback compares the two.
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { ...COOKIE_OPTS, maxAge: 10 * 60 * 1000 });

  const url = oauthClient().generateAuthUrl({
    scope: SCOPES,
    state,
    // offline → Google issues a REFRESH token (not just a 1h access token),
    // which Phases 8–9 need to act while the rep isn't mid-login.
    access_type: 'offline',
    // Google only returns the refresh token on the FIRST consent unless you
    // force the consent screen. For a dev prototype (where DBs get reset and
    // stored refresh tokens vanish), always forcing it is the reliable
    // choice; the cost is one extra click per login.
    prompt: 'consent',
  });
  res.redirect(url);
});

// ----------------------------------------------------------------------------
// GET /auth/google/callback — Google sends the browser back here
// ----------------------------------------------------------------------------
router.get('/google/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;

  // The rep clicked "cancel" on the consent screen — not an error, a choice.
  if (error) return res.redirect(`${APP_ORIGIN}/#/?login=denied`);

  // state mismatch = the callback wasn't initiated by this browser's own
  // /auth/google visit. Reject before touching the code.
  if (!state || state !== req.cookies?.oauth_state) {
    return res.status(400).json({ error: 'OAuth state mismatch — start the login again' });
  }
  res.clearCookie('oauth_state', COOKIE_OPTS);
  if (!code) return res.status(400).json({ error: 'missing authorization code' });

  // Exchange the one-time code for tokens. This is a server-to-server call
  // authenticated by our client secret.
  const client = oauthClient();
  const { tokens } = await client.getToken(String(code));

  // Don't trust — verify. The ID token is a JWT signed by Google;
  // verifyIdToken checks the signature against Google's published keys and
  // that it was minted for OUR client id. Its payload gives us the stable
  // account id (sub) plus email/name.
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const { sub, email, name } = ticket.getPayload();

  // Upsert on google_sub, then — for BRAND-NEW reps only — populate their
  // account with onboarding starter data. Both happen in ONE transaction, so
  // a new rep atomically gets their account AND their sample dataset, or
  // neither: no half-seeded reps if seeding fails partway.
  //
  // `(xmax = 0) AS inserted` distinguishes insert from update in the upsert:
  // for a freshly INSERTED row xmax is 0; ON CONFLICT DO UPDATE locks the
  // existing row first, leaving xmax non-zero. So `inserted` is true only on
  // a rep's very first login. Returning logins refresh profile+tokens (the
  // COALESCE keeps a stored refresh token when Google omits one) and are
  // NEVER reseeded — that would duplicate their data.
  // `client` above is the Google OAuth client; use a distinct name for the
  // pooled DB connection this transaction runs on.
  const db = await pool.connect();
  let repId;
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `INSERT INTO reps (google_sub, email, name,
                         google_access_token, google_refresh_token_enc, token_expiry)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (google_sub) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         google_access_token = EXCLUDED.google_access_token,
         google_refresh_token_enc = COALESCE(EXCLUDED.google_refresh_token_enc,
                                             reps.google_refresh_token_enc),
         token_expiry = EXCLUDED.token_expiry
       RETURNING id, (xmax = 0) AS inserted`,
      [
        sub,
        email,
        name || email,
        tokens.access_token,
        tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      ]
    );
    repId = rows[0].id;

    if (rows[0].inserted) {
      await seedStarterDataForRep(db, repId);
    }

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }

  // OUR session: a JWT naming only the rep id, signed with SESSION_SECRET,
  // short-lived. The Google tokens stay server-side; the browser holds only
  // this cookie.
  const session = jwt.sign({ rep_id: repId }, process.env.SESSION_SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });
  res.cookie('session', session, {
    ...COOKIE_OPTS,
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });

  res.redirect(APP_ORIGIN);
}));

// ----------------------------------------------------------------------------
// GET /auth/me — who am I? (the client's session probe)
// ----------------------------------------------------------------------------
// Reuses requireRep, so "me" and "may I use the API" can never disagree.
// Returns id/email/name/google_connected — and no token fields, ever.
router.get('/me', requireRep, (req, res) => {
  res.json(req.rep);
});

// ----------------------------------------------------------------------------
// POST /auth/logout — clear the session cookie
// ----------------------------------------------------------------------------
// POST (not GET) so a hostile <img src="/auth/logout"> can't log reps out.
// Only OUR session ends; the Google grant stays (revoking it lives in the
// rep's Google account settings, where it belongs).
router.post('/logout', (req, res) => {
  res.clearCookie('session', COOKIE_OPTS);
  res.json({ ok: true });
});

module.exports = router;
