# Pharma Contact Manager — Phase 6+ Build Spec (Orders, Google OAuth, Multi-Rep)

> **Read this whole file before writing code.** This extends an already-complete,
> tested app (Phases 1–4: contacts, activities, tier/overdue planner, dedup,
> React UI). A clean git commit exists as the baseline. Build ADDITIVELY on top;
> do not rewrite working code. Same working style as before: one phase at a time,
> heavy comments, a `docs/PHASE_<N>_EXPLAINED.md` after each, honest `NOTES.md`
> entries for real mistakes only, and STOP after each phase printing
> `✅ Phase <N> complete...` then wait.

---

## 🔒 SECURITY RULES — NON-NEGOTIABLE, APPLY TO EVERY PHASE

The human is submitting this as a **public GitHub repo** and has explicitly said
no credentials may leak. OAuth makes this critical.

1. **All secrets live in `server/.env` ONLY.** Never hardcode a client secret,
   client ID, token, or API key in any committed file. This includes Google
   OAuth client secret, JWT signing secret, and DB URL.
2. **Verify `.env` is gitignored.** Before finishing each phase, confirm
   `server/.env` is NOT tracked (`git ls-files | grep .env` must show only
   `.env.example`, never `.env`).
3. **`.env.example`** holds every needed key with PLACEHOLDER values and a comment
   explaining where to get it. Real values never appear in it.
4. **OAuth tokens** (per-rep access/refresh tokens for Google) are stored in the
   database, and refresh tokens are stored **encrypted** or at minimum never
   logged/returned in API responses.
5. **Never print tokens or secrets to console** in committed code.
6. The README's Google-setup section explains how a reviewer creates their OWN
   Google Cloud OAuth credentials — the human's credentials are never shared.

If any step would require committing a secret, STOP and flag it instead.

---

## Architecture decision: Google login IS the multi-rep login

Reps sign in with **"Sign in with Google" (OAuth 2.0)**. That single consent
flow provides BOTH:
- the rep's identity (email, name) → their account in the `reps` table, and
- the access/refresh tokens for Calendar + Gmail scopes.

So we do NOT build a separate password system. OAuth login = multi-rep auth =
Google connection, unified. Every rep-owned row is scoped by `rep_id`.

**Scopes requested:** `openid email profile`,
`https://www.googleapis.com/auth/calendar.events` (create visit events),
`https://www.googleapis.com/auth/gmail.send` (send the daily digest).
Request them at login so one consent covers everything.

---

## PHASE 6 — Orders & Products (build first, no external deps)

Purely internal — get this solid before touching Google.

- `products` table: id (uuid), name, sku (unique), form (e.g. '500mg tablet'),
  unit_price NUMERIC(12,2) CHECK >= 0, active bool. Seed ~10 realistic pharma
  products.
- `orders` table: id, contact_id FK, order_date, status CHECK
  ('pending','delivered','cancelled') default 'pending', delivered_at nullable,
  total_amount NUMERIC(12,2). (rep_id column added in Phase 8.)
- `order_items` table: id, order_id FK ON DELETE CASCADE, product_id FK,
  quantity INT CHECK > 0, unit_price_at_order NUMERIC(12,2) (snapshot — same
  reasoning as any priced line item).
- Endpoints (parameterized queries, transactions where multi-table):
  - `GET /api/products`
  - `POST /api/orders` — body: contact_id + line items; insert order + items in
    ONE transaction; compute total; ALSO insert an `activities` row on the
    contact ("Order placed: N items, ₹X") so orders show in the timeline.
  - `GET /api/orders` — filter by `?status=` and `?contact_id=`; return contact
    name + item count + total.
  - `GET /api/orders/:id` — full order with line items.
  - `PATCH /api/orders/:id` — status change (→ delivered sets delivered_at; log
    an activity).
- UI: a New-Order form on the contact detail page (pick products + quantities,
  live total); an Orders section (list + status filter + mark-delivered button);
  show each contact's total order value on their detail page.
- Reseed clean. **git commit** at end: "Phase 6: orders & products".

