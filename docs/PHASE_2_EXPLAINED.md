# Phase 2 Explained — The REST API

## 1. What we built

A small Express API over the Phase-1 schema, using raw `pg` with
parameterized queries — no ORM. Five endpoints: create a contact (base +
type-detail row in one transaction), list contacts with filters/search/sort,
fetch one contact with its full activity timeline, patch a contact (where a
real status change also writes a `status_change` activity in the same
transaction), and log a note/visit/call. Bad input returns a 400 naming the
offending field; missing ids return 404. Everything was exercised live with
curl — happy paths and ~15 error paths — against the seeded database.

Run it:

```bash
npm run setup        # once: createdb + schema + seed + npm install (server)
npm run dev:server   # API on http://localhost:3001
curl localhost:3001/api/health   # → {"ok":true}
```

Files: [src/index.js](../server/src/index.js) (bootstrap),
[src/db.js](../server/src/db.js) (pool),
[src/routes/contacts.routes.js](../server/src/routes/contacts.routes.js),
[src/routes/activities.routes.js](../server/src/routes/activities.routes.js).

## 2. Design decisions — chosen vs. rejected

**Raw SQL with `$1` placeholders, no ORM** *(fixed by the stack choice, but
worth defending)*: every query is visible and explainable on camera, and
parameterization makes SQL injection structurally impossible — values travel
to Postgres separately from the SQL text, so user input is never *code*. The
one thing `$n` can't parameterize is identifiers (column names, ORDER BY);
everywhere the SQL string is assembled dynamically, the parts interpolated
into it come from server-side whitelists (`DETAIL_SPEC`, the `SORTS` map),
never from the request.

**Validation in code, constraints in the DB — both, on purpose.** The API
validates before any SQL runs so users get `"details.specialty is required
for type hcp"` instead of a raw constraint error; the schema's CHECKs/FKs
remain the safety net against any path that bypasses the API. The
`DETAIL_SPEC` constant drives validation *and* the dynamic INSERT/UPDATE
column lists, so a new detail field is added in exactly one place. We
rejected a validation library (zod/joi): ~120 lines of plain checks are
easier to defend line-by-line than a schema DSL, at this size.

**Transactions exactly where two writes must not diverge.**
- `POST /api/contacts`: base row + detail row. The schema can't force a
  detail row to *exist* (noted in Phase 1) — this transaction is the other
  half of that contract.
- `PATCH /api/contacts/:id`: the update + its `status_change` activity
  commit or roll back together, so the timeline can never claim a change
  that didn't happen (and vice versa). The row is read `FOR UPDATE` first so
  "did the status actually change?" can't race a concurrent PATCH.
- `POST .../activities` deliberately has **no** transaction — one INSERT is
  atomic by itself; wrapping it would be cargo-culting.

**One shared SELECT for list and detail** (`CONTACT_SELECT`): both endpoints
return the same shape because they run the same joins — three LEFT JOINs to
the detail tables (exactly one matches per contact) plus a LATERAL subquery
for `last_activity_at`. Rejected: assembling `details` as JSON in SQL
(`json_build_object`) — shaping rows in ~15 lines of JS is easier to read
and debug than nested SQL functions.

**Smaller calls:**

| Decision | Why |
|---|---|
| `sort=overdue` deferred to Phase 3 | The spec lists it under both phases; the `days_overdue` computation is *defined* in Phase 3a, so it ships there. Whitelisted sorts today: `name`, `last_contacted`. |
| `status_change` rejected by the activities endpoint | Those rows are written only by PATCH, so the timeline is trustworthy — a client can't fabricate lifecycle history. |
| `contact_type` immutable | Changing type would orphan the detail row. A wrong-type contact is deleted and recreated (rare enough not to build for). |
| No `GET .../activities` endpoint | The UI only ever shows the timeline on the detail screen, which `GET /api/contacts/:id` already serves. |
| No CORS middleware | Vite's dev server proxies `/api/*` to this port, so the browser sees one origin. Not adding middleware we don't need. |
| Re-sending the current status logs nothing | An activity saying "changed from active to active" is noise; only real transitions hit the timeline. |
| DB defaults do the defaulting | POST omits absent columns from the INSERT so `status='lead'`, `tier='C'`, `is_owner=false` come from the schema — defaults live in one place. |

## 3. Walkthrough of the tricky parts

### 3.1 Building WHERE clauses without touching the SQL string with input

```js
if (type !== undefined) {
  if (!CONTACT_TYPES.includes(type)) return badRequest(...);
  params.push(type);
  where.push(`c.contact_type = $${params.length}`);
}
```

The pattern: push the *value* onto `params`, then append a clause that
references its position. The SQL string only ever gains server-written text
like `c.contact_type = $1`; the value rides the parameter channel. `ORDER BY`
can't use `$n` (Postgres parameterizes values, not syntax), so the sort key
is looked up in the `SORTS` map — an unknown key 400s before any SQL exists.

