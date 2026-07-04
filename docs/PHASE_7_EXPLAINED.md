# Phase 7 Explained — Google OAuth Login + Multi-Rep Scoping

## 1. What we built

"Sign in with Google" is now the app's entire account system. One consent
flow gives us the rep's identity (a row in the new `reps` table) *and* the
Calendar/Gmail authorization Phases 8–9 will use — no password system
exists, deliberately. Every rep-owned table (`contacts`, `orders`,
`activities`) gained a `rep_id`, every query in every data route is scoped
by it, and all of `/api/*` sits behind a `requireRep` session wall (signed
JWT in an httpOnly cookie). Google refresh tokens are stored AES-256-GCM
encrypted; no token ever appears in a response or a log. The client shows a
login screen when anonymous and the rep's name + sign-out when not.
Verified with a two-rep isolation battery (every cross-tenant probe on
every route), forged-cookie tests, an encryption test, and a headless-
browser pass. What *cannot* be tested without real credentials — the live
Google token exchange — is called out honestly in §3.5.

## 2. Design decisions — chosen vs. rejected

**OAuth login = the login (no password system).** The founder-y question
this answers: why build password auth when every rep has a Google account
and the app needs Google authorization anyway? One "Sign in with Google"
click yields identity (OpenID Connect ID token) + API consent
(Calendar/Gmail scopes) in a single grant. We store no passwords, no hashes,
no reset flow — a whole attack surface that simply doesn't exist here.
Rejected: separate email/password auth with a "Connect Google" button later
— two account systems to explain and link, for zero benefit at this scale.

**Our own session on top of Google's.** After the callback we issue a
12-hour JWT (`{rep_id}`) in an **httpOnly, SameSite=Lax cookie** — Google is
consulted once at login, not per request. Rejected alternatives:
- *Server-side session store* — needs a table/Redis and cleanup; a signed
  JWT keeps the server stateless and is the pattern reused conceptually
  from the prior project, as the spec asked.
- *JWT in localStorage* — readable by any injected script; httpOnly means
  even successful XSS can't exfiltrate the session.
- *Sending Google's access token to the browser* — never. Google tokens
  stay server-side, full stop.

**Identity key = `google_sub`, not email.** Google's `sub` claim is the
account's permanent id; emails can change and (across workspaces) be
reassigned. Login is an upsert on `google_sub`, so profile changes update
the row instead of duplicating the rep.

