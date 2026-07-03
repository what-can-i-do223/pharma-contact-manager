-- ============================================================================
-- Pharma Contact Manager — Seed Data
-- ============================================================================
--
-- Realistic demo data for a single pharma sales rep covering Mumbai, Pune,
-- Hyderabad and Delhi:
--   * 10 workplaces  (hospitals, clinics, pharmacies, a distributor)
--   * 14 contacts    (6 HCPs, 4 pharmacists, 4 procurement officers)
--   * mixed tiers (A/B/C) and all four statuses
--   * BACKDATED activities, chosen so the Phase-3 overdue planner shows
--     visible results on day one (tier intervals: A=14d, B=30d, C=90d).
--
-- FIXED UUIDs: every row uses a hand-written, readable UUID
-- ('aaaaaaaa-…' = workplace, 'cccccccc-…' = contact) instead of
-- gen_random_uuid(). That makes cross-references in this file legible and
-- keeps seeded ids stable across re-runs, which makes manual API testing
-- ("GET /api/contacts/cccccccc-…01") repeatable.
--
-- BACKDATING: created_at values use `now() - interval '…'` so the demo
-- ages gracefully — "20 days ago" is still 20 days ago whenever you seed.
--
-- Run AFTER schema.sql:  psql -d pharma_contacts -f server/db/seed.sql
-- ============================================================================

-- Wipe in dependency order so the seed is safe to re-run.
-- (TRUNCATE ... CASCADE would also work; explicit order is easier to read.)
DELETE FROM activities;
DELETE FROM hcp_details;
DELETE FROM pharmacist_details;
DELETE FROM procurement_details;
DELETE FROM contacts;
DELETE FROM workplaces;

-- ----------------------------------------------------------------------------
-- Workplaces
-- ----------------------------------------------------------------------------
INSERT INTO workplaces (id, name, kind, city) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Lilavati Hospital',            'hospital',    'Mumbai'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'Sahyadri Clinic',              'clinic',      'Pune'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'Apollo Hospitals Jubilee Hills','hospital',   'Hyderabad'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'KIMS Hospital',                'hospital',    'Hyderabad'),
  ('aaaaaaaa-0000-4000-8000-000000000005', 'Max Super Speciality Saket',   'hospital',    'Delhi'),
  ('aaaaaaaa-0000-4000-8000-000000000006', 'Wellness Forever Bandra',      'pharmacy',    'Mumbai'),
  ('aaaaaaaa-0000-4000-8000-000000000007', 'Noble Chemists FC Road',       'pharmacy',    'Pune'),
  ('aaaaaaaa-0000-4000-8000-000000000008', 'MedPlus Kukatpally',           'pharmacy',    'Hyderabad'),
  ('aaaaaaaa-0000-4000-8000-000000000009', 'Guardian Pharmacy CP',         'pharmacy',    'Delhi'),
  ('aaaaaaaa-0000-4000-8000-000000000010', 'Ajanta Pharma Distributors',   'distributor', 'Mumbai');

-- ----------------------------------------------------------------------------
-- Contacts (base rows) + their per-type detail rows
-- ----------------------------------------------------------------------------
-- Each contact is inserted as base row + detail row back-to-back so a reader
-- can see the whole "object" in one place. The overdue math in the comments
-- assumes the tier intervals A=14d / B=30d / C=90d and that "next visit due"
-- falls back to created_at when a contact has never been visited.

-- ── HCPs ────────────────────────────────────────────────────────────────────

-- 1. Dr. Asha Mehta — Tier A, active. Last visit 20 days ago → 6 days OVERDUE.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'Dr. Asha Mehta', 'hcp',
   '+91 98200 11001', 'asha.mehta@lilavati.example', 'Mumbai', 'active', 'A',
   'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '90 days', now() - interval '20 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'Cardiologist', 'Senior Consultant');

-- 2. Dr. Rajiv Kulkarni — Tier B, active. Last visit 10 days ago → on track.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000002', 'Dr. Rajiv Kulkarni', 'hcp',
   '+91 98220 11002', 'rajiv.kulkarni@sahyadri.example', 'Pune', 'active', 'B',
   'aaaaaaaa-0000-4000-8000-000000000002', now() - interval '75 days', now() - interval '10 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000002', 'General Physician', 'Resident Physician');

