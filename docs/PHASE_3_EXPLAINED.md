# Phase 3 Explained — Visit Planner & Duplicate Warning

## 1. What we built

Two non-trivial features on top of the existing API. **3a — visit-tier
planner:** every contact now carries `last_visit_at`, `next_visit_due`,
`days_overdue` and `is_overdue`, computed in SQL at query time from the
activity log (tier intervals: A = 14 days, B = 30, C = 90); the list endpoint
gained `?overdue=true|false` and `sort=overdue`. **3b — duplicate-contact
warning:** creating a contact whose name is trigram-similar to an existing
one returns `409 Conflict` with the candidate matches; resubmitting with
`?force=true` creates it anyway. Both were verified live against the seeded
data — and 3b's live testing caught a real blind spot in the threshold
analysis (kept, but now documented — see §3.3 and NOTES.md).

Changed files: [schema.sql](../server/db/schema.sql) (one line: the
`pg_trgm` extension) and
[contacts.routes.js](../server/src/routes/contacts.routes.js) (planner SQL,
two list parameters, the duplicate check).

## 2. Design decisions — chosen vs. rejected

**Compute overdue at query time; store nothing** *(the spec asked why —
here's the answer)*. `next_visit_due` is fully derivable from facts we
already store: the newest `visit` activity (or `created_at` for
never-visited contacts) plus the tier's interval. Storing it would make it a
cache with three invalidation triggers — new visit logged, tier changed,
contact created — and one forgotten trigger means a silently wrong overdue
flag, the worst kind of bug in a trust-your-tool app. The rejected
alternative (a `next_visit_due` column updated by application code or
triggers) buys performance we don't need — the computation is two indexed
lookups and an interval addition over a few hundred rows — at the price of a
consistency obligation that never expires. Derived state can't drift.

**Signed `days_overdue`, plus a server-derived `is_overdue`.** The SQL
yields "6" for six days overdue and "-9" for due-in-nine-days; clamping to
zero would throw away the "due soon" information a planning screen wants.
`is_overdue` (`days_overdue > 0`) ships from the server so every client
agrees on the rule instead of re-implementing it.

**`sort=overdue` is `days_overdue DESC`** — most-overdue first, and among
not-yet-due contacts it degrades gracefully into "due soonest first", which
is exactly the order a rep plans a week in.

**Duplicate check = warning, not block.** Same-name contacts are sometimes
legitimate (two Dr. Guptas in one city is unremarkable in India), so the API
never refuses — it returns 409 with evidence (top 5 matches with scores) and
an explicit escape hatch (`?force=true`). 409 rather than 400 so clients can
branch: 400 → fix the form; 409 → show "did you mean…?".

**Checked across all contact types, before the transaction.** The same human
entered once as an HCP and once as a procurement officer is still a
duplicate, so the check doesn't filter by type. It runs before the insert
transaction because it's a pure read — nothing to roll back.

**No trigram index.** `similarity()` in function-call form scans the table
regardless; index support needs the `%` operator plus `set_limit()`
machinery. A scan over one rep's few hundred contacts is sub-millisecond —
the index would be ceremony. Documented so it reads as a decision, not an
omission.

## 3. Walkthrough of the tricky parts

### 3.1 The planner SQL, from the inside out

```sql
LEFT JOIN LATERAL (
  SELECT max(a.created_at) AS last_visit_at
  FROM activities a
  WHERE a.contact_id = c.id AND a.kind = 'visit'
) lv ON true
```

A second LATERAL subquery alongside the existing "last activity of any kind"
one — deliberately separate, because they answer different questions: a
phone call updates *last contacted* but does **not** reset the visit clock.
Both ride the `(contact_id, created_at DESC)` index.

```sql
coalesce(lv.last_visit_at, c.created_at) + make_interval(days =>
  CASE c.tier WHEN 'A' THEN 14 WHEN 'B' THEN 30 WHEN 'C' THEN 90 END)
```

The `COALESCE` is the never-visited fallback the spec requires — a fresh
lead's clock starts when the rep added them. The CASE is *generated in JS*
from the `TIER_VISIT_INTERVAL_DAYS` constant, so the product rule lives in
one named place; the interpolation is safe because every character comes
from that server-side constant, never a request.

```sql
floor(extract(epoch FROM (now() - next_visit_due)) / 86400)::int
```

`floor()` means a contact becomes "1 day overdue" only after a full day has
passed — half a day late rounds to 0, not 1. The same expression string is
reused in `WHERE` (for `?overdue=`) and `ORDER BY` (for `sort=overdue`)
because SQL can't reference a SELECT alias from WHERE; sharing the JS
constant keeps the three uses identical by construction.

### 3.2 Trigram similarity in one paragraph (for the video)

`pg_trgm` breaks a string into all its three-character chunks — "mehta"
becomes ` me`, `meh`, `eht`, `hta`, `ta ` (padded at the edges) — and scores
two strings by how much their chunk sets overlap: 1.0 = identical sets,
0.0 = nothing shared. Because a one-letter typo only disturbs the two or
three chunks that touch it, "Dr. Asha Meta" still shares most chunks with
"Dr. Asha Mehta" and scores 0.69, while a genuinely different name shares
almost none and scores near 0.2. It's spelling-based, not phonetic:
"Mehta"/"Meta" (typo) scores high, but "Sheikh"/"Shaikh"-style transliteration
pairs score lower — a known limitation worth saying out loud.

### 3.3 Picking 0.45 — including the blind spot testing found

The threshold came from measuring, not guessing. Against the seeded data:
unrelated names top out at **0.23**; surname-only overlap ("Dr. Sanjay
Mehta" vs "Dr. Asha Mehta") reaches **0.43**; real duplicate variants of a
seeded name — missing dot, dropped title, typo'd surname, initialled first
name — score **0.50–1.00**. So 0.45 was chosen to sit in the gap.

Then live testing caught what the analysis missed: the experiment compared
candidate names against **one** target, but the API compares against the
**whole table** — and "Dr. Sanjay Mehta" hit *0.52* against "Dr. Sanjay
**Gupta**" (shared title + first name), a different person, triggering a 409
the analysis said wouldn't happen. Decision: **keep 0.45.** Raising the
threshold above 0.52 would also silence "Asha Meta" at 0.50 — a real
duplicate variant. For a warning that costs one click to dismiss, a false
positive is noise; a false negative defeats the feature. The false-positive
mode is documented at the constant's definition, and the mistake is logged
in NOTES.md — it's a good honest-limitation story for the video.

### 3.4 What was verified live

- `sort=overdue` returned all 14 contacts in exactly the order predicted in
  the Phase-1 seed comments: Farhan 30, Vikram 16, Meena 15, Arun 10,
  Sanjay 10, Asha 6, Pooja 5, Ramesh 2, then the six not-yet-due contacts
  from −5 to −70.
- Both never-visited contacts (Sanjay Gupta, Vikram Malhotra) got correct
  due dates via the `created_at` fallback; Dr. Priya Nair's **latest** of
  two visits set her clock (−9 days, not overdue) — the seeded trap query
  authors fall into, passed.
- `?overdue=true` → 8 rows, `?overdue=false` → 6, filters compose
  (`?overdue=true&status=active&sort=overdue` → the rep's "today list":
  Meena 15, Asha 6, Ramesh 2), `?overdue=yes` → clear 400.
- Duplicates: exact name → 409 with `similarity: 1.00`; "Asha Meta"
  (typo + dropped title) → 409 matching Dr. Asha Mehta at 0.50;
  `?force=true` → 201; and the 409 path provably inserts nothing (row count
  unchanged). Database reseeded afterwards.

## 4. Likely reviewer / video questions — with tight answers

**Q: Why compute overdue on every request instead of storing it?**
Because it's derivable from data we already store, and stored derived state
is a cache that must be invalidated on visit logged, tier changed, and
contact created — miss one and the flag silently lies. Query-time derivation
can't drift, and at this data volume it costs microseconds. If it ever got
slow, the fix is a materialized view or generated column — same rule, still
defined in one place.

**Q: Why does a call not reset the visit clock?**
The planner models face-to-face coverage — in pharma sales, a visit is the
unit of relationship maintenance; a call is a touch, not coverage. Hence two
separate LATERAL subqueries: any-activity for "last contacted", visit-only
for the planner.

**Q: What exactly is trigram similarity?**
Break both strings into all overlapping three-character chunks, score by
overlap of the chunk sets: 1.0 identical, 0.0 disjoint. Typos barely move
the score because they only disturb neighboring chunks. It catches
spelling-level duplicates, not phonetic ones.

**Q: How did you pick 0.45?**
Measured three bands against the seed data — unrelated ≤0.23, surname
coincidence 0.43, true variants ≥0.50 — and put the threshold in the gap.
Live testing then found a false-positive mode the analysis missed (shared
title + first name scores 0.52); we kept the threshold anyway because
raising it would sacrifice real variants at 0.50, and for a warning, misses
are worse than noise.

**Q: Why 409 and not 400 or refusing outright?**
Same-name people legitimately exist, so refusal is wrong; the API warns
with evidence and lets the human decide via `?force=true`. 409 ("conflict
with current state") rather than 400 ("your request is malformed") so
clients can branch to a "did you mean…?" dialog.

**Q: Could someone bypass the duplicate check?**
Yes — `?force=true` is a documented front door, and that's the design: the
server's job is to make duplicates hard to create *accidentally*, not
impossible to create deliberately.
