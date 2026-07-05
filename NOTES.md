# NOTES.md — honest AI-usage log

A running log of (a) real mistakes the AI made during this build and how they
were caught/fixed, and (b) judgment calls made along the way. Entries are
true events from this build only — nothing here is invented. This feeds the
README's "AI tool usage" note.

---

## Phase 1 — Data model

### Mistakes

None caught in this phase. `schema.sql` and `seed.sql` ran cleanly against
PostgreSQL 16 on the first attempt, and all four negative tests (cross-type
detail row, invalid status, invalid activity kind, duplicate detail row)
failed on exactly the constraint they were designed to hit. The overdue
dry-run matched every prediction written in the seed comments. (Recording
the absence honestly rather than inventing a mistake — the spec forbids
fabrication.)

### Judgment calls

1. **Repo root = this directory, not a nested `pharma-contact-manager/`
   folder.** The spec's tree shows that name as the repo root; since this
   workspace *is* the repo, nesting would just add a pointless layer.

2. **"Pharmacy name" lives in `workplaces`, not `pharmacist_details`.** The
   spec lists pharmacy name as a pharmacist field, but a pharmacy is an
   organization like hospitals and distributors — storing its name on the
   person would duplicate it for every colleague at the same store. The
   pharmacist links to a `workplaces` row with `kind = 'pharmacy'` instead.
   Documented in PHASE_1_EXPLAINED.md so it's defensible on camera.

3. **Added the composite-FK type guard beyond the spec's minimum.** A plain
   FK on `contact_id` would satisfy the letter of the spec but lets a
   pharmacist detail row attach to a doctor. The `(id, contact_type)`
   composite FK closes that hole in the database itself. Slightly more
   schema to explain, but it's the strongest talking point for the video's
   data-model section — accepted the tradeoff.

4. **CHECK constraints instead of Postgres ENUM types** for type/status/
   tier/kind: same integrity, cheaper to extend later.

5. **`updated_at` maintained by API code, not a DB trigger.** A trigger is
   the "proper" way but is invisible machinery the human would have to
   explain; setting `updated_at = now()` inside our own UPDATE statements is
   explicit. Cost: discipline in Phase 2's queries.

6. **Fixed hand-written UUIDs in the seed** (`cccccccc-…-01`) instead of
   `gen_random_uuid()`: makes cross-references in seed.sql readable and
   seeded ids stable for repeatable API testing. Production inserts still
   use generated UUIDs.

7. **Seed rows engineered as test cases** for Phase 3 rather than generic
   filler: two never-visited contacts exercise the `created_at` fallback,
   and one contact has two visits so a query that fails to take the *latest*
   visit gets caught by visibly wrong demo data.

8. **Deferred the `pg_trgm` extension to Phase 3** even though it lives in
   schema.sql eventually — keeping each phase's diff scoped to what that
   phase needs.

---

## Phase 2 — REST API

### Mistakes

None caught in this phase either. All five endpoints plus ~15 error paths
were exercised live with curl on the first run and returned the intended
status codes and messages; the test contacts created during verification
were removed by reseeding. (Again recording the absence honestly — see the
Phase 1 note.)

### Judgment calls

1. **`sort=overdue` deferred to Phase 3 despite appearing in the Phase 2
   endpoint list.** The spec mentions it in both phases; the `days_overdue`
   computation it depends on is *defined* in Phase 3a, so building it now
   would mean building half of 3a early. The sort whitelist gains `overdue`
   in Phase 3.

2. **`status_change` is not an accepted kind on POST /activities.** Those
   rows are written only by the PATCH transaction that actually changes the
   status, so the timeline can't be forged. The spec didn't say either way;
   this seemed like the defensible reading.

3. **Re-sending the current status does not log an activity.** "Changed from
   active to active" is timeline noise; only real transitions are recorded.

4. **No validation library (zod/joi).** ~120 lines of plain checks driven by
   one `DETAIL_SPEC` constant are easier to explain on camera than a schema
   DSL. Unknown detail keys are rejected (not ignored) so a typo like
   "speciality" fails loudly — this check caught nothing yet but is cheap
   insurance.

5. **No CORS middleware.** The Phase 4 Vite dev server will proxy `/api/*`,
   so the browser only ever sees one origin. Middleware we don't need.

6. **No `GET /:id/activities` endpoint and no pagination** — the detail
   endpoint already returns the timeline, and a single rep's data volume
   doesn't need paging. Both noted as scope decisions, not oversights.