### 3.2 The PATCH transaction, step by step

1. `BEGIN`, then `SELECT contact_type, status ... FOR UPDATE` — this (a)
   404s early if the id is unknown, (b) tells us the contact's type, which
   detail validation needs (on PATCH the type comes from the DB, never the
   request), and (c) locks the row so a concurrent PATCH can't slip between
   our read and our write.
2. `UPDATE contacts SET ..., updated_at = now()` — `updated_at` is
   maintained here because Phase 1 chose app-managed timestamps over a
   trigger; this is the discipline that decision bought.
3. If `status` was provided **and differs** from the old value, INSERT the
   `status_change` activity with a human-readable body.
4. Detail fields, if any, UPDATE the correct detail table for the type we
   read in step 1 — so `{"details":{"is_owner":true}}` against a doctor
   fails validation with a message naming the allowed fields.
5. `COMMIT`, then respond with the same canonical shape GET returns.

Every early exit before COMMIT calls `ROLLBACK`, and `client.release()` sits
in a `finally` — a thrown error can't leak the pooled connection.

### 3.3 Error handling in layers

- **Field validation** → specific 400s (`"tier must be one of: A, B, C"`).
- **UUID shape checked in code** (`UUID_RE`) → a garbage id is a 400, not
  the 500 Postgres's cast error would otherwise become.
- **FK violations** (`err.code === '23503'`) → the only user-reachable FK in
  POST/PATCH is `workplace_id`, so it maps to one clear 400.
- **Everything else** → the 4-arg error middleware in index.js: log the real
  error server-side, return a generic 500 (internals don't belong in
  responses). Async handlers are wrapped (`asyncHandler`) because Express 4
  doesn't route rejected promises to error middleware on its own.

### 3.4 What was verified live (curl against the seeded DB)

Happy paths: list (14 rows, correct nested shape); filters `type`, `status`,
`city` (case-insensitive — `?city=pune` matches "Pune"), `q=mehta`; both
sorts; detail view with newest-first timeline; create for HCP (201, full
shape) and pharmacist with no details (DB defaults produced `status: lead`,
`tier: C`, `is_owner: false`); PATCH status+tier (logged exactly one
`status_change`); PATCH details-only; activity create (201).

Error paths, all returning the intended code and message: unknown
type/sort/status filter values; missing `details.specialty`; misspelled
detail field (`speciality` — rejected by the unknown-key check, which is why
that check exists); invalid `contact_type`; well-formed-but-nonexistent
`workplace_id` (FK → 400); malformed JSON body; malformed UUID (400) vs
missing UUID (404) on GET/PATCH; `contact_type` change attempt; wrong-type
detail field on PATCH; empty PATCH body; `status_change` via the activities
endpoint; whitespace-only activity body; unknown route. The database was
reseeded afterwards, so the demo data is pristine.

## 4. Likely reviewer / video questions — with tight answers

**Q: How does this API prevent SQL injection?**
Every value goes through `pg`'s `$n` placeholders — sent to Postgres
separately from the SQL text, so input is data, never code. Where the SQL
string is built dynamically (filter clauses, ORDER BY, column lists), the
interpolated fragments come from server-side whitelists, not the request.

**Q: Why do POST and PATCH use transactions but the activities endpoint doesn't?**
Transactions exist to make *multiple* writes atomic. Create writes two rows
(base + detail); PATCH writes up to three (base, activity, detail) that must
agree. Logging an activity is one INSERT — already atomic.

**Q: What happens if the server crashes between inserting the base row and the detail row?**
Nothing is left behind: both inserts sit inside BEGIN/COMMIT, and an
uncommitted transaction is rolled back automatically when its connection
dies. That transaction is the API's half of the contract the schema can't
enforce ("every contact has a detail row").

**Q: Why FOR UPDATE in PATCH?**
The handler reads the current status, compares, and conditionally writes an
activity. Without the row lock, two concurrent PATCHes could both read
`lead`, both write, and log a misleading pair of transitions. FOR UPDATE
serializes them for pennies at this scale.

**Q: Why can't clients log a `status_change` activity directly?**
Because then the timeline could lie. Status-change rows are written only
inside the PATCH transaction that performs the change, so a `status_change`
in the timeline is *proof* the status changed.

**Q: Where's the pagination?**
Deliberately absent: a single rep's book is a few hundred contacts, and the
list query does one indexed pass. `LIMIT/OFFSET` (or keyset) slots into the
same query builder when data size demands it — noted as a known limitation
rather than built speculatively.

**Q: Why validate in JS when the DB has CHECK constraints?**
Different jobs. Validation gives humans actionable 400s naming the field;
constraints guarantee integrity against every path, including bugs in the
validation. Belt and suspenders, each doing what it's good at.
