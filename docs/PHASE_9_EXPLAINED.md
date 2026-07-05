# Phase 9 Explained — Gmail Daily Digest

## 1. What we built

A "daily tasks" email a rep can send to themselves: `buildDailyDigest(rep)`
queries their overdue contacts (grouped by city, so they can plan a route)
and pending order deliveries, and returns a clean inline-styled HTML body.
`POST /api/digest/send` emails it via the Gmail API using the rep's OAuth
token — **to the rep's own address only**, never a recipient from the
request. A "Send me today's tasks" button plus an in-app **preview** (the
real email rendered in a sandboxed iframe) make the feature demoable without
opening an inbox. It is button-triggered, not scheduled — a real deployment
would fire `buildDailyDigest` from a cron job, but that's out of scope for
the prototype.

New pieces: [digest.js](../server/src/digest.js) (the builder),
`buildRawMessage` + `sendEmail` in [google.js](../server/src/google.js),
[digest.routes.js](../server/src/routes/digest.routes.js), and the client
[DigestPanel](../client/src/components/DigestPanel.jsx) on the Agenda page.

## 2. Design decisions — chosen vs. rejected

**Reps email only themselves.** The recipient is *always* `req.rep.email`
from the verified session; the send endpoint never reads a `to` from the
request body. This is the spec's abuse guard — with `gmail.send` scope the
app could otherwise be turned into a spam relay. Verified: posting
`{"to":"attacker@evil.com"}` is simply ignored (the send still targets the
rep, and returns the same not-connected 409 for the demo rep). Rejected:
accepting a recipient with a domain allowlist — more surface, no prototype
need.

**Build and send are separate.** `buildDailyDigest` only *builds* — it
touches the DB, not Gmail. So `GET /api/digest/preview` can render the exact
email in-app with zero Google dependency, and `POST /api/digest/send` reuses
the same builder before handing off to Gmail. The demoable half (preview)
and the Google-dependent half (send) are cleanly split.

**Grouped by city.** A rep works a city at a time, so overdue contacts are
grouped under city headings (Delhi, Hyderabad, Mumbai, Pune…), most-overdue
first within each. Same "overdue, exclude closed" rule as the agenda, from
the same shared `visitPlanner.js` SQL — no re-derivation of the tier rule.

**Inline-styled HTML, ASCII subject.** Email clients strip `<style>` blocks
and don't cascade external CSS, so every style is inline. The **subject is
kept ASCII** on purpose — it becomes a raw RFC-2822 header, and non-ASCII
there needs RFC-2047 encoding; the ₹ symbol and any em dashes live only in
the UTF-8 **body**. Rejected: a templating/MJML dependency — a couple of
string-building functions are easier to read and carry no build step.

**Preview in a sandboxed iframe.** The email HTML is rendered via
`<iframe sandbox srcDoc={html}>`. The iframe isolates the email's inline CSS
from the app (and vice versa) so it looks like the real thing, and `sandbox`
with no allow-tokens means the previewed markup can't run scripts or
navigate. Rejected: `dangerouslySetInnerHTML` into the page — it'd inherit
app styles (misleading preview) and inject foreign markup into the app DOM.

## 3. Walkthrough of the tricky parts

### 3.1 The Gmail message format

Gmail's `messages.send` doesn't take fields — it takes one `raw` string: the
entire email as a base64url-encoded RFC-2822 message. `buildRawMessage`
(pure, unit-tested) assembles it:

```
To: demo.rep@example.com
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8
Subject: Your pharma tasks for today: 7 overdue visits, 3 pending orders
<blank line>
<html body…>
```

Three details that matter:
- **CRLF (`\r\n`) line endings** and the **blank line** between headers and
  body are RFC-2822 requirements — LF-only or a missing blank line yields a
  malformed message.
- **base64*url*** (not plain base64): Gmail wants the URL-safe alphabet
  (`-_` instead of `+/`, no padding). `Buffer.from(msg,'utf8').toString('base64url')`.
- **UTF-8 body**: encoding the whole message as UTF-8 bytes preserves the ₹
  in the body, declared by the `charset=utf-8`. The unit test decodes the
  base64url back and asserts `₹9,986.00` survived intact.