**`rep_id` scoping in the WHERE clause of every query** — not RLS, not a
global query wrapper. Postgres row-level security was the tempting
alternative (enforced in the DB, can't forget it), but it needs per-request
`SET ROLE`/session variables through a connection pool — machinery that's
hard to explain on camera and easy to misconfigure. Instead: every list
query *starts* with `rep_id = $1`, every by-id lookup is `id = $1 AND
rep_id = $2`, and the rep id comes only from the verified session
(`req.rep.id`) — the validators don't even accept a `rep_id` field from a
request body. The safety net for "did we miss one?" is the two-rep test
battery (§3.4), which probes every route cross-tenant.

**"Not yours" = "doesn't exist" (404, not 403).** A 403 on someone else's
contact id confirms the id exists — an information leak. Scoped lookups
make foreign and nonexistent ids indistinguishable. Same reasoning scopes
the duplicate-name check: without it, the 409's match list would leak other
reps' contact names to anyone probing with common names.

**Refresh tokens encrypted (AES-256-GCM), access tokens plaintext.** A
refresh token is a long-lived credential — a DB dump shouldn't hand them
out. GCM is authenticated encryption: tampered ciphertext fails loudly
instead of decrypting to garbage. The key is `sha256(SESSION_SECRET)` — one
secret to manage; the documented tradeoff is that rotating it logs everyone
out *and* orphans stored refresh tokens (reps just re-consent). Access
tokens are ~1-hour, low-value; encrypting them would be ceremony.

**Smaller calls:**

| Decision | Why |
|---|---|
| `prompt: 'consent'` + `access_type: 'offline'` on every login | Google only returns a refresh token on first consent otherwise; dev DBs get reset, so always forcing consent is the reliable choice. Cost: one extra click per login. |
| `state` parameter checked against a cookie | Textbook login-CSRF defense: a forged callback can't guess the random value parked in the victim's browser. |
| `activities.rep_id` is denormalized | Derivable via the contact, but rep-wide queries (Phase 9's digest) shouldn't need a join to be tenant-safe — and ownership never changes after insert, so nothing can drift. |
| `workplaces` and `products` stay global | Reference data, not rep data; they sit behind the auth wall but aren't per-rep. |
| Demo rep owns the seed; `npm run db:adopt` hands it to your real account | A fresh Google login starts with an empty book — lousy demo. The adopt script (dev-only, idempotent) reassigns the seed to the newest real rep. |
| Logout is POST and clears only our cookie | GET logout is CSRF-able via `<img>`; and revoking the Google grant belongs in the rep's Google settings, not our button. |
| Boot fails fast on missing env vars | A named list at startup beats a cryptic 500 at first login. Presence is checked, not validity — the app boots with placeholders; only the live exchange needs real values. |

## 3. Walkthrough of the tricky parts

### 3.1 The OAuth flow in beginner terms (for the video)

Think of it as a valet-key handshake with three parties: the browser, our
server, and Google.

1. **"Sign in with Google"** is a plain link to `/auth/google`. Our server
   answers with a redirect to Google's consent screen, carrying: our
   *client id* (which app is asking), the *scopes* (what it's asking for —
   identity, calendar events, send-mail), a random *state* (anti-forgery,
   see 3.2), and `access_type=offline` ("I'll need to act later, when the
   user isn't here").
2. The rep approves. Google redirects the browser back to our
   `redirect_uri` with a **one-time code**. The code is useless on its own
   — it's a claim ticket, not a key.
3. **Our server** exchanges code + *client secret* for the actual tokens.
   This hop is server-to-server: the browser never sees the client secret
   or the tokens. That's the entire point of the authorization-*code* flow
   (versus older flows that put tokens in the URL).
4. Three tokens come back: the **ID token** (a signed statement from
   Google: "this is sub=…, email=…" — we verify its signature and that it
   was minted for our client id, then upsert the rep); the **access token**
   (a ~1-hour key for the Calendar/Gmail APIs); and the **refresh token**
   (a long-lived voucher to get new access tokens — encrypted, stored,
   never shown to anyone).
5. We then issue **our own cookie** (a 12-hour signed JWT naming the rep
   id). Day-to-day requests are authenticated by that cookie alone;
   Google's tokens only come out when we actually call Google.

**Access vs refresh in one line:** the access token is a hotel keycard that
expires in an hour; the refresh token is the front-desk voucher that prints
new keycards — which is why the voucher gets the safe (encryption) and the
keycard doesn't.

### 3.2 The `state` check

`/auth/google` parks a random value in a short-lived cookie and sends the
same value to Google, which echoes it back to the callback. The callback
compares the two. Without it, an attacker could get *their own* Google code
and trick a victim's browser into completing *our* callback with it —
logging the victim into the attacker's account (login CSRF). The forged-
state test returns 400 before the code is ever exchanged.

### 3.3 The upsert's COALESCE subtlety

Google returns a refresh token only when consent is (re)granted. Even with
`prompt:'consent'` we defend against the None case:

```sql
google_refresh_token_enc = COALESCE(EXCLUDED.google_refresh_token_enc,
                                    reps.google_refresh_token_enc)
```

— a login that brings no refresh token keeps the stored one, instead of
overwriting a working credential with NULL.

### 3.4 What was verified (the isolation battery is the headline)

- **Walls:** every `/api/*` route 401s anonymously; `/api/health` stays
  public; garbage cookies and a JWT signed with the wrong secret both 401.
- **Redirect shape:** `/auth/google` 302s to `accounts.google.com` with all
  five scopes, `access_type=offline`, `prompt=consent`, and `state`
  matching the cookie it set. Forged state → 400.
- **Two-rep isolation:** a second rep (inserted directly in the DB, JWT
  minted with the real secret) sees 0 contacts and 0 orders; GET/PATCH on
  rep A's contact → 404; logging an activity on it → 404; GET/PATCH on A's
  order → 404; placing an order for A's contact → 400 "does not reference
  an existing contact"; creating "Dr. Asha Mehta" (A's contact's exact
  name) → **201, no duplicate warning** — the 409 would have leaked A's
  data. After all probes, A's 14 contacts, statuses and timelines were
  bit-identical.
- **Encryption:** round trip exact; plaintext absent from ciphertext; two
  encryptions of the same token differ (unique IVs); tampered ciphertext
  throws (GCM auth) instead of decrypting to garbage.
- **UI (headless browser):** anonymous → login screen with zero data
  rendered; the button navigates to `accounts.google.com`; with an injected
  session cookie → full app showing "Demo Rep", list/detail/orders all
  work; sign-out lands back on the login screen.

### 3.5 What could NOT be verified here — honestly

The live code-for-tokens exchange and ID-token verification require real
Google credentials, which per the security rules never enter this repo. The
placeholder-credential environment proves everything up to Google's front
door (and the browser test confirms the handoff lands on
`accounts.google.com`); the first human login with real `.env` values
exercises the remaining ~30 lines (`getToken`, `verifyIdToken`, the
upsert). Phase 10's README walks the reviewer through creating their own
credentials. This is a stated limitation, not an oversight — say it in the
video before someone asks.

## 4. Likely reviewer / video questions — with tight answers

**Q: How does one Google login give you both auth and API access?**
The consent request bundles identity scopes (openid/email/profile) with API
scopes (calendar.events, gmail.send). Google returns an ID token — verified
proof of who signed in, which becomes the `reps` row — alongside the
access/refresh tokens for those APIs. One grant, both halves; no second
"connect Google" step.

**Q: What exactly is in the user's cookie?**
Only our own 12-hour JWT containing the rep's UUID, signed with
SESSION_SECRET, httpOnly. No Google token ever reaches the browser; no
personal data is in the cookie. Steal the cookie value and you still can't
read it into a Google credential — it's only honored by our API, until it
expires.

**Q: How do you guarantee a rep can't see another rep's data?**
Three layers: the rep id comes only from the verified session (no request
field can name it); every query is scoped by `rep_id` in SQL (list queries
start with it; by-id lookups pair it with the id); and cross-tenant
lookups return 404 — indistinguishable from nonexistent, so ids can't even
be confirmed. Proven by a battery that probes every route as a second rep.

**Q: Why 404 instead of 403 for someone else's data?**
403 says "exists, but not yours" — that's already a leak (valid ids can be
enumerated). One scoped query naturally yields "no row", and "no row" is
404. Cheaper *and* safer.

**Q: Why is the refresh token encrypted but not the access token?**
Value and lifetime. An access token dies in an hour; a refresh token mints
new ones indefinitely, so it's the credential a DB leak must not expose.
AES-256-GCM (authenticated — tampering fails loudly), key derived from
SESSION_SECRET, random IV per encryption.

**Q: What happens when the Google access token expires?**
`getGoogleClientForRep` checks expiry (with a 60s margin), uses the
decrypted refresh token to get a fresh access token, persists it, and
returns a ready client. If the rep never granted offline access or revoked
it, a typed GoogleNotConnectedError surfaces as a "reconnect Google" prompt
— that's Phase 8's graceful-degradation path.

**Q: Why not Postgres row-level security?**
RLS enforces in the database, which is genuinely stronger — but it needs
per-request session variables through a shared connection pool, which is
subtle to get right and hard to explain. At two-layer scale (session wall +
scoped queries + a cross-tenant test battery), explicit WHERE clauses are
auditable by grep. RLS is the right upgrade when the team or table count
grows.

**Q: Could someone log in as another rep by guessing their JWT?**
They'd have to forge a signature over the rep's UUID without
SESSION_SECRET. jsonwebtoken verifies signature and expiry; the forged-
secret test 401s. Rotating SESSION_SECRET instantly invalidates every
session.
