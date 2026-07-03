-- ============================================================================
-- Pharma Contact Manager — Database Schema
-- ============================================================================
--
-- WHAT THIS FILE DOES
--   Creates every table for the app, in dependency order:
--     1. workplaces            — hospitals / clinics / pharmacies / distributors
--     2. contacts              — the shared "base" row for every contact
--     3. hcp_details           — extra fields only doctors (HCPs) have
--     4. pharmacist_details    — extra fields only pharmacists have
--     5. procurement_details   — extra fields only procurement officers have
--     6. activities            — the interaction timeline (notes/visits/calls)
--
-- THE CORE MODELING DECISION (class-table inheritance)
--   We have three contact types that share most fields (name, phone, city,
--   status, tier...) but each has a few fields the others don't. We model
--   this as ONE shared `contacts` table plus ONE small "detail" table per
--   type, joined 1-to-1 on the contact's id. This is the relational pattern
--   called *class-table inheritance*.
--
--   Alternatives we rejected (full discussion in docs/PHASE_1_EXPLAINED.md):
--     - One wide table with nullable type-specific columns: simple, but the
--       DB can't stop a pharmacist row from having a `specialty`, and every
--       new type widens the table with more NULLs.
--     - A JSONB `details` column: flexible, but no column-level constraints,
--       no NOT NULL on individual detail fields, and queries get stringly.
--   Class-table inheritance costs one JOIN per read but gives us real
--   columns, real constraints, and a clean place to add per-type fields.
--
-- INTEGRITY PHILOSOPHY
--   Rules that must never be violated live in the database (CHECK, FK,
--   UNIQUE, NOT NULL) — not only in application code. App code can have
--   bugs, be bypassed (psql, a script), or be rewritten; the schema is the
--   single choke point every write goes through.
--
-- HOW TO RUN
--   createdb pharma_contacts
--   psql -d pharma_contacts -f server/db/schema.sql
--   psql -d pharma_contacts -f server/db/seed.sql
-- ============================================================================

