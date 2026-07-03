# Phase 1 Explained — The Data Model

## 1. What we built

Phase 1 is the database only: a PostgreSQL schema ([server/db/schema.sql](../server/db/schema.sql))
and realistic seed data ([server/db/seed.sql](../server/db/seed.sql)). The
schema models three kinds of pharma sales contacts — doctors (HCPs),
pharmacists, and procurement officers — as one shared `contacts` table plus a
small per-type detail table each, linked to a `workplaces` table (hospitals,
clinics, pharmacies, distributors) and an `activities` timeline (notes,
visits, calls, status changes). The seed loads 10 workplaces, 14 contacts
across 4 cities with mixed tiers and statuses, and 26 **backdated** activities
so the Phase-3 "overdue visit" feature shows meaningful results the moment
you seed. Everything was run and verified against PostgreSQL 16.

To set it up:

```bash
createdb pharma_contacts
psql -d pharma_contacts -f server/db/schema.sql
psql -d pharma_contacts -f server/db/seed.sql
```

## 2. Design decisions — chosen vs. rejected

### 2.1 How to model three contact types (THE decision of this assignment)

The three types share most fields (name, phone, city, status, tier…) but each
has fields the others don't: HCPs have a specialty and role, pharmacists have
an ownership flag, procurement officers have a purchasing role. Three honest
options:

**Option A — one wide table with nullable columns** (rejected)

```
contacts(id, name, type, ..., specialty, role, is_owner, purchasing_role)
```

- ✅ Simplest possible queries: no JOINs, ever.
- ✅ Fine for 3 types with 1–2 extra fields each — honestly, it would work here.
- ❌ The database cannot express "only HCPs have a specialty". A pharmacist
  row with `specialty = 'Cardiologist'` is legal garbage unless you write
  hairy multi-column CHECK constraints that grow with every type.
- ❌ You can't mark `specialty NOT NULL` (it's null for two-thirds of rows),
  so even required per-type fields become optional everywhere.
- ❌ Every new type widens the table for all rows. NULL-sprawl.

**Option B — a JSONB `details` column** (rejected)

```
contacts(id, name, type, ..., details JSONB)
```

- ✅ Ultimate flexibility; new types need zero migrations.
- ✅ Reasonable when detail shapes are unknown or user-defined.
- ❌ No column types, no NOT NULL, no CHECK on individual keys — a typo like
  `{"speciality": ...}` is silently accepted and silently breaks reads.
- ❌ Queries and indexing get stringly (`details->>'is_owner' = 'true'`).
- ❌ Our detail shapes are *known and stable* — flexibility we'd pay for and
  never use.

**Option C — class-table inheritance: shared base + per-type detail tables**
(✅ chosen)

```
contacts(id, name, contact_type, ...)          -- everything shared
hcp_details(contact_id → contacts, specialty, role)
pharmacist_details(contact_id → contacts, is_owner)
procurement_details(contact_id → contacts, purchasing_role)
```

- ✅ Real columns: types, `NOT NULL`, CHECKs all work per field
  (`hcp_details.specialty TEXT NOT NULL` — enforceable, unlike Option A).
- ✅ Shared queries (list, filter, search, the overdue planner) touch only
  `contacts` — the common case pays no penalty.
- ✅ Adding a contact type = one new table; existing rows untouched.
- ❌ Reads that need detail fields cost a JOIN (or three LEFT JOINs for a
  mixed list). Acceptable: 1-to-1 joins on primary keys are cheap.
- ❌ Writes must create two rows atomically — the API wraps base + detail
  inserts in a transaction (Phase 2).

The honest summary for the video: **at this scale all three work; we chose C
because it's the only one where the *database* enforces the shape of each
type, and this assignment explicitly grades data-model rigor.**

### 2.2 What if a contact can work at multiple companies?

Today: `contacts.workplace_id` — a single FK, because a prototype rep tracks
one primary workplace per person. If the requirement becomes "Dr. Mehta
consults at Lilavati *and* Breach Candy", a single FK can't hold two values;
the fix is a **many-to-many junction table**:

```sql
CREATE TABLE contact_affiliations (
    contact_id   UUID NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
    workplace_id UUID NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
    role         TEXT,          -- what they do THERE ("Visiting Consultant")
    is_primary   BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (contact_id, workplace_id)   -- same pair only once
);
```

Each *relationship* becomes a row, and relationship-specific facts (their role
there, which is primary) get a natural home — the same pattern as a
supply-chain link table between suppliers and products. Migration is
mechanical: `INSERT INTO contact_affiliations SELECT id, workplace_id, true
FROM contacts WHERE workplace_id IS NOT NULL`, then drop the column.

**Why we did NOT build it now (YAGNI):** every screen would pay the cost
today — create-contact needs multi-select UI, the list view needs an
aggregated join, "which workplace?" ambiguity appears in every query — for a
requirement the assignment doesn't have. Knowing the migration path and
deferring it *is* the design decision.

### 2.3 Smaller decisions worth defending

| Decision | Why |
|---|---|
| **CHECK constraints, not Postgres ENUMs** | Same integrity; adding a value later is a one-line `ALTER TABLE`, vs. ENUM alteration ceremony. |
| **UUID PKs (`gen_random_uuid()`)** | Globally unique, no extension needed on PG 13+, ids don't leak row counts. |
| **TIMESTAMPTZ everywhere** | Absolute instants, rendered in local time. Plain TIMESTAMP invites off-by-5:30 bugs in IST. |
| **Status changes logged in `activities`** | One chronological timeline tells the whole story; no separate audit table for a prototype. |
| **No `last_visited` column on contacts** | It duplicates what `activities` already knows; duplicated state drifts. Phase 3 computes it at query time. |
| **`updated_at` set by the API, not a trigger** | One less invisible moving part to explain on camera; the cost is discipline in our own UPDATE statements. |
| **`workplace_id ON DELETE SET NULL`** | Deleting a workplace shouldn't delete people — they become unaffiliated. Activities, by contrast, CASCADE: they're meaningless without their contact. |
| **Pharmacy name lives in `workplaces`, not `pharmacist_details`** | The spec lists "pharmacy name" as a pharmacist field, but a pharmacy is an organization like any other; storing its name on the person would duplicate it across colleagues at the same store. |

## 3. Walkthrough of the tricky parts

### 3.1 The composite-FK trick (the schema's one clever move)

A naive detail table would be:

```sql
CREATE TABLE hcp_details (
    contact_id UUID PRIMARY KEY REFERENCES contacts(id),
    ...
);
```

That guarantees the contact *exists* — but nothing stops an `hcp_details` row
from pointing at a **pharmacist**. The fix, step by step:

1. `contacts` declares `UNIQUE (id, contact_type)`. `id` alone is already
   unique, so this adds no new restriction — it only creates a two-column
   target a foreign key can reference.
2. Each detail table carries a `contact_type` column **pinned to one value**:
   `contact_type TEXT NOT NULL DEFAULT 'hcp' CHECK (contact_type = 'hcp')`.
3. The FK references **both columns**:
   `FOREIGN KEY (contact_id, contact_type) REFERENCES contacts (id, contact_type)`.

Now inserting an `hcp_details` row for a pharmacist contact makes Postgres
look for `(that-id, 'hcp')` in `contacts`, find only `(that-id,
'pharmacist')`, and reject the insert. We verified this live — the error:

```
ERROR: insert or update on table "pharmacist_details" violates foreign key
constraint "pharmacist_details_contact_id_contact_type_fkey"
```

The detail table's PK being `contact_id` (not a fresh UUID) is what makes the
relationship 1-to-1: a second detail row for the same contact violates the
primary key.

**Known, accepted gap:** the DB guarantees *at most* one detail row of the
*right type*, but cannot cheaply guarantee one *exists* (that needs deferred
cross-table constraints). The API closes the gap by inserting base + detail
in one transaction.

### 3.2 Seed data engineered as test cases

The seed isn't random — rows were chosen to exercise Phase 3 before it exists
(tier windows: A = 14 days, B = 30, C = 90):

- **Overdue via a real visit:** Dr. Asha Mehta (A, visited 20 days ago → 6
  days overdue), Meena Joshi (B, 45 days → 15 overdue).