7. **Added `GET /api/health`** (not in the spec's endpoint list) — a
   one-liner that lets the README's setup steps verify "server up, DB
   reachable" before touching real endpoints.

---

## Phase 3 — Visit planner & duplicate warning

### Mistakes

1. **The duplicate-threshold analysis had a blind spot, caught by live
   testing.** The AI picked the 0.45 similarity threshold by measuring
   candidate names against ONE target ("Dr. Asha Mehta") and concluded that
   a different person would never cross it. But the API compares a new name
   against the WHOLE table, and the live test "Dr. Sanjay Mehta" returned a
   409 the analysis said couldn't happen — it scored 0.52 against
   "Dr. Sanjay **Gupta**" (shared title + first name), a clearly different
   person. Resolution: measured the actual collision, then kept 0.45
   deliberately — raising it above 0.52 would also silence "Asha Meta"
   (0.50), a genuine duplicate variant, and for a warn-only feature a false
   positive costs one click while a false negative defeats the feature. The
   false-positive mode is now documented at the constant's definition and in
   PHASE_3_EXPLAINED.md. Lesson: test predictions against the full dataset,
   not a single example.

2. **A stray server process survived what looked like a clean shutdown.**
   Between test runs, port 3001 was still owned by an unaccounted-for node
   process even though the tracked one had been stopped (and a restart
   attempt had failed by running from the wrong directory). Caught by
   checking `lsof -i :3001` instead of trusting the stop message; fixed by
   killing the PID and restarting from `server/`, then verifying the port
   was actually free after the final shutdown. Lesson: verify ports, not
   process-manager messages.

### Judgment calls

1. **Kept `days_overdue` signed** (−9 = due in 9 days) instead of clamping
   at zero — the client gets "due soon" information for free, and
   `is_overdue` is derived server-side so no client re-implements the rule.

2. **A call does not reset the visit clock.** Two separate LATERAL
   subqueries: last activity of any kind feeds "last contacted"; last
   *visit* feeds the planner. The planner models face-to-face coverage.

3. **Duplicate check spans all contact types** — the same human entered as
   two types is still a duplicate — and runs before the insert transaction
   because it's a pure read.

4. **No trigram index.** `similarity()` in function form scans anyway;
   index support needs the `%` operator + `set_limit()`. A scan over a few
   hundred rows is sub-millisecond; documented as a decision.

5. **Overdue filter/sort ignore status** (a closed contact can appear
   overdue). The filters compose — `?overdue=true&status=active` is the
   real "today list" — so baking a status exclusion into the overdue rule
   would be a hidden opinion. Seed contact Pooja Reddy (closed but overdue)
   exists to demonstrate exactly this.

---

## Phase 4 — React frontend

### Mistakes

1. **Missing favicon, caught by headless-browser verification.** The
   hand-written `index.html` had no favicon, so the browser's automatic
   `/favicon.ico` request 404'd — visible as a console error the moment the
   app was driven in a real browser, invisible in code review. Fixed with
   an inline SVG data-URI icon. Minor, but it's exactly the kind of thing
   that would have looked sloppy in the video demo's devtools.

### Judgment calls

1. **Verified the UI by actually driving it,** not just by building it:
   Playwright + headless Edge clicked through all three screens, the
   filters, both mutation forms, and the duplicate-409 flow, with
   screenshots reviewed at desktop and phone widths and the console
   checked. The DB was reseeded afterwards to remove the test contact and
   test activities.

2. **Hand-rolled ~20-line hash router instead of react-router** — three
   screens don't justify a routing dependency, and every line is
   explainable on camera.

3. **Added read-only `GET /api/workplaces`** (not in the spec's Phase-2
   endpoint list) so the new-contact form can offer a workplace dropdown —
   seeded UUIDs can't be typed by hand. Deliberately no create/edit for
   workplaces (out of prototype scope).

4. **No client-side filtering, sorting, or overdue math** — the client
   re-queries the API on every control change and renders server-computed
   `is_overdue`/`days_overdue`, so each rule exists in exactly one place.

5. **Known cosmetic quirk, accepted:** the browser logs the duplicate-check
   409 as a console error even though the app handles it as the intended
   warning flow — that's how browsers report any non-2xx fetch. Noted here
   so it doesn't get "fixed" into something worse (suppressing it would
   mean pre-checking duplicates with an extra request).

---

## Phase 6 — Orders & products

### Mistakes

1. **The browser-test script tried to select a disabled option.** The
   first UI-verification run timed out because the driver picked "line 2's
   dropdown, option index 2" — which was the product line 1 had already
   selected, and the form (correctly, by design) disables already-picked
   products on other lines. A test-script bug rather than an app bug, but
   worth recording because the failure inadvertently proved the
   duplicate-prevention UX works; the fixed script now asserts that
   disabled state explicitly instead of stumbling over it.

