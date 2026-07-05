// ============================================================================
// scheduler.js — the 7am daily-digest cron (Phase 9 follow-up)
// ============================================================================
//
// IMPORTANT — READ BEFORE ASSUMING THIS "JUST WORKS":
//   node-cron's schedule is an IN-PROCESS timer. It only fires while THIS
//   Node process is alive and running. It is NOT a system cron job, and it
//   does NOT persist across restarts or survive the process being asleep/
//   stopped. That means:
//     - On a laptop dev machine, or any host that stops the process (most
//       serverless/on-demand platforms), the 7am job simply never fires
//       unless the server happens to be up at that moment.
//     - It only behaves like a real "every day at 7am" job on an ALWAYS-ON
//       host (a VM, a long-running container, a process manager like pm2/
//       systemd keeping `node src/index.js` alive continuously).
//   For local development and for demoing this feature, the in-app "Send me
//   today's tasks" button (Phase 9) remains the reliable way to trigger a
//   send — it doesn't depend on the clock or the process's uptime.
//
// CONFIGURATION (see server/.env.example):
//   DIGEST_CRON       — a standard 5-field cron expression, e.g. "0 7 * * *"
//                        for 7:00 AM server time daily. UNSET BY DEFAULT — no
//                        job is scheduled unless this is explicitly set, so a
//                        fresh checkout / local dev never fires emails by
//                        surprise. This is the opt-in switch, not just the
//                        schedule.
//   DISABLE_SCHEDULER — set to "true" to force the scheduler off even if
//                        DIGEST_CRON is set (e.g. running multiple instances
//                        behind a load balancer, where only one should send).
//
// WHAT THE JOB DOES: for every rep with a connected Google account (a stored
// refresh token), build their digest and send it to their own address via
// the same buildDailyDigest + sendEmail path the button uses. One rep's
// failure (revoked token, transient Gmail error) is caught and logged; it
// does not stop the rest of the batch.

const cron = require('node-cron');
const { pool } = require('./db');
const { buildDailyDigest } = require('./digest');
const { sendEmail, GoogleNotConnectedError } = require('./google');

// the actual batch job: one digest per connected rep, failures isolated
async function sendDigestToAllConnectedReps() {
  // has_refresh_token is the same "connected" predicate requireRep exposes
  // as google_connected — reps without it are skipped without ever being
  // queried for digest content.
  const { rows: reps } = await pool.query(
    `SELECT id, email, name
       FROM reps
      WHERE google_refresh_token_enc IS NOT NULL`
  );

  console.log(`[digest-scheduler] run starting: ${reps.length} connected rep(s)`);

  let sent = 0;
  let failed = 0;
  for (const rep of reps) {
    try {
      const digest = await buildDailyDigest(rep);
      await sendEmail(rep.id, { to: rep.email, subject: digest.subject, html: digest.html });
      console.log(`[digest-scheduler] sent to ${rep.email} (${digest.counts.overdue} overdue, ${digest.counts.pending_orders} pending)`);
      sent += 1;
    } catch (err) {
      // A token can be revoked between the query above and the send below;
      // that's an expected, quiet skip, not a failure worth alarming about.
      if (err instanceof GoogleNotConnectedError) {
        console.log(`[digest-scheduler] skipped ${rep.email}: Google not connected`);
      } else {
        console.error(`[digest-scheduler] FAILED for ${rep.email}:`, err.message);
        failed += 1;
      }
    }
  }

  console.log(`[digest-scheduler] run complete: ${sent} sent, ${failed} failed, ${reps.length - sent - failed} skipped`);
}

// Reads env at call time (not module load) so tests can set/unset it first.
function startDigestScheduler() {
  if (process.env.DISABLE_SCHEDULER === 'true') {
    console.log('[digest-scheduler] disabled via DISABLE_SCHEDULER');
    return null;
  }

  const expr = process.env.DIGEST_CRON;
  if (!expr) {
    // Unset is the safe default: no job runs. See the file header — this is
    // what keeps local dev from ever firing real emails unattended.
    console.log('[digest-scheduler] DIGEST_CRON not set — scheduler not started (this is the default)');
    return null;
  }

  if (!cron.validate(expr)) {
    // Fail safe, not fatal: a typo'd cron string shouldn't crash the API.
    console.error(`[digest-scheduler] DIGEST_CRON="${expr}" is not a valid cron expression — scheduler not started`);
    return null;
  }

  const task = cron.schedule(expr, () => {
    sendDigestToAllConnectedReps().catch((err) =>
      console.error('[digest-scheduler] unexpected error in scheduled run:', err)
    );
  });
  console.log(`[digest-scheduler] started with schedule "${expr}" (server time; only fires while this process stays running)`);
  return task;
}

module.exports = { startDigestScheduler, sendDigestToAllConnectedReps };