## PHASE 7 — Google OAuth login + multi-rep scoping

This is the big structural phase.

- `reps` table: id, google_sub (unique), email, name, created_at,
  google_refresh_token (encrypted/never exposed), google_access_token,
  token_expiry.
- OAuth flow (use `googleapis` npm lib): `/auth/google` redirects to Google;
  `/auth/google/callback` exchanges the code, upserts the rep by google_sub,
  stores tokens, issues the app's OWN short-lived session (a signed JWT cookie
  or token) identifying the rep. Reuse the JWT/session pattern from the human's
  prior project conceptually.
- **Add `rep_id` to `contacts`, `orders`, `activities`** (and backfill seed data
  to a demo rep). Every existing query gains `WHERE rep_id = $currentRep`. This
  is multi-tenant scoping — a rep sees ONLY their own contacts/orders. Apply it
  everywhere; a missed scope = data leak across reps.
- Middleware: `requireRep` verifies the session and attaches `req.rep`. All
  `/api/*` data routes go behind it. The rep_id always comes from the session,
  never from the request body.
- Token refresh helper: when a Google access token is expired, use the refresh
  token to get a new one before calling Google APIs.
- UI: a login screen ("Sign in with Google"); show logged-in rep's name; logout.
- **git commit**: "Phase 7: Google OAuth login + per-rep scoping".

## PHASE 8 — Google Calendar sync

- When a rep logs a **visit** or the app schedules a next visit, offer "Add to
  Google Calendar": create a Calendar event (title "Visit: Dr. X", the contact's
  workplace as location, the due date) via the Calendar API using the rep's
  stored token.
- Store the returned Google event id on the activity/contact so it isn't
  duplicated.
- Also: an in-app calendar/agenda view showing this week's due visits and
  pending order deliveries (reads local data — works even if Google is not
  connected). Google sync is the enhancement on top.
- Handle the "token expired / not connected" case gracefully (prompt reconnect).
- **git commit**: "Phase 8: Google Calendar sync".

## PHASE 9 — Gmail daily digest

- A `buildDailyDigest(rep)` function: queries that rep's overdue contacts
  (grouped by city) + pending orders, returns a clean HTML email body.
- `POST /api/digest/send` — sends that digest to the logged-in rep's own email
  via the Gmail API (`gmail.send`) using their OAuth token. (Rep emails only
  themselves — no arbitrary recipients, avoids abuse.)
- A "Send me today's tasks" button in the UI + the generated preview shown
  in-app so the feature is demoable without opening an inbox.
- Do NOT send on a schedule/cron for the prototype (note real deployment would
  use a scheduled job). Keep it button-triggered.
- **git commit**: "Phase 9: Gmail daily digest".

## PHASE 10 — README + video prep (LAST)

- README: video link placeholder; full setup INCLUDING how the reviewer makes
  their own Google Cloud OAuth app (enable Calendar + Gmail APIs, create OAuth
  client, set redirect URI, put values in `.env`); run steps; stack rationale;
  scope notes; honest AI-usage note from NOTES.md.
- `docs/VIDEO_PREP.md`: 2–5 min script — demo flow; data-model rationale + the
  multiple-companies answer; the debated tradeoff; and specifically how OAuth
  login doubles as multi-rep auth and carries Calendar/Gmail scopes (this
  directly answers what the founder asked about).
- Final secret-safety sweep: confirm no `.env`, token, or secret is tracked by
  git.

## docs/PHASE_<N>_EXPLAINED.md — each must contain
1. What we built (plain English). 2. Design decisions incl. rejected
alternatives. 3. Walkthrough of tricky parts (esp. the OAuth flow — explain
authorization-code exchange, access vs refresh token, scopes, in beginner
terms). 4. Likely reviewer/video questions + model answers.

## Rules recap
- Phases sequential; build, document, git commit, STOP, wait.
- Secrets only in `.env`; verify not committed every phase.
- Additive — don't break Phases 1–4.
- Begin with **Phase 6 only.**
