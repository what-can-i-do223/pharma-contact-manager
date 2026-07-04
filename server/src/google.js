// ============================================================================
// google.js — everything that touches Google OAuth in one place
// ============================================================================
//
//   * oauthClient()            — a fresh googleapis OAuth2 client from env
//   * SCOPES                   — what one login consent grants (identity +
//                                Calendar + Gmail, so Phases 8–9 need no
//                                second consent)
//   * encryptToken/decryptToken — AES-256-GCM for stored refresh tokens
//   * getGoogleClientForRep()  — an authed client for a rep, refreshing the
//                                access token first if it's (nearly) expired
//
// SECURITY INVARIANTS THIS MODULE UPHOLDS:
//   * No token or secret is ever logged or returned in an API response.
//   * Refresh tokens touch the database only encrypted; plaintext exists
//     only in memory, inside a request that needs it.

const crypto = require('crypto');
const { google } = require('googleapis');
const { pool } = require('./db');

// One consent covers login identity AND the two Google APIs used later.
// openid/email/profile → the ID token (who is this rep);
// calendar.events → Phase 8 visit events; gmail.send → Phase 9 digest.
// Narrow scopes on purpose: calendar.events can't read arbitrary calendars,
// gmail.send can't read mail.
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
];

// A new client per use (they carry per-rep credentials, so sharing one
// instance across requests would leak tokens between reps).
function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ----------------------------------------------------------------------------
// Refresh-token encryption (AES-256-GCM)
// ----------------------------------------------------------------------------
// WHY ENCRYPT: a refresh token is long-lived credential material — anyone
// holding it can mint Google access tokens for that rep indefinitely. A DB
// dump or leaked backup shouldn't hand those out in plaintext.
//
// KEY DERIVATION: sha256(SESSION_SECRET) → exactly the 32 bytes AES-256
// needs. One secret to manage instead of two; the documented tradeoff is
// that rotating SESSION_SECRET both logs everyone out AND orphans stored
// refresh tokens (reps re-consent on next login — annoying, not dangerous).
//
// GCM (not CBC) because it's authenticated: decryption fails loudly if the
// ciphertext was tampered with or the key is wrong, instead of silently
// yielding garbage bytes we'd then send to Google.
//
// Stored format: "<iv>:<authTag>:<ciphertext>", all hex. The IV is random
// per encryption (GCM's hard requirement: never reuse an IV under one key)
// and not secret — it just has to be unique, so it rides along in the value.
const encKey = () =>
  crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();

function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit IV, the GCM standard size
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('hex')).join(':');
}

function decryptToken(stored) {
  const [iv, tag, ct] = stored.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ----------------------------------------------------------------------------
// Per-rep authed client with refresh (used by Phases 8–9)
// ----------------------------------------------------------------------------
// Thrown when the rep never granted offline access (no refresh token) or
// revoked it — callers turn this into a "reconnect Google" prompt, not a 500.
class GoogleNotConnectedError extends Error {
  constructor() {
    super('Google account not connected for this rep — sign in with Google again');
    this.name = 'GoogleNotConnectedError';
  }
}

// Access tokens live ~1 hour. Refresh when within a minute of expiry rather
// than exactly at it, so a token can't expire mid-API-call.
const EXPIRY_SLACK_MS = 60 * 1000;

async function getGoogleClientForRep(repId) {
  const { rows } = await pool.query(
    `SELECT google_access_token, google_refresh_token_enc, token_expiry
       FROM reps WHERE id = $1`,
    [repId]
  );
  const rep = rows[0];
  if (!rep || !rep.google_refresh_token_enc) throw new GoogleNotConnectedError();

  const client = oauthClient();
  client.setCredentials({
    access_token: rep.google_access_token,
    refresh_token: decryptToken(rep.google_refresh_token_enc),
    expiry_date: rep.token_expiry ? new Date(rep.token_expiry).getTime() : 0,
  });

  const expired =
    !rep.token_expiry ||
    new Date(rep.token_expiry).getTime() < Date.now() + EXPIRY_SLACK_MS;

  if (expired) {
    // The refresh round trip: googleapis exchanges the refresh token for a
    // fresh access token. Persist it so other requests benefit — otherwise
    // every request would refresh again until this one's token expired.
    try {
      const { credentials } = await client.refreshAccessToken();
      await pool.query(
        `UPDATE reps SET google_access_token = $2, token_expiry = $3 WHERE id = $1`,
        [
          repId,
          credentials.access_token,
          credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        ]
      );
    } catch {
      // The refresh token is revoked/expired (Google returns invalid_grant).
      // Collapse it into the same "not connected" signal callers already
      // handle, so a revoked grant becomes a "reconnect Google" prompt, not
      // a 500. (We don't log the error — it can carry token material.)
      throw new GoogleNotConnectedError();
    }
  }

  return client;
}

// ----------------------------------------------------------------------------
// Phase 8 — Google Calendar
// ----------------------------------------------------------------------------

// Builds the events.insert request body for a contact's due visit. Pure and
// side-effect-free so it's unit-testable without touching Google. All-day
// event on the due date: for all-day events Google treats end.date as
// EXCLUSIVE, so a one-day event ends on the following day.
function buildVisitEvent({ fullName, workplace, nextVisitDue }) {
  const start = new Date(nextVisitDue);
  const ymd = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const end = new Date(start.getTime() + 86400000);

  const location = workplace
    ? [workplace.name, workplace.city].filter(Boolean).join(', ')
    : undefined;

  return {
    summary: `Visit: ${fullName}`,
    location,
    description: 'Scheduled by Pharma Contact Manager — tier-based follow-up visit.',
    start: { date: ymd(start) },
    end: { date: ymd(end) },
  };
}

// Creates the event on the rep's PRIMARY Google calendar and returns its id.
// Uses the rep's stored token (refreshing if needed via getGoogleClientForRep,
// which throws GoogleNotConnectedError when the rep hasn't connected / has
// revoked access — the caller turns that into a reconnect prompt).
async function createCalendarEvent(repId, eventBody) {
  const auth = await getGoogleClientForRep(repId);
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: eventBody,
  });
  return res.data.id;
}

module.exports = {
  SCOPES,
  oauthClient,
  encryptToken,
  decryptToken,
  getGoogleClientForRep,
  GoogleNotConnectedError,
  buildVisitEvent,
  createCalendarEvent,
};