- **Overdue via the fallback:** Dr. Sanjay Gupta and Vikram Malhotra have
  **never been visited**, so "due" falls back to `created_at` + window —
  seeded `created_at` values make both overdue. This exercises the
  `COALESCE(last_visit, created_at)` branch.
- **The "latest visit" trap:** Dr. Priya Nair has TWO visits (35 and 5 days
  ago). A buggy query that grabs *any* visit instead of `MAX(created_at)`
  flags her overdue; the correct one doesn't. Seeded deliberately as a test.
- **Edge of the window:** Ramesh Iyer is 2 days overdue, Divya Shetty is 5
  days *inside* her window — useful for eyeballing sort order.
- **Status vs. overdue:** Pooja Reddy is technically overdue but `closed` —
  demonstrates why the UI filters on status too.

Dry-run of the overdue math against the seeded DB (verified):

```
Dr. Farhan Sheikh  C   30 days overdue
Vikram Malhotra    A   16
Meena Joshi        B   15
Arun Verma         C   10
Dr. Sanjay Gupta   B   10
Dr. Asha Mehta     A    6
Pooja Reddy        C    5
Ramesh Iyer        A    2
(the other six are not yet due)
```

Two mechanical details: seeds use `now() - interval 'N days'` so the demo
never goes stale, and **fixed hand-written UUIDs** (`cccccccc-…-01`) so
cross-references inside the file are readable and API testing against seeded
ids is repeatable.

### 3.3 What was verified against a live PostgreSQL 16

- `schema.sql` and `seed.sql` run cleanly end-to-end (and re-run cleanly —
  both are idempotent via `DROP TABLE IF EXISTS` / `DELETE`).
- Counts: 14 contacts (6/4/4 across types), all 4 statuses, all 3 tiers,
  4 cities, 26 activities; every contact has exactly one detail row.
- Four bad inserts each rejected by the intended constraint: cross-type
  detail row (composite FK), invalid status (CHECK), invalid activity kind
  (CHECK), duplicate detail row (PK).

## 4. Likely reviewer / video questions — with tight answers

**Q: Why three detail tables instead of one table with nullable columns?**
At this size, nullable columns would work — but only the split lets the
database itself enforce each type's shape: `specialty` can be `NOT NULL` for
HCPs while not existing at all for pharmacists. Since the data model is the
graded artifact, we chose the option where correctness is structural, not
conventional. The cost is one join on detail reads and a transaction on
create.

**Q: Why not JSONB for the type-specific fields?**
JSONB shines when detail shapes are unknown or user-defined. Ours are known,
stable, and tiny — three fixed fields. JSONB would trade away typed columns
and per-field constraints for flexibility we'd never use.

**Q: What breaks if a contact works at multiple companies?**
Nothing breaks silently — a single FK just can't represent it. The fix is a
`contact_affiliations(contact_id, workplace_id, role, is_primary)` junction
table; existing data migrates with one INSERT…SELECT. We deferred it because
every screen would pay for many-to-many complexity today for a requirement
the prototype doesn't have.

**Q: How do you stop a pharmacist detail row pointing at a doctor?**
Composite foreign key: detail tables reference `(id, contact_type)` on
`contacts`, with their own `contact_type` CHECK-pinned to one literal. The
mismatch fails at insert time, in the database. Demonstrated live.

**Q: Can a contact exist with no detail row?**
The DB allows it (enforcing existence across tables needs deferred
constraints — overkill here); the API prevents it by creating both rows in
one transaction. That's a deliberate, documented split of responsibilities.

**Q: Why is there no `last_visited` column when the whole app cares about it?**
Because `activities` already knows it. A stored copy is a cache, and caches
drift — miss one code path that forgets to update it and every overdue flag
is silently wrong. We compute it in SQL at query time; at a rep's data volume
(hundreds of contacts) that's microseconds.

**Q: Why log status changes as activities?**
The rep's question is "what happened with this person?" — a single
chronological timeline (visits, calls, notes, *and* lifecycle moves) answers
it. A separate audit table would fragment that story for no prototype
benefit.