-- 3. Dr. Priya Nair — Tier A, active. Last visit 5 days ago → on track.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000003', 'Dr. Priya Nair', 'hcp',
   '+91 98490 11003', 'priya.nair@apollo.example', 'Hyderabad', 'active', 'A',
   'aaaaaaaa-0000-4000-8000-000000000003', now() - interval '120 days', now() - interval '2 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000003', 'Endocrinologist', 'Head of Department');

-- 4. Dr. Sanjay Gupta — Tier B, lead. NEVER visited; created 40 days ago,
--    so due date = created_at + 30d → 10 days OVERDUE (tests the fallback).
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000004', 'Dr. Sanjay Gupta', 'hcp',
   '+91 98110 11004', NULL, 'Delhi', 'lead', 'B',
   'aaaaaaaa-0000-4000-8000-000000000005', now() - interval '40 days', now() - interval '40 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000004', 'Orthopedic Surgeon', 'Senior Consultant');

-- 5. Dr. Farhan Sheikh — Tier C, dormant. Last visit 120 days ago → 30 days OVERDUE.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000005', 'Dr. Farhan Sheikh', 'hcp',
   '+91 98850 11005', 'farhan.sheikh@kims.example', 'Hyderabad', 'dormant', 'C',
   'aaaaaaaa-0000-4000-8000-000000000004', now() - interval '200 days', now() - interval '60 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000005', 'Pediatrician', 'Consultant');

-- 6. Dr. Kavita Rao — Tier C, lead. Never visited, created 20 days ago →
--    not due for another 70 days (C = 90d window).
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000006', 'Dr. Kavita Rao', 'hcp',
   NULL, 'kavita.rao@sahyadri.example', 'Pune', 'lead', 'C',
   'aaaaaaaa-0000-4000-8000-000000000002', now() - interval '20 days', now() - interval '20 days');
INSERT INTO hcp_details (contact_id, specialty, role) VALUES
  ('cccccccc-0000-4000-8000-000000000006', 'Dermatologist', 'Consultant');

-- ── Pharmacists ─────────────────────────────────────────────────────────────

-- 7. Suresh Patil — Tier A owner, active. Visited 3 days ago → on track.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000007', 'Suresh Patil', 'pharmacist',
   '+91 98200 22007', 'suresh.patil@wellness.example', 'Mumbai', 'active', 'A',
   'aaaaaaaa-0000-4000-8000-000000000006', now() - interval '150 days', now() - interval '3 days');
INSERT INTO pharmacist_details (contact_id, is_owner) VALUES
  ('cccccccc-0000-4000-8000-000000000007', true);

-- 8. Meena Joshi — Tier B owner, active. Last visit 45 days ago → 15 days OVERDUE.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000008', 'Meena Joshi', 'pharmacist',
   '+91 98220 22008', 'meena.joshi@noble.example', 'Pune', 'active', 'B',
   'aaaaaaaa-0000-4000-8000-000000000007', now() - interval '100 days', now() - interval '45 days');
INSERT INTO pharmacist_details (contact_id, is_owner) VALUES
  ('cccccccc-0000-4000-8000-000000000008', true);

-- 9. Arun Verma — Tier C staff pharmacist, lead. Never visited, created
--    100 days ago → 10 days OVERDUE via the created_at fallback.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000009', 'Arun Verma', 'pharmacist',
   '+91 98490 22009', NULL, 'Hyderabad', 'lead', 'C',
   'aaaaaaaa-0000-4000-8000-000000000008', now() - interval '100 days', now() - interval '100 days');
INSERT INTO pharmacist_details (contact_id, is_owner) VALUES
  ('cccccccc-0000-4000-8000-000000000009', false);

-- 10. Divya Shetty — Tier B staff pharmacist, dormant. Visited 25 days ago →
--     on track (just inside the 30-day window).
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000010', 'Divya Shetty', 'pharmacist',
   '+91 98110 22010', 'divya.shetty@guardian.example', 'Delhi', 'dormant', 'B',
   'aaaaaaaa-0000-4000-8000-000000000009', now() - interval '80 days', now() - interval '25 days');
INSERT INTO pharmacist_details (contact_id, is_owner) VALUES
  ('cccccccc-0000-4000-8000-000000000010', false);

-- ── Procurement officers ────────────────────────────────────────────────────

