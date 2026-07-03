# Pharma Contact Manager — Build Spec for Claude Code

> **Read this whole file before writing any code.** This is a take-home
> assignment submission. The human must be able to explain every design
> decision on camera (a required video walkthrough covers: data model
> rationale, and one tradeoff they debated). Optimize for understanding and
> clean scope, not feature count. Time budget: ~4–6 hours of build.

---

## Your role

You are a **tutor that builds in phases and explains everything in writing.**
Do NOT quiz the human. Instead:

1. Build ONE phase at a time, in order. **Stop after each phase** and print:
   `✅ Phase <N> complete. Read docs/PHASE_<N>_EXPLAINED.md, then tell me to continue.`
2. **Heavily comment every file** — what and why, assuming a smart reader who
   hasn't seen the code.
3. After each phase, write `docs/PHASE_<N>_EXPLAINED.md` (spec below).
4. Maintain **`NOTES.md`** at the repo root from Phase 1 onward: an honest
   running log of (a) every real mistake you make and how it was caught/fixed,
   (b) every judgment call. Entries must be TRUE events from this build — never
   invented. This feeds the assignment's required "AI tool usage" note, which
   asks what the AI got wrong that the human had to fix. If a phase has no
   mistakes, write nothing for it — do not fabricate.
5. Keep scope tight. NO authentication/login (single-rep prototype; note this
   as a deliberate scope decision in the README). No WebSockets. Nothing the
   assignment didn't ask for.

## What we're building

A **Lead & Contact Manager** for a pharma sales rep: track doctors (HCPs),
pharmacists, and hospital/distributor procurement officers; log notes and
activities; filter/search/sort; plus two non-trivial features (Phase 3).

**Stack (confirmed by the human — do not change):**
- Backend: Node.js + Express, PostgreSQL via raw `pg` (no ORM), parameterized
  queries everywhere.
- Frontend: React + Vite (plain CSS or minimal styling; clean and usable beats
  fancy).
- Dev ergonomics: root `package.json` scripts so the reviewer can run
  everything with few commands.

## Project structure

```
pharma-contact-manager/
├── README.md
├── NOTES.md                      # honest AI-mistake + decision log
├── server/
│   ├── package.json
│   ├── .env.example
│   ├── db/schema.sql             # heavily commented
│   ├── db/seed.sql               # realistic demo data (≥12 contacts across all 3 types)
│   └── src/
│       ├── index.js              # Express bootstrap
│       ├── db.js                 # pg pool
│       └── routes/
│           ├── contacts.routes.js
│           └── activities.routes.js
├── client/                       # Vite React app
│   └── src/ ...
└── docs/
    ├── PHASE_1_EXPLAINED.md ... PHASE_4_EXPLAINED.md
    └── VIDEO_PREP.md             # written in Phase 4
```

---

## Phase 1 — Data model (the heart of this assignment)

The reviewer explicitly evaluates the data model. Requirements:

- Three contact types with genuinely different fields: **HCPs** (specialty,
  workplace hospital/clinic, role); **pharmacists** (pharmacy name, whether
  owner); **procurement officers** (hospital or distributor, purchasing role).
- Model this as a **shared `contacts` base table + per-type detail tables**
  (class-table inheritance): `contacts` holds common fields (name, type,
  phone, email, city, status, tier, workplace link, timestamps); `hcp_details`,
  `pharmacist_details`, `procurement_details` hold type-specific fields, each
  FK'ing to `contacts.id`.
- Include a lightweight **`workplaces`** table (hospitals/clinics/pharmacies/
  distributors) that contacts link to via a single FK for now. In the docs,
  explicitly answer the assignment's question: *what changes if a contact can
  work at multiple companies?* → the FK becomes a many-to-many
  `contact_affiliations` junction table (same pattern as a supply-chain link
  table). Explain why we did NOT build that now (YAGNI for a prototype).
- **`activities`** table: contact_id, kind ('note' | 'visit' | 'call' |
  'status_change'), body, created_at. Status changes are logged here too so
  the timeline is complete.