2. **A `grep -c … && …` shell chain silently skipped the test run once.**
   `grep -c` exits non-zero when it counts zero matches, so "no errors
   found" short-circuited the `&&` chain that should have launched the UI
   tests. Caught immediately (exit 1 with no output) and re-run with `;`
   instead. Logged as a reminder that "no matches" and "failure" are the
   same exit code to grep.

### Judgment calls

1. **Stored `total_amount` despite Phase 3's derive-don't-store rule** —
   documented at length in PHASE_6_EXPLAINED.md: derive from living data,
   snapshot completed transactions. Line items are immutable (no edit-order
   endpoint), so there is nothing for the stored total to drift from.

2. **All money math in Postgres NUMERIC; JS only formats.** The client's
   live order total is an explicit preview (floats, display-only); the
   server recomputes exactly. Prices are never accepted from the client —
   a request containing one is rejected with a named 400.

3. **Order status is one-way** (`pending → delivered|cancelled`, terminal
   thereafter), which let the schema enforce
   `(status='delivered') = (delivered_at IS NOT NULL)` as a CHECK.

4. **New activity kind `'order'`, writable only by order endpoints** —
   same timeline-can't-lie rule as `status_change`.

5. **Seeded orders are threaded into the existing contact stories** (e.g.
   the ₹37,000 order IS the "reordered 200 strips" visit already in the
   seed), with hand-computed totals verified against item sums by query.

6. **Products endpoint returns only active products**; the discontinued
   seed product exists specifically to test rejection paths.

---

## Phase 7 — Google OAuth + multi-rep scoping

### Mistakes

1. **`DELETE FROM reps CASCADE` — SQL that doesn't exist.** The first
   seed edit wrote `DELETE FROM reps CASCADE` (CASCADE belongs to
   TRUNCATE/DROP, not DELETE) and placed the statement before the contacts
   deletion, which the FK would have rejected anyway. Caught on re-read
   seconds later, before the seed was ever run; fixed by moving a plain
   `DELETE FROM reps` to the end of the wipe order. Logged because it's a
   real "the AI wrote invalid SQL" moment even though it never executed.

2. **Ran `npm run db:reset` from the wrong directory.** The reset "failed"
   with *Missing script: db:reset* because the shell was sitting in
   `server/` (the root package.json has the script). Momentarily looked
   like a broken seed; it was a broken working directory. Same lesson as
   Phase 6's grep incident: read the error before suspecting the code.

### Judgment calls

1. **No password system at all** — Google OAuth is the account system, per
   the spec's architecture decision. No hashes, no reset flow, no second
   login path to secure.

2. **Session = stateless signed JWT (12h) in an httpOnly SameSite=Lax
   cookie**, rejected localStorage (XSS-readable) and a server-side session
   store (state + cleanup for no prototype benefit).

3. **Tenant scoping via explicit WHERE clauses + a cross-tenant test
   battery**, rejected Postgres RLS (stronger in principle, but per-request
   session variables through a connection pool are easy to misconfigure and
   hard to explain on camera). Every route was probed as a second rep:
   list/GET/PATCH/activities/orders all 404 or 400 cross-tenant, and the
   duplicate-name check was scoped so its 409 can't leak names across reps.

4. **404 (not 403) for other reps' resources** — "not yours" must be
   indistinguishable from "doesn't exist" or ids become enumerable.

5. **Refresh tokens AES-256-GCM-encrypted with a key derived from
   SESSION_SECRET** — one secret to manage; rotating it logs everyone out
   and forces Google re-consent (documented tradeoff). Access tokens stay
   plaintext (1-hour lifetime, low value).

6. **`prompt: 'consent'` on every login** so a refresh token always
   arrives (Google omits it on repeat consents otherwise) — right for a
   prototype whose DB gets reset; a production app would drop it after
   first grant.

7. **The live Google token exchange is untested in this environment** —
   deliberately, since testing it would require real credentials in the
   repo, which the security rules forbid. Everything up to Google's door is
   tested (redirect shape, state CSRF check, forged sessions, isolation,
   encryption); the human's first login with their own .env exercises the
   rest. Stated in PHASE_7_EXPLAINED.md rather than glossed over.

8. **Demo rep owns the seed; `npm run db:adopt` reassigns it** to the
   first real Google account so the post-login demo isn't an empty screen.

---

## Phase 7 addendum — per-rep onboarding seed data

### Mistakes

