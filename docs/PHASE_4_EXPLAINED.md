# Phase 4 Explained — The React Frontend

## 1. What we built

A Vite + React client with the three screens the assignment asks for:
a **contact list** (search, type/status filters, sort dropdown including
"most overdue", an overdue-only toggle, red overdue pills), a **contact
detail** page (all fields including type-specific ones, an edit panel for
status/tier/details, the newest-first timeline, and a log-note/visit/call
form), and a **new contact** form (type picker that swaps the type-specific
fields, workplace dropdown, and the full duplicate-warning flow with
"Create anyway"). Plain CSS, no component or state library, one tiny
[api.js](../client/src/api.js) for all server calls. The whole app was
verified by driving it in a headless browser — every screen, filter,
mutation and the 409 flow — with screenshots checked at desktop and phone
widths. One small server addition: read-only `GET /api/workplaces` to feed
the form's dropdown.

Run it (two terminals):

```bash
npm run dev:server   # API on :3001
npm run dev:client   # Vite on :5173 — open http://localhost:5173
```

## 2. Design decisions — chosen vs. rejected

**A ~20-line hash router instead of react-router.** Three screens, no
nested layouts, no route guards. `#/`, `#/new`, `#/contacts/<id>` — one
`hashchange` listener and a match function, and plain `<a href="#/…">`
anchors *are* the navigation. react-router earns its place at five+ screens
with nesting; here it would be a dependency whose features go unused. The
fragment never reaches the server, so no server routing config either.

**Server state is not duplicated on the client.** The list never filters or
sorts locally — every control change re-queries the API, because the
filter/sort logic already exists there (Phases 2–3) and implementing it
twice means two implementations that can disagree. Same principle on the
detail page: after any mutation the component just re-fetches; and the
overdue flag renders server-computed `is_overdue`/`days_overdue` rather than
re-deriving tier intervals in JS. The client renders truth; it doesn't
maintain a copy of it. (This is also the no-state-library argument:
`useState` + effects is enough when there's no client-side state worth
managing.)

**One `filters` object + one debounced effect** drives the entire list
screen. Any control updates the object; the effect re-fetches 250ms later,
canceling the pending timer on every change — that cancellation *is* the
debounce (no lodash). A `cancelled` flag ignores stale responses that
resolve after a newer request.

**The type-specific form fields exist once** —
[TypeDetailFields.jsx](../client/src/components/TypeDetailFields.jsx), a
spec-driven component (the client-side mirror of the server's
`DETAIL_SPEC`) used by both the create form and the edit panel, so the two
can't drift apart.

**The 409 is data, not an error.** `api.js` throws an `ApiError` carrying
the status and payload; NewContact catches status 409 and renders
`payload.matches` (with similarity percentages and links to each candidate)
in place of the submit button. "Create anyway" resubmits the same payload
with `?force=true`; "Back to editing" returns to the form.

**Smaller calls:**

| Decision | Why |
|---|---|
| `GET /api/workplaces` added (read-only) | The form's workplace `<select>` needs options; seeded UUIDs can't be typed by hand. No POST/PATCH — workplace management is out of scope. |
| Workplace dropdown filtered by contact type | Pharmacists see pharmacies, HCPs see hospitals/clinics — a client-side UX nicety the API deliberately doesn't enforce. |
| Optional fields sent only when filled | The API distinguishes absent/null from empty string (which it rejects); the form omits blank phone/email/workplace rather than sending `""`. |
| Unticked "overdue only" sends nothing | `overdue=false` would *hide* overdue contacts — not what an unticked checkbox means. |
| Table wrapped in `overflow-x: auto` | Tabular data scrolls inside its container on phones instead of breaking the page — verified at 375px. |
| Activity form keeps the kind after submit | Logging several visits in a row is the common case; only the text clears. |

## 3. Walkthrough of the tricky parts

### 3.1 The debounced fetch effect (ContactList)

```js
useEffect(() => {
  let cancelled = false;
  const timer = setTimeout(async () => { …fetch, guard with cancelled… }, 250);
  return () => { cancelled = true; clearTimeout(timer); };
}, [filters]);
```