- `contacts.status` lifecycle via CHECK: ('lead','active','dormant','closed').
- `contacts.tier` CHECK: ('A','B','C') — used by Phase 3's visit planner.
- UUID PKs, TIMESTAMPTZ, CHECK constraints in the DB — same integrity
  philosophy as before.
- In PHASE_1_EXPLAINED.md, document the modeling alternatives considered
  (single table with nullable columns; JSONB details column; class-table
  inheritance) with honest pros/cons — this is prime material for the video's
  "a decision you debated" section.
- Seed data: realistic Indian pharma-flavored demo data across all 3 types,
  several cities, mixed tiers/statuses, and backdated activities so the
  overdue feature has visible results immediately.

## Phase 2 — REST API

Endpoints (all with parameterized queries):
- `POST /api/contacts` — create (type-specific details in one request;
  insert base + detail row in a transaction).
- `GET /api/contacts` — list with filters: `?type=`, `?status=`, `?city=`,
  `?q=` (name search), `?sort=` (name | last_contacted | overdue).
  Return each contact with its detail fields joined and its
  last-activity timestamp.
- `GET /api/contacts/:id` — full detail incl. type details + activity timeline.
- `PATCH /api/contacts/:id` — update status/details; a status change also
  inserts a 'status_change' activity (transaction).
- `POST /api/contacts/:id/activities` — add note/visit/call.
- Proper 400s with clear messages for bad input; 404 for missing ids.

## Phase 3 — Non-trivial features

**3a. Visit-tier planner with overdue flagging (build first):**
- Tier → target visit interval: A = 14 days, B = 30, C = 90 (constants,
  documented).
- `next_visit_due` = last activity of kind 'visit' (fall back to created_at)
  + interval. Computed in SQL at query time (no stored duplicate state —
  explain why in the doc).
- List endpoint returns `days_overdue`; supports `?overdue=true` filter and
  `sort=overdue`.

**3b. Duplicate-contact warning (only after 3a is solid):**
- On create, check for similar existing names using `pg_trgm` similarity
  (enable extension in schema). If similarity above threshold, return
  `409`-style response with the candidate matches; the client can resubmit
  with `?force=true` to create anyway.
- Keep it explainable: document what trigram similarity is in one paragraph.

## Phase 4 — React frontend (Vite)

Views:
1. **Contact list** — table with name, type badge, city, status, tier,
   last-contacted, overdue flag (red). Controls: search box, type/status
   filters, sort dropdown (incl. "most overdue").
2. **Contact detail** — all fields incl. type-specific ones; edit
   status/details; activity timeline (newest first); add note/visit/call form.
3. **New contact** — type picker that swaps the type-specific fields;
   duplicate-warning flow (show matches, "create anyway").
- Keep components simple and readable; fetch via a tiny api.js helper; no
  state library. Handle loading and error states. Responsive enough to not
  embarrass.

## Phase 5 — README + video prep

- **README.md**: video link placeholder at top; setup (Postgres create/schema/
  seed commands exactly as tested); run instructions (server + client);
  stack-choice rationale (short); scope decisions (no auth — why); AI-usage
  note drawing on NOTES.md (which tools, for what, how reviewed, what the AI
  got wrong — real entries only).
- **docs/VIDEO_PREP.md**: a 2–5 minute walkthrough script covering: demo flow;
  data model rationale + the multiple-companies answer; the debated tradeoff
  (recommend: contact-type modeling choice); one honest limitation.

## Each docs/PHASE_<N>_EXPLAINED.md must contain
1. What we built (plain English, 3–5 sentences)
2. Design decisions: chosen vs rejected alternatives, and why
3. Walkthrough of the tricky parts (line-by-line where non-obvious)
4. Likely reviewer/video questions with tight model answers

## Rules recap
- Phases sequential; build, document, STOP, wait.
- Minimal, runnable, honest. NOTES.md entries must be true.
- Begin with **Phase 1 only.**