1. **Variable name collision that broke server boot: two `const client`
   in one function.** The OAuth callback already declared
   `const client = oauthClient()` (the Google client). My new transaction
   block added `const client = await pool.connect()` in the same scope, so
   Node refused to even start: *Identifier 'client' has already been
   declared*. Caught immediately because the live-API verification step
   booted the server and it crashed on load (a pure unit test of
   seedStarterDataForRep would have sailed past this — the bug was in the
   caller). Fixed by renaming the DB connection to `db`. Good reminder that
   "run the actual thing" catches what isolated tests don't.

### Judgment calls

1. **New-vs-returning detected via `(xmax = 0)` in the upsert's RETURNING**,
   rejecting a separate SELECT-then-branch (racy) and DO NOTHING + second
   UPDATE (loses the single-statement token refresh). Verified the trick in
   psql before relying on it: first upsert → true, second → false.

2. **Rep creation + seeding wrapped in ONE transaction** so a new rep gets
   account + data atomically or neither. `seedStarterDataForRep(client,
   repId)` takes the caller's client and does no BEGIN/COMMIT itself, so it
   composes into that transaction.

3. **Fresh UUIDs per call, not the hardcoded seed.sql ids** — reusing the
   fixed `cccccccc-…` ids would make the second onboarding rep collide on
   PKs. Symbolic keys in the dataset resolve to fresh UUIDs at seed time.
   Verified zero shared contact/order ids between two seeded reps.

4. **contacts/activities/orders = per-rep; workplaces/products = global
   get-or-create.** Products dedupe by unique SKU (ON CONFLICT DO NOTHING);
   workplaces (no unique key) by a (name,kind,city) select-or-insert. So
   onboarding many reps doesn't duplicate the shared catalog/dropdown, and
   the function still bootstraps the catalog on a schema-only DB. Chose this
   over per-rep workplace copies specifically to avoid a workplace dropdown
   that grows with every rep.

5. **db/seed.sql left untouched** — the demo rep keeps its own hardcoded-id
   path; onboarding is a separate function for Google logins only, so the
   existing setup flow is unaffected.

6. **Live Google login still can't be exercised here** (no real creds, per
   the security rules), so onboarding was verified by driving the exact
   callback logic — real upsert SQL + xmax detection + seedStarterDataForRep
   in a transaction — against the DB, plus an API read of a seeded rep. The
   remaining untested surface is the same ~30 Google lines noted in the main
   Phase 7 entry, not the seeding itself.

---

## Phase 8 — Google Calendar sync

### Mistakes

No code mistakes this phase. One process note worth recording so it doesn't
read as a real bug:

1. **A test-harness quoting error briefly looked like a broken endpoint.**
   The first server test run built the auth header as an unquoted shell var
   (`AUTH="-H Cookie:session=$JWT"`) and passed it as `curl $AUTH …`. Word-
   splitting mangled the cookie, so authenticated requests came back empty
   or 400 while anonymous ones correctly 401'd — which momentarily looked
   like the new agenda/calendar routes were failing. Re-running with a
   properly quoted `-H "Cookie: session=$JWT"` showed everything working
   (agenda correct, calendar 409 graceful). The bug was in the test shell,
   not the app — logged so the "it was 400!" moment isn't mistaken for a
   real defect later.

### Judgment calls