Every keystroke updates `filters`, which re-runs the effect. The cleanup
from the *previous* run fires first: it clears the not-yet-fired timer (so
intermediate keystrokes never reach the network) and flips `cancelled` so
that if a request *was* already in flight, its late response is ignored
instead of overwriting newer results. Debounce and stale-response handling
in six lines, no library.

### 3.2 The duplicate flow, client side (NewContact)

`submit()` is one function used by both buttons: the normal submit calls it
plain; "Create anyway" calls `submit({ force: true })`. On `ApiError` with
status 409 it stores `payload.matches` in state — rendering the warning
panel — and any other error goes to the normal error banner. The user
leaves the flow three ways: click a match (it was a duplicate — navigate
to the existing contact), force-create, or go back to editing. On success,
`window.location.hash = '#/contacts/<id>'` navigates — with a hash router,
navigation is just an assignment.

### 3.3 What headless-browser verification actually checked

Playwright driving Edge against the real dev servers (screenshots reviewed,
console captured):

- List: 14 rows render; sort "most overdue" + overdue-only shows exactly
  the 8 expected contacts in the expected order, red pills on all;
  search "mehta" narrows to 1 row.
- Detail: timeline renders newest-first; logging a visit from the UI
  appends it; changing status to dormant via the edit panel adds the
  "Status changed from active to dormant." entry to the timeline —
  the Phase-2 transaction observed end-to-end through the UI.
- New contact: picking "Pharmacist" swaps in the ownership checkbox and
  narrows the workplace dropdown to the four pharmacies; submitting
  "Suresh Patel" triggers the duplicate panel showing "Suresh Patil —
  63% similar"; "Create anyway" lands on the new contact's detail page.
- Responsive: at 375px the detail grid stacks and the table scrolls in
  place; screenshots confirmed, zero console errors after the favicon fix.

The database was reseeded after verification, so demo data is pristine.

### 3.4 What the browser check caught

The browser's automatic `/favicon.ico` request 404'd — invisible in code
review, an immediate console error in the driven browser. Fixed with an
inline SVG data-URI favicon (no file to serve). The other console entry
during testing was the 409 itself: browsers log every non-2xx fetch as an
error even when the app handles it — expected, and worth knowing before the
video demo so it doesn't look like a bug on screen.

## 4. Likely reviewer / video questions — with tight answers

**Q: Why no react-router / redux / react-query?**
Three screens, no shared client state, and an API that already does
filtering, sorting and overdue math. A hash router is 20 explainable lines;
`useState` covers the state; re-fetching after mutations replaces cache
management. Each library solves a problem this app doesn't have yet.

**Q: Why does the client re-fetch after every mutation instead of updating local state?**
Hand-patching local state means reimplementing server logic (a status
change also adds a timeline entry — the client would have to know that).
Re-fetching guarantees the screen shows what the database actually says,
for the cost of one extra GET on a user-initiated action.

**Q: Where does the client compute overdue?**
Nowhere — that's the point. It renders the server's `is_overdue` and
`days_overdue`, so the tier-interval rule exists in exactly one place. If
the client also computed it, the two could disagree and the red pill would
be untrustworthy.

**Q: How does the UI handle the duplicate warning?**
`api.js` surfaces the 409's payload; the form swaps its submit button for a
panel listing the matches (name, type, city, similarity %, link). The user
either opens a match, forces creation (`?force=true`), or edits the name.
The server decides *whether* to warn; the client only decides how to show it.

**Q: Is it responsive?**
"Responsive enough not to embarrass," per the spec: one breakpoint stacks
the detail grid and form rows, the controls row wraps, and the table
scrolls inside its wrapper. Verified with phone-width screenshots — it's a
desktop-first tool that degrades gracefully, not a mobile app.

**Q: How do you know the UI actually works?**
Not by reading it — by driving it: headless-browser runs clicked through
every screen, filter, both mutation forms and the 409 flow, with
screenshots reviewed at two widths and the console checked. That process
caught the favicon 404.
