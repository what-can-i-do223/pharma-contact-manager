# Phase 8 Explained — Google Calendar Sync

## 1. What we built

Two things: an **in-app Agenda** (a new screen listing this week's due visits
and pending order deliveries, read entirely from local data), and **Google
Calendar sync** on top of it — each due visit has an "Add to Google Calendar"
button that creates an all-day "Visit: Dr. X" event on the rep's own calendar
via their stored OAuth token, storing the returned event id so a repeat click
never duplicates it. The whole feature degrades gracefully: the Agenda works
with Google entirely disconnected, and the calendar button turns into a
"Connect Google" link when the rep hasn't authorized (or has revoked) access.
Verified with a server test battery, a pure unit test of the event builder,
and a headless-browser pass; the live Google API call is the one piece that
can't be exercised without real credentials (§4).

New pieces: [visitPlanner.js](../server/src/visitPlanner.js) (shared tier SQL),
calendar helpers in [google.js](../server/src/google.js),
`POST /api/contacts/:id/calendar` in
[contacts.routes.js](../server/src/routes/contacts.routes.js),
[agenda.routes.js](../server/src/routes/agenda.routes.js), and the client
[Agenda](../client/src/pages/Agenda.jsx) +
[AddToCalendarButton](../client/src/components/AddToCalendarButton.jsx).

## 2. Design decisions — chosen vs. rejected

**Local agenda first, Google as an enhancement.** The Agenda reads only the
database — due visits from the Phase-3 planner, pending deliveries from
orders. Google Calendar sync is layered on top as an optional per-row action.
So the core planning value survives a rep who never connects Google, an
expired token, or a Google outage. Rejected: making the agenda itself read
from Google Calendar — that would make a core screen fail whenever Google is
unavailable, for no gain.

**The tier rule moved to one shared module.** The agenda needs the exact
"when is a visit due" computation the contacts list already had. Rather than
copy the `A=14/B=30/C=90` interval SQL into a second file (the drift risk
Phase 3 explicitly argued against), it now lives in `visitPlanner.js` and
both routes import `NEXT_VISIT_DUE_SQL` / `DAYS_OVERDUE_SQL` /
`LAST_VISIT_LATERAL`. One source of truth; verified the contacts endpoint's
overdue numbers are unchanged after the extraction.

**Event id stored on the contact, making sync idempotent.** `contacts.
calendar_event_id` holds the Google event id for that contact's upcoming
visit. The endpoint checks it first: if set, it returns the existing event
without calling Google at all. That's the dedup the spec asked for — clicking
twice can't make two events. Rejected: storing the id on the visit *activity*
— the event is about the *next, not-yet-happened* visit, which is a property
of the contact (its computed due date), not of any past activity row.

**"Not connected" and "token revoked" collapse into one graceful path.**
`getGoogleClientForRep` already threw `GoogleNotConnectedError` when a rep has
no refresh token; this phase also wraps the token-refresh call so a revoked/
invalid refresh token (`invalid_grant`) throws the *same* error instead of a
500. The endpoint maps it to `409 { code: 'google_not_connected' }`, and the
client turns that one code into the "Connect Google" link. One failure mode,
one prompt, whether the rep never connected or connected-then-revoked.

**All-day events.** A visit reminder is a day, not a time slot — an all-day
event avoids inventing a meeting time and sidesteps timezone math. (One
Google quirk handled: for all-day events `end.date` is *exclusive*, so a
one-day event ends on the following date — see §3.)

**Smaller calls:**

| Decision | Why |
|---|---|
| Agenda "this week" = overdue **+** next 7 days | A planning screen should surface what you're behind on *and* what's coming; `days_overdue >= -7`, most-overdue first. |
| Closed contacts excluded from the agenda | You don't plan visits to lost accounts. Dormant stays (an overdue dormant contact is a re-engagement cue). This is an agenda-specific product filter; the raw overdue math stays status-independent everywhere else. |
| "Pending deliveries" = pending orders, oldest first | There's no separate delivery-due date in the model; the orders aging longest are the ones to chase. |
| Prices/dates never sent by the client | The event's title/location/date are built server-side from the contact + its computed due date; the client only says *which contact*. |
| Button reused on Agenda **and** contact detail | Same `<AddToCalendarButton>` — "the app schedules a next visit → offer Add to Calendar" applies in both places. |

## 3. Walkthrough of the tricky parts

### 3.1 The calendar endpoint's three outcomes

```
POST /api/contacts/:id/calendar
  → contact not found / not yours ....... 404
  → already has calendar_event_id ....... 200 { created: false }   (no Google call)
  → Google not connected / revoked ...... 409 { code: 'google_not_connected' }
  → success ............................. 201 { created: true, calendar_event_id }
```