-- pg_trgm powers the duplicate-contact warning (Phase 3b): it provides
-- similarity(text, text) → 0.0..1.0 based on shared three-letter chunks
-- ("trigrams"), so "Dr. Asha Mehta" and "Dr. Asha Meta" score high while
-- unrelated names score near zero. Ships with Postgres (contrib);
-- IF NOT EXISTS makes re-runs safe.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Start clean so the file is safe to re-run during development.
-- CASCADE drops dependent objects (the detail tables' FKs) in one go.
DROP TABLE IF EXISTS activities          CASCADE;
DROP TABLE IF EXISTS hcp_details         CASCADE;
DROP TABLE IF EXISTS pharmacist_details  CASCADE;
DROP TABLE IF EXISTS procurement_details CASCADE;
DROP TABLE IF EXISTS contacts            CASCADE;
DROP TABLE IF EXISTS workplaces          CASCADE;

-- ----------------------------------------------------------------------------
-- 1. workplaces — the organizations contacts belong to
-- ----------------------------------------------------------------------------
-- One lightweight table for all four kinds of organization rather than four
-- tiny tables: they share the same shape (name, kind, city), and a single
-- table means `contacts` needs only a single FK.
--
-- DELIBERATE SIMPLIFICATION: a contact links to exactly ONE workplace
-- (contacts.workplace_id below). If the product later needs "a doctor who
-- consults at two hospitals", this FK is replaced by a many-to-many junction
-- table `contact_affiliations(contact_id, workplace_id, role, ...)`.
-- We did NOT build that now — YAGNI for a prototype; see PHASE_1_EXPLAINED.md.
CREATE TABLE workplaces (
    -- UUID primary keys everywhere: ids are globally unique (safe to merge
    -- datasets, no information leaked about row counts) and gen_random_uuid()
    -- is built into PostgreSQL 13+ — no extension needed.
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name       TEXT NOT NULL,

    -- What kind of organization this is. A CHECK constraint (not an ENUM
    -- type) because adding a value later is a one-line ALTER, whereas
    -- ALTERing an ENUM is more ceremony.
    kind       TEXT NOT NULL CHECK (kind IN ('hospital', 'clinic', 'pharmacy', 'distributor')),

    city       TEXT NOT NULL,

    -- TIMESTAMPTZ (not TIMESTAMP): stores an absolute instant in UTC and
    -- renders in the client's timezone. Plain TIMESTAMP is a wall-clock time
    -- with no zone — a classic source of off-by-5:30 bugs in India.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. contacts — the shared base row for every contact, regardless of type
-- ----------------------------------------------------------------------------
CREATE TABLE contacts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    full_name     TEXT NOT NULL,

    -- The discriminator: which detail table completes this row.
    contact_type  TEXT NOT NULL CHECK (contact_type IN ('hcp', 'pharmacist', 'procurement')),

    -- Contact channels are optional — a rep often starts with just a name
    -- from a hospital visit and fills these in later.
    phone         TEXT,
    email         TEXT,

    -- City lives on the contact (not only on the workplace) because reps
    -- filter their day plan by the city the *person* sits in, and a contact
    -- may be created before a workplace is linked.
    city          TEXT NOT NULL,

    -- Sales lifecycle. CHECK enforces the four allowed states; every status
    -- change is also logged as an activity (see `activities` below) so the
    -- timeline tells the full story.
    status        TEXT NOT NULL DEFAULT 'lead'
                  CHECK (status IN ('lead', 'active', 'dormant', 'closed')),

    -- Priority tier drives the visit planner (Phase 3): A = visit every
    -- 14 days, B = 30, C = 90.
    tier          TEXT NOT NULL DEFAULT 'C' CHECK (tier IN ('A', 'B', 'C')),

    -- Single-workplace link (see the note on `workplaces` above).
    -- ON DELETE SET NULL: deleting a workplace should not delete the people —
    -- they just become "unaffiliated" until re-linked.
    workplace_id  UUID REFERENCES workplaces(id) ON DELETE SET NULL,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Maintained by the API layer (`SET updated_at = now()` inside every
    -- UPDATE statement) rather than a trigger — one less invisible moving
    -- part to explain, at the cost of discipline in our own queries.
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- This UNIQUE pair exists ONLY as the target for the composite foreign
    -- keys in the detail tables below — it lets the DB guarantee that an
    -- hcp_details row can only ever attach to a contact whose type is 'hcp'.
    -- (id alone is already unique; adding contact_type doesn't change that,
    -- it just gives the FK something to grab.)
    UNIQUE (id, contact_type)
);

-- Indexes for the list screen's filters. Small dataset now, but they document
-- the intended access paths: filter by type/status/city, join activities.
CREATE INDEX idx_contacts_type   ON contacts (contact_type);
CREATE INDEX idx_contacts_status ON contacts (status);
CREATE INDEX idx_contacts_city   ON contacts (city);

-- ----------------------------------------------------------------------------
-- 3–5. Per-type detail tables (the "class-table inheritance" leaves)
-- ----------------------------------------------------------------------------
-- Shared shape, three times:
--   * PRIMARY KEY = contact_id  → enforces AT MOST ONE detail row per contact
--     (a true 1-to-1, not 1-to-many).
--   * contact_type column CHECK-pinned to one literal value, plus a COMPOSITE
--     FK on (contact_id, contact_type) → the DB itself rejects, say, a
--     pharmacist_details row pointing at an HCP contact. Without this trick a
--     plain FK on contact_id would happily allow cross-type detail rows and
--     we'd be trusting app code to prevent them.
--   * ON DELETE CASCADE → a detail row is meaningless without its base row,
--     so deleting the contact removes it automatically.
--
-- Known, accepted gap: the DB cannot force that a detail row EXISTS for every
-- contact (that would need deferred cross-table constraints — overkill here).
-- The API creates base + detail together in one transaction (Phase 2).

-- Doctors / healthcare professionals.
-- Their workplace (hospital or clinic) is the shared workplace_id link;
-- only truly HCP-specific facts live here.
CREATE TABLE hcp_details (
    contact_id   UUID PRIMARY KEY,
    contact_type TEXT NOT NULL DEFAULT 'hcp' CHECK (contact_type = 'hcp'),

    -- e.g. 'Cardiologist', 'General Physician' — free text, not a lookup
    -- table: specialties are read-mostly labels, and a prototype doesn't
    -- need to manage a canonical list.
    specialty    TEXT NOT NULL,

    -- Their position at the workplace, e.g. 'Senior Consultant', 'HOD'.
    role         TEXT,

    FOREIGN KEY (contact_id, contact_type)
        REFERENCES contacts (id, contact_type)
        ON DELETE CASCADE
);

-- Pharmacists. The pharmacy's NAME lives in `workplaces` (kind='pharmacy')
-- via the shared workplace link — it's an organization like any other, not a
-- pharmacist-only attribute. What IS pharmacist-specific:
CREATE TABLE pharmacist_details (
    contact_id   UUID PRIMARY KEY,
    contact_type TEXT NOT NULL DEFAULT 'pharmacist' CHECK (contact_type = 'pharmacist'),

    -- Owners decide stocking; staff pharmacists influence substitution.
    -- Different sales conversation, so the rep needs this flag.
    is_owner     BOOLEAN NOT NULL DEFAULT false,

    FOREIGN KEY (contact_id, contact_type)
        REFERENCES contacts (id, contact_type)
        ON DELETE CASCADE
);

-- Hospital / distributor procurement officers.
-- Whether they sit at a hospital or a distributor is expressed by their
-- workplace's `kind` — not duplicated here.
CREATE TABLE procurement_details (
    contact_id      UUID PRIMARY KEY,
    contact_type    TEXT NOT NULL DEFAULT 'procurement' CHECK (contact_type = 'procurement'),

    -- Their purchasing role, e.g. 'Purchase Officer', 'Stores In-charge',
    -- 'Supply Chain Manager'. NOT NULL: it's the defining fact of this type.
    purchasing_role TEXT NOT NULL,

    FOREIGN KEY (contact_id, contact_type)
        REFERENCES contacts (id, contact_type)
        ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 6. activities — the interaction timeline
-- ----------------------------------------------------------------------------
-- One append-only stream per contact. Status changes are logged here too
-- ('status_change' rows, written by the API in the same transaction as the
-- UPDATE), so the timeline is a complete history — you can see not just
-- "called on the 3rd, visited on the 10th" but also "moved to active on
-- the 12th" in one chronological list.
--
-- The visit planner (Phase 3) computes "next visit due" from the newest
-- 'visit' row here at query time — we deliberately do NOT store a
-- last_visited column on contacts, because duplicated state drifts.
CREATE TABLE activities (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- CASCADE: activities are meaningless without their contact.
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

    kind       TEXT NOT NULL CHECK (kind IN ('note', 'visit', 'call', 'status_change')),

    -- The content: the note text, what happened on the visit/call, or a
    -- human-readable description of the status change.
    body       TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The timeline query is always "this contact's activities, newest first" —
-- this composite index serves it directly.
CREATE INDEX idx_activities_contact_created
    ON activities (contact_id, created_at DESC);
