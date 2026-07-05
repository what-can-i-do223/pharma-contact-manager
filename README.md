# Pharma Contact Manager

**Video walkthrough:** https://www.loom.com/share/bf732389efd24165a429907f84c665ad
Please watch at 1.7x

**Live demo:** https://pharma-cm-backend.onrender.com

A Lead & Contact Manager for a pharma sales rep — tracking the doctors (HCPs),
pharmacists, and hospital/distributor procurement officers they visit, with
activity logging, a visit-priority planner, order tracking, and Google
Calendar / Gmail integration.

Note on Google OAuth access: since this app's OAuth consent screen is in "Testing" mode, only Google accounts explicitly added as test users can sign in. I've added admin@meliorasys.com as a test user, so that account can log in directly. If you'd like to try it with a different Google account, let me know the email and I'll add it.

---

## What it does

- **Contacts** across three genuinely different types — HCPs, pharmacists,
  and procurement officers — each with their own fields, plus shared status
  and priority tier.
- **Activity timeline** — notes, calls, and visits logged per contact.
- **Visit-tier planner** — A/B/C priority tiers with target visit intervals
  (14 / 30 / 90 days). The list flags overdue contacts, worst-first, so a rep
  always knows who needs attention.
- **Duplicate-contact warning** — new contacts are checked against existing
  names using text similarity before creation.
- **Orders & products** — a rep can log an order placed during a visit,
  track it through to delivered, and see a contact's lifetime order value.
- **Google sign-in** — reps authenticate with their Google account, which
  also grants Calendar and Gmail permissions in one flow. Each rep's data is
  fully isolated from every other rep's.
- **Google Calendar sync** — push a contact's next visit straight to the
  rep's real calendar.
- **Gmail daily digest** — an on-demand (and optionally scheduled) email
  summarizing the rep's overdue visits, grouped by city, and pending order
  deliveries.

---

## Stack

- **Backend:** Node.js + Express, PostgreSQL via raw `pg` (no ORM —
  parameterized queries throughout).
- **Frontend:** React + Vite.
- **Auth:** Google OAuth 2.0 ("Sign in with Google" doubles as the multi-rep
  login and grants Calendar/Gmail scopes in the same consent).
- Chose raw SQL over an ORM so every query and every access-control decision
  is explicit and easy to walk through. Chose Google OAuth over a
  password system since the assignment specifically called for Calendar and
  Gmail integration — one sign-in flow covers identity and both permissions.

---

## Setup — run it locally

### Prerequisites
- Node.js 18+
- PostgreSQL running locally
- A Google Cloud project with the Calendar API and Gmail API enabled, and an
  OAuth 2.0 Web Application client (see below)

### 1. Install dependencies
```bash
npm install --prefix server
npm install --prefix client
```

### 2. Create the database
```bash
psql -d postgres -c "CREATE USER pharma WITH PASSWORD 'pharma';"
psql -d postgres -c "CREATE DATABASE pharma_contacts OWNER pharma;"
psql postgres://pharma:pharma@localhost:5432/pharma_contacts -f server/db/schema.sql
psql postgres://pharma:pharma@localhost:5432/pharma_contacts -f server/db/seed.sql
```

### 3. Set up Google OAuth credentials
1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable the **Google Calendar API** and **Gmail API**.
3. Configure the **OAuth consent screen** (External, add yourself as a test
   user — the app runs in unverified "Testing" mode, which is standard for a
   dev prototype).
4. Create an **OAuth 2.0 Client ID** (Web application) with an authorized
   redirect URI of `http://localhost:3001/auth/google/callback`.

### 4. Configure environment variables
```bash
cp server/.env.example server/.env
```
Fill in `server/.env` with your database URL, your Google Client ID and
Secret, the redirect URI above, and a random `SESSION_SECRET`.

### 5. Run it
```bash
npm run dev:server      # API on http://localhost:3001
npm run dev --prefix client   # frontend on http://localhost:5173
```

Sign in with the Google account you added as a test user — new accounts are
automatically seeded with a full sample dataset.

---

## Deployment

Deployed on Render: one Web Service running the Express API, which also
serves the built React frontend from the same origin (so no CORS
configuration is needed), plus a managed Render PostgreSQL instance.

---

## A note on the data model

The three contact types share common fields (name, phone, city, status) but
each has fields the others don't — so contacts are modeled as a shared base
table plus a separate detail table per type, rather than one table with many
nullable columns or a JSON blob for the extra fields. This lets the database
itself enforce which fields belong to which type, at the cost of one extra
join to assemble a full contact record. If a contact needed to work at
multiple companies, the current single link from a contact to its workplace
would become a many-to-many join table between contacts and workplaces —
a contained change, since that relationship is already isolated in its own
column.

---

## AI tool usage

I used Claude (chat, for planning and design discussion) and Claude Code (in
VS Code) to help build this, working phase by phase and reviewing and
testing each part before moving on — including running the actual server and
driving the UI in a browser, not just reading the code.

A few concrete things it got wrong that I caught and fixed:
- It initially tuned the duplicate-detection similarity threshold by testing
  against a single example name, and testing against the full contact list
  surfaced a real false positive ("Dr. Sanjay Mehta" vs "Dr. Sanjay Gupta"
  scored higher than an actual duplicate typo). I kept the threshold low
  anyway, since it's a warning rather than a hard block — a false alarm
  costs one click, while a missed duplicate is worse.
- A variable name collision (two different things both named `client` in
  the same function — a database connection and a Google API client) broke
  the server on startup. It was caught only because I actually ran the
  server rather than trusting an isolated test.
- A small SQL mistake (`DELETE ... CASCADE`, which isn't valid syntax for
  `DELETE`) was caught on a re-read before it was ever run.

I reviewed and tested every phase myself before moving to the next, running
the app, checking API responses, and verifying things like cross-account
data isolation directly rather than assuming the generated code was correct.
