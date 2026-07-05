// ============================================================================
// digest.routes.js — /api/digest : the daily-tasks email (Phase 9)
// ============================================================================
//
//   GET  /api/digest/preview → { subject, html, counts }   (build only, no send)
//   POST /api/digest/send    → emails the digest to the rep's OWN address
//
// The preview endpoint makes the feature demoable without opening an inbox
// (and needs no Google connection). Send uses the rep's Gmail token.
//
// ABUSE PREVENTION: the recipient is ALWAYS req.rep.email — taken from the
// verified session, never from the request body. A rep can email only
// themselves; there is no code path that accepts a `to` from the client.

const express = require('express');
const { buildDailyDigest } = require('../digest');
const { sendEmail, GoogleNotConnectedError } = require('../google');

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Shared "reconnect Google" response — same shape/code the calendar endpoint
// uses, so the client handles both features' not-connected case identically.
const notConnected = (res) =>
  res.status(409).json({
    error: 'Google account not connected — reconnect to send email',
    code: 'google_not_connected',
  });

router.get('/preview', asyncHandler(async (req, res) => {
  res.json(await buildDailyDigest(req.rep));
}));

router.post('/send', asyncHandler(async (req, res) => {
  const digest = await buildDailyDigest(req.rep);
  try {
    const messageId = await sendEmail(req.rep.id, {
      to: req.rep.email, // self only — never from the request
      subject: digest.subject,
      html: digest.html,
    });
    res.json({
      sent: true,
      to: req.rep.email,
      subject: digest.subject,
      counts: digest.counts,
      message_id: messageId,
    });
  } catch (err) {
    if (err instanceof GoogleNotConnectedError) return notConnected(res);
    throw err; // a real Gmail/API failure → central 500 handler
  }
}));

module.exports = router;