### 3.2 Not-connected handling reuses Phase 8's path

`sendEmail` → `getGoogleClientForRep`, which throws `GoogleNotConnectedError`
when the rep has no/revoked Google token. The endpoint maps it to the *same*
`409 { code: 'google_not_connected' }` the calendar endpoint uses, so the
client's one handler covers both features: show "Connect Google". The rep can
still preview the digest — only the send needs Google.

### 3.3 What was verified

- **Unit:** `buildRawMessage` — base64url (no `+/=`), CRLF header/body
  separator, `text/html; charset=utf-8`, the ₹ body survives the round trip,
  `To:` is the passed address. Subject confirmed pure ASCII (max char code
  121).
- **API:** preview returns the right counts (7 overdue, 4 cities, 3 pending),
  HTML contains all four city names, excludes the closed contact, carries a ₹
  total and inline styles; send as the demo rep → 409 `google_not_connected`;
  a body `to` is ignored (still self); anonymous → 401 on both routes.
- **UI (headless browser):** the Agenda shows the digest panel; Preview
  renders the actual email inside the iframe ("Today's tasks", "Overdue
  visits (7)", 4 city subheadings, correct subject); Send degrades to a
  "Connect Google" link. Only console line is the expected handled 409.

## 4. Honest limitation — the live Gmail send is untested here

Like Phase 7's token exchange and Phase 8's calendar insert, the actual
`gmail.users.messages.send` round trip needs a real connected Google account,
which per the security rules never lives in this repo. Everything around it is
tested: the message encoding (unit), the digest content (API), the not-
connected 409, the abuse guard, and the full preview UI. The untested surface
is the ~5 lines that hand a `raw` string to googleapis and read back the
message id. The first real login + click exercises it; the README (Phase 10)
covers enabling the Gmail API on the reviewer's own credentials.

**Not scheduled, on purpose.** The spec asks for button-triggered send only.
A production deployment would call `buildDailyDigest` + `sendEmail` for each
rep from a scheduled job (cron / a task queue) each morning; the builder is
already a pure function of a rep, so wiring it to a scheduler is the only
missing piece. Kept manual so the prototype has no background machinery to
explain or secure.

## 5. Likely reviewer / video questions — with tight answers

**Q: Can a rep email the digest to a customer, or to anyone?**
No. The recipient is taken from the session (`req.rep.email`) and the send
endpoint never reads a recipient from the request. A rep can email only
themselves — which is why holding `gmail.send` scope here isn't a spam risk.

**Q: How is the email demoable without an inbox?**
`GET /api/digest/preview` builds the exact HTML without sending (no Google
needed), and the UI renders it in a sandboxed iframe. You see precisely what
would land in the inbox, live, in the app.

**Q: Why is the subject ASCII but the body has ₹?**
The subject is a raw email header; non-ASCII there needs RFC-2047 encoding.
The body is UTF-8 (declared by Content-Type) and the whole message is encoded
as UTF-8 bytes, so ₹ is fine in the body. Keeping the subject ASCII avoids the
header-encoding dance entirely.

**Q: Why isn't this on a schedule?**
Deliberate prototype scope — button-triggered only, so there's no cron/queue
to run or secure. `buildDailyDigest(rep)` is already a pure function, so a
real deployment just calls it from a morning scheduled job per rep.

**Q: What does the rep see if Google isn't connected?**
The send returns 409 and the button becomes a "Connect Google" link — the
same graceful path as the calendar feature. Preview still works, so the
feature isn't a dead end while disconnected.

**Q: Why group overdue contacts by city?**
Reps plan by geography — a morning in one part of town. Grouping the overdue
list by city turns the email into a route plan rather than a flat list.

## 6. Addendum — greeting fallback, hide/show toggle, and the 7am scheduler

**Greeting bug report, investigated.** The reported symptom was the digest
greeting reading "Hi Lost". Tracing it: `renderHtml` already used
`rep.name` straight from the `reps` table (`requireRep.js`'s
`SELECT id, email, name, …`) — there was no code path substituting a wrong
field. The actual explanation: a real "Sign in with Google" was performed
against this app with real credentials during testing, creating a genuine
`reps` row (a real `google_sub`, a real encrypted refresh token) whose
Google account's profile name really is "Lost". `esc(rep.name)` faithfully
rendered exactly what Google returned — not a bug in the greeting logic, a
surprising but real upstream value. **What was still worth fixing:** the
greeting had no defined behavior for a *blank or missing* name (it would
have rendered `Hi ,`). Added `greetingName(rep)` — non-blank `rep.name` →
that; else the email's local part (`user` from `user@domain.com`); else the
neutral `"there"` as a last-resort floor (unreachable in practice, since
`reps.email` is `NOT NULL` in the schema). Verified: the real "Lost" row
still renders "Hi Lost" (correct — a present, non-blank name is used
as-is), while a simulated blank/null name falls back to the email's local
part.

**Hide/show preview toggle.** `DigestPanel` now tracks the fetched preview
data (`preview`) separately from its visibility (`previewOpen`). One button
drives both: first click fetches and shows ("Preview" → "Hide preview");
once data is cached, clicking only toggles visibility ("Hide preview" ↔
"Show preview") without re-fetching — verified in the browser that
re-showing issues zero requests to `/api/digest/preview`. Re-fetching only
happens by hiding then... no — by design there's now no explicit "refresh";
if a rep wants genuinely fresh counts (e.g. after editing contacts in
another tab), reloading the Agenda page re-mounts the panel. Kept minimal,
per the ask.

**The 7am scheduler.** [scheduler.js](../server/src/scheduler.js) adds
`startDigestScheduler()`, wired in `index.js` right after `app.listen`. It
reuses the exact same `buildDailyDigest` + `sendEmail` path the button
uses — no parallel digest logic — for every rep with a stored (encrypted)
refresh token, i.e. `google_refresh_token_enc IS NOT NULL`. One rep's
failure (a revoked token discovered only at send time, a transient Gmail
error) is caught per-rep and logged; the loop continues to the rest —
verified with a stubbed run (one success, one simulated revoked-token skip,
one simulated Gmail failure) producing exactly `1 sent, 1 failed, 1
skipped` and attempting all three.

**Configuration is opt-in, not opt-out — deliberately.** `DIGEST_CRON` is
**unset by default**; with it unset, `startDigestScheduler()` logs "not
started" and returns `null` — no timer is ever created. Setting
`DIGEST_CRON="0 7 * * *"` (or any valid 5-field cron expression) is what
turns it on; an invalid expression is rejected with a logged error rather
than crashing the server (`cron.validate` checked first). `DISABLE_SCHEDULER=
true` force-disables even when `DIGEST_CRON` is set — for example, running
several instances of this server where only one should send. This ordering
(disabled unless explicitly configured) is what keeps a fresh checkout or a
laptop dev session from ever firing a real email by surprise — the opposite
of "on by default, opt out." Verified all four states directly: unset →
`null`/no-op; `DISABLE_SCHEDULER=true` → `null` even with a valid cron set;
invalid cron string → `null` with a logged error; valid cron → a real
`node-cron` task returned.

**The honest limitation this feature has, stated plainly:** `node-cron`'s
`schedule()` is an in-process JavaScript timer, not a system cron job. It
only fires while *this exact Node process* is running at the scheduled
moment — it does not persist across restarts, does not queue up missed
runs, and does nothing on a laptop dev machine that isn't left running
continuously through 7am. It behaves like a real "every day at 7am" job
only on an always-on host (a VM, a container kept alive by systemd/pm2/a
platform's process supervisor). This is documented at the top of
scheduler.js, in `.env.example`, and here — on purpose, so it isn't mistaken
for guaranteed delivery in a demo or a take-home review. The in-app "Send me
today's tasks" button remains the reliable trigger regardless of uptime.

**Why the real "Lost" rep's data wasn't reseeded during this work.** Earlier
phases routinely ended with `npm run db:reset` to return to a pristine demo
state. This time, a *real* rep row exists from a live Google login the human
performed with real credentials (a genuine `google_sub` and an encrypted
refresh token that took a real OAuth consent to obtain). `db/seed.sql`
unconditionally wipes the entire `reps` table — running it would have
destroyed that real login. Since this round of work only ran read-only
queries and read-only API calls against the database, there was nothing to
clean up, so the reseed was skipped and the real rep was left untouched.