-- 11. Ramesh Iyer — Tier A, active, hospital purchase officer.
--     Last visit 16 days ago → 2 days OVERDUE (barely — good for sorting demos).
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000011', 'Ramesh Iyer', 'procurement',
   '+91 98200 33011', 'ramesh.iyer@lilavati.example', 'Mumbai', 'active', 'A',
   'aaaaaaaa-0000-4000-8000-000000000001', now() - interval '180 days', now() - interval '16 days');
INSERT INTO procurement_details (contact_id, purchasing_role) VALUES
  ('cccccccc-0000-4000-8000-000000000011', 'Purchase Officer');

-- 12. Anita Deshpande — Tier B, active, hospital stores. Visited 8 days ago → on track.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000012', 'Anita Deshpande', 'procurement',
   '+91 98490 33012', 'anita.d@kims.example', 'Hyderabad', 'active', 'B',
   'aaaaaaaa-0000-4000-8000-000000000004', now() - interval '110 days', now() - interval '8 days');
INSERT INTO procurement_details (contact_id, purchasing_role) VALUES
  ('cccccccc-0000-4000-8000-000000000012', 'Stores In-charge');

-- 13. Vikram Malhotra — Tier A, lead, DISTRIBUTOR supply chain. Never
--     visited, created 30 days ago → 16 days OVERDUE (A = 14d window).
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000013', 'Vikram Malhotra', 'procurement',
   '+91 98200 33013', 'vikram.m@ajanta.example', 'Mumbai', 'lead', 'A',
   'aaaaaaaa-0000-4000-8000-000000000010', now() - interval '30 days', now() - interval '30 days');
INSERT INTO procurement_details (contact_id, purchasing_role) VALUES
  ('cccccccc-0000-4000-8000-000000000013', 'Supply Chain Manager');

-- 14. Pooja Reddy — Tier C, CLOSED (lost the account). Last visit 95 days
--     ago → 5 days overdue on paper, but status 'closed' is why the UI also
--     filters by status, not just overdue.
INSERT INTO contacts (id, full_name, contact_type, phone, email, city, status, tier, workplace_id, created_at, updated_at) VALUES
  ('cccccccc-0000-4000-8000-000000000014', 'Pooja Reddy', 'procurement',
   '+91 98110 33014', 'pooja.reddy@max.example', 'Delhi', 'closed', 'C',
   'aaaaaaaa-0000-4000-8000-000000000005', now() - interval '160 days', now() - interval '30 days');
INSERT INTO procurement_details (contact_id, purchasing_role) VALUES
  ('cccccccc-0000-4000-8000-000000000014', 'Deputy Purchase Manager');

