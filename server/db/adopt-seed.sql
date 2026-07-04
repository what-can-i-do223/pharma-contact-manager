-- ============================================================================
-- adopt-seed.sql — hand the demo data to your real (Google) account
-- ============================================================================
--
-- THE PROBLEM THIS SOLVES: seed data belongs to the fake "Demo Rep", but the
-- moment you sign in with your real Google account you're a NEW rep with an
-- empty book — a lousy demo. Run this AFTER your first login to move every
-- demo contact/order/activity to the most recently created REAL rep (i.e.
-- you). Dev convenience only — nothing in the app calls this.
--
--   npm run db:adopt      (or: psql -d pharma_contacts -f server/db/adopt-seed.sql)
--
-- Idempotent: once the demo rep owns nothing, re-running changes nothing.
BEGIN;

WITH real_rep AS (
  SELECT id FROM reps
  WHERE google_sub NOT LIKE 'demo-rep|%'   -- the seeded sentinel
  ORDER BY created_at DESC
  LIMIT 1
)
UPDATE contacts SET rep_id = (SELECT id FROM real_rep)
WHERE rep_id = 'bbbbbbbb-0000-4000-8000-000000000001'
  AND EXISTS (SELECT 1 FROM real_rep);

WITH real_rep AS (
  SELECT id FROM reps WHERE google_sub NOT LIKE 'demo-rep|%'
  ORDER BY created_at DESC LIMIT 1
)
UPDATE activities SET rep_id = (SELECT id FROM real_rep)
WHERE rep_id = 'bbbbbbbb-0000-4000-8000-000000000001'
  AND EXISTS (SELECT 1 FROM real_rep);

WITH real_rep AS (
  SELECT id FROM reps WHERE google_sub NOT LIKE 'demo-rep|%'
  ORDER BY created_at DESC LIMIT 1
)
UPDATE orders SET rep_id = (SELECT id FROM real_rep)
WHERE rep_id = 'bbbbbbbb-0000-4000-8000-000000000001'
  AND EXISTS (SELECT 1 FROM real_rep);

COMMIT;

-- Show the outcome so the run is self-explanatory.
SELECT r.name, r.email, count(c.id) AS contacts_owned
FROM reps r LEFT JOIN contacts c ON c.rep_id = r.id
GROUP BY r.id ORDER BY r.created_at;