The idempotent branch is first and cheap: a repeat click returns the stored
id without touching Google. Only a genuinely-unsynced contact reaches
`createCalendarEvent`, and the sole *expected* failure there
(`GoogleNotConnectedError`) becomes the 409; anything else is a real bug →
central 500.

### 3.2 All-day event: the exclusive end date

`buildVisitEvent` is a pure function (unit-tested without Google):

```js
start: { date: '2026-07-10' }   // the due date
end:   { date: '2026-07-11' }   // next day — Google treats end.date as EXCLUSIVE
```

If start and end were the same date, Google rejects the event (zero-length).
The helper adds one day for the end. It also omits `location` entirely when
the contact has no workplace (rather than sending an empty string), and
titles the event `Visit: <full name>`.

### 3.3 Why refresh-failure became `GoogleNotConnectedError`

`getGoogleClientForRep` refreshes an expired access token using the stored
refresh token. If that refresh fails — the rep revoked access in their Google
settings, so Google returns `invalid_grant` — the old code would have thrown
a raw error and produced a 500. Now it's caught and re-thrown as
`GoogleNotConnectedError`, so the caller's single catch handles both "never
connected" and "connection went bad" identically: prompt to reconnect. (The
raw error is deliberately *not* logged — it can carry token material.)

### 3.4 What was verified

- **Unit:** `buildVisitEvent` — correct summary/location, all-day end = next
  day, location omitted when no workplace.
- **Agenda API:** 8 due visits (closed Pooja excluded), most-overdue-first
  (30,16,15,10,10,6,2,−5), the one upcoming (Divya, −5 = due in 5 days)
  included while Priya (−9, due in 9) is correctly outside the 7-day window;
  3 pending deliveries oldest-first.
- **Calendar API:** demo rep (no token) → 409 `google_not_connected`;
  pre-set event id → `created:false` with no Google call; bad UUID → 400;
  missing contact → 404; anonymous → 401.
- **Regression:** contacts `?overdue=true` still 8, `sort=overdue` order
  intact (the visitPlanner extraction changed no behavior), orders and
  contact-detail shape (now carrying `calendar_event_id`) unchanged.
- **UI (headless browser):** Agenda renders both tables; clicking "Add to
  Google Calendar" as the unconnected demo rep swaps the button for a
  "Connect Google → /auth/google" link; the contact-detail facts card shows
  the same control; a pre-synced contact shows the static "On Google
  Calendar" chip. Only console entry is the expected 409 (browsers log every
  non-2xx fetch even when handled — same as the Phase-4 duplicate 409).

## 4. Honest limitation — the live Google call is untested here

`createCalendarEvent`'s actual `calendar.events.insert` round trip needs a
real, connected Google account, and per the security rules no real
credentials live in this repo. Everything *around* it is tested: the event
payload (unit), the idempotent short-circuit, the not-connected 409, the
agenda, and the UI reconnect flow. The untested surface is the ~6 lines that
hand a validated event body to googleapis and read back the event id — the
same honest boundary as Phase 7's live token exchange. The first real login
+ click exercises it; the README (Phase 10) walks a reviewer through enabling
the Calendar API on their own credentials.

## 5. Likely reviewer / video questions — with tight answers

**Q: Does the app break if the rep hasn't connected Google?**
No — that's the core design. The Agenda reads only local data, so it works
fully. The only Google-dependent action (Add to Calendar) detects the
missing connection and shows a "Connect Google" link instead of erroring.

**Q: How do you avoid creating duplicate calendar events?**
The returned event id is stored on the contact. The endpoint checks it first
and, if present, returns it without calling Google. One event per contact's
upcoming visit, enforced by that stored id.

**Q: What if the rep already added it, then you log a new visit?**
Known limitation, documented: the due date moves but we don't currently
reschedule or delete the already-created Google event (that's future work —
a PATCH/delete against the stored event id). For the prototype, the stored
id keeps the button idempotent; it doesn't chase the date.

**Q: Why an all-day event and not a timed one?**
A tier-based follow-up is "visit this person around this date", not a 3pm
meeting. All-day avoids fabricating a time and dodges timezone conversion.
The one gotcha — Google's exclusive end date — is handled by ending the
event on the next day.

**Q: Revoked-token handling?**
Refreshing with a revoked refresh token throws `invalid_grant`; we convert
that to the same `GoogleNotConnectedError` as "never connected", so the rep
just sees "Connect Google" again. No 500, no dead end.

**Q: Why did the agenda need a shared SQL module?**
Because it computes the same "visit due" rule as the contacts list, and that
rule (the tier intervals) must have exactly one definition or the two screens
could disagree about who's overdue. `visitPlanner.js` is that single
definition; both routes import it.