1. **Local-first agenda; Google is an enhancement layered on top.** The
   agenda reads only the DB so it works with Google disconnected; only the
   per-row "Add to Calendar" touches Google, and that degrades to a
   reconnect link. Rejected making the agenda read from Google (a core
   screen shouldn't depend on an external service).

2. **Extracted the tier-interval SQL into visitPlanner.js** shared by the
   contacts list and the agenda, rather than duplicating the A/B/C intervals
   — the exact drift risk Phase 3 argued against. Verified the contacts
   overdue numbers are unchanged after the refactor.

3. **Event id stored on the CONTACT, not the activity** — the calendar event
   is about the contact's upcoming (computed) due visit, a property of the
   contact, not of any past activity row. Makes "Add to Calendar" idempotent.

4. **Refresh-token failure re-thrown as GoogleNotConnectedError**, so a
   revoked grant and a never-connected account share one graceful "reconnect"
   path (409 + code) instead of a 500.

5. **All-day events** (visit reminders are a day, not a time slot); handled
   Google's exclusive `end.date` by ending on the next day.

6. **Agenda excludes closed contacts** (you don't plan visits to lost
   accounts) but keeps dormant (overdue dormant = re-engagement cue). An
   agenda-specific product filter; the raw overdue math stays status-
   independent elsewhere.

7. **The live calendar.events.insert call remains untested here** (no real
   Google creds, same boundary as Phase 7's token exchange). Everything
   around it is tested: event-payload unit test, idempotent short-circuit,
   not-connected 409, agenda, and the UI reconnect flow.

---

## Phase 9 — Gmail daily digest

### Mistakes

No code mistakes this phase. One near-miss caught in design, worth recording:

1. **Almost put the ₹ symbol (and an em dash) in the email SUBJECT.** The
   first draft subject read like the UI ("… — ₹X pending"). That would have
   produced a malformed raw email header — non-ASCII in a header needs
   RFC-2047 encoding, which `buildRawMessage` doesn't do. Caught while
   writing `buildRawMessage` (thinking through the header/body charset
   split), before any test ran: kept the subject pure ASCII (verified max
   char code 121) and confined ₹ to the UTF-8 body. Logged because it's a
   real correctness trap the code now guards against by convention.

### Judgment calls

1. **Reps email only themselves** — recipient is always `req.rep.email` from
   the session, never from the request body. The spec's abuse guard for
   holding `gmail.send`. Verified a body `to` is ignored.

2. **Build and send split** — `buildDailyDigest` only queries + renders (no
   Gmail), so `GET /api/digest/preview` is fully demoable without Google and
   `POST /send` reuses the same builder. The Google-dependent half is
   isolated to the actual send.

3. **Overdue grouped by city** (route planning) using the shared
   visitPlanner.js SQL — no re-derivation of the tier rule.

4. **Inline-styled HTML, ASCII subject, no template engine** — email clients
   strip `<style>`; a couple of string builders beat an MJML/templating dep.

5. **Preview via sandboxed `<iframe srcDoc>`** rather than
   `dangerouslySetInnerHTML` — isolates the email's CSS from the app (honest
   preview) and can't run scripts/navigate.

6. **Button-triggered, not scheduled** — per spec. `buildDailyDigest(rep)`
   is a pure-ish function of a rep, so a real deployment wires it to a cron/
   queue; noted as the only missing piece for production.

7. **The live gmail.send round trip is untested here** — same no-real-creds
   boundary as Phases 7–8. Message encoding (unit), digest content (API),
   the 409, the abuse guard, and the preview UI are all tested; only the ~5
   lines handing `raw` to googleapis are exercised by a real login.

---

## Digest follow-up — greeting fix, hide/show toggle, 7am scheduler

### Mistakes

None this round. The one thing worth recording isn't a mistake but a
finding: investigating the reported "Hi Lost" bug showed the greeting code
was already correct (`rep.name` straight from the `reps` table) — "Lost" is
the literal, real display name Google returned for a genuine "Sign in with
Google" the human performed with real credentials during testing (a real
`google_sub`, a real encrypted refresh token in the DB, created 2026-07-05
13:48). Not a code defect; recorded here so it isn't rediscovered and
"fixed" again later by someone assuming the greeting logic is broken. The
requested defensive fallback (blank/missing name → email local-part →
"there") was added regardless, since it's correct behavior the code
genuinely lacked.

### Judgment calls

1. **Did not run `npm run db:reset` at the end of this task.** A real rep
   row now exists in the dev database (the login above) with a real
   encrypted refresh token that required actual OAuth consent to obtain —
   reseeding would delete it, and re-creating it isn't a `psql` command,
   it's a real login. This round of work only ran read/GET operations
   against the database, so there was nothing to clean up; skipping the
   reseed was the safer call. Flagged explicitly to the human rather than
   silently deviating from the usual per-phase "reseed to pristine" habit.

2. **Scheduler is opt-in via `DIGEST_CRON` being unset by default**, not
   "on with a 7am default unless disabled." A baked-in always-on default
   would risk a real email firing the first time a dev happens to leave
   `npm run dev:server` running through 7am. `DISABLE_SCHEDULER=true` is a
   secondary override for when `DIGEST_CRON` IS set but a given instance
   shouldn't send (e.g. multiple server instances).

3. **The scheduled job reuses buildDailyDigest + sendEmail verbatim** — no
   parallel "batch" digest logic — so the scheduled path and the button
   path can never disagree about what a digest contains.

4. **One rep's failure doesn't stop the batch**, verified with a stubbed
   run (success / simulated revoked-token / simulated Gmail error → exactly
   1 sent, 1 failed, 1 skipped, all three attempted).

5. **DigestPanel's hide/show is a pure visibility toggle once data is
   cached** — no explicit "refresh" action was added (kept minimal per the
   ask); a rep wanting truly fresh counts reloads the Agenda page.