-- ----------------------------------------------------------------------------
-- Activities — the backdated timeline
-- ----------------------------------------------------------------------------
-- 'visit' rows drive the overdue computation; notes/calls/status_changes
-- make the per-contact timeline look lived-in. ids are auto-generated
-- (gen_random_uuid()) since nothing needs to reference an activity.
INSERT INTO activities (contact_id, kind, body, created_at) VALUES
  -- Dr. Asha Mehta (A): visit 20d ago → overdue since 6 days
  ('cccccccc-0000-4000-8000-000000000001', 'visit', 'Detailed CardioSafe 10mg; she asked for the AMI outcomes trial reprint.', now() - interval '20 days'),
  ('cccccccc-0000-4000-8000-000000000001', 'note',  'Prefers meetings after 2pm OPD. Gatekeeper: Sister Regina at reception.', now() - interval '18 days'),
  ('cccccccc-0000-4000-8000-000000000001', 'call',  'Confirmed she received the trial reprint; wants samples next visit.', now() - interval '12 days'),

  -- Dr. Rajiv Kulkarni (B): visit 10d ago → on track
  ('cccccccc-0000-4000-8000-000000000002', 'visit', 'Intro visit with GlucoBal starter pack. Positive on pricing vs competitor.', now() - interval '10 days'),
  ('cccccccc-0000-4000-8000-000000000002', 'status_change', 'Status changed from lead to active after first prescription commitment.', now() - interval '10 days'),

  -- Dr. Priya Nair (A): visits 35d and 5d ago → the overdue query must pick
  -- the LATEST visit, not just any visit (this pair is a test case for that).
  ('cccccccc-0000-4000-8000-000000000003', 'visit', 'Quarterly review of ThyroNorm uptake in her OPD.', now() - interval '35 days'),
  ('cccccccc-0000-4000-8000-000000000003', 'visit', 'Dropped new dosage chart; discussed switching two patients to 25mcg.', now() - interval '5 days'),
  ('cccccccc-0000-4000-8000-000000000003', 'call',  'Her registrar asked for patient counselling leaflets in Telugu.', now() - interval '2 days'),

  -- Dr. Sanjay Gupta (B, never visited): only a note → created_at fallback applies
  ('cccccccc-0000-4000-8000-000000000004', 'note',  'Referred by Dr. Mehta. Handles high-volume knee replacements; pitch OsteoFlex.', now() - interval '38 days'),

  -- Dr. Farhan Sheikh (C): old visit, then went quiet → dormant
  ('cccccccc-0000-4000-8000-000000000005', 'visit', 'Brief corridor meeting; low interest, OPD was overflowing.', now() - interval '120 days'),
  ('cccccccc-0000-4000-8000-000000000005', 'status_change', 'Status changed from active to dormant — no response to three follow-ups.', now() - interval '60 days'),

  -- Dr. Kavita Rao (C, new lead): just an intro note
  ('cccccccc-0000-4000-8000-000000000006', 'note',  'Met at Pune Derm CME. Interested in the new tretinoin formulation.', now() - interval '20 days'),

  -- Suresh Patil (A): regular fortnightly visits
  ('cccccccc-0000-4000-8000-000000000007', 'visit', 'Stock check: CardioSafe moving well, reordered 200 strips.', now() - interval '17 days'),
  ('cccccccc-0000-4000-8000-000000000007', 'visit', 'Placed festival-season order; discussed shelf placement for OTC line.', now() - interval '3 days'),

  -- Meena Joshi (B): visit 45d ago → 15 days overdue
  ('cccccccc-0000-4000-8000-000000000008', 'visit', 'She flagged expiry-return delays from our CFA; promised to escalate.', now() - interval '45 days'),
  ('cccccccc-0000-4000-8000-000000000008', 'note',  'Escalated the expiry-return issue to distribution manager over email.', now() - interval '43 days'),

  -- Arun Verma (C, never visited): one call only → created_at fallback applies
  ('cccccccc-0000-4000-8000-000000000009', 'call',  'Cold call. Store manager decides purchases; Arun influences substitution.', now() - interval '90 days'),

  -- Divya Shetty (B): visit 25d ago, went dormant earlier this year
  ('cccccccc-0000-4000-8000-000000000010', 'visit', 'Counter moved to new manager; Divya now handles only night shifts.', now() - interval '25 days'),
  ('cccccccc-0000-4000-8000-000000000010', 'status_change', 'Status changed from active to dormant — purchasing moved to head office.', now() - interval '25 days'),

  -- Ramesh Iyer (A): visit 16d ago → 2 days overdue
  ('cccccccc-0000-4000-8000-000000000011', 'visit', 'Rate-contract renewal discussion; asked for revised quote by month end.', now() - interval '16 days'),
  ('cccccccc-0000-4000-8000-000000000011', 'note',  'Quote sent. Tender committee meets first week of the month.', now() - interval '13 days'),

  -- Anita Deshpande (B): visited 8d ago → on track
  ('cccccccc-0000-4000-8000-000000000012', 'visit', 'Audited ward stock levels with her; shortfall in IV antibiotics line.', now() - interval '8 days'),
  ('cccccccc-0000-4000-8000-000000000012', 'call',  'Confirmed emergency PO for the antibiotics shortfall was raised.', now() - interval '6 days'),

  -- Vikram Malhotra (A, never visited): intro call only → fallback applies
  ('cccccccc-0000-4000-8000-000000000013', 'call',  'Intro call. Ajanta covers 300+ retail counters in western suburbs.', now() - interval '28 days'),

  -- Pooja Reddy (C, closed): the losing-the-account story
  ('cccccccc-0000-4000-8000-000000000014', 'visit', 'Final negotiation on oncology line pricing.', now() - interval '95 days'),
  ('cccccccc-0000-4000-8000-000000000014', 'status_change', 'Status changed from active to closed — hospital signed exclusive with competitor.', now() - interval '30 days');
